// auth-guard: the gates every API route opens with (lib/auth-guard.ts).
//
// The route suites put a stand-in in place of these gates, so a route can be
// tested without a session or a metadata database. This file is the other
// half: the real gates, with only what they ask stood in for (the session, the
// header naming the organization, the View as cookie, the organization and
// membership lookups, and the roles table). What it holds them to:
//
//   - No session is 401, and so is a session lookup that throws: never a 500
//     that says why.
//   - The organization is the one the request's header names. A request that
//     names none is 404 on the web and the default organization on the
//     desktop, which has only the one.
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
//   - With the bypass on, the caller acts in the organization the request
//     names, and one nobody has is 404. With no cookie they are its full
//     admin. A cookie naming a role gives exactly that role's permissions,
//     under the bypass's own email. A role deleted since, or a cookie naming
//     admin, is the full admin again, and a role that could not be read is a
//     503, never the full admin.
//   - resolveOrganization, the pages' lookup, reads the slug it is handed
//     rather than the header, and says who was turned away.
import { VIEW_AS_COOKIE } from "@/lib/auth-mode";
import { ORG_HEADER } from "@/lib/org-slug";
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
/** The headers the request carries, by lowercase name. */
let mockHeaders: Record<string, string> = {};
/** True to make cookies() and headers() throw, the way they do outside a request. */
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
  headers: async () => {
    if (mockOutsideRequest) throw new Error("`headers` was called outside a request scope.");
    return { get: (name: string) => mockHeaders[name.toLowerCase()] ?? null };
  },
}));

const mockFindOrganization = jest.fn();
const mockFindDefault = jest.fn();
const mockFindMembership = jest.fn();
const mockFindDefaultMembership = jest.fn();
jest.mock("../lib/orgs-db", () => ({
  findOrganization: (...args: unknown[]) => mockFindOrganization(...args),
  findDefaultOrganization: (...args: unknown[]) => mockFindDefault(...args),
  findMembership: (...args: unknown[]) => mockFindMembership(...args),
  findDefaultMembership: (...args: unknown[]) => mockFindDefaultMembership(...args),
}));

const mockGetRoleAccess = jest.fn();
jest.mock("../lib/roles-db", () => ({
  getRoleAccess: (...args: unknown[]) => mockGetRoleAccess(...args),
}));

import { requireMember, requirePermission, resolveOrganization, type Gate } from "@/lib/auth-guard";

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
/** A second organization, for the tests that need the request to name another one. */
const ACME = { id: 12, slug: "acme", name: "Acme", isDefault: false };

const DESKTOP = process.env.SCHEMA_STUDIO_DESKTOP;

beforeEach(() => {
  mockBypass = false;
  mockJar = {};
  // Every call a screen makes names the organization its page is open in.
  mockHeaders = { [ORG_HEADER]: TEST_ORG.slug };
  mockOutsideRequest = false;
  delete process.env.SCHEMA_STUDIO_DESKTOP;
  mockAuth.mockReset();
  mockCookieReads.mockReset();
  mockFindOrganization.mockReset();
  mockFindDefault.mockReset();
  mockFindMembership.mockReset();
  mockFindDefaultMembership.mockReset();
  mockGetRoleAccess.mockReset();
});

afterEach(() => {
  jest.restoreAllMocks();
  if (DESKTOP === undefined) delete process.env.SCHEMA_STUDIO_DESKTOP;
  else process.env.SCHEMA_STUDIO_DESKTOP = DESKTOP;
});

/** Answer the way the server the desktop app starts does. */
function onTheDesktop() {
  process.env.SCHEMA_STUDIO_DESKTOP = "1";
}

/** A request that names no organization. */
function noHeader() {
  mockHeaders = {};
}

/** What auth() hands back for a signed-in person: who they are, and nothing about what they may do. */
function session(user: Record<string, unknown> = {}) {
  return {
    user: { email: "ed@example.com", name: "Ed", ...user },
    expires: "2099-01-01T00:00:00.000Z",
  };
}

/** The membership row the lookups hand back for Ed in TEST_ORG. */
function membership(role: string) {
  return {
    orgId: TEST_ORG.id,
    slug: TEST_ORG.slug,
    name: TEST_ORG.name,
    isDefault: TEST_ORG.isDefault,
    role,
  };
}

/** Ed, signed in and a member of TEST_ORG in this role, which may do what `access` says. */
function signedInAs(access: { role: string; roleLabel: string; permissions: string[] }) {
  mockAuth.mockResolvedValue(session());
  mockFindMembership.mockResolvedValue(membership(access.role));
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
    expect(mockFindMembership).toHaveBeenCalledWith("ed@example.com", TEST_ORG.slug);
    // In the member's own organization: the same key can mean another role,
    // with other boxes ticked, somewhere else.
    expect(mockGetRoleAccess).toHaveBeenCalledWith(TEST_ORG.id, "editor");
  });

  test("says whether the member's organization is the default one", async () => {
    // Where the organization's scripts live in GitHub hangs on this flag, so
    // it has to come from the membership row, never be assumed.
    signedInAs(EDITOR);
    mockHeaders = { [ORG_HEADER]: ACME.slug };
    mockFindMembership.mockResolvedValue({
      orgId: ACME.id,
      slug: ACME.slug,
      name: ACME.name,
      isDefault: false,
      role: "editor",
    });
    expect(principalOf(await requireMember())).toMatchObject({
      orgId: ACME.id,
      orgSlug: ACME.slug,
      orgIsDefault: false,
    });
    expect(mockFindMembership).toHaveBeenCalledWith("ed@example.com", ACME.slug);
    expect(mockGetRoleAccess).toHaveBeenCalledWith(ACME.id, "editor");
  });

  test("reads the organization from the request's header, with the spaces around it dropped", async () => {
    signedInAs(VIEWER);
    mockHeaders = { [ORG_HEADER]: `  ${TEST_ORG.slug} ` };
    expect((await requireMember()).ok).toBe(true);
    expect(mockFindMembership).toHaveBeenCalledWith("ed@example.com", TEST_ORG.slug);
  });

  test.each([
    ["no header", () => noHeader()],
    ["a blank header", () => (mockHeaders = { [ORG_HEADER]: "   " })],
  ])("%s on the web is 404 for both gates, and no membership is looked up", async (_name, arrange) => {
    // A screen that forgot to say where it acts must not quietly act in the
    // caller's first organization, or any other.
    signedInAs(EDITOR);
    arrange();
    expect(await bothRefusals()).toEqual([
      [404, NOT_A_MEMBER],
      [404, NOT_A_MEMBER],
    ]);
    expect(mockFindMembership).not.toHaveBeenCalled();
    expect(mockFindDefaultMembership).not.toHaveBeenCalled();
    expect(mockGetRoleAccess).not.toHaveBeenCalled();
  });

  test("no header on the desktop acts in its default organization", async () => {
    onTheDesktop();
    noHeader();
    mockAuth.mockResolvedValue(session());
    mockFindDefaultMembership.mockResolvedValue(membership("editor"));
    mockGetRoleAccess.mockResolvedValue(EDITOR);
    expect(principalOf(await requirePermission("connections:create"))).toMatchObject({
      role: "editor",
      orgId: TEST_ORG.id,
      orgSlug: TEST_ORG.slug,
    });
    expect(mockFindDefaultMembership).toHaveBeenCalledWith("ed@example.com");
    expect(mockFindMembership).not.toHaveBeenCalled();
  });

  test("on the desktop a header still names the organization", async () => {
    onTheDesktop();
    signedInAs(EDITOR);
    expect((await requireMember()).ok).toBe(true);
    expect(mockFindMembership).toHaveBeenCalledWith("ed@example.com", TEST_ORG.slug);
    expect(mockFindDefaultMembership).not.toHaveBeenCalled();
  });

  test("on the desktop, someone with no membership in the default organization is 404", async () => {
    onTheDesktop();
    noHeader();
    mockAuth.mockResolvedValue(session());
    mockFindDefaultMembership.mockResolvedValue(null);
    expect(await bothRefusals()).toEqual([
      [404, NOT_A_MEMBER],
      [404, NOT_A_MEMBER],
    ]);
    expect(mockGetRoleAccess).not.toHaveBeenCalled();
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
    // The lookup answers null for an organization that does not exist and
    // for one the caller is not in alike, so the two cannot be told apart.
    mockAuth.mockResolvedValue(session());
    mockHeaders = { [ORG_HEADER]: ACME.slug };
    mockFindMembership.mockResolvedValue(null);
    expect(await bothRefusals()).toEqual([
      [404, NOT_A_MEMBER],
      [404, NOT_A_MEMBER],
    ]);
    expect(mockFindMembership).toHaveBeenCalledWith("ed@example.com", ACME.slug);
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
    expect(mockFindOrganization).not.toHaveBeenCalled();
    expect(mockFindDefault).not.toHaveBeenCalled();
  });
});

describe("with the bypass on", () => {
  beforeEach(() => {
    mockBypass = true;
    const org = { id: TEST_ORG.id, slug: TEST_ORG.slug, name: TEST_ORG.name, isDefault: true };
    mockFindOrganization.mockImplementation(async (slug: string) => (slug === org.slug ? org : null));
    mockFindDefault.mockResolvedValue(org);
  });

  test.each([
    ["no cookie", undefined],
    ["an empty cookie", ""],
  ])("%s is the full admin of the organization the request names, and looks up no role", async (_name, value) => {
    if (value !== undefined) mockJar = { [VIEW_AS_COOKIE]: value };
    expect(principalOf(await requirePermission("roles:delete"))).toEqual(bypassAdminPrincipal());
    expect(mockFindOrganization).toHaveBeenCalledWith(TEST_ORG.slug);
    expect(mockFindDefault).not.toHaveBeenCalled();
    expect(mockAuth).not.toHaveBeenCalled();
    expect(mockFindMembership).not.toHaveBeenCalled();
    expect(mockGetRoleAccess).not.toHaveBeenCalled();
  });

  test("acts in whichever organization the request names, View as included", async () => {
    mockHeaders = { [ORG_HEADER]: ACME.slug };
    mockFindOrganization.mockResolvedValue(ACME);
    expect(principalOf(await requireMember())).toEqual({
      ...bypassAdminPrincipal(),
      orgId: ACME.id,
      orgSlug: ACME.slug,
      orgName: ACME.name,
      orgIsDefault: false,
    });
    // A role picked in View as is that organization's role of that name.
    mockJar = { [VIEW_AS_COOKIE]: "qa-lead" };
    mockGetRoleAccess.mockResolvedValue(QA_LEAD);
    expect(principalOf(await requireMember())).toMatchObject({ orgId: ACME.id, viewingAs: "qa-lead" });
    expect(mockGetRoleAccess).toHaveBeenCalledWith(ACME.id, "qa-lead");
  });

  test("an organization nobody has is 404 for both gates", async () => {
    mockHeaders = { [ORG_HEADER]: "nobody-has-this" };
    expect(await bothRefusals()).toEqual([
      [404, NOT_A_MEMBER],
      [404, NOT_A_MEMBER],
    ]);
    expect(mockCookieReads).not.toHaveBeenCalled();
  });

  test("no header on the web is 404 for both gates, and no organization is looked up", async () => {
    noHeader();
    expect(await bothRefusals()).toEqual([
      [404, NOT_A_MEMBER],
      [404, NOT_A_MEMBER],
    ]);
    expect(mockFindOrganization).not.toHaveBeenCalled();
    expect(mockFindDefault).not.toHaveBeenCalled();
  });

  test("no header on the desktop is the full admin of its default organization", async () => {
    onTheDesktop();
    noHeader();
    expect(principalOf(await requireMember())).toEqual(bypassAdminPrincipal());
    expect(mockFindDefault).toHaveBeenCalled();
    expect(mockFindOrganization).not.toHaveBeenCalled();
  });

  test("on the desktop, no default organization at all is 404 for both gates", async () => {
    onTheDesktop();
    noHeader();
    mockFindDefault.mockResolvedValue(null);
    expect(await bothRefusals()).toEqual([
      [404, NOT_A_MEMBER],
      [404, NOT_A_MEMBER],
    ]);
    expect(mockCookieReads).not.toHaveBeenCalled();
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

  test("outside a request, where there is nothing to read, only the desktop answers, as the full admin", async () => {
    mockOutsideRequest = true;
    expect(await refusal(await requireMember())).toEqual([404, NOT_A_MEMBER]);
    onTheDesktop();
    expect(principalOf(await requireMember())).toEqual(bypassAdminPrincipal());
    expect(mockCookieReads).toHaveBeenCalled();
    expect(mockGetRoleAccess).not.toHaveBeenCalled();
  });

  test.each([
    ["named in the request", () => mockFindOrganization.mockRejectedValue(DATABASE_DOWN)],
    [
      "the desktop's default",
      () => {
        onTheDesktop();
        noHeader();
        mockFindDefault.mockRejectedValue(DATABASE_DOWN);
      },
    ],
  ])("an organization (%s) that could not be read is 503 for both gates, whatever the cookie says", async (_name, arrange) => {
    const errors = quietErrors();
    arrange();
    const jars: Record<string, string>[] = [{}, { [VIEW_AS_COOKIE]: "qa-lead" }];
    for (const jar of jars) {
      mockJar = jar;
      expect(await bothRefusals()).toEqual([
        [503, ACCESS_UNAVAILABLE],
        [503, ACCESS_UNAVAILABLE],
      ]);
    }
    expect(errors).toHaveBeenCalledWith("Could not read the organization:", DATABASE_DOWN);
    expect(mockCookieReads).not.toHaveBeenCalled();
    expect(mockGetRoleAccess).not.toHaveBeenCalled();
  });
});

describe("resolveOrganization, the pages' lookup", () => {
  test("looks in the organization it is handed, never the one in the header", async () => {
    signedInAs(EDITOR);
    mockHeaders = { [ORG_HEADER]: ACME.slug };
    const found = await resolveOrganization(TEST_ORG.slug);
    expect(found).toMatchObject({ kind: "ok", principal: { role: "editor", orgId: TEST_ORG.id } });
    expect(mockFindMembership.mock.calls).toEqual([["ed@example.com", TEST_ORG.slug]]);
  });

  test("says who was turned away: the signed-in email, or null for the bypass", async () => {
    // The organization's layout tells someone in no organization at all from
    // someone who typed the address of one they are not in by this email.
    mockAuth.mockResolvedValue(session());
    mockFindMembership.mockResolvedValue(null);
    expect(await resolveOrganization(ACME.slug)).toEqual({ kind: "not-member", email: "ed@example.com" });

    mockBypass = true;
    mockFindOrganization.mockResolvedValue(null);
    expect(await resolveOrganization(ACME.slug)).toEqual({ kind: "not-member", email: null });
  });

  test.each([
    ["nobody is signed in", () => mockAuth.mockResolvedValue(null), { kind: "signed-out" }],
    [
      "the membership could not be read",
      () => {
        quietErrors();
        mockAuth.mockResolvedValue(session());
        mockFindMembership.mockRejectedValue(DATABASE_DOWN);
      },
      { kind: "unavailable" },
    ],
  ])("answers in kind when %s", async (_name, arrange, expected) => {
    arrange();
    expect(await resolveOrganization(TEST_ORG.slug)).toEqual(expected);
  });

  test("on the desktop it still looks in the organization it is handed", async () => {
    onTheDesktop();
    signedInAs(VIEWER);
    await resolveOrganization(TEST_ORG.slug);
    expect(mockFindMembership).toHaveBeenCalledWith("ed@example.com", TEST_ORG.slug);
    expect(mockFindDefaultMembership).not.toHaveBeenCalled();
  });
});
