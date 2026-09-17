// drift-runner: a check that found nothing to check has still been attempted.
//
// The scheduler picks the six most overdue schemas a minute, and "overdue" is
// measured from tracked_schemas.last_drift_check_at. A check that threw, or
// found the schema gone, or found it had no baseline, used to return before the
// stamp was written — so its check time never moved, it stayed the most overdue
// schema there was, and it was picked again on the very next tick. Six schemas
// in that state fill every tick between them and nothing else is ever checked.
//
// An unreachable database is not one of these: it comes out of the check as a
// successful "unreachable" result and always got its stamp, which is why the
// schedule looked fine right up until a schema lost its baseline.
import { runDriftCheck } from "@/lib/drift-runner";
import { selectDue, type DriftScheduleEntry } from "@/lib/drift-schedule";

/** What computeDriftDetail should do on the next call. */
let outcome: { kind: string } | Error = { kind: "not_found" };

// Relative paths on purpose: next/jest rewrites the @/ alias inside import
// statements only, so jest.mock("@/...") would not resolve.
const mockPoolQuery = jest.fn<Promise<unknown>, [string, unknown[]?]>(async () => ({
  rows: [],
  rowCount: 0,
}));
jest.mock("../lib/version-db", () => ({
  __esModule: true,
  default: { query: (...args: [string, unknown[]?]) => mockPoolQuery(...args) },
  syncMetadataTables: async () => undefined,
}));

// Only the one function that reads a database is replaced; buildDriftSummary
// and the rest of lineage-db stay real, so a change to what an outcome looks
// like is not silently hidden behind a hand-written stub.
jest.mock("../lib/lineage-db", () => ({
  ...jest.requireActual("../lib/lineage-db"),
  computeDriftDetail: async () => {
    if (mockOutcome.value instanceof Error) throw mockOutcome.value;
    return mockOutcome.value;
  },
}));

jest.mock("../lib/schema-metrics", () => ({
  recordSchemaMetrics: async () => undefined,
}));

// The factory above runs before the module body, so it cannot close over an
// ordinary let — a `mock`-prefixed name is the exception jest allows.
const mockOutcome = {
  get value() {
    return outcome;
  },
};

/** The stamping UPDATEs the runner sent, if any. */
function stamps(): unknown[][] {
  return mockPoolQuery.mock.calls
    .filter(([text]) => /UPDATE tracked_schemas SET last_drift_check_at/.test(text))
    .map(([, values]) => (values ?? []) as unknown[]);
}

/** The subject fields every non-"not_found" outcome carries. */
const subject = {
  schemaName: "public",
  label: null,
  environment: "development" as const,
  connection: null,
  driftIntervalMinutes: 15,
};

beforeEach(() => {
  mockPoolQuery.mockClear();
});

describe("a check that could not produce a result", () => {
  it("stamps the check time when the check threw", async () => {
    outcome = new Error("connection terminated unexpectedly");
    const result = await runDriftCheck(4, "scheduled");

    // The failure is still reported — the stamp is not a way of pretending the
    // check worked, only of recording that it was attempted.
    expect(result.ok).toBe(false);
    expect(stamps()).toEqual([[4]]);
  });

  it("stamps the check time when the schema has no baseline", async () => {
    // The one that actually stops a schedule: not transient, so without the
    // stamp this schema is the most overdue row forever.
    outcome = { kind: "no_baseline", ...subject };
    const result = await runDriftCheck(4, "scheduled");

    expect(result.ok).toBe(false);
    expect(stamps()).toEqual([[4]]);
  });

  it("stamps the check time when the schema is gone", async () => {
    outcome = { kind: "not_found" };
    const result = await runDriftCheck(4, "scheduled");

    expect(result.ok).toBe(false);
    expect(stamps()).toEqual([[4]]);
  });

  it("records no drift event for any of them", async () => {
    // Stamping must not turn a failed check into an audit row saying the schema
    // was looked at and found fine.
    outcome = { kind: "no_baseline", ...subject };
    await runDriftCheck(4, "scheduled");

    expect(
      mockPoolQuery.mock.calls.filter(([text]) => /INSERT INTO drift_events/.test(text))
    ).toHaveLength(0);
  });

  it("stamps exactly once, not once per outcome branch", async () => {
    // The success path stamps too. A refactor that stamped up front AND on the
    // way out would double every UPDATE, which is harmless but says the code
    // has two ideas about where the stamp belongs.
    outcome = new Error("boom");
    await runDriftCheck(4, "manual");

    expect(stamps()).toHaveLength(1);
  });
});

describe("what the missing stamp did to the schedule", () => {
  // selectDue is pure, so the consequence can be shown exactly rather than
  // described. This is the reason the fix above is worth making.
  const now = new Date("2026-09-17T12:00:00Z");
  /** A schema on a 15-minute cadence, last checked `minutesAgo` ago. */
  function entry(id: number, minutesAgo: number | null): DriftScheduleEntry {
    return {
      trackedSchemaId: id,
      intervalMinutes: 15,
      lastCheckedAt:
        minutesAgo === null ? null : new Date(now.getTime() - minutesAgo * 60_000),
    };
  }

  it("keeps picking the schema whose check time never moves", async () => {
    // The broken schema was never stamped, so it is still the oldest.
    const unstamped = [entry(1, null), entry(2, 20), entry(3, 16)];

    expect(selectDue(unstamped, now, 1).map((e) => e.trackedSchemaId)).toEqual([1]);
    // ...and a tick later, having been checked and failed, it is oldest again.
    expect(selectDue(unstamped, now, 1).map((e) => e.trackedSchemaId)).toEqual([1]);
  });

  it("moves on once that schema is stamped like any other", async () => {
    // Same three schemas after the fix: schema 1 was just checked, failed, and
    // stamped anyway, so the next tick goes to the genuinely oldest one.
    const stamped = [entry(1, 0), entry(2, 20), entry(3, 16)];

    expect(selectDue(stamped, now, 1).map((e) => e.trackedSchemaId)).toEqual([2]);
  });
});
