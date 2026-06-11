import { NextRequest, NextResponse } from "next/server";
import pool from "@/lib/version-db";
import { getPoolForConfig } from "@/lib/postgres";
import { buildPgConfig } from "@/lib/connection-config";
import type { LedgerEntry } from "@/lib/version-sync";

// GET /api/versionsync/ledger?connectionId=<id>&schema=<name>
//
// Returns a schema's applied-script ledger (script_patch) — including the stored
// SQL (sql_content) so Version Sync can show it and replay it. Same connection
// lookup + SSL/URI handling as preflight / schema-snapshot: the connection row
// (with its password) is read server-side and never leaves the server.

export type LedgerResponse = {
  schema: string;
  /** False when the schema has no script_patch table yet (never migrated). */
  hasLedger: boolean;
  entries: LedgerEntry[];
};

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const connectionId = Number(params.get("connectionId"));
  const schema = (params.get("schema") ?? "").trim();

  if (!Number.isInteger(connectionId) || connectionId <= 0) {
    return NextResponse.json({ error: "connectionId must be a positive integer." }, { status: 400 });
  }
  if (!schema) {
    return NextResponse.json({ error: "schema is required." }, { status: 400 });
  }

  // ── Look up the saved connection ─────────────────────────────────────────
  let connRow: {
    host: string;
    port: number;
    database_name: string;
    username: string;
    password: string | null;
    connection_string: string | null;
    ssl: boolean | null;
    name: string;
  };
  try {
    const result = await pool.query(
      `SELECT host, port, database_name, username, password, connection_string, ssl, name
       FROM connections WHERE id = $1`,
      [connectionId]
    );
    if (result.rows.length === 0) {
      return NextResponse.json({ error: `No saved connection found with id ${connectionId}.` }, { status: 404 });
    }
    connRow = result.rows[0];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Version sync ledger — failed to read connection:", message);
    return NextResponse.json(
      { error: "Could not read saved connection. Is the app database reachable?" },
      { status: 500 }
    );
  }

  // ── Connect to the target ────────────────────────────────────────────────
  const targetPool = getPoolForConfig(
    buildPgConfig({
      host: connRow.host,
      port: connRow.port,
      database: connRow.database_name,
      user: connRow.username,
      password: connRow.password,
      connectionString: connRow.connection_string,
      ssl: Boolean(connRow.ssl),
    })
  );

  let client;
  try {
    client = await targetPool.connect();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json(
      {
        error:
          `Could not connect to "${connRow.name}" ` +
          `(${connRow.host}:${connRow.port}/${connRow.database_name}). Details: ${message}`,
      },
      { status: 503 }
    );
  }

  try {
    // script_patch may not exist (schema never migrated through this tool).
    const tableCheck = await client.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.tables
         WHERE table_schema = $1 AND table_name = 'script_patch'
       ) AS exists`,
      [schema]
    );
    if (tableCheck.rows[0]?.exists !== true) {
      const body: LedgerResponse = { schema, hasLedger: false, entries: [] };
      return NextResponse.json(body);
    }

    // sql_content may be absent on a script_patch created before P1 and not yet
    // re-applied. Select NULL for it rather than erroring on a missing column.
    const colCheck = await client.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = 'script_patch' AND column_name = 'sql_content'
       ) AS exists`,
      [schema]
    );
    const sqlExpr = colCheck.rows[0]?.exists === true ? "sql_content" : "NULL::text AS sql_content";

    const q = quoteIdent(schema);
    const res = await client.query<{
      script_name: string;
      version: string;
      change_type: string;
      applied_at: Date | string;
      sql_content: string | null;
    }>(
      `SELECT script_name, version, change_type, applied_at, ${sqlExpr}
       FROM ${q}.script_patch
       ORDER BY applied_at ASC, version ASC`
    );

    const entries: LedgerEntry[] = res.rows.map((r) => {
      const sql = typeof r.sql_content === "string" && r.sql_content.length > 0 ? r.sql_content : null;
      return {
        scriptName: r.script_name,
        version: r.version,
        changeType: r.change_type,
        appliedAt: r.applied_at instanceof Date ? r.applied_at.toISOString() : String(r.applied_at),
        hasSql: sql !== null,
        sqlContent: sql,
      };
    });

    const body: LedgerResponse = { schema, hasLedger: true, entries };
    return NextResponse.json(body);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Version sync ledger — query failed:", message);
    return NextResponse.json({ error: `Could not read the ledger: ${message}` }, { status: 500 });
  } finally {
    client.release();
  }
}
