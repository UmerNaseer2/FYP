// Two ways the sign-in path used to give someone more than they should have.
//
// AUTH-2 — a deleted user got their old role back. The session callback re-reads
// the role from the database on every session read, so that demoting somebody
// takes effect at once instead of waiting for their token to expire. But when
// the lookup came back empty it fell back to `token.role`, and the token is a
// copy of the answer from up to thirty days ago. Demote an admin to viewer,
// delete them, and the fallback handed back the role they signed in with: admin.
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
import { toRole, DEFAULT_ROLE, ROLES } from "@/lib/auth-mode";

describe("the role a session gets", () => {
  it("gives the least privilege when the profile lookup found nothing", async () => {
    // getProfileRole returns null for "no such profile" and THROWS when the
    // database cannot be read, so null has exactly one meaning here. It is the
    // value the session callback now passes straight through.
    expect(toRole(null)).toBe("viewer");
    expect(toRole(null)).toBe(DEFAULT_ROLE);
    expect(toRole(undefined)).toBe(DEFAULT_ROLE);
  });

  it("still honours a role the database does return", async () => {
    for (const role of ROLES) expect(toRole(role)).toBe(role);
  });

  it("does not trust a role it does not recognise", async () => {
    // A column somebody edited by hand, or a claim from a token.
    expect(toRole("superuser")).toBe(DEFAULT_ROLE);
    expect(toRole("Admin")).toBe(DEFAULT_ROLE);
    expect(toRole(42)).toBe(DEFAULT_ROLE);
    expect(toRole({ role: "admin" })).toBe(DEFAULT_ROLE);
  });
});

describe("the session callback in auth.ts", () => {
  // Read as source rather than called. NextAuth does not hand its callbacks
  // back — `NextAuth({...})` returns handlers, signIn, signOut and auth, and
  // nothing else — so there is no way to invoke this one from a test. What can
  // be checked is the thing that was wrong and that an edit could put back:
  // whether the token's stale role is consulted at all.
  const source = fs.readFileSync(
    path.join(__dirname, "..", "auth.ts"),
    "utf8"
  );

  /** The body of `async session({ session, token })`, up to the next callback. */
  const sessionCallback = (() => {
    const start = source.indexOf("async session(");
    expect(start).toBeGreaterThan(-1);
    const end = source.indexOf("\n  },", start);
    expect(end).toBeGreaterThan(start);
    return source.slice(start, end);
  })();

  it("resolves the role from the lookup alone, never from the token", async () => {
    expect(sessionCallback).toContain("toRole(role)");
    // The exact shape of the bug, and anything else that reaches for the token
    // while deciding a role.
    expect(sessionCallback).not.toMatch(/role\s*\?\?\s*token\.role/);
    expect(sessionCallback).not.toMatch(/toRole\([^)]*token\.role/);
  });

  it("still reads the profile id from the token, which is not a privilege", async () => {
    // token.role is the problem; token.profileId is not. It only says which row
    // this person is, and a stale one names a profile that no longer exists —
    // it grants nothing on its own.
    expect(source).toContain("typeof token.profileId === \"number\"");
  });

  it("falls back to the least privilege when the lookup throws", async () => {
    // The other half: a database that cannot be read must not hand out a role
    // either. This path is what makes null unambiguous above.
    expect(sessionCallback).toContain("session.user.role = DEFAULT_ROLE");
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
      /* eslint-disable-next-line @typescript-eslint/no-require-imports */
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
