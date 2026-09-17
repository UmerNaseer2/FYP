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
import { runSchedulerTick } from "@/lib/drift-scheduler";

/** What pg_try_advisory_lock should answer on the next tick. */
let lockAvailable = true;
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
      // loadEntries: one schema, on a cadence, never checked — always due.
      if (/FROM tracked_schemas/.test(text)) {
        return {
          rows: [
            {
              id: 1,
              drift_check_interval_minutes: 15,
              last_drift_check_at: null,
            },
          ],
          rowCount: 1,
        };
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

const mockCheck = jest.fn(async () => ({
  ok: true as const,
  run: { status: "in_sync" as const },
}));
jest.mock("../lib/drift-runner", () => ({
  runDriftCheck: (...args: unknown[]) => mockCheck(...(args as [])),
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
  lockAvailable = true;
  onLockConnection = [];
  borrowed = 0;
  released = 0;
  mockCheck.mockClear();
});

describe("a tick another copy of the app is already running", () => {
  it("does no work at all", async () => {
    lockAvailable = false;
    const summary = await runSchedulerTick(new Date("2026-09-17T12:00:00Z"));

    // The schema was due. Without the lock this tick would have checked it, and
    // so would the copy that is checking it right now.
    expect(mockCheck).not.toHaveBeenCalled();
    expect(summary).toContain("another copy of the app");
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
    const summary = await runSchedulerTick(new Date("2026-09-17T12:00:00Z"));

    expect(mockCheck).toHaveBeenCalledTimes(1);
    expect(summary).toContain("Checked 1");
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
    const summary = await runSchedulerTick(new Date("2026-09-17T12:00:00Z"));

    expect(summary).toContain("Tick failed");
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
