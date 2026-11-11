// How one row of pg_stat_activity becomes a session (lib/db-activity.ts).
//
// The kinds and the times are pinned where people read them, in
// tests/component-live-activity.test.tsx. This pins the moment a query started,
// which POST /api/performance/cancel asks for back: it has to survive as text
// with all of PostgreSQL's digits, or the cancel would read as a different
// query, and it has to be there for a phone to offer Cancel at all.
import { ACTIVITY_SQL, CANCEL_SQL, toSession, type ActivityRow } from "@/lib/db-activity";

const ROW: ActivityRow = {
  pid: 4242,
  username: "app",
  application_name: "billing",
  client_addr: null,
  state: "active",
  wait_event_type: null,
  wait_event: null,
  query: "SELECT pg_sleep(600)",
  query_start_utc: "2026-11-01T09:30:00.123456Z",
  query_seconds: 12,
  xact_seconds: 12,
  state_seconds: 12,
} as unknown as ActivityRow;

describe("which sessions are read", () => {
  it("only this connection's own database, not every database on the server", () => {
    // pg_stat_activity covers the whole server. Without this filter a
    // statement running in another database is listed under this one.
    expect(ACTIVITY_SQL).toContain("AND datname = current_database()");
    expect(CANCEL_SQL).toContain("AND datname = current_database()");
  });
});

describe("the moment a query started", () => {
  it("is read as UTC text with its microseconds, so PostgreSQL can match it", () => {
    expect(ACTIVITY_SQL).toContain("query_start AT TIME ZONE 'UTC'");
    expect(ACTIVITY_SQL).toContain(`YYYY-MM-DD"T"HH24:MI:SS.US"Z"`);
    expect(ACTIVITY_SQL).toContain("AS query_start_utc");
  });

  it("passes through untouched", () => {
    expect(toSession(ROW, 30).queryStart).toBe("2026-11-01T09:30:00.123456Z");
  });

  it("is null for a session that has never run a query", () => {
    expect(toSession({ ...ROW, query_start_utc: null }, 30).queryStart).toBe(null);
  });
});
