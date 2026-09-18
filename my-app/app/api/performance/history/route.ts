import { NextRequest, NextResponse } from "next/server";
import { requireViewer } from "@/lib/auth-guard";
import pool, { syncMetadataTables } from "@/lib/version-db";
import {
  HISTORY_PAGE_SIZE,
  listQueryHistory,
  listRunsOfQuery,
  queryTrend,
  type QueryDayPoint,
} from "@/lib/query-history-db";
import {
  QUERY_HISTORY_MAX_ROWS,
  QUERY_HISTORY_RETENTION_DAYS,
  compareRuns,
  type QueryComparison,
  type QueryHistoryRow,
} from "@/lib/query-history";

/**
 * GET /api/performance/history?connectionId=<id>&schema=<name>
 *                              [&fingerprint=<hex>][&days=<n>]
 *
 * Spec feature 8 — "store query history for comparison" — and feature 10's
 * "Historical Query Monitoring" and "compare historical performance with
 * current performance". One endpoint, because they are one table: see the note
 * at the top of lib/query-history.ts for why.
 *
 * Without a fingerprint this is the whole schema's history, newest first, plus
 * the day-by-day trend. With one, it is every run of that single query, plus
 * the comparison between its two most recent runs — which is the thing feature
 * 10 asks for in so many words.
 *
 * The rows are written by POST /api/performance/analyze. Nothing is collected
 * in the background, so an empty history means nobody has analysed anything
 * here yet, and the screen says exactly that rather than drawing an empty
 * chart that reads as "nothing happened".
 */

export type HistoryView = {
  connectionName: string;
  schema: string;
  /** The fingerprint asked about, or null for the whole schema. */
  fingerprint: string | null;
  /** Newest first. Capped at one page — see HISTORY_PAGE_SIZE. */
  rows: QueryHistoryRow[];
  /** How many days the trend covers. */
  days: number;
  /** One point per day that had at least one analysis. Oldest first. */
  trend: QueryDayPoint[];
  /**
   * Newest run against the one before it. Null unless a fingerprint was asked
   * about and it has at least two runs — comparing two different queries would
   * be meaningless, and comparing one run with itself is not a comparison.
   */
  comparison: QueryComparison | null;
  /** How long a row is kept, and how many are kept per schema. */
  retentionDays: number;
  maxRows: number;
  pageSize: number;
};

/** Windows the screen has a button for. Same set as the metrics chart. */
const WINDOWS = [1, 7, 30, 90];
const DEFAULT_WINDOW = 30;

/** Snap a requested window onto one of the buttons — see the metrics route. */
function windowDays(raw: string | null): number {
  const asked = Number(raw ?? "");
  if (!Number.isFinite(asked) || asked <= 0) return DEFAULT_WINDOW;
  return WINDOWS.find((w) => w >= asked) ?? WINDOWS[WINDOWS.length - 1];
}

/**
 * A fingerprint is eight hex characters (lib/query-history.ts). Anything else
 * is refused rather than passed to the query as a value that cannot match —
 * a silent empty list would read as "this query has never been run".
 */
function readFingerprint(raw: string | null): string | null | false {
  if (raw === null || raw === "") return null;
  return /^[0-9a-f]{8}$/.test(raw) ? raw : false;
}

export async function GET(request: NextRequest) {
  const gate = await requireViewer();
  if (!gate.ok) return gate.response;

  const params = request.nextUrl.searchParams;
  const connectionId = Number(params.get("connectionId") ?? "");
  const schema = (params.get("schema") ?? "").trim();
  const days = windowDays(params.get("days"));
  const fingerprint = readFingerprint(params.get("fingerprint"));

  if (!connectionId) {
    return NextResponse.json(
      { ok: false, error: "A connectionId query parameter is required." },
      { status: 400 }
    );
  }
  if (!schema) {
    return NextResponse.json(
      { ok: false, error: "A schema query parameter is required." },
      { status: 400 }
    );
  }
  if (fingerprint === false) {
    return NextResponse.json(
      { ok: false, error: "That is not a query fingerprint." },
      { status: 400 }
    );
  }

  // The connection is read for its name only. A deleted connection is NOT an
  // error here the way it is elsewhere: query_history.connection_id is
  // deliberately not a foreign key, so history outlives the connection it was
  // captured against, and refusing to show it would throw away the only record
  // that the work was ever done.
  let connectionName: string;
  try {
    await syncMetadataTables();
    const result = await pool.query<{ name: string }>(
      `SELECT name FROM connections WHERE id = $1`,
      [connectionId]
    );
    connectionName = result.rows[0]?.name ?? "(deleted connection)";
  } catch (error) {
    console.error("Query history — failed to read connection:", error);
    return NextResponse.json(
      { ok: false, error: "Could not read the saved connection. Is the app database reachable?" },
      { status: 500 }
    );
  }

  let rows: QueryHistoryRow[];
  let trend: QueryDayPoint[];
  try {
    // Reads are not best-effort here — an unreadable table must say so rather
    // than return an empty list that reads as "nothing has ever been analysed".
    [rows, trend] = await Promise.all([
      fingerprint
        ? listRunsOfQuery(connectionId, schema, fingerprint)
        : listQueryHistory(connectionId, schema),
      queryTrend(connectionId, schema, days),
    ]);
  } catch (error) {
    console.error("Query history — failed to read history:", error);
    return NextResponse.json(
      { ok: false, error: "Could not read the query history for this schema." },
      { status: 500 }
    );
  }

  const view: HistoryView = {
    connectionName,
    schema,
    fingerprint,
    rows,
    days,
    trend,
    // rows[0] is the newest and rows[1] the one before it, because both list
    // functions order by captured_at DESC.
    comparison: fingerprint && rows.length >= 2 ? compareRuns(rows[0], rows[1]) : null,
    retentionDays: QUERY_HISTORY_RETENTION_DAYS,
    maxRows: QUERY_HISTORY_MAX_ROWS,
    pageSize: HISTORY_PAGE_SIZE,
  };
  return NextResponse.json(view);
}
