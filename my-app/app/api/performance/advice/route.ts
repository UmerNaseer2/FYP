import { NextRequest, NextResponse } from "next/server";
import { requireViewer } from "@/lib/auth-guard";
import pool, { syncMetadataTables } from "@/lib/version-db";
import { buildPgConfig } from "@/lib/connection-config";
import { fetchSchemaSnapshot, getPoolForConfig, withoutToolTables } from "@/lib/postgres";
import type { PoolClient } from "pg";
import {
  STATS_LOCK_TIMEOUT_MS,
  STATS_STATEMENT_TIMEOUT_MS,
  STRUCTURE_LOCK_TIMEOUT_MS,
  analyzeSchemaPerformance,
  analyzeTableStats,
  attachForeignKeyIndexes,
  foreignKeyIndexes,
  withoutRepeatedDrops,
  describeStatsError,
  describeStructureError,
  sortAdvice,
  summarizeAdvice,
  type AdviceItem,
  type AdviceView,
  type IndexStats,
  type TableStats,
} from "@/lib/perf-advice";

/**
 * GET /api/performance/advice?connectionId=<id>&schema=<name>
 *
 * Spec feature 09 — performance suggestions.
 *
 * Two independent passes over one schema, deliberately not merged in the
 * analyzer (see lib/perf-advice.ts): the structural rules read the snapshot the
 * introspector already knows how to take, and the statistics rules read
 * PostgreSQL's own counters. They are merged HERE, tagged with which pass found
 * them, because a reader needs to know that "this index has not been used"
 * came from counters that only reach back to when they last started, while
 * "this foreign key has no index" is simply true.
 *
 * The statistics half is allowed to fail on its own. pg_stat_user_tables is
 * readable by anyone, but a connection can still be pointed at a replica with
 * cold counters or a role that cannot see the size functions — and losing the
 * structural advice too because of that would be the wrong trade. It also runs
 * under a time limit and a lock-wait limit, so a busy server costs the page
 * those suggestions rather than the page itself, and describeStatsError tells
 * the reader which of those happened.
 *
 * Reading the structure has a lock-wait limit of its own too
 * (STRUCTURE_LOCK_TIMEOUT_MS): some of its catalog reads lock the tables they
 * describe, and without the limit a running ALTER TABLE would hold the page
 * for the snapshot's full 30 seconds before failing with a message that
 * blames the connection. describeStructureError says what really happened.
 *
 * The structural rules run after pass two, not before, because pass two is
 * what knows which indexes PostgreSQL has marked invalid, and the duplicate
 * and redundant rules must not count those as copies. Pass two also gets the
 * snapshot's foreign keys, so an unused index that the last check of a foreign
 * key goes through is not offered for DROP.
 *
 * Nothing here writes: both passes only read, and pass two runs inside a
 * READ ONLY transaction, which the server enforces.
 */

// AdviceItem and AdviceView live in lib/perf-advice.ts, so this route and the
// screen that reads its response share one definition instead of two copies
// that could drift apart without anyone noticing.

/** Bookkeeping this tool writes into the schemas it manages. */
const TOOL_TABLES = ["script_patch", "script_patch_reverted"];

/**
 * PostgreSQL reports every counter as a bigint, and node-pg hands a bigint back
 * as a STRING so that values past 2^53 survive the trip. Every rule in
 * lib/perf-advice does arithmetic on these, and `"5000" > "100" * 10` is not
 * arithmetic, so each one is converted exactly once, here.
 */
function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

export async function GET(request: NextRequest) {
  const gate = await requireViewer();
  if (!gate.ok) return gate.response;

  const connectionId = Number(request.nextUrl.searchParams.get("connectionId") ?? "");
  const schema = (request.nextUrl.searchParams.get("schema") ?? "").trim();

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

  // ── The saved connection, read from the same pool the rest of the app uses ──
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
        { ok: false, error: `No saved connection found with id ${connectionId}.` },
        { status: 404 }
      );
    }
    conn = result.rows[0];
  } catch (error) {
    console.error("Performance advice — failed to read connection:", error);
    return NextResponse.json(
      { ok: false, error: "Could not read the saved connection. Is the app database reachable?" },
      { status: 500 }
    );
  }

  if (conn.type !== "PostgreSQL") {
    return NextResponse.json(
      { ok: false, error: "Performance advice is only available for PostgreSQL connections." },
      { status: 400 }
    );
  }

  const cfg = buildPgConfig({
    host: conn.host,
    port: conn.port,
    database: conn.database_name,
    user: conn.username,
    password: conn.password,
    connectionString: conn.connection_string,
    ssl: Boolean(conn.ssl),
    sslMode: conn.ssl_mode,
  });

  // ── Pass one: the schema's structure ──────────────────────────────────────
  const captured = await fetchSchemaSnapshot(cfg, schema, {
    lockTimeoutMs: STRUCTURE_LOCK_TIMEOUT_MS,
  });
  if (!captured.ok) {
    return NextResponse.json(
      { ok: false, error: describeStructureError(schema, conn.name, captured) },
      { status: 502 }
    );
  }

  // The tool's own ledger tables are not the user's schema, and advice about
  // them is advice they cannot act on.
  const snapshot = withoutToolTables(captured.data);

  // ── Pass two: the server's own counters ───────────────────────────────────
  // On a connection of its own, inside one read-only transaction, so these
  // settings apply to these reads and to nothing else that shares the pool
  // (SET LOCAL ends with the transaction):
  //   • statement_timeout: counters over a schema with thousands of tables can
  //     take a while, and the structural advice is already waiting;
  //   • lock_timeout: pg_relation_size locks each index it measures, so a
  //     running ALTER TABLE would otherwise hold the whole page up;
  //   • search_path = pg_catalog: pg_get_indexdef then writes the table's
  //     schema out in full, so a definition shown as an undo means the same
  //     thing whatever search_path the reader pastes it into.
  let runtime: AdviceItem[] = [];
  let statsUnavailable: string | null = null;
  // The indexes PostgreSQL has marked invalid, for the structural rules below.
  // Stays empty when this pass fails.
  let invalidIndexes: ReadonlySet<string> = new Set();
  let client: PoolClient | null = null;
  // Set when even ROLLBACK failed. The connection is then in an unknown state,
  // and release(true) closes it instead of handing it to the next request.
  let broken = false;
  try {
    client = await getPoolForConfig(cfg).connect();
    await client.query("BEGIN READ ONLY");
    // Numbers from constants, not from the request, so writing them into the
    // text is safe (SET does not take bind parameters).
    await client.query(`SET LOCAL statement_timeout = ${STATS_STATEMENT_TIMEOUT_MS}`);
    await client.query(`SET LOCAL lock_timeout = ${STATS_LOCK_TIMEOUT_MS}`);
    await client.query("SET LOCAL search_path = pg_catalog");

    const tableRows = await client.query(
      `SELECT s.relname                                   AS table_name,
              COALESCE(s.seq_scan, 0)                     AS seq_scan,
              COALESCE(s.seq_tup_read, 0)                 AS seq_tup_read,
              COALESCE(s.idx_scan, 0)                     AS idx_scan,
              COALESCE(s.n_live_tup, 0)                   AS n_live_tup,
              COALESCE(s.n_dead_tup, 0)                   AS n_dead_tup,
              GREATEST(s.last_analyze, s.last_autoanalyze) AS last_analyzed,
              COALESCE(io.heap_blks_hit, 0)               AS heap_blks_hit,
              COALESCE(io.heap_blks_read, 0)              AS heap_blks_read,
              -- What ANALYZE collected, which outlives a statistics reset.
              -- pg_stats shows only columns this login may read, which for
              -- the schema's own tables is all of them.
              EXISTS (SELECT 1 FROM pg_stats st
                       WHERE st.schemaname = s.schemaname
                         AND st.tablename = s.relname)    AS has_statistics
         FROM pg_stat_user_tables s
         LEFT JOIN pg_statio_user_tables io ON io.relid = s.relid
        WHERE s.schemaname = $1
          AND s.relname <> ALL($2::text[])`,
      [schema, TOOL_TABLES]
    );

    // backs_constraint counts only the constraints that own an index (primary
    // key, unique, exclusion); a foreign key also records an index, but it is
    // the one on the table it points at. is_partition_child is one partition's
    // piece of a partitioned table's index, which cannot be dropped alone.
    const indexRows = await client.query(
      `SELECT s.relname                        AS table_name,
              s.indexrelname                   AS index_name,
              COALESCE(s.idx_scan, 0)          AS idx_scan,
              ix.indisunique                   AS is_unique,
              ix.indisprimary                  AS is_primary,
              ix.indisvalid                    AS is_valid,
              EXISTS (SELECT 1 FROM pg_constraint co
                       WHERE co.conindid = s.indexrelid
                         AND co.contype IN ('p', 'u', 'x')) AS backs_constraint,
              EXISTS (SELECT 1 FROM pg_inherits i
                       WHERE i.inhrelid = s.indexrelid)     AS is_partition_child,
              pg_relation_size(s.indexrelid)   AS size_bytes,
              pg_get_indexdef(s.indexrelid)    AS definition
         FROM pg_stat_user_indexes s
         JOIN pg_index ix ON ix.indexrelid = s.indexrelid
        WHERE s.schemaname = $1
          AND s.relname <> ALL($2::text[])`,
      [schema, TOOL_TABLES]
    );

    // When the counters last started from nothing, as a lower bound: the
    // latest of an explicit reset of this database's counters (a reset of one
    // table's counters stamps it too), the archiver's reset time, which the
    // server also stamps when it throws all counters away after a crash, and
    // the server's start. Taking the latest can only make the date later than
    // the truth, never earlier, so "not used since at least then" stays true.
    const counterRows = await client.query(
      `SELECT GREATEST(d.stats_reset, a.stats_reset, pg_postmaster_start_time()) AS counters_since
         FROM pg_stat_database d
         CROSS JOIN pg_stat_archiver a
        WHERE d.datname = current_database()`
    );
    await client.query("COMMIT");

    const tables: TableStats[] = tableRows.rows.map((r) => ({
      table_name: String(r.table_name),
      seq_scan: num(r.seq_scan),
      seq_tup_read: num(r.seq_tup_read),
      idx_scan: num(r.idx_scan),
      n_live_tup: num(r.n_live_tup),
      n_dead_tup: num(r.n_dead_tup),
      last_analyzed: r.last_analyzed ? new Date(r.last_analyzed).toISOString() : null,
      heap_blks_hit: num(r.heap_blks_hit),
      heap_blks_read: num(r.heap_blks_read),
      has_statistics: Boolean(r.has_statistics),
    }));

    const indexes: IndexStats[] = indexRows.rows.map((r) => ({
      table_name: String(r.table_name),
      index_name: String(r.index_name),
      idx_scan: num(r.idx_scan),
      is_unique: Boolean(r.is_unique),
      is_primary: Boolean(r.is_primary),
      is_valid: Boolean(r.is_valid),
      backs_constraint: Boolean(r.backs_constraint),
      is_partition_child: Boolean(r.is_partition_child),
      size_bytes: num(r.size_bytes),
      definition: String(r.definition ?? ""),
    }));

    const since = counterRows.rows[0]?.counters_since;
    const countersSince = since ? new Date(since).toISOString() : null;

    // Index names are unique within a schema, so a name alone is enough.
    invalidIndexes = new Set(indexes.filter((i) => !i.is_valid).map((i) => i.index_name));

    runtime = analyzeTableStats(
      schema,
      tables,
      indexes,
      countersSince,
      new Date(),
      foreignKeyIndexes(snapshot)
    ).map((a) => ({ ...a, origin: "statistics" }));
  } catch (error) {
    // Deliberately not fatal — see the note at the top of this file.
    if (client) {
      try {
        await client.query("ROLLBACK");
      } catch {
        broken = true;
      }
    }
    const message = error instanceof Error ? error.message : String(error);
    console.error("Performance advice — statistics unavailable:", message);
    statsUnavailable = describeStatsError(error);
  } finally {
    client?.release(broken);
  }

  // ── The structural rules ──────────────────────────────────────────────────
  // After pass two, so the duplicate and redundant rules can leave out the
  // invalid indexes it found (queries never use one, so it copies nothing).
  // When pass two failed the set is empty, and a copy that REINDEX
  // CONCURRENTLY left behind is still known by its name.
  const structural: AdviceItem[] = analyzeSchemaPerformance(snapshot, invalidIndexes).map(
    (a) => ({ ...a, origin: "structure" })
  );

  // A whole-table-read finding on a table with an unindexed foreign key gets
  // that key's index as its fix (see attachForeignKeyIndexes), and an unused
  // index that a duplicate or redundant finding already drops is not offered
  // a second time (see withoutRepeatedDrops).
  const advice = sortAdvice(
    withoutRepeatedDrops(attachForeignKeyIndexes([...structural, ...runtime]))
  );

  const view: AdviceView = {
    connectionName: conn.name,
    database: snapshot.database,
    schema: snapshot.schema,
    advice,
    counts: summarizeAdvice(advice),
    tablesAnalyzed: snapshot.tables.length,
    statsUnavailable,
  };

  return NextResponse.json(view);
}
