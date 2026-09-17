// drift: new drift on an already-drifted schema has to be recorded too.
//
// The scheduler runs in "on_change" mode — a check every fifteen minutes that
// says "still fine" would push a day of real events off the end of the feed —
// and "changed" used to mean the status was different from the last recorded
// event. The status only has three values, so the moment a schema goes from
// "in_sync" to "drifted" it can never say anything again: somebody drops a
// column on Monday and the event is written, somebody drops a whole table on
// Tuesday and the status is still "drifted", so nothing is written and the feed
// says the last thing that happened here was Monday's column.
//
// The fix is to also compare a fingerprint of WHICH differences were found. The
// reports below are built by the real compare engine rather than by hand, so
// these tests are about what the app actually produces.
import { compareSchemas } from "@/lib/compare";
import { driftDifferences, driftFingerprint } from "@/lib/drift-fingerprint";
import { runDriftCheck } from "@/lib/drift-runner";
import { column, schema, table } from "./helpers/snapshots";

/** What the fake metadata database answers for "the newest event". */
let previousEvent: { status: string; fingerprint: string | null } | null = null;
/** What computeDriftDetail should hand back on the next call. */
let outcome: unknown = null;

// Relative paths on purpose: next/jest rewrites the @/ alias inside import
// statements only, so jest.mock("@/...") would not resolve.
const mockPoolQuery = jest.fn<Promise<unknown>, [string, unknown[]?]>(
  async (text: string) => {
    if (/SELECT status, fingerprint FROM drift_events/.test(text)) {
      return {
        rows: mockState.previous ? [mockState.previous] : [],
        rowCount: mockState.previous ? 1 : 0,
      };
    }
    return { rows: [], rowCount: 0 };
  }
);
jest.mock("../lib/version-db", () => ({
  __esModule: true,
  default: { query: (...args: [string, unknown[]?]) => mockPoolQuery(...args) },
  syncMetadataTables: async () => undefined,
}));

// Only the one function that reads a database is replaced. buildDriftSummary
// and the rest of lineage-db stay real, so a change to what an outcome looks
// like is not silently hidden behind a hand-written stub.
jest.mock("../lib/lineage-db", () => ({
  ...jest.requireActual("../lib/lineage-db"),
  computeDriftDetail: async () => mockState.outcome,
}));

jest.mock("../lib/schema-metrics", () => ({
  recordSchemaMetrics: async () => undefined,
}));

// The factories above run before the module body, so they cannot close over
// ordinary lets — a `mock`-prefixed name is the exception jest allows.
const mockState = {
  get previous() {
    return previousEvent;
  },
  get outcome() {
    return outcome;
  },
};

/** The drift_events rows the runner wrote, as the values it passed. */
function inserted(): unknown[][] {
  return mockPoolQuery.mock.calls
    .filter(([text]) => /INSERT INTO drift_events/.test(text))
    .map(([, values]) => (values ?? []) as unknown[]);
}

// ── the schemas these tests drift between ──────────────────────────────────
// The baseline: two ordinary tables.
const expected = schema([
  table("customer", [column("id"), column("email"), column("phone")]),
  table("invoice", [column("id"), column("total")]),
]);

// Monday: one column is gone from `customer`.
const afterFirstChange = schema([
  table("customer", [column("id"), column("email")]),
  table("invoice", [column("id"), column("total")]),
]);

// Tuesday: that column is still gone AND a whole table has gone with it. The
// status is "drifted" both days, which is the whole problem.
const afterSecondChange = schema([
  table("customer", [column("id"), column("email")]),
]);

// A different second change, inside the table that had already changed: the
// counts stored on the event cannot tell this from Monday either, because
// tablesChanged is 1 in both.
const afterDifferentChange = schema([
  table("customer", [column("id"), column("phone")]),
  table("invoice", [column("id"), column("total")]),
]);

/** Drift compares (expected, live), so left is the baseline. */
function report(live: ReturnType<typeof schema>) {
  return compareSchemas(expected, live);
}

/** An "ok" drift outcome the runner will accept, for this live schema. */
function drifted(live: ReturnType<typeof schema>) {
  const r = report(live);
  return {
    kind: "ok" as const,
    status: "drifted" as const,
    summary: "some drift",
    counts: {
      tablesAdded: r.summary.tablesOnlyInB,
      tablesRemoved: r.summary.tablesOnlyInA,
      tablesChanged: r.summary.changedTables,
      constraintsChanged: r.summary.changedConstraints,
    },
    report: r,
    expected: { snapshotId: 7, version: "1.0.0" },
    live: r.right,
    schemaName: "public",
    label: null,
    environment: "development" as const,
    connection: null,
    driftIntervalMinutes: 15,
  };
}

beforeEach(() => {
  mockPoolQuery.mockClear();
  previousEvent = null;
  outcome = null;
});

describe("a schema that drifts twice", () => {
  it("records the second change even though the status never moved", async () => {
    // Monday's event is already in the feed: status "drifted", and the
    // fingerprint of the dropped column.
    previousEvent = {
      status: "drifted",
      fingerprint: driftFingerprint(report(afterFirstChange)),
    };
    outcome = drifted(afterSecondChange);

    const result = await runDriftCheck(4, "scheduled", "on_change");

    expect(result.ok).toBe(true);
    expect(inserted()).toHaveLength(1);
    expect(result.ok && result.run.recorded).toBe(true);
  });

  it("records a second change inside a table that had already changed", async () => {
    // The hardest case for anything counting rather than naming: one table
    // changed on Monday, one table changed on Tuesday, a different column each
    // time. Every count on the stored event is identical.
    previousEvent = {
      status: "drifted",
      fingerprint: driftFingerprint(report(afterFirstChange)),
    };
    outcome = drifted(afterDifferentChange);

    await runDriftCheck(4, "scheduled", "on_change");

    expect(inserted()).toHaveLength(1);
  });

  it("stores the fingerprint so the next check has something to compare", async () => {
    // Without this the fix only works once: the row written above would have no
    // fingerprint, and the check after it would be back to comparing statuses.
    previousEvent = null;
    outcome = drifted(afterFirstChange);

    await runDriftCheck(4, "scheduled", "on_change");

    const values = inserted()[0];
    expect(values[values.length - 1]).toBe(driftFingerprint(report(afterFirstChange)));
  });
});

describe("a check that found nothing new", () => {
  it("still records nothing when the drift is the same drift", async () => {
    // The reason "on_change" exists. Four checks an hour, all day, on a schema
    // nobody has touched since the event was written.
    const same = report(afterFirstChange);
    previousEvent = { status: "drifted", fingerprint: driftFingerprint(same) };
    outcome = drifted(afterFirstChange);

    const result = await runDriftCheck(4, "scheduled", "on_change");

    expect(inserted()).toHaveLength(0);
    expect(result.ok && result.run.recorded).toBe(false);
  });

  it("records nothing while a database stays unreachable", async () => {
    // An unreachable database produces no comparison, so there is no
    // fingerprint. Treating that as "cannot tell, write it down" would refill
    // the feed every fifteen minutes for as long as the database stayed down.
    previousEvent = { status: "unreachable", fingerprint: null };
    outcome = {
      kind: "unreachable" as const,
      summary: "could not connect",
      expected: { snapshotId: 7, version: "1.0.0" },
      schemaName: "public",
      label: null,
      environment: "development" as const,
      connection: null,
      driftIntervalMinutes: 15,
    };

    await runDriftCheck(4, "scheduled", "on_change");

    expect(inserted()).toHaveLength(0);
  });

  it("records once against an event that predates fingerprints", async () => {
    // Every row already in the feed has a null fingerprint. Recording once is
    // the honest answer — nothing can be compared — and it leaves a fingerprint
    // behind, so the check after it goes quiet again instead of repeating.
    previousEvent = { status: "drifted", fingerprint: null };
    outcome = drifted(afterFirstChange);

    await runDriftCheck(4, "scheduled", "on_change");

    expect(inserted()).toHaveLength(1);
  });

  it("still records everything when a person asked", async () => {
    // "always" is what a button press gets: the record is the answer to "did I
    // check this?", so it is written whatever the last one said.
    const same = report(afterFirstChange);
    previousEvent = { status: "drifted", fingerprint: driftFingerprint(same) };
    outcome = drifted(afterFirstChange);

    await runDriftCheck(4, "manual", "always");

    expect(inserted()).toHaveLength(1);
  });
});

describe("the fingerprint itself", () => {
  it("names the differences rather than counting them", async () => {
    // Readable on purpose: the lines are what makes two fingerprints differ, so
    // a test that only compared hashes would not say what went wrong.
    expect(driftDifferences(report(afterSecondChange))).toEqual([
      "column:customer.phone:onlyA",
      "table:invoice:onlyA",
    ]);
  });

  it("gives an unchanged schema the same fingerprint every time", async () => {
    expect(driftFingerprint(report(expected))).toBe(driftFingerprint(report(expected)));
    expect(driftDifferences(report(expected))).toEqual([]);
  });

  it("does not depend on the order tables come back in", async () => {
    // Table order comes off the snapshot, and a drift check must not report a
    // change because a catalog listed two tables the other way round.
    const reordered = schema([
      table("invoice", [column("id"), column("total")]),
      table("customer", [column("id"), column("email")]),
    ]);

    expect(driftFingerprint(report(afterFirstChange))).toBe(
      driftFingerprint(report(reordered))
    );
  });

  it("tells two different single-column changes apart", async () => {
    expect(driftFingerprint(report(afterFirstChange))).not.toBe(
      driftFingerprint(report(afterDifferentChange))
    );
  });

  it("tells a change from that change plus one more", async () => {
    expect(driftFingerprint(report(afterFirstChange))).not.toBe(
      driftFingerprint(report(afterSecondChange))
    );
  });
});
