// The edge proxy is the only thing standing between an anonymous request and
// every page and API route in the app, and it is also the file most likely to
// be broken silently: it is picked up by FILENAME, so a rename, a moved export
// or a bad matcher stops it running without any error anywhere. Nothing else in
// the suite would notice.
//
// Each case reloads the module, because both switches it reads — the bypass
// flag and whether sign-in is configured at all — are captured at import time.

import { NextRequest } from "next/server";

// next-auth and its provider ship as ESM, which Jest's CommonJS runtime cannot
// require. Neither is reached by any case here — every one of them either
// bypasses auth or stops at the "sign-in is not configured" branch, both of
// which return before NextAuth is ever constructed — so a stand-in is enough to
// let the module load. If a future case needs the real session check, it needs
// a real integration test, not a richer mock.
jest.mock("next-auth", () => ({
  __esModule: true,
  default: () => ({ auth: () => () => new Response(null, { status: 200 }) }),
}));
jest.mock("next-auth/providers/microsoft-entra-id", () => ({
  __esModule: true,
  default: () => ({ id: "microsoft-entra-id" }),
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

  it("guards the pages that need it and leaves sign-in reachable", async () => {
    const { config } = await loadProxy({ NEXT_PUBLIC_AUTH_BYPASS: "true" });
    // Anchored, the way Next compiles a matcher. Unanchored it would happily
    // match "/api/auth/session" starting at the second slash and report the
    // sign-in endpoint as guarded.
    const pattern = new RegExp(`^${config.matcher[0]}$`);
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
