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
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";

jest.mock("next-auth/react", () => require("./helpers/render-page").sessionStubs);

import VersionSyncPage from "@/app/[org]/(studio)/versionsync/page";
import { OrgProvider } from "@/components/OrgProvider";
import { sha256Hex, type ApprovalRow } from "@/components/studio/ApprovalPanel";
import { REQUESTS_CHANGED_EVENT } from "@/lib/access-requests";
import { fingerprintBody } from "@/lib/approval-fingerprint";
import { HELP_TOPICS } from "@/lib/help";
import {
  type FetchRoute,
  fetchCalls,
  holdNext,
  render,
  resetPageState,
  setCustomRole,
  setRoutes,
  setUser,
} from "./helpers/render-page";

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

/**
 * Pick Staging → Live, which puts the one version Live is missing on screen,
 * in an organization with the two-person rule switched on (it is off by
 * default), since most of what is below is about production approvals.
 */
async function pickStagingToLive() {
  render(
    <OrgProvider slug="test-org" name="Test Org" twoPersonRule>
      <VersionSyncPage />
    </OrgProvider>
  );
  await waitFor(() =>
    expect(screen.getByRole("combobox", { name: "Source connection" })).toBeEnabled()
  );

  pick("Source connection", /Staging/);
  await waitFor(() => expect(screen.getByRole("combobox", { name: "Source schema" })).toBeEnabled());
  pick("Source schema", "public");

  pick("Target connection", /Live/);
  await waitFor(() => expect(screen.getByRole("combobox", { name: "Target schema" })).toBeEnabled());
  pick("Target schema", "public");
}

/** Pick Staging → Live, then open the replay check for the one missing version. */
async function openReplayCheck() {
  await pickStagingToLive();
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
describe("the page header", () => {
  it("shows the page's name and the one line from its help file", async () => {
    setRoutes(baseRoutes());
    render(<VersionSyncPage />);

    expect(await screen.findByRole("heading", { level: 1, name: "Version Sync" })).toBeInTheDocument();
    expect(screen.getByText(HELP_TOPICS["/versionsync"].blurb)).toBeInTheDocument();
  });

  it("says what a Run button does in the note beside the list, for a role that may replay", async () => {
    setRoutes(baseRoutes());
    await pickStagingToLive();

    fireEvent.click(await screen.findByRole("button", { name: "Help: Missing on the Target" }));
    expect(screen.getByRole("note")).toHaveTextContent(/The Run button replays the first version/);
  });
});

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

describe("the number beside Requests on the rail", () => {
  const heard = jest.fn();
  beforeEach(() => {
    heard.mockClear();
    window.addEventListener(REQUESTS_CHANGED_EVENT, heard);
  });
  afterEach(() => window.removeEventListener(REQUESTS_CHANGED_EVENT, heard));

  it("is told when a decision is made here", async () => {
    const hash = await runFingerprint();
    let row = approval(hash, { status: "pending", decided_by: null, decided_at: null });
    setRoutes([
      ...baseRoutes(),
      { match: /\/api\/deploy\/approvals\?/, method: "GET", body: () => ({ approvals: [row] }) },
      DECIDE,
    ]);
    await openReplayCheck();
    await screen.findByText("Waiting for a second person");
    expect(heard).not.toHaveBeenCalled();

    row = approval(hash);
    fireEvent.click(screen.getByRole("button", { name: "Approve this run" }));
    expect(await screen.findByText("Approved by a second person")).toBeInTheDocument();
    expect(heard).toHaveBeenCalled();
  });

  it("is told when a replay has run here", async () => {
    const hash = await runFingerprint();
    setRoutes([
      ...baseRoutes(),
      { match: /\/api\/deploy\/approvals\?/, method: "GET", body: { approvals: [approval(hash)] } },
      { match: "/api/scripts/apply", method: "POST", body: { success: true, results: [] } },
    ]);
    await openReplayCheck();
    await screen.findByText("Approved by a second person");
    screen.getAllByRole("checkbox").forEach((box) => fireEvent.click(box));
    const replay = await screen.findByRole("button", { name: "Replay 1 version on production" });
    await waitFor(() => expect(replay).toBeEnabled());
    expect(heard).not.toHaveBeenCalled();

    fireEvent.click(replay);
    await screen.findByText(/^Replayed 1 version onto /);
    expect(heard).toHaveBeenCalled();
  });
});

describe("what the replay check says about deleting rows", () => {
  /** The usual routes, with the SQL of the one version to replay swapped. */
  function routesReplaying(sql: string): FetchRoute[] {
    const source = [SOURCE_LEDGER[0], { ...SOURCE_LEDGER[1], sqlContent: sql }];
    return [
      {
        match: "/api/versionsync/ledger",
        body: (url: string) =>
          url.includes("connectionId=1") ? { entries: source } : { entries: TARGET_LEDGER },
      },
      ...baseRoutes(),
      { match: /\/api\/deploy\/approvals\?/, method: "GET", body: { approvals: [] } },
    ];
  }

  it("says a TRUNCATE deletes rows", async () => {
    setRoutes(routesReplaying("TRUNCATE notes;"));

    await openReplayCheck();

    expect(await screen.findByText("1 migration deletes rows")).toBeInTheDocument();
    expect(screen.getByText(/This replay contains TRUNCATE\. Those take rows out of a live table/)).toBeInTheDocument();
    expect(screen.getByText("I have read these statements and know which rows they delete.")).toBeInTheDocument();
  });

  it("says SQL it could not read may delete rows, not that it does", async () => {
    // EXECUTE in a DO block runs SQL from a string. The reader cannot see what
    // the string will be, so the box must not say that rows are deleted.
    setRoutes(
      routesReplaying("DO $$\nBEGIN\n  EXECUTE 'ANALYZE ' || 'notes';\nEND\n$$;")
    );

    await openReplayCheck();

    expect(await screen.findByText("1 migration may delete rows")).toBeInTheDocument();
    expect(screen.getByText(/Part of the SQL could not be read: an EXECUTE inside a DO block/)).toBeInTheDocument();
    expect(screen.getByText("I have read this SQL and know whether it deletes rows.")).toBeInTheDocument();

    expect(screen.queryByText(/Those take rows out of a live table/)).not.toBeInTheDocument();
    expect(screen.queryByText(/migration deletes rows/)).not.toBeInTheDocument();
    expect(screen.queryByText(/know which rows they delete/)).not.toBeInTheDocument();
  });
});

describe("who may replay", () => {
  it("lets a role without Deploy: Run ask an Admin to approve one exact replay", async () => {
    // A replay writes to the Target through the same apply route Deploy uses,
    // so it needs the same box, or an Admin's yes for that exact replay. The
    // list stays, the Run buttons stay (pressing one opens the check, which
    // asks), and the note above the list says how it works once.
    setUser("viewer");
    setRoutes(baseRoutes());

    await pickStagingToLive();

    expect(await screen.findByText("A replay here needs an Admin's approval")).toBeInTheDocument();
    expect(screen.getByText(/you can run it once, within 7 days/)).toBeInTheDocument();
    expect(screen.queryByText("You can read this list, but not replay it")).not.toBeInTheDocument();
    expect(await screen.findByRole("button", { name: /^Run v2\.0\.0/ })).toBeInTheDocument();
  });

  it("does not ask for approvals a role may not read, and keeps Replay on production shut", async () => {
    // A role an admin made that may replay but not read approvals. No route
    // here answers /api/deploy/approvals, so asking for it would fail the
    // test outright; and the panel must say "unknown" rather than read the
    // list it never fetched as an empty one.
    setCustomRole("deployer", "Deployer", ["version_sync:read", "deploy:read", "deploy:run"]);
    setRoutes(baseRoutes());

    await openReplayCheck();

    expect(await screen.findByText("Approval state unknown")).toBeInTheDocument();
    expect(
      screen.getByText(
        `Your role (Deployer) can't see production approvals. Ask an admin to turn on "See production approvals" for this role.`
      )
    ).toBeInTheDocument();
    expect(fetchCalls.some((call) => call.url.includes("/api/deploy/approvals"))).toBe(false);

    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "I understand, and I mean to replay 1 version against production.",
      })
    );
    // A rehearsal needs no approval, so only Replay waits.
    expect(await screen.findByText("Replay needs the approval above. A dry run does not.")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Dry run" })).toBeEnabled());
    expect(screen.getByRole("button", { name: "Replay 1 version on production" })).toBeDisabled();
  });
});

describe("the version line", () => {
  /** What each step of the line says, read the way a screen reader would. */
  async function lineSteps() {
    const line = await screen.findByRole("region", { name: "The Source's versions" });
    return within(line)
      .getAllByRole("listitem")
      .map((step) => step.textContent);
  }

  it("draws the Source's versions in order, with a pin where the Target has got to", async () => {
    setRoutes(baseRoutes());
    await pickStagingToLive();

    // v1.0.0 is on both, so the Target's pin sits on it; v2.0.0 is the one a
    // replay can run, and the newest the Source has.
    expect(await lineSteps()).toEqual(["Targetv1.0.0on the Target", "Sourcev2.0.0can run"]);
  });

  it("marks the version every run stops before, and the ones waiting behind it", async () => {
    // v2.0.0 was applied before its SQL was stored, so nothing can be sent for
    // it, and v3.0.0 cannot run until it has.
    const source = [
      SOURCE_LEDGER[0],
      { ...SOURCE_LEDGER[1], hasSql: false, sqlContent: null },
      entry("3.0.0", "2026-03-01T00:00:00Z"),
    ];
    setRoutes([
      {
        match: "/api/versionsync/ledger",
        body: (url: string) =>
          url.includes("connectionId=1") ? { entries: source } : { entries: TARGET_LEDGER },
      },
      ...baseRoutes(),
    ]);
    await pickStagingToLive();

    expect(await lineSteps()).toEqual([
      "Targetv1.0.0on the Target",
      "v2.0.0runs stop here",
      "Sourcev3.0.0waits",
    ]);
    // And nothing is offered to run, on the line or in the list.
    expect(screen.queryByRole("button", { name: /^Run / })).toBeNull();
  });

  it("is not drawn for a Source with nothing applied", async () => {
    setRoutes([
      { match: "/api/versionsync/ledger", body: { entries: [] } },
      ...baseRoutes(),
    ]);
    await pickStagingToLive();

    expect(await screen.findByText("The Source has no applied scripts")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "The Source's versions" })).toBeNull();
  });
});
