import { NextRequest, NextResponse } from "next/server";
import pool from "@/lib/version-db";
import { fetchSchemaSnapshot } from "@/lib/postgres";
import { buildPgConfig } from "@/lib/connection-config";

// GET /api/schema/snapshot?connectionId=<id>&schema=<name>
//
// Returns the full structural snapshot (tables, columns, PKs, FKs, constraints)
// of one schema on a saved connection — the data the Schema Visualizer renders.
// Same lookup pattern as /api/scripts/preflight: the connection row (with its
// password) is read server-side from the app metadata DB and never leaves it.

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;

  const connectionId = Number(params.get("connectionId"));
  const schema = (params.get("schema") ?? "").trim();

  if (!Number.isInteger(connectionId) || connectionId <= 0) {
    return NextResponse.json(
      { error: "connectionId must be a positive integer." },
      { status: 400 }
    );
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
    connRow = result.rows[0];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Schema snapshot — failed to read connection record:", message);
    return NextResponse.json(
      { error: "Could not read saved connection. Is the app database reachable?" },
      { status: 500 }
    );
  }

  // ── Introspect the target schema ─────────────────────────────────────────
  const config = buildPgConfig({
    host: connRow.host,
    port: connRow.port,
    database: connRow.database_name,
    user: connRow.username,
    password: connRow.password,
    connectionString: connRow.connection_string,
    ssl: Boolean(connRow.ssl),
  });

  const snapshot = await fetchSchemaSnapshot(config, schema);
  if (!snapshot.ok) {
    return NextResponse.json(
      {
        error:
          `Could not read schema "${schema}" on "${connRow.name}": ${snapshot.error}`,
      },
      { status: 502 }
    );
  }

  return NextResponse.json({ snapshot: snapshot.data });
}
