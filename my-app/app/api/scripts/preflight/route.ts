import { NextRequest, NextResponse } from "next/server";
import pool from "../../../../lib/db";
import { getPoolForConfig } from "../../../../lib/postgres";

// One row from script_patch — what we return to the frontend
export type PatchEntry = {
  version: string;
  title: string | null;
  description: string | null;
  change_type: string;
  applied_at: string;
};

// The full pre-flight response shape
export type PreflightResult = {
  hasVersionTable: boolean;
  needsInit: boolean;
  currentVersion: string | null;
  timeline: PatchEntry[];
  schema: string;
  // Which script family this result is scoped to.
  // null means the result is unfiltered (all entries in script_patch).
  scriptName: string | null;
  message: string;
};

// Safely quote a PostgreSQL identifier (prevents SQL injection)
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

// Convert a semver string to a single comparable number so we can find the
// highest version applied — regardless of the order scripts were applied in.
// e.g. "1.3.0" → 1_003_000, "2.0.1" → 2_000_001
function versionToNumber(v: string): number {
  const parts = v
    .replace(/^v/i, "")
    .split(".")
    .map((p) => parseInt(p.replace(/\D/g, ""), 10) || 0);
  while (parts.length < 3) parts.push(0);
  return (parts[0] ?? 0) * 1_000_000 + (parts[1] ?? 0) * 1_000 + (parts[2] ?? 0);
}

export async function POST(request: NextRequest) {
  // ─── 1. Parse and validate the body ──────────────────────────────────────
  let body: { connectionId: number; schemaName?: string; scriptName?: string };

  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON in request body." },
      { status: 400 }
    );
  }

  const { connectionId } = body;

  const schemaName =
    typeof body.schemaName === "string" && body.schemaName.trim().length > 0
      ? body.schemaName.trim()
      : "public";

  // scriptName is optional.  When provided the timeline and currentVersion are
  // scoped to that script family, which is what pendingScripts calculation on
  // the frontend needs.  When omitted the full script_patch table is returned
  // (useful for a general health check).
  const scriptName =
    typeof body.scriptName === "string" && body.scriptName.trim().length > 0
      ? body.scriptName.trim()
      : null;

  if (!connectionId) {
    return NextResponse.json(
      { error: "connectionId is required." },
      { status: 400 }
    );
  }

  // ─── 2. Look up the saved connection from the local app database ──────────
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
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Preflight — failed to fetch connection record:", message);
    return NextResponse.json(
      { error: "Could not read saved connection. Is the app database reachable?" },
      { status: 500 }
    );
  }

  // ─── 3. Connect to the target database ───────────────────────────────────
  const targetConfig = {
    host: connRow.host,
    port: Number(connRow.port),
    database: connRow.database_name,
    user: connRow.username,
    password: connRow.password,
  };

  const targetPool = getPoolForConfig(targetConfig);

  let client;
  try {
    client = await targetPool.connect();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Preflight — could not connect to target DB:", message);
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
    // ─── 4. Check whether script_patch exists in the target schema ────────
    const tableCheck = await client.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1
         FROM information_schema.tables
         WHERE table_schema = $1
           AND table_name   = 'script_patch'
       ) AS exists`,
      [schemaName]
    );

    const hasVersionTable = tableCheck.rows[0]?.exists === true;

    // ─── 5a. No script_patch found ────────────────────────────────────────
    if (!hasVersionTable) {
      const result: PreflightResult = {
        hasVersionTable: false,
        needsInit: true,
        currentVersion: null,
        timeline: [],
        schema: schemaName,
        scriptName,
        message:
          `Schema "${schemaName}" on "${connRow.name}" has no script_patch table. ` +
          `It will be created automatically on first deploy.`,
      };
      return NextResponse.json(result);
    }

    // ─── 5b. script_patch exists — read the timeline ──────────────────────
    //
    // When scriptName is provided, scope the query to that script family so
    // that currentVersion reflects only what THIS script group has applied —
    // not the highest version across every unrelated script.
    //
    // Without this, applying "products_migration v2.0.0" would make the tool
    // believe "users_migration v1.0.0" is already applied (1.0.0 < 2.0.0).
    const quotedSchema = quoteIdent(schemaName);

    const timelineResult = scriptName
      ? await client.query<PatchEntry>(
          `SELECT
             version,
             title,
             description,
             change_type,
             applied_at
           FROM ${quotedSchema}.script_patch
           WHERE script_name = $1
           ORDER BY applied_at DESC`,
          [scriptName]
        )
      : await client.query<PatchEntry>(
          `SELECT
             version,
             title,
             description,
             change_type,
             applied_at
           FROM ${quotedSchema}.script_patch
           ORDER BY applied_at DESC`
        );

    const timeline: PatchEntry[] = timelineResult.rows;

    // ─── 6. Handle empty timeline ─────────────────────────────────────────
    if (timeline.length === 0) {
      const result: PreflightResult = {
        hasVersionTable: true,
        needsInit: false,
        currentVersion: null,
        timeline: [],
        schema: schemaName,
        scriptName,
        message: scriptName
          ? `No versions of "${scriptName}" have been applied to schema "${schemaName}" yet. All scripts will be treated as pending.`
          : `script_patch table exists in "${schemaName}" but has no entries yet. All scripts will be treated as pending.`,
      };
      return NextResponse.json(result);
    }

    // ─── 7. Determine the current version ────────────────────────────────
    // "Current" = the highest semver in the (possibly filtered) timeline,
    // computed via versionToNumber().  We do NOT use applied_at order because
    // scripts can be applied out of order (e.g. a hotfix for v1.1.x applied
    // after v1.2.0 was already deployed).
    const currentVersion = timeline.reduce<string | null>((highest, entry) => {
      if (!highest) return entry.version;
      return versionToNumber(entry.version) > versionToNumber(highest)
        ? entry.version
        : highest;
    }, null);

    const result: PreflightResult = {
      hasVersionTable: true,
      needsInit: false,
      currentVersion,
      timeline,
      schema: schemaName,
      scriptName,
      message: scriptName
        ? `"${scriptName}" in schema "${schemaName}" on "${connRow.name}" is at version ${currentVersion}. ${timeline.length} version(s) in history.`
        : `Schema "${schemaName}" on "${connRow.name}" is at version ${currentVersion}. ${timeline.length} version(s) in history.`,
    };

    return NextResponse.json(result);

  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Preflight — query failed:", message);
    return NextResponse.json(
      { error: `Pre-flight check failed: ${message}` },
      { status: 500 }
    );
  } finally {
    // Always release — even on early returns
    client.release();
  }
}
