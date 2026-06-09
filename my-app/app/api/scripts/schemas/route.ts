import { NextRequest, NextResponse } from "next/server";
import pool from "@/lib/version-db";
import { getPoolForConfig } from "@/lib/postgres";
import { buildPgConfig } from "@/lib/connection-config";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const connectionId = Number(searchParams.get("connectionId"));

  if (!connectionId) {
    return NextResponse.json(
      { error: "connectionId is required." },
      { status: 400 }
    );
  }

  // ── 1. Look up the saved connection from the app metadata database ──────────
  // Same pool the Connections screen saves to (version-db), so any connection the
  // user created is visible here. We read connection_string + ssl too, so URI and
  // SSL-required hosts (Neon, Supabase, RDS) work exactly like the rest of the app.
  let connRow: {
    host: string;
    port: number;
    database_name: string;
    username: string;
    password: string;
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
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: `Could not read saved connection: ${message}` },
      { status: 500 }
    );
  }

  // ── 2. Connect to the target database (SSL/URI-aware via buildPgConfig) ──────
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
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      {
        error:
          `Could not connect to "${connRow.name}" ` +
          `(${connRow.host}:${connRow.port}/${connRow.database_name}). ` +
          `Check that the database is running and credentials are correct. ` +
          `Details: ${message}`,
      },
      { status: 503 }
    );
  }

  try {
    // ── 3. Query user schemas — exclude Postgres system schemas ───────────────
    const result = await client.query<{ schema_name: string }>(
      `SELECT schema_name
       FROM information_schema.schemata
       WHERE schema_name NOT LIKE 'pg_%'
         AND schema_name != 'information_schema'
       ORDER BY schema_name`
    );

    return NextResponse.json({
      schemas: result.rows.map((r) => r.schema_name),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: `Schema query failed: ${message}` },
      { status: 500 }
    );
  } finally {
    client.release();
  }
}
