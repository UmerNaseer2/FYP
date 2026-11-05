/**
 * @jest-environment jsdom
 */
// The Requests page: where someone asks for what their role can't do, where
// whoever can change roles answers, and where a production run waiting on
// somebody can be found.
//
// The app sends no email, so this page is the only place a person learns any of
// it. What these pin is that each person is offered only what they can actually
// use, and that an answer which changes a role really changes it first.
import "@testing-library/jest-dom";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { REQUESTS_CHANGED_EVENT, type InboxRequest, type RequestsPayload } from "@/lib/access-requests";
import type { ListedApproval } from "@/lib/approvals-db";
import { permissionLabel, type PermissionKey } from "@/lib/permissions";
import {
  fetchCalls,
  render,
  resetPageState,
  setCustomRole,
  setRoutes,
  setSearchParams,
  setUser,
  type FetchRoute,
} from "./helpers/render-page";

jest.mock("next-auth/react", () => require("./helpers/render-page").sessionStubs);
jest.mock("next/navigation", () => require("./helpers/render-page").navigationStubs);

import RequestsPage from "@/app/[org]/(studio)/requests/page";

const LONG_AGO = "2026-01-01T09:00:00.000Z";
const LATER = "2026-01-02T09:00:00.000Z";
const FUTURE = "2099-01-02T09:00:00.000Z";

function payload(over: Partial<RequestsPayload> = {}): RequestsPayload {
  return {
    mine: [],
    inbox: [],
    runsToApprove: [],
    runsToRun: [],
    myRuns: [],
    canAnswer: false,
    lastSeenAt: null,
    counts: { waiting: 0, answered: 0 },
    ...over,
  };
}

function ownRequest(over: Partial<RequestsPayload["mine"][number]> = {}): RequestsPayload["mine"][number] {
  return {
    id: 1,
    requested_by: "viewer@example.com",
    requested_by_name: "A viewer",
    permission: "deploy:run",
    message: null,
    status: "pending",
    decided_by: null,
    decided_at: null,
    decision_note: null,
    created_at: LONG_AGO,
    ...over,
  };
}

function inboxRequest(over: Partial<InboxRequest> = {}): InboxRequest {
  return {
    ...ownRequest({ id: 5, requested_by: "carol@example.com", requested_by_name: "Carol Reader" }),
    member_id: 33,
    member_role: "viewer",
    member_role_label: "Viewer",
    ...over,
  };
}

function aRun(over: Partial<ListedApproval> = {}): ListedApproval {
  return {
    id: 9,
    connection_id: 2,
    connection_name: "Bookshop prod",
    schema_name: "shop",
    script_name: "add_author",
    target_version: "1.2.0",
    run_fingerprint: "abc",
    migration_count: 1,
    breaking_count: 0,
    requested_by: "dan@example.com",
    requested_at: LONG_AGO,
    status: "pending",
    decided_by: null,
    decided_at: null,
    self_approved: false,
    note: null,
    used_at: null,
    action: "deploy",
    expires_at: null,
    ...over,
  } as ListedApproval;
}

const listRoute = (body: RequestsPayload, status = 200): FetchRoute => ({
  match: /\/api\/requests$/,
  method: "GET",
  status,
  body,
});
const seenRoute = (): FetchRoute => ({
  match: "/api/requests/seen",
  method: "POST",
  body: { ok: true },
});
const answerRoute = (status = 200, body: unknown = { request: {} }): FetchRoute => ({
  match: /\/api\/requests\/\d+$/,
  method: "PATCH",
  status,
  body,
});
const rolesRoute = (permissions: PermissionKey[] = [], userCount = 3): FetchRoute => ({
  match: "/api/admin/roles",
  method: "GET",
  body: { roles: [{ name: "viewer", label: "Viewer", userCount, permissions }], changes: [] },
});

function callsTo(pattern: RegExp, method: string) {
  return fetchCalls.filter((call) => pattern.test(call.url) && call.method.toUpperCase() === method);
}
const saved = (pattern: RegExp, method: string) =>
  JSON.parse(callsTo(pattern, method).at(-1)?.body ?? "null") as Record<string, unknown>;

async function draw(body: RequestsPayload, more: FetchRoute[] = []) {
  setRoutes([seenRoute(), answerRoute(), ...more, listRoute(body)]);
  render(<RequestsPage />);
}

/** Opens a picker and takes one option out of it. */
async function pick(box: string, option: string | RegExp) {
  fireEvent.click(await screen.findByRole("combobox", { name: box }));
  fireEvent.click(await screen.findByRole("option", { name: option }));
}

/** The label one permission has in the list of things to ask for: its line on the Roles tab. */
function optionFor(key: PermissionKey): string {
  return permissionLabel(key);
}

beforeEach(() => resetPageState());
afterEach(() => cleanup());

describe("asking for something", () => {
  beforeEach(() => setUser("viewer"));

  it("says this is the place to ask, and how an answer reaches you", async () => {
    await draw(payload());
    expect(await screen.findByRole("heading", { name: "Ask for what your role can't do" })).toBeInTheDocument();
    expect(screen.getByText(/does not send email/)).toBeInTheDocument();
  });

  it("offers only what the role can't do and an admin could give", async () => {
    await draw(payload());
    fireEvent.click(await screen.findByRole("combobox", { name: "What do you need?" }));

    const names = (await screen.findAllByRole("option")).map((option) => option.textContent);
    expect(names).toContain(optionFor("deploy:run"));
    expect(names).toContain("Something else");
    // Already held.
    expect(names).not.toContain(optionFor("compare:read"));
    // Admin only: no one can be given this, so asking would be a dead end.
    expect(names).not.toContain(optionFor("roles:update"));
    expect(names).not.toContain(optionFor("organization:update"));
  });

  it("sends the choice and the reason, then says where the answer will show", async () => {
    await draw(payload(), [
      {
        match: /\/api\/requests$/,
        method: "POST",
        status: 201,
        body: { request: ownRequest(), already: false },
      },
    ]);
    const send = await screen.findByRole("button", { name: "Send request" });
    expect(send).toBeDisabled();

    await pick("What do you need?", optionFor("deploy:run"));
    fireEvent.change(screen.getByLabelText("Why? (optional)"), { target: { value: "For the release." } });
    fireEvent.click(send);

    expect(await screen.findByText(/The answer will show under Your requests/)).toBeInTheDocument();
    expect(saved(/\/api\/requests$/, "POST")).toEqual({
      permission: "deploy:run",
      message: "For the release.",
    });
  });

  it("wants words before sending something else, and sends no permission", async () => {
    await draw(payload(), [
      {
        match: /\/api\/requests$/,
        method: "POST",
        status: 201,
        body: { request: ownRequest({ permission: null }), already: false },
      },
    ]);
    await pick("What do you need?", "Something else");
    const send = screen.getByRole("button", { name: "Send request" });
    expect(send).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Say what you need"), { target: { value: "A role in between." } });
    expect(send).toBeEnabled();
    fireEvent.click(send);

    await screen.findByText(/The answer will show under Your requests/);
    expect(saved(/\/api\/requests$/, "POST")).toEqual({
      permission: null,
      message: "A role in between.",
    });
  });

  it("says so when the same thing is still waiting, rather than asking twice", async () => {
    await draw(payload(), [
      { match: /\/api\/requests$/, method: "POST", body: { request: ownRequest(), already: true } },
    ]);
    await pick("What do you need?", optionFor("deploy:run"));
    fireEvent.click(screen.getByRole("button", { name: "Send request" }));
    expect(await screen.findByText("You already asked for this, and it is still waiting.")).toBeInTheDocument();
  });

  it("drops what it said about the last request once another is picked", async () => {
    await draw(payload(), [
      { match: /\/api\/requests$/, method: "POST", body: { request: ownRequest(), already: true } },
    ]);
    await pick("What do you need?", optionFor("deploy:run"));
    fireEvent.click(screen.getByRole("button", { name: "Send request" }));
    await screen.findByText("You already asked for this, and it is still waiting.");

    await pick("What do you need?", optionFor("drift:create"));
    expect(screen.queryByText("You already asked for this, and it is still waiting.")).not.toBeInTheDocument();
  });

  it("drops a refusal too once another is picked", async () => {
    await draw(payload(), [
      { match: /\/api\/requests$/, method: "POST", status: 400, body: { error: "Your role can already do that." } },
    ]);
    await pick("What do you need?", optionFor("deploy:run"));
    fireEvent.click(screen.getByRole("button", { name: "Send request" }));
    await screen.findByRole("alert");

    await pick("What do you need?", optionFor("drift:create"));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows the server's own words when it refuses", async () => {
    const words = "You have 20 requests waiting. Withdraw one, or wait for an answer, before asking for more.";
    await draw(payload(), [
      { match: /\/api\/requests$/, method: "POST", status: 429, body: { error: words } },
    ]);
    await pick("What do you need?", optionFor("deploy:run"));
    fireEvent.click(screen.getByRole("button", { name: "Send request" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(words);
  });

  it("says it could not send when the server can't be reached", async () => {
    await draw(payload(), [{ match: /\/api\/requests$/, method: "POST", networkError: true }]);
    await pick("What do you need?", optionFor("deploy:run"));
    fireEvent.click(screen.getByRole("button", { name: "Send request" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not send your request.");
  });

  it("starts with the thing a refusal linked here for", async () => {
    setSearchParams(`ask=${encodeURIComponent("deploy:run")}`);
    await draw(payload());
    expect(await screen.findByRole("combobox", { name: "What do you need?" })).toHaveTextContent(
      optionFor("deploy:run")
    );
    expect(screen.getByRole("button", { name: "Send request" })).toBeEnabled();
  });

  it("says the role can already do it, when an old link asks for what it now holds", async () => {
    setSearchParams(`ask=${encodeURIComponent("compare:read")}`);
    await draw(payload());
    expect(await screen.findByText(/Your role \(Viewer\) can already/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send request" })).toBeDisabled();
  });

  it("ignores a link asking for what can't be handed out or does not exist", async () => {
    setSearchParams("ask=roles%3Aupdate");
    await draw(payload());
    expect(await screen.findByRole("button", { name: "Send request" })).toBeDisabled();
    cleanup();

    setSearchParams("ask=nothing%3Areal");
    await draw(payload());
    expect(await screen.findByRole("button", { name: "Send request" })).toBeDisabled();
  });

  it("does not offer an Admin the form, because an Admin already holds everything", async () => {
    setUser("admin");
    await draw(payload({ canAnswer: true }));
    await screen.findByRole("heading", { name: "What people here need" });
    expect(screen.queryByRole("combobox", { name: "What do you need?" })).toBeNull();
  });
});

describe("reading your own requests", () => {
  beforeEach(() => setUser("viewer"));

  it("says when there is nothing yet", async () => {
    await draw(payload());
    expect(await screen.findByText("You have not asked for anything here yet.")).toBeInTheDocument();
  });

  it("lets a waiting one be taken back", async () => {
    await draw(payload({ mine: [ownRequest({ id: 12 })] }));
    fireEvent.click(await screen.findByRole("button", { name: "Withdraw" }));
    await waitFor(() => expect(callsTo(/\/api\/requests\/12$/, "PATCH")).toHaveLength(1));
    expect(saved(/\/api\/requests\/12$/, "PATCH")).toEqual({ action: "withdraw" });
  });

  it("shows who answered, their note, and that a reload brings the new access", async () => {
    await draw(
      payload({
        mine: [
          ownRequest({
            status: "allowed",
            decided_by: "alice@example.com",
            decided_at: LATER,
            decision_note: "Yours until Friday.",
          }),
        ],
      })
    );
    expect(await screen.findByText(/Reload the page you need it on/)).toBeInTheDocument();
    expect(screen.getByText(/Yours until Friday\./)).toBeInTheDocument();
    expect(screen.getByText(/Answered by alice@example\.com/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Withdraw" })).toBeNull();
  });

  it("marks answers given since the last look as new, and only those", async () => {
    await draw(
      payload({
        lastSeenAt: "2026-01-01T12:00:00.000Z",
        counts: { waiting: 0, answered: 1 },
        mine: [
          ownRequest({ id: 1, status: "done", decided_by: "a@example.com", decided_at: LATER }),
          ownRequest({ id: 2, status: "done", decided_by: "a@example.com", decided_at: LONG_AGO }),
        ],
      })
    );
    await screen.findAllByText(/Answered by a@example\.com/);
    expect(screen.getAllByText("New")).toHaveLength(1);
  });

  it("clears the number in the sidebar once there were answers to read", async () => {
    const told = jest.fn();
    window.addEventListener(REQUESTS_CHANGED_EVENT, told);
    await draw(
      payload({
        counts: { waiting: 0, answered: 1 },
        mine: [ownRequest({ status: "done", decided_by: "a@example.com", decided_at: LATER })],
      })
    );
    await waitFor(() => expect(callsTo(/\/api\/requests\/seen$/, "POST")).toHaveLength(1));
    await waitFor(() => expect(told).toHaveBeenCalled());
    window.removeEventListener(REQUESTS_CHANGED_EVENT, told);
  });

  it("does not bother the server when there was nothing new", async () => {
    await draw(payload({ mine: [ownRequest()] }));
    await screen.findByRole("button", { name: "Withdraw" });
    expect(callsTo(/\/api\/requests\/seen$/, "POST")).toHaveLength(0);
  });

  it("calls a run's note a note, as it stays the asker's own unless the approver left one", async () => {
    await draw(
      payload({
        myRuns: [
          aRun({ id: 1, note: "Still waiting." }),
          aRun({ id: 2, status: "used", decided_by: "bob@example.com", decided_at: LATER, note: "Adds isbn." }),
        ],
      })
    );
    expect(await screen.findByText("Note: Adds isbn.")).toBeInTheDocument();
    expect(screen.queryByText(/Their note/)).not.toBeInTheDocument();
    // Whoever is still waiting wrote it a moment ago, and doesn't need it read back.
    expect(screen.queryByText(/Still waiting\./)).not.toBeInTheDocument();
  });

  it("tells the story of a production run someone asked for", async () => {
    await draw(
      payload({
        myRuns: [
          aRun({ id: 1 }),
          aRun({ id: 2, status: "rejected", decided_by: "alice@example.com", decided_at: LATER }),
          aRun({ id: 3, status: "used", decided_by: "bob@example.com", decided_at: LATER }),
          aRun({
            id: 4,
            status: "approved",
            decided_by: "cara@example.com",
            decided_at: LATER,
            expires_at: LONG_AGO,
          }),
          aRun({
            id: 5,
            status: "approved",
            decided_by: "dee@example.com",
            decided_at: LATER,
            expires_at: FUTURE,
          }),
        ],
      })
    );
    expect(await screen.findByText(/Waiting for a second person/)).toBeInTheDocument();
    expect(screen.getByText(/Rejected by alice@example\.com/)).toBeInTheDocument();
    expect(screen.getByText(/Approved by bob@example\.com, and it has been run/)).toBeInTheDocument();
    expect(screen.getByText(/Approved by cara@example\.com, but it was not run in time/)).toBeInTheDocument();
    expect(screen.getByText(/Approved by dee@example\.com\. Ready to run until/)).toBeInTheDocument();
  });
});

describe("answering", () => {
  beforeEach(() => setUser("admin"));

  it("says when nothing is waiting", async () => {
    await draw(payload({ canAnswer: true }));
    expect(await screen.findByText("Nothing is waiting for you")).toBeInTheDocument();
  });

  it("shows what was asked, why, and who is asking", async () => {
    await draw(
      payload({
        canAnswer: true,
        inbox: [inboxRequest({ message: "For the release." })],
      })
    );
    expect(await screen.findByText(permissionLabel("deploy:run"))).toBeInTheDocument();
    expect(screen.getByText("For the release.")).toBeInTheDocument();
    expect(screen.getByText(/Carol Reader \(carol@example\.com\), currently Viewer/)).toBeInTheDocument();
  });

  it("widens the role only after saying how many people it reaches, then answers", async () => {
    await draw(payload({ canAnswer: true, inbox: [inboxRequest({ id: 5 })] }), [
      rolesRoute(["compare:read"], 3),
      { match: "/api/admin/roles", method: "PUT", body: { ok: true } },
    ]);
    fireEvent.click(await screen.findByRole("button", { name: "Allow for everyone who is Viewer" }));

    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("Change the Viewer role?");
    expect(dialog).toHaveTextContent("Everyone who is Viewer (3 people)");
    // Nothing has changed while the question is open.
    expect(callsTo(/\/api\/admin\/roles$/, "PUT")).toHaveLength(0);

    fireEvent.click(within(dialog).getByRole("button", { name: "Allow" }));

    await waitFor(() => expect(callsTo(/\/api\/requests\/5$/, "PATCH")).toHaveLength(1));
    const change = saved(/\/api\/admin\/roles$/, "PUT");
    expect(change.role).toBe("viewer");
    expect(change.permissions).toEqual(expect.arrayContaining(["compare:read", "deploy:run"]));
    expect(saved(/\/api\/requests\/5$/, "PATCH")).toMatchObject({ action: "answer", answer: "allowed" });
  });

  it("changes no role that already holds it, and only marks it", async () => {
    await draw(payload({ canAnswer: true, inbox: [inboxRequest()] }), [rolesRoute(["deploy:run"], 1)]);
    fireEvent.click(await screen.findByRole("button", { name: "Allow for everyone who is Viewer" }));

    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("Viewer can already do this, so nothing changes.");
    fireEvent.click(within(dialog).getByRole("button", { name: "Mark as allowed" }));

    await waitFor(() => expect(callsTo(/\/api\/requests\/5$/, "PATCH")).toHaveLength(1));
    expect(callsTo(/\/api\/admin\/roles$/, "PUT")).toHaveLength(0);
  });

  it("does not answer when changing the role failed", async () => {
    await draw(payload({ canAnswer: true, inbox: [inboxRequest()] }), [
      rolesRoute([], 1),
      { match: "/api/admin/roles", method: "PUT", status: 403, body: { error: "Not that role." } },
    ]);
    fireEvent.click(await screen.findByRole("button", { name: "Allow for everyone who is Viewer" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Allow" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Not that role.");
    expect(callsTo(/\/api\/requests\/5$/, "PATCH")).toHaveLength(0);
  });

  it("gives one person another role instead, then answers", async () => {
    await draw(payload({ canAnswer: true, inbox: [inboxRequest()] }), [
      {
        match: "/api/admin/users",
        method: "GET",
        body: {
          users: [],
          roles: [
            { name: "viewer", label: "Viewer", assignable: true },
            { name: "editor", label: "Editor", assignable: true },
            { name: "admin", label: "Admin", assignable: false },
          ],
        },
      },
      {
        match: "/api/admin/roles",
        method: "GET",
        body: {
          roles: [
            { name: "viewer", label: "Viewer", userCount: 1, permissions: [] },
            { name: "editor", label: "Editor", userCount: 1, permissions: ["deploy:run"] },
            { name: "admin", label: "Admin", userCount: 1, permissions: [] },
          ],
          changes: [],
        },
      },
      { match: "/api/admin/users", method: "PUT", body: { ok: true } },
    ]);
    fireEvent.click(await screen.findByRole("button", { name: "Give Carol Reader another role" }));

    const box = "New role for Carol Reader";
    fireEvent.click(await screen.findByRole("combobox", { name: box }));
    const names = (await screen.findAllByRole("option")).map((option) => option.textContent);
    // Their current role and one this person can't hand out are not choices.
    expect(names).toEqual(["Editor (includes this)"]);
    fireEvent.click(screen.getByRole("option", { name: "Editor (includes this)" }));
    fireEvent.click(screen.getByRole("button", { name: "Change role and allow" }));

    await waitFor(() => expect(callsTo(/\/api\/requests\/5$/, "PATCH")).toHaveLength(1));
    expect(saved(/\/api\/admin\/users$/, "PUT")).toEqual({ userId: 33, role: "editor" });
    expect(saved(/\/api\/requests\/5$/, "PATCH")).toMatchObject({ answer: "allowed" });
  });

  it("doesn't say allowed when the new role lacks what was asked for", async () => {
    await draw(payload({ canAnswer: true, inbox: [inboxRequest()] }), [
      {
        match: "/api/admin/users",
        method: "GET",
        body: { users: [], roles: [{ name: "helper", label: "Helper", assignable: true }] },
      },
      {
        match: "/api/admin/roles",
        method: "GET",
        body: { roles: [{ name: "helper", label: "Helper", userCount: 0, permissions: ["compare:read"] }], changes: [] },
      },
      { match: "/api/admin/users", method: "PUT", body: { ok: true } },
    ]);
    fireEvent.click(await screen.findByRole("button", { name: "Give Carol Reader another role" }));
    fireEvent.click(await screen.findByRole("combobox", { name: "New role for Carol Reader" }));
    fireEvent.click(await screen.findByRole("option", { name: "Helper" }));

    expect(screen.getByText(/^Helper does not include "Apply or revert migrations"/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Change role and allow" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Change role" }));

    await waitFor(() => expect(callsTo(/\/api\/requests\/5$/, "PATCH")).toHaveLength(1));
    expect(saved(/\/api\/admin\/users$/, "PUT")).toEqual({ userId: 33, role: "helper" });
    expect(saved(/\/api\/requests\/5$/, "PATCH")).toMatchObject({ answer: "done" });
  });

  it("doesn't guess when the roles can't be read", async () => {
    await draw(payload({ canAnswer: true, inbox: [inboxRequest()] }), [
      {
        match: "/api/admin/users",
        method: "GET",
        body: { users: [], roles: [{ name: "editor", label: "Editor", assignable: true }] },
      },
      { match: "/api/admin/roles", method: "GET", status: 403, body: { error: "Only admins can." } },
      { match: "/api/admin/users", method: "PUT", body: { ok: true } },
    ]);
    fireEvent.click(await screen.findByRole("button", { name: "Give Carol Reader another role" }));
    fireEvent.click(await screen.findByRole("combobox", { name: "New role for Carol Reader" }));
    fireEvent.click(await screen.findByRole("option", { name: "Editor" }));

    expect(screen.getByText("This also marks the request as done.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Change role" }));

    await waitFor(() => expect(callsTo(/\/api\/requests\/5$/, "PATCH")).toHaveLength(1));
    expect(saved(/\/api\/requests\/5$/, "PATCH")).toMatchObject({ answer: "done" });
  });

  it("marks as done or declines straight away, with the note", async () => {
    await draw(payload({ canAnswer: true, inbox: [inboxRequest()] }));
    fireEvent.change(await screen.findByPlaceholderText("A note to Carol Reader (optional)"), {
      target: { value: "Not this term." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Decline" }));
    await waitFor(() => expect(callsTo(/\/api\/requests\/5$/, "PATCH")).toHaveLength(1));
    expect(saved(/\/api\/requests\/5$/, "PATCH")).toEqual({
      action: "answer",
      answer: "declined",
      note: "Not this term.",
    });
    cleanup();
    fetchCalls.length = 0;

    await draw(payload({ canAnswer: true, inbox: [inboxRequest()] }));
    fireEvent.click(await screen.findByRole("button", { name: "Mark as done" }));
    await waitFor(() => expect(callsTo(/\/api\/requests\/5$/, "PATCH")).toHaveLength(1));
    expect(saved(/\/api\/requests\/5$/, "PATCH")).toMatchObject({ answer: "done" });
  });

  it("says plainly when a role changed but the answer did not save", async () => {
    setRoutes([
      seenRoute(),
      answerRoute(500, { error: "Could not update this request." }),
      rolesRoute([], 1),
      { match: "/api/admin/roles", method: "PUT", body: { ok: true } },
      listRoute(payload({ canAnswer: true, inbox: [inboxRequest()] })),
    ]);
    render(<RequestsPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Allow for everyone who is Viewer" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Allow" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The change was made, but this still shows as waiting. Could not update this request."
    );
  });

  it("reloads when someone else answered first", async () => {
    await draw(payload({ canAnswer: true, inbox: [inboxRequest()] }));
    setRoutes([
      answerRoute(409, { error: "That request has already been answered." }),
      listRoute(payload({ canAnswer: true })),
    ]);
    fireEvent.click(await screen.findByRole("button", { name: "Mark as done" }));
    expect(await screen.findByText("Nothing is waiting for you")).toBeInTheDocument();
  });

  it("says so when the server can't be reached", async () => {
    await draw(payload({ canAnswer: true, inbox: [inboxRequest()] }));
    setRoutes([{ match: /\/api\/requests\/\d+$/, method: "PATCH", networkError: true }]);
    fireEvent.click(await screen.findByRole("button", { name: "Decline" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not reach the server. Try again.");
  });

  it("offers no role change for someone who has left", async () => {
    await draw(
      payload({
        canAnswer: true,
        inbox: [inboxRequest({ member_id: null, member_role: null, member_role_label: null })],
      })
    );
    expect(await screen.findByText(/who has left this organization/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Allow for everyone/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /another role/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Decline" })).toBeEnabled();
  });

  it("offers no role change for something else, which names no permission", async () => {
    await draw(
      payload({ canAnswer: true, inbox: [inboxRequest({ permission: null, message: "A new role." })] })
    );
    expect(await screen.findByText("Something else")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Allow for everyone/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /another role/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Mark as done" })).toBeEnabled();
  });

  it("does not offer to widen the Admin role, which holds everything", async () => {
    await draw(
      payload({
        canAnswer: true,
        inbox: [inboxRequest({ member_role: "admin", member_role_label: "Admin" })],
      })
    );
    await screen.findByRole("button", { name: "Decline" });
    expect(screen.queryByRole("button", { name: /Allow for everyone/ })).toBeNull();
  });

  it("offers each way in only to someone who holds it", async () => {
    setCustomRole("people", "People", ["users:update"]);
    await draw(payload({ canAnswer: true, inbox: [inboxRequest()] }));
    expect(await screen.findByRole("button", { name: "Give Carol Reader another role" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Allow for everyone/ })).toBeNull();
    cleanup();

    // Roles & permissions is for admins alone, so an Admin is the only one who
    // can widen a role, and an Admin holds the Users row as well.
    setUser("admin");
    await draw(payload({ canAnswer: true, inbox: [inboxRequest()] }));
    expect(await screen.findByRole("button", { name: "Allow for everyone who is Viewer" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Give Carol Reader another role" })).toBeInTheDocument();
  });
});

describe("production runs waiting on someone", () => {
  beforeEach(() => setUser("admin"));

  it("links a run to approve to the very target on Deploy", async () => {
    await draw(payload({ canAnswer: true, runsToApprove: [aRun()] }));
    const link = await screen.findByRole("link", { name: "Review it on Deploy" });
    expect(link).toHaveAttribute(
      "href",
      "/test-org/deploy?connection=2&schema=shop&script=add_author&version=1.2.0"
    );
    expect(screen.getByText("Needs approval")).toBeInTheDocument();
    expect(screen.getByText("Run add_author to v1.2.0")).toBeInTheDocument();
    expect(screen.getByText(/Bookshop prod, schema shop/)).toBeInTheDocument();
    expect(screen.getByText(/Asked for by dan@example\.com/)).toBeInTheDocument();
  });

  it("tells whoever can run it that an approved run is ready", async () => {
    await draw(
      payload({
        canAnswer: true,
        runsToRun: [
          aRun({
            status: "approved",
            decided_by: "alice@example.com",
            decided_at: LATER,
            expires_at: FUTURE,
          }),
        ],
      })
    );
    expect(await screen.findByRole("link", { name: "Open it on Deploy" })).toBeInTheDocument();
    expect(screen.getByText("Ready to run")).toBeInTheDocument();
    expect(screen.getByText(/Approved by alice@example\.com\. Good until/)).toBeInTheDocument();
  });

  it("does not pretend a rollback's version is where the database ends up", async () => {
    await draw(payload({ canAnswer: true, runsToApprove: [aRun({ action: "revert" })] }));
    const link = await screen.findByRole("link", { name: "Review it on Deploy" });
    // The version on a rollback is the oldest one undone, so it can't go in a
    // link that would pick it as the version to run to.
    expect(link).toHaveAttribute("href", "/test-org/deploy?connection=2&schema=shop&script=add_author");
    expect(screen.getByText("Roll back add_author, undoing v1.2.0 and newer")).toBeInTheDocument();
    expect(screen.getByText(/use "Roll back to" on this target/)).toBeInTheDocument();
  });

  it("still reads when the connection has gone", async () => {
    await draw(payload({ canAnswer: true, runsToApprove: [aRun({ connection_name: null })] }));
    expect(await screen.findByText(/A connection that has been removed, schema shop/)).toBeInTheDocument();
  });

  it("offers no link to a page the person can't open", async () => {
    setCustomRole("approver", "Approver", ["approvals:approve"]);
    // Holding any action on a feature gives that feature's read, and Deploy's
    // own read is a separate feature, so this person has no way onto the page.
    await draw(payload({ runsToApprove: [aRun()] }));
    await screen.findByText("Needs approval");
    expect(screen.queryByRole("link", { name: "Review it on Deploy" })).toBeNull();
  });
});

describe("the section of things waiting", () => {
  // An Editor holds Deploy: Run, so something may wait for them, but they don't answer requests.
  beforeEach(() => setUser("editor"));

  it("isn't drawn empty above the form for someone who doesn't answer requests", async () => {
    await draw(payload());
    await screen.findByRole("combobox", { name: "What do you need?" });
    expect(screen.queryByText("Waiting for you")).not.toBeInTheDocument();
    expect(screen.queryByText("Nothing is waiting for you")).not.toBeInTheDocument();
  });

  it("is drawn for them once a run is ready", async () => {
    await draw(payload({ runsToRun: [aRun({ status: "approved", decided_by: "alice@example.com", decided_at: LATER })] }));
    expect(await screen.findByText("Waiting for you")).toBeInTheDocument();
    expect(screen.getByText("Ready to run")).toBeInTheDocument();
    expect(screen.queryByText("Nothing is waiting for you")).not.toBeInTheDocument();
  });
});

describe("when the list can't be read", () => {
  it("says so", async () => {
    setUser("viewer");
    setRoutes([{ match: /\/api\/requests$/, method: "GET", status: 500, body: { error: "Could not load requests." } }]);
    render(<RequestsPage />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load requests.");
  });

  it("says so when the server can't be reached", async () => {
    setUser("viewer");
    setRoutes([{ match: /\/api\/requests$/, method: "GET", networkError: true }]);
    render(<RequestsPage />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load requests.");
  });
});
