// drift-scheduler: only one copy of the app may run a tick.
//
// The guard against two overlapping ticks was a boolean in the process, which
// says nothing about the copy of the app running next to it. Two replicas — or
// a `next dev` left open beside a `next start`, which is how this happens on a
// laptop — each ran the whole schedule against the one metadata database. Every
// due schema was introspected twice a cadence, and every drift event written in
// "always" mode was written twice, so the audit feed showed each check twice.
//
// The metadata database is the only thing both copies can see, so the agreement
// about whose turn it is is made there, with an advisory lock.
import { driftSchedulerStatus, runSchedulerTick } from "@/lib/drift-scheduler";

/** One row of the schedule, as loadEntries reads it. */
type ScheduledRow = {
  id: number;
  org_id: number;
  drift_check_interval_minutes: number;
  last_drift_check_at: string | null;
};

/**
 * One schema, on a cadence, never checked, so always due. It belongs to
 * organization 3, which the check has to be run in.
 */
const ONE_SCHEMA: ScheduledRow[] = [
  { id: 1, org_id: 3, drift_check_interval_minutes: 15, last_drift_check_at: null },
];

/** What pg_try_advisory_lock should answer on the next tick. */
let lockAvailable = true;
/** The schemas on a cadence, in every organization. */
let schedule: ScheduledRow[] = ONE_SCHEMA;
/** Every statement the tick sent on its held connection, in order. */
let onLockConnection: string[] = [];
/** How many connections the tick borrowed, and how many it gave back. */
let borrowed = 0;
let released = 0;

// Relative paths on purpose: next/jest rewrites the @/ alias inside import
// statements only, so jest.mock("@/...") would not resolve.
jest.mock("../lib/version-db", () => ({
  __esModule: true,
  default: {
    query: async (text: string) => {
      // loadEntries: whatever the test put on the schedule.
      if (/FROM tracked_schemas/.test(text)) {
        return { rows: mockCount.schedule, rowCount: mockCount.schedule.length };
      }
      return { rows: [], rowCount: 0 };
    },
    connect: async () => {
      mockCount.borrow();
      return {
        query: async (text: string) => {
          mockCount.sent(text);
          if (/pg_try_advisory_lock/.test(text)) {
            return { rows: [{ taken: mockCount.available }], rowCount: 1 };
          }
          return { rows: [], rowCount: 0 };
        },
        release: () => mockCount.release(),
      };
    },
  },
  syncMetadataTables: async () => undefined,
}));

/** The check, called with (orgId, trackedSchemaId, source, mode). */
const mockCheck = jest.fn<Promise<{ ok: true; run: { status: string } }>, unknown[]>(
  async () => ({
    ok: true,
    run: { status: "in_sync" },
  })
);
jest.mock("../lib/drift-runner", () => ({
  runDriftCheck: (...args: unknown[]) => mockCheck(...args),
}));

jest.mock("../lib/schema-metrics", () => ({
  pruneSchemaMetrics: async () => 0,
  METRIC_RETENTION_DAYS: 90,
}));

// The factory above runs before the module body, so it cannot close over
// ordinary lets — a `mock`-prefixed name is the exception jest allows.
const mockCount = {
  get available() {
    return lockAvailable;
  },
  get schedule() {
    return schedule;
  },
  borrow: () => {
    borrowed += 1;
  },
  release: () => {
    released += 1;
  },
  sent: (text: string) => {
    onLockConnection.push(text.replace(/\s+/g, " ").trim());
  },
};

beforeEach(() => {
  // The scheduler keeps its counts on globalThis, so each test starts from a
  // process that has never ticked.
  globalThis.__driftSchedulerState = undefined;
  lockAvailable = true;
  schedule = ONE_SCHEMA;
  onLockConnection = [];
  borrowed = 0;
  released = 0;
  mockCheck.mockClear();
});

describe("a tick another copy of the app is already running", () => {
  it("does no work at all", async () => {
    lockAvailable = false;
    const report = await runSchedulerTick(new Date("2026-09-17T12:00:00Z"));

    // The schema was due. Without the lock this tick would have checked it, and
    // so would the copy that is checking it right now.
    expect(mockCheck).not.toHaveBeenCalled();
    expect(report).toEqual({
      kind: "shared",
      line: expect.stringContaining("another copy of the app"),
    });
  });

  it("gives the connection straight back", async () => {
    // A tick that is not going to do anything must not sit on one of the five
    // metadata connections for a minute.
    lockAvailable = false;
    await runSchedulerTick(new Date("2026-09-17T12:00:00Z"));

    expect(borrowed).toBe(1);
    expect(released).toBe(1);
  });

  it("does not unlock a lock it never took", async () => {
    // Advisory locks are not reference-counted across sessions, but a stray
    // unlock is still a lie in the log, and the warning it raises would point
    // at the copy that is holding the lock legitimately.
    lockAvailable = false;
    await runSchedulerTick(new Date("2026-09-17T12:00:00Z"));

    expect(onLockConnection.filter((q) => /pg_advisory_unlock/.test(q))).toHaveLength(0);
  });
});

describe("a tick nobody else is running", () => {
  it("checks what is due", async () => {
    const report = await runSchedulerTick(new Date("2026-09-17T12:00:00Z"));

    expect(mockCheck).toHaveBeenCalledTimes(1);
    expect(report).toEqual({ kind: "by_org", byOrg: new Map([[3, "Checked 1."]]) });
  });

  it("runs each check in the organization its schema belongs to", async () => {
    // The tick reads schemas from every organization, so nothing else tells the
    // check whose rows it may read and write.
    await runSchedulerTick(new Date("2026-09-17T12:00:00Z"));

    expect(mockCheck.mock.calls[0]).toEqual([3, 1, "scheduled", "on_change"]);
  });

  it("releases the lock on the connection that took it", async () => {
    await runSchedulerTick(new Date("2026-09-17T12:00:00Z"));

    // Same connection, in this order. Releasing without unlocking would hand a
    // connection that still holds the lock back to the pool, and no copy of the
    // app would ever tick again.
    expect(onLockConnection).toHaveLength(2);
    expect(onLockConnection[0]).toContain("pg_try_advisory_lock");
    expect(onLockConnection[1]).toContain("pg_advisory_unlock");
    expect(released).toBe(1);
  });

  it("releases the lock even when the tick blows up", async () => {
    // The failure mode that matters most: a tick that throws and keeps the lock
    // stops every copy of the app from ever checking anything again.
    mockCheck.mockRejectedValueOnce(new Error("metadata database went away"));
    const report = await runSchedulerTick(new Date("2026-09-17T12:00:00Z"));

    expect(report).toEqual({ kind: "shared", line: expect.stringContaining("Tick failed") });
    expect(onLockConnection.some((q) => /pg_advisory_unlock/.test(q))).toBe(true);
    expect(released).toBe(1);
  });

  it("takes the lock in a different space from the per-schema locks", async () => {
    // The deploy and re-baseline paths lock a tracked schema with the
    // single-argument form. Two arguments is a separate lock space, so this can
    // neither block one of those nor be blocked by one — which would be worse,
    // because a long deploy would stop the whole schedule.
    await runSchedulerTick(new Date("2026-09-17T12:00:00Z"));

    expect(onLockConnection[0]).toContain("hashtext($1), hashtext($2)");
  });
});

describe("what each organization is told about a tick", () => {
  // One tick checks every organization's due schemas together. A line or a
  // count that added them up would tell each organization how much drift and
  // how many unreachable databases the others have.
  const TWO_ORGS: ScheduledRow[] = [
    { id: 1, org_id: 3, drift_check_interval_minutes: 15, last_drift_check_at: null },
    { id: 2, org_id: 5, drift_check_interval_minutes: 15, last_drift_check_at: null },
    { id: 3, org_id: 5, drift_check_interval_minutes: 15, last_drift_check_at: null },
  ];

  beforeEach(() => {
    schedule = TWO_ORGS;
    // Organization 5's databases have drifted; organization 3's has not.
    mockCheck.mockImplementation(async (orgId) => ({
      ok: true,
      run: { status: orgId === 5 ? "drifted" : "in_sync" },
    }));
  });
  afterEach(() => {
    mockCheck.mockReset();
    mockCheck.mockImplementation(async () => ({ ok: true, run: { status: "in_sync" } }));
  });

  it("gives each organization a line about its own schemas only", async () => {
    await runSchedulerTick(new Date("2026-09-17T12:00:00Z"));

    expect(driftSchedulerStatus(3).lastTickSummary).toBe("Checked 1.");
    expect(driftSchedulerStatus(5).lastTickSummary).toBe("Checked 2 · 2 drifted.");
  });

  it("counts each organization's checks apart", async () => {
    await runSchedulerTick(new Date("2026-09-17T12:00:00Z"));
    await runSchedulerTick(new Date("2026-09-17T12:01:00Z"));

    // The fake never stamps a check, so every schema is due on both ticks.
    expect(driftSchedulerStatus(3).checksRun).toBe(2);
    expect(driftSchedulerStatus(5).checksRun).toBe(4);
  });

  it("tells an organization with nothing on a cadence just that", async () => {
    await runSchedulerTick(new Date("2026-09-17T12:00:00Z"));

    expect(driftSchedulerStatus(9)).toMatchObject({
      checksRun: 0,
      lastTickSummary: expect.stringContaining("Nothing scheduled"),
    });
  });

  it("says which of an organization's due schemas the tick did not reach", async () => {
    // Eight schemas due in organization 5 and one in organization 3: the tick
    // stops at six, most overdue first, so three of them wait for the next one.
    schedule = [
      { id: 1, org_id: 3, drift_check_interval_minutes: 15, last_drift_check_at: null },
      ...Array.from({ length: 8 }, (_, i) => ({
        id: 10 + i,
        org_id: 5,
        drift_check_interval_minutes: 15,
        last_drift_check_at: "2026-09-17T09:00:00Z",
      })),
    ];
    await runSchedulerTick(new Date("2026-09-17T12:00:00Z"));

    expect(driftSchedulerStatus(3).lastTickSummary).toBe("Checked 1.");
    expect(driftSchedulerStatus(5).lastTickSummary).toBe(
      "Checked 5 · 5 drifted · 3 more waiting for the next tick."
    );
  });

  it("keeps a failed check's error out of the line every organization sees", async () => {
    // The error can come from any organization's database, its host and all.
    mockCheck.mockRejectedValueOnce(new Error("could not reach db.org-five.internal"));
    await runSchedulerTick(new Date("2026-09-17T12:00:00Z"));

    for (const orgId of [3, 5]) {
      const line = driftSchedulerStatus(orgId).lastTickSummary;
      expect(line).toContain("Tick failed");
      expect(line).not.toContain("org-five");
    }
  });
});
