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
 *                              [&fingerprint=<hex>][&days=<n>][&baseline=<runId>]
 *
 * Spec feature 8 — "store query history for comparison" — and feature 10's
 * "Historical Query Monitoring" and "compare historical performance with
 * current performance". One endpoint, because they are one table: see the note
 * at the top of lib/query-history.ts for why.
 *
 * Without a fingerprint this is the whole schema's history, newest first, plus
 * the day-by-day trend. With one, it is every run of that single query, plus a
 * comparison of the newest run against an older one — which is the thing
 * feature 10 asks for in so many words.
 *
 * Which older one is the caller's choice, through `baseline`. It defaults to
 * the run immediately before the newest, because that answers "did my last
 * change help?" and that is the common question. But it is the wrong baseline
 * for the other common question: a query that has crept slower over three
 * months does so a few percent at a time, and every consecutive pair looks
 * fine. Comparing against the run from before the slide is the only way to see
 * it, so the run to compare against is selectable rather than fixed.
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
   * Newest run against the chosen baseline. Null unless a fingerprint was asked
   * about and it has at least two runs — comparing two different queries would
   * be meaningless, and comparing one run with itself is not a comparison.
   */
  comparison: QueryComparison | null;
  /**
   * The id of the run `comparison` measured against, so the screen can mark it
   * in the list and keep its picker in step with what was actually compared.
   * Null whenever `comparison` is.
   */
  baselineId: number | null;
  /**
   * Set when a baseline was asked for and is not among this query's runs — it
   * was pruned by retention, or it belongs to a different query. The comparison
   * then falls back to the previous run, and the screen has to say so rather
   * than silently answering a different question than the one asked.
   */
  baselineNote: string | null;
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

/**
 * The run id to compare against, or null for "the one before the newest".
 *
 * `false` means the caller sent something that is not a run id at all. That is
 * refused rather than ignored, because ignoring it would answer with a
 * comparison against a different run than the one asked about, and the screen
 * would present it as the answer to the question that was asked.
 *
 * A run that is simply not in this query's history is a different case and is
 * handled below, where the rows are known — the id is well formed, it just is
 * not there any more.
 */
function readBaseline(raw: string | null): number | null | false {
  if (raw === null || raw === "") return null;
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : false;
}

export async function GET(request: NextRequest) {
  const gate = await requireViewer();
  if (!gate.ok) return gate.response;

  const params = request.nextUrl.searchParams;
  const connectionId = Number(params.get("connectionId") ?? "");
  const schema = (params.get("schema") ?? "").trim();
  const days = windowDays(params.get("days"));
  const fingerprint = readFingerprint(params.get("fingerprint"));
  const baselineId = readBaseline(params.get("baseline"));

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
  if (baselineId === false) {
    return NextResponse.json(
      { ok: false, error: "The baseline must be the id of a run in this query's history." },
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

  // rows[0] is the newest and rows[1] the one before it, because both list
  // functions order by captured_at DESC.
  //
  // A baseline is only meaningful among the runs of one query, so this whole
  // block is skipped without a fingerprint. rows[0] itself is refused as a
  // baseline: comparing the newest run with itself produces "about the same",
  // which reads as a real answer and is not one.
  let baselineRow: QueryHistoryRow | null = null;
  let baselineNote: string | null = null;
  if (fingerprint && rows.length >= 2) {
    if (baselineId === null) {
      baselineRow = rows[1];
    } else if (baselineId === rows[0].id) {
      // Comparing the newest run with itself produces "About the same speed as
      // before", which reads as a finding and is not one.
      baselineRow = rows[1];
      baselineNote =
        "The newest run cannot be its own baseline. This compares it against the run before it.";
    } else {
      const asked = rows.find((r) => r.id === baselineId) ?? null;
      baselineRow = asked ?? rows[1];
      if (!asked) {
        // Two ways to get here, and the message covers both without claiming
        // to know which: retention pruned the row while the screen was open,
        // or the id belongs to some other query. Saying "it has aged out"
        // outright would be a guess stated as a fact.
        baselineNote =
          "The run you picked as the baseline is not in this query's history — it has been " +
          "pruned, or it belongs to another query. This compares against the previous run instead.";
      }
    }
  }

  const view: HistoryView = {
    connectionName,
    schema,
    fingerprint,
    rows,
    days,
    trend,
    comparison: baselineRow ? compareRuns(rows[0], baselineRow) : null,
    baselineId: baselineRow ? baselineRow.id : null,
    baselineNote,
    retentionDays: QUERY_HISTORY_RETENTION_DAYS,
    maxRows: QUERY_HISTORY_MAX_ROWS,
    pageSize: HISTORY_PAGE_SIZE,
  };
  return NextResponse.json(view);
}
