/** @jest-environment jsdom */

/**
 * The sign-in screen — the one page in the app a signed-out person can reach,
 * and the only one where a failure has nowhere else to be reported.
 *
 * NextAuth reports a refused sign-in by bouncing the browser back here with
 * ?error=<code> and nothing else. The page ignored that parameter, so every
 * refusal — a blocked account, an expired link, a server with no credentials
 * at all — arrived as a button that appeared to do nothing when pressed.
 *
 * In the browser there are two ways in, Microsoft and GitHub, each offered
 * only when the server has its keys. Signing in carries on to the page that
 * sent the person here (?callbackUrl=), as long as that page is on this site;
 * lib/callback-url.ts has the rules and tests/callback-url.test.ts the cases.
 * Someone sent here to sign in as somebody else (&account=choose) is shown
 * Microsoft's or GitHub's account picker rather than signed straight back in.
 */

import "@testing-library/jest-dom";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

// A real redirect never comes back, so the stub never settles: that is what
// puts the button into its "Redirecting…" state and keeps it there, which is
// exactly what the browser does on the way to Microsoft.
jest.mock("next-auth/react", () => ({
  signIn: jest.fn(() => new Promise(() => {})),
}));

import { signIn } from "next-auth/react";
import LoginPage from "@/app/login/page";
import type { DesktopSignInResult } from "@/lib/desktop-bridge";
import { resetPageState, setRoutes } from "./helpers/render-page";
import {
  installDesktopBridge,
  removeDesktopBridge,
  type FakeDesktopBridge,
} from "./helpers/desktop-bridge";

const signInMock = signIn as jest.Mock;

/** A server with Entra credentials set, and one without. */
const CONFIGURED = [
  { match: "/api/auth/providers", body: { "microsoft-entra-id": { id: "microsoft-entra-id" } } },
];
const UNCONFIGURED = [{ match: "/api/auth/providers", body: {} }];
/** A server with only GitHub's keys, and one with both. */
const GITHUB_ONLY = [{ match: "/api/auth/providers", body: { github: { id: "github" } } }];
const BOTH = [
  {
    match: "/api/auth/providers",
    body: { "microsoft-entra-id": { id: "microsoft-entra-id" }, github: { id: "github" } },
  },
];

/** NextAuth puts its code in the address bar, which is where the page reads it. */
function arriveWith(query: string) {
  window.history.replaceState({}, "", `/login${query}`);
}

beforeEach(() => {
  resetPageState();
  signInMock.mockClear();
  arriveWith("");
});
afterEach(() => cleanup());

describe("signing in", () => {
  it("offers the button when the server can actually sign someone in", async () => {
    setRoutes(CONFIGURED);
    render(<LoginPage />);

    const button = await screen.findByRole("button", { name: "Continue with Microsoft" });
    expect(button).toBeEnabled();

    fireEvent.click(button);
    expect(signInMock).toHaveBeenCalledWith("microsoft-entra-id", { callbackUrl: "/studio" });
    // The browser is leaving, so the button says so rather than sitting there
    // looking pressable while the redirect is in flight.
    expect(await screen.findByText("Redirecting to Microsoft…")).toBeInTheDocument();
  });

  it("says plainly when the server has no credentials to sign in against", async () => {
    // With the Entra keys absent the provider list comes back empty. A button
    // that can only fail is worse than saying so: the reader cannot fix this
    // and needs to know it is not their account.
    setRoutes(UNCONFIGURED);
    render(<LoginPage />);

    expect(await screen.findByText("Single sign-on is not set up.")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Continue with Microsoft (unavailable)" })
    ).toBeDisabled();
  });

  it("treats an unreadable provider list as no sign-in rather than a working one", async () => {
    // Same answer as above for a different reason, and deliberately so: the
    // page cannot tell a server with no credentials from one that would not
    // say, and offering a button on a guess would fail on the far side of a
    // redirect where this screen can no longer explain anything.
    setRoutes([{ match: "/api/auth/providers", networkError: true }]);
    render(<LoginPage />);

    expect(await screen.findByText("Single sign-on is not set up.")).toBeInTheDocument();
  });

  it("shows no button until the server has said which ways it offers", async () => {
    // A guessed button could be for a provider the server does not have, and
    // pressing it would fail on the far side of a redirect.
    setRoutes(CONFIGURED);
    render(<LoginPage />);

    expect(screen.getByRole("button", { name: "Loading sign-in…" })).toBeDisabled();
    expect(await screen.findByRole("button", { name: "Continue with Microsoft" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Loading sign-in…" })).not.toBeInTheDocument();
  });

  it("offers GitHub on its own when the server has only GitHub's keys", async () => {
    setRoutes(GITHUB_ONLY);
    render(<LoginPage />);

    const button = await screen.findByRole("button", { name: "Continue with GitHub" });
    expect(screen.queryByRole("button", { name: /Microsoft/ })).not.toBeInTheDocument();
    expect(
      screen.getByText("You'll sign in with GitHub, then come straight back here.")
    ).toBeInTheDocument();

    fireEvent.click(button);
    expect(signInMock).toHaveBeenCalledWith("github", { callbackUrl: "/studio" });
    expect(await screen.findByText("Redirecting to GitHub…")).toBeInTheDocument();
    expect(screen.getByText("read:user · user:email")).toBeInTheDocument();
  });

  it("offers both, Microsoft first, when the server has both", async () => {
    setRoutes(BOTH);
    render(<LoginPage />);

    await screen.findByRole("button", { name: "Continue with GitHub" });
    expect(
      screen.getAllByRole("button", { name: /^Continue with/ }).map((b) => b.textContent)
    ).toEqual(["Continue with Microsoft", "Continue with GitHub"]);
    expect(
      screen.getByText("You'll sign in with Microsoft or GitHub, then come straight back here.")
    ).toBeInTheDocument();
  });

  it("names both sets of keys when the server has neither", async () => {
    setRoutes(UNCONFIGURED);
    render(<LoginPage />);

    const banner = await screen.findByRole("alert");
    expect(banner).toHaveTextContent("AZURE_AD_CLIENT_SECRET");
    expect(banner).toHaveTextContent("GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET");
    expect(banner).toHaveTextContent("NEXTAUTH_SECRET");
  });

  it("tells a newcomer how to join or start an organization", async () => {
    setRoutes(BOTH);
    render(<LoginPage />);
    await screen.findByRole("button", { name: "Continue with GitHub" });

    fireEvent.click(screen.getByRole("button", { name: "Trouble signing in?" }));
    expect(screen.getByText(/the email address the invitation went to/)).toBeVisible();
    expect(screen.getByText(/make an organization of your own/)).toBeVisible();
    // The old promise that everyone starts as a Viewer is the desktop app's
    // alone now: in the browser nobody joins anything just by signing in.
    expect(screen.queryByText(/New people start as Viewers/)).not.toBeInTheDocument();
  });
});

describe("where signing in carries on to", () => {
  it("goes back to the page that sent the person here", async () => {
    // What the proxy does for a signed-out visit, and what an invitation link
    // and the landing page's "Create account" do on purpose.
    arriveWith(`?callbackUrl=${encodeURIComponent("/invite/abc123?from=mail")}`);
    setRoutes(BOTH);
    render(<LoginPage />);

    fireEvent.click(await screen.findByRole("button", { name: "Continue with GitHub" }));
    expect(signInMock).toHaveBeenCalledWith("github", { callbackUrl: "/invite/abc123?from=mail" });
  });

  it.each([
    ["another site", "https://evil.example/studio"],
    ["another site written as a path", "//evil.example/studio"],
    ["another site behind a backslash", "/\\evil.example/studio"],
    ["this page again", "/login?error=AccessDenied"],
  ])("goes to the studio instead of %s", async (_, asked) => {
    arriveWith(`?callbackUrl=${encodeURIComponent(asked)}`);
    setRoutes(CONFIGURED);
    render(<LoginPage />);

    fireEvent.click(await screen.findByRole("button", { name: "Continue with Microsoft" }));
    expect(signInMock).toHaveBeenCalledWith("microsoft-entra-id", { callbackUrl: "/studio" });
  });
});

describe("signing in as somebody else", () => {
  // How the invitation page sends someone who signed out to take an
  // invitation meant for another address (lib/callback-url.ts loginHref).
  // Without the prompt, Microsoft and GitHub both sign straight back in to the
  // account the browser last used, and the person is back where they started.
  it.each([
    ["Microsoft", CONFIGURED, "microsoft-entra-id"],
    ["GitHub", GITHUB_ONLY, "github"],
  ])("asks %s to show its account picker", async (label, routes, provider) => {
    arriveWith(`?callbackUrl=${encodeURIComponent("/invite/abc123")}&account=choose`);
    setRoutes(routes);
    render(<LoginPage />);

    fireEvent.click(await screen.findByRole("button", { name: `Continue with ${label}` }));
    expect(signInMock.mock.calls).toEqual([
      [provider, { callbackUrl: "/invite/abc123" }, { prompt: "select_account" }],
    ]);
  });

  it("asks for no picker when the address does not say so", async () => {
    // Exactly two arguments: a third, even an empty one, is sent on to the
    // provider as authorization parameters.
    arriveWith(`?callbackUrl=${encodeURIComponent("/invite/abc123")}&account=other`);
    setRoutes(BOTH);
    render(<LoginPage />);

    fireEvent.click(await screen.findByRole("button", { name: "Continue with Microsoft" }));
    expect(signInMock.mock.calls).toEqual([["microsoft-entra-id", { callbackUrl: "/invite/abc123" }]]);
  });
});

describe("coming back from a refused sign-in", () => {
  it("turns NextAuth's code into something a reader can act on", async () => {
    arriveWith("?error=AccessDenied");
    setRoutes(CONFIGURED);
    render(<LoginPage />);

    expect(
      await screen.findByText("That account is not allowed to use Schema Studio.")
    ).toBeInTheDocument();
    // And the way back is a button that says it is a second attempt.
    expect(screen.getByRole("button", { name: "Retry with Microsoft" })).toBeEnabled();
  });

  it("still says something for a code it has never seen", async () => {
    // The list of codes is NextAuth's, not ours, and it grows between versions.
    // An unknown one must not fall through to a blank banner.
    arriveWith("?error=SomethingNewInV6");
    setRoutes(CONFIGURED);
    render(<LoginPage />);

    expect(await screen.findByText("Sign-in failed or was cancelled.")).toBeInTheDocument();
  });

  it.each([
    ["NoEmail", "That account did not share an email address, and Schema Studio needs one."],
    ["AccountExists", "That email address belongs to someone here who signs in another way."],
    ["EmailUnverified", "That account has not confirmed its email address is yours."],
    ["AccountUnavailable", "Schema Studio could not finish signing you in."],
  ])("explains %s, the app's own refusal, with what to do next", async (code, message) => {
    arriveWith(`?error=${code}`);
    setRoutes(BOTH);
    render(<LoginPage />);

    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    // Either way back is offered, since the fix may be the other one.
    expect(screen.getByRole("button", { name: "Retry with Microsoft" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Retry with GitHub" })).toBeEnabled();
  });

  it("prefers 'not set up' over the error code when both are true", async () => {
    // A server with no credentials refuses every sign-in, so it sends an error
    // code too. Both banners are true; only one of them tells the reader that
    // trying again cannot work, so the other is not drawn.
    arriveWith("?error=OAuthSignin");
    setRoutes(UNCONFIGURED);
    render(<LoginPage />);

    expect(await screen.findByText("Single sign-on is not set up.")).toBeInTheDocument();
    expect(
      screen.queryByText("Could not start the sign-in. Try again in a moment.")
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry with Microsoft" })).not.toBeInTheDocument();
  });
});

describe("the theme toggle on the signed-out screen", () => {
  it("remembers the choice for the studio to pick up", async () => {
    // The same hook runs the toggle inside the app, so a choice made before
    // signing in is the one the dashboard opens with.
    setRoutes(CONFIGURED);
    render(<LoginPage />);
    await screen.findByRole("button", { name: "Continue with Microsoft" });

    fireEvent.click(screen.getByRole("button", { name: /Light mode/ }));
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(localStorage.getItem("ss-theme")).toBe("light");
  });
});

describe("inside the desktop app", () => {
  // The app's own server offers a "desktop" provider in place of the browser
  // one (auth.config.ts), and the sign-in itself happens in the system
  // browser: the app opens it, waits, and hands back the ID token Microsoft
  // gave it, which this screen then posts to that provider.
  const DESKTOP = [{ match: "/api/auth/providers", body: { desktop: { id: "desktop" } } }];

  let bridge: FakeDesktopBridge;
  beforeEach(() => {
    bridge = installDesktopBridge();
  });
  afterEach(() => removeDesktopBridge());

  /**
   * Keeps the app's sign-in waiting, the way it does while the person is still
   * in their browser, and hands back the way to end it.
   */
  function holdSignIn() {
    let finish: (result: DesktopSignInResult) => void = () => {};
    bridge.signIn.mockImplementation(
      () =>
        new Promise<DesktopSignInResult>((resolve) => {
          finish = resolve;
        })
    );
    return (result: DesktopSignInResult) => act(async () => finish(result));
  }

  /** The button, once the provider list has said there is a sign-in to start. */
  async function pressContinue() {
    fireEvent.click(await screen.findByRole("button", { name: "Continue with Microsoft" }));
  }

  it("says the sign-in opens the web browser rather than leaving this window", async () => {
    setRoutes(DESKTOP);
    render(<LoginPage />);

    expect(await screen.findByRole("button", { name: "Continue with Microsoft" })).toBeEnabled();
    expect(
      screen.getByText("Opens your web browser for your organization's Microsoft sign-in.")
    ).toBeInTheDocument();
  });

  it("waits for the browser, then hands Microsoft's token to the server", async () => {
    setRoutes(DESKTOP);
    const finish = holdSignIn();
    render(<LoginPage />);
    await pressContinue();

    // Nothing is posted until there is a token to post, and the button says
    // where the person has to look in the meantime.
    expect(screen.getByRole("button", { name: "Waiting for your browser…" })).toBeDisabled();
    expect(bridge.signIn).toHaveBeenCalledTimes(1);
    expect(signInMock).not.toHaveBeenCalled();

    await finish({ ok: true, idToken: "header.payload.signature" });
    expect(await screen.findByRole("button", { name: "Signing you in…" })).toBeDisabled();
    expect(signInMock).toHaveBeenCalledTimes(1);
    expect(signInMock).toHaveBeenCalledWith("desktop", {
      idToken: "header.payload.signature",
      callbackUrl: "/studio",
    });
  });

  it("goes quietly back to the button when the person cancels", async () => {
    setRoutes(DESKTOP);
    const finish = holdSignIn();
    render(<LoginPage />);
    await pressContinue();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(bridge.cancelSignIn).toHaveBeenCalledTimes(1);

    // The app answers a cancel by ending the wait it was holding open.
    await finish({ ok: false, reason: "cancelled", message: "The sign-in was cancelled." });
    expect(await screen.findByRole("button", { name: "Continue with Microsoft" })).toBeEnabled();
    // Changing your mind is not a failure, so nothing is reported as one.
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(signInMock).not.toHaveBeenCalled();
  });

  it.each([
    [
      "offline",
      "Microsoft could not be reached. Check this computer's internet connection and try again.",
    ],
    ["failed", "Microsoft did not finish the sign-in. Try again in a moment."],
  ] as const)("shows the app's own words for a sign-in that came back %s", async (reason, message) => {
    setRoutes(DESKTOP);
    bridge.signIn.mockResolvedValue({ ok: false, reason, message });
    render(<LoginPage />);
    await pressContinue();

    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    expect(screen.getByRole("button", { name: "Retry with Microsoft" })).toBeEnabled();
    expect(signInMock).not.toHaveBeenCalled();
  });

  it("opens the browser again from the banner, and drops the old reason", async () => {
    setRoutes(DESKTOP);
    bridge.signIn.mockResolvedValueOnce({
      ok: false,
      reason: "offline",
      message: "Microsoft could not be reached.",
    });
    render(<LoginPage />);
    await pressContinue();
    fireEvent.click(await screen.findByRole("button", { name: "Retry with Microsoft" }));

    // The second attempt falls back to the fake's default, a sign-in still
    // waiting for the browser.
    expect(bridge.signIn).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("button", { name: "Waiting for your browser…" })).toBeDisabled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("keeps Electron's wording out of it when the app itself breaks", async () => {
    // The app answers every sign-in with a result, failures included, so a
    // rejected call means something in the app broke. What arrives then names
    // Electron's plumbing, which tells the person nothing they can act on.
    setRoutes(DESKTOP);
    bridge.signIn.mockRejectedValue(
      new Error("Error invoking remote method 'sign-in': Error: EACCES")
    );
    const quiet = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      render(<LoginPage />);
      await pressContinue();

      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent("Schema Studio could not start the sign-in.");
      expect(alert).toHaveTextContent("Help > Open Logs");
      expect(alert).not.toHaveTextContent(/remote method|EACCES/);
      expect(signInMock).not.toHaveBeenCalled();
    } finally {
      quiet.mockRestore();
    }
  });

  it("says the app was built without its sign-in IDs when the server has none", async () => {
    setRoutes(UNCONFIGURED);
    render(<LoginPage />);

    expect(await screen.findByText("Single sign-on is not set up.")).toBeInTheDocument();
    expect(screen.getByText(/This copy of the desktop app was built without/)).toBeInTheDocument();
    // A desktop build has no client secret at all, so the browser's list of
    // four keys would send whoever builds it looking for one.
    expect(screen.queryByText(/AZURE_AD_CLIENT_SECRET/)).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Continue with Microsoft (unavailable)" })
    ).toBeDisabled();
  });

  it("does not offer the browser sign-in inside the app", async () => {
    // Its redirect would take the app's own window to Microsoft's page, which
    // is the one thing the app is built not to do, so a server offering only
    // that provider counts as offering none.
    setRoutes(CONFIGURED);
    render(<LoginPage />);

    expect(await screen.findByText("Single sign-on is not set up.")).toBeInTheDocument();
  });

  it("carries on to the page that sent the person here", async () => {
    arriveWith(`?callbackUrl=${encodeURIComponent("/acme/connections")}`);
    setRoutes(DESKTOP);
    const finish = holdSignIn();
    render(<LoginPage />);
    await pressContinue();

    await finish({ ok: true, idToken: "header.payload.signature" });
    expect(signInMock).toHaveBeenCalledWith("desktop", {
      idToken: "header.payload.signature",
      callbackUrl: "/acme/connections",
    });
  });

  it("offers only Microsoft, even from a server that has GitHub's keys", async () => {
    // The app's sign-in is built on Microsoft, and GitHub's redirect would take
    // the app's own window away, as the browser Microsoft one would.
    setRoutes([
      {
        match: "/api/auth/providers",
        body: { desktop: { id: "desktop" }, github: { id: "github" } },
      },
    ]);
    render(<LoginPage />);

    expect(await screen.findByRole("button", { name: "Continue with Microsoft" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: /GitHub/ })).not.toBeInTheDocument();
  });

  it.each([
    ["CredentialsSignin", "Schema Studio could not confirm your Microsoft sign-in."],
    ["SessionRevoked", "Your Microsoft sign-in has ended. Sign in again to carry on."],
    [
      "OfflineTooLong",
      "This computer has been offline for more than 30 days, so you need to sign in again.",
    ],
  ])("explains %s, the code the app or its server sends back", async (code, message) => {
    arriveWith(`?error=${code}`);
    setRoutes(DESKTOP);
    render(<LoginPage />);

    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry with Microsoft" })).toBeEnabled();
  });
});
