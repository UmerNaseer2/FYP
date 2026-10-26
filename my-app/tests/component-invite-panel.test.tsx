/** @jest-environment jsdom */

/**
 * "Invite people" on the Users tab (components/admin/InvitePanel.tsx): the two
 * ways to invite someone, the link it shows once, and the invitations still
 * waiting to be taken.
 *
 * The server keeps only a hash of each invitation's token, so the moment the
 * panel shows a new link is the only moment it exists anywhere a person can
 * read it. Most of what is held here follows from that: the link is shown
 * whole and can be copied, or selected when the browser will not copy, and an
 * answer the panel cannot read says plainly that the link is lost rather than
 * showing nothing.
 *
 * What it is held to here:
 *  - Nothing is drawn until the server says invitations work here, and
 *    nothing at all where it says they do not (the demo, the desktop app).
 *  - An address is checked before anything is sent, and the address sent is
 *    the cleaned one.
 *  - A refusal lands under the box it is about when the server names one, and
 *    in a banner when it does not.
 *  - A new invitation's link is the token on this site's own address.
 *  - Cancelling asks first, sends the invitation's id, and takes the row away;
 *    a refused cancel says why.
 *  - A list asked for before a change and answered after it is thrown away.
 *
 * What is NOT here:
 *  - Whether the server makes, refuses or cancels anything. The route and the
 *    database half are tests/admin-invites-route.test.ts and
 *    tests/invites-db.test.ts.
 *  - Whether the panel appears on the Users tab at all, and for whom. That is
 *    tests/page-admin.test.tsx.
 *  - What opening the link does. That is the invitation page's own suites.
 */

import "@testing-library/jest-dom";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

jest.mock("next/navigation", () => require("./helpers/render-page").navigationStubs);
jest.mock("next-auth/react", () => require("./helpers/render-page").sessionStubs);

import { InvitePanel } from "@/components/admin/InvitePanel";
import type { SelectOption } from "@/components/ui/Select";
import type { InviteListing, PendingInvite } from "@/lib/invites";
import {
  fetchCalls,
  flushAsync,
  holdNext,
  resetPageState,
  setRoutes,
  type FetchRoute,
} from "./helpers/render-page";

/** The roles the Users tab hands the panel, as GET /api/admin/users sends them. */
const OPTIONS: SelectOption[] = [
  { value: "viewer", label: "Viewer" },
  { value: "editor", label: "Editor" },
  { value: "admin", label: "Admin" },
];

/** 43 characters from the URL-safe alphabet, the shape lib/invites.ts isInviteToken expects. */
const TOKEN = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE";

const GRACE: PendingInvite = {
  id: 7,
  kind: "email",
  email: "grace@example.com",
  role: "editor",
  roleLabel: "Editor",
  invitedBy: "ada@example.com",
  createdAt: "2026-10-26T09:00:00.000Z",
  expiresAt: "2026-11-02T09:00:00.000Z",
};

const LINK: PendingInvite = {
  id: 8,
  kind: "link",
  email: null,
  role: "viewer",
  roleLabel: "Viewer",
  invitedBy: null,
  createdAt: "2026-10-26T09:00:00.000Z",
  expiresAt: "2026-11-25T09:00:00.000Z",
};

/**
 * The invitations the server holds. The routes below read and change it, so a
 * reload after a change shows what the server kept. Made fresh for every test.
 */
let waiting: PendingInvite[] = [];

/** A copy, as a real reply is: the panel must not hold the array the routes change. */
function copy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

const listRoute = (canInvite = true): FetchRoute => ({
  match: "/api/admin/invites",
  method: "GET",
  body: (): InviteListing => copy({ invites: waiting, canInvite }),
});

/** POST, answering as the route does when it makes one: 201, the row and its token. */
const madeRoute = (invite: PendingInvite): FetchRoute => ({
  match: "/api/admin/invites",
  method: "POST",
  status: 201,
  body: () => {
    waiting = [invite, ...waiting];
    return { invite, token: TOKEN };
  },
});

/** DELETE, taking the row away as the route does. */
const cancelRoute: FetchRoute = {
  match: "/api/admin/invites",
  method: "DELETE",
  body: (_url: string, init?: RequestInit) => {
    const { id } = JSON.parse(String(init?.body));
    waiting = waiting.filter((invite) => invite.id !== id);
    return { cancelled: true };
  },
};

function listGets(): number {
  return fetchCalls.filter((c) => c.method === "GET" && c.url.includes("/api/admin/invites"))
    .length;
}

function lastCall(method: string) {
  return fetchCalls.filter((c) => c.method === method).at(-1);
}

/** Draw the panel on an open tab, and wait for its first list. */
async function openPanel() {
  const view = render(<InvitePanel active options={OPTIONS} />);
  await screen.findByRole("heading", { name: "Invite people" });
  return view;
}

function emailBox(): HTMLInputElement {
  return screen.getByLabelText("Email address") as HTMLInputElement;
}

function linkBox(): HTMLInputElement {
  return screen.getByRole("textbox", { name: "Invitation link" }) as HTMLInputElement;
}

function pick(combobox: string, option: string) {
  fireEvent.click(screen.getByRole("combobox", { name: combobox }));
  fireEvent.click(screen.getByRole("option", { name: option }));
}

/** Put a clipboard on navigator, which jsdom does not have, the way a secure page does. */
function installClipboard(writeText: jest.Mock) {
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  });
}

beforeEach(() => {
  resetPageState();
  waiting = [GRACE, LINK];
});
afterEach(() => {
  cleanup();
  // Gone again, as on a plain-http page: a clipboard left behind would make
  // every later test a secure page.
  delete (navigator as { clipboard?: unknown }).clipboard;
});

describe("before and around the list", () => {
  it("draws nothing until the server says invitations work here", async () => {
    setRoutes([listRoute()]);
    const release = holdNext("/api/admin/invites", "GET");
    render(<InvitePanel active options={OPTIONS} />);

    // Not an empty panel that fills in a moment later, and not forms that
    // might turn out to be refused.
    expect(screen.queryByRole("heading", { name: "Invite people" })).not.toBeInTheDocument();

    release();
    expect(await screen.findByRole("heading", { name: "Invite people" })).toBeInTheDocument();
  });

  it("draws nothing at all where nobody can be invited", async () => {
    setRoutes([listRoute(false)]);
    render(<InvitePanel active options={OPTIONS} />);
    await flushAsync();

    expect(listGets()).toBe(1);
    expect(screen.queryByRole("heading", { name: "Invite people" })).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("asks nothing while the tab is closed, and asks again each time it opens", async () => {
    setRoutes([listRoute()]);
    const view = render(<InvitePanel active={false} options={OPTIONS} />);
    await flushAsync();
    expect(listGets()).toBe(0);

    view.rerender(<InvitePanel active options={OPTIONS} />);
    await screen.findByRole("heading", { name: "Invite people" });
    expect(listGets()).toBe(1);

    // An invitation taken while the tab was closed should not still be listed.
    waiting = [LINK];
    view.rerender(<InvitePanel active={false} options={OPTIONS} />);
    view.rerender(<InvitePanel active options={OPTIONS} />);
    await waitFor(() => expect(screen.queryByText("grace@example.com")).not.toBeInTheDocument());
    expect(listGets()).toBe(2);
  });

  it("says why when the first list cannot be loaded, and Retry loads it", async () => {
    setRoutes([
      {
        match: "/api/admin/invites",
        method: "GET",
        status: 503,
        body: { error: "The app database is unreachable." },
      },
    ]);
    render(<InvitePanel active options={OPTIONS} />);

    expect(await screen.findByRole("alert")).toHaveTextContent("The app database is unreachable.");
    // No forms under a list that never arrived: whether invitations work here
    // at all is what the list would have said.
    expect(screen.queryByLabelText("Email address")).not.toBeInTheDocument();

    setRoutes([listRoute()]);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("grace@example.com")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("says the server could not be reached when the request never arrives", async () => {
    setRoutes([{ match: "/api/admin/invites", method: "GET", networkError: true }]);
    render(<InvitePanel active options={OPTIONS} />);

    expect(await screen.findByRole("alert")).toHaveTextContent("Could not reach the server.");
  });
});

describe("the invitations waiting", () => {
  it("lists each one with its role, when it runs out and who made it", async () => {
    setRoutes([listRoute()]);
    await openPanel();

    const grace = screen.getByText("grace@example.com").closest("li") as HTMLElement;
    expect(within(grace).getByText("Editor")).toBeInTheDocument();
    expect(grace).toHaveTextContent("Lasts until Nov 2, 2026 · made by ada@example.com");

    // A link has no address to show, and its maker may have been removed since.
    const link = screen.getByText("Invitation link").closest("li") as HTMLElement;
    expect(within(link).getByText("Viewer")).toBeInTheDocument();
    expect(link).toHaveTextContent("Lasts until Nov 25, 2026");
    expect(link).not.toHaveTextContent("made by");
  });

  it("says so when nothing is waiting", async () => {
    waiting = [];
    setRoutes([listRoute()]);
    await openPanel();

    expect(screen.getByText("No invitations are waiting.")).toBeInTheDocument();
  });

  it("cancels one only after asking, and takes its row away", async () => {
    setRoutes([listRoute(), cancelRoute]);
    await openPanel();

    fireEvent.click(screen.getByRole("button", { name: "Cancel the invitation for grace@example.com" }));
    const dialog = screen.getByRole("dialog", { name: "Cancel the invitation for grace@example.com?" });
    expect(dialog).toHaveTextContent("The link you sent stops working at once.");
    // Nothing sent yet: the button only opens the question.
    expect(lastCall("DELETE")).toBeUndefined();

    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel invitation" }));
    await waitFor(() => expect(screen.queryByText("grace@example.com")).not.toBeInTheDocument());
    expect(lastCall("DELETE")).toMatchObject({ body: JSON.stringify({ id: 7 }) });
    expect(screen.getByText("Invitation link")).toBeInTheDocument();
    // And the list is asked for again, to show what the server kept.
    await waitFor(() => expect(listGets()).toBe(2));
  });

  it("names a link by when it runs out, and says what cancelling it does", async () => {
    setRoutes([listRoute(), cancelRoute]);
    await openPanel();

    fireEvent.click(
      screen.getByRole("button", { name: "Cancel the invitation link that lasts until Nov 25, 2026" })
    );
    const dialog = screen.getByRole("dialog", { name: "Cancel this invitation link?" });
    // Cancelling a link does not undo who already joined with it.
    expect(dialog).toHaveTextContent("Anyone who already joined with it stays a member.");
  });

  it("keeps nothing back when Keep it is pressed", async () => {
    setRoutes([listRoute(), cancelRoute]);
    await openPanel();

    fireEvent.click(screen.getByRole("button", { name: "Cancel the invitation for grace@example.com" }));
    fireEvent.click(screen.getByRole("button", { name: "Keep it" }));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(lastCall("DELETE")).toBeUndefined();
    expect(screen.getByText("grace@example.com")).toBeInTheDocument();
  });

  it("says why a cancel was refused, and shows the list as it is now", async () => {
    const gone = "That invitation is not waiting any more.";
    setRoutes([
      listRoute(),
      {
        match: "/api/admin/invites",
        method: "DELETE",
        status: 404,
        body: () => {
          // Taken a moment before, by the person it was for.
          waiting = waiting.filter((invite) => invite.id !== GRACE.id);
          return { error: gone };
        },
      },
    ]);
    await openPanel();

    fireEvent.click(screen.getByRole("button", { name: "Cancel the invitation for grace@example.com" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel invitation" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(gone);
    await waitFor(() => expect(screen.queryByText("grace@example.com")).not.toBeInTheDocument());
  });

  it("holds every Cancel while one cancel is on its way", async () => {
    setRoutes([listRoute(), cancelRoute]);
    await openPanel();

    const release = holdNext("/api/admin/invites", "DELETE");
    fireEvent.click(screen.getByRole("button", { name: "Cancel the invitation for grace@example.com" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel invitation" }));

    // The dialog closes at once, so the row carries the wait.
    expect(await screen.findByText("Cancelling…")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Cancel the invitation link that lasts until Nov 25, 2026" })
    ).toBeDisabled();

    release();
    await waitFor(() => expect(screen.queryByText("grace@example.com")).not.toBeInTheDocument());
    expect(
      screen.getByRole("button", { name: "Cancel the invitation link that lasts until Nov 25, 2026" })
    ).toBeEnabled();
  });

  it("throws away a list asked for before a cancel and answered after it", async () => {
    setRoutes([listRoute(), cancelRoute]);
    const view = await openPanel();

    // A visit to the tab asks again, and that answer is held. It was made
    // while Grace's invitation was still waiting, so it still lists her.
    const stale = holdNext("/api/admin/invites", "GET");
    view.rerender(<InvitePanel active={false} options={OPTIONS} />);
    view.rerender(<InvitePanel active options={OPTIONS} />);

    fireEvent.click(screen.getByRole("button", { name: "Cancel the invitation for grace@example.com" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel invitation" }));
    await waitFor(() => expect(screen.queryByText("grace@example.com")).not.toBeInTheDocument());
    await waitFor(() => expect(listGets()).toBe(3));

    // The old answer arriving now must not bring the cancelled row back.
    stale();
    await flushAsync();
    expect(screen.queryByText("grace@example.com")).not.toBeInTheDocument();
  });
});

describe("an invitation to an email address", () => {
  it("checks the address before sending anything", async () => {
    setRoutes([listRoute()]);
    await openPanel();

    fireEvent.click(screen.getByRole("button", { name: "Make invitation" }));
    expect(screen.getByText("Type the email address of the person to invite.")).toBeInTheDocument();
    expect(emailBox()).toHaveAttribute("aria-invalid", "true");
    expect(emailBox()).toHaveAccessibleDescription("Type the email address of the person to invite.");
    expect(emailBox()).toHaveFocus();

    fireEvent.change(emailBox(), { target: { value: "grace" } });
    fireEvent.click(screen.getByRole("button", { name: "Make invitation" }));
    expect(screen.getByText(/That is not an email address/)).toBeInTheDocument();

    expect(lastCall("POST")).toBeUndefined();
  });

  it("sends the cleaned address and the role picked, then shows the link once", async () => {
    const made = { ...GRACE, id: 9, email: "new@example.com", role: "editor", roleLabel: "Editor" };
    setRoutes([listRoute(), madeRoute(made)]);
    await openPanel();

    fireEvent.change(emailBox(), { target: { value: "  New@Example.COM " } });
    pick("Role", "Editor");
    fireEvent.click(screen.getByRole("button", { name: "Make invitation" }));

    const box = await screen.findByRole("textbox", { name: "Invitation link" });
    expect(JSON.parse(String(lastCall("POST")?.body))).toEqual({
      kind: "email",
      email: "new@example.com",
      role: "editor",
    });
    // The token on this site's own address: jsdom's is http://localhost.
    expect(box).toHaveValue(`http://localhost/invite/${TOKEN}`);
    expect(screen.getByText("Invitation for new@example.com, as Editor")).toBeInTheDocument();
    expect(screen.getByText(/This is the only time the link is shown/)).toBeInTheDocument();
    // Ready for the next person, and Copy is what to press now.
    expect(emailBox()).toHaveValue("");
    expect(screen.getByRole("button", { name: "Copy link" })).toHaveFocus();
    // And the new invitation is listed, from the server's own list.
    await waitFor(() => expect(listGets()).toBe(2));
    expect(screen.getByText("new@example.com", { selector: "li span" })).toBeInTheDocument();
  });

  it("offers Viewer first, so nobody is given more by accident", async () => {
    setRoutes([listRoute()]);
    await openPanel();

    expect(screen.getByRole("combobox", { name: "Role" })).toHaveTextContent("Viewer");
  });

  it("puts a refusal about the address under the address", async () => {
    const member = "new@example.com is already a member here.";
    setRoutes([
      listRoute(),
      {
        match: "/api/admin/invites",
        method: "POST",
        status: 409,
        body: { error: member, field: "email" },
      },
    ]);
    await openPanel();

    fireEvent.change(emailBox(), { target: { value: "new@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Make invitation" }));

    expect(await screen.findByText(member)).toHaveClass("field-problem");
    expect(emailBox()).toHaveAttribute("aria-invalid", "true");
    expect(emailBox()).toHaveValue("new@example.com");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Invitation link" })).not.toBeInTheDocument();
  });

  it("puts a refusal about nothing in particular in a banner", async () => {
    setRoutes([
      listRoute(),
      {
        match: "/api/admin/invites",
        method: "POST",
        status: 403,
        body: { error: "You don't have permission to do that." },
      },
    ]);
    await openPanel();

    fireEvent.change(emailBox(), { target: { value: "new@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Make invitation" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "You don't have permission to do that."
    );
    expect(emailBox()).not.toHaveAttribute("aria-invalid");
  });

  it("says the link is lost when the server made one but its answer cannot be read", async () => {
    setRoutes([
      listRoute(),
      { match: "/api/admin/invites", method: "POST", status: 201, body: { invite: GRACE } },
    ]);
    await openPanel();

    fireEvent.change(emailBox(), { target: { value: "grace@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Make invitation" }));

    // Nothing to copy, and a way out: the invitation exists, so it can be
    // cancelled and made again.
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Cancel it below and make a new one."
    );
    expect(screen.queryByRole("textbox", { name: "Invitation link" })).not.toBeInTheDocument();
    await waitFor(() => expect(listGets()).toBe(2));
  });

  it("holds both forms while one invitation is being made", async () => {
    setRoutes([listRoute(), madeRoute(GRACE)]);
    await openPanel();

    const release = holdNext("/api/admin/invites", "POST");
    fireEvent.change(emailBox(), { target: { value: "grace@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Make invitation" }));

    expect(await screen.findByText("Making…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Make link" })).toBeDisabled();

    release();
    await screen.findByRole("textbox", { name: "Invitation link" });
    expect(screen.getByRole("button", { name: "Make link" })).toBeEnabled();
    expect(fetchCalls.filter((c) => c.method === "POST")).toHaveLength(1);
  });
});

describe("an invitation link", () => {
  it("lasts as long as picked, and says who it lets in", async () => {
    setRoutes([listRoute(), madeRoute({ ...LINK, id: 10 })]);
    await openPanel();

    expect(screen.getByText(/Anyone who has the link can join as a Viewer/)).toBeInTheDocument();
    pick("Lasts", "30 days");
    fireEvent.click(screen.getByRole("button", { name: "Make link" }));

    await screen.findByRole("textbox", { name: "Invitation link" });
    expect(JSON.parse(String(lastCall("POST")?.body))).toEqual({ kind: "link", days: 30 });
    expect(screen.getByText("Invitation link, as Viewer, until Nov 25, 2026")).toBeInTheDocument();
  });

  it("puts a refusal about the days under the days", async () => {
    const days = "Choose how long the link lasts: 1, 7 or 30 days.";
    setRoutes([
      listRoute(),
      { match: "/api/admin/invites", method: "POST", status: 400, body: { error: days, field: "days" } },
    ]);
    await openPanel();

    fireEvent.click(screen.getByRole("button", { name: "Make link" }));
    expect(await screen.findByText(days)).toHaveClass("field-problem");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("the link just made", () => {
  async function makeOne() {
    // Only the new one waiting, so its row is the only "Invitation link" row
    // to find. Two links made the same day for the same length read the same.
    waiting = [];
    setRoutes([listRoute(), madeRoute({ ...LINK, id: 10 }), cancelRoute]);
    await openPanel();
    fireEvent.click(screen.getByRole("button", { name: "Make link" }));
    await screen.findByRole("textbox", { name: "Invitation link" });
  }

  it("copies the link", async () => {
    const writeText = jest.fn(() => Promise.resolve());
    installClipboard(writeText);
    await makeOne();

    fireEvent.click(screen.getByRole("button", { name: "Copy link" }));
    expect(await screen.findByRole("button", { name: "Copied" })).toBeInTheDocument();
    expect(writeText).toHaveBeenCalledWith(`http://localhost/invite/${TOKEN}`);
  });

  it("selects the link to copy by hand when the browser will not copy it", async () => {
    // No clipboard at all, as on a plain-http page that is not localhost.
    await makeOne();

    fireEvent.click(screen.getByRole("button", { name: "Copy link" }));
    expect(await screen.findByText(/copy it from the box/)).toBeInTheDocument();
    expect(linkBox()).toHaveFocus();
    expect(linkBox().selectionStart).toBe(0);
    expect(linkBox().selectionEnd).toBe(linkBox().value.length);
  });

  it("goes when Done is pressed", async () => {
    await makeOne();

    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.queryByRole("textbox", { name: "Invitation link" })).not.toBeInTheDocument();
  });

  it("goes when its invitation is cancelled, since it no longer works", async () => {
    await makeOne();

    fireEvent.click(
      screen.getByRole("button", { name: "Cancel the invitation link that lasts until Nov 25, 2026" })
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Cancel invitation" }));
    });
    await waitFor(() =>
      expect(screen.queryByRole("textbox", { name: "Invitation link" })).not.toBeInTheDocument()
    );
  });
});
