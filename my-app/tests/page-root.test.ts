/**
 * The front door at "/": the landing page for a visitor, and a hop into the
 * studio for anyone who should not see it.
 *
 * What app/page.tsx decides, case by case: inside the desktop app it forwards
 * to /studio; on a demo server with sign-in switched off it shows the landing
 * page with both buttons opening the studio; signed in, it forwards to
 * /studio; otherwise it shows the landing page with both buttons going to
 * /login, "Create account" asking it to carry on to "Your organizations".
 *
 * Node, not jsdom. An earlier version of this page called signIn() from
 * "next-auth/react" when the browser came back to "/?code=…", a helper that
 * reaches for `window`, so every return from Microsoft became a 500 on the
 * front door. Running the page where there is no window is what proves
 * nothing here reaches for it again.
 *
 * The page is called as a plain async function and its answer inspected as a
 * React element: which component, with which props. Rendering that element
 * is the landing page suite's job.
 *
 * What is NOT here:
 *  - What the landing page shows: tests/component-landing-page.test.tsx.
 *  - That the proxy lets "/" through without a session: tests/proxy.test.ts.
 */
import type { ReactElement } from "react";
import RootPage, { dynamic } from "@/app/page";
import { LandingPage, type LandingPageProps } from "@/components/landing/LandingPage";

// Relative paths on purpose: next/jest rewrites the @/ alias inside import
// statements only, so jest.mock("@/...") would not resolve.

// redirect() works by throwing, and the page relies on that: nothing after a
// redirect may run. The stand-in throws too, so a case that forgot to stop
// would come back as a rendered page instead of passing by accident.
const mockRedirects: string[] = [];
jest.mock("next/navigation", () => ({
  redirect: (href: string) => {
    mockRedirects.push(href);
    throw new Error("NEXT_REDIRECT");
  },
}));

// next-auth ships as ESM, which Jest cannot load, so auth() is a stand-in.
const mockAuth = jest.fn();
jest.mock("../auth", () => ({ auth: () => mockAuth() }));

// A server with sign-in set up and a key for saved passwords. Each case
// changes only the switch it is about; getters, so the page reads the change.
const SIGN_IN_SERVER = { desktopMode: false, authUsable: true, bypass: false, keySource: "derived" };
const mockFlags = { ...SIGN_IN_SERVER };
jest.mock("../auth.config", () => ({
  get desktopMode() {
    return mockFlags.desktopMode;
  },
  get authUsable() {
    return mockFlags.authUsable;
  },
}));
jest.mock("../lib/auth-mode", () => ({
  get BYPASS_AUTH() {
    return mockFlags.bypass;
  },
}));
jest.mock("../lib/secret-store", () => ({
  encryptionKeySource: () => mockFlags.keySource,
}));

beforeEach(() => {
  mockRedirects.length = 0;
  mockAuth.mockReset();
  Object.assign(mockFlags, SIGN_IN_SERVER);
});

/** The page's answer when it shows something rather than forwarding. */
async function landing(): Promise<ReactElement<LandingPageProps>> {
  return (await RootPage()) as ReactElement<LandingPageProps>;
}

describe("the front door", () => {
  it("forwards the desktop app to /studio without asking who is signed in", async () => {
    // The app only ever opens /login and /studio itself, and "Create account"
    // means nothing inside it, so a "/" typed into its address bar goes on.
    mockFlags.desktopMode = true;
    await expect(RootPage()).rejects.toThrow("NEXT_REDIRECT");
    expect(mockRedirects).toEqual(["/studio"]);
    expect(mockAuth).not.toHaveBeenCalled();
  });

  it("shows a demo server's landing page with both buttons opening the studio", async () => {
    // With the bypass on there is no sign-in to send anyone to, and no
    // session to read either.
    mockFlags.bypass = true;
    const page = await landing();
    expect(page.type).toBe(LandingPage);
    expect(page.props).toEqual({
      createAccountHref: "/studio",
      logInHref: "/studio",
      encryptsPasswords: true,
      demo: true,
    });
    expect(mockAuth).not.toHaveBeenCalled();
    expect(mockRedirects).toEqual([]);
  });

  it("forwards a signed-in visitor to /studio", async () => {
    mockAuth.mockResolvedValue({ user: { email: "someone@example.com" }, expires: "2099-01-01" });
    await expect(RootPage()).rejects.toThrow("NEXT_REDIRECT");
    expect(mockRedirects).toEqual(["/studio"]);
  });

  it("shows a signed-out visitor the landing page with both buttons going to /login", async () => {
    // The first sign-in is what creates an account, so "Create account" has
    // nowhere else to go. After it, a new person carries on to "Your
    // organizations" to make their first one, not to a studio they have no
    // organization in yet.
    mockAuth.mockResolvedValue(null);
    const page = await landing();
    expect(page.type).toBe(LandingPage);
    expect(page.props).toEqual({
      createAccountHref: "/login?callbackUrl=/onboarding",
      logInHref: "/login",
      encryptsPasswords: true,
    });
    expect(mockRedirects).toEqual([]);
  });

  it("treats a session with nobody in it as signed out", async () => {
    // The shape the next-auth beta.31 advisory was about: something came
    // back, but no user. Forwarding on it would send the visitor to a studio
    // that turns them away.
    mockAuth.mockResolvedValue({ expires: "2099-01-01" });
    const page = await landing();
    expect(page.props.logInHref).toBe("/login");
    expect(mockRedirects).toEqual([]);
  });

  it("does not read the session on a server where sign-in is not set up", async () => {
    // NextAuth throws on the read without its secret. /login, where both
    // buttons go, says what is missing.
    mockFlags.authUsable = false;
    const page = await landing();
    expect(page.props.logInHref).toBe("/login");
    expect(mockAuth).not.toHaveBeenCalled();
  });

  it("shows the landing page when the session cannot be read", async () => {
    // An error page on the front door would hide the "Log in" button too, and
    // the studio checks the session again for itself before it shows anything.
    mockAuth.mockRejectedValue(new Error("session read failed"));
    const logged = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      const page = await landing();
      expect(page.props.logInHref).toBe("/login");
      expect(mockRedirects).toEqual([]);
      expect(logged).toHaveBeenCalledTimes(1);
    } finally {
      logged.mockRestore();
    }
  });

  it.each<[string, boolean]>([
    ["app-key", true],
    ["derived", true],
    ["none", false],
  ])("with a key from %s, tells the landing page passwords are encrypted: %s", async (source, encrypted) => {
    mockFlags.keySource = source;
    mockAuth.mockResolvedValue(null);
    const page = await landing();
    expect(page.props.encryptsPasswords).toBe(encrypted);
  });

  it("is rendered on every request, never once at build time", () => {
    // A page prerendered by `next build` would keep the build machine's
    // answers for good: whether this is the desktop app, and whether there is
    // an encryption key. The Docker image and CI both build with placeholders.
    expect(dynamic).toBe("force-dynamic");
  });
});
