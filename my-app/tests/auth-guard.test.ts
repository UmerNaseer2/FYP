// auth-guard: the gates every API route opens with (lib/auth-guard.ts).
//
// The route suites put a stand-in in place of these gates, so a route can be
// tested without a session or a metadata database. This file is the other
// half: the real gates, with only what they ask stood in for (the session, the
// View as cookie, the organization and membership lookups, and the roles
// table). What it holds them to:
//
//   - No session is 401, and so is a session lookup that throws: never a 500
//     that says why.
//   - Someone signed in who is not a member is 404, the same answer as an
//     organization that does not exist, and nothing about a role is read.
//   - A membership or a role the database could not read is 503 for every
//     route, so nobody is told their role can't do what nobody could check,
//     and nobody is let in on a guess.
//   - A member's role is the one their membership names, read in their own
//     organization, and the principal says which organization that is.
//   - A role without the permission is 403, in the words refusalMessage uses
//     for the first key asked for. Any one of several keys lets a request in.
//   - With real sign-in the View as cookie is never read.
//   - With the bypass on, the caller acts in the default organization. With no
//     cookie they are its full admin. A cookie naming a role gives exactly that
//     role's permissions, under the bypass's own email. A role deleted since,
//     or a cookie naming admin, is the full admin again, and a role that could
//     not be read is a 503, never the full admin.
import { VIEW_AS_COOKIE } from "@/lib/auth-mode";
import { ALL_PERMISSIONS, presetFor, refusalMessage } from "@/lib/permissions";
import { TEST_ORG, bypassAdminPrincipal } from "./helpers/principals";

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

const mockFindDefault = jest.fn();
const mockFindMembership = jest.fn();
jest.mock("../lib/orgs-db", () => ({
  findDefaultOrganization: (...args: unknown[]) => mockFindDefault(...args),
  findMembership: (...args: unknown[]) => mockFindMembership(...args),
}));

const mockGetRoleAccess = jest.fn();
jest.mock("../lib/roles-db", () => ({
  getRoleAccess: (...args: unknown[]) => mockGetRoleAccess(...args),
}));

import { requireMember, requirePermission, type Gate } from "@/lib/auth-guard";

const SIGN_IN_FIRST = { error: "Sign in to continue." };
const NOT_A_MEMBER = { error: "This organization does not exist, or you are not a member." };
const ACCESS_UNAVAILABLE = {
  error:
    "Could not check what your role can do, because the app's database did not answer. " +
    "Try again in a moment.",
};
const VIEWER = { role: "viewer", roleLabel: "Viewer", permissions: [...(presetFor("viewer") ?? [])] };
const EDITOR = { role: "editor", roleLabel: "Editor", permissions: [...(presetFor("editor") ?? [])] };
/** What getRoleAccess hands back for a custom role that may add connections. */
const QA_LEAD = {
  role: "qa-lead",
  roleLabel: "QA Lead",
  permissions: ["dashboard:read", "connections:create", "connections:read"],
};
const DATABASE_DOWN = new Error("connect ECONNREFUSED 127.0.0.1:5433");

beforeEach(() => {
  mockBypass = false;
  mockJar = {};
  mockOutsideRequest = false;
  mockAuth.mockReset();
  mockCookieReads.mockReset();
  mockFindDefault.mockReset();
  mockFindMembership.mockReset();
  mockGetRoleAccess.mockReset();
});

afterEach(() => {
  jest.restoreAllMocks();
});

/** What auth() hands back for a signed-in person: who they are, and nothing about what they may do. */
function session(user: Record<string, unknown> = {}) {
  return {
    user: { email: "ed@example.com", name: "Ed", ...user },
    expires: "2099-01-01T00:00:00.000Z",
  };
}

/** Ed, signed in and a member of TEST_ORG in this role, which may do what `access` says. */
function signedInAs(access: { role: string; roleLabel: string; permissions: string[] }) {
  mockAuth.mockResolvedValue(session());
  mockFindMembership.mockResolvedValue({
    orgId: TEST_ORG.id,
    slug: TEST_ORG.slug,
    name: TEST_ORG.name,
    isDefault: TEST_ORG.isDefault,
    role: access.role,
  });
  mockGetRoleAccess.mockResolvedValue(access);
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

/** Both gates' answers, which every refusal before the 403 has in common. */
async function bothRefusals(): Promise<[number, unknown][]> {
  return [await refusal(await requirePermission("dashboard:read")), await refusal(await requireMember())];
}

/** Keep the gate's own console.error out of the test output, and count it. */
function quietErrors() {
  return jest.spyOn(console, "error").mockImplementation(() => {});
}

describe("with real sign-in", () => {
  test("no session, or one with no email, is 401 for both gates, and nothing else is looked up", async () => {
    for (const answer of [null, { user: {} }, { user: { name: "Ed" } }]) {
      mockAuth.mockResolvedValue(answer);
      expect(await bothRefusals()).toEqual([
        [401, SIGN_IN_FIRST],
        [401, SIGN_IN_FIRST],
      ]);
    }
    expect(mockFindMembership).not.toHaveBeenCalled();
    expect(mockGetRoleAccess).not.toHaveBeenCalled();
  });

  test("a session lookup that throws is 401 too, and the reason stays in the log", async () => {
    const errors = quietErrors();
    mockAuth.mockRejectedValue(new Error("JWTSessionError: no matching decryption secret"));
    expect(await refusal(await requirePermission("dashboard:read"))).toEqual([401, SIGN_IN_FIRST]);
    expect(errors).toHaveBeenCalled();
    expect(mockFindMembership).not.toHaveBeenCalled();
  });

  test("a member gets the role their membership names, and the route the whole principal", async () => {
    signedInAs(EDITOR);
    expect(principalOf(await requirePermission("connections:create"))).toEqual({
      email: "ed@example.com",
      name: "Ed",
      role: "editor",
      roleLabel: "Editor",
      permissions: EDITOR.permissions,
      bypass: false,
      viewingAs: null,
      orgId: TEST_ORG.id,
      orgSlug: TEST_ORG.slug,
      orgName: TEST_ORG.name,
      orgIsDefault: true,
    });
    expect(mockFindMembership).toHaveBeenCalledWith("ed@example.com");
    // In the member's own organization: the same key can mean another role,
    // with other boxes ticked, somewhere else.
    expect(mockGetRoleAccess).toHaveBeenCalledWith(TEST_ORG.id, "editor");
  });

  test("says whether the member's organization is the default one", async () => {
    // Where the organization's scripts live in GitHub hangs on this flag, so
    // it has to come from the membership row, never be assumed.
    signedInAs(EDITOR);
    mockFindMembership.mockResolvedValue({
      orgId: 12,
      slug: "acme",
      name: "Acme",
      isDefault: false,
      role: "editor",
    });
    expect(principalOf(await requireMember())).toMatchObject({ orgId: 12, orgIsDefault: false });
  });

  test("a member whose session has no name goes by their email", async () => {
    signedInAs(VIEWER);
    mockAuth.mockResolvedValue(session({ name: null }));
    expect(principalOf(await requireMember()).name).toBe("ed@example.com");
  });

  test("turns a role down without the permission, naming the first key asked for", async () => {
    signedInAs(VIEWER);
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
    signedInAs(VIEWER);
    expect((await requirePermission("connections:create", "connections:read")).ok).toBe(true);
  });

  test("lets any member through requireMember, whatever their role holds", async () => {
    signedInAs({ role: "nothing", roleLabel: "Nothing", permissions: [] });
    expect(principalOf(await requireMember())).toMatchObject({ role: "nothing", permissions: [] });
    expect((await requirePermission("dashboard:read")).ok).toBe(false);
  });

  test("holds a custom role to its own boxes, and names it by its label", async () => {
    signedInAs(QA_LEAD);
    expect((await requirePermission("connections:create")).ok).toBe(true);
    expect(await refusal(await requirePermission("connections:update"))).toEqual([
      403,
      { error: refusalMessage("QA Lead", "connections:update") },
    ]);
  });

  test("someone signed in who is not a member is 404 for both gates, and no role is looked up", async () => {
    mockAuth.mockResolvedValue(session());
    mockFindMembership.mockResolvedValue(null);
    expect(await bothRefusals()).toEqual([
      [404, NOT_A_MEMBER],
      [404, NOT_A_MEMBER],
    ]);
    expect(mockGetRoleAccess).not.toHaveBeenCalled();
  });

  test("a membership that could not be read is 503 for both gates, and the reason stays in the log", async () => {
    const errors = quietErrors();
    mockAuth.mockResolvedValue(session());
    mockFindMembership.mockRejectedValue(DATABASE_DOWN);
    expect(await bothRefusals()).toEqual([
      [503, ACCESS_UNAVAILABLE],
      [503, ACCESS_UNAVAILABLE],
    ]);
    expect(errors).toHaveBeenCalledWith("Could not read the caller's membership:", DATABASE_DOWN);
  });

  test.each([
    ["could not be read", () => mockGetRoleAccess.mockRejectedValue(DATABASE_DOWN)],
    ["is missing from its organization", () => mockGetRoleAccess.mockResolvedValue(null)],
  ])("a member whose role %s is 503 for both gates, never a guess", async (_name, arrange) => {
    const errors = quietErrors();
    signedInAs(EDITOR);
    arrange();
    expect(await bothRefusals()).toEqual([
      [503, ACCESS_UNAVAILABLE],
      [503, ACCESS_UNAVAILABLE],
    ]);
    // Either way the log says so: a missing role only happens when somebody
    // edits the rows by hand, and they need to know which rows.
    expect(errors).toHaveBeenCalled();
  });

  test("names the role a membership points at but its organization lacks", async () => {
    const errors = quietErrors();
    signedInAs(EDITOR);
    mockGetRoleAccess.mockResolvedValue(null);
    await requireMember();
    expect(errors).toHaveBeenCalledWith(
      `A membership in organization ${TEST_ORG.id} names the role "editor", which that organization does not have.`
    );
  });

  test("never reads the View as cookie, even one naming admin", async () => {
    mockJar = { [VIEW_AS_COOKIE]: "admin" };
    signedInAs(VIEWER);
    expect(principalOf(await requireMember())).toMatchObject({
      role: "viewer",
      permissions: VIEWER.permissions,
      bypass: false,
      viewingAs: null,
    });
    expect(mockCookieReads).not.toHaveBeenCalled();
    expect(mockGetRoleAccess.mock.calls).toEqual([[TEST_ORG.id, "viewer"]]);
    expect(mockFindDefault).not.toHaveBeenCalled();
  });
});

describe("with the bypass on", () => {
  beforeEach(() => {
    mockBypass = true;
    mockFindDefault.mockResolvedValue({
      id: TEST_ORG.id,
      slug: TEST_ORG.slug,
      name: TEST_ORG.name,
      isDefault: true,
    });
  });

  test.each([
    ["no cookie", undefined],
    ["an empty cookie", ""],
  ])("%s is the full admin of the default organization, and looks up no role", async (_name, value) => {
    if (value !== undefined) mockJar = { [VIEW_AS_COOKIE]: value };
    expect(principalOf(await requirePermission("roles:delete"))).toEqual(bypassAdminPrincipal());
    expect(mockAuth).not.toHaveBeenCalled();
    expect(mockFindMembership).not.toHaveBeenCalled();
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
    // The default organization's role of that name, the one the switcher listed.
    expect(mockGetRoleAccess).toHaveBeenCalledWith(TEST_ORG.id, "qa-lead");
    expect(await refusal(await requirePermission("connections:update"))).toEqual([
      403,
      { error: refusalMessage("QA Lead", "connections:update") },
    ]);
    expect(mockAuth).not.toHaveBeenCalled();
  });

  test("a role deleted since it was picked is the full admin again", async () => {
    mockJar = { [VIEW_AS_COOKIE]: "qa-lead" };
    mockGetRoleAccess.mockResolvedValue(null);
    expect(principalOf(await requireMember())).toEqual(bypassAdminPrincipal());
  });

  test("a cookie naming admin is the full admin, and that role is never looked up", async () => {
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
    expect(principalOf(await requireMember())).toEqual(bypassAdminPrincipal());
    expect(mockGetRoleAccess).not.toHaveBeenCalled();
  });

  test("a role that could not be read is 503 for both gates, never the full admin", async () => {
    const errors = quietErrors();
    mockJar = { [VIEW_AS_COOKIE]: "qa-lead" };
    mockGetRoleAccess.mockRejectedValue(DATABASE_DOWN);
    expect(await bothRefusals()).toEqual([
      [503, ACCESS_UNAVAILABLE],
      [503, ACCESS_UNAVAILABLE],
    ]);
    expect(errors).toHaveBeenCalledWith("Could not read the role picked in View as:", DATABASE_DOWN);
  });

  test("outside a request, where there is no cookie to read, is the full admin", async () => {
    mockOutsideRequest = true;
    expect(principalOf(await requireMember())).toEqual(bypassAdminPrincipal());
    expect(mockCookieReads).toHaveBeenCalled();
    expect(mockGetRoleAccess).not.toHaveBeenCalled();
  });

  test("a default organization that could not be read is 503 for both gates, whatever the cookie says", async () => {
    const errors = quietErrors();
    mockFindDefault.mockRejectedValue(DATABASE_DOWN);
    const jars: Record<string, string>[] = [{}, { [VIEW_AS_COOKIE]: "qa-lead" }];
    for (const jar of jars) {
      mockJar = jar;
      expect(await bothRefusals()).toEqual([
        [503, ACCESS_UNAVAILABLE],
        [503, ACCESS_UNAVAILABLE],
      ]);
    }
    expect(errors).toHaveBeenCalledWith("Could not read the default organization:", DATABASE_DOWN);
    expect(mockCookieReads).not.toHaveBeenCalled();
    expect(mockGetRoleAccess).not.toHaveBeenCalled();
  });

  test("no default organization at all is 404 for both gates", async () => {
    mockFindDefault.mockResolvedValue(null);
    expect(await bothRefusals()).toEqual([
      [404, NOT_A_MEMBER],
      [404, NOT_A_MEMBER],
    ]);
    expect(mockCookieReads).not.toHaveBeenCalled();
  });
});
