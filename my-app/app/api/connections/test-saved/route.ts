import { NextRequest, NextResponse } from "next/server";
import { requireEditor } from "@/lib/auth-guard";
import pool, { syncMetadataTables } from "@/lib/version-db";
import { runConnectionTest } from "@/lib/connection-config";

/** Test a saved connection by id (used by the per-row "Test" action). */
export async function POST(request: NextRequest) {
  const gate = await requireEditor();
  if (!gate.ok) return gate.response;

  try {
    const { id } = await request.json();

    if (!Number.isInteger(Number(id)) || Number(id) <= 0) {
      return NextResponse.json(
        { ok: false, error: "Connection ID is required.", sslRequired: false, detail: "" },
        { status: 400 }
      );
    }

    // The ssl_mode column is added lazily; make sure it exists before selecting it.
    await syncMetadataTables();
    const result = await pool.query(
      `SELECT host, port, database_name, type, username, password, connection_string, ssl, ssl_mode
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
      sslMode: conn.ssl_mode,
    });

    // Record what happened, so the Connections table can say when this
    // connection was last reached and whether it answered. Without this the
    // row reads "Last tested: Never" the moment the page is reloaded, which is
    // the opposite of what just happened.
    //
    // Its own try/catch: a failure to WRITE the note must not turn a successful
    // test into a reported failure. The user asked whether the database
    // answers, and it did.
    const testedAt = new Date();
    try {
      await pool.query(
        `UPDATE connections
            SET last_tested_at = $1,
                last_test_ok = $2,
                last_test_version = $3,
                last_test_latency_ms = $4,
                last_test_error = $5
          WHERE id = $6`,
        [
          testedAt,
          testResult.ok,
          testResult.ok ? testResult.version : null,
          testResult.ok ? testResult.latencyMs : null,
          testResult.ok ? null : testResult.error,
          id,
        ]
      );
    } catch (writeError) {
      console.error("Could not record the connection test result:", writeError);
    }

    return NextResponse.json({ ...testResult, testedAt: testedAt.toISOString() });
  } catch (error) {
    console.error("Saved test connection route error:", error);
    return NextResponse.json(
      { ok: false, error: "Could not run the test.", sslRequired: false, detail: "" },
      { status: 200 }
    );
  }
}
