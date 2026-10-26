/**
 * /api/admin/organization (app/api/admin/organization/route.ts): reading,
 * renaming, switching the two-person rule, and deleting the caller's own
 * organization.
 *
 * What the database does with each change is lib/orgs-db.ts's business, and
 * tests/org-migration.test.ts holds it to that against a real Postgres. Here the gate
 * and the database calls are stood in for, so these cover what the route adds:
 * which box each method asks for, what it reads from the body, what it refuses
 * before the database is reached, and how each answer is said.
 */
import { NextRequest } from "next/server";
import type { Gate } from "@/lib/auth-guard";
import { orgNameProblem } from "@/lib/new-organization";
import { bypassAdminPrincipal, principalFor, TEST_ORG } from "./helpers/principals";

let mockGate: Gate;
/** The keys each call to requirePermission asked for, in order. */
let mockAskedFor: string[][] = [];

jest.mock("../lib/auth-guard", () => ({
  requirePermission: async (...keys: string[]) => {
    mockAskedFor.push(keys);
    return mockGate;
  },
}));

const mockOrgsDb = { updateOrganization: jest.fn(), deleteOrganization: jest.fn() };
jest.mock("../lib/orgs-db", () => ({
  updateOrganization: (...args: unknown[]) => mockOrgsDb.updateOrganization(...args),
  deleteOrganization: (...args: unknown[]) => mockOrgsDb.deleteOrganization(...args),
}));

import { DELETE, GET, PATCH } from "@/app/api/admin/organization/route";

const ADMIN = principalFor("admin", { email: "umer@x", name: "Umer" });
/** An admin in an organization other than the install's first. */
const ADMIN_ELSEWHERE = { ...ADMIN, orgIsDefault: false };
const TRY_AGAIN = " The app's database may be unreachable. Try again in a moment.";

const DESKTOP = process.env.SCHEMA_STUDIO_DESKTOP;

beforeEach(() => {
  mockGate = { ok: true, principal: ADMIN };
  mockAskedFor = [];
  delete process.env.SCHEMA_STUDIO_DESKTOP;
  mockOrgsDb.updateOrganization.mockReset();
  mockOrgsDb.deleteOrganization.mockReset();
});

afterEach(() => {
  jest.restoreAllMocks();
  if (DESKTOP === undefined) delete process.env.SCHEMA_STUDIO_DESKTOP;
  else process.env.SCHEMA_STUDIO_DESKTOP = DESKTOP;
});

function send(method: "PATCH" | "DELETE", body: string): NextRequest {
  return new NextRequest("http://localhost/api/admin/organization", {
    method,
    body,
    headers: { "content-type": "application/json" },
  });
}

async function answer(response: Response): Promise<[number, unknown]> {
  return [response.status, await response.json()];
}

describe("GET", () => {
  test("asks for Organization: Read and says what the tab shows", async () => {
    expect(await answer(await GET())).toEqual([
      200,
      { name: TEST_ORG.name, slug: TEST_ORG.slug, twoPersonRule: true, canDelete: false },
    ]);
    expect(mockAskedFor).toEqual([["organization:read"]]);
  });

  test.each([
    ["another organization", () => (mockGate = { ok: true, principal: ADMIN_ELSEWHERE }), true],
    ["the desktop app", () => {
      mockGate = { ok: true, principal: ADMIN_ELSEWHERE };
      process.env.SCHEMA_STUDIO_DESKTOP = "1";
    }, false],
    ["the demo", () => (mockGate = { ok: true, principal: { ...bypassAdminPrincipal(), orgIsDefault: false } }), false],
  ])("says whether %s can be deleted", async (_, setUp, canDelete) => {
    setUp();
    const [, body] = await answer(await GET());
    expect((body as { canDelete: boolean }).canDelete).toBe(canDelete);
  });

  test("passes a refusal from the gate on as it is", async () => {
    const refusal = Response.json({ error: "no" }, { status: 403 });
    mockGate = { ok: false, response: refusal as never };
    expect(await GET()).toBe(refusal);
  });
});

describe("PATCH", () => {
  const saved = { id: 7, name: "Acme", slug: TEST_ORG.slug, twoPersonRule: false };

  test("asks for Organization: Update, saves a clean name and the rule, and answers what was kept", async () => {
    mockOrgsDb.updateOrganization.mockResolvedValue({ kind: "ok", organization: saved });

    const sent = send("PATCH", JSON.stringify({ name: "  Acme  ", twoPersonRule: false }));
    expect(await answer(await PATCH(sent))).toEqual([
      200,
      { name: "Acme", slug: TEST_ORG.slug, twoPersonRule: false },
    ]);
    expect(mockAskedFor).toEqual([["organization:update"]]);
    expect(mockOrgsDb.updateOrganization.mock.calls).toEqual([
      [TEST_ORG.id, { name: "Acme", twoPersonRule: false }, "umer@x"],
    ]);
  });

  test.each<[string, string, unknown]>([
    ["a body that is not JSON", "{", { error: "Expected a JSON body." }],
    ["an array", "[]", { error: "Expected a JSON body." }],
    ["nothing to change", "{}", { error: "Say what to change: the name, the two-person rule, or both." }],
    ["an empty name", JSON.stringify({ name: "   " }), { error: orgNameProblem(""), field: "name" }],
    ["a name that is not text", JSON.stringify({ name: 5 }), { error: orgNameProblem(""), field: "name" }],
    [
      "a rule that is not true or false",
      JSON.stringify({ twoPersonRule: "off" }),
      { error: "Say whether the two-person rule is on (true) or off (false).", field: "twoPersonRule" },
    ],
  ])("refuses %s before the database is reached", async (_, body, refusal) => {
    expect(await answer(await PATCH(send("PATCH", body)))).toEqual([400, refusal]);
    expect(mockOrgsDb.updateOrganization).not.toHaveBeenCalled();
  });

  test("answers 404 when the organization went meanwhile, and 503 when the database fails", async () => {
    mockOrgsDb.updateOrganization.mockResolvedValueOnce({ kind: "not-found" });
    const [status] = await answer(await PATCH(send("PATCH", JSON.stringify({ name: "Acme" }))));
    expect(status).toBe(404);

    const logged = jest.spyOn(console, "error").mockImplementation(() => {});
    mockOrgsDb.updateOrganization.mockRejectedValueOnce(new Error("boom"));
    expect(await answer(await PATCH(send("PATCH", JSON.stringify({ twoPersonRule: true }))))).toEqual([
      503,
      { error: `Could not save the change.${TRY_AGAIN}` },
    ]);
    expect(logged).toHaveBeenCalledTimes(1);
  });
});

describe("DELETE", () => {
  const typed = (confirm: unknown) => send("DELETE", JSON.stringify({ confirm }));

  test("asks for Organization: Delete, hands over the typed name, and logs the address and profile only", async () => {
    mockGate = { ok: true, principal: ADMIN_ELSEWHERE };
    mockOrgsDb.deleteOrganization.mockResolvedValue({ kind: "deleted" });
    const logged = jest.spyOn(console, "info").mockImplementation(() => {});

    expect(await answer(await DELETE(typed(TEST_ORG.name)))).toEqual([200, { deleted: true }]);
    expect(mockAskedFor).toEqual([["organization:delete"]]);
    expect(mockOrgsDb.deleteOrganization.mock.calls).toEqual([[TEST_ORG.id, TEST_ORG.name]]);
    expect(logged.mock.calls).toEqual([
      [`Organization ${TEST_ORG.slug} deleted by profile ${ADMIN.profileId}.`],
    ]);
    expect(logged.mock.calls.flat().join(" ")).not.toContain("umer@x");
  });

  test.each([
    ["on the desktop app", () => (process.env.SCHEMA_STUDIO_DESKTOP = "1"), /desktop app/],
    ["in the demo", () => (mockGate = { ok: true, principal: { ...bypassAdminPrincipal(), orgIsDefault: false } }), /real sign-in/],
  ])("refuses %s without reaching the database", async (_, setUp, why) => {
    mockGate = { ok: true, principal: ADMIN_ELSEWHERE };
    setUp();
    const [status, body] = await answer(await DELETE(typed(TEST_ORG.name)));
    expect(status).toBe(403);
    expect((body as { error: string }).error).toMatch(why);
    expect(mockOrgsDb.deleteOrganization).not.toHaveBeenCalled();
  });

  test("hands over an empty name when none was typed, so the database refuses it", async () => {
    mockOrgsDb.deleteOrganization.mockResolvedValue({ kind: "mismatch" });
    const [status, body] = await answer(await DELETE(typed(5)));
    expect(mockOrgsDb.deleteOrganization.mock.calls).toEqual([[TEST_ORG.id, ""]]);
    expect(status).toBe(400);
    expect((body as { field: string }).field).toBe("confirm");
  });

  test.each([
    ["not-found", 404],
    ["default", 403],
  ])("answers %s with %i", async (kind, status) => {
    mockOrgsDb.deleteOrganization.mockResolvedValue({ kind });
    const [got] = await answer(await DELETE(typed(TEST_ORG.name)));
    expect(got).toBe(status);
  });

  test("refuses a body that is not JSON, and answers 503 when the database fails", async () => {
    expect(await answer(await DELETE(send("DELETE", "nope")))).toEqual([
      400,
      { error: "Expected a JSON body." },
    ]);
    jest.spyOn(console, "error").mockImplementation(() => {});
    mockOrgsDb.deleteOrganization.mockRejectedValue(new Error("boom"));
    expect(await answer(await DELETE(typed(TEST_ORG.name)))).toEqual([
      503,
      { error: `Could not delete the organization.${TRY_AGAIN}` },
    ]);
  });
});
