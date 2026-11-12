/**
 * @jest-environment jsdom
 */
// The phone app, drawn the way the page draws it. Its data comes from routes
// the full site already uses, so these look at what is new: which tabs someone
// gets, what is kept off a phone's screen, and the two steps before a decision.
import "@testing-library/jest-dom";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { REQUESTS_CHANGED_EVENT, type InboxRequest, type RequestsPayload } from "@/lib/access-requests";
import type { ListedApproval } from "@/lib/approvals-db";
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

import PhonePage from "@/app/[org]/phone/page";

const WHEN = "2026-01-01T09:00:00.000Z";
const FAKE_HOST = "db.private.example.test";
const STORED_ERROR = `could not connect to ${FAKE_HOST}:5432`;
const UNREACHABLE_TEXT = "The last check could not reach this database.";

function payload(over: Partial<RequestsPayload> = {}): RequestsPayload {
  return {
    mine: [],
    inbox: [],
    lent: [],
    runsToApprove: [],
    runsToRun: [],
    myRuns: [],
    canAnswer: false,
    lastSeenAt: null,
    counts: { waiting: 0, answered: 0 },
    ...over,
  };
}

function run(over: Partial<ListedApproval> = {}): ListedApproval {
  return {
    id: 5,
    connection_id: 2,
    connection_name: "Production",
    schema_name: "public",
    script_name: "add-orders",
    target_version: "1.2.0",
    run_fingerprint: "print-1",
    migration_count: 1,
    breaking_count: 0,
    requested_by: "asker@example.com",
    requested_at: WHEN,
    status: "pending",
    decided_by: null,
    decided_at: null,
    self_approved: false,
    note: null,
    used_at: null,
    action: "run",
    expires_at: null,
    ...over,
  } as ListedApproval;
}

function inboxRequest(over: Partial<InboxRequest> = {}): InboxRequest {
  return {
    id: 9,
    requested_by: "asker@example.com",
    requested_by_name: "Asker",
    permission: "deploy:run",
    message: "Please",
    status: "pending",
    decided_by: null,
    decided_at: null,
    decision_note: null,
    created_at: WHEN,
    member_id: 3,
    member_role: "viewer",
    member_role_label: "Viewer",
    ...over,
  } as InboxRequest;
}

function schema(id: number, name: string, status: string | null, summary: string | null = null) {
  return {
    id,
    connectionId: 2,
    schemaName: name,
    label: null,
    environment: "prod",
    createdAt: WHEN,
    connectionName: `Connection ${id}`,
    connectionHost: FAKE_HOST,
    connectionDatabase: "shop",
    headVersion: "1.0.0",
    headSeq: 1,
    migrationCount: 1,
    driftStatus: status,
    driftSummary: summary,
    driftCheckedAt: status ? WHEN : null,
    driftAcknowledgedAt: null,
    interval: 15,
  };
}

function event(id: number, status: string, summary: string) {
  return {
    id,
    trackedSchemaId: 1,
    schemaName: "orders",
    connectionName: "Production",
    status,
    summary,
    detail: null,
    detectedAt: WHEN,
    acknowledgedAt: null,
    source: "scheduled",
  };
}

const COUNTS_ROUTE: FetchRoute = { match: "only=counts", body: { counts: { waiting: 0, answered: 0 } } };

function usual(extra: FetchRoute[] = [], over: Partial<RequestsPayload> = {}): FetchRoute[] {
  return [
    ...extra,
    COUNTS_ROUTE,
    { match: /\/api\/requests$/, body: payload(over) },
    { match: /\/api\/lineage$/, body: [] },
    { match: "/api/lineage/audit", body: [] },
  ];
}

/** What the app sent with its first call of this kind, read back from the JSON. */
function sentBody(method: string): unknown {
  const body = fetchCalls.find((call) => call.method === method)?.body;
  return typeof body === "string" ? JSON.parse(body) : body;
}

function bar() {
  return within(screen.getByRole("navigation", { name: "Phone app" }));
}

beforeEach(() => {
  resetPageState();
  setUser("admin");
});

afterEach(cleanup);

describe("which tabs someone gets", () => {
  test("someone who can read drift starts on Drift, and has all five", async () => {
    setRoutes(usual());
    render(<PhonePage />);
    await screen.findByRole("navigation", { name: "Phone app" });
    for (const name of ["Drift", "History", "Approvals", "Compare", "Alerts"]) {
      expect(bar().getByRole("button", { name })).toBeInTheDocument();
    }
    expect(bar().getByRole("button", { name: "Drift" })).toHaveAttribute("aria-current", "page");
  });

  test("someone who cannot read drift gets Approvals and Alerts, and starts on Approvals", async () => {
    setCustomRole("clerk", "Clerk", []);
    setRoutes(usual());
    render(<PhonePage />);
    await screen.findByRole("navigation", { name: "Phone app" });
    expect(bar().queryByRole("button", { name: "Drift" })).not.toBeInTheDocument();
    expect(bar().queryByRole("button", { name: "History" })).not.toBeInTheDocument();
    expect(bar().getByRole("button", { name: "Approvals" })).toHaveAttribute("aria-current", "page");
    expect(fetchCalls.some((call) => call.url.includes("/api/lineage"))).toBe(false);
  });

  test("an alert's link opens the tab it names", async () => {
    setSearchParams("tab=approvals");
    setRoutes(usual());
    render(<PhonePage />);
    await screen.findByText("Nothing waiting");
    expect(bar().getByRole("button", { name: "Approvals" })).toHaveAttribute("aria-current", "page");
  });

  test("a link to a tab this person cannot open falls back to their first", async () => {
    setCustomRole("clerk", "Clerk", []);
    setSearchParams("tab=history");
    setRoutes(usual());
    render(<PhonePage />);
    await screen.findByText("Nothing waiting");
    expect(bar().getByRole("button", { name: "Approvals" })).toHaveAttribute("aria-current", "page");
  });

  test("a waiting count shows on the Approvals tab", async () => {
    setRoutes([
      { match: "only=counts", body: { counts: { waiting: 3, answered: 0 } } },
      ...usual(),
    ]);
    render(<PhonePage />);
    expect(await screen.findByLabelText("3 waiting")).toBeInTheDocument();
  });
});

describe("the Drift tab", () => {
  test("lists what needs someone first, and never a host", async () => {
    setRoutes(
      usual([
        {
          match: /\/api\/lineage$/,
          body: [
            schema(1, "fine", "in_sync", "All in sync"),
            schema(2, "new", null),
            schema(3, "gone", "unreachable", STORED_ERROR),
            schema(4, "moved", "drifted", "2 tables changed"),
          ],
        },
      ])
    );
    const { container } = render(<PhonePage />);
    await screen.findByText("moved");

    const names = ["moved", "gone", "new", "fine"].map((name) =>
      screen.getByText(name).compareDocumentPosition(screen.getByText("fine"))
    );
    // Each name is followed by "fine", apart from "fine" itself.
    expect(names.slice(0, 3).every((position) => position & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
    expect(
      screen.getByText("moved").compareDocumentPosition(screen.getByText("gone")) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();

    expect(screen.getByText("2 tables changed")).toBeInTheDocument();
    expect(screen.getByText(UNREACHABLE_TEXT)).toBeInTheDocument();
    expect(container.textContent).not.toContain(FAKE_HOST);
  });

  test("opening a schema reads it, and a failed check keeps the host off the screen", async () => {
    setRoutes(
      usual([
        { match: /\/api\/lineage$/, body: [schema(4, "moved", "drifted", "2 tables changed")] },
        {
          match: "/api/lineage/drift?trackedSchemaId=4",
          body: {
            trackedSchemaId: 4,
            schemaName: "moved",
            label: null,
            environment: "prod",
            connection: { host: FAKE_HOST },
            expected: { version: "1.0.0", seq: 1, snapshotId: 1 },
            state: "unreachable",
            summary: STORED_ERROR,
            counts: null,
            report: null,
            driftIntervalMinutes: 15,
            lastRecorded: null,
          },
        },
      ])
    );
    const { container } = render(<PhonePage />);
    fireEvent.click(await screen.findByRole("button", { name: /moved/ }));
    expect(await screen.findByText(UNREACHABLE_TEXT)).toBeInTheDocument();
    expect(container.textContent).not.toContain(FAKE_HOST);
    expect(screen.getByRole("link", { name: "See the changes" })).toHaveAttribute(
      "href",
      "/test-org/drift?schema=4"
    );
  });

  test("Acknowledge takes two taps, and the list reads again afterwards", async () => {
    setRoutes(
      usual([
        { match: /\/api\/lineage$/, body: [schema(4, "moved", "drifted", "2 tables changed")] },
        { match: "/api/lineage/acknowledge", method: "POST", body: { success: true } },
        {
          match: "/api/lineage/drift?trackedSchemaId=4",
          body: {
            trackedSchemaId: 4,
            schemaName: "moved",
            label: null,
            environment: "prod",
            connection: null,
            expected: { version: "1.0.0", seq: 1, snapshotId: 1 },
            state: "drifted",
            summary: "2 tables changed",
            counts: { tablesAdded: 1, tablesRemoved: 0, tablesChanged: 1, constraintsChanged: 0 },
            report: null,
            driftIntervalMinutes: 15,
            lastRecorded: { status: "drifted", detectedAt: WHEN, acknowledgedAt: null },
          },
        },
      ])
    );
    render(<PhonePage />);
    fireEvent.click(await screen.findByRole("button", { name: /moved/ }));
    expect(await screen.findByText("1 table added")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Acknowledge" }));
    expect(fetchCalls.some((call) => call.url.includes("acknowledge"))).toBe(false);
    const listReads = fetchCalls.filter((call) => /\/api\/lineage$/.test(call.url)).length;

    fireEvent.click(screen.getByRole("button", { name: "Acknowledge this drift" }));
    await waitFor(() => {
      expect(sentBody("POST")).toEqual({ trackedSchemaId: 4 });
    });
    await waitFor(() =>
      expect(fetchCalls.filter((call) => /\/api\/lineage$/.test(call.url)).length).toBeGreaterThan(listReads)
    );
  });

  test("someone who can only read gets neither button", async () => {
    setCustomRole("reader", "Reader", ["drift:read"]);
    setRoutes(
      usual([
        { match: /\/api\/lineage$/, body: [schema(4, "moved", "drifted", "2 tables changed")] },
        {
          match: "/api/lineage/drift?trackedSchemaId=4",
          body: {
            trackedSchemaId: 4,
            schemaName: "moved",
            label: null,
            environment: "prod",
            connection: null,
            expected: { version: "1.0.0", seq: 1, snapshotId: 1 },
            state: "drifted",
            summary: "2 tables changed",
            counts: null,
            report: null,
            driftIntervalMinutes: 0,
            lastRecorded: null,
          },
        },
      ])
    );
    render(<PhonePage />);
    fireEvent.click(await screen.findByRole("button", { name: /moved/ }));
    await screen.findByText(/Checked only by hand/);
    expect(screen.queryByRole("button", { name: "Check now" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Acknowledge" })).not.toBeInTheDocument();
  });

  test("a server failure's own text is not shown, and a refusal's is", async () => {
    setRoutes(
      usual([{ match: /\/api\/lineage$/, status: 500, body: { error: STORED_ERROR } }])
    );
    const { container, unmount } = render(<PhonePage />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not read the tracked schemas.");
    expect(container.textContent).not.toContain(FAKE_HOST);
    unmount();

    setRoutes(
      usual([{ match: /\/api\/lineage$/, status: 403, body: { error: "Ask an admin for this." } }])
    );
    render(<PhonePage />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Ask an admin for this.");
  });

  test("an ended sign-in says what to do", async () => {
    setRoutes(usual([{ match: /\/api\/lineage$/, status: 401, body: { error: "nope" } }]));
    render(<PhonePage />);
    expect(await screen.findByRole("alert")).toHaveTextContent(/Your sign-in has ended/);
  });

  test("coming back to the app reads the list again, and a failed read keeps what was there", async () => {
    setRoutes(usual([{ match: /\/api\/lineage$/, body: [schema(4, "moved", "drifted", "Two")] }]));
    render(<PhonePage />);
    await screen.findByText("moved");

    setRoutes(usual([{ match: /\/api\/lineage$/, status: 500, body: {} }]));
    document.dispatchEvent(new Event("visibilitychange"));
    await screen.findByRole("alert");
    expect(screen.getByText("moved")).toBeInTheDocument();
  });
});

describe("the History tab", () => {
  test("lists checks, and an unreachable one says the fixed sentence", async () => {
    setRoutes(
      usual([
        {
          match: "/api/lineage/audit?limit=50",
          body: [event(1, "drifted", "2 tables changed"), event(2, "unreachable", STORED_ERROR)],
        },
      ])
    );
    const { container } = render(<PhonePage />);
    fireEvent.click(await screen.findByRole("button", { name: "History" }));
    expect(await screen.findByText("2 tables changed")).toBeInTheDocument();
    expect(screen.getByText(UNREACHABLE_TEXT)).toBeInTheDocument();
    expect(container.textContent).not.toContain(FAKE_HOST);
  });

  test("says so when nothing has been recorded", async () => {
    setRoutes(usual());
    render(<PhonePage />);
    fireEvent.click(await screen.findByRole("button", { name: "History" }));
    expect(await screen.findByText("No checks recorded yet")).toBeInTheDocument();
  });
});

describe("the Approvals tab", () => {
  function open(routes: FetchRoute[], over: Partial<RequestsPayload>) {
    setSearchParams("tab=approvals");
    setRoutes(usual(routes, over));
    return render(<PhonePage />);
  }

  const KEPT = {
    id: 5,
    action: "run",
    fingerprint: "print-1",
    scripts: [{ scriptName: "add-orders", version: "1.2.0", sqlContent: "ALTER TABLE orders ADD note text;" }],
  };

  describe("the number on the tab", () => {
    const changed = jest.fn();
    const seenCalls = () => fetchCalls.filter((call) => call.url.includes("/api/requests/seen"));

    beforeEach(() => {
      changed.mockClear();
      window.addEventListener(REQUESTS_CHANGED_EVENT, changed);
    });
    afterEach(() => window.removeEventListener(REQUESTS_CHANGED_EVENT, changed));

    test("answers on screen stop counting as unread, then it is read again", async () => {
      open([{ match: "/api/requests/seen", method: "POST", body: { ok: true } }], {
        counts: { waiting: 0, answered: 2 },
      });
      await waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
      expect(seenCalls()).toHaveLength(1);
    });

    test("with nothing unread it is only read again, so Refresh keeps it right", async () => {
      open([], { runsToApprove: [run()], counts: { waiting: 1, answered: 0 } });
      await waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
      expect(seenCalls()).toHaveLength(0);
      // Another run arrives while the app is open.
      setRoutes(usual([], { runsToApprove: [run(), run({ id: 6 })], counts: { waiting: 2, answered: 0 } }));
      fireEvent.click(await screen.findByRole("button", { name: "Refresh" }));
      await waitFor(() => expect(changed).toHaveBeenCalledTimes(2));
    });

    test("a failed save still reads it again", async () => {
      open([{ match: "/api/requests/seen", method: "POST", status: 500, body: {} }], {
        counts: { waiting: 0, answered: 1 },
      });
      await waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
    });
  });

  test("the first tap on Approve shows the SQL and decides nothing", async () => {
    open([{ match: "/api/deploy/approvals/5/phone", body: KEPT }], { runsToApprove: [run()] });
    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
    expect(await screen.findByText(/ALTER TABLE orders/)).toBeInTheDocument();
    expect(fetchCalls.some((call) => call.method === "POST")).toBe(false);
  });

  test("the second tap sends the decision with the fingerprint it was drawn from", async () => {
    const changed = jest.fn();
    window.addEventListener(REQUESTS_CHANGED_EVENT, changed);
    open(
      [
        { match: "/api/deploy/approvals/5/phone", body: KEPT },
        { match: "/api/deploy/approvals/5", method: "POST", body: { ok: true } },
      ],
      { runsToApprove: [run()] }
    );
    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
    await screen.findByText(/ALTER TABLE orders/);
    fireEvent.change(screen.getByLabelText(/Note/), { target: { value: " Looks right " } });
    fireEvent.click(screen.getByRole("button", { name: "Approve this run" }));

    await waitFor(() => {
      const sent = sentBody("POST");
      expect(sent).toEqual({
        decision: "approve",
        note: "Looks right",
        expectedFingerprint: "print-1",
      });
    });
    await waitFor(() => expect(changed).toHaveBeenCalled());
    window.removeEventListener(REQUESTS_CHANGED_EVENT, changed);
  });

  test("Reject does not need the SQL", async () => {
    open([{ match: "/api/deploy/approvals/5", method: "POST", body: { ok: true } }], {
      runsToApprove: [run()],
    });
    fireEvent.click(await screen.findByRole("button", { name: "Reject" }));
    fireEvent.click(screen.getByRole("button", { name: "Reject this run" }));
    await waitFor(() => {
      expect(sentBody("POST")).toMatchObject({ decision: "reject", expectedFingerprint: "print-1" });
    });
    expect(fetchCalls.some((call) => call.url.endsWith("/phone"))).toBe(false);
  });

  test("SQL with characters that do not show is marked, and can be rejected but not approved", async () => {
    const hiding = { ...KEPT, scripts: [{ ...KEPT.scripts[0], sqlContent: "-- adds an index\rDROP TABLE accounts;" }] };
    open(
      [
        { match: "/api/deploy/approvals/5/phone", body: hiding },
        { match: "/api/deploy/approvals/5", method: "POST", body: { ok: true } },
      ],
      { runsToApprove: [run()] }
    );
    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
    expect(await screen.findByText(/adds an index\u{240D}/u)).toBeInTheDocument();
    expect(screen.getByText(/cannot be approved here/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Approve this run" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    fireEvent.click(screen.getByRole("button", { name: "Reject this run" }));
    await waitFor(() => {
      expect(sentBody("POST")).toMatchObject({ decision: "reject", expectedFingerprint: "print-1" });
    });
  });

  test("Cancel backs out without sending anything", async () => {
    open([], { runsToApprove: [run()] });
    fireEvent.click(await screen.findByRole("button", { name: "Reject" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("button", { name: "Reject" })).toBeInTheDocument();
    expect(fetchCalls.some((call) => call.method === "POST")).toBe(false);
  });

  test("SQL read for an older version goes away when the list brings a newer one", async () => {
    open([{ match: "/api/deploy/approvals/5/phone", body: KEPT }], { runsToApprove: [run()] });
    fireEvent.click(await screen.findByRole("button", { name: "Read SQL" }));
    await screen.findByText(/ALTER TABLE orders/);

    setRoutes(
      usual(
        [{ match: "/api/deploy/approvals/5/phone", body: KEPT }],
        { runsToApprove: [run({ run_fingerprint: "print-2" })] }
      )
    );
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(screen.queryByText(/ALTER TABLE orders/)).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Read SQL" })).toBeInTheDocument();
  });

  test("a request that changed after it was listed says so", async () => {
    open([{ match: "/api/deploy/approvals/5/phone", body: { ...KEPT, fingerprint: "print-2" } }], {
      runsToApprove: [run()],
    });
    fireEvent.click(await screen.findByRole("button", { name: "Read SQL" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/has changed/);
    expect(screen.queryByText(/ALTER TABLE orders/)).not.toBeInTheDocument();
  });

  test("when no copy of the SQL was kept it says where to read it", async () => {
    open([{ match: "/api/deploy/approvals/5/phone", body: { ...KEPT, scripts: null } }], {
      runsToApprove: [run()],
    });
    fireEvent.click(await screen.findByRole("button", { name: "Read SQL" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/No copy of this SQL was kept/);
  });

  test("the server's refusal of a decision is shown as it wrote it", async () => {
    open(
      [
        { match: "/api/deploy/approvals/5/phone", body: KEPT },
        {
          match: "/api/deploy/approvals/5",
          method: "POST",
          status: 403,
          body: { error: "A second person has to approve this." },
        },
      ],
      { runsToApprove: [run()] }
    );
    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
    await screen.findByText(/ALTER TABLE orders/);
    fireEvent.click(screen.getByRole("button", { name: "Approve this run" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("A second person has to approve this.");
  });

  test("a rollback reads as a rollback, with its breaking count", async () => {
    open([], { runsToApprove: [run({ action: "revert", breaking_count: 2 } as Partial<ListedApproval>)] });
    expect(await screen.findByText(/Roll back add-orders/)).toBeInTheDocument();
    expect(screen.getByText("2 breaking")).toBeInTheDocument();
  });

  test("an access request can be declined here, and allowing goes to the full site", async () => {
    open([{ match: "/api/requests/9", method: "PATCH", body: { ok: true } }], {
      inbox: [inboxRequest()],
      canAnswer: true,
    });
    expect(await screen.findByRole("link", { name: "Allow on the full site" })).toHaveAttribute(
      "href",
      "/test-org/requests"
    );
    expect(screen.queryByRole("button", { name: /^Allow/ })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Decline" }));
    fireEvent.click(screen.getByRole("button", { name: "Decline this request" }));
    await waitFor(() => {
      expect(sentBody("PATCH")).toEqual({ action: "answer", answer: "declined", note: "" });
    });
  });

  test("runs ready to run are only a link, for someone who can open Deploy", async () => {
    open([], { runsToRun: [run({ status: "approved", decided_by: "other@example.com" } as Partial<ListedApproval>)] });
    expect(await screen.findByText("Ready to run")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Run/ })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open it on Deploy" }).getAttribute("href")).toMatch(
      /^\/test-org\/deploy\?/
    );
  });

  test("what you asked for reads the same as on the Requests page", async () => {
    open([], { myRuns: [run({ status: "rejected", decided_by: "other@example.com" } as Partial<ListedApproval>)] });
    expect(await screen.findByText("Rejected by other@example.com.")).toBeInTheDocument();
  });
});

describe("the Alerts tab", () => {
  test("a browser without push says so and offers no button", async () => {
    setSearchParams("tab=alerts");
    setRoutes(usual());
    render(<PhonePage />);
    expect(await screen.findByText(/This browser cannot show alerts/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Turn on" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open the full site" })).toHaveAttribute(
      "href",
      "/test-org/studio"
    );
  });
});
