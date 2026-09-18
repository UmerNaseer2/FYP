/** @jest-environment jsdom */

/**
 * LiveActivity: spec feature 10, "Long-Running Query Detection", as a screen.
 *
 * Four of its decisions are the reason it is worth a suite of its own:
 *
 *   Nothing on this screen refreshes on its own. The screen says so in words,
 *   and a timer added later would quietly make that sentence a lie — a reading
 *   redrawn under the reader is a reading they cannot act on.
 *
 *   "PostgreSQL would not show us this SQL" and "this session is not running a
 *   statement" are opposite facts. Collapsing them tells the reader a session
 *   is idle when it may be running something they are not allowed to see.
 *
 *   A number nobody could measure must not look like a number that came back
 *   good. An unmeasurable metric says so instead of printing a dash, which at
 *   a glance reads as a zero.
 *
 *   There is deliberately no button here that ends a session. Terminating
 *   somebody else's backend is irreversible from a web page, so this screen
 *   gives the pid and stops.
 *
 * What is NOT here:
 *  - Which session counts as blocked, idle-in-transaction or long-running.
 *    lib/db-activity decides that from pg_stat_activity, and it has no suite
 *    of its own yet, so nothing checks that classification anywhere.
 *  - The numbers on the health panel. lib/db-health works those out and
 *    tests/db-health.test.ts covers it; here they arrive already worded.
 *  - The endpoint. /api/performance/activity runs the query; here it is a
 *    canned reply.
 */

import "@testing-library/jest-dom";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { LiveActivity } from "@/components/studio/LiveActivity";
import type { PerfTarget } from "@/components/studio/PerfTargetPicker";
import type { ActivitySession } from "@/lib/db-activity";
import type { DbHealth, HealthMetric } from "@/lib/db-health";
import type { ThresholdBreach } from "@/lib/perf-thresholds";
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

const TARGET: PerfTarget = {
  connectionId: "7",
  connectionName: "Prod shop",
  schema: "public",
};

const TAKEN_AT = "2026-09-18T10:20:30.000Z";
/** Built the same way the screen builds it, so the test is not a clock test. */
const STAMP = new Date(TAKEN_AT).toLocaleTimeString();

/** Mirrors ActivityView in app/api/performance/activity/route.ts. */
type Activity = {
  connectionName: string;
  database: string;
  takenAt: string;
  longRunningSeconds: number;
  thresholdConfigured: boolean;
  sessions: ActivitySession[];
  summary: {
    total: number;
    blocked: number;
    idleInTransaction: number;
    longRunning: number;
    anyHidden: boolean;
  };
  emptyMessage: string;
  hiddenNote: string | null;
  health: DbHealth | null;
  breaches: ThresholdBreach[];
};

const activity = (over: Partial<Activity> = {}): Activity => ({
  connectionName: "Prod shop",
  database: "shop",
  takenAt: TAKEN_AT,
  longRunningSeconds: 60,
  thresholdConfigured: false,
  sessions: [],
  summary: { total: 0, blocked: 0, idleInTransaction: 0, longRunning: 0, anyHidden: false },
  emptyMessage: "Nothing else was running on this database when this was read.",
  hiddenNote: null,
  health: null,
  breaches: [],
  ...over,
});

const session = (over: Partial<ActivitySession> & { pid: number }): ActivitySession => ({
  kind: "running",
  querySeconds: 2,
  xactSeconds: null,
  username: "app",
  applicationName: null,
  clientAddr: null,
  state: "active",
  waitingOn: null,
  query: "select 1",
  queryHidden: false,
  ...over,
});

const metric = (over: Partial<HealthMetric> & { key: string }): HealthMetric => ({
  label: "Cache hit ratio",
  display: "98%",
  value: 0.98,
  level: "good",
  note: "How often a read was already in memory.",
  ...over,
});

const health = (metrics: HealthMetric[], since: string | null = null): DbHealth => ({
  database: "shop",
  since,
  metrics,
});

const breach = (over: Partial<ThresholdBreach> = {}): ThresholdBreach =>
  ({
    key: "long_running_seconds",
    actual: 400,
    limit: 60,
    direction: "above",
    subject: "pid 900",
    message: "A session has been on one statement for 400s; the limit is 60s.",
    ...over,
  }) as ThresholdBreach;

const answers = (body: unknown, status = 200) => [
  { match: "/api/performance/activity", status, body },
];

/* ------------------------------------------------------------------ helpers */

function show(target: PerfTarget | null = TARGET) {
  return render(<LiveActivity target={target} />);
}

const loaded = () => screen.findByRole("button", { name: /Read again/ });
/** The line that stamps the reading. Its database name is inside a span. */
const stamp = () => screen.getByText(/Nothing here refreshes on its own/);

beforeEach(() => {
  resetPageState();
  setUser("editor");
});

afterEach(() => cleanup());

/* -------------------------------------------------------------------- tests */

describe("before there is a server to look at", () => {
  it("says what to pick, and asks nothing", () => {
    show(null);

    expect(
      screen.getByText(/Choose a PostgreSQL connection and a schema above/)
    ).toBeInTheDocument();
    expect(fetchCalls).toHaveLength(0);
  });

  it("shows a skeleton rather than an empty screen while it reads", () => {
    setRoutes(answers(activity()));
    const release = holdNext("/api/performance/activity");
    show();

    expect(screen.queryByRole("button", { name: /Read again/ })).not.toBeInTheDocument();
    release();
  });

  it("asks about the chosen connection and schema", async () => {
    setRoutes(answers(activity()));
    show();
    await loaded();

    expect(fetchCalls[0].url).toBe(
      "/api/performance/activity?connectionId=7&schema=public"
    );
  });
});

describe("one reading, and it says so", () => {
  it("does not refresh on its own", async () => {
    // The screen promises this in words. A timer added later would make that
    // sentence a lie, and a reading redrawn under the reader is one they
    // cannot act on.
    const timer = jest.spyOn(globalThis, "setInterval");
    setRoutes(answers(activity()));
    show();
    // Settled without findBy*, whose own polling would be the only interval
    // this spy ever saw and would drown out the thing being checked.
    await flushAsync();
    expect(screen.getByRole("button", { name: /Read again/ })).toBeInTheDocument();

    expect(timer).not.toHaveBeenCalled();
    expect(fetchCalls).toHaveLength(1);
    timer.mockRestore();
  });

  it("stamps the moment the reading was taken, not the moment it is drawn", async () => {
    setRoutes(answers(activity()));
    show();
    await loaded();

    expect(stamp()).toHaveTextContent(`As of ${STAMP} on shop.`);
  });

  it("names its own default when nobody has set a limit", async () => {
    setRoutes(answers(activity({ longRunningSeconds: 60, thresholdConfigured: false })));
    show();
    await loaded();

    expect(stamp()).toHaveTextContent(
      "more than 60s counts as long-running, which is this app's own default because no limit has been set."
    );
  });

  it("says when the limit is one somebody set for this schema", async () => {
    setRoutes(answers(activity({ longRunningSeconds: 15, thresholdConfigured: true })));
    show();
    await loaded();

    expect(stamp()).toHaveTextContent(
      "more than 15s counts as long-running, which is the limit set for this schema."
    );
  });

  it("reads again when the reader asks, and not before", async () => {
    setRoutes(answers(activity({ summary: { total: 1, blocked: 0, idleInTransaction: 0, longRunning: 0, anyHidden: false } })));
    show();
    await loaded();
    expect(fetchCalls).toHaveLength(1);

    setRoutes(answers(activity({ summary: { total: 4, blocked: 0, idleInTransaction: 0, longRunning: 0, anyHidden: false } })));
    fireEvent.click(screen.getByRole("button", { name: /Read again/ }));
    await screen.findByText("4 active");

    expect(fetchCalls).toHaveLength(2);
  });

  it("passes on the server's note about what it could not see", async () => {
    setRoutes(answers(activity({ hiddenNote: "Two sessions are hidden from this login." })));
    show();
    await loaded();

    expect(screen.getByText("Two sessions are hidden from this login.")).toBeInTheDocument();
  });
});

describe("the count along the top", () => {
  it("counts only what there is something to say about", async () => {
    setRoutes(
      answers(
        activity({
          summary: { total: 3, blocked: 0, idleInTransaction: 0, longRunning: 0, anyHidden: false },
        })
      )
    );
    show();
    await loaded();

    expect(screen.getByText("3 active")).toBeInTheDocument();
    expect(screen.queryByText(/waiting for a lock/)).not.toBeInTheDocument();
    expect(screen.queryByText(/idle in a transaction/)).not.toBeInTheDocument();
    expect(screen.queryByText(/long-running$/)).not.toBeInTheDocument();
  });

  it("names each kind of trouble separately, because the fixes differ", async () => {
    setRoutes(
      answers(
        activity({
          summary: { total: 9, blocked: 2, idleInTransaction: 1, longRunning: 4, anyHidden: false },
        })
      )
    );
    show();
    await loaded();

    expect(screen.getByText("9 active")).toBeInTheDocument();
    expect(screen.getByText("2 waiting for a lock")).toBeInTheDocument();
    expect(screen.getByText("1 idle in a transaction")).toBeInTheDocument();
    expect(screen.getByText("4 long-running")).toBeInTheDocument();
  });
});

describe("the sessions", () => {
  it("says nothing is running rather than showing an empty list", async () => {
    setRoutes(answers(activity({ emptyMessage: "This database is idle." })));
    show();
    await loaded();

    expect(screen.getByRole("heading", { name: "Nothing is running" })).toBeInTheDocument();
    expect(screen.getByText("This database is idle.")).toBeInTheDocument();
  });

  it("gives one card per session, each with its pid", async () => {
    setRoutes(
      answers(activity({ sessions: [session({ pid: 101 }), session({ pid: 202 })] }))
    );
    show();
    await loaded();

    expect(screen.getByText("pid 101")).toBeInTheDocument();
    expect(screen.getByText("pid 202")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Nothing is running" })).not.toBeInTheDocument();
  });

  it("names the kind in words rather than by colour alone", async () => {
    setRoutes(
      answers(
        activity({
          sessions: [
            session({ pid: 1, kind: "blocked" }),
            session({ pid: 2, kind: "idle-in-transaction" }),
            session({ pid: 3, kind: "long-running" }),
            session({ pid: 4, kind: "running" }),
          ],
        })
      )
    );
    show();
    await loaded();

    expect(screen.getByText("Waiting for a lock")).toBeInTheDocument();
    expect(screen.getByText("Idle in a transaction")).toBeInTheDocument();
    expect(screen.getByText("Long-running")).toBeInTheDocument();
    expect(screen.getByText("Running")).toBeInTheDocument();
  });

  it("keeps a decimal under a second, where the difference still matters", async () => {
    setRoutes(answers(activity({ sessions: [session({ pid: 1, querySeconds: 0.24 })] })));
    show();
    await loaded();

    // 0.24s and 0.91s both round to "0s", and one of them is worth a look.
    expect(screen.getByText("0.24s")).toBeInTheDocument();
  });

  it("reads longer runs in minutes and hours", async () => {
    setRoutes(
      answers(
        activity({
          sessions: [
            session({ pid: 1, querySeconds: 2.5 }),
            session({ pid: 2, querySeconds: 90 }),
            session({ pid: 3, querySeconds: 3720 }),
          ],
        })
      )
    );
    show();
    await loaded();

    expect(screen.getByText("2.5s")).toBeInTheDocument();
    expect(screen.getByText("1m 30s")).toBeInTheDocument();
    expect(screen.getByText("1h 2m")).toBeInTheDocument();
  });

  it("says a duration is unknown rather than printing it as zero", async () => {
    setRoutes(answers(activity({ sessions: [session({ pid: 1, querySeconds: null })] })));
    show();
    await loaded();

    expect(screen.getByText("unknown")).toBeInTheDocument();
  });

  it("fills in what the server did not tell it", async () => {
    setRoutes(
      answers(
        activity({
          sessions: [
            session({ pid: 1, username: null, applicationName: null, clientAddr: null }),
          ],
        })
      )
    );
    show();
    await loaded();

    expect(screen.getByText(/unknown user/)).toHaveTextContent(
      "unknown user · local socket · state active"
    );
  });

  it("prints everything it was told, in one line", async () => {
    setRoutes(
      answers(
        activity({
          sessions: [
            session({
              pid: 1,
              username: "reports",
              applicationName: "psql",
              clientAddr: "10.0.0.4",
              state: "idle in transaction",
              waitingOn: "Lock: transactionid",
              xactSeconds: 125,
            }),
          ],
        })
      )
    );
    show();
    await loaded();

    expect(screen.getByText(/reports/)).toHaveTextContent(
      "reports · psql · 10.0.0.4 · state idle in transaction · waiting on Lock: transactionid · transaction open 2m 5s"
    );
  });
});

describe("the SQL, and the two reasons there is none", () => {
  it("shows the statement when the server let it through", async () => {
    setRoutes(
      answers(
        activity({ sessions: [session({ pid: 1, query: "update orders set paid = true" })] })
      )
    );
    show();
    await loaded();

    expect(screen.getByText("update orders set paid = true")).toBeInTheDocument();
  });

  it("says the SQL was withheld rather than letting it read as idle", async () => {
    // The guard: withheld and absent are opposite facts. A session running
    // something this login may not see is not a session doing nothing.
    setRoutes(
      answers(
        activity({ sessions: [session({ pid: 1, query: null, queryHidden: true })] })
      )
    );
    show();
    await loaded();

    expect(
      screen.getByText(/did not show this session's SQL to the login this app is using/)
    ).toBeInTheDocument();
    expect(screen.queryByText("This session is not running a statement.")).not.toBeInTheDocument();
  });

  it("says a session with no statement has none", async () => {
    setRoutes(
      answers(
        activity({ sessions: [session({ pid: 1, query: null, queryHidden: false })] })
      )
    );
    show();
    await loaded();

    expect(screen.getByText("This session is not running a statement.")).toBeInTheDocument();
    expect(screen.queryByText(/did not show this session's SQL/)).not.toBeInTheDocument();
  });
});

describe("what this screen will not do", () => {
  it("offers no way to end somebody else's session", async () => {
    // Deliberate: terminating a backend is irreversible from here, so the
    // screen gives the pid and stops. Reading is the whole job.
    setRoutes(
      answers(
        activity({
          sessions: [session({ pid: 101, kind: "blocked" }), session({ pid: 202 })],
        })
      )
    );
    show();
    await loaded();

    expect(screen.getAllByRole("button").map((b) => b.textContent?.trim())).toEqual([
      "Read again",
    ]);
  });
});

describe("the health panel", () => {
  it("is not drawn at all when the server could not be asked", async () => {
    setRoutes(answers(activity({ health: null })));
    show();
    await loaded();

    expect(screen.queryByText("Database health")).not.toBeInTheDocument();
  });

  it("says what window the totals cover, because it is not 'now'", async () => {
    const since = "2026-01-04T00:00:00.000Z";
    setRoutes(answers(activity({ health: health([metric({ key: "cache" })], since) })));
    show();
    await loaded();

    // A 98% cache hit ratio over eight months and over the last hour are
    // different claims, and only one of them is on screen.
    expect(
      screen.getByText(
        `Totals since the counters were reset on ${new Date(since).toLocaleString()}.`
      )
    ).toBeInTheDocument();
  });

  it("says so when the counters have never been reset", async () => {
    setRoutes(answers(activity({ health: health([metric({ key: "cache" })], null) })));
    show();
    await loaded();

    expect(
      screen.getByText("Totals since this server last started; its counters have never been reset.")
    ).toBeInTheDocument();
  });

  it("says a metric is not measurable rather than printing a dash", async () => {
    // The guard: a dash and a zero look alike at a glance and mean opposite
    // things, and a number nobody could measure must not read as a good one.
    setRoutes(
      answers(
        activity({
          health: health([
            metric({ key: "cache", display: null, value: null, level: "unknown" }),
          ]),
        })
      )
    );
    show();
    await loaded();

    expect(screen.getByText("Not measurable yet")).toBeInTheDocument();
  });

  it("marks only the metrics worth looking at", async () => {
    setRoutes(
      answers(
        activity({
          health: health([
            metric({ key: "cache", label: "Cache hit ratio", level: "good" }),
            metric({ key: "dead", label: "Dead rows", level: "watch", display: "12%" }),
            metric({ key: "locks", label: "Deadlocks", level: "bad", display: "31" }),
          ]),
        })
      )
    );
    show();
    await loaded();

    expect(screen.queryByText("good")).not.toBeInTheDocument();
    expect(screen.getByText("watch")).toBeInTheDocument();
    expect(screen.getByText("bad")).toBeInTheDocument();
  });

  it("says what each number means and what it does not", async () => {
    setRoutes(
      answers(
        activity({
          health: health([
            metric({ key: "cache", note: "Reads served from memory since the reset." }),
          ]),
        })
      )
    );
    show();
    await loaded();

    expect(screen.getByText("Reads served from memory since the reset.")).toBeInTheDocument();
  });
});

describe("a reading that broke somebody's rule", () => {
  it("says nothing when nothing was broken, which is the normal case", async () => {
    setRoutes(answers(activity({ breaches: [] })));
    show();
    await loaded();

    expect(screen.queryByText(/broke an alert threshold/)).not.toBeInTheDocument();
  });

  it("names the breach and points at the rule that fired", async () => {
    setRoutes(answers(activity({ breaches: [breach()] })));
    show();
    await loaded();

    expect(screen.getByText("This broke an alert threshold")).toBeInTheDocument();
    expect(
      screen.getByText("A session has been on one statement for 400s; the limit is 60s.")
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Change them" })).toHaveAttribute(
      "href",
      "/performance?tab=alerts&connectionId=7&schema=public"
    );
  });

  it("counts them when more than one fired", async () => {
    setRoutes(
      answers(
        activity({
          breaches: [
            breach({ subject: "pid 900" }),
            breach({ subject: "pid 901", message: "Another session is over the limit." }),
          ],
        })
      )
    );
    show();
    await loaded();

    expect(screen.getByText("This broke 2 alert thresholds")).toBeInTheDocument();
  });
});

describe("when the reading cannot be taken", () => {
  it("says what the server said, and offers another go", async () => {
    setRoutes(answers({ error: "That connection is not a PostgreSQL database." }, 400));
    show();

    expect(
      await screen.findByText("Could not read this server's activity")
    ).toBeInTheDocument();
    expect(
      screen.getByText(/That connection is not a PostgreSQL database\./)
    ).toBeInTheDocument();
  });

  it("says something when the server cannot be reached at all", async () => {
    setRoutes([{ match: "/api/performance/activity", networkError: true }]);
    show();

    expect(
      await screen.findByText(/Could not reach the server to read its activity\./)
    ).toBeInTheDocument();
  });

  it("actually tries again when asked, rather than only redrawing", async () => {
    setRoutes(answers({ error: "The server was busy." }, 500));
    show();
    await screen.findByText("Could not read this server's activity");

    setRoutes(answers(activity({ summary: { total: 2, blocked: 0, idleInTransaction: 0, longRunning: 0, anyHidden: false } })));
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByText("2 active");

    expect(fetchCalls).toHaveLength(2);
  });
});

describe("changing the server under the screen", () => {
  it("does not let a late answer overwrite the server now on screen", async () => {
    setRoutes(answers(activity({ database: "shop" })));
    const { rerender } = show();
    await loaded();

    const releaseStale = holdNext("/api/performance/activity");
    rerender(<LiveActivity target={{ ...TARGET, schema: "sales" }} />);
    setRoutes(answers(activity({ database: "billing" })));
    rerender(<LiveActivity target={{ ...TARGET, schema: "billing" }} />);
    await loaded();
    expect(stamp()).toHaveTextContent("on billing.");

    releaseStale();
    await flushAsync();

    expect(stamp()).toHaveTextContent("on billing.");
  });
});
