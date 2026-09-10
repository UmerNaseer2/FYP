import { NextRequest, NextResponse } from "next/server";
import { requireViewer } from "@/lib/auth-guard";
import pool, { syncMetadataTables } from "@/lib/version-db";
import { buildPgConfig } from "@/lib/connection-config";
import { fetchSchemaSnapshot, getPoolForConfig, withoutToolTables } from "@/lib/postgres";
import {
  analyzeSchemaPerformance,
  analyzeTableStats,
  sortAdvice,
  summarizeAdvice,
  type IndexStats,
  type PerfAdvice,
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
 * them, because a reader needs to know that "this index has never been used"
 * came from counters that have been running for an unknown length of time
 * while "this foreign key has no index" is simply true.
 *
 * The statistics half is allowed to fail on its own. pg_stat_user_tables is
 * readable by anyone, but a connection can still be pointed at a replica with
 * cold counters or a role that cannot see the size functions — and losing the
 * structural advice too because of that would be the wrong trade.
 */

/** A finding plus which of the two passes produced it. */
export type AdviceItem = PerfAdvice & {
  origin: "structure" | "statistics";
};

export type AdviceView = {
  connectionName: string;
  database: string;
  schema: string;
  advice: AdviceItem[];
  counts: { high: number; medium: number; low: number; total: number };
  /** How many tables the structural pass looked at. */
  tablesAnalyzed: number;
  /**
   * Why the statistics pass produced nothing, or null when it ran. Not an
   * error: the structural advice above is still complete.
   */
  statsUnavailable: string | null;
};

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
      { error: "A connectionId query parameter is required." },
      { status: 400 }
    );
  }
  if (!schema) {
    return NextResponse.json(
      { error: "A schema query parameter is required." },
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
        { error: `No saved connection found with id ${connectionId}.` },
        { status: 404 }
      );
    }
    conn = result.rows[0];
  } catch (error) {
    console.error("Performance advice — failed to read connection:", error);
    return NextResponse.json(
      { error: "Could not read the saved connection. Is the app database reachable?" },
      { status: 500 }
    );
  }

  if (conn.type !== "PostgreSQL") {
    return NextResponse.json(
      { error: "Performance advice is only available for PostgreSQL connections." },
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
  const captured = await fetchSchemaSnapshot(cfg, schema);
  if (!captured.ok) {
    return NextResponse.json(
      {
        error:
          `Could not read "${schema}" on "${conn.name}". ` +
          `Check the connection details. Details: ${captured.error}`,
      },
      { status: 502 }
    );
  }

  // The tool's own ledger tables are not the user's schema, and advice about
  // them is advice they cannot act on.
  const snapshot = withoutToolTables(captured.data);
  const structural: AdviceItem[] = analyzeSchemaPerformance(snapshot).map((a) => ({
    ...a,
    origin: "structure",
  }));

  // ── Pass two: the server's own counters ───────────────────────────────────
  let runtime: AdviceItem[] = [];
  let statsUnavailable: string | null = null;
  try {
    const target = getPoolForConfig(cfg);

    const tableRows = await target.query(
      `SELECT s.relname                                   AS table_name,
              COALESCE(s.seq_scan, 0)                     AS seq_scan,
              COALESCE(s.idx_scan, 0)                     AS idx_scan,
              COALESCE(s.n_live_tup, 0)                   AS n_live_tup,
              COALESCE(s.n_dead_tup, 0)                   AS n_dead_tup,
              GREATEST(s.last_analyze, s.last_autoanalyze) AS last_analyzed,
              COALESCE(io.heap_blks_hit, 0)               AS heap_blks_hit,
              COALESCE(io.heap_blks_read, 0)              AS heap_blks_read
         FROM pg_stat_user_tables s
         LEFT JOIN pg_statio_user_tables io ON io.relid = s.relid
        WHERE s.schemaname = $1
          AND s.relname <> ALL($2::text[])`,
      [schema, TOOL_TABLES]
    );

    const indexRows = await target.query(
      `SELECT s.relname                        AS table_name,
              s.indexrelname                   AS index_name,
              COALESCE(s.idx_scan, 0)          AS idx_scan,
              ix.indisunique                   AS is_unique,
              pg_relation_size(s.indexrelid)   AS size_bytes
         FROM pg_stat_user_indexes s
         JOIN pg_index ix ON ix.indexrelid = s.indexrelid
        WHERE s.schemaname = $1
          AND s.relname <> ALL($2::text[])`,
      [schema, TOOL_TABLES]
    );

    const tables: TableStats[] = tableRows.rows.map((r) => ({
      table_name: String(r.table_name),
      seq_scan: num(r.seq_scan),
      idx_scan: num(r.idx_scan),
      n_live_tup: num(r.n_live_tup),
      n_dead_tup: num(r.n_dead_tup),
      last_analyzed: r.last_analyzed ? new Date(r.last_analyzed).toISOString() : null,
      heap_blks_hit: num(r.heap_blks_hit),
      heap_blks_read: num(r.heap_blks_read),
    }));

    const indexes: IndexStats[] = indexRows.rows.map((r) => ({
      table_name: String(r.table_name),
      index_name: String(r.index_name),
      idx_scan: num(r.idx_scan),
      is_unique: Boolean(r.is_unique),
      size_bytes: num(r.size_bytes),
    }));

    runtime = analyzeTableStats(tables, indexes).map((a) => ({
      ...a,
      origin: "statistics",
    }));
  } catch (error) {
    // Deliberately not fatal — see the note at the top of this file.
    const message = error instanceof Error ? error.message : String(error);
    console.error("Performance advice — statistics unavailable:", message);
    statsUnavailable = message;
  }

  const advice = sortAdvice([...structural, ...runtime]);

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
