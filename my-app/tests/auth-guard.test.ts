// auth-guard: the gates every API route opens with (lib/auth-guard.ts).
//
// The route suites put a stand-in in place of these gates, so a route can be
// tested without a session or a metadata database. This file is the other
// half: the real gates, with only what they ask stood in for (the session, the
// View as cookie and the roles table). What it holds them to:
//
//   - No session is 401, and so is a session lookup that throws: never a 500
//     that says why.
//   - A role without the permission is 403, in the words refusalMessage uses
//     for the first key asked for. Any one of several keys lets a request in.
//   - A role the database could not read is 503 for a feature, so nobody is
//     told their role can't do what nobody could check. Asking who you are
//     still answers, so the screen can say so.
//   - A permission the catalogue does not have never matches, whatever an old
//     session carried.
//   - With real sign-in the View as cookie is never read.
//   - With the bypass on and no cookie, the caller is the full admin. A cookie
//     naming a role gives exactly that role's permissions, under the bypass's
//     own email. A role deleted since, or a cookie naming admin, is the full
//     admin again, and a role that could not be read holds nothing.
import { VIEW_AS_COOKIE } from "@/lib/auth-mode";
import { ALL_PERMISSIONS, DEFAULT_ROLE, presetFor, refusalMessage } from "@/lib/permissions";
import { bypassAdminPrincipal } from "./helpers/principals";

let mockBypass = false;
jest.mock("../lib/auth-mode", () => ({
  ...jest.requireActual("../lib/auth-mode"),
  // A getter, so one file can see both sides of a switch that is otherwise
  // decided once, at module load. See tests/use-user.test.tsx.
  get BYPASS_AUTH() {
    return mockBypass;
  },
}));

const mockAuth = jest.fn();
jest.mock("../auth", () => ({ auth: () => mockAuth() }));

/** The cookies the request carries, by name. */
let mockJar: Record<string, string> = {};
/** True to make cookies() throw, the way it does outside a request. */
let mockOutsideRequest = false;
const mockCookieReads = jest.fn();
jest.mock("next/headers", () => ({
  cookies: async () => {
    mockCookieReads();
    if (mockOutsideRequest) throw new Error("`cookies` was called outside a request scope.");
    return {
      get: (name: string) => (name in mockJar ? { name, value: mockJar[name] } : undefined),
    };
  },
}));

const mockGetRoleAccess = jest.fn();
jest.mock("../lib/roles-db", () => ({
  getRoleAccess: (...args: unknown[]) => mockGetRoleAccess(...args),
}));

import { getPrincipal, requirePermission, requireSignedIn, type Gate } from "@/lib/auth-guard";

const SIGN_IN_FIRST = { error: "Sign in to continue." };
const ACCESS_UNAVAILABLE = {
  error:
    "Could not check what your role can do, because the app's database did not answer. " +
    "Try again in a moment.",
};
const VIEWER = [...(presetFor("viewer") ?? [])];
const EDITOR = [...(presetFor("editor") ?? [])];
/** What getRoleAccess hands back for a custom role that may add connections. */
const QA_LEAD = {
  role: "qa-lead",
  roleLabel: "QA Lead",
  permissions: ["dashboard:read", "connections:create", "connections:read"],
};

beforeEach(() => {
  mockBypass = false;
  mockJar = {};
  mockOutsideRequest = false;
  mockAuth.mockReset();
  mockCookieReads.mockReset();
  mockGetRoleAccess.mockReset();
});

afterEach(() => {
  jest.restoreAllMocks();
});

/** What auth() hands back for a signed-in person, as auth.ts fills it in. */
function session(user: Record<string, unknown>) {
  return {
    user: { email: "ed@example.com", name: "Ed", ...user },
    expires: "2099-01-01T00:00:00.000Z",
  };
}

/** The principal an open gate hands the route. */
function principalOf(gate: Gate) {
  if (!gate.ok) throw new Error(`The gate refused with ${gate.response.status}.`);
  return gate.principal;
}

/** A closed gate's status and body. */
async function refusal(gate: Gate): Promise<[number, unknown]> {
  if (gate.ok) throw new Error(`The gate let ${gate.principal.email} in.`);
  return [gate.response.status, await gate.response.json()];
}

/** Keep the gate's own console.error out of the test output, and count it. */
function quietErrors() {
  return jest.spyOn(console, "error").mockImplementation(() => {});
}

describe("with real sign-in", () => {
  test("no session, or one with no email, is 401 for both gates", async () => {
    for (const answer of [null, { user: {} }, { user: { name: "Ed" } }]) {
      mockAuth.mockResolvedValue(answer);
      expect(await refusal(await requirePermission("dashboard:read"))).toEqual([401, SIGN_IN_FIRST]);
      expect(await refusal(await requireSignedIn())).toEqual([401, SIGN_IN_FIRST]);
    }
  });

  test("a session lookup that throws is 401 too, and the reason stays in the log", async () => {
    const errors = quietErrors();
    mockAuth.mockRejectedValue(new Error("JWTSessionError: no matching decryption secret"));
    expect(await refusal(await requirePermission("dashboard:read"))).toEqual([401, SIGN_IN_FIRST]);
    expect(errors).toHaveBeenCalled();
  });

  test("lets a role in with the permission, and hands the route the whole principal", async () => {
    mockAuth.mockResolvedValue(session({ role: "editor", roleLabel: "Editor", permissions: EDITOR }));
    expect(principalOf(await requirePermission("connections:create"))).toEqual({
      email: "ed@example.com",
      name: "Ed",
      role: "editor",
      roleLabel: "Editor",
      permissions: EDITOR,
      bypass: false,
      viewingAs: null,
      accessUnavailable: false,
    });
  });

  test("turns a role down without the permission, naming the first key asked for", async () => {
    mockAuth.mockResolvedValue(session({ role: "viewer", roleLabel: "Viewer", permissions: VIEWER }));
    expect(await refusal(await requirePermission("connections:create"))).toEqual([
      403,
      { error: refusalMessage("Viewer", "connections:create") },
    ]);
    // Neither key is held, so the refusal is about the first one.
    expect(await refusal(await requirePermission("users:read", "roles:read"))).toEqual([
      403,
      { error: refusalMessage("Viewer", "users:read") },
    ]);
  });

  test("lets a request in when the role holds any one of the keys", async () => {
    mockAuth.mockResolvedValue(session({ role: "viewer", roleLabel: "Viewer", permissions: VIEWER }));
    expect((await requirePermission("connections:create", "connections:read")).ok).toBe(true);
  });

  test("holds a custom role to its own boxes, and names it by its label", async () => {
    mockAuth.mockResolvedValue(session(QA_LEAD));
    expect((await requirePermission("connections:create")).ok).toBe(true);
    expect(await refusal(await requirePermission("connections:update"))).toEqual([
      403,
      { error: refusalMessage("QA Lead", "connections:update") },
    ]);
  });

  test("never matches a permission the catalogue does not have", async () => {
    mockAuth.mockResolvedValue(
      session({ role: "qa-lead", permissions: ["dashboard:read", "reports:export", "users:fly"] })
    );
    expect(principalOf(await requireSignedIn()).permissions).toEqual(["dashboard:read"]);
  });

  test("a session that names no role is the default role, holding nothing", async () => {
    mockAuth.mockResolvedValue(session({}));
    expect(principalOf(await requireSignedIn())).toMatchObject({
      role: DEFAULT_ROLE,
      permissions: [],
    });
    expect((await requirePermission("dashboard:read")).ok).toBe(false);
  });

  test("a role the database could not read is 503 for a feature, yet still says who is asking", async () => {
    // What the session callback in auth.ts hands over when getProfileAccess
    // throws: the least role, no permissions, and a flag saying why.
    mockAuth.mockResolvedValue(
      session({ role: "viewer", roleLabel: "Viewer", permissions: [], accessError: true })
    );
    expect(await refusal(await requirePermission("dashboard:read"))).toEqual([503, ACCESS_UNAVAILABLE]);
    expect(principalOf(await requireSignedIn())).toMatchObject({
      role: "viewer",
      permissions: [],
      accessUnavailable: true,
    });
  });

  test("never reads the View as cookie, even one naming admin", async () => {
    mockJar = { [VIEW_AS_COOKIE]: "admin" };
    mockAuth.mockResolvedValue(session({ role: "viewer", roleLabel: "Viewer", permissions: VIEWER }));
    expect(principalOf(await requireSignedIn())).toMatchObject({
      role: "viewer",
      permissions: VIEWER,
      bypass: false,
      viewingAs: null,
    });
    expect(mockCookieReads).not.toHaveBeenCalled();
    expect(mockGetRoleAccess).not.toHaveBeenCalled();
  });
});

describe("with the bypass on", () => {
  beforeEach(() => {
    mockBypass = true;
  });

  test.each([
    ["no cookie", undefined],
    ["an empty cookie", ""],
  ])("%s is the full admin, and asks nobody anything", async (_name, value) => {
    if (value !== undefined) mockJar = { [VIEW_AS_COOKIE]: value };
    expect(principalOf(await requirePermission("roles:delete"))).toEqual(bypassAdminPrincipal());
    expect(mockAuth).not.toHaveBeenCalled();
    expect(mockGetRoleAccess).not.toHaveBeenCalled();
  });

  test("a cookie naming a role gives exactly that role's permissions, under the bypass's own name", async () => {
    mockJar = { [VIEW_AS_COOKIE]: "qa-lead" };
    mockGetRoleAccess.mockResolvedValue(QA_LEAD);
    // The email and name stay the bypass's, so an audit row written now still
    // says sign-in was off.
    expect(principalOf(await requirePermission("connections:create"))).toEqual({
      ...bypassAdminPrincipal(),
      role: "qa-lead",
      roleLabel: "QA Lead",
      permissions: QA_LEAD.permissions,
      viewingAs: "qa-lead",
    });
    expect(mockGetRoleAccess).toHaveBeenCalledWith("qa-lead");
    expect(await refusal(await requirePermission("connections:update"))).toEqual([
      403,
      { error: refusalMessage("QA Lead", "connections:update") },
    ]);
    expect(mockAuth).not.toHaveBeenCalled();
  });

  test("a role deleted since it was picked is the full admin again", async () => {
    mockJar = { [VIEW_AS_COOKIE]: "qa-lead" };
    mockGetRoleAccess.mockResolvedValue(null);
    expect(principalOf(await requireSignedIn())).toEqual(bypassAdminPrincipal());
  });

  test("a cookie naming admin is the full admin, and asks the database nothing", async () => {
    // "Admin (everything)" clears the cookie, so this one was set by hand.
    // Looked up, it would come back as Admin, and the bypass would say it was
    // viewing the app as the admin it already is: the switcher would then
    // offer Admin twice.
    mockJar = { [VIEW_AS_COOKIE]: "admin" };
    mockGetRoleAccess.mockResolvedValue({
      role: "admin",
      roleLabel: "Admin",
      permissions: [...ALL_PERMISSIONS],
    });
    expect(principalOf(await requireSignedIn())).toEqual(bypassAdminPrincipal());
    expect(mockGetRoleAccess).not.toHaveBeenCalled();
  });

  test("a role that could not be read holds nothing, and every feature answers 503", async () => {
    const errors = quietErrors();
    mockJar = { [VIEW_AS_COOKIE]: "qa-lead" };
    mockGetRoleAccess.mockRejectedValue(new Error("connect ECONNREFUSED 127.0.0.1:5433"));
    expect(principalOf(await requireSignedIn())).toEqual({
      ...bypassAdminPrincipal(),
      role: "qa-lead",
      roleLabel: "qa-lead",
      permissions: [],
      viewingAs: "qa-lead",
      accessUnavailable: true,
    });
    expect(await refusal(await requirePermission("dashboard:read"))).toEqual([503, ACCESS_UNAVAILABLE]);
    expect(errors).toHaveBeenCalled();
  });

  test("a cookie too long to be a role key is cut to one before it is repeated", async () => {
    quietErrors();
    mockJar = { [VIEW_AS_COOKIE]: "a".repeat(200) };
    mockGetRoleAccess.mockRejectedValue(new Error("connect ECONNREFUSED 127.0.0.1:5433"));
    expect(principalOf(await requireSignedIn())).toMatchObject({
      role: "a".repeat(32),
      roleLabel: "a".repeat(32),
      viewingAs: "a".repeat(32),
    });
  });

  test("outside a request, where there is no cookie to read, is the full admin", async () => {
    mockOutsideRequest = true;
    expect(await getPrincipal()).toEqual(bypassAdminPrincipal());
    expect(mockCookieReads).toHaveBeenCalled();
    expect(mockGetRoleAccess).not.toHaveBeenCalled();
  });
});
