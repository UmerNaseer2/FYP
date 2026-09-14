import { NextRequest, NextResponse } from "next/server";
import type { PoolClient } from "pg";
import { requireEditor, requireViewer } from "@/lib/auth-guard";
import pool, { syncMetadataTables } from "@/lib/version-db";
import { buildPgConfig } from "@/lib/connection-config";
import { UNREADABLE_CREDENTIALS_MESSAGE } from "@/lib/secret-store";
import { getPoolForConfig } from "@/lib/postgres";
import {
  QUERY_TIMEOUT_SECONDS,
  buildExplainSql,
  catalogFromRows,
  checkAnalysable,
  checkPlanIsReadOnly,
  describePlan,
  describeQueryError,
  explainPrefix,
  planMentionsDenied,
  planRelations,
  planSteps,
  readPlan,
  readSql,
  sortFindings,
  sqlContextFromPlan,
  summarizeFindings,
  toQueryError,
  type AnalyzeView,
  type CatalogRows,
  type PlanStep,
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
 * Careful means these steps, in this order:
 *
 *   1. Only one query that reads data gets in (checkAnalysable). One
 *      statement, no COMMIT, no EXPLAIN of its own, nothing that starts with
 *      UPDATE / INSERT / DELETE and friends, no SELECT … INTO. All decided from
 *      the text alone, before any server hears about it.
 *   2. A READ ONLY transaction, always, with a statement_timeout and a
 *      lock_timeout. The lock timeout matters because a query stuck behind
 *      somebody else's ALTER TABLE is waiting, not slow, and should be told so.
 *   3. A plain EXPLAIN first, which plans the query without running it. Its
 *      plan is checked for a write or a row lock hiding behind an innocent
 *      first word (a DELETE inside a WITH block, a SELECT … FOR UPDATE).
 *   4. Only then, and only when an editor asked to measure, EXPLAIN ANALYZE,
 *      which really runs the query. Before it runs, the query and its plan are
 *      checked against a list of functions that act on the server itself
 *      (ending sessions, reloading settings, writing files, taking advisory
 *      locks that outlive the transaction). READ ONLY does not stop any of
 *      those.
 *   5. A ROLLBACK in a finally, whatever happened. After a measured run the
 *      connection is then closed rather than handed to the next request,
 *      because some of what a query can do to a session outlives a ROLLBACK.
 *
 * None of this is a sandbox. READ ONLY stops writes to tables and nothing
 * else, and the list in step 4 names known cases, not every possible one: a
 * user-defined function can call any of them internally. What a query can
 * really do is decided by the permissions of the database user this
 * connection signs in as, and the screen says so next to the Measure tick-box.
 */

export type AnalyzeRequest = {
  connectionId: number;
  schema: string;
  sql: string;
  /** True to run the query for real (EXPLAIN ANALYZE) inside the rollback. */
  measure?: boolean;
};

// The response shape, AnalyzeView, lives in lib/query-analysis.ts so this
// route and the screen that reads it share one definition.

/** How long the user's query gets. See QUERY_TIMEOUT_SECONDS for the why. */
const STATEMENT_TIMEOUT_MS = QUERY_TIMEOUT_SECONDS * 1000;

/**
 * How long to wait for another session's lock before giving up.
 *
 * Without it, a query queued behind a running ALTER TABLE waited the full
 * statement timeout and was then reported as a slow query, blaming the query
 * for somebody else's lock. Five seconds rides out an ordinary short lock and
 * still lets the error say "locked" rather than "slow".
 */
const LOCK_TIMEOUT_MS = 5_000;

/**
 * The same idea for the catalog reads after the plan, but shorter. Nothing
 * downstream needs them (the analysis is only less sharp without them), so
 * they get a third of the patience the user's own query gets.
 */
const CATALOG_TIMEOUT_MS = 5_000;

/** Said when the server answered with something that is not a readable plan. */
const UNREADABLE_PLAN =
  "The server answered, but not with a plan this screen can read. That usually " +
  "means an older PostgreSQL version, or a database that only looks like " +
  "PostgreSQL. Check the server's version with whoever looks after it.";

/** Every refusal from this route has the same shape: { ok: false, error }. */
function fail(error: string, status: number) {
  return NextResponse.json({ ok: false, error }, { status });
}

// ── The catalog reads ────────────────────────────────────────────────────────
// Every one takes the plan's tables as two parallel text arrays, $1 the
// schemas and $2 the names, and unnest pairs them back up on the server. The
// names are bind parameters, so they never become part of the SQL text.

/**
 * How many rows each table holds, from the planner's own statistics.
 * reltuples is -1 until a table has been analysed; GREATEST turns that into 0,
 * which catalogFromRows reads as "unknown". Only tables, partitioned tables and
 * materialised views: a view has no rows of its own.
 */
const SIZES_SQL = `
  SELECT n.nspname AS schema_name,
         c.relname AS table_name,
         GREATEST(c.reltuples, 0)::bigint AS row_count
    FROM unnest($1::text[], $2::text[]) AS r(schema_name, table_name)
    JOIN pg_namespace n ON n.nspname = r.schema_name
    JOIN pg_class c ON c.relnamespace = n.oid AND c.relname = r.table_name
   WHERE c.relkind IN ('r', 'p', 'm')`;

/** Each table's columns in table order, with their types as a person writes them. */
const COLUMNS_SQL = `
  SELECT n.nspname AS schema_name,
         c.relname AS table_name,
         a.attname::text AS column_name,
         format_type(a.atttypid, a.atttypmod) AS data_type,
         a.attnotnull AS not_null
    FROM unnest($1::text[], $2::text[]) AS r(schema_name, table_name)
    JOIN pg_namespace n ON n.nspname = r.schema_name
    JOIN pg_class c ON c.relnamespace = n.oid AND c.relname = r.table_name
    JOIN pg_attribute a ON a.attrelid = c.oid
   WHERE a.attnum > 0
     AND NOT a.attisdropped
   ORDER BY n.nspname, c.relname, a.attnum`;

/**
 * Each table's indexes, with their key columns in index order.
 *
 * Only the first indnkeyatts positions are key columns; the rest are INCLUDE
 * columns, which cannot be searched on and so are left out. An expression key
 * (LOWER(email)) has attnum 0, matches no pg_attribute row, and comes back as
 * NULL. attname is cast to text because node-pg parses text[] into an array
 * but leaves name[] as a string.
 */
const INDEXES_SQL = `
  SELECT n.nspname AS schema_name,
         c.relname AS table_name,
         ic.relname AS index_name,
         i.indisprimary AS is_primary,
         i.indisunique AS is_unique,
         i.indisvalid AS is_valid,
         ARRAY(
           SELECT a.attname::text
             FROM generate_series(0, i.indnkeyatts - 1) AS k(ord)
             LEFT JOIN pg_attribute a
               ON a.attrelid = c.oid AND a.attnum = i.indkey[k.ord]
            ORDER BY k.ord
         ) AS columns
    FROM unnest($1::text[], $2::text[]) AS r(schema_name, table_name)
    JOIN pg_namespace n ON n.nspname = r.schema_name
    JOIN pg_class c ON c.relnamespace = n.oid AND c.relname = r.table_name
    JOIN pg_index i ON i.indrelid = c.oid
    JOIN pg_class ic ON ic.oid = i.indexrelid
   ORDER BY 1, 2, 3`;

/**
 * Every relation name already taken in the plan's schemas: tables, indexes,
 * views, sequences. A suggested index needs a name none of them has.
 */
const RELATION_NAMES_SQL = `
  SELECT n.nspname AS schema_name,
         c.relname::text AS relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = ANY($1::text[])`;

/** The settings that decide how hard the planner tries with many joins. */
const SETTINGS_SQL = `
  SELECT current_setting('join_collapse_limit') AS join_collapse_limit,
         current_setting('geqo_threshold') AS geqo_threshold,
         current_setting('geqo') AS geqo`;

/**
 * Read what the plan cannot say about its own tables, into `rows`.
 *
 * Runs on the same client and inside the same READ ONLY transaction as the
 * EXPLAIN, just before the ROLLBACK, so there is no second connection to open
 * or to fail to open. The tables come from the plan itself, as the (Schema,
 * Relation Name) pairs PostgreSQL resolved, so a table reached through public
 * is read as well as one in the chosen schema.
 *
 * Fills `rows` one result at a time. A failure stops at that point and keeps
 * what was already read; the caller treats the whole read as optional.
 */
async function readCatalog(
  client: PoolClient,
  steps: PlanStep[],
  rows: Partial<CatalogRows>
): Promise<void> {
  await client.query(`SET LOCAL statement_timeout = ${CATALOG_TIMEOUT_MS}`);

  const { schemas, names } = planRelations(steps);
  if (names.length > 0) {
    const pairs = [schemas, names];
    rows.sizes = (await client.query<CatalogRows["sizes"][number]>(SIZES_SQL, pairs)).rows;
    rows.columns = (await client.query<CatalogRows["columns"][number]>(COLUMNS_SQL, pairs)).rows;
    rows.indexes = (await client.query<CatalogRows["indexes"][number]>(INDEXES_SQL, pairs)).rows;
    const uniqueSchemas = Array.from(new Set(schemas));
    rows.relationNames = (
      await client.query<CatalogRows["relationNames"][number]>(RELATION_NAMES_SQL, [
        uniqueSchemas,
      ])
    ).rows;
  }

  const settings = await client.query<NonNullable<CatalogRows["settings"]>>(SETTINGS_SQL);
  rows.settings = settings.rows[0] ?? null;
}

export async function POST(request: NextRequest) {
  // Reading a plan is a read. Running the query — even rolled back — is not
  // something a viewer should be able to make somebody else's database do.
  const gate = await requireViewer();
  if (!gate.ok) return gate.response;

  let body: Partial<AnalyzeRequest> | null;
  try {
    body = await request.json();
  } catch {
    return fail("The request could not be read. Reload the page and try again.", 400);
  }
  if (typeof body !== "object" || body === null) {
    return fail("The request could not be read. Reload the page and try again.", 400);
  }

  const connectionId = Number(body.connectionId);
  const schema = String(body.schema ?? "").trim();
  const sql = String(body.sql ?? "");
  const measure = body.measure === true;

  if (!connectionId) return fail("Choose a connection above before analysing a query.", 400);
  if (!schema) return fail("Choose a schema above before analysing a query.", 400);

  if (measure) {
    const editor = await requireEditor();
    if (!editor.ok) return editor.response;
  }

  // ── Decide from the text alone, before any server hears about it ──────────
  const refused = checkAnalysable(sql, measure);
  if (refused) return fail(refused, 400);

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
      return fail(
        `No saved connection has id ${connectionId}. It may have been deleted. ` +
          `Choose a connection above and try again.`,
        404
      );
    }
    conn = result.rows[0];
  } catch (error) {
    console.error("Query analysis — failed to read connection:", error);
    return fail(
      "Could not read the saved connection, because the app's own database did " +
        "not answer. Check that it is running, then try again.",
      500
    );
  }

  if (conn.type !== "PostgreSQL") {
    return fail(
      "Query analysis reads PostgreSQL plans, so it needs a PostgreSQL connection. " +
        "Choose one above.",
      400
    );
  }

  // buildPgConfig decrypts the saved password, and throws when this server's
  // APP_ENCRYPTION_KEY is missing or is not the key it was saved with. Left
  // uncaught, that was a bare 500 instead of { ok: false, error }.
  let targetConfig: ReturnType<typeof buildPgConfig>;
  try {
    targetConfig = buildPgConfig({
      host: conn.host,
      port: conn.port,
      database: conn.database_name,
      user: conn.username,
      password: conn.password,
      connectionString: conn.connection_string,
      ssl: Boolean(conn.ssl),
      sslMode: conn.ssl_mode,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Query analysis — could not read the saved connection's credentials:", message);
    return fail(UNREADABLE_CREDENTIALS_MESSAGE, 500);
  }
  const target = getPoolForConfig(targetConfig);

  let client: PoolClient;
  try {
    client = await target.connect();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Query analysis — could not connect:", message);
    return fail(
      `Could not connect to "${conn.name}" ` +
        `(${conn.host}:${conn.port}/${conn.database_name}). Check that the server ` +
        `is running and that the saved connection details are right, then try ` +
        `again. Details: ${message}`,
      503
    );
  }

  let raw: unknown;
  const rows: Partial<CatalogRows> = {};
  // Which EXPLAIN was running when an error arrived. PostgreSQL counts an
  // error's position from the start of everything it was sent, and the two
  // EXPLAIN prefixes differ in length.
  let measuring = false;
  try {
    await client.query("BEGIN READ ONLY");
    await client.query(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`);
    await client.query(`SET LOCAL lock_timeout = ${LOCK_TIMEOUT_MS}`);
    // quote_ident is the server's own quoting, applied server-side, so a schema
    // name never becomes part of the statement text this app assembles.
    await client.query("SELECT set_config('search_path', quote_ident($1) || ', public', true)", [
      schema,
    ]);

    // ── 1. Plan it without running it ──
    const estimate = await client.query(buildExplainSql(sql, false));
    raw = estimate.rows[0]?.["QUERY PLAN"];
    const steps = planSteps(raw);
    if (!steps) return fail(UNREADABLE_PLAN, 502);

    // ── 2. Check what the plan says the query really does ──
    const writes = checkPlanIsReadOnly(steps);
    if (writes) return fail(writes, 400);

    // ── 3. Only now, and only when asked, run it for real ──
    if (measure) {
      const denied = planMentionsDenied(steps);
      if (denied) return fail(denied, 400);
      measuring = true;
      const measured = await client.query(buildExplainSql(sql, true));
      raw = measured.rows[0]?.["QUERY PLAN"];
    }

    // ── 4. What the plan cannot say about its own tables ──
    // Optional. A failure here aborts a transaction that is about to be rolled
    // back anyway, and every rule still works from the plan's own numbers.
    try {
      await readCatalog(client, planSteps(raw) ?? steps, rows);
    } catch (error) {
      console.error(
        "Query analysis — catalog details unavailable:",
        error instanceof Error ? error.message : error
      );
    }
  } catch (error) {
    const err = toQueryError(error);
    console.error("Query analysis — the query failed:", err.code ?? "(no code)", err.message);
    return fail(
      describeQueryError(err, schema, QUERY_TIMEOUT_SECONDS, {
        sql,
        prefixLength: explainPrefix(measuring).length,
      }),
      400
    );
  } finally {
    // Always. The whole safety story above rests on this line, so it does not
    // sit behind a condition and its own failure cannot mask the real error.
    let broken = false;
    try {
      await client.query("ROLLBACK");
    } catch (error) {
      broken = true;
      console.error("Query analysis — rollback failed:", error);
    }
    // A client whose ROLLBACK failed may still be inside the transaction.
    // release(true) closes it instead of handing it to the next request.
    // A measured query is closed the same way: it really ran, and a function
    // it called can leave something on the session that ROLLBACK does not
    // undo (a session advisory lock taken inside a function of the user's
    // own, say, which no check here can see into).
    client.release(broken || measuring);
  }

  const catalog = catalogFromRows(rows);
  const plan = readPlan(raw, catalog);
  if (!plan) return fail(UNREADABLE_PLAN, 502);

  // The text rules judge the query by its real size too: how many rows come
  // back, how big each table is, what the primary keys and join settings
  // are. All of it comes from the plan and catalog already read above, so no
  // further query is run.
  const findings = sortFindings([
    ...plan.findings,
    ...readSql(sql, sqlContextFromPlan(plan, catalog)),
  ]);
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
