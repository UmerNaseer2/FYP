// Two ways the sign-in path used to give someone more than they should have.
//
// AUTH-2 — a deleted user got their old role back. The session callback used
// to re-read the role from the database on every session read, so that
// demoting somebody took effect at once instead of waiting for their token to
// expire. But when the lookup came back empty it fell back to `token.role`,
// and the token is a copy of the answer from up to thirty days ago. Demote an
// admin to viewer, delete them, and the fallback handed back the role they
// signed in with: admin.
//
// The session carries no role at all now. It says who someone is, and the
// gates in lib/auth-guard.ts read what they may do from their membership on
// every request, so there is nothing in the token left to fall back on. What
// the tests below hold the callbacks to is not putting any of it back: no role
// copied into the session, and no token refresh quietly making somebody an
// admin removed a member again on their next click.
//
// AUTH-4 — the bypass switch only understood one spelling of "off". Anything
// but the exact text `false` left authentication turned off, and there is no
// sign-in screen either way, so nothing on screen told you which one you got.
// It is an allow-list now, and the same argument that decided the spellings
// later decided the default: an unset variable enforces authentication rather
// than switching it off, so the deployment that forgets it is refused rather
// than served. Turning the bypass on for testing is a deliberate line.
import fs from "fs";
import path from "path";
import { DEFAULT_ROLE, effectivePermissions, presetFor } from "@/lib/permissions";

/** The parts of a NextAuth token the callbacks read or write. */
type Token = {
  email?: string | null;
  name?: string | null;
  profileId?: number;
  [claim: string]: unknown;
};
type Person = { email?: string | null; name?: string | null };
type SessionShape = { user: { id?: string; email?: string; name?: string }; expires: string };
type Callbacks = {
  jwt(params: { token: Token; user?: Person }): Promise<Token>;
  session(params: { session: SessionShape; token: Token }): SessionShape;
};

// next-auth and the Entra provider ship as ESM, which Jest's CommonJS runtime
// cannot require, so both are stand-ins, as in tests/proxy.test.ts. This
// NextAuth keeps the configuration auth.ts hands it, which the real one never
// gives back, and that is how the tests below reach the callbacks to call them.
let mockConfig: { callbacks: Callbacks } | undefined;
jest.mock("next-auth", () => ({
  __esModule: true,
  default: (config: { callbacks: Callbacks }) => {
    mockConfig = config;
    return { handlers: {}, auth: jest.fn(), signIn: jest.fn(), signOut: jest.fn() };
  },
}));
jest.mock("next-auth/providers/microsoft-entra-id", () => ({
  __esModule: true,
  default: () => ({ id: "microsoft-entra-id" }),
}));
// The database half of signing in. What it does with a profile and a
// membership is tested against a real database in tests/org-migration.test.ts;
// here it is only whether the callbacks call it, when, and with what. Relative
// paths on purpose: next/jest rewrites the @/ alias inside import statements
// only, so jest.mock("@/...") would not resolve.
const mockUpsertProfile = jest.fn();
jest.mock("../lib/version-db", () => ({
  upsertProfile: (...args: unknown[]) => mockUpsertProfile(...args),
}));

/** The callbacks auth.ts gave NextAuth. */
async function loadCallbacks(): Promise<Callbacks> {
  // Imported here rather than at the top of the file: imports run first,
  // before the `let` above exists for the stand-in to write to.
  await import("../auth");
  if (!mockConfig) throw new Error("auth.ts did not call NextAuth.");
  return mockConfig.callbacks;
}

const UMER = { email: "umer@x", name: "Umer" };
const EXPIRES = "2026-11-25T00:00:00.000Z";
/** A session as NextAuth hands it to the callback, before anything is added. */
const freshSession = (): SessionShape => ({ user: { ...UMER }, expires: EXPIRES });

describe("the role a member holds", () => {
  it("starts a person nobody has given a role as a viewer", async () => {
    // Everyone who joins an organization that already has members starts with
    // this role (upsertProfile in lib/version-db.ts), and an admin decides from
    // there. Viewer is the least the app gives anyone.
    expect(DEFAULT_ROLE).toBe("viewer");
  });

  it("gives a role it does not know nothing beyond what was granted to it", async () => {
    // A column somebody edited by hand names a role with no rows. It has no
    // preset to fall back on, and holds exactly what its rows say: nothing.
    expect(presetFor("superuser")).toBeNull();
    expect(effectivePermissions("superuser", [])).toEqual([]);
  });

  it("does not take a differently written admin for the admin", async () => {
    // "Admin" is not "admin". Only the real key gets everything; any other role
    // holds what was granted, and never an admin-only permission.
    expect(effectivePermissions("Admin", ["deploy:run", "users:read"])).toEqual([
      "deploy:read",
      "deploy:run",
    ]);
  });
});

describe("the sign-in callbacks in auth.ts", () => {
  // Called, not read. NextAuth never hands its callbacks back, but the
  // stand-in above keeps what auth.ts gave it, so each one runs here the way
  // NextAuth runs it, with a token and a session shaped like NextAuth's.
  let callbacks: Callbacks;
  beforeAll(async () => {
    callbacks = await loadCallbacks();
  });
  beforeEach(() => {
    mockUpsertProfile.mockReset();
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("provisions the person at sign-in, as the provider named them", async () => {
    // At sign-in NextAuth builds a fresh token from what the provider sent,
    // and hands the same person over as `user`.
    mockUpsertProfile.mockResolvedValue({ id: 41, ...UMER });
    const token = await callbacks.jwt({ token: { ...UMER }, user: { ...UMER } });

    expect(mockUpsertProfile.mock.calls).toEqual([[UMER.email, UMER.name]]);
    expect(token).toEqual({ ...UMER, profileId: 41 });
  });

  it("leaves a provisioned token alone, so a removed member stays removed", async () => {
    // The callback runs again on every request that reads the session, long
    // after sign-in. Provisioning there would make somebody an admin has just
    // removed a member again on their very next click.
    const provisioned = { ...UMER, profileId: 41 };
    const token = await callbacks.jwt({ token: { ...provisioned } });

    expect(mockUpsertProfile).not.toHaveBeenCalled();
    expect(token).toEqual(provisioned);
  });

  it("tries again on a later request when sign-in could not provision", async () => {
    // A token with no profile id was never provisioned, so there is nothing
    // yet that an admin could have taken away.
    mockUpsertProfile.mockResolvedValue({ id: 41, ...UMER });
    const token = await callbacks.jwt({ token: { ...UMER } });

    expect(mockUpsertProfile.mock.calls).toEqual([[UMER.email, UMER.name]]);
    expect(token).toEqual({ ...UMER, profileId: 41 });
  });

  it("hands out nothing in its place when the database does not answer", async () => {
    // No profile means no membership, and every gate refuses. The token stays
    // without a profile id, so the next request tries again.
    mockUpsertProfile.mockRejectedValue(new Error("connect ECONNREFUSED"));
    const errors = jest.spyOn(console, "error").mockImplementation(() => {});
    const token = await callbacks.jwt({ token: { ...UMER }, user: { ...UMER } });

    expect(token).toEqual(UMER);
    expect(errors).toHaveBeenCalledWith(
      "Failed to provision profile on sign-in:",
      expect.any(Error)
    );
  });

  it("puts who the person is in the session, and nothing about what they may do", () => {
    // A token from before organizations still carries the role its owner
    // signed in with. It is never read: what a member may do comes from the
    // gates, fresh on every request. The profile id is read, and it grants
    // nothing either. It only says which row this person is.
    const token = { ...UMER, profileId: 41, role: "admin" };
    const session = callbacks.session({ session: freshSession(), token });

    // A plain answer, not a promise: reading a session never waits on the
    // database.
    expect(session).not.toBeInstanceOf(Promise);
    expect(session).toEqual({ user: { ...UMER, id: "41" }, expires: EXPIRES });
  });

  it("has no id to put in the session before the person is provisioned", () => {
    const session = callbacks.session({ session: freshSession(), token: { ...UMER } });
    expect(session).toEqual({ user: UMER, expires: EXPIRES });
  });
});

describe("the auth bypass switch", () => {
  /** BYPASS_AUTH as a fresh import would compute it for this env value. */
  function bypassFor(value: string | undefined): boolean {
    const previous = process.env.NEXT_PUBLIC_AUTH_BYPASS;
    if (value === undefined) delete process.env.NEXT_PUBLIC_AUTH_BYPASS;
    else process.env.NEXT_PUBLIC_AUTH_BYPASS = value;

    let result: boolean | undefined;
    jest.isolateModules(() => {
      // The value is read once, at module load, so the module has to be loaded
      // again for each spelling. require() and not import: an import is hoisted
      // out of this callback and evaluated once, which is exactly what has to
      // not happen here.
      result = (require("../lib/auth-mode") as { BYPASS_AUTH: boolean }).BYPASS_AUTH;
    });

    if (previous === undefined) delete process.env.NEXT_PUBLIC_AUTH_BYPASS;
    else process.env.NEXT_PUBLIC_AUTH_BYPASS = previous;
    return result as boolean;
  }

  it("understands every ordinary way of writing 'off'", async () => {
    // These reach the same answer as a typo does now — the allow-list simply
    // does not contain them — but they are the spellings a person actually
    // writes meaning off, so they are worth asserting by name: a later edit
    // that "helpfully" added "no" or "0" to the on-list would fail here.
    for (const off of ["false", "False", "FALSE", "  false  ", "0", "no", "NO", "off", "Off"]) {
      expect(bypassFor(off)).toBe(false);
    }
  });

  it("enforces authentication when the variable is unset", async () => {
    // This is the whole point of the switch being an allow-list. A deployment
    // that forgets the variable is refused rather than served: the two mistakes
    // are equally easy to make and only one of them is visible, because a
    // checkout that comes up locked says so on the first click while one that
    // comes up open looks exactly like one that is properly signed in.
    expect(bypassFor(undefined)).toBe(false);
    expect(bypassFor("")).toBe(false);
  });

  it("turns the bypass on for every ordinary way of writing 'on'", async () => {
    // More than just "true" on purpose: each of these is something a person
    // writes meaning on, and getting a locked app instead would be an hour of
    // confusion for no reason. The stray spaces are the ones that come off the
    // end of a line in .env.local.
    for (const on of ["true", "True", "TRUE", "  true  ", "1", "yes", "YES", "on", "On"]) {
      expect(bypassFor(on)).toBe(true);
    }
  });

  it("enforces authentication for anything it does not recognise", async () => {
    // The case the old deny-list got wrong. It asked whether the value meant
    // off, so a value it could not read — a typo, a stray quote, half a line —
    // fell through to leaving the app open to everybody with nothing on screen
    // to say so. Now an unreadable value costs a sign-in prompt instead.
    for (const unknown of ["please", "falsey", "truthy", "tru", '"true"', "enabled", "y"]) {
      expect(bypassFor(unknown)).toBe(false);
    }
  });

  it("is written out in full so the bundler can find it", async () => {
    // Next substitutes the literal text `process.env.NEXT_PUBLIC_AUTH_BYPASS`
    // for its value while compiling. A computed read — process.env[name], or
    // the variable reached through a helper — is never substituted, so in the
    // browser it is always undefined and the bypass is always on.
    const source = fs.readFileSync(
      path.join(__dirname, "..", "lib", "auth-mode.ts"),
      "utf8"
    );
    // Comments stripped first — the one above the export explains this rule by
    // quoting the very shape the rule forbids, and would fail its own test.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(code).toContain("process.env.NEXT_PUBLIC_AUTH_BYPASS");
    expect(code).not.toMatch(/process\.env\[/);
  });

  it("says in the file that a built app needs rebuilding", async () => {
    // The comment used to call changing this "one line in .env.local", and for
    // a built app that line does nothing at all.
    const source = fs.readFileSync(
      path.join(__dirname, "..", "lib", "auth-mode.ts"),
      "utf8"
    );
    expect(source).toMatch(/rebuild/i);
    expect(source).toContain("--build-arg");
  });
});
