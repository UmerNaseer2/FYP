/** @jest-environment jsdom */

/**
 * CompareVersionTimeline: the "Version timeline" disclosure under Compare's
 * Declared versions bar.
 *
 * The bar says which side is ahead. This panel is where that answer can be
 * checked version by version — and it is the only thing on the screen that
 * goes back to both databases after the comparison has already run. Four of
 * its decisions are the reason it is worth a suite of its own:
 *
 *   Nothing is read until the disclosure is opened. Most comparisons never
 *   open it, and a panel nobody looked at must not cost each database another
 *   read.
 *
 *   A read that failed leaves the entries the comparison already carried on
 *   screen, says so, and waits to be asked again. The alternative — an empty
 *   table — reads as "this schema records nothing", which is the opposite of
 *   what a failed read means.
 *
 *   Each side is read from whichever route can answer for it, and only one of
 *   the two carries scripts. A side loaded from the other route has to say
 *   that its table stores none, rather than showing a version whose script
 *   looks lost.
 *
 *   A side the panel has only part of hedges about anything older than what it
 *   read ("not known" rather than "not recorded"), and stops hedging the moment
 *   the whole history is in. The two marks mean opposite things.
 *
 * What is NOT here:
 *  - Which side is read which way. lib/compare-timeline decides that and
 *    tests/compare-timeline.test.ts covers it.
 *  - The merge of the two sides into rows, and the table that draws them.
 *    lib/version-timeline and components/studio/VersionTimeline have their own
 *    suites (tests/version-timeline.test.ts, component-version-timeline).
 *  - Both endpoints. tests/versionsync-ledger-route.test.ts and
 *    tests/compare-version-history-route.test.ts cover those.
 *  - Resetting the panel between comparisons. Nothing here watches the props;
 *    app/(studio)/compare/page.tsx keys this component on its run counter, so
 *    a new comparison gets a new panel. That key belongs to the page, and
 *    tests/page-compare.test.tsx is where it would be checked.
 *
 * jsdom does not implement the summary click that opens a <details>, so these
 * tests open the element and fire the toggle the browser would have fired.
 */

import "@testing-library/jest-dom";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import {
  CompareVersionTimeline,
  type CompareTimelineSide,
} from "@/components/studio/CompareVersionTimeline";
import type { DetectedVersion, DetectedVersionEntry } from "@/lib/detected-version";
import type { NewerSchemaVerdict } from "@/lib/version-detection";
import type { LedgerEntry } from "@/lib/version-sync";
import {
  fetchCalls,
  flushAsync,
  holdNext,
  resetPageState,
  setRoutes,
  setUser,
} from "./helpers/render-page";

jest.mock("next/navigation", () => require("./helpers/render-page").navigationStubs);
jest.mock("next-auth/react", () => require("./helpers/render-page").sessionStubs);

/* ----------------------------------------------------------------- fixtures */

const entry = (
  over: Partial<DetectedVersionEntry> & { version: string }
): DetectedVersionEntry => ({
  label: "",
  appliedAt: "2026-09-10T09:00:00.000Z",
  changeLevel: "patch",
  scriptName: null,
  succeeded: true,
  current: false,
  ...over,
});

const detected = (over: Partial<DetectedVersion> = {}): DetectedVersion => ({
  table: "flyway_schema_history",
  version: "1.2.0",
  recent: [entry({ version: "1.2.0", current: true })],
  recentComplete: true,
  familyHeads: null,
  message: "Read from flyway_schema_history.",
  ...over,
});

/** A side the panel must go and read: a Flyway table the comparison cut short. */
const historySide = (over: Partial<CompareTimelineSide> = {}): CompareTimelineSide => ({
  label: "Source",
  name: "stage.public",
  detected: detected({ recentComplete: false }),
  connectionId: 3,
  schema: "public",
  ...over,
});

/** A side the panel reads from the ledger, scripts included. */
const ledgerSide = (over: Partial<CompareTimelineSide> = {}): CompareTimelineSide => ({
  label: "Target",
  name: "prod.public",
  detected: detected({
    table: "script_patch",
    version: "2.0.0",
    recent: [entry({ version: "2.0.0", current: true, scriptName: "core" })],
    message: "Read from script_patch.",
  }),
  connectionId: 4,
  schema: "public",
  ...over,
});

/** A side with nothing to go and read: no saved connection. */
const carriedSide = (over: Partial<CompareTimelineSide> = {}): CompareTimelineSide => ({
  label: "Target",
  name: "file.public",
  detected: detected(),
  connectionId: null,
  schema: "public",
  ...over,
});

const ledgerEntry = (over: Partial<LedgerEntry> & { version: string }): LedgerEntry => ({
  scriptName: "core",
  changeType: "patch",
  appliedAt: "2026-09-10T09:00:00.000Z",
  hasSql: true,
  sqlContent: "alter table orders add column paid boolean;",
  downSql: null,
  title: null,
  description: null,
  ...over,
});

const LEDGER = "/api/versionsync/ledger";
const HISTORY = "/api/compare/version-history";

/* ------------------------------------------------------------------ helpers */

function show(
  over: {
    left?: CompareTimelineSide;
    right?: CompareTimelineSide;
    verdict?: NewerSchemaVerdict | null;
  } = {}
) {
  return render(
    <CompareVersionTimeline
      left={over.left ?? historySide()}
      right={over.right ?? carriedSide()}
      verdict={over.verdict ?? null}
    />
  );
}

/** What a browser does on a summary click, which jsdom does not. */
function openPanel(open = true) {
  const details = screen.getByText("Version timeline").closest("details") as HTMLDetailsElement;
  details.open = open;
  fireEvent(details, new Event("toggle"));
}

const urls = () => fetchCalls.map((call) => call.url);
const versionToggle = (text: string) => screen.getByText(text).closest("button") as HTMLElement;

beforeEach(() => {
  resetPageState();
  setUser("editor");
});

afterEach(() => cleanup());

/* -------------------------------------------------------------------- tests */

describe("before anybody opens it", () => {
  it("reads nothing, because most comparisons never open it", () => {
    show({ left: historySide(), right: ledgerSide() });

    expect(screen.getByText("Version timeline")).toBeInTheDocument();
    expect(fetchCalls).toHaveLength(0);
  });

  it("starts both sides' reads the moment it is opened", async () => {
    setRoutes([
      { match: LEDGER, body: { hasLedger: true, entries: [] } },
      { match: HISTORY, body: { detected: detected({ recent: [] }) } },
    ]);
    show({ left: historySide(), right: ledgerSide() });
    openPanel();
    await flushAsync();

    expect(urls()).toEqual(
      expect.arrayContaining([
        "/api/compare/version-history?connectionId=3&schema=public",
        "/api/versionsync/ledger?connectionId=4&schema=public",
      ])
    );
    expect(fetchCalls).toHaveLength(2);
  });

  it("does not go back for a side it already holds whole", async () => {
    // A schema with three migrations has its whole history on screen already,
    // so asking would cost that database a read to be told what we knew. This
    // side has a saved connection — being reachable is not a reason to read it.
    setRoutes([{ match: HISTORY, body: { detected: detected({ recent: [] }) } }]);
    show({
      left: historySide(),
      right: historySide({ label: "Target", name: "prod.public", connectionId: 9, detected: detected() }),
    });
    openPanel();
    await flushAsync();

    expect(urls()).toEqual(["/api/compare/version-history?connectionId=3&schema=public"]);
  });

  it("does not read a side that was compared without a saved connection", async () => {
    setRoutes([{ match: HISTORY, body: { detected: detected({ recent: [] }) } }]);
    show({ left: historySide(), right: carriedSide({ detected: detected({ recentComplete: false }) }) });
    openPanel();
    await flushAsync();

    // There is nothing to read it through, however incomplete its list is.
    expect(urls()).toEqual(["/api/compare/version-history?connectionId=3&schema=public"]);
  });

  it("reads nothing at all when neither side can be read", async () => {
    show({
      left: carriedSide({ label: "Source", name: "file.public" }),
      right: carriedSide(),
    });
    openPanel();
    await flushAsync();

    expect(fetchCalls).toHaveLength(0);
  });
});

describe("while the reads are in flight", () => {
  it("names both schemas when both are being read", async () => {
    setRoutes([
      { match: LEDGER, body: { hasLedger: true, entries: [] } },
      { match: HISTORY, body: { detected: detected({ recent: [] }) } },
    ]);
    const releaseLedger = holdNext(LEDGER);
    const releaseHistory = holdNext(HISTORY);
    show({ left: historySide(), right: ledgerSide() });
    openPanel();

    expect(screen.getByText("Loading the version history of both schemas…")).toBeInTheDocument();
    releaseLedger();
    releaseHistory();
    await flushAsync();
  });

  it("names the one schema when only one is being read", async () => {
    setRoutes([{ match: HISTORY, body: { detected: detected({ recent: [] }) } }]);
    const release = holdNext(HISTORY);
    show({ left: historySide(), right: carriedSide() });
    openPanel();

    expect(screen.getByText("Loading stage.public's version history…")).toBeInTheDocument();
    release();
    await flushAsync();
  });
});

describe("a side read from the ledger", () => {
  it("shows every version the ledger holds, not the few the comparison read", async () => {
    setRoutes([
      {
        match: LEDGER,
        body: {
          hasLedger: true,
          entries: [ledgerEntry({ version: "2.0.0" }), ledgerEntry({ version: "1.0.0" })],
        },
      },
    ]);
    show({ left: carriedSide({ label: "Source", name: "file.public" }), right: ledgerSide() });
    openPanel();
    await flushAsync();

    expect(screen.getByText("v2.0.0")).toBeInTheDocument();
    expect(screen.getByText("v1.0.0")).toBeInTheDocument();
  });

  it("says nothing above the table when both sides loaded their own history", async () => {
    setRoutes([
      { match: LEDGER, body: { hasLedger: true, entries: [ledgerEntry({ version: "2.0.0" })] } },
    ]);
    const { container } = show({
      left: ledgerSide({ label: "Source", name: "stage.public", connectionId: 3 }),
      right: ledgerSide(),
    });
    openPanel();
    await flushAsync();

    // A note is for what the table cannot show. Two whole histories with their
    // scripts leave nothing to apologise for, and a note that always appears
    // stops being read.
    expect(container.querySelector(".vtl__note")).toBeNull();
  });

  it("hands the table the ledger's own words for a row with no script", async () => {
    setRoutes([
      {
        match: LEDGER,
        body: {
          hasLedger: true,
          entries: [ledgerEntry({ version: "1.0.0", hasSql: false, sqlContent: null })],
        },
      },
    ]);
    show({ left: carriedSide({ label: "Source", name: "file.public" }), right: ledgerSide() });
    openPanel();
    await flushAsync();

    fireEvent.click(versionToggle("v1.0.0"));

    // A ledger row without SQL predates the column; that is a different fact
    // from a table that never stores scripts at all.
    expect(screen.getByText(/No script was stored with this version\./)).toBeInTheDocument();
  });

  it("says the table went away when the ledger read finds none", async () => {
    setRoutes([{ match: LEDGER, body: { hasLedger: false, entries: [] } }]);
    show({ left: carriedSide({ label: "Source", name: "file.public" }), right: ledgerSide() });
    openPanel();
    await flushAsync();

    expect(
      screen.getByText(
        /No script_patch table was found on prod\.public when the timeline loaded, so it shows the entries the comparison read\./
      )
    ).toBeInTheDocument();

    fireEvent.click(versionToggle("v2.0.0"));
    expect(
      screen.getByText("The script_patch table was not found, so no script is shown.")
    ).toBeInTheDocument();
  });
});

describe("a side read from the version-history route", () => {
  it("counts the whole history once it has it, not the handful that arrived", async () => {
    setRoutes([
      {
        match: HISTORY,
        body: {
          detected: detected({
            recent: [
              entry({ version: "1.2.0", current: true }),
              entry({ version: "1.1.0" }),
              entry({ version: "1.0.0" }),
            ],
            recentComplete: true,
          }),
        },
      },
    ]);
    show({ left: historySide(), right: carriedSide() });
    openPanel();
    await flushAsync();

    expect(
      screen.getByText(
        "flyway_schema_history on stage.public does not store its scripts. This shows all 3 entries it holds."
      )
    ).toBeInTheDocument();
  });

  it("says the version table went away when the history read finds none", async () => {
    setRoutes([{ match: HISTORY, body: { detected: detected({ table: null, recent: [] }) } }]);
    show({ left: historySide(), right: carriedSide() });
    openPanel();
    await flushAsync();

    expect(
      screen.getByText(
        /No version table was found on stage\.public when the timeline loaded, so it shows the entries the comparison read\./
      )
    ).toBeInTheDocument();
  });
});

describe("the reason a row has no script", () => {
  it("names the table's own limitation, not a failure", async () => {
    setRoutes([
      {
        match: HISTORY,
        body: { detected: detected({ recent: [entry({ version: "1.2.0", current: true })] }) },
      },
    ]);
    show({ left: historySide(), right: carriedSide({ detected: detected({ table: null, recent: [] }) }) });
    openPanel();
    await flushAsync();

    fireEvent.click(versionToggle("1.2.0"));
    expect(screen.getByText("This version table does not store its scripts.")).toBeInTheDocument();
  });
});

describe("a read that did not come back", () => {
  it("keeps the entries the comparison carried, and says why they are all there is", async () => {
    // The guard: an empty table would read as "this schema records nothing",
    // which is the opposite of what a failed read means.
    setRoutes([{ match: HISTORY, status: 500, body: { error: "The database refused the connection" } }]);
    show({ left: historySide(), right: carriedSide() });
    openPanel();
    await flushAsync();

    expect(
      screen.getByText(
        /stage\.public's flyway_schema_history history did not load\. The database refused the connection\. Nothing was changed\. Until it loads, the timeline shows only the entries the comparison read\./
      )
    ).toBeInTheDocument();
    expect(screen.getByText("1.2.0")).toBeInTheDocument();
  });

  it("finishes the server's sentence, but does not add a second full stop", async () => {
    setRoutes([{ match: HISTORY, status: 500, body: { error: "Who knows?" } }]);
    show({ left: historySide(), right: carriedSide() });
    openPanel();
    await flushAsync();

    expect(screen.getByText(/Who knows\? Nothing was changed\./)).toBeInTheDocument();
  });

  it("says the status when the server sent no words of its own", async () => {
    setRoutes([{ match: HISTORY, status: 503, body: { nothing: true } }]);
    show({ left: historySide(), right: carriedSide() });
    openPanel();
    await flushAsync();

    expect(screen.getByText(/The server answered with status 503\./)).toBeInTheDocument();
  });

  it("treats an answer it cannot read as a failed read, not as an empty history", async () => {
    // A 200 whose body is not a history would otherwise draw a side with no
    // entries at all, which reads as "this schema records nothing" — the
    // opposite of what a read that went wrong means.
    setRoutes([{ match: HISTORY, body: { detected: null } }]);
    show({ left: historySide(), right: carriedSide() });
    openPanel();
    await flushAsync();

    expect(screen.getByText(/did not load\. The server answered with status 200\./)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it("does the same for a ledger answer it cannot read", async () => {
    setRoutes([{ match: LEDGER, body: { hasLedger: true } }]);
    show({ left: carriedSide({ label: "Source", name: "file.public" }), right: ledgerSide() });
    openPanel();
    await flushAsync();

    expect(
      screen.getByText(/prod\.public's script_patch history did not load\. The server answered with status 200\./)
    ).toBeInTheDocument();
  });

  it("says the request never arrived when the network drops", async () => {
    setRoutes([{ match: HISTORY, networkError: true }]);
    show({ left: historySide(), right: carriedSide() });
    openPanel();
    await flushAsync();

    expect(screen.getByText(/The request did not reach the server\./)).toBeInTheDocument();
  });

  it("tells the ledger side that no script is shown, rather than that none exists", async () => {
    setRoutes([{ match: LEDGER, status: 500, body: { error: "Timed out" } }]);
    show({ left: carriedSide({ label: "Source", name: "file.public" }), right: ledgerSide() });
    openPanel();
    await flushAsync();

    expect(
      screen.getByText(/prod\.public's script_patch history did not load\. Timed out\./)
    ).toBeInTheDocument();

    fireEvent.click(versionToggle("v2.0.0"));
    expect(
      screen.getByText(/The script_patch history did not load, so no script is shown\./)
    ).toBeInTheDocument();
  });

  it("waits to be asked again rather than retrying on its own", async () => {
    setRoutes([{ match: HISTORY, status: 500, body: { error: "Timed out" } }]);
    show({ left: historySide(), right: carriedSide() });
    openPanel();
    await flushAsync();
    expect(fetchCalls).toHaveLength(1);

    // Closed and opened again: a read that failed must not repeat itself every
    // time somebody opens the panel.
    openPanel(false);
    openPanel(true);
    await flushAsync();

    expect(fetchCalls).toHaveLength(1);
  });

  it("reads again when asked, and drops the note once it works", async () => {
    setRoutes([{ match: HISTORY, status: 500, body: { error: "Timed out" } }]);
    show({ left: historySide(), right: carriedSide() });
    openPanel();
    await flushAsync();

    setRoutes([
      {
        match: HISTORY,
        body: {
          detected: detected({
            recent: [entry({ version: "1.2.0", current: true }), entry({ version: "1.1.0" })],
            recentComplete: true,
          }),
        },
      },
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await flushAsync();

    expect(fetchCalls).toHaveLength(2);
    expect(screen.queryByText(/did not load/)).not.toBeInTheDocument();
    expect(
      screen.getByText(
        "flyway_schema_history on stage.public does not store its scripts. This shows all 2 entries it holds."
      )
    ).toBeInTheDocument();
  });
});

describe("a side with nothing to read", () => {
  it("says so, rather than leaving its column unexplained", async () => {
    show({
      left: historySide({ detected: null }),
      right: carriedSide(),
    });
    openPanel();
    await flushAsync();

    expect(
      screen.getByText(
        "No versions were read from stage.public, so every version below shows as not recorded there."
      )
    ).toBeInTheDocument();
  });

  it("explains that a ledger without a saved connection cannot be loaded", async () => {
    show({
      left: historySide(),
      right: carriedSide({
        name: "file.public",
        detected: detected({ table: "script_patch", version: "2.0.0" }),
      }),
    });
    openPanel();
    await flushAsync();

    expect(
      screen.getByText(
        /file\.public was compared without a saved connection, so its script_patch history and scripts cannot be loaded here\./
      )
    ).toBeInTheDocument();

    fireEvent.click(versionToggle("1.2.0"));
    // Not "this table does not store its scripts" — script_patch does store
    // them; they are simply out of reach from a comparison run off a file.
    expect(
      screen.getByText(/Target: Scripts load only for a schema compared through a saved connection\./)
    ).toBeInTheDocument();
  });
});

describe("when the comparison underneath it changes", () => {
  it("does not read again by itself, because the page mounts a new panel", async () => {
    setRoutes([{ match: HISTORY, body: { detected: detected({ recent: [] }) } }]);
    const { rerender } = show({ left: historySide(), right: carriedSide() });
    openPanel();
    await flushAsync();
    expect(fetchCalls).toHaveLength(1);

    rerender(
      <CompareVersionTimeline
        left={historySide({ name: "other.public", connectionId: 8 })}
        right={carriedSide()}
        verdict={null}
      />
    );
    await flushAsync();

    // Nothing here watches the sides. app/(studio)/compare/page.tsx keys this
    // component on its run counter, so a fresh comparison gets a fresh panel
    // rather than the history the last one loaded. Reacting to the props here
    // as well would read the new schema before anybody opened the panel,
    // which is the cost the disclosure exists to avoid.
    expect(fetchCalls).toHaveLength(1);
  });

  it("starts over when the page does mount a new one", async () => {
    setRoutes([{ match: HISTORY, body: { detected: detected({ recent: [] }) } }]);
    show({ left: historySide(), right: carriedSide() });
    openPanel();
    await flushAsync();

    cleanup();
    show({ left: historySide({ name: "other.public", connectionId: 8 }), right: carriedSide() });
    openPanel();
    await flushAsync();

    expect(urls()).toEqual([
      "/api/compare/version-history?connectionId=3&schema=public",
      "/api/compare/version-history?connectionId=8&schema=public",
    ]);
  });
});

describe("how much of a side the table may speak for", () => {
  /** Older than anything the comparison read from the left side. */
  const OLDER = detected({
    recent: [entry({ version: "1.0.0", current: true })],
    version: "1.0.0",
  });

  it("hedges about versions older than the list it has, while that is all it has", async () => {
    setRoutes([{ match: HISTORY, status: 500, body: { error: "Timed out" } }]);
    show({ left: historySide(), right: carriedSide({ detected: OLDER }) });
    openPanel();
    await flushAsync();

    expect(
      screen.getByText("Not known: this is older than the entries read from Source.")
    ).toBeInTheDocument();
  });

  it("keeps hedging when the read itself says it only got part of the history", async () => {
    // The detector has a row limit of its own, so "all of it" and "as much of
    // it as we read" can both come back 200. They must not look the same.
    setRoutes([
      {
        match: HISTORY,
        body: {
          detected: detected({
            recent: [entry({ version: "1.2.0", current: true }), entry({ version: "1.1.0" })],
            recentComplete: false,
          }),
        },
      },
    ]);
    show({ left: historySide(), right: carriedSide({ detected: OLDER }) });
    openPanel();
    await flushAsync();

    expect(
      screen.getByText("Not known: this is older than the entries read from Source.")
    ).toBeInTheDocument();
  });

  it("does not hedge for a side the comparison already carried whole", async () => {
    setRoutes([
      {
        match: HISTORY,
        body: {
          detected: detected({
            recent: [entry({ version: "1.2.0", current: true }), entry({ version: "1.0.0" })],
            recentComplete: true,
          }),
        },
      },
    ]);
    // The right side came with its whole list, so a version missing from it is
    // missing, not merely below what was read.
    show({ left: historySide(), right: carriedSide({ detected: detected({ version: "1.2.0" }) }) });
    openPanel();
    await flushAsync();

    expect(screen.queryByText(/Not known: this is older/)).not.toBeInTheDocument();
    expect(screen.getByText("Target does not record this version.")).toBeInTheDocument();
  });

  it("stops hedging once the whole history is in", async () => {
    setRoutes([
      {
        match: HISTORY,
        body: {
          detected: detected({
            recent: [entry({ version: "1.2.0", current: true }), entry({ version: "1.1.0" })],
            recentComplete: true,
          }),
        },
      },
    ]);
    show({ left: historySide(), right: carriedSide({ detected: OLDER }) });
    openPanel();
    await flushAsync();

    // The read came back and said 1.0.0 is not there, which is a fact, not a
    // gap in what was read.
    expect(screen.queryByText(/Not known: this is older/)).not.toBeInTheDocument();
    expect(screen.getByText("Source does not record this version.")).toBeInTheDocument();
  });
});

describe("the verdict the bar reached", () => {
  it("marks the side the bar calls behind", async () => {
    setRoutes([{ match: HISTORY, body: { detected: detected({ recent: [] }) } }]);
    show({
      left: historySide(),
      right: carriedSide(),
      verdict: { newer: "left", reason: "Source is ahead." },
    });
    openPanel();
    await flushAsync();

    const target = screen.getByText("Target").closest("th") as HTMLElement;
    expect(target).toHaveTextContent("(Outdated)");
    expect(screen.getByText("Source").closest("th")).not.toHaveTextContent("(Outdated)");
  });

  it("marks neither side when the bar could not decide", async () => {
    setRoutes([{ match: HISTORY, body: { detected: detected({ recent: [] }) } }]);
    show({
      left: historySide(),
      right: carriedSide(),
      verdict: { newer: "diverged", reason: "Each side has versions the other does not." },
    });
    openPanel();
    await flushAsync();

    expect(screen.queryByText("(Outdated)")).not.toBeInTheDocument();
  });
});
