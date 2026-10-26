/** @jest-environment jsdom */

/**
 * The admin screen: the Users tab, which says who has which role and removes
 * people, the Roles & permissions tab, which says what each role can do,
 * makes and deletes custom roles, and lists who changed what, and the folding
 * guide above both that explains how to use them.
 *
 * This is the first suite in the project that renders a page rather than
 * calling a function, so it is also the one that proves the setup works at all
 * — jsdom, the three stand-ins in tests/helpers/render-page, and a client
 * component that fetches on mount.
 *
 * The roles the server holds live in `roleRows` below. The stand-in routes
 * read and change it the way /api/admin/roles reads and changes the database,
 * so the reload after a save shows what the server kept, not what the page
 * hoped for.
 */

import "@testing-library/jest-dom";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";

// Hoisted above the page import below, which is the point of writing them here
// rather than in the helper: the page's own `next/navigation` and
// `next-auth/react` imports have to already resolve to the stand-ins by the
// time it loads, and jest.mock only ever applies to the file it appears in.
jest.mock("next/navigation", () => require("./helpers/render-page").navigationStubs);
jest.mock("next-auth/react", () => require("./helpers/render-page").sessionStubs);

// The sign-in bypass as a switch a test can move: off unless a test turns it
// on. A getter, for the reason tests/use-user.test.tsx gives: the hook reads
// BYPASS_AUTH each time it runs, so one file can see both sides of it.
let mockBypass = false;
jest.mock("../lib/auth-mode", () => ({
  ...jest.requireActual("../lib/auth-mode"),
  get BYPASS_AUTH() {
    return mockBypass;
  },
}));

import AdminPage from "@/app/[org]/(studio)/admin/page";
import { ROLES_CHANGED_EVENT } from "@/components/studio/ViewAsSwitcher";
import { resetUserCache } from "@/hooks/useUser";
import {
  ACTIONS,
  ACTION_LABELS,
  ALL_PERMISSIONS,
  BUILT_IN_ROLE_INFO,
  presetFor,
  withToggled,
  type PermissionKey,
} from "@/lib/permissions";
import type { RoleChange, RoleSummary } from "@/lib/roles-db";
import {
  fetchCalls,
  flushAsync,
  holdNext,
  render,
  resetPageState,
  setRoutes,
  setUser,
  type FetchRoute,
} from "./helpers/render-page";

type Profile = { id: number; email: string; role: string };

// Three roles, none of them the signed-in account (resetPageState signs in as
// admin@example.com), so every row here carries its controls.
const USERS: Profile[] = [
  { id: 1, email: "ada@example.com", role: "admin" },
  { id: 2, email: "grace@example.com", role: "editor" },
  { id: 3, email: "linus@example.com", role: "viewer" },
];

// The roles each row's picker offers, as GET /api/admin/users sends them.
const ROLE_OPTIONS = [
  { name: "viewer", label: "Viewer" },
  { name: "editor", label: "Editor" },
  { name: "admin", label: "Admin" },
];

const listRoute = (users: Profile[] = USERS, roles = ROLE_OPTIONS): FetchRoute => ({
  match: "/api/admin/users",
  method: "GET",
  body: { users, roles },
});

/**
 * The three built-in roles, one person each, and a custom one nobody has yet.
 * Editor is one box short of its defaults (Deploy: Run), so Reset has
 * something to put back. Made fresh for every test, because the routes below
 * change it.
 */
function freshRoles(): RoleSummary[] {
  return [
    {
      name: "viewer",
      label: "Viewer",
      description: BUILT_IN_ROLE_INFO.viewer.description,
      builtIn: true,
      userCount: 1,
      permissions: [...(presetFor("viewer") ?? [])],
    },
    {
      name: "editor",
      label: "Editor",
      description: BUILT_IN_ROLE_INFO.editor.description,
      builtIn: true,
      userCount: 1,
      permissions: (presetFor("editor") ?? []).filter((key) => key !== "deploy:run"),
    },
    {
      name: "admin",
      label: "Admin",
      description: BUILT_IN_ROLE_INFO.admin.description,
      builtIn: true,
      userCount: 1,
      permissions: [...ALL_PERMISSIONS],
    },
    {
      name: "qa-lead",
      label: "QA Lead",
      description: "Checks a release before it goes out.",
      builtIn: false,
      userCount: 0,
      permissions: ["dashboard:read"],
    },
  ];
}

let roleRows: RoleSummary[] = [];
let changeRows: RoleChange[] = [];

/** A copy, as a real reply is: the page must not hold the arrays these routes change. */
function copy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function differences(a: readonly string[], b: readonly string[]): number {
  return a.filter((key) => !b.includes(key)).length + b.filter((key) => !a.includes(key)).length;
}

const rolesGetRoute: FetchRoute = {
  match: "/api/admin/roles",
  method: "GET",
  body: () => copy({ roles: roleRows, changes: changeRows }),
};

// Keeps the whole set it was sent, or the defaults for a reset, and says how
// many boxes that changed, as PUT /api/admin/roles does.
const rolesPutRoute: FetchRoute = {
  match: "/api/admin/roles",
  method: "PUT",
  body: (_url: string, init?: RequestInit) => {
    const sent = JSON.parse(String(init?.body));
    const row = roleRows.find((r) => r.name === sent.role);
    if (!row) throw new Error(`No role called ${sent.role} in roleRows`);
    const next: PermissionKey[] = sent.reset ? [...(presetFor(row.name) ?? [])] : sent.permissions;
    const changes = differences(row.permissions, next);
    row.permissions = next;
    return { permissions: [...next], changes };
  },
};

/** What a Roles tab test needs. Routes passed in come first, so they win. */
function rolesRoutes(...first: FetchRoute[]): FetchRoute[] {
  return [...first, listRoute(), rolesGetRoute, rolesPutRoute];
}

/** How many times the page has asked for the roles. */
function rolesGets(): number {
  return fetchCalls.filter((c) => c.url.includes("/api/admin/roles") && c.method === "GET")
    .length;
}

function lastCall(method: string) {
  return fetchCalls.filter((c) => c.method === method).at(-1);
}

/** Open the page, then the Roles & permissions tab, and wait for the roles. */
async function openRolesTab() {
  render(<AdminPage />);
  await screen.findByText("ada@example.com");
  fireEvent.click(screen.getByRole("tab", { name: "Roles & permissions" }));
  await screen.findByRole("button", { name: "Viewer, 1 person" });
}

/**
 * Press a button in the open confirm dialog. Scoped to the dialog because the
 * page behind it can have a button with the same name ("Delete role").
 */
function confirmIn(title: string, button: string) {
  const dialog = screen.getByRole("dialog", { name: title });
  fireEvent.click(within(dialog).getByRole("button", { name: button }));
}

/**
 * Each time the page tells the View as picker on the rail that a role was made
 * or deleted. The picker loads its list once, so without this a role made here
 * could not be picked until the page was reloaded. The picker's side of it is
 * in tests/component-view-as-switcher.test.tsx.
 */
const rolesAnnounced = jest.fn();
beforeAll(() => window.addEventListener(ROLES_CHANGED_EVENT, rolesAnnounced));
afterAll(() => window.removeEventListener(ROLES_CHANGED_EVENT, rolesAnnounced));

beforeEach(() => {
  mockBypass = false;
  resetUserCache();
  resetPageState();
  roleRows = freshRoles();
  changeRows = [];
  rolesAnnounced.mockClear();
  // The guide remembers being folded in localStorage, and jsdom keeps it for
  // the whole file, so one test folding it would fold it for the next.
  window.localStorage.clear();
});
afterEach(() => cleanup());

describe("the Users tab", () => {
  it("lists the profiles the server returned", async () => {
    setRoutes([listRoute()]);
    render(<AdminPage />);

    expect(await screen.findByText("ada@example.com")).toBeInTheDocument();
    expect(screen.getByText("grace@example.com")).toBeInTheDocument();
    expect(screen.getByText("linus@example.com")).toBeInTheDocument();
    // The counts are part of the header's job, and they distinguish "3 users"
    // from "3 admins" — getting either wrong is the kind of thing nobody
    // notices on a list they can also just count.
    expect(screen.getByText(/Give people a role/)).toHaveTextContent("· 3 users, 1 admin");
  });

  it("says nothing twice on an empty list", async () => {
    setRoutes([listRoute([])]);
    render(<AdminPage />);

    expect(await screen.findByText("No users yet")).toBeInTheDocument();
    // No "· 0 users, 0 admins" above an empty state that already says so.
    expect(screen.getByText(/Give people a role/)).not.toHaveTextContent("·");
  });

  it("does not ask the admin API anything when the visitor is not an admin", async () => {
    setUser("viewer");
    setRoutes([listRoute()]);
    render(<AdminPage />);
    // The mount effect runs inside render()'s act, so a request would already
    // be recorded; this only flushes anything React chose to defer.
    await act(async () => {});

    // The visible refusal is app/[org]/(studio)/admin/layout.tsx's AuthGuard, not
    // this page — what the page owes is not calling an admin-only endpoint
    // for somebody who has no business calling it.
    expect(fetchCalls).toEqual([]);
    expect(screen.queryByText("ada@example.com")).not.toBeInTheDocument();
    // Nor offering tabs it would then refuse: only its own short note.
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
    expect(screen.getByText("You can't manage users or roles")).toBeInTheDocument();
    // Nor a guide to tabs it does not show.
    expect(screen.queryByText("How roles and permissions work")).not.toBeInTheDocument();
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
    // Said once, where the list would be, and not again in a banner above it.
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

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
    // back when the server says no — otherwise the screen says "Viewer" about
    // an account the server still treats as an admin.
    const adaRow = screen.getByText("ada@example.com").closest(".card") as HTMLElement;
    expect(adaRow.querySelector(".pill")).toHaveTextContent("Admin");
    // The dropdown lags the pill by a commit: Select keeps its own value and
    // re-seeds from the prop in an effect, so the rollback reaches it on the
    // render AFTER the one that shows the error. waitFor rather than a bare
    // assertion for that reason, and it matters that it arrives at all — the
    // row would otherwise show a pill saying "Admin" next to a dropdown saying
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

  it("names a custom role on each row, and offers it in the picker", async () => {
    setRoutes([
      listRoute(
        [USERS[0], USERS[1], { ...USERS[2], role: "qa-lead" }],
        [...ROLE_OPTIONS, { name: "qa-lead", label: "QA Lead" }]
      ),
      { match: "/api/admin/users", method: "PUT", body: { success: true } },
    ]);
    render(<AdminPage />);
    await screen.findByText("linus@example.com");

    // By the name the admin gave it, not the key it is stored under.
    const linusRow = screen.getByText("linus@example.com").closest(".card") as HTMLElement;
    expect(linusRow.querySelector(".pill")).toHaveTextContent("QA Lead");

    fireEvent.click(screen.getByRole("combobox", { name: "Role for grace@example.com" }));
    fireEvent.click(screen.getByRole("option", { name: "QA Lead" }));
    // The key goes to the server, and the row shows the name straight away.
    await waitFor(() =>
      expect(lastCall("PUT")).toMatchObject({
        url: "/api/admin/users",
        body: JSON.stringify({ userId: 2, role: "qa-lead" }),
      })
    );
    const graceRow = screen.getByText("grace@example.com").closest(".card") as HTMLElement;
    expect(graceRow.querySelector(".pill")).toHaveTextContent("QA Lead");
    await flushAsync();
  });

  describe("with sign-in off for testing", () => {
    it("says why nobody is listed, and says it once", async () => {
      mockBypass = true;
      setRoutes([listRoute([])]);
      render(<AdminPage />);

      // Not "No users yet": with sign-in off, nobody new can ever arrive, and
      // the page says so instead of waiting for people who can't come.
      expect(await screen.findByText("Nobody has signed in yet")).toBeInTheDocument();
      // The empty state already says sign-in is off, so the note above the
      // list stays away.
      expect(screen.queryByText("Sign-in is off for testing")).not.toBeInTheDocument();
    });

    it("lists the people who signed in before, under a note saying why it won't grow", async () => {
      mockBypass = true;
      setRoutes([listRoute()]);
      render(<AdminPage />);

      expect(await screen.findByText("ada@example.com")).toBeInTheDocument();
      expect(screen.getByText("Sign-in is off for testing")).toBeInTheDocument();
      // The stand-in admin can open both tabs, as a signed-in admin can.
      expect(screen.getByRole("tab", { name: "Users" })).toBeInTheDocument();
      expect(screen.getByRole("tab", { name: "Roles & permissions" })).toBeInTheDocument();
    });
  });
});

describe("the Roles & permissions tab", () => {
  it("loads the roles the first time the tab is opened, not before", async () => {
    setRoutes(rolesRoutes());
    render(<AdminPage />);
    await screen.findByText("ada@example.com");

    // Both tabs are on the page from the start, but nobody is looking at this
    // one yet, so it has asked for nothing.
    expect(rolesGets()).toBe(0);

    fireEvent.click(screen.getByRole("tab", { name: "Roles & permissions" }));
    // Viewer is first, so it is the one on screen.
    expect(await screen.findByRole("button", { name: "Viewer, 1 person" })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    expect(rolesGets()).toBe(1);
    expect(screen.getByRole("tab", { name: "Roles & permissions" })).toHaveAttribute(
      "aria-selected",
      "true"
    );
    // The Users tab is hidden, not gone, so its controls are out of reach.
    expect(screen.getByText("ada@example.com")).not.toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Remove ada@example.com" })
    ).not.toBeInTheDocument();
    expect(screen.getByText(/Nothing has been changed yet/)).toBeInTheDocument();
  });

  it("saves ticked boxes only when asked, then shows what the server kept", async () => {
    setRoutes(rolesRoutes());
    await openRolesTab();

    const box = screen.getByRole("checkbox", { name: "Connections: Create" });
    expect(box).not.toBeChecked();
    fireEvent.click(box);

    // Ticked on the screen, marked as unsaved on the chip and in the bar,
    // and nothing sent yet.
    expect(box).toBeChecked();
    expect(
      screen.getByRole("button", { name: "Viewer, 1 person, unsaved changes" })
    ).toBeInTheDocument();
    expect(screen.getByText("1 unsaved change to Viewer")).toBeInTheDocument();
    expect(fetchCalls.some((c) => c.method === "PUT")).toBe(false);

    // Withheld, so the wait is something the test can look at.
    const release = holdNext("/api/admin/roles", "PUT");
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByRole("button", { name: "Saving…" })).toBeDisabled();
    // No box can change while a save is on its way.
    expect(box).toBeDisabled();
    release();

    expect(await screen.findByText(/Saved 1 change to Viewer/)).toBeInTheDocument();
    // The whole set the role should have, not only the box that changed.
    expect(lastCall("PUT")?.body).toBe(
      JSON.stringify({
        role: "viewer",
        permissions: withToggled(presetFor("viewer") ?? [], "connections:create", true),
      })
    );
    expect(screen.queryByText(/unsaved changes? to/)).not.toBeInTheDocument();
    expect(box).toBeChecked();

    // And the list is read again, because counts and the log change with a save.
    await flushAsync();
    expect(rolesGets()).toBe(2);
    expect(box).toBeEnabled();
    expect(box).toBeChecked();
  });

  it("keeps the unsaved boxes when the server refuses the save", async () => {
    const refused =
      "Could not save the role's permissions. " +
      "The app's database may be unreachable. Try again in a moment.";
    setRoutes(
      rolesRoutes({ match: "/api/admin/roles", method: "PUT", status: 500, body: { error: refused } })
    );
    await openRolesTab();

    fireEvent.click(screen.getByRole("checkbox", { name: "Connections: Create" }));
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(refused);
    await flushAsync();
    // Still ticked and still waiting to be saved, so trying again is one click.
    expect(screen.getByText("1 unsaved change to Viewer")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Connections: Create" })).toBeChecked();
    expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled();
  });

  it("keeps each role's unsaved boxes apart, through a visit to the Users tab", async () => {
    setRoutes(rolesRoutes());
    await openRolesTab();
    fireEvent.click(screen.getByRole("button", { name: "QA Lead, 0 people" }));

    // Update can't be reached without opening Connections, so Read comes with it.
    fireEvent.click(screen.getByRole("checkbox", { name: "Connections: Update" }));
    expect(screen.getByRole("checkbox", { name: "Connections: Read" })).toBeChecked();
    expect(screen.getByText("2 unsaved changes to QA Lead")).toBeInTheDocument();

    // Unticking Read clears the row, which here puts the role back as it was
    // saved, so there is nothing left to save.
    fireEvent.click(screen.getByRole("checkbox", { name: "Connections: Read" }));
    expect(screen.getByRole("checkbox", { name: "Connections: Update" })).not.toBeChecked();
    expect(screen.queryByText(/unsaved changes? to/)).not.toBeInTheDocument();

    // A box ticked on QA Lead is not shown as unsaved on Editor...
    fireEvent.click(screen.getByRole("checkbox", { name: "Compare: Read" }));
    fireEvent.click(screen.getByRole("button", { name: "Editor, 1 person" }));
    expect(screen.queryByText(/unsaved changes? to/)).not.toBeInTheDocument();

    // ...and is still there after the other tab, and the reload coming back.
    fireEvent.click(screen.getByRole("tab", { name: "Users" }));
    fireEvent.click(screen.getByRole("tab", { name: "Roles & permissions" }));
    await waitFor(() => expect(rolesGets()).toBe(2));
    await flushAsync();

    fireEvent.click(screen.getByRole("button", { name: "QA Lead, 0 people, unsaved changes" }));
    expect(screen.getByText("1 unsaved change to QA Lead")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Compare: Read" })).toBeChecked();

    // Discard puts the saved boxes back without asking the server anything.
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(screen.getByRole("checkbox", { name: "Compare: Read" })).not.toBeChecked();
    expect(screen.queryByText(/unsaved changes? to/)).not.toBeInTheDocument();
    expect(fetchCalls.some((c) => c.method === "PUT")).toBe(false);
  });

  it("shows Admin with every box ticked and none of them changeable", async () => {
    setRoutes(rolesRoutes());
    await openRolesTab();
    fireEvent.click(screen.getByRole("button", { name: "Admin, 1 person" }));

    expect(screen.getByText("Admin can always do everything")).toBeInTheDocument();
    const box = screen.getByRole("checkbox", { name: "Connections: Create" });
    expect(box).toBeChecked();
    expect(box).toBeDisabled();
    // Including the rows only Admin can have.
    expect(screen.getByRole("checkbox", { name: "Roles & permissions: Update" })).toBeChecked();
    // Admin is built in and has nowhere else to be, so neither button is offered.
    expect(screen.queryByRole("button", { name: "Reset to default" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete role" })).not.toBeInTheDocument();
  });

  it("offers no boxes for managing people and roles on any other role", async () => {
    setRoutes(rolesRoutes());
    await openRolesTab();

    // Users and Roles & permissions: one cell each saying why, instead of
    // boxes the server would refuse to save.
    expect(screen.getAllByText("Admins only")).toHaveLength(2);
    expect(screen.queryByRole("checkbox", { name: "Users: Read" })).not.toBeInTheDocument();
    expect(
      screen.queryByRole("checkbox", { name: "Roles & permissions: Read" })
    ).not.toBeInTheDocument();
  });

  it("puts a built-in role back to its defaults once confirmed", async () => {
    setRoutes(rolesRoutes());
    await openRolesTab();
    // Viewer is already where a new install puts it.
    expect(screen.getByRole("button", { name: "Reset to default" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Editor, 1 person" }));
    expect(screen.getByRole("checkbox", { name: "Deploy: Run" })).not.toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Reset to default" }));
    confirmIn("Reset Editor to its defaults?", "Reset");

    expect(await screen.findByText("Put Editor back to its defaults.")).toBeInTheDocument();
    // The server works out the defaults, so the page only asks for them.
    expect(lastCall("PUT")?.body).toBe(JSON.stringify({ role: "editor", reset: true }));
    expect(screen.getByRole("checkbox", { name: "Deploy: Run" })).toBeChecked();
    expect(screen.getByRole("button", { name: "Reset to default" })).toBeDisabled();
    await flushAsync();
  });

  it("makes a new role, and says so when the name is missing or taken", async () => {
    const taken = "There is already a role with that name. Pick a different name.";
    setRoutes(
      rolesRoutes({ match: "/api/admin/roles", method: "POST", status: 409, body: { error: taken } })
    );
    await openRolesTab();
    fireEvent.click(screen.getByRole("button", { name: "New role" }));

    // An empty name never reaches the server.
    fireEvent.click(screen.getByRole("button", { name: "Create role" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Give the role a name.");
    expect(fetchCalls.some((c) => c.method === "POST")).toBe(false);

    // A taken one does, and the server's reason is shown in the form.
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Release Manager" } });
    fireEvent.click(screen.getByRole("button", { name: "Create role" }));
    expect(await screen.findByText(taken)).toBeInTheDocument();
    await flushAsync();
    // Nothing was made, so there is nothing new for View as to offer.
    expect(rolesAnnounced).not.toHaveBeenCalled();

    // The name is still typed in, so trying again is one click.
    setRoutes(
      rolesRoutes({
        match: "/api/admin/roles",
        method: "POST",
        status: 201,
        body: () => {
          const role: RoleSummary = {
            name: "release-manager",
            label: "Release Manager",
            description: "",
            builtIn: false,
            userCount: 0,
            permissions: [...(presetFor("viewer") ?? [])],
          };
          roleRows.push(role);
          return copy({ role });
        },
      })
    );
    fireEvent.click(screen.getByRole("button", { name: "Create role" }));

    expect(await screen.findByText(/Created Release Manager/)).toBeInTheDocument();
    // A new role starts as a copy of Viewer unless the admin picks otherwise.
    expect(lastCall("POST")?.body).toBe(
      JSON.stringify({ label: "Release Manager", description: "", copyFrom: "viewer" })
    );
    // And it is the role on screen, ready for its boxes to be changed.
    expect(screen.getByRole("button", { name: "Release Manager, 0 people" })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    expect(screen.getByRole("heading", { name: "Release Manager" })).toBeInTheDocument();
    // View as on the rail is told, so it can offer the new role straight away.
    expect(rolesAnnounced).toHaveBeenCalledTimes(1);
    await flushAsync();
  });

  it("deletes a custom role once confirmed, and keeps it when the server says no", async () => {
    const held = "Someone still has this role. Give them another role on the Users tab first.";
    setRoutes(
      rolesRoutes({ match: "/api/admin/roles", method: "DELETE", status: 409, body: { error: held } })
    );
    await openRolesTab();
    fireEvent.click(screen.getByRole("button", { name: "QA Lead, 0 people" }));

    // Someone was given the role after this page loaded: the server has the
    // last word, and the role stays.
    fireEvent.click(screen.getByRole("button", { name: "Delete role" }));
    confirmIn("Delete QA Lead?", "Delete role");
    expect(await screen.findByRole("alert")).toHaveTextContent(held);
    expect(screen.getByRole("button", { name: "QA Lead, 0 people" })).toBeInTheDocument();
    await flushAsync();
    expect(rolesAnnounced).not.toHaveBeenCalled();

    setRoutes(
      rolesRoutes({
        match: "/api/admin/roles",
        method: "DELETE",
        body: () => {
          roleRows = roleRows.filter((r) => r.name !== "qa-lead");
          return { success: true };
        },
      })
    );
    fireEvent.click(screen.getByRole("button", { name: "Delete role" }));
    confirmIn("Delete QA Lead?", "Delete role");

    expect(await screen.findByText("Deleted QA Lead.")).toBeInTheDocument();
    expect(lastCall("DELETE")?.body).toBe(JSON.stringify({ role: "qa-lead" }));
    // Gone from the chips, and the page falls back to the first role.
    expect(screen.queryByRole("button", { name: /QA Lead/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Viewer, 1 person" })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    // And View as on the rail is told, so it stops offering the role.
    expect(rolesAnnounced).toHaveBeenCalledTimes(1);
    await flushAsync();
  });

  it("won't delete a role somebody has, and says what to do first", async () => {
    roleRows[3].userCount = 2;
    setRoutes(rolesRoutes());
    await openRolesTab();
    fireEvent.click(screen.getByRole("button", { name: "QA Lead, 2 people" }));

    expect(screen.getByRole("button", { name: "Delete role" })).toBeDisabled();
    expect(
      screen.getByText(
        "2 people have this role. To delete it, give them another role on the Users tab first."
      )
    ).toBeInTheDocument();
  });

  it("lists recent changes, with one line for each save", async () => {
    changeRows = [
      {
        id: 3,
        role: "editor",
        roleLabel: "Editor",
        kind: "grant",
        feature: "connections",
        action: "create",
        subject: null,
        detail: null,
        actor: "admin@example.com",
        createdAt: "2026-10-16T10:02:00.000Z",
      },
      {
        id: 2,
        role: "editor",
        roleLabel: "Editor",
        kind: "assign",
        feature: null,
        action: null,
        subject: "grace@example.com",
        detail: "Viewer",
        actor: "admin@example.com",
        createdAt: "2026-10-16T10:01:00.000Z",
      },
      {
        id: 1,
        role: "qa-lead",
        roleLabel: "QA Lead",
        kind: "create-role",
        feature: null,
        action: null,
        subject: null,
        detail: "Copied from Viewer",
        actor: "admin@example.com",
        createdAt: "2026-10-16T10:00:00.000Z",
      },
    ];
    setRoutes(rolesRoutes());
    await openRolesTab();

    expect(screen.getByText("changed what Editor can do")).toBeInTheDocument();
    expect(screen.getByText("Gave: Connections: Create")).toBeInTheDocument();
    expect(
      screen.getByText("gave grace@example.com the Editor role, instead of Viewer")
    ).toBeInTheDocument();
    expect(screen.getByText("created QA Lead (copied from Viewer)")).toBeInTheDocument();
    expect(screen.queryByText(/Nothing has been changed yet/)).not.toBeInTheDocument();
  });

  it("offers a retry when the roles cannot be loaded, and the retry works", async () => {
    const unreachable =
      "Could not read the roles. The app's database may be unreachable. Try again in a moment.";
    setRoutes(
      rolesRoutes({
        match: "/api/admin/roles",
        method: "GET",
        status: 500,
        body: { error: unreachable },
      })
    );
    render(<AdminPage />);
    await screen.findByText("ada@example.com");
    fireEvent.click(screen.getByRole("tab", { name: "Roles & permissions" }));

    expect(await screen.findByText(/Couldn.t load roles/)).toBeInTheDocument();
    expect(screen.getByText(unreachable)).toBeInTheDocument();

    setRoutes(rolesRoutes());
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("button", { name: "Viewer, 1 person" })).toBeInTheDocument();
    expect(screen.queryByText(/Couldn.t load roles/)).not.toBeInTheDocument();
  });
});

describe("the guide above the tabs", () => {
  /** The folding panel, found by the words on its header. */
  function guide(): HTMLDetailsElement {
    const panel = screen.getByText("How roles and permissions work").closest("details");
    if (!panel) throw new Error("The guide is not a <details>");
    return panel;
  }

  /** The numbered steps, the first of the guide's two lists. */
  function steps(): HTMLElement[] {
    const [numbered] = within(guide()).getAllByRole("list");
    return within(numbered).getAllByRole("listitem");
  }

  /**
   * Fold or unfold it as a click on its header does in a browser. jsdom does
   * not fold a <details> on a click, so this does both halves itself: flip
   * `open`, then fire the toggle event the browser fires after it.
   */
  function setOpen(panel: HTMLDetailsElement, open: boolean) {
    panel.open = open;
    fireEvent(panel, new Event("toggle"));
  }

  async function openPage() {
    render(<AdminPage />);
    await screen.findByText("ada@example.com");
  }

  it("opens on the first visit, with the steps and a line for every box", async () => {
    setRoutes([listRoute()]);
    await openPage();

    expect(guide().open).toBe(true);
    // Named and ordered as the grid's columns are, so the guide and the grid
    // never call the same box two different things.
    expect(within(guide()).getAllByRole("term").map((term) => term.textContent)).toEqual(
      ACTIONS.map((action) => ACTION_LABELS[action])
    );
    // With real sign-in there is no View as on the sidebar, so no step for it.
    expect(steps()).toHaveLength(4);
    expect(within(guide()).queryByText("View as")).not.toBeInTheDocument();
  });

  it("stays folded once folded, and open once opened again", async () => {
    setRoutes([listRoute()]);
    await openPage();
    setOpen(guide(), false);
    cleanup();

    // The next visit, in the same browser.
    await openPage();
    expect(guide().open).toBe(false);
    setOpen(guide(), true);
    cleanup();

    await openPage();
    expect(guide().open).toBe(true);
  });

  it("adds a step for View as while sign-in is off for testing", async () => {
    mockBypass = true;
    setRoutes([listRoute()]);
    await openPage();

    expect(steps()).toHaveLength(5);
    expect(within(steps()[4]).getByText("View as")).toBeInTheDocument();
  });

  it("still opens, and still folds, when the browser keeps nothing", async () => {
    // What a private window that blocks storage does: every touch throws.
    const refuse = () => {
      throw new DOMException("The operation is insecure.", "SecurityError");
    };
    const spies = (["getItem", "setItem", "removeItem"] as const).map((method) =>
      jest.spyOn(Storage.prototype, method).mockImplementation(refuse)
    );
    try {
      setRoutes([listRoute()]);
      await openPage();
      expect(guide().open).toBe(true);

      setOpen(guide(), false);
      expect(guide().open).toBe(false);
    } finally {
      spies.forEach((spy) => spy.mockRestore());
    }
  });
});
