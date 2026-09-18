import { NextRequest, NextResponse } from "next/server";
import { requireViewer } from "@/lib/auth-guard";
import pool, { syncMetadataTables } from "@/lib/version-db";
import { buildPgConfig } from "@/lib/connection-config";
import { UNREADABLE_CREDENTIALS_MESSAGE } from "@/lib/secret-store";
import { fetchSchemaVersionInfo, pickCurrentVersion } from "@/lib/version-detection";
import { toFullDetectedVersion, type DetectedVersion } from "@/lib/detected-version";

// GET /api/compare/version-history?connectionId=<id>&schema=<name>
//
// One schema's WHOLE version history, from whatever table it already keeps its
// versions in — flyway_schema_history, a hand-rolled schema_version, our own
// script_patch, whichever the detector finds.
//
// Why this exists: a comparison carries only the newest few entries of each
// side to the browser (VERSION_TIMELINE_SHOWN), because sending every row of
// every schema would be most of the page's weight and most comparisons never
// open the timeline. Until this route, the only way to get the rest back was
// GET /api/versionsync/ledger, which reads a table called exactly script_patch
// — so a team using Flyway saw five entries and no way to see the sixth.
//
// This route does not read scripts. script_patch stores the SQL it applied and
// the ledger route returns it; flyway_schema_history and its like do not store
// SQL at all, so there is nothing here to hand back and the timeline says so
// rather than showing an empty script box.
//
// The connection lookup below is the same one preflight, schema-snapshot and
// the ledger route do: the saved row (with its password) is read server-side
// and never leaves the server.

export type VersionHistoryResponse = {
  schema: string;
  /**
   * The same shape the comparison itself sends for a side, with `recent`
   * holding every row instead of the newest few. The screen swaps one for the
   * other, so nothing downstream has to learn a second shape.
   */
  detected: DetectedVersion;
};

export async function GET(request: NextRequest) {
  const gate = await requireViewer();
  if (!gate.ok) return gate.response;

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
    ssl_mode: string | null;
    name: string;
  };
  try {
    // The ssl_mode column is added lazily; make sure it exists before selecting it.
    await syncMetadataTables();
    const result = await pool.query(
      `SELECT host, port, database_name, username, password, connection_string, ssl, ssl_mode, name
       FROM connections WHERE id = $1`,
      [connectionId]
    );
    if (result.rows.length === 0) {
      return NextResponse.json({ error: `No saved connection found with id ${connectionId}.` }, { status: 404 });
    }
    connRow = result.rows[0];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Version history — failed to read connection:", message);
    return NextResponse.json(
      { error: "Could not read saved connection. Is the app database reachable?" },
      { status: 500 }
    );
  }

  // buildPgConfig decrypts the saved password, and throws when this server's
  // APP_ENCRYPTION_KEY is missing or is not the key it was saved with. Left
  // uncaught, that would be a bare 500 the timeline could only call a failure.
  let targetConfig: ReturnType<typeof buildPgConfig>;
  try {
    targetConfig = buildPgConfig({
      host: connRow.host,
      port: connRow.port,
      database: connRow.database_name,
      user: connRow.username,
      password: connRow.password,
      connectionString: connRow.connection_string,
      ssl: Boolean(connRow.ssl),
      sslMode: connRow.ssl_mode,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Version history — could not read the saved connection's credentials:", message);
    return NextResponse.json({ error: UNREADABLE_CREDENTIALS_MESSAGE }, { status: 500 });
  }

  // The detector opens the connection itself, through the same shared pool the
  // comparison used, so opening the panel does not cost the target a second one.
  try {
    const info = await fetchSchemaVersionInfo(targetConfig, schema);
    // fetchSchemaVersionInfo answers rather than throws when the schema has no
    // version table or the read failed: hasVersionTable is false and `message`
    // says which. Both travel back as a DetectedVersion with no entries, which
    // is what the screen already renders for a side that has no table.
    //
    // pickCurrentVersion is the detector's own rule for which row the schema's
    // version was read from. Applying it here, rather than trusting row order,
    // keeps the entry the timeline marks HEAD the same entry the bar above it
    // prints as this side's version.
    const detected = toFullDetectedVersion(info, pickCurrentVersion(info.timeline));
    const body: VersionHistoryResponse = { schema, detected };
    return NextResponse.json(body);
  } catch (error) {
    // Only a pool-level failure reaches here — the schema read itself is
    // already caught inside the detector.
    const message = error instanceof Error ? error.message : String(error);
    console.error("Version history — read failed:", message);
    return NextResponse.json(
      {
        error:
          `Could not read the version history from "${connRow.name}" ` +
          `(${connRow.host}:${connRow.port}/${connRow.database_name}). Details: ${message}`,
      },
      { status: 503 }
    );
  }
}
