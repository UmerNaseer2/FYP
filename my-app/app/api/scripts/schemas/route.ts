import { NextRequest, NextResponse } from "next/server";
import pool from "../../../../lib/db";
import { getPoolForConfig } from "../../../../lib/postgres";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const connectionId = Number(searchParams.get("connectionId"));

  if (!connectionId) {
    return NextResponse.json(
      { error: "connectionId is required." },
      { status: 400 }
    );
  }

  // ── 1. Look up the saved connection from the local app database ─────────────
  let connRow: {
    host: string;
    port: number;
    database_name: string;
    username: string;
    password: string;
    name: string;
  };

  try {
    const result = await pool.query(
      `SELECT host, port, database_name, username, password, name
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

  // ── 2. Connect to the target database ──────────────────────────────────────
  const targetPool = getPoolForConfig({
    host: connRow.host,
    port: Number(connRow.port),
    database: connRow.database_name,
    user: connRow.username,
    password: connRow.password,
  });

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
