/** @jest-environment jsdom */

/**
 * The admin screen: what it shows, who it asks the server about, and what it
 * does while a removal is in flight.
 *
 * This is the first suite in the project that renders a page rather than
 * calling a function, so it is also the one that proves the setup works at all
 * — jsdom, the three stand-ins in tests/helpers/render-page, and a client
 * component that fetches on mount.
 */

import "@testing-library/jest-dom";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

// Hoisted above the page import below, which is the point of writing them here
// rather than in the helper: the page's own `next/navigation` and
// `next-auth/react` imports have to already resolve to the stand-ins by the
// time it loads, and jest.mock only ever applies to the file it appears in.
jest.mock("next/navigation", () => require("./helpers/render-page").navigationStubs);
jest.mock("next-auth/react", () => require("./helpers/render-page").sessionStubs);

import AdminPage from "@/app/(studio)/admin/page";
import { fetchCalls, holdNext, resetPageState, setRoutes, setUser } from "./helpers/render-page";

type Profile = { id: number; email: string; role: string };

// Three roles, none of them the signed-in account (resetPageState signs in as
// admin@example.com), so every row here carries its controls.
const USERS: Profile[] = [
  { id: 1, email: "ada@example.com", role: "admin" },
  { id: 2, email: "grace@example.com", role: "editor" },
  { id: 3, email: "linus@example.com", role: "viewer" },
];

const listRoute = (users: Profile[] = USERS) => ({
  match: "/api/admin/users",
  method: "GET",
  body: { users },
});

beforeEach(() => resetPageState());
afterEach(() => cleanup());

describe("admin page", () => {
  it("lists the profiles the server returned", async () => {
    setRoutes([listRoute()]);
    render(<AdminPage />);

    expect(await screen.findByText("ada@example.com")).toBeInTheDocument();
    expect(screen.getByText("grace@example.com")).toBeInTheDocument();
    expect(screen.getByText("linus@example.com")).toBeInTheDocument();
    // The counts are part of the header's job, and they distinguish "3 users"
    // from "3 admins" — getting either wrong is the kind of thing nobody
    // notices on a list they can also just count.
    expect(screen.getByText(/Grant or revoke/)).toHaveTextContent("· 3 users, 1 admin");
  });

  it("says nothing twice on an empty list", async () => {
    setRoutes([listRoute([])]);
    render(<AdminPage />);

    expect(await screen.findByText("No users yet")).toBeInTheDocument();
    // No "· 0 users, 0 admins" above an empty state that already says so.
    expect(screen.getByText(/Grant or revoke/)).not.toHaveTextContent("·");
  });

  it("does not ask the admin API anything when the visitor is not an admin", async () => {
    setUser("viewer");
    setRoutes([listRoute()]);
    render(<AdminPage />);
    // The mount effect runs inside render()'s act, so a request would already
    // be recorded; this only flushes anything React chose to defer.
    await act(async () => {});

    // The visible refusal is app/(studio)/admin/layout.tsx's AuthGuard, not
    // this page — what the page owes is not calling an admin-only endpoint
    // for somebody who has no business calling it.
    expect(fetchCalls).toEqual([]);
    expect(screen.queryByText("ada@example.com")).not.toBeInTheDocument();
  });

  it("leaves your own row read-only", async () => {
    setRoutes([listRoute([...USERS, { id: 4, email: "admin@example.com", role: "admin" }])]);
    render(<AdminPage />);
    await screen.findByText("admin@example.com");

    // You cannot demote or delete yourself into a lockout.
    expect(screen.getByText("Your account")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Remove admin@example.com" })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("combobox", { name: "Role for admin@example.com" })
    ).not.toBeInTheDocument();
    // …while everybody else's row still works.
    expect(screen.getByRole("button", { name: "Remove ada@example.com" })).toBeEnabled();
  });

  it("offers a retry when the list cannot be loaded, and the retry works", async () => {
    setRoutes([
      {
        match: "/api/admin/users",
        method: "GET",
        status: 500,
        body: { error: "The app database is unreachable." },
      },
    ]);
    render(<AdminPage />);

    expect(await screen.findByText(/Couldn.t load users/)).toBeInTheDocument();
    expect(screen.getByText("The app database is unreachable.")).toBeInTheDocument();

    // A retry that only clears the message would look identical on screen for
    // a moment and leave the page empty, so check a row actually arrives.
    setRoutes([listRoute()]);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("ada@example.com")).toBeInTheDocument();
    expect(screen.queryByText(/Couldn.t load users/)).not.toBeInTheDocument();
  });

  it("puts the old role back when the server refuses the change", async () => {
    setRoutes([
      listRoute(),
      {
        match: "/api/admin/users",
        method: "PUT",
        status: 403,
        body: { error: "Cannot demote the last admin." },
      },
    ]);
    render(<AdminPage />);
    await screen.findByText("ada@example.com");

    fireEvent.click(screen.getByRole("combobox", { name: "Role for ada@example.com" }));
    fireEvent.click(screen.getByRole("option", { name: "Viewer" }));

    expect(await screen.findByText("Cannot demote the last admin.")).toBeInTheDocument();
    expect(fetchCalls.at(-1)).toMatchObject({
      method: "PUT",
      body: JSON.stringify({ userId: 1, role: "viewer" }),
    });

    // The page changes the row before the server has agreed, so it has to go
    // back when the server says no — otherwise the screen says "viewer" about
    // an account the server still treats as an admin.
    expect(screen.getByText("admin")).toBeInTheDocument();
    // The dropdown lags the pill by a commit: Select keeps its own value and
    // re-seeds from the prop in an effect, so the rollback reaches it on the
    // render AFTER the one that shows the error. waitFor rather than a bare
    // assertion for that reason, and it matters that it arrives at all — the
    // row would otherwise show a pill saying "admin" next to a dropdown saying
    // "Viewer", contradicting itself about the same account.
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "Role for ada@example.com" })).toHaveTextContent(
        "Admin"
      )
    );
  });

  it("locks every remove button while one removal is in flight", async () => {
    setRoutes([
      listRoute(),
      { match: "/api/admin/users", method: "DELETE", body: { success: true } },
    ]);
    render(<AdminPage />);
    await screen.findByText("grace@example.com");

    // Withhold the DELETE so the in-flight state is something the test can
    // look at rather than something that is over before it renders.
    const release = holdNext("/api/admin/users");
    fireEvent.click(screen.getByRole("button", { name: "Remove grace@example.com" }));
    fireEvent.click(await screen.findByRole("button", { name: "Remove access" }));

    // The dialog closes the instant it is confirmed, so the row is the only
    // place the wait can show.
    expect(await screen.findByText("Removing…")).toBeInTheDocument();
    // And this is the fix: `deleting !== null`, not `deleting === u.id`.
    // `deleting` holds ONE id, so a second confirmed removal overwrote the
    // first one's marker and the first one's `finally` then cleared the
    // second's — re-enabling a row whose DELETE was still in flight.
    expect(screen.getByRole("button", { name: "Remove ada@example.com" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Remove linus@example.com" })).toBeDisabled();

    release();

    await waitFor(() =>
      expect(screen.queryByText("grace@example.com")).not.toBeInTheDocument()
    );
    expect(screen.getByRole("button", { name: "Remove ada@example.com" })).toBeEnabled();
  });

  it("keeps the row when the removal is refused, and says why", async () => {
    setRoutes([
      listRoute(),
      {
        match: "/api/admin/users",
        method: "DELETE",
        status: 409,
        body: { error: "That is the last admin." },
      },
    ]);
    render(<AdminPage />);
    await screen.findByText("ada@example.com");

    fireEvent.click(screen.getByRole("button", { name: "Remove ada@example.com" }));
    fireEvent.click(await screen.findByRole("button", { name: "Remove access" }));

    expect(await screen.findByText("That is the last admin.")).toBeInTheDocument();
    expect(screen.getByText("ada@example.com")).toBeInTheDocument();
    // A refusal must also let go of the lock, or the screen stays shut.
    expect(screen.getByRole("button", { name: "Remove ada@example.com" })).toBeEnabled();
  });
});
