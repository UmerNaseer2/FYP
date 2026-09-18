/** @jest-environment jsdom */

/**
 * Version Sync's replay check, on the production approval it shows there.
 *
 * The panel is the last thing a reader looks at before pressing Replay on a
 * live database, and it used to be able to say "Approved by a second person"
 * off the back of an answer that was not about this target at all. The server
 * would still have refused the run — its own claim is scoped by connection and
 * schema — so what the defect cost was the truth of the screen: you were told
 * to press the button and then turned down.
 *
 * Driving it needs the whole page, because the panel lives inside the replay
 * dialog and the dialog only opens once both ledgers are picked and read; the
 * approvals are only read at all when the Target is production.
 */

import "@testing-library/jest-dom";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

jest.mock("next-auth/react", () => require("./helpers/render-page").sessionStubs);

import VersionSyncPage from "@/app/(studio)/versionsync/page";
import { sha256Hex, type ApprovalRow } from "@/components/studio/ApprovalPanel";
import { fingerprintBody } from "@/lib/approval-fingerprint";
import { type FetchRoute, holdNext, resetPageState, setRoutes } from "./helpers/render-page";

const CONNECTIONS = [
  {
    id: 1,
    name: "Staging",
    host: "staging.internal",
    database_name: "shop",
    environment: "staging",
  },
  {
    id: 2,
    name: "Live",
    host: "live.internal",
    database_name: "shop",
    environment: "prod",
  },
];

const ADD_NOTE = "ALTER TABLE orders ADD COLUMN note text;";

/** One applied-script row, as /api/versionsync/ledger returns it. */
function entry(version: string, appliedAt: string) {
  return {
    scriptName: "app_core",
    version,
    changeType: "additive",
    appliedAt,
    hasSql: true,
    sqlContent: ADD_NOTE,
    downSql: null,
    appliedBy: null,
  };
}

// Staging is one version ahead of Live, and that version is additive, so the
// replay check opens with no breaking or data-loss gate in the way — the
// approval is the only thing between the reader and the Replay button.
const SOURCE_LEDGER = [entry("1.0.0", "2026-01-01T00:00:00Z"), entry("2.0.0", "2026-02-01T00:00:00Z")];
const TARGET_LEDGER = [entry("1.0.0", "2026-01-01T00:00:00Z")];

/**
 * The hash the panel matches an approval against.
 *
 * Worked out here with the same two functions the screen uses, because that
 * spelling IS the contract: the route hashes the scripts it was sent and
 * stores the result, and the dialog hashes the run in front of the reader and
 * compares. A row carrying any other value would simply never match, and the
 * test would pass while showing an unapproved panel for the wrong reason.
 */
async function runFingerprint() {
  return sha256Hex(
    fingerprintBody([{ scriptName: "app_core", version: "2.0.0", sqlContent: ADD_NOTE }])
  );
}

function approval(runHash: string, over: Partial<ApprovalRow> = {}): ApprovalRow {
  return {
    id: 7,
    target_version: "2.0.0",
    run_fingerprint: runHash,
    migration_count: 1,
    breaking_count: 0,
    requested_by: "someone.else@example.com",
    requested_at: "2026-02-02T00:00:00Z",
    status: "approved",
    decided_by: "reviewer@example.com",
    decided_at: "2026-02-02T01:00:00Z",
    self_approved: false,
    note: null,
    used_at: null,
    action: "deploy",
    expires_at: null,
    ...over,
  };
}

/**
 * Everything the page reads before the replay dialog can open.
 *
 * The ledger and the schema lookup are answered per connection, since the
 * whole point of the screen is that the two sides are different databases —
 * one answer for both would make Source and Target indistinguishable and no
 * test here could tell which one a reply belonged to.
 */
function baseRoutes(): FetchRoute[] {
  return [
    { match: "/api/connections", body: CONNECTIONS },
    { match: "/api/scripts/schemas", body: { schemas: ["public"] } },
    {
      match: "/api/versionsync/ledger",
      body: (url: string) =>
        url.includes("connectionId=1") ? { entries: SOURCE_LEDGER } : { entries: TARGET_LEDGER },
    },
    {
      match: "/api/lineage/lookup",
      body: (url: string) =>
        url.includes("connectionId=2")
          ? { tracked: true, environment: "prod", driftStatus: "in_sync" }
          : { tracked: true, environment: "staging", driftStatus: "in_sync" },
    },
  ];
}

/** The reviewer's decision lands; it is the re-read afterwards that is at stake. */
const DECIDE: FetchRoute = {
  match: /\/api\/deploy\/approvals\/\d+$/,
  method: "POST",
  body: { approval: { id: 7, status: "rejected" } },
};

/** Pick one of the four dropdowns by its label. */
function pick(box: string, option: string | RegExp) {
  fireEvent.click(screen.getByRole("combobox", { name: box }));
  fireEvent.click(screen.getByRole("option", { name: option }));
}

/** Pick Staging → Live, then open the replay check for the one missing version. */
async function openReplayCheck() {
  render(<VersionSyncPage />);
  await waitFor(() =>
    expect(screen.getByRole("combobox", { name: "Source connection" })).toBeEnabled()
  );

  pick("Source connection", /Staging/);
  await waitFor(() => expect(screen.getByRole("combobox", { name: "Source schema" })).toBeEnabled());
  pick("Source schema", "public");

  pick("Target connection", /Live/);
  await waitFor(() => expect(screen.getByRole("combobox", { name: "Target schema" })).toBeEnabled());
  pick("Target schema", "public");

  fireEvent.click(await screen.findByRole("button", { name: /^Run v2\.0\.0/ }));
}

beforeEach(() => resetPageState());
afterEach(() => cleanup());

/**
 * What is NOT below, and why.
 *
 * The fix stores the approvals against the `connectionId schema` they were
 * read for and ignores an answer whose key no longer matches. Nothing here
 * exercises that comparison, because the target cannot change while the panel
 * is on screen: the panel lives in the replay dialog, the dialog is a modal
 * whose backdrop closes it on the first click outside, and the body is mounted
 * fresh each time it opens — so no reply can arrive for a target this panel is
 * no longer showing. Driving it anyway would mean clicking a dropdown the
 * backdrop covers, which is a test of something no reader can do.
 *
 * The key comparison is therefore a guard against a change to the page above
 * it, not against anything reachable today, and it is the SECOND half of the
 * fix that carries the defect: rows emptied when a read fails, and a loading
 * state that covers a re-read of the same target. Both are below, and both
 * fail when their half is undone.
 */
describe("the replay check's production approval", () => {
  it("reads the approval that covers this exact run", async () => {
    const hash = await runFingerprint();
    setRoutes([
      ...baseRoutes(),
      { match: /\/api\/deploy\/approvals\?/, method: "GET", body: { approvals: [approval(hash)] } },
    ]);

    await openReplayCheck();

    expect(await screen.findByText("Approved by a second person")).toBeInTheDocument();
    expect(screen.getByText(/reviewer@example.com/)).toBeInTheDocument();
  });

  it("says the approval state is unknown when the list cannot be read", async () => {
    setRoutes([
      ...baseRoutes(),
      {
        match: /\/api\/deploy\/approvals\?/,
        method: "GET",
        status: 500,
        body: { error: "The approvals table is unreachable." },
      },
    ]);

    await openReplayCheck();

    // Not the same as "there are none": an empty list would read as "Needs a
    // second person", which claims the gate was checked.
    expect(await screen.findByText("Approval state unknown")).toBeInTheDocument();
    expect(screen.getByText("The approvals table is unreachable.")).toBeInTheDocument();
  });

  it("stops repeating an old answer once a re-read of the approvals fails", async () => {
    const hash = await runFingerprint();
    const readRoute = (route: FetchRoute): FetchRoute[] => [...baseRoutes(), route, DECIDE];
    setRoutes(
      readRoute({
        match: /\/api\/deploy\/approvals\?/,
        method: "GET",
        body: { approvals: [approval(hash, { status: "pending", decided_by: null, decided_at: null })] },
      })
    );

    await openReplayCheck();
    expect(await screen.findByText("Waiting for a second person")).toBeInTheDocument();

    // The approvals go out of reach between the decision and the re-read that
    // follows it — the one moment where a stale list is guaranteed to exist.
    setRoutes(
      readRoute({
        match: /\/api\/deploy\/approvals\?/,
        method: "GET",
        status: 500,
        body: { error: "The approvals table went away." },
      })
    );
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));

    // The defect: the rows were kept when the read that should have replaced
    // them failed, and `unreadable` asks for an empty list — so the panel went
    // on answering from the last list it managed to read. Here that reads as
    // "still waiting"; with an approved row it read as "Approved by a second
    // person", and the reader was sent to press Replay on a production
    // database off the back of an answer nothing had confirmed.
    expect(await screen.findByText("Approval state unknown")).toBeInTheDocument();
    expect(screen.queryByText("Waiting for a second person")).not.toBeInTheDocument();
  });

  it("does not keep answering from the old list while it is being re-read", async () => {
    const hash = await runFingerprint();
    // What the table would say, as the decision changes it underneath.
    let row = approval(hash, { status: "pending", decided_by: null, decided_at: null });
    setRoutes([
      ...baseRoutes(),
      { match: /\/api\/deploy\/approvals\?/, method: "GET", body: () => ({ approvals: [row] }) },
      DECIDE,
    ]);

    await openReplayCheck();
    await screen.findByText("Waiting for a second person");

    // The decision lands, and the re-read that follows it is held — so the
    // moment between "decided" and "read back" is one the test can look at
    // rather than one that passes too quickly to assert on.
    row = approval(hash);
    const releaseReread = holdNext("/api/deploy/approvals", "GET");
    fireEvent.click(screen.getByRole("button", { name: "Approve this run" }));

    // Until that answer comes back the panel has nothing current to say, and
    // the list it is holding is the one the decision has just invalidated.
    // Repeating it would show the reader a request still waiting for them
    // moments after they cleared it themselves.
    expect(await screen.findByText("Reading the approvals for this target…")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Approve this run" })).not.toBeInTheDocument();

    releaseReread();
    expect(await screen.findByText("Approved by a second person")).toBeInTheDocument();
  });
});
