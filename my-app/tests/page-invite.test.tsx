/** @jest-environment jsdom */

/**
 * An invitation (components/invite/InvitePage.tsx): what someone sees after
 * opening an invitation link, as the server half looked it up for them.
 *
 * What it is held to here:
 *   - Each view: its title and line, and the one way on that suits it. Only an
 *     invitation this person can take has a Join button, and every page but
 *     the demo has Sign out in the header.
 *   - Joining: the token sent as it came, one request however often Join is
 *     pressed, and the organization the server named opened once it answers.
 *   - A refusal: the route's own words above the button, "Sign in again" when
 *     the session has gone, and the page drawn again from the server when the
 *     refusal says what became of the invitation, so the matching view
 *     replaces a Join button that can only fail.
 *   - Another account: signing out on the way to the account picker, and back
 *     to this invitation afterwards.
 *
 * The server half, which looks the invitation up and forwards the desktop app
 * to /studio, is tests/page-invite-server.test.ts. The route Join asks is
 * tests/invites-accept-route.test.ts, and what an invitation is to whoever
 * opens it is tests/invites-db.test.ts.
 */

import "@testing-library/jest-dom";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

jest.mock("next/navigation", () => require("./helpers/render-page").navigationStubs);
// The real one reaches for next-auth, and signing out is not this page's to test.
jest.mock("../lib/sign-out", () => ({ signOutEverywhere: jest.fn(() => Promise.resolve()) }));

import { InvitePage, type InviteView } from "@/components/invite/InvitePage";
import { signOutEverywhere } from "@/lib/sign-out";
import {
  fetchCalls,
  flushAsync,
  holdNext,
  resetPageState,
  routerCalls,
  setRoutes,
  type FetchRoute,
} from "./helpers/render-page";

const ACCEPT = "/api/invites/accept";
const TOKEN = "Abc_def-123".padEnd(43, "x");
const HERE = `/invite/${TOKEN}`;
/** The sign-in page, coming back to this invitation. */
const SIGN_IN_AGAIN = `/login?callbackUrl=%2Finvite%2F${TOKEN}`;
const UNREACHABLE = "Could not reach the server. Check your connection, then try again.";

const ACME = { slug: "acme", name: "Acme" };

const BY_EMAIL: InviteView = {
  kind: "ok",
  organization: ACME,
  role: "developer",
  roleLabel: "Developer",
  invite: "email",
};
const BY_LINK: InviteView = {
  kind: "ok",
  organization: ACME,
  role: "viewer",
  roleLabel: "Viewer",
  invite: "link",
};

/**
 * One of each view, keyed by its kind, so a view added to InviteView and not
 * here is a type error rather than a view nobody looked at.
 */
const VIEWS: { [Kind in InviteView["kind"]]: Extract<InviteView, { kind: Kind }> } = {
  ok: BY_EMAIL,
  member: { kind: "member", organization: ACME },
  "wrong-account": { kind: "wrong-account", organization: ACME, maskedEmail: "a•••@example.com" },
  invalid: { kind: "invalid" },
  revoked: { kind: "revoked" },
  expired: { kind: "expired" },
  used: { kind: "used" },
  "no-profile": { kind: "no-profile" },
  demo: { kind: "demo" },
  "signed-out": { kind: "signed-out" },
  unavailable: { kind: "unavailable" },
};

/** POST /api/invites/accept answering like this. */
function accepting(status: number, body: unknown): FetchRoute {
  return { match: ACCEPT, method: "POST", status, body };
}

function draw(view: InviteView, token = TOKEN) {
  render(<InvitePage token={token} view={view} />);
}

const title = () => screen.getByRole("heading", { level: 1 });
const joinButton = () => screen.getByRole("button", { name: /^(Join Acme|Joining…|Opening…)$/ });
const links = () =>
  screen.getAllByRole("link").map((link) => [link.textContent, link.getAttribute("href")]);

beforeEach(() => {
  resetPageState();
  window.history.replaceState({}, "", HERE);
  (signOutEverywhere as jest.Mock).mockClear();
});

afterEach(() => cleanup());

describe("each view", () => {
  test("an invitation to this person's address: the organization, the role and Join", () => {
    draw(BY_EMAIL);

    expect(title()).toHaveTextContent("Join Acme");
    expect(screen.getByText("You have been invited to join this organization.")).toBeInTheDocument();
    expect(screen.getByText("/acme")).toBeInTheDocument();
    // "Joining as" is there for a screen reader, which would otherwise read a
    // bare "Developer" with nothing to say what it is.
    expect(screen.getByText("Developer")).toHaveTextContent("Joining as Developer");
    expect(joinButton()).toHaveTextContent("Join Acme");
    expect(joinButton()).toBeEnabled();
    expect(screen.getByText("An Admin there can change your role later.")).toBeInTheDocument();
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  test("an invitation link: says everyone who joins through one starts with its role", () => {
    draw(BY_LINK);

    expect(title()).toHaveTextContent("Join Acme");
    expect(screen.getByText("This link lets you join this organization.")).toBeInTheDocument();
    expect(screen.getByText("Viewer")).toHaveTextContent("Joining as Viewer");
    expect(
      screen.getByText(
        "Everyone who joins through a link starts as a Viewer. An Admin there can change your role later."
      )
    ).toBeInTheDocument();
  });

  test("in the organization already: opens it instead, with nothing to join", () => {
    draw(VIEWS.member);

    expect(title()).toHaveTextContent("You are already in Acme");
    expect(
      screen.getByText(
        "This invitation is for an organization you belong to, so there is nothing to join."
      )
    ).toBeInTheDocument();
    expect(links()).toEqual([["Open Acme", "/acme/studio"]]);
    expect(screen.queryByRole("button", { name: /Join/ })).toBeNull();
  });

  test("for another account: names the address it was sent to, masked as the server sent it", () => {
    draw(VIEWS["wrong-account"]);

    expect(title()).toHaveTextContent("This invitation is for another account");
    expect(screen.getByText(/was sent to/)).toHaveTextContent(
      "The invitation to join Acme was sent to a•••@example.com. Sign in with that address to take it."
    );
    expect(screen.getByRole("button", { name: "Sign in with another account" })).toBeEnabled();
    expect(links()).toEqual([["Your organizations", "/onboarding"]]);
    expect(screen.queryByRole("button", { name: /Join/ })).toBeNull();
  });

  test.each([
    [
      "invalid",
      "This invitation link does not work",
      "Check that it was copied whole, or ask whoever sent it for a new one.",
    ],
    ["revoked", "This invitation was cancelled", "Ask whoever sent it for a new one."],
    [
      "expired",
      "This invitation has run out",
      "Invitations only last a set number of days. Ask whoever sent it for a new one.",
    ],
    [
      "used",
      "This invitation has been used",
      "Each invitation to an address can be taken once. If you still need to join, ask whoever sent it for a new one.",
    ],
    ["demo", "Invitations need a real sign-in", "Sign-in is switched off here, so there is nobody to join as."],
  ] as const)("%s: says why, and points back to the person's own organizations", (kind, heading, lede) => {
    draw(VIEWS[kind]);

    expect(title()).toHaveTextContent(heading);
    expect(screen.getByText(lede)).toBeInTheDocument();
    expect(links()).toEqual([["Your organizations", "/onboarding"]]);
    expect(screen.queryByRole("button", { name: /Join/ })).toBeNull();
  });

  test.each(["signed-out", "no-profile"] as const)(
    "%s: asks them to sign in again, and comes back to this invitation afterwards",
    (kind) => {
      draw(VIEWS[kind]);

      expect(title()).toHaveTextContent("Sign in again to continue");
      expect(
        screen.getByText(
          "Your session has ended. Sign in, and you will come straight back to this invitation."
        )
      ).toBeInTheDocument();
      // Not the account picker: this is the same person, signed out.
      expect(links()).toEqual([["Sign in", SIGN_IN_AGAIN]]);
    }
  );

  test("a token with characters an address treats specially comes back as the same token", () => {
    // A mangled link, not a real token: those are letters, digits, "-" and
    // "_" only. Unencoded, "/" would land on another page and "?" or "#" would
    // cut the token short on the way back.
    draw(VIEWS["signed-out"], "a/b?c#d e");

    const href = screen.getByRole("link", { name: "Sign in" }).getAttribute("href")!;
    const back = new URL(href, "http://localhost").searchParams.get("callbackUrl");
    expect(back).toBe("/invite/a%2Fb%3Fc%23d%20e");
    expect(decodeURIComponent(back!.slice("/invite/".length))).toBe("a/b?c#d e");
  });

  test("unavailable: says the database may be down, and looks again when asked", () => {
    draw(VIEWS.unavailable);

    expect(title()).toHaveTextContent("Could not read the invitation");
    expect(
      screen.getByText("The app's database may be unreachable. Try again in a moment.")
    ).toBeInTheDocument();
    expect(screen.queryByRole("link")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    // Drawn again by the server, which looks the invitation up afresh.
    expect(routerCalls.refresh).toBe(1);
    expect(screen.getByRole("button", { name: "Try again" })).toBeEnabled();
  });

  test.each(Object.values(VIEWS))("Sign out is in the header unless this is the demo ($kind)", (view) => {
    draw(view);

    const signOut = screen.queryByRole("button", { name: "Sign out" });
    if (view.kind === "demo") {
      // Sign-in is switched off: nobody is signed in to sign out.
      expect(signOut).toBeNull();
      return;
    }
    fireEvent.click(signOut!);
    expect((signOutEverywhere as jest.Mock).mock.calls).toEqual([[]]);
  });

  test("no view sends anything until a button asks it to", async () => {
    for (const view of Object.values(VIEWS)) {
      draw(view);
      cleanup();
    }
    await flushAsync();
    expect(fetchCalls).toEqual([]);
    expect(routerCalls).toEqual({ push: [], replace: [], refresh: 0 });
  });
});

describe("joining", () => {
  test.each([
    ["joins", true],
    // A second press of Join, or a second tab: still the organization to open.
    ["was in it already", false],
  ])("sends the token as it came and opens the organization when the person %s", async (_, joined) => {
    setRoutes([accepting(200, { organization: ACME, joined })]);
    draw(BY_EMAIL);

    fireEvent.click(joinButton());
    await waitFor(() => expect(routerCalls.push).toEqual(["/acme/studio"]));
    expect(fetchCalls).toEqual([{ url: ACCEPT, method: "POST", body: JSON.stringify({ token: TOKEN }) }]);
    // Busy until the studio replaces this page, so it cannot be pressed again.
    expect(joinButton()).toHaveTextContent("Opening…");
    expect(joinButton()).toBeDisabled();
    expect(joinButton()).toHaveAttribute("aria-busy", "true");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  test("sends one request however often Join is pressed", async () => {
    setRoutes([accepting(200, { organization: ACME, joined: true })]);
    const release = holdNext(ACCEPT, "POST");
    draw(BY_EMAIL);

    fireEvent.click(joinButton());
    expect(joinButton()).toHaveTextContent("Joining…");
    expect(joinButton()).toBeDisabled();
    expect(joinButton()).toHaveAttribute("aria-busy", "true");
    fireEvent.click(joinButton());
    fireEvent.click(joinButton());
    await flushAsync();
    expect(fetchCalls).toHaveLength(1);

    release();
    await waitFor(() => expect(routerCalls.push).toEqual(["/acme/studio"]));
    expect(fetchCalls).toHaveLength(1);
  });

  test("an answer with no organization in it says so, and Join can be pressed again", async () => {
    setRoutes([accepting(200, { joined: true })]);
    draw(BY_EMAIL);

    fireEvent.click(joinButton());
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The server's answer could not be read. Try again in a moment."
    );
    expect(routerCalls.push).toEqual([]);
    expect(joinButton()).toHaveTextContent("Join Acme");
    expect(joinButton()).toBeEnabled();
  });

  test("a refusal that says what became of the invitation is shown, and the page drawn again", async () => {
    setRoutes([
      accepting(410, { error: "This invitation was cancelled. Ask for a new one.", state: "revoked" }),
    ]);
    draw(BY_EMAIL);

    fireEvent.click(joinButton());
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("This invitation was cancelled. Ask for a new one.");
    // The server now draws the "cancelled" view in place of this one.
    expect(routerCalls.refresh).toBe(1);
    expect(within(alert).queryByRole("link")).toBeNull();
    expect(routerCalls.push).toEqual([]);
    expect(joinButton()).toBeEnabled();
  });

  test("a refusal that does not is shown, and the page is left as it is", async () => {
    setRoutes([
      accepting(503, {
        error: "Could not take the invitation. The app's database may be unreachable. Try again in a moment.",
      }),
    ]);
    draw(BY_EMAIL);

    fireEvent.click(joinButton());
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(
      "Could not take the invitation. The app's database may be unreachable. Try again in a moment."
    );
    expect(within(alert).queryByRole("link")).toBeNull();
    expect(routerCalls.refresh).toBe(0);
    expect(joinButton()).toBeEnabled();
  });

  test("a session that has gone offers to sign in again, coming back here", async () => {
    setRoutes([accepting(401, { error: "Sign in again to continue." })]);
    draw(BY_EMAIL);

    fireEvent.click(joinButton());
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Sign in again to continue.");
    expect(within(alert).getByRole("link", { name: "Sign in again" })).toHaveAttribute(
      "href",
      SIGN_IN_AGAIN
    );
    expect(routerCalls.refresh).toBe(0);
  });

  test("a refusal with no words of its own says which answer came back", async () => {
    // A proxy's error page, say, which is no JSON the route wrote.
    setRoutes([accepting(502, null)]);
    draw(BY_EMAIL);

    fireEvent.click(joinButton());
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not take the invitation (HTTP 502)."
    );
    expect(routerCalls.refresh).toBe(0);
  });

  test("a server it cannot reach is said so, and pressing Join again clears that while it tries", async () => {
    setRoutes([{ match: ACCEPT, method: "POST", networkError: true }]);
    draw(BY_EMAIL);

    fireEvent.click(joinButton());
    expect(await screen.findByRole("alert")).toHaveTextContent(UNREACHABLE);
    expect(joinButton()).toBeEnabled();

    setRoutes([accepting(200, { organization: ACME, joined: true })]);
    const release = holdNext(ACCEPT, "POST");
    fireEvent.click(joinButton());
    expect(screen.queryByRole("alert")).toBeNull();
    expect(joinButton()).toHaveTextContent("Joining…");

    release();
    await waitFor(() => expect(routerCalls.push).toEqual(["/acme/studio"]));
    expect(fetchCalls).toHaveLength(2);
  });
});

describe("another account", () => {
  test("signs out on the way to the account picker, then back to this invitation", () => {
    draw(VIEWS["wrong-account"]);

    const button = screen.getByRole("button", { name: "Sign in with another account" });
    fireEvent.click(button);
    // Without the picker, Microsoft and GitHub would sign straight back in to
    // the account the browser last used: the same wrong one.
    expect((signOutEverywhere as jest.Mock).mock.calls).toEqual([[`${SIGN_IN_AGAIN}&account=choose`]]);
    expect(button).toHaveTextContent("Signing out…");
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");

    fireEvent.click(button);
    expect(signOutEverywhere).toHaveBeenCalledTimes(1);
  });
});
