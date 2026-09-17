import { NextRequest, NextResponse } from "next/server";
import { requireViewer } from "@/lib/auth-guard";
import pool, { syncMetadataTables } from "@/lib/version-db";
import { buildPgConfig } from "@/lib/connection-config";
import { UNREADABLE_CREDENTIALS_MESSAGE } from "@/lib/secret-store";
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
  type PerfAdvice,
  type TableStats,
  type WaitingPartition,
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
 * and redundant rules must not count those as copies. That list is read from
 * pg_index first thing in pass two, so it holds even when a later read of the
 * pass fails, and it includes a partitioned table's own index, which the
 * counters never list. Pass two also gets the snapshot's foreign keys, so an
 * unused index that the last check of a foreign key goes through is not
 * offered for DROP.
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

/**
 * The partitions an unfinished partitioned index is waiting for, as the query
 * below builds them. node-pg parses json itself, so this only checks the
 * shape. Anything but a list comes back as undefined, and the finding then
 * falls back to general advice instead of claiming nothing is waiting.
 */
function waitingOn(value: unknown): WaitingPartition[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value
    .filter((w): w is Record<string, unknown> => typeof w === "object" && w !== null)
    .map((w) => ({
      schema: String(w.schema ?? ""),
      table: String(w.table ?? ""),
      partitioned: w.partitioned === true,
      foreign: w.foreign === true,
      foreign_below: w.foreign_below === true,
      attached: typeof w.attached === "string" ? w.attached : null,
    }));
}

/** One of an unfinished partitioned index's attached copies, or null. */
function attachedExample(value: unknown): { schema: string; name: string } | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.schema !== "string" || typeof v.name !== "string") return null;
  return { schema: v.schema, name: v.name };
}

/** The index at the top of the tree a partition's copy belongs to, or null. */
function topIndex(value: unknown): { schema: string; table: string; name: string } | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.schema !== "string" || typeof v.table !== "string" || typeof v.name !== "string") {
    return null;
  }
  return { schema: v.schema, table: v.table, name: v.name };
}

/**
 * The structural rules that decide what to do with one index by looking at
 * another, and so are only as good as the list of invalid indexes.
 *
 * "duplicate-index" and "redundant-index" drop an index because a second one
 * does the same job; "no-primary-key" can build the key out of an index it
 * found. All three read the same filtered groups, and an invalid index that
 * was not filtered out looks to them like a perfectly good one — so the index
 * they keep, or adopt, can be the broken one, and the DROP goes to its healthy
 * twin. An invalid index is not exotic: it is what a CREATE INDEX
 * CONCURRENTLY that failed halfway leaves behind.
 */
const INDEX_AWARE_RULES = new Set(["duplicate-index", "redundant-index", "no-primary-key"]);

/**
 * Whether this suggestion would act on a particular index.
 *
 * Both halves are needed. The id alone would untick a "no primary key" whose
 * fix names its own columns and touches no index at all, which is sound advice
 * however the index list went. The statement alone would reach findings from
 * other rules — "invalid-index" itself drops an index, and that one is right
 * precisely BECAUSE the list was read.
 */
function actsOnAnIndex(advice: PerfAdvice): boolean {
  return (
    INDEX_AWARE_RULES.has(advice.id) && /\bDROP INDEX\b|\bUSING INDEX\b/.test(advice.fix)
  );
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

  // buildPgConfig decrypts the saved password, and throws when this server's
  // APP_ENCRYPTION_KEY is missing or is not the key it was saved with. Left
  // uncaught, that was a bare 500 instead of { ok: false, error }.
  let cfg: ReturnType<typeof buildPgConfig>;
  try {
    cfg = buildPgConfig({
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
    console.error("Performance advice — could not read the saved connection's credentials:", message);
    return NextResponse.json({ ok: false, error: UNREADABLE_CREDENTIALS_MESSAGE }, { status: 500 });
  }

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
  // Filled by the first read of this pass, so a later read failing keeps it.
  // Null only when the pass could not even start.
  let invalidIndexes: ReadonlySet<string> | null = null;
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

    // Every index PostgreSQL has marked invalid, read first so the structural
    // rules still get this list when a later read below fails. From pg_index
    // itself, because the per-index counters never list a partitioned table's
    // own index. Such an index made with ON ONLY (pg_dump writes it that way
    // too) stays unfinished until every partition has a finished copy
    // attached, so for those the query also gathers what the finding needs
    // to say how to finish it:
    //   • waiting_on: the partitions one level down with no finished copy
    //     attached, and whether each is partitioned, a foreign table, or has
    //     a foreign table below it, and which unfinished copy it has, if any;
    //   • attached_example: one copy that is attached, to attach again when
    //     nothing is waiting any more (PostgreSQL only checks at that moment);
    //   • top_index: for a partition's copy, the index at the top of its tree.
    const invalidRows = await client.query(
      `SELECT ic.relname                     AS index_name,
              c.relname                      AS table_name,
              ix.indisunique                 AS is_unique,
              ix.indisprimary                AS is_primary,
              ic.relkind = 'I'               AS is_partitioned,
              EXISTS (SELECT 1 FROM pg_inherits i
                       WHERE i.inhrelid = ix.indexrelid) AS is_partition_child,
              pg_get_indexdef(ix.indexrelid) AS definition,
              (SELECT pg_get_constraintdef(co.oid)
                 FROM pg_constraint co
                WHERE co.conindid = ix.indexrelid
                  AND co.contype IN ('p', 'u', 'x')) AS constraint_definition,
              CASE WHEN ic.relkind = 'I' THEN
                (SELECT COALESCE(json_agg(json_build_object(
                          'schema', pn.nspname,
                          'table', pc.relname,
                          'partitioned', pc.relkind = 'p',
                          'foreign', pc.relkind = 'f',
                          'foreign_below', pc.relkind = 'p' AND EXISTS (
                                             SELECT 1 FROM pg_partition_tree(pc.oid) t
                                               JOIN pg_class fc ON fc.oid = t.relid
                                              WHERE fc.relkind = 'f'),
                          'attached', (SELECT xc.relname
                                         FROM pg_inherits i
                                         JOIN pg_index x ON x.indexrelid = i.inhrelid
                                         JOIN pg_class xc ON xc.oid = i.inhrelid
                                        WHERE i.inhparent = ix.indexrelid
                                          AND x.indrelid = p.inhrelid))
                        ORDER BY pn.nspname, pc.relname), '[]')
                   FROM pg_inherits p
                   JOIN pg_class pc ON pc.oid = p.inhrelid
                   JOIN pg_namespace pn ON pn.oid = pc.relnamespace
                  WHERE p.inhparent = ix.indrelid
                    AND NOT EXISTS (SELECT 1
                                      FROM pg_inherits i
                                      JOIN pg_index x ON x.indexrelid = i.inhrelid
                                     WHERE i.inhparent = ix.indexrelid
                                       AND x.indrelid = p.inhrelid
                                       AND x.indisvalid))
              END AS waiting_on,
              CASE WHEN ic.relkind = 'I' THEN
                (SELECT json_build_object('schema', xn.nspname, 'name', xc.relname)
                   FROM pg_inherits i
                   JOIN pg_class xc ON xc.oid = i.inhrelid
                   JOIN pg_namespace xn ON xn.oid = xc.relnamespace
                  WHERE i.inhparent = ix.indexrelid
                  ORDER BY xn.nspname, xc.relname
                  LIMIT 1)
              END AS attached_example,
              CASE WHEN ic.relkind = 'I' AND EXISTS (SELECT 1 FROM pg_inherits i
                                                      WHERE i.inhrelid = ix.indexrelid) THEN
                (WITH RECURSIVE up(idx) AS (
                   SELECT ix.indexrelid
                   UNION ALL
                   SELECT i.inhparent FROM pg_inherits i JOIN up ON i.inhrelid = up.idx)
                 SELECT json_build_object('schema', tn.nspname, 'table', tc.relname, 'name', uc.relname)
                   FROM up
                   JOIN pg_class uc ON uc.oid = up.idx
                   JOIN pg_index ux ON ux.indexrelid = up.idx
                   JOIN pg_class tc ON tc.oid = ux.indrelid
                   JOIN pg_namespace tn ON tn.oid = tc.relnamespace
                  WHERE NOT EXISTS (SELECT 1 FROM pg_inherits i WHERE i.inhrelid = up.idx))
              END AS top_index
         FROM pg_index ix
         JOIN pg_class ic ON ic.oid = ix.indexrelid
         JOIN pg_class c ON c.oid = ix.indrelid
         JOIN pg_namespace n ON n.oid = ic.relnamespace
        WHERE n.nspname = $1
          AND NOT ix.indisvalid
          AND c.relname <> ALL($2::text[])
        ORDER BY ic.relname`,
      [schema, TOOL_TABLES]
    );
    // Index names are unique within a schema, so a name alone is enough.
    invalidIndexes = new Set(invalidRows.rows.map((r) => String(r.index_name)));

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

    // The counters never list a partitioned table's own index, so an
    // unfinished one is added from the first read. It holds no rows of its
    // own (each partition's copy does), so it has no scans and no size.
    const indexes: IndexStats[] = indexRows.rows
      .map(
        (r): IndexStats => ({
          table_name: String(r.table_name),
          index_name: String(r.index_name),
          idx_scan: num(r.idx_scan),
          is_unique: Boolean(r.is_unique),
          is_primary: Boolean(r.is_primary),
          is_valid: Boolean(r.is_valid),
          backs_constraint: Boolean(r.backs_constraint),
          is_partition_child: Boolean(r.is_partition_child),
          is_partitioned: false,
          size_bytes: num(r.size_bytes),
          definition: String(r.definition ?? ""),
        })
      )
      .concat(
        invalidRows.rows
          .filter((r) => Boolean(r.is_partitioned))
          .map(
            (r): IndexStats => ({
              table_name: String(r.table_name),
              index_name: String(r.index_name),
              idx_scan: 0,
              is_unique: Boolean(r.is_unique),
              is_primary: Boolean(r.is_primary),
              is_valid: false,
              backs_constraint: r.constraint_definition != null,
              is_partition_child: Boolean(r.is_partition_child),
              is_partitioned: true,
              size_bytes: 0,
              definition: String(r.definition ?? ""),
              constraint_definition:
                r.constraint_definition == null ? null : String(r.constraint_definition),
              waiting_on: waitingOn(r.waiting_on),
              attached_example: attachedExample(r.attached_example),
              top_index: topIndex(r.top_index),
            })
          )
      );

    const since = counterRows.rows[0]?.counters_since;
    const countersSince = since ? new Date(since).toISOString() : null;

    runtime = analyzeTableStats(
      schema,
      tables,
      indexes,
      countersSince,
      new Date(),
      // The invalid ones are left out on purpose: an index the planner will
      // not use protects nothing, and the foreign-key rule has already counted
      // the key as unindexed. Reached only when the list loaded — the catch
      // below is where a failure lands.
      foreignKeyIndexes(snapshot, invalidIndexes ?? new Set())
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
    // Without the list, every rule that filters on it treats an invalid index
    // as usable. That is the duplicate and redundant rules (a live index can be
    // reported as a copy of one that is actually broken) AND the no-primary-key
    // rule, which shares the same filtered index groups and can offer PRIMARY
    // KEY USING INDEX on an index PostgreSQL would refuse to build a key from.
    // It is also the foreign-key rule, which skips a key whose only index is
    // invalid: without the list that key looks covered and no "add an index"
    // advice is given for it. Unlike the others this one goes quiet rather
    // than wrong — it says less than it should, and never something untrue.
    if (invalidIndexes === null) {
      statsUnavailable +=
        " Which indexes are invalid could not be read either, so a suggestion from the" +
        " schema may count an invalid index as one queries use.";
    }
  } finally {
    client?.release(broken);
  }

  // ── The structural rules ──────────────────────────────────────────────────
  // After pass two, so the duplicate and redundant rules can leave out the
  // invalid indexes it found (queries never use one, so it copies nothing).
  // When pass two could not even start, there is no list (the screen says
  // so), and a copy that REINDEX CONCURRENTLY left behind is still known by
  // its name.
  const structural: AdviceItem[] = analyzeSchemaPerformance(snapshot, invalidIndexes ?? new Set()).map(
    (a) => ({
      ...a,
      origin: "structure" as const,
      // Without the list, a suggestion that acts on one index because of
      // another cannot promise the one it keeps is the working one — see
      // actsOnAnIndex. It is still shown, and still probably right; it just
      // does not go into a script by default.
      ...(invalidIndexes === null && actsOnAnIndex(a)
        ? {
            startUnticked:
              "Starts unticked: which indexes are invalid could not be read, so this" +
              " cannot tell a working index from one a failed build left behind.",
          }
        : {}),
    })
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
