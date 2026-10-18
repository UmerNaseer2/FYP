// admin-roles-route: the API behind the Roles & permissions tab
// (app/api/admin/roles/route.ts).
//
// The rules about roles themselves (a name already taken, a role still held,
// Admin can't be changed) live in lib/roles-db.ts and are tested in
// tests/roles-db.test.ts. Here lib/roles-db is replaced, so these tests cover
// only what the route adds on top:
//
//   - Each method asks for its own Roles & permissions box before it reads
//     anything, and a refusal goes back exactly as the gate made it.
//   - A body of the wrong shape is turned down in words a person can act on,
//     and nothing is passed on.
//   - A refusal from lib/roles-db reaches the screen with the status and words
//     it chose, not as a generic failure.
//   - Every change is credited to whoever made it. While sign-in is off that
//     is "(authentication bypassed)", not a made-up email.
//   - A database that is down reads as "try again", never as a stack trace.
import { NextRequest, NextResponse } from "next/server";
import type { Gate } from "@/lib/auth-guard";
import { bypassAdminPrincipal, principalFor } from "./helpers/principals";

let mockGate: Gate;
/** The keys each call to requirePermission asked for, in order. */
let mockAskedFor: string[][] = [];

jest.mock("../lib/auth-guard", () => ({
  requirePermission: async (...keys: string[]) => {
    mockAskedFor.push(keys);
    return mockGate;
  },
}));

// Each one is reached through mockRolesDb when called, not when this factory
// runs, because the factory runs before the line that creates mockRolesDb.
const mockRolesDb = {
  createRole: jest.fn(),
  deleteRole: jest.fn(),
  listRoleChanges: jest.fn(),
  listRoles: jest.fn(),
  resetRolePermissions: jest.fn(),
  setRolePermissions: jest.fn(),
};
jest.mock("../lib/roles-db", () => ({
  createRole: (...args: unknown[]) => mockRolesDb.createRole(...args),
  deleteRole: (...args: unknown[]) => mockRolesDb.deleteRole(...args),
  listRoleChanges: (...args: unknown[]) => mockRolesDb.listRoleChanges(...args),
  listRoles: (...args: unknown[]) => mockRolesDb.listRoles(...args),
  resetRolePermissions: (...args: unknown[]) => mockRolesDb.resetRolePermissions(...args),
  setRolePermissions: (...args: unknown[]) => mockRolesDb.setRolePermissions(...args),
}));

import { DELETE, GET, POST, PUT } from "@/app/api/admin/roles/route";

const ADMIN = principalFor("admin", { email: "umer@x", name: "Umer" });
const TRY_AGAIN = "The app's database may be unreachable. Try again in a moment.";
const HANDLERS = { POST, PUT, DELETE };
type Write = keyof typeof HANDLERS;

const QA_LEAD = {
  name: "qa-lead",
  label: "QA Lead",
  description: "Runs the test plans",
  builtIn: false,
  userCount: 0,
  permissions: ["dashboard:read", "compare:read"],
};

beforeEach(() => {
  mockGate = { ok: true, principal: ADMIN };
  mockAskedFor = [];
  for (const fn of Object.values(mockRolesDb)) fn.mockReset();
});

afterEach(() => {
  jest.restoreAllMocks();
});

/** A request with this exact body text, the way a browser would send it. */
function send(method: Write, body: string): NextRequest {
  return new NextRequest("http://localhost/api/admin/roles", {
    method,
    body,
    headers: { "content-type": "application/json" },
  });
}

const json = (method: Write, value: unknown) => send(method, JSON.stringify(value));

async function answer(response: Response): Promise<[number, unknown]> {
  return [response.status, await response.json()];
}

function nothingWasPassedOn() {
  for (const [name, fn] of Object.entries(mockRolesDb)) {
    expect([name, fn.mock.calls]).toEqual([name, []]);
  }
}

/** Keep the route's own console.error out of the test output, and count it. */
function quietErrors() {
  return jest.spyOn(console, "error").mockImplementation(() => {});
}

describe("asking first", () => {
  const refusal = () =>
    NextResponse.json(
      { error: "Your role (Editor) can't see roles and permissions. Only admins can." },
      { status: 403 }
    );

  test("GET asks for roles:read, and a refusal goes back as it came", async () => {
    const refused = refusal();
    mockGate = { ok: false, response: refused };

    expect(await GET()).toBe(refused);
    expect(mockAskedFor).toEqual([["roles:read"]]);
    nothingWasPassedOn();
  });

  test.each([
    ["POST", "roles:create", { label: "QA Lead" }],
    ["PUT", "roles:update", { role: "editor", reset: true }],
    ["DELETE", "roles:delete", { role: "qa-lead" }],
  ] as const)(
    "%s asks for %s before it reads the body, and a refusal goes back as it came",
    async (method, key, body) => {
      const refused = refusal();
      mockGate = { ok: false, response: refused };
      const request = json(method, body);

      expect(await HANDLERS[method](request)).toBe(refused);
      expect(mockAskedFor).toEqual([[key]]);
      expect(request.bodyUsed).toBe(false);
      nothingWasPassedOn();
    }
  );
});

describe("GET: the roles and the change log", () => {
  test("answers with every role and the 50 most recent changes, in one reply", async () => {
    const changes = [
      {
        id: 3,
        role: "editor",
        roleLabel: "Editor",
        kind: "grant",
        feature: "deploy",
        action: "run",
        subject: null,
        detail: null,
        actor: "umer@x",
        createdAt: "2026-10-16T09:30:00.000Z",
      },
    ];
    mockRolesDb.listRoles.mockResolvedValue([QA_LEAD]);
    mockRolesDb.listRoleChanges.mockResolvedValue(changes);

    expect(await answer(await GET())).toEqual([200, { roles: [QA_LEAD], changes }]);
    expect(mockRolesDb.listRoleChanges).toHaveBeenCalledWith(50);
  });

  test.each(["listRoles", "listRoleChanges"] as const)(
    "says the database may be down when %s fails",
    async (failing) => {
      const logged = quietErrors();
      mockRolesDb.listRoles.mockResolvedValue([QA_LEAD]);
      mockRolesDb.listRoleChanges.mockResolvedValue([]);
      mockRolesDb[failing].mockRejectedValue(new Error("connect ECONNREFUSED 127.0.0.1:5433"));

      expect(await answer(await GET())).toEqual([
        500,
        { error: `Could not read the roles. ${TRY_AGAIN}` },
      ]);
      // The reason goes to the server's log, not to the screen.
      expect(logged).toHaveBeenCalledTimes(1);
    }
  );
});

describe("POST: making a role", () => {
  const COPY_REFUSED = "Pick a role to copy, or none to start with nothing ticked.";

  test.each([
    ["text that is not JSON", "label=QA Lead", "Expected a JSON body."],
    ["a list", JSON.stringify([{ label: "QA Lead" }]), "Expected a JSON body."],
    ["null", "null", "Expected a JSON body."],
    ["a bare string", JSON.stringify("QA Lead"), "Expected a JSON body."],
    ["no name", JSON.stringify({}), "Give the role a name."],
    ["a name that is not text", JSON.stringify({ label: 7 }), "Give the role a name."],
    [
      "a description that is not text",
      JSON.stringify({ label: "QA Lead", description: 7 }),
      "The description must be text.",
    ],
    ["a role to copy that is not text", JSON.stringify({ label: "QA", copyFrom: 7 }), COPY_REFUSED],
    ["false as the role to copy", JSON.stringify({ label: "QA", copyFrom: false }), COPY_REFUSED],
    [
      "a role to copy longer than any role key",
      JSON.stringify({ label: "QA", copyFrom: "x".repeat(65) }),
      COPY_REFUSED,
    ],
  ])("turns down %s", async (_name, body, error) => {
    expect(await answer(await POST(send("POST", body)))).toEqual([400, { error }]);
    nothingWasPassedOn();
  });

  test.each([
    ["left out", {}],
    ["null", { copyFrom: null }],
    ["the picker's empty choice", { copyFrom: "" }],
  ])("starts the role with nothing ticked when the role to copy is %s", async (_name, extra) => {
    mockRolesDb.createRole.mockResolvedValue({ ok: true, role: QA_LEAD });

    await POST(json("POST", { label: "QA Lead", ...extra }));
    // No description sent means an empty one.
    expect(mockRolesDb.createRole).toHaveBeenCalledWith(
      { label: "QA Lead", description: "", copyFrom: null },
      "umer@x"
    );
  });

  test("passes the name, description and role to copy on as they were sent", async () => {
    // Trimming and the length rules are lib/roles-db's, so the route leaves
    // the spaces for it to deal with.
    mockRolesDb.createRole.mockResolvedValue({ ok: true, role: QA_LEAD });
    const longestKey = "k".repeat(64);

    await POST(json("POST", { label: "  QA Lead ", description: "Runs the test plans", copyFrom: "editor" }));
    await POST(json("POST", { label: "QA Lead", copyFrom: longestKey }));

    expect(mockRolesDb.createRole.mock.calls).toEqual([
      [{ label: "  QA Lead ", description: "Runs the test plans", copyFrom: "editor" }, "umer@x"],
      [{ label: "QA Lead", description: "", copyFrom: longestKey }, "umer@x"],
    ]);
  });

  test("answers 201 with the role as it was made", async () => {
    mockRolesDb.createRole.mockResolvedValue({ ok: true, role: QA_LEAD });
    expect(await answer(await POST(json("POST", { label: "QA Lead" })))).toEqual([
      201,
      { role: QA_LEAD },
    ]);
  });

  test.each([
    [400, "Give the role a name with at least one letter from A to Z, or a number."],
    [400, "The role to copy from no longer exists. Refresh the page and try again."],
    [409, 'There is already a role called "QA Lead". Pick a different name.'],
  ])("passes on a %i refusal from lib/roles-db as it came", async (status, error) => {
    mockRolesDb.createRole.mockResolvedValue({ ok: false, status, error });
    expect(await answer(await POST(json("POST", { label: "QA Lead" })))).toEqual([
      status,
      { error },
    ]);
  });

  test("says the database may be down when the write fails", async () => {
    const logged = quietErrors();
    mockRolesDb.createRole.mockRejectedValue(new Error("Connection terminated unexpectedly"));

    expect(await answer(await POST(json("POST", { label: "QA Lead" })))).toEqual([
      500,
      { error: `Could not create the role. ${TRY_AGAIN}` },
    ]);
    expect(logged).toHaveBeenCalledTimes(1);
  });
});

describe("PUT: changing what a role can do", () => {
  const ROLE_REFUSED = "Say which role to change.";
  const LIST_REFUSED = "Send the role's permissions as a list.";

  test.each([
    ["text that is not JSON", "role=editor", "Expected a JSON body."],
    ["a list", JSON.stringify(["deploy:run"]), "Expected a JSON body."],
    ["no role", JSON.stringify({ permissions: [] }), ROLE_REFUSED],
    ["an empty role", JSON.stringify({ role: "", permissions: [] }), ROLE_REFUSED],
    ["a role that is not text", JSON.stringify({ role: 7, permissions: [] }), ROLE_REFUSED],
    [
      "a role longer than any role key",
      JSON.stringify({ role: "x".repeat(65), permissions: [] }),
      ROLE_REFUSED,
    ],
    ["no permissions", JSON.stringify({ role: "editor" }), LIST_REFUSED],
    ["permissions that are not a list", JSON.stringify({ role: "editor", permissions: "deploy:run" }), LIST_REFUSED],
    [
      "a list with something other than text in it",
      JSON.stringify({ role: "editor", permissions: ["deploy:run", 7] }),
      LIST_REFUSED,
    ],
    // Only true itself resets, so a reset can never happen by accident.
    ['"true" as text for reset', JSON.stringify({ role: "editor", reset: "true" }), LIST_REFUSED],
  ])("turns down %s", async (_name, body, error) => {
    expect(await answer(await PUT(send("PUT", body)))).toEqual([400, { error }]);
    nothingWasPassedOn();
  });

  test("saves exactly the list that was sent, and answers with what the role can do now", async () => {
    mockRolesDb.setRolePermissions.mockResolvedValue({
      ok: true,
      permissions: ["deploy:read", "deploy:run"],
      changes: 2,
    });

    const response = await PUT(json("PUT", { role: "editor", permissions: ["deploy:run"] }));
    expect(await answer(response)).toEqual([
      200,
      { permissions: ["deploy:read", "deploy:run"], changes: 2 },
    ]);
    expect(mockRolesDb.setRolePermissions).toHaveBeenCalledWith("editor", ["deploy:run"], "umer@x");
    expect(mockRolesDb.resetRolePermissions).not.toHaveBeenCalled();
  });

  test("treats an empty list as a list: the role is left with nothing", async () => {
    mockRolesDb.setRolePermissions.mockResolvedValue({ ok: true, permissions: [], changes: 12 });
    await PUT(json("PUT", { role: "viewer", permissions: [] }));
    expect(mockRolesDb.setRolePermissions).toHaveBeenCalledWith("viewer", [], "umer@x");
  });

  test("resets with reset: true, and ignores any list sent with it", async () => {
    mockRolesDb.resetRolePermissions.mockResolvedValue({
      ok: true,
      permissions: ["dashboard:read"],
      changes: 1,
    });

    const response = await PUT(
      json("PUT", { role: "viewer", reset: true, permissions: ["users:read"] })
    );
    expect(await answer(response)).toEqual([200, { permissions: ["dashboard:read"], changes: 1 }]);
    expect(mockRolesDb.resetRolePermissions).toHaveBeenCalledWith("viewer", "umer@x");
    expect(mockRolesDb.setRolePermissions).not.toHaveBeenCalled();
  });

  test("looks up a role key as long as the route allows", async () => {
    const longestKey = "k".repeat(64);
    mockRolesDb.setRolePermissions.mockResolvedValue({
      ok: false,
      status: 404,
      error: "That role no longer exists. Refresh the page.",
    });

    await PUT(json("PUT", { role: longestKey, permissions: [] }));
    expect(mockRolesDb.setRolePermissions).toHaveBeenCalledWith(longestKey, [], "umer@x");
  });

  test.each([
    ["saving a list", { role: "admin", permissions: [] }, "setRolePermissions"],
    ["a reset", { role: "admin", reset: true }, "resetRolePermissions"],
  ] as const)("passes on a refusal from lib/roles-db as it came, for %s", async (_name, body, fn) => {
    const error = "The admin role can always do everything, so its permissions can't be changed.";
    mockRolesDb[fn].mockResolvedValue({ ok: false, status: 400, error });
    expect(await answer(await PUT(json("PUT", body)))).toEqual([400, { error }]);
  });

  test.each([
    ["saving a list", { role: "editor", permissions: [] }, "setRolePermissions"],
    ["a reset", { role: "editor", reset: true }, "resetRolePermissions"],
  ] as const)("says the database may be down when %s fails", async (_name, body, fn) => {
    const logged = quietErrors();
    mockRolesDb[fn].mockRejectedValue(new Error("Connection terminated unexpectedly"));

    expect(await answer(await PUT(json("PUT", body)))).toEqual([
      500,
      { error: `Could not save the role's permissions. ${TRY_AGAIN}` },
    ]);
    expect(logged).toHaveBeenCalledTimes(1);
  });
});

describe("DELETE: deleting a role", () => {
  const ROLE_REFUSED = "Say which role to delete.";

  test.each([
    ["text that is not JSON", "role=qa-lead", "Expected a JSON body."],
    ["no role", JSON.stringify({}), ROLE_REFUSED],
    ["an empty role", JSON.stringify({ role: "" }), ROLE_REFUSED],
    ["a role that is not text", JSON.stringify({ role: ["qa-lead"] }), ROLE_REFUSED],
    ["a role longer than any role key", JSON.stringify({ role: "x".repeat(65) }), ROLE_REFUSED],
  ])("turns down %s", async (_name, body, error) => {
    expect(await answer(await DELETE(send("DELETE", body)))).toEqual([400, { error }]);
    nothingWasPassedOn();
  });

  test("deletes the role named, and says so", async () => {
    mockRolesDb.deleteRole.mockResolvedValue({ ok: true });

    expect(await answer(await DELETE(json("DELETE", { role: "qa-lead" })))).toEqual([
      200,
      { success: true },
    ]);
    expect(mockRolesDb.deleteRole).toHaveBeenCalledWith("qa-lead", "umer@x");
  });

  test.each([
    [400, "Viewer, Editor and Admin are built in and can't be deleted."],
    [404, "That role no longer exists. Refresh the page."],
    [409, "2 people have this role. Give them another role on the Users tab first."],
  ])("passes on a %i refusal from lib/roles-db as it came", async (status, error) => {
    mockRolesDb.deleteRole.mockResolvedValue({ ok: false, status, error });
    expect(await answer(await DELETE(json("DELETE", { role: "qa-lead" })))).toEqual([
      status,
      { error },
    ]);
  });

  test("says the database may be down when the delete fails", async () => {
    const logged = quietErrors();
    mockRolesDb.deleteRole.mockRejectedValue(new Error("Connection terminated unexpectedly"));

    expect(await answer(await DELETE(json("DELETE", { role: "qa-lead" })))).toEqual([
      500,
      { error: `Could not delete the role. ${TRY_AGAIN}` },
    ]);
    expect(logged).toHaveBeenCalledTimes(1);
  });
});

describe("who a change is credited to", () => {
  // Every write goes in the role change log under this name, so it has to be
  // the person who made it. With sign-in off there is no person to name, and
  // the log says so rather than inventing an email.
  const WRITES = [
    ["POST", { label: "QA Lead" }, "createRole", { ok: true, role: QA_LEAD }],
    ["PUT", { role: "editor", permissions: [] }, "setRolePermissions", { ok: true, permissions: [], changes: 0 }],
    ["PUT", { role: "editor", reset: true }, "resetRolePermissions", { ok: true, permissions: [], changes: 0 }],
    ["DELETE", { role: "qa-lead" }, "deleteRole", { ok: true }],
  ] as const;

  test.each([
    ["the signed-in admin", ADMIN, "umer@x"],
    ["the auth bypass", bypassAdminPrincipal(), "(authentication bypassed)"],
  ])("is %s", async (_name, principal, actor) => {
    mockGate = { ok: true, principal };
    for (const [method, body, fn, result] of WRITES) {
      mockRolesDb[fn].mockResolvedValue(result);
      await HANDLERS[method](json(method, body));
      expect([fn, mockRolesDb[fn].mock.lastCall?.at(-1)]).toEqual([fn, actor]);
    }
  });
});
