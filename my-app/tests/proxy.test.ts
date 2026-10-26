// The edge proxy is the only thing standing between an anonymous request and
// every page and API route in the app, and it is also the file most likely to
// be broken silently: it is picked up by FILENAME, so a rename, a moved export
// or a bad matcher stops it running without any error anywhere. Nothing else in
// the suite would notice.
//
// Each case reloads the module, because both switches it reads — the bypass
// flag and whether sign-in is configured at all — are captured at import time.

import { NextRequest } from "next/server";
import { isPublicPath } from "../lib/public-paths";

// next-auth and its provider ship as ESM, which Jest's CommonJS runtime cannot
// require, so both are stand-ins. The stand-in `auth()` does what the real one
// does for this file: it runs the proxy's own callback with `request.auth` set
// to whatever session the case puts in `mockSession`. That tests the proxy's
// decision about a session, not whether NextAuth decodes a cookie correctly;
// the second needs a real integration test, not a richer mock.
let mockSession: unknown = null;
jest.mock("next-auth", () => ({
  __esModule: true,
  default: () => ({
    auth:
      (handler: (request: unknown) => Response) =>
      (request: object) =>
        handler(Object.assign(request, { auth: mockSession })),
  }),
}));
jest.mock("next-auth/providers/microsoft-entra-id", () => ({
  __esModule: true,
  default: () => ({ id: "microsoft-entra-id" }),
}));
jest.mock("next-auth/providers/github", () => ({
  __esModule: true,
  default: () => ({ id: "github" }),
}));

type Proxy = (request: NextRequest) => Response | Promise<Response>;

async function loadProxy(env: Record<string, string | undefined>): Promise<{
  proxy: Proxy;
  config: { matcher: string[] };
}> {
  const saved = { ...process.env };
  Object.assign(process.env, env);
  jest.resetModules();
  const mod = await import("../proxy");
  process.env = saved;
  return { proxy: mod.default as Proxy, config: mod.config as { matcher: string[] } };
}

const page = () => new NextRequest("http://localhost:3000/studio");
const api = () => new NextRequest("http://localhost:3000/api/lineage");
const home = () => new NextRequest("http://localhost:3000/");

describe("edge proxy", () => {
  it("lets everything through while the bypass is on", async () => {
    const { proxy } = await loadProxy({ NEXT_PUBLIC_AUTH_BYPASS: "true" });
    expect((await proxy(page())).status).toBe(200);
    expect((await proxy(api())).status).toBe(200);
  });

  it("sends a page to /login when the bypass is off and sign-in is unconfigured", async () => {
    const { proxy } = await loadProxy({
      NEXT_PUBLIC_AUTH_BYPASS: "false",
      AZURE_AD_CLIENT_ID: "",
      AZURE_AD_CLIENT_SECRET: "",
      AZURE_AD_TENANT_ID: "",
      NEXTAUTH_SECRET: "",
    });
    const response = await proxy(page());
    expect(response.status).toBe(307);
    const location = new URL(response.headers.get("location") ?? "");
    expect(location.pathname).toBe("/login");
    // Without this the page says "signed out" and never says why.
    expect(location.searchParams.get("error")).toBe("Configuration");
  });

  it("answers an API call with a 401 rather than an HTML redirect", async () => {
    const { proxy } = await loadProxy({
      NEXT_PUBLIC_AUTH_BYPASS: "false",
      AZURE_AD_CLIENT_ID: "",
      AZURE_AD_CLIENT_SECRET: "",
      AZURE_AD_TENANT_ID: "",
      NEXTAUTH_SECRET: "",
    });
    const response = await proxy(api());
    // A fetch() follows a redirect and reads the login HTML as a success, so a
    // redirect here would look to the caller like an empty result rather than
    // a refusal.
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: "Sign-in is not set up on this server.",
    });
  });

  it("opens the landing page even where sign-in is not set up", async () => {
    const { proxy } = await loadProxy({
      NEXT_PUBLIC_AUTH_BYPASS: "false",
      AZURE_AD_CLIENT_ID: "",
      AZURE_AD_CLIENT_SECRET: "",
      AZURE_AD_TENANT_ID: "",
      NEXTAUTH_SECRET: "",
    });
    // The landing page tells a visitor what Schema Studio is before anyone
    // signs in, so it cannot wait for sign-in to be set up. Its "Log in"
    // button goes to /login, which says what is missing.
    expect((await proxy(home())).status).toBe(200);
    // Only "/": every other page still goes to /login.
    expect((await proxy(page())).status).toBe(307);
  });

  describe("with sign-in configured", () => {
    const signInOn = {
      NEXT_PUBLIC_AUTH_BYPASS: "false",
      AZURE_AD_CLIENT_ID: "client",
      AZURE_AD_CLIENT_SECRET: "secret",
      AZURE_AD_TENANT_ID: "tenant",
      NEXTAUTH_SECRET: "a-test-secret-that-is-long-enough",
    };

    afterEach(() => {
      mockSession = null;
    });

    it("lets a signed-in user through", async () => {
      mockSession = { user: { email: "someone@example.com" }, expires: "2099-01-01" };
      const { proxy } = await loadProxy(signInOn);
      expect((await proxy(page())).status).toBe(200);
      expect((await proxy(api())).status).toBe(200);
    });

    it("refuses a session object that has no user in it", async () => {
      // The shape the next-auth beta.31 advisory was about: something is there,
      // but nobody is signed in. Checking only that `auth` exists let it in.
      mockSession = { expires: "2099-01-01" };
      const { proxy } = await loadProxy(signInOn);
      expect((await proxy(api())).status).toBe(401);
      const response = await proxy(page());
      expect(response.status).toBe(307);
      const location = new URL(response.headers.get("location") ?? "");
      expect(location.pathname).toBe("/login");
      expect(location.searchParams.get("callbackUrl")).toBe("/studio");
    });

    it("refuses a request with no session at all", async () => {
      mockSession = null;
      const { proxy } = await loadProxy(signInOn);
      expect((await proxy(api())).status).toBe(401);
    });

    it("lets a signed-out visitor open the landing page and nothing else", async () => {
      mockSession = null;
      const { proxy } = await loadProxy(signInOn);
      expect((await proxy(home())).status).toBe(200);
      // The pathname decides, so a query string changes nothing.
      expect((await proxy(new NextRequest("http://localhost:3000/?from=email"))).status).toBe(200);
      expect((await proxy(page())).status).toBe(307);
      expect((await proxy(api())).status).toBe(401);
    });

    it("counts GitHub on its own as sign-in being set up", async () => {
      // Read as unconfigured, a signed-out visitor would be told sign-in is
      // not set up, on a server where the GitHub button works.
      mockSession = null;
      const { proxy } = await loadProxy({
        ...signInOn,
        AZURE_AD_CLIENT_ID: "",
        AZURE_AD_CLIENT_SECRET: "",
        AZURE_AD_TENANT_ID: "",
        GITHUB_CLIENT_ID: "github-client",
        GITHUB_CLIENT_SECRET: "github-secret",
      });
      const response = await proxy(page());
      expect(response.status).toBe(307);
      const location = new URL(response.headers.get("location") ?? "");
      expect(location.searchParams.get("error")).toBeNull();
      expect(location.searchParams.get("callbackUrl")).toBe("/studio");
      expect((await proxy(api())).status).toBe(401);
    });
  });

  describe("inside the desktop app", () => {
    // The desktop app carries no client secret and needs none: it does the
    // Microsoft sign-in itself, so the two IDs and the session secret it makes
    // for itself are all it takes for the proxy to start checking.
    const desktop = {
      NEXT_PUBLIC_AUTH_BYPASS: "false",
      SCHEMA_STUDIO_DESKTOP: "1",
      AZURE_AD_CLIENT_ID: "client",
      AZURE_AD_CLIENT_SECRET: "",
      AZURE_AD_TENANT_ID: "tenant",
      NEXTAUTH_SECRET: "a-test-secret-that-is-long-enough",
    };

    afterEach(() => {
      mockSession = null;
    });

    it("guards pages and API routes without a client secret", async () => {
      const { proxy } = await loadProxy(desktop);
      expect((await proxy(api())).status).toBe(401);
      const response = await proxy(page());
      expect(response.status).toBe(307);
      const location = new URL(response.headers.get("location") ?? "");
      expect(location.pathname).toBe("/login");
      expect(location.searchParams.get("callbackUrl")).toBe("/studio");
      // Sign-in is set up, so the login screen offers it rather than an error.
      expect(location.searchParams.get("error")).toBeNull();
    });

    it("lets a signed-in user through", async () => {
      mockSession = { user: { email: "someone@example.com" }, expires: "2099-01-01" };
      const { proxy } = await loadProxy(desktop);
      expect((await proxy(page())).status).toBe(200);
      expect((await proxy(api())).status).toBe(200);
    });

    it("says sign-in is not set up in an app built without the two IDs", async () => {
      const { proxy } = await loadProxy({
        ...desktop,
        AZURE_AD_CLIENT_ID: "",
        AZURE_AD_TENANT_ID: "",
      });
      const response = await proxy(page());
      expect(response.status).toBe(307);
      const location = new URL(response.headers.get("location") ?? "");
      expect(location.searchParams.get("error")).toBe("Configuration");
    });

    it("lets the landing page through, which forwards to /studio itself", async () => {
      // app/page.tsx sends the desktop app on to /studio, and /studio is
      // guarded like every other page, so letting "/" through opens nothing.
      const { proxy } = await loadProxy(desktop);
      expect((await proxy(home())).status).toBe(200);
    });
  });

  it("guards the pages that need it and leaves sign-in reachable", async () => {
    const { config } = await loadProxy({ NEXT_PUBLIC_AUTH_BYPASS: "true" });
    // Anchored, the way Next compiles a matcher. Unanchored it would happily
    // match "/api/auth/session" starting at the second slash and report the
    // sign-in endpoint as guarded.
    const pattern = new RegExp(`^${config.matcher[0]}$`);
    // "/" is matched too. The proxy still runs for the landing page, and lets
    // it through itself (isPublicPath, below).
    for (const guarded of ["/", "/studio", "/compare", "/api/lineage"]) {
      expect(pattern.test(guarded)).toBe(true);
    }
    // /login and NextAuth's own endpoints must stay open, or signing in is the
    // one thing a signed-out visitor cannot do.
    for (const open of ["/login", "/api/auth/session", "/favicon.ico"]) {
      expect(pattern.test(open)).toBe(false);
    }
  });
});

describe("isPublicPath", () => {
  // No reload needed: the list is fixed and no switch reads it.
  it("opens the landing page and nothing else", () => {
    expect(isPublicPath("/")).toBe(true);
    // Exact paths only. A prefix match on "/" would open every page there is.
    for (const guarded of ["/studio", "/login", "/api/me", "//", "", "/index"]) {
      expect(isPublicPath(guarded)).toBe(false);
    }
  });
});
