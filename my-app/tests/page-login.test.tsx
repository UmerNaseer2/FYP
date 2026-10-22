/** @jest-environment jsdom */

/**
 * The sign-in screen — the one page in the app a signed-out person can reach,
 * and the only one where a failure has nowhere else to be reported.
 *
 * NextAuth reports a refused sign-in by bouncing the browser back here with
 * ?error=<code> and nothing else. The page ignored that parameter, so every
 * refusal — a blocked account, an expired link, a server with no credentials
 * at all — arrived as a button that appeared to do nothing when pressed.
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

  it("prefers 'not set up' over the error code when both are true", async () => {
    // A server with no credentials refuses every sign-in, so it sends an error
    // code too. Both banners are true; only one of them tells the reader that
    // trying again cannot work, so the other is not drawn.
    arriveWith("?error=OAuthSignin");
    setRoutes(UNCONFIGURED);
    render(<LoginPage />);

    expect(await screen.findByText("Single sign-on is not set up.")).toBeInTheDocument();
    expect(screen.queryByText("Could not reach Microsoft to start sign-in.")).not.toBeInTheDocument();
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
