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
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

// A real redirect never comes back, so the stub never settles: that is what
// puts the button into its "Redirecting…" state and keeps it there, which is
// exactly what the browser does on the way to Microsoft.
jest.mock("next-auth/react", () => ({
  signIn: jest.fn(() => new Promise(() => {})),
}));

import { signIn } from "next-auth/react";
import LoginPage from "@/app/login/page";
import { resetPageState, setRoutes } from "./helpers/render-page";

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
