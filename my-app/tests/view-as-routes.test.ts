// view-as-routes: the two routes behind "View as" and the screens' own idea of
// what a role may do (app/api/me/view-as/route.ts and app/api/me/route.ts).
//
// "View as" only exists while authentication is off. It leaves a cookie naming
// a role, and from then on every gate answers as that role (bypassPrincipal in
// lib/auth-guard.ts). What these tests hold it to:
//
//   - With real sign-in the switcher is not there at all. It answers 404
//     before it asks who is calling, so being signed in never makes a way to
//     wear another role appear.
//   - Going back to Admin needs no database, because a database that is down
//     is exactly when someone stuck viewing as a role needs to get out.
//   - The cookie is only ever set to a role that was found, and only cleared
//     when it has stopped working. A failed lookup leaves it as it was.
//   - The cookie is what a browser will really receive: this session only,
//     readable by the page, and Secure over https.
//   - /api/me says what the caller may do and nothing about who they are.
import { NextRequest, NextResponse } from "next/server";
import type { Gate } from "@/lib/auth-guard";
import { ALL_PERMISSIONS, presetFor } from "@/lib/permissions";
import { bypassAdminPrincipal, principalFor } from "./helpers/principals";

let mockBypass = true;
jest.mock("../lib/auth-mode", () => ({
  ...jest.requireActual("../lib/auth-mode"),
  // A getter, so one file can see both sides of a switch that is otherwise
  // decided once, at module load. See tests/use-user.test.tsx.
  get BYPASS_AUTH() {
    return mockBypass;
  },
}));

let mockGate: Gate;
let mockGateCalls = 0;
jest.mock("../lib/auth-guard", () => ({
  requireSignedIn: async () => {
    mockGateCalls += 1;
    return mockGate;
  },
}));

const mockRolesDb = { getRoleAccess: jest.fn(), listRoles: jest.fn() };
jest.mock("../lib/roles-db", () => ({
  getRoleAccess: (...args: unknown[]) => mockRolesDb.getRoleAccess(...args),
  listRoles: (...args: unknown[]) => mockRolesDb.listRoles(...args),
}));

import { GET as getMe } from "@/app/api/me/route";
import { GET as listViewAs, POST as pickViewAs } from "@/app/api/me/view-as/route";

const BYPASS_ADMIN = bypassAdminPrincipal();
/** The bypass once View as has picked Viewer (bypassPrincipal found the role). */
const VIEWING_AS_VIEWER = principalFor("viewer", {
  email: BYPASS_ADMIN.email,
  name: BYPASS_ADMIN.name,
  bypass: true,
  viewingAs: "viewer",
});
/** The bypass when the role View as picked could not be read. */
const VIEWING_AS_UNREAD = {
  ...BYPASS_ADMIN,
  role: "qa-lead",
  roleLabel: "qa-lead",
  permissions: [],
  viewingAs: "qa-lead",
  accessUnavailable: true,
};
const SIGNED_IN_EDITOR = principalFor("editor");

const NOT_AVAILABLE = "View as is only available while authentication is off.";
const CLEARED = "studio-view-as=; Path=/; Max-Age=0";
const QA_LEAD = { role: "qa-lead", roleLabel: "QA Lead", permissions: ["dashboard:read"] };

beforeEach(() => {
  mockBypass = true;
  mockGate = { ok: true, principal: BYPASS_ADMIN };
  mockGateCalls = 0;
  for (const fn of Object.values(mockRolesDb)) fn.mockReset();
});

afterEach(() => {
  jest.restoreAllMocks();
});

/** POST /api/me/view-as with this exact body text, the way the switcher sends it. */
function pick(body: string, url = "http://localhost/api/me/view-as"): NextRequest {
  return new NextRequest(url, {
    method: "POST",
    body,
    headers: { "content-type": "application/json" },
  });
}

const pickRole = (role: unknown, url?: string) => pick(JSON.stringify({ role }), url);

/** GET /api/me with this Cookie header, or none. */
function askMe(cookie?: string): NextRequest {
  return new NextRequest("http://localhost/api/me", {
    headers: cookie === undefined ? {} : { cookie },
  });
}

async function answer(response: Response): Promise<[number, unknown]> {
  return [response.status, await response.json()];
}

/** The Set-Cookie header exactly as the browser would receive it, or null. */
const setCookie = (response: Response) => response.headers.get("set-cookie");

const signInFirst = () => NextResponse.json({ error: "Sign in to continue." }, { status: 401 });

/** Keep the route's own console.error out of the test output, and count it. */
function quietErrors() {
  return jest.spyOn(console, "error").mockImplementation(() => {});
}

describe("GET /api/me/view-as: the roles to pick from", () => {
  test("is not there with real sign-in, and asks nobody anything", async () => {
    mockBypass = false;

    expect(await answer(await listViewAs())).toEqual([404, { error: NOT_AVAILABLE }]);
    expect(mockGateCalls).toBe(0);
    expect(mockRolesDb.listRoles).not.toHaveBeenCalled();
  });

  test("passes on a refusal from the sign-in check as it came", async () => {
    const refused = signInFirst();
    mockGate = { ok: false, response: refused };

    expect(await listViewAs()).toBe(refused);
    expect(mockRolesDb.listRoles).not.toHaveBeenCalled();
  });

  test("lists each role by name and label only, and says who the app is viewed as", async () => {
    mockGate = { ok: true, principal: VIEWING_AS_VIEWER };
    mockRolesDb.listRoles.mockResolvedValue([
      {
        name: "viewer",
        label: "Viewer",
        description: "Can look, not change",
        builtIn: true,
        userCount: 3,
        permissions: ["dashboard:read"],
      },
      {
        name: "qa-lead",
        label: "QA Lead",
        description: "",
        builtIn: false,
        userCount: 0,
        permissions: [],
      },
    ]);

    // What each role may do is the Admin screen's business. The picker gets
    // something to show and nothing more.
    expect(await answer(await listViewAs())).toEqual([
      200,
      {
        viewingAs: "viewer",
        roles: [
          { name: "viewer", label: "Viewer" },
          { name: "qa-lead", label: "QA Lead" },
        ],
      },
    ]);
  });

  test("says the database did not answer, and that Admin is still a way out", async () => {
    const logged = quietErrors();
    mockRolesDb.listRoles.mockRejectedValue(new Error("connect ECONNREFUSED 127.0.0.1:5433"));

    expect(await answer(await listViewAs())).toEqual([
      503,
      {
        error:
          "Could not load the roles, because the app's database did not answer. " +
          "You can still go back to Admin.",
      },
    ]);
    // The reason goes to the server's log, not to the screen.
    expect(logged).toHaveBeenCalledTimes(1);
  });
});

describe("POST /api/me/view-as: picking a role", () => {
  test("is not there with real sign-in, and reads nothing", async () => {
    mockBypass = false;
    const request = pickRole("viewer");
    const response = await pickViewAs(request);

    expect(await answer(response)).toEqual([404, { error: NOT_AVAILABLE }]);
    expect(setCookie(response)).toBeNull();
    expect([mockGateCalls, request.bodyUsed]).toEqual([0, false]);
    expect(mockRolesDb.getRoleAccess).not.toHaveBeenCalled();
  });

  test("passes on a refusal from the sign-in check as it came, before reading the body", async () => {
    const refused = signInFirst();
    mockGate = { ok: false, response: refused };
    const request = pickRole("viewer");

    expect(await pickViewAs(request)).toBe(refused);
    expect(request.bodyUsed).toBe(false);
    expect(mockRolesDb.getRoleAccess).not.toHaveBeenCalled();
  });

  const CHOOSE = "Choose a role to view the app as.";

  test.each([
    ["text that is not JSON", "role=viewer", "Expected a JSON body."],
    ["null", "null", "Expected a JSON body."],
    ["a bare string", JSON.stringify("viewer"), "Expected a JSON body."],
    ["a number", "7", "Expected a JSON body."],
    // A list has no role in it. Reading it as "back to Admin" would make a
    // malformed request do something.
    ["a list", JSON.stringify([{ role: "viewer" }]), "Expected a JSON body."],
    ["a role that is not text", JSON.stringify({ role: 7 }), CHOOSE],
    ["true as the role", JSON.stringify({ role: true }), CHOOSE],
    ["a role inside a list", JSON.stringify({ role: ["viewer"] }), CHOOSE],
    ["a role longer than any role key", JSON.stringify({ role: "x".repeat(65) }), CHOOSE],
  ])("turns down %s, and leaves the cookie as it was", async (_name, body, error) => {
    const response = await pickViewAs(pick(body));

    expect(await answer(response)).toEqual([400, { error }]);
    expect(setCookie(response)).toBeNull();
    expect(mockRolesDb.getRoleAccess).not.toHaveBeenCalled();
  });

  test.each([
    ["no role", {}],
    ["null", { role: null }],
    ["the empty choice", { role: "" }],
    ["admin", { role: "admin" }],
  ])("goes back to Admin for %s, without the database", async (_name, body) => {
    // The database is down. Going back to Admin works anyway.
    mockRolesDb.getRoleAccess.mockRejectedValue(new Error("connect ECONNREFUSED 127.0.0.1:5433"));
    const response = await pickViewAs(pick(JSON.stringify(body)));

    expect(await answer(response)).toEqual([200, { viewingAs: null, roleLabel: "Admin" }]);
    expect(setCookie(response)).toBe(CLEARED);
    expect(mockRolesDb.getRoleAccess).not.toHaveBeenCalled();
  });

  test("leaves a cookie naming the role, for this browser session only", async () => {
    mockRolesDb.getRoleAccess.mockResolvedValue(QA_LEAD);
    const response = await pickViewAs(pickRole("qa-lead"));

    expect(await answer(response)).toEqual([200, { viewingAs: "qa-lead", roleLabel: "QA Lead" }]);
    expect(mockRolesDb.getRoleAccess).toHaveBeenCalledWith("qa-lead");
    // No Max-Age or Expires, so it goes when the browser closes. No HttpOnly,
    // because hooks/useUser reads it as well.
    expect(setCookie(response)).toBe("studio-view-as=qa-lead; Path=/; SameSite=lax");
  });

  test("marks the cookie Secure when the app is served over https", async () => {
    mockRolesDb.getRoleAccess.mockResolvedValue(QA_LEAD);
    const response = await pickViewAs(pickRole("qa-lead", "https://studio.test/api/me/view-as"));

    expect(setCookie(response)).toBe("studio-view-as=qa-lead; Path=/; Secure; SameSite=lax");
  });

  test("looks up a role key as long as the route allows", async () => {
    const longest = "k".repeat(64);
    mockRolesDb.getRoleAccess.mockResolvedValue(null);

    await pickViewAs(pickRole(longest));
    expect(mockRolesDb.getRoleAccess).toHaveBeenCalledWith(longest);
  });

  test("turns down a role that has gone, and leaves the cookie as it was", async () => {
    mockRolesDb.getRoleAccess.mockResolvedValue(null);
    const response = await pickViewAs(pickRole("qa-lead"));

    expect(await answer(response)).toEqual([
      400,
      {
        error:
          "That role does not exist any more. Reload the page to see the roles there are now.",
      },
    ]);
    expect(setCookie(response)).toBeNull();
  });

  test("says the database did not answer, and leaves the cookie as it was", async () => {
    const logged = quietErrors();
    mockRolesDb.getRoleAccess.mockRejectedValue(new Error("connect ECONNREFUSED 127.0.0.1:5433"));
    const response = await pickViewAs(pickRole("qa-lead"));

    expect(await answer(response)).toEqual([
      503,
      {
        error:
          "Could not switch roles, because the app's database did not answer. " +
          "Try again in a moment.",
      },
    ]);
    expect(setCookie(response)).toBeNull();
    expect(logged).toHaveBeenCalledTimes(1);
  });
});

describe("GET /api/me: what the caller may do", () => {
  test("passes on a refusal from the sign-in check as it came", async () => {
    const refused = signInFirst();
    mockGate = { ok: false, response: refused };

    expect(await getMe(askMe())).toBe(refused);
  });

  test.each([
    [
      "the bypass as Admin",
      true,
      BYPASS_ADMIN,
      {
        role: "admin",
        roleLabel: "Admin",
        permissions: [...ALL_PERMISSIONS],
        bypass: true,
        viewingAs: null,
        accessUnavailable: false,
      },
    ],
    [
      "the bypass viewing as Viewer",
      true,
      VIEWING_AS_VIEWER,
      {
        role: "viewer",
        roleLabel: "Viewer",
        permissions: presetFor("viewer"),
        bypass: true,
        viewingAs: "viewer",
        accessUnavailable: false,
      },
    ],
    [
      // Answered, not refused, so the screen can say "try again" rather than
      // "your role can't".
      "the bypass when the role it views as could not be read",
      true,
      VIEWING_AS_UNREAD,
      {
        role: "qa-lead",
        roleLabel: "qa-lead",
        permissions: [],
        bypass: true,
        viewingAs: "qa-lead",
        accessUnavailable: true,
      },
    ],
    [
      "a signed-in editor",
      false,
      SIGNED_IN_EDITOR,
      {
        role: "editor",
        roleLabel: "Editor",
        permissions: presetFor("editor"),
        bypass: false,
        viewingAs: null,
        accessUnavailable: false,
      },
    ],
  ])("answers for %s, with nothing about who they are", async (_name, bypass, principal, body) => {
    mockBypass = bypass;
    mockGate = { ok: true, principal };

    // toEqual fails on a field it does not expect, so an email or a name
    // creeping into the reply fails here.
    expect(await answer(await getMe(askMe()))).toEqual([200, body]);
  });

  test("clears a View as cookie that did not take, so the switcher says Admin too", async () => {
    // The role it names was deleted after it was picked. bypassPrincipal is the
    // full admin again, but the browser still sends the cookie.
    mockGate = { ok: true, principal: BYPASS_ADMIN };
    const response = await getMe(askMe("studio-view-as=qa-lead"));

    expect(response.status).toBe(200);
    expect(setCookie(response)).toBe(CLEARED);
  });

  test.each([
    ["sign-in is real", false, "studio-view-as=qa-lead", SIGNED_IN_EDITOR],
    ["there is no cookie", true, undefined, BYPASS_ADMIN],
    ["the cookie is empty", true, "studio-view-as=", BYPASS_ADMIN],
    ["the only cookie is some other one", true, "theme=dark", BYPASS_ADMIN],
    ["the role it names is in use", true, "studio-view-as=viewer", VIEWING_AS_VIEWER],
    // Today a failed read also keeps viewingAs (see VIEWING_AS_UNREAD), so
    // this is a second lock. It gets a case of its own so it stays one: the
    // role may well still be there.
    [
      "the role could not be read",
      true,
      "studio-view-as=qa-lead",
      { ...BYPASS_ADMIN, accessUnavailable: true },
    ],
  ])("leaves the cookie alone when %s", async (_name, bypass, cookie, principal) => {
    mockBypass = bypass;
    mockGate = { ok: true, principal };

    expect(setCookie(await getMe(askMe(cookie)))).toBeNull();
  });
});
