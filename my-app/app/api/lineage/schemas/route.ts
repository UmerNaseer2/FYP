import { NextRequest, NextResponse } from "next/server";
import pool from "@/lib/version-db";
import { buildPgConfig } from "@/lib/connection-config";
import { fetchSchemaNames } from "@/lib/postgres";

/**
 * GET /api/lineage/schemas?connectionId=<id>
 *
 * List the schemas on a saved connection so the "Track a schema" flow can offer
 * a dropdown. Reads the connection from the same metadata pool the rest of the
 * lineage feature uses (so it stays consistent with /api/lineage/track), then
 * lists schemas SSL-aware via the shared introspection helper.
 *
 * Returns: { schemas: string[] } on success, or { error } with a 4xx/5xx.
 */
export async function GET(request: NextRequest) {
  const connectionId = Number(
    request.nextUrl.searchParams.get("connectionId") ?? ""
  );

  if (!connectionId) {
    return NextResponse.json(
      { error: "A connectionId query parameter is required." },
      { status: 400 }
    );
  }

  // ── Look up the saved connection (same pool /track reads from) ─────────────
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
  };
  try {
    const result = await pool.query(
      `SELECT name, host, port, database_name, type, username, password, connection_string, ssl
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
    console.error("Lineage schemas — failed to read connection:", error);
    return NextResponse.json(
      { error: "Could not read saved connection. Is the app database reachable?" },
      { status: 500 }
    );
  }

  if (conn.type !== "PostgreSQL") {
    return NextResponse.json(
      { error: "Only PostgreSQL connections can be tracked right now." },
      { status: 400 }
    );
  }

  // ── List the live schemas (SSL-aware, like the rest of the app) ────────────
  const cfg = buildPgConfig({
    host: conn.host,
    port: conn.port,
    database: conn.database_name,
    user: conn.username,
    password: conn.password,
    connectionString: conn.connection_string,
    ssl: Boolean(conn.ssl),
  });

  const listed = await fetchSchemaNames(cfg);
  if (!listed.ok) {
    return NextResponse.json(
      {
        error:
          `Could not reach "${conn.name}" to list its schemas. ` +
          `Check the connection details. Details: ${listed.error}`,
      },
      { status: 502 }
    );
  }

  return NextResponse.json({ schemas: listed.data });
}
