import { NextRequest, NextResponse } from "next/server";
import pool from "@/lib/version-db";
import { runConnectionTest } from "@/lib/connection-config";

/** Test a saved connection by id (used by the per-row "Test" action). */
export async function POST(request: NextRequest) {
  try {
    const { id } = await request.json();

    if (!id) {
      return NextResponse.json(
        { ok: false, error: "Connection ID is required.", sslRequired: false, detail: "" },
        { status: 400 }
      );
    }

    const result = await pool.query(
      `SELECT host, port, database_name, type, username, password, connection_string, ssl
       FROM connections
       WHERE id = $1`,
      [id]
    );

    const conn = result.rows[0];

    if (!conn) {
      return NextResponse.json(
        { ok: false, error: "Connection not found.", sslRequired: false, detail: "" },
        { status: 404 }
      );
    }

    if (conn.type !== "PostgreSQL") {
      return NextResponse.json(
        { ok: false, error: "Only PostgreSQL is supported right now.", sslRequired: false, detail: "" },
        { status: 400 }
      );
    }

    const testResult = await runConnectionTest({
      host: conn.host,
      port: conn.port,
      database: conn.database_name,
      user: conn.username,
      password: conn.password,
      connectionString: conn.connection_string,
      ssl: Boolean(conn.ssl),
    });

    return NextResponse.json(testResult);
  } catch (error) {
    console.error("Saved test connection route error:", error);
    return NextResponse.json(
      { ok: false, error: "Could not run the test.", sslRequired: false, detail: "" },
      { status: 200 }
    );
  }
}
