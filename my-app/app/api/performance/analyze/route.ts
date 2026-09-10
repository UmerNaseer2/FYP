import { NextRequest, NextResponse } from "next/server";
import { requireEditor, requireViewer } from "@/lib/auth-guard";
import pool, { syncMetadataTables } from "@/lib/version-db";
import { buildPgConfig } from "@/lib/connection-config";
import { getPoolForConfig } from "@/lib/postgres";
import {
  containsTransactionControl,
  maskNonCode,
  splitStatements,
} from "@/lib/sql-guard";
import {
  describePlan,
  readPlan,
  readSql,
  sortFindings,
  type TableRows,
  summarizeFindings,
  type PlanSummary,
  type QueryFinding,
} from "@/lib/query-analysis";

/**
 * POST /api/performance/analyze
 *
 * Spec feature 08 — query execution analysis.
 *
 * Asks a target server what it would do with one query, and turns the answer
 * into something a person can act on. The analysis itself lives in
 * lib/query-analysis.ts, which never opens a connection; this file is the part
 * that has to be careful.
 *
 * Careful means four things, in order:
 *
 *   1. One statement. A box holding `SELECT 1; DROP TABLE users` is refused
 *      outright rather than analysed up to the semicolon, because the second
 *      half is the interesting one.
 *   2. No transaction control, for the same reason the deploy route refuses it —
 *      a COMMIT in the middle would end the wrapper the guard below depends on.
 *   3. A READ ONLY transaction, always. Plain EXPLAIN does not execute the
 *      query, but EXPLAIN ANALYZE does, and READ ONLY is what makes running an
 *      unfamiliar statement safe rather than merely unlikely to be a write.
 *   4. A statement timeout, and a ROLLBACK in a finally. Somebody will paste a
 *      query that takes four minutes, and this app should not hold a connection
 *      open waiting for it.
 */

/** What the plan is worth — see the guards above. */
type Mode = "estimate" | "measured";

export type AnalyzeRequest = {
  connectionId: number;
  schema: string;
  sql: string;
  /** True to run the query for real (EXPLAIN ANALYZE) inside the rollback. */
  measure?: boolean;
};

export type AnalyzeView = {
  connectionName: string;
  database: string;
  schema: string;
  mode: Mode;
  /** The one-line verdict, e.g. "Ran in 3.1 ms and returned 42 rows…". */
  headline: string;
  plan: PlanSummary;
  /** Findings from the plan and from the query text, merged and ranked. */
  findings: QueryFinding[];
  counts: { high: number; medium: number; low: number; total: number };
};

/**
 * How long a query gets before the server is told to stop.
 *
 * Generous enough that a genuinely slow query still produces the measurement
 * that proves it is slow — which is the whole point of asking — and short
 * enough that a runaway one gives the connection back.
 */
const STATEMENT_TIMEOUT_MS = 15_000;

/**
 * The same idea for the supplementary read of pg_class, but shorter. Nothing
 * downstream needs it — the analysis is only less sharp without it — so it gets
 * a third of the patience the user's own query gets.
 */
const SIZE_TIMEOUT_MS = 5_000;

export async function POST(request: NextRequest) {
  // Reading a plan is a read. Running the query — even rolled back — is not
  // something a viewer should be able to make somebody else's database do.
  const gate = await requireViewer();
  if (!gate.ok) return gate.response;

  let body: AnalyzeRequest;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON in request body." }, { status: 400 });
  }

  const connectionId = Number(body.connectionId);
  const schema = String(body.schema ?? "").trim();
  const sql = String(body.sql ?? "");
  const measure = body.measure === true;

  if (!connectionId) {
    return NextResponse.json({ error: "A connectionId is required." }, { status: 400 });
  }
  if (!schema) {
    return NextResponse.json({ error: "A schema is required." }, { status: 400 });
  }
  if (!sql.trim()) {
    return NextResponse.json({ error: "Enter a query to analyse." }, { status: 400 });
  }

  if (measure) {
    const editor = await requireEditor();
    if (!editor.ok) return editor.response;
  }

  // ── Guard the text before it goes anywhere near a server ──────────────────
  // splitStatements keeps a chunk that is nothing but a comment, because its
  // other callers need the statement text exactly as written. Here the question
  // is how many statements PostgreSQL would RUN, and a trailing "-- note" is
  // not one of them — counting it would refuse an ordinary annotated query.
  const statements = splitStatements(sql).filter(
    (statement) => maskNonCode(statement).trim().length > 0
  );
  if (statements.length === 0) {
    return NextResponse.json(
      { error: "There is no SQL here — only comments." },
      { status: 400 }
    );
  }
  if (statements.length > 1) {
    return NextResponse.json(
      {
        error:
          `This analyses one query at a time, and there are ${statements.length} here. ` +
          `Remove the extra statements, or the semicolons between them.`,
      },
      { status: 400 }
    );
  }
  if (containsTransactionControl(sql)) {
    return NextResponse.json(
      {
        error:
          "Remove the COMMIT / ROLLBACK. The plan is taken inside a transaction " +
          "that is always rolled back, and ending it early would defeat that.",
      },
      { status: 400 }
    );
  }

  // ── The saved connection ──────────────────────────────────────────────────
  let conn: {
    name: string;
    host: string;
    port: number;
    database_name: string;
    type: string;
    username: string;
    password: string;
    connection_string: string | null;
    ssl: boolean;
    ssl_mode: string | null;
  };
  try {
    await syncMetadataTables();
    const result = await pool.query(
      `SELECT name, host, port, database_name, type, username, password,
              connection_string, ssl, ssl_mode
         FROM connections
        WHERE id = $1`,
      [connectionId]
    );
    if (result.rows.length === 0) {
      return NextResponse.json(
        { error: `No saved connection found with id ${connectionId}.` },
        { status: 404 }
      );
    }
    conn = result.rows[0];
  } catch (error) {
    console.error("Query analysis — failed to read connection:", error);
    return NextResponse.json(
      { error: "Could not read the saved connection. Is the app database reachable?" },
      { status: 500 }
    );
  }

  if (conn.type !== "PostgreSQL") {
    return NextResponse.json(
      { error: "Query analysis reads PostgreSQL plans, so it needs a PostgreSQL connection." },
      { status: 400 }
    );
  }

  const target = getPoolForConfig(
    buildPgConfig({
      host: conn.host,
      port: conn.port,
      database: conn.database_name,
      user: conn.username,
      password: conn.password,
      connectionString: conn.connection_string,
      ssl: Boolean(conn.ssl),
      sslMode: conn.ssl_mode,
    })
  );

  let client;
  try {
    client = await target.connect();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Query analysis — could not connect:", message);
    return NextResponse.json(
      {
        error:
          `Could not connect to "${conn.name}" ` +
          `(${conn.host}:${conn.port}/${conn.database_name}). Details: ${message}`,
      },
      { status: 503 }
    );
  }

  // EXPLAIN ANALYZE executes the statement. READ ONLY is what makes that safe:
  // PostgreSQL itself refuses any write inside the transaction, so an UPDATE
  // pasted into the box fails with a clear error instead of running.
  const explain = measure
    ? `EXPLAIN (ANALYZE, COSTS, TIMING, FORMAT JSON) ${sql}`
    : `EXPLAIN (COSTS, FORMAT JSON) ${sql}`;

  let raw: unknown;
  try {
    await client.query("BEGIN READ ONLY");
    await client.query(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`);
    // quote_ident is the server's own quoting, applied server-side, so a schema
    // name never becomes part of the statement text this app assembles.
    await client.query("SELECT set_config('search_path', quote_ident($1) || ', public', true)", [
      schema,
    ]);
    const result = await client.query(explain);
    raw = result.rows[0]?.["QUERY PLAN"];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json(
      {
        error:
          message.includes("statement timeout") || message.includes("canceling statement")
            ? `The query was still running after ${STATEMENT_TIMEOUT_MS / 1000} seconds and was stopped. ` +
              `Analyse it without running it, or narrow it down first.`
            : `PostgreSQL would not run this: ${message}`,
      },
      { status: 400 }
    );
  } finally {
    // Always. The whole safety story above rests on this line, so it does not
    // sit behind a condition and its own failure cannot mask the real error.
    try {
      await client.query("ROLLBACK");
    } catch (error) {
      console.error("Query analysis — rollback failed:", error);
    }
    client.release();
  }

  // ── How big the tables in this schema really are ──────────────────────────
  // A plan says how many rows a step hands on, never how many it reads, so
  // without this the "whole table read" rule stays quiet on precisely the
  // queries it exists to catch. Read from the server's own statistics, on the
  // pool rather than the client above, so a failure here cannot disturb the
  // transaction that has just been rolled back.
  //
  // Not fatal on its own: everything below still works from the plan alone,
  // just less sharply, and losing the entire analysis because a role cannot
  // read pg_class would be the wrong trade.
  //
  // On its own client and inside its own read-only transaction, for the
  // statement_timeout: a catch handles a refusal, but nothing handles a hang,
  // and this runs after the reply to the user is already most of the way built.
  const tableRows: TableRows = {};
  const sizeClient = await target.connect();
  try {
    await sizeClient.query("BEGIN READ ONLY");
    await sizeClient.query(`SET LOCAL statement_timeout = ${SIZE_TIMEOUT_MS}`);
    const sizes = await sizeClient.query<{ table_name: string; row_count: string }>(
      `SELECT c.relname AS table_name,
              GREATEST(c.reltuples, 0)::bigint AS row_count
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1
          AND c.relkind IN ('r', 'p', 'm')`,
      [schema]
    );
    await sizeClient.query("COMMIT");
    for (const row of sizes.rows) {
      // reltuples is -1 until a table has been analysed, and GREATEST has
      // already turned that into 0 — which means "unknown", and falls through
      // to the plan's own number rather than claiming the table is empty.
      const count = Number(row.row_count);
      // Keyed with the schema, because that is how readPlan looks a step up:
      // a plan step reading another schema's table of the same name must not
      // be measured against this one.
      if (Number.isFinite(count) && count > 0) {
        tableRows[`${schema}.${row.table_name}`] = count;
      }
    }
  } catch (error) {
    console.error("Query analysis — table sizes unavailable:", error);
    // A rolled-back client is safe to hand back to the pool; one left mid
    // transaction is not, and this is the only place that knows to do it.
    await sizeClient.query("ROLLBACK").catch(() => {});
  } finally {
    sizeClient.release();
  }

  const plan = readPlan(raw, tableRows);
  if (!plan) {
    return NextResponse.json(
      {
        error:
          "The server replied, but the plan was not in a shape this app could read. " +
          "That usually means a PostgreSQL version older than this app expects.",
      },
      { status: 502 }
    );
  }

  const findings = sortFindings([...plan.findings, ...readSql(sql)]);
  const view: AnalyzeView = {
    connectionName: conn.name,
    database: conn.database_name,
    schema,
    mode: measure ? "measured" : "estimate",
    headline: describePlan(plan),
    plan,
    findings,
    counts: summarizeFindings(findings),
  };
  return NextResponse.json(view);
}
