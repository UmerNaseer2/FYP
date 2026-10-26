/**
 * The desktop app's sign-in, on the server side: the check that decides
 * whether to believe the Microsoft ID token the app hands over.
 *
 * In a browser, Auth.js talks to Microsoft itself and never has to take
 * anybody's word for who signed in. The desktop app cannot do it that way (it
 * carries no client secret, see lib/desktop-sign-in.ts), so it posts the ID
 * token it got back from Microsoft and the server checks it. That check is the
 * whole of the desktop app's sign-in security: anything it lets through is
 * signed in, so every way it can say no is pinned down here.
 *
 * jose, the library that checks the signature, is replaced. Proving that a
 * forged signature fails is jose's job and is covered by jose's own tests;
 * what is checked here is what this server ASKS jose to verify (whose keys,
 * which issuer, which audience, how old a token may be) and what it does with
 * the claims jose hands back, which is where a mistake of ours would let
 * somebody in.
 *
 * The second half checks auth.config.ts: that the desktop app offers this
 * sign-in and only this one, that the provider really goes through the check
 * rather than around it, and that the browser offers Microsoft and GitHub only
 * once each is set up, with Microsoft accounts from other organizations only
 * when AZURE_AD_ANY_ACCOUNT says so.
 *
 * What is NOT here:
 *  - The login screen's side of it (waiting, cancelling, the messages):
 *    tests/page-login.test.tsx.
 *  - The proxy guarding pages once somebody is signed in: tests/proxy.test.ts.
 *  - What GitHub's sign-in reads from GitHub: tests/auth-config-github.test.ts.
 *  - The Microsoft sign-in in the system browser, which happens in the
 *    desktop app itself (desktop/ at the root of this repository).
 */

import { verifyDesktopIdToken } from "@/lib/desktop-sign-in";

const mockJwtVerify = jest.fn();
// Hands back a stand-in key set that records whose keys it would fetch, so a
// case can check the URL without anything leaving the machine.
const mockCreateRemoteJWKSet = jest.fn((url: URL) => ({ keysFrom: url.href }));

// jose ships as an ES module, which Jest's CommonJS runtime cannot load, and
// the real one would fetch Microsoft's keys over the network anyway. Each
// stand-in passes straight through to a mock above, so the cases can answer
// and inspect the calls (and the mocks survive jest.resetModules below).
jest.mock("jose", () => ({
  createRemoteJWKSet: (url: URL) => mockCreateRemoteJWKSet(url),
  jwtVerify: (...args: unknown[]) => mockJwtVerify(...args),
}));
// Both helpers are ES modules too. The stand-ins keep the options that matter
// here, so a case can see which Microsoft issuer the server would use and that
// GitHub reads accounts the app's own way.
jest.mock("next-auth/providers/microsoft-entra-id", () => ({
  __esModule: true,
  default: (options: { issuer?: string }) => ({ id: "microsoft-entra-id", issuer: options.issuer }),
}));
jest.mock("next-auth/providers/github", () => ({
  __esModule: true,
  default: (options: { userinfo?: unknown }) => ({ id: "github", userinfo: options.userinfo }),
}));

// The shapes of real IDs from the Azure portal. Made up, and not secret even
// when real: both are printed on the app registration's overview page.
const CLIENT = "11111111-2222-3333-4444-555555555555";
const TENANT = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
// An account's object ID, in capitals the way the Azure portal shows them. A
// token carries it in lowercase, but the key must not depend on that.
const OBJECT_ID = "BBBBBBBB-1111-2222-3333-444444444444";
/** The key the browser sign-in files the same person under. */
const ADA = `${TENANT}:${OBJECT_ID.toLowerCase()}`;
const TOKEN = "header.payload.signature";
const SESSION_SECRET = "a-test-secret-that-is-long-enough";

/** What Microsoft puts in a work account's ID token, as far as the check reads it. */
function claims(over: Record<string, unknown> = {}) {
  return {
    tid: TENANT,
    oid: OBJECT_ID,
    sub: "a-subject-for-ada",
    email: "ada@contoso.example",
    preferred_username: "ada@contoso.example",
    name: "Ada Lovelace",
    ...over,
  };
}

/** jose finding the signature good, and handing these claims back. */
function verifiesAs(payload: Record<string, unknown>) {
  mockJwtVerify.mockResolvedValue({ payload, protectedHeader: { alg: "RS256" } });
}

const ENV_KEYS = [
  "SCHEMA_STUDIO_DESKTOP",
  "AZURE_AD_CLIENT_ID",
  "AZURE_AD_CLIENT_SECRET",
  "AZURE_AD_TENANT_ID",
  "AZURE_AD_ANY_ACCOUNT",
  "GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
  "NEXTAUTH_SECRET",
] as const;
type EnvKey = (typeof ENV_KEYS)[number];

/** Sets exactly these keys, and unsets the rest, whatever the machine has. */
function setEnv(env: Partial<Record<EnvKey, string>>) {
  for (const key of ENV_KEYS) {
    const value = env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

const saved: Partial<Record<EnvKey, string>> = {};
let warn: jest.SpyInstance;

beforeEach(() => {
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  setEnv({ AZURE_AD_CLIENT_ID: CLIENT, AZURE_AD_TENANT_ID: TENANT });
  mockJwtVerify.mockReset();
  mockCreateRemoteJWKSet.mockClear();
  // Every refusal is logged for whoever reads the app's logs. Kept quiet here,
  // and read back by the cases that care what it says.
  warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  setEnv(saved);
  warn.mockRestore();
});

/** Everything the server wrote to its log while the case ran. */
const logged = () => warn.mock.calls.map((call) => String(call[0])).join("\n");

describe("checking the token the desktop app hands over", () => {
  describe("before asking jose anything", () => {
    it.each([
      ["both empty", { AZURE_AD_CLIENT_ID: "", AZURE_AD_TENANT_ID: "" }],
      // Placeholder words left where the IDs belong. Without the shape check
      // these would build an issuer URL that can never match, and the log
      // would blame the token.
      ["placeholders rather than IDs", { AZURE_AD_CLIENT_ID: "client", AZURE_AD_TENANT_ID: "tenant" }],
      ["the tenant missing", { AZURE_AD_CLIENT_ID: CLIENT }],
      ["the client missing", { AZURE_AD_TENANT_ID: TENANT }],
      ["neither ever set", {}],
    ])("refuses every token when the app's IDs are %s, and says which keys to set", async (_, env) => {
      setEnv(env);
      verifiesAs(claims());
      expect(await verifyDesktopIdToken(TOKEN)).toBeNull();
      expect(mockJwtVerify).not.toHaveBeenCalled();
      expect(logged()).toContain("AZURE_AD_CLIENT_ID and AZURE_AD_TENANT_ID must both be set");
    });

    it.each([
      ["no token at all", undefined],
      ["a number", 42],
      ["an empty string", ""],
      ["one character over the limit", "x".repeat(16_385)],
    ])("refuses %s without parsing anything", async (_, token) => {
      verifiesAs(claims());
      expect(await verifyDesktopIdToken(token)).toBeNull();
      expect(mockJwtVerify).not.toHaveBeenCalled();
      expect(logged()).toContain("did not carry a usable ID token");
    });

    it("still checks a token right at the limit", async () => {
      // Real ID tokens run to two or three thousand characters. The limit is
      // there to stop a request making the server parse a megabyte, not to
      // turn away a long but genuine token.
      verifiesAs(claims());
      const token = "x".repeat(16_384);
      expect(await verifyDesktopIdToken(token)).not.toBeNull();
      expect(mockJwtVerify).toHaveBeenCalledWith(token, expect.anything(), expect.anything());
    });
  });

  describe("what it asks jose to verify", () => {
    it("checks the signature against this tenant's keys, for this app, signed with RS256, issued in the last ten minutes", async () => {
      verifiesAs(claims());
      await verifyDesktopIdToken(TOKEN);
      expect(mockJwtVerify).toHaveBeenCalledTimes(1);
      expect(mockJwtVerify).toHaveBeenCalledWith(
        TOKEN,
        { keysFrom: `https://login.microsoftonline.com/${TENANT}/discovery/v2.0/keys` },
        {
          // A genuine token Microsoft issued to another organization, or to
          // some other app, fails one of these two.
          issuer: `https://login.microsoftonline.com/${TENANT}/v2.0`,
          audience: CLIENT,
          // Named, so a token cannot pick a weaker algorithm for itself.
          algorithms: ["RS256"],
          // Used only in the seconds after a sign-in, so anything older is
          // somebody replaying a token they got hold of.
          maxTokenAge: "10m",
          clockTolerance: "5m",
        }
      );
    });

    it("accepts the IDs pasted in capitals or with spaces, the way the Azure portal copies them", async () => {
      setEnv({
        AZURE_AD_CLIENT_ID: `  ${CLIENT.toUpperCase()}  `,
        AZURE_AD_TENANT_ID: TENANT.toUpperCase(),
      });
      verifiesAs(claims());
      expect(await verifyDesktopIdToken(TOKEN)).not.toBeNull();
      // Microsoft writes both in lowercase inside the token, so that is what
      // they are compared as.
      expect(mockJwtVerify).toHaveBeenCalledWith(
        TOKEN,
        expect.anything(),
        expect.objectContaining({
          issuer: `https://login.microsoftonline.com/${TENANT}/v2.0`,
          audience: CLIENT,
        })
      );
    });

    it("fetches a tenant's keys once and keeps them", async () => {
      // A tenant no other case uses, so the module's own key cache starts
      // empty for it whatever ran before.
      const tenant = "bbbbbbbb-cccc-dddd-eeee-ffffffffffff";
      setEnv({ AZURE_AD_CLIENT_ID: CLIENT, AZURE_AD_TENANT_ID: tenant });
      verifiesAs(claims({ tid: tenant }));
      await verifyDesktopIdToken(TOKEN);
      await verifyDesktopIdToken(TOKEN);
      expect(mockJwtVerify).toHaveBeenCalledTimes(2);
      expect(mockCreateRemoteJWKSet).toHaveBeenCalledTimes(1);
      expect(mockCreateRemoteJWKSet.mock.calls[0][0].href).toBe(
        `https://login.microsoftonline.com/${tenant}/discovery/v2.0/keys`
      );
    });

    it.each([
      ["an expired token", new Error('"exp" claim timestamp check failed'), '"exp" claim timestamp check failed'],
      ["a token for another app", new Error('unexpected "aud" claim value'), 'unexpected "aud" claim value'],
      ["a failure that is not an Error", "the keys could not be fetched", "the keys could not be fetched"],
    ])("turns jose refusing %s into a quiet no, with the reason in the log", async (_, failure, reason) => {
      // A throw from here would reach Auth.js as "Configuration", and the
      // person would be told the app is broken rather than that the sign-in
      // did not work.
      mockJwtVerify.mockRejectedValue(failure);
      await expect(verifyDesktopIdToken(TOKEN)).resolves.toBeNull();
      expect(logged()).toContain(`[desktop sign-in] Refused a sign-in: ${reason}`);
    });
  });

  describe("what it reads from a token jose accepted", () => {
    it.each([
      ["another organization's", "99999999-8888-7777-6666-555555555555"],
      ["no", undefined],
    ])("refuses a token carrying %s tenant ID", async (_, tid) => {
      verifiesAs(claims({ tid }));
      expect(await verifyDesktopIdToken(TOKEN)).toBeNull();
      expect(logged()).toContain("issued for a different organization");
    });

    it.each([
      ["missing", undefined],
      ["blank", "   "],
    ])("refuses a token whose object ID is %s", async (_, oid) => {
      verifiesAs(claims({ oid }));
      expect(await verifyDesktopIdToken(TOKEN)).toBeNull();
      expect(logged()).toContain("does not say which account signed in");
    });

    it("signs in the person the token names, with their name tidied", async () => {
      verifiesAs(claims({ name: "  Ada Lovelace  " }));
      expect(await verifyDesktopIdToken(TOKEN)).toEqual({
        id: ADA,
        email: "ada@contoso.example",
        name: "Ada Lovelace",
      });
      expect(warn).not.toHaveBeenCalled();
    });

    it("signs in an account with no display name, as nobody in particular", async () => {
      verifiesAs(claims({ name: undefined }));
      expect(await verifyDesktopIdToken(TOKEN)).toEqual({
        id: ADA,
        email: "ada@contoso.example",
        name: null,
      });
    });

    it("keys the person by tenant and object ID, whatever the subject says", async () => {
      // `sub` differs between app registrations for the same person. The
      // object ID does not, so the browser sign-in and this one meet.
      verifiesAs(claims({ sub: "a-subject-another-app-would-see" }));
      expect((await verifyDesktopIdToken(TOKEN))?.id).toBe(ADA);
    });

    it("prefers the mailbox address when the account has one", async () => {
      verifiesAs(
        claims({ email: "ada.lovelace@contoso.example", preferred_username: "alovelace@contoso.example" })
      );
      expect((await verifyDesktopIdToken(TOKEN))?.email).toBe("ada.lovelace@contoso.example");
    });

    it("falls back to the sign-in name for an account with no mailbox", async () => {
      // The same rule as the browser sign-in (lib/accounts-db.ts), so the same
      // person shows up under the same address from either.
      verifiesAs(claims({ email: undefined, preferred_username: "ada@contoso.example" }));
      expect((await verifyDesktopIdToken(TOKEN))?.email).toBe("ada@contoso.example");
    });

    it("skips an email claim that is not an address", async () => {
      verifiesAs(claims({ email: "not-an-address", preferred_username: "ada@contoso.example" }));
      expect((await verifyDesktopIdToken(TOKEN))?.email).toBe("ada@contoso.example");
    });

    it("refuses an account with no address anywhere", async () => {
      verifiesAs(claims({ email: undefined, preferred_username: "ada" }));
      expect(await verifyDesktopIdToken(TOKEN)).toBeNull();
      expect(logged()).toContain("has no email address");
    });
  });
});

describe("the sign-in the server offers", () => {
  // auth.config.ts decides what to offer when it loads, so each case loads a
  // fresh copy after setting the environment it is about.
  async function loadAuthConfig() {
    jest.resetModules();
    return import("../auth.config");
  }

  const ids = (providers: ReadonlyArray<{ id?: string }>) => providers.map((provider) => provider.id);

  it("offers only the desktop sign-in inside the desktop app", async () => {
    setEnv({
      SCHEMA_STUDIO_DESKTOP: "1",
      AZURE_AD_CLIENT_ID: CLIENT,
      AZURE_AD_TENANT_ID: TENANT,
      NEXTAUTH_SECRET: SESSION_SECRET,
    });
    const config = await loadAuthConfig();
    expect(ids(config.authConfig.providers)).toEqual(["desktop"]);
    expect(config.authUsable).toBe(true);
  });

  it("never offers the browser sign-in inside the desktop app, even with a client secret set", async () => {
    // The browser sign-in would send Microsoft back to an address the app
    // registration does not list (the desktop server's port changes on every
    // start), so offering it could only ever end in an error page.
    setEnv({
      SCHEMA_STUDIO_DESKTOP: "1",
      AZURE_AD_CLIENT_ID: CLIENT,
      AZURE_AD_CLIENT_SECRET: "a-client-secret-for-the-browser",
      AZURE_AD_TENANT_ID: TENANT,
      NEXTAUTH_SECRET: SESSION_SECRET,
    });
    const config = await loadAuthConfig();
    expect(ids(config.authConfig.providers)).toEqual(["desktop"]);
    expect(config.entraConfigured).toBe(false);
    expect(config.desktopConfigured).toBe(true);
  });

  it.each([
    ["client", { AZURE_AD_TENANT_ID: TENANT }],
    ["tenant", { AZURE_AD_CLIENT_ID: CLIENT }],
  ])("offers nothing in a desktop app built without the %s ID", async (_, idsSet) => {
    setEnv({ SCHEMA_STUDIO_DESKTOP: "1", NEXTAUTH_SECRET: SESSION_SECRET, ...idsSet });
    const config = await loadAuthConfig();
    expect(config.authConfig.providers).toEqual([]);
    expect(config.authUsable).toBe(false);
  });

  it("is not usable without the session secret the app makes for itself", async () => {
    setEnv({ SCHEMA_STUDIO_DESKTOP: "1", AZURE_AD_CLIENT_ID: CLIENT, AZURE_AD_TENANT_ID: TENANT });
    const config = await loadAuthConfig();
    expect(config.desktopConfigured).toBe(true);
    expect(config.authUsable).toBe(false);
  });

  it("leaves the browser sign-in as it was everywhere else", async () => {
    setEnv({
      AZURE_AD_CLIENT_ID: CLIENT,
      AZURE_AD_CLIENT_SECRET: "a-client-secret-for-the-browser",
      AZURE_AD_TENANT_ID: TENANT,
      NEXTAUTH_SECRET: SESSION_SECRET,
    });
    const config = await loadAuthConfig();
    expect(ids(config.authConfig.providers)).toEqual(["microsoft-entra-id"]);
    expect(config.desktopMode).toBe(false);
    expect(config.desktopConfigured).toBe(false);
    expect(config.githubConfigured).toBe(false);
    // Only the home tenant's accounts, until the switch below is set.
    expect(config.authConfig.providers[0]).toMatchObject({
      issuer: `https://login.microsoftonline.com/${TENANT}/v2.0`,
    });
  });

  it("takes any Microsoft account only when told to, and only with exactly true", async () => {
    const entra = {
      AZURE_AD_CLIENT_ID: CLIENT,
      AZURE_AD_CLIENT_SECRET: "a-client-secret-for-the-browser",
      AZURE_AD_TENANT_ID: TENANT,
      NEXTAUTH_SECRET: SESSION_SECRET,
    };
    setEnv({ ...entra, AZURE_AD_ANY_ACCOUNT: "true" });
    let config = await loadAuthConfig();
    expect(config.authConfig.providers[0]).toMatchObject({
      issuer: "https://login.microsoftonline.com/common/v2.0",
    });

    // A registration that takes only its own tenant refuses the common
    // sign-in page outright, so a loose value must not switch to it.
    setEnv({ ...entra, AZURE_AD_ANY_ACCOUNT: "yes" });
    config = await loadAuthConfig();
    expect(config.authConfig.providers[0]).toMatchObject({
      issuer: `https://login.microsoftonline.com/${TENANT}/v2.0`,
    });
  });

  it("offers GitHub once its two keys are set, after Microsoft", async () => {
    const github = { GITHUB_CLIENT_ID: "a-github-client", GITHUB_CLIENT_SECRET: "a-github-secret" };
    setEnv({ ...github, NEXTAUTH_SECRET: SESSION_SECRET });
    let config = await loadAuthConfig();
    expect(ids(config.authConfig.providers)).toEqual(["github"]);
    expect(config.authUsable).toBe(true);
    // Accounts are read the app's way, which records whether the address was
    // checked (tests/auth-config-github.test.ts).
    expect(config.authConfig.providers[0]).toMatchObject({
      userinfo: { request: config.readGitHubAccount },
    });

    setEnv({
      ...github,
      AZURE_AD_CLIENT_ID: CLIENT,
      AZURE_AD_CLIENT_SECRET: "a-client-secret-for-the-browser",
      AZURE_AD_TENANT_ID: TENANT,
      NEXTAUTH_SECRET: SESSION_SECRET,
    });
    config = await loadAuthConfig();
    expect(ids(config.authConfig.providers)).toEqual(["microsoft-entra-id", "github"]);

    setEnv({ GITHUB_CLIENT_ID: "a-github-client", NEXTAUTH_SECRET: SESSION_SECRET });
    config = await loadAuthConfig();
    expect(config.authConfig.providers).toEqual([]);
    expect(config.authUsable).toBe(false);
  });

  it("never offers GitHub inside the desktop app", async () => {
    setEnv({
      SCHEMA_STUDIO_DESKTOP: "1",
      AZURE_AD_CLIENT_ID: CLIENT,
      AZURE_AD_TENANT_ID: TENANT,
      GITHUB_CLIENT_ID: "a-github-client",
      GITHUB_CLIENT_SECRET: "a-github-secret",
      NEXTAUTH_SECRET: SESSION_SECRET,
    });
    const config = await loadAuthConfig();
    expect(ids(config.authConfig.providers)).toEqual(["desktop"]);
    expect(config.githubConfigured).toBe(false);
  });

  it("takes only the exact switch the desktop app sets", async () => {
    // Anything looser and a server with SCHEMA_STUDIO_DESKTOP=true left in its
    // environment by accident would start accepting tokens it was never meant
    // to see, in place of its own sign-in.
    setEnv({
      SCHEMA_STUDIO_DESKTOP: "true",
      AZURE_AD_CLIENT_ID: CLIENT,
      AZURE_AD_TENANT_ID: TENANT,
      NEXTAUTH_SECRET: SESSION_SECRET,
    });
    const config = await loadAuthConfig();
    expect(config.desktopMode).toBe(false);
    expect(config.authConfig.providers).toEqual([]);
  });

  it("signs a person in through the token check and never around it", async () => {
    setEnv({
      SCHEMA_STUDIO_DESKTOP: "1",
      AZURE_AD_CLIENT_ID: CLIENT,
      AZURE_AD_TENANT_ID: TENANT,
      NEXTAUTH_SECRET: SESSION_SECRET,
    });
    const { authConfig } = await loadAuthConfig();
    const [desktop] = authConfig.providers;
    if (!desktop || !("authorize" in desktop)) throw new Error("the desktop sign-in is not offered");

    verifiesAs(claims());
    await expect(desktop.authorize({ idToken: TOKEN })).resolves.toEqual({
      id: ADA,
      email: "ada@contoso.example",
      name: "Ada Lovelace",
    });
    expect(mockJwtVerify).toHaveBeenCalledWith(TOKEN, expect.anything(), expect.anything());

    // A post with no token is refused before anything is parsed.
    mockJwtVerify.mockClear();
    await expect(desktop.authorize({})).resolves.toBeNull();
    expect(mockJwtVerify).not.toHaveBeenCalled();
  });
});
