import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth-guard";
import pool, { syncMetadataTables } from "@/lib/version-db";
import {
  PUBLIC_COLUMNS,
  publicRow,
  createConnection,
  deleteConnection,
  updateConnection,
  type WriteAnswer,
} from "@/lib/connection-writes";

/**
 * Saved database targets — the rows every other feature connects through.
 *
 * Three rules hold across all four methods:
 *
 *  1. Validation is lib/connection-validate, the SAME module the drawer uses.
 *     One implementation means the client and the server cannot drift into
 *     disagreeing about what a valid connection is.
 *  2. Secrets are encrypted on the way in (lib/secret-store) and decrypted in
 *     exactly one place on the way out (buildPgConfig). Nothing here ever sends
 *     a password or a connection string back to the browser.
 *  3. `ssl_mode` is the real setting; the older boolean `ssl` column is written
 *     in step with it so a rollback to an earlier build still behaves.
 *
 * Every saved connection belongs to one organization, and every statement here
 * names the caller's organization next to the id. A connection id from another
 * organization reads as missing, the same 404 a deleted one gets, so the ids
 * cannot be probed to learn what other organizations have saved. A new
 * connection is saved into the caller's organization, never one the request
 * names: the body has no say in where the row lands.
 */

export async function GET() {
  const gate = await requirePermission("connections:read", "dashboard:read", "scripts:read", "deploy:read", "version_sync:read", "performance:read", "visualizer:read");
  if (!gate.ok) return gate.response;

  try {
    await syncMetadataTables();

    // Never send secrets to the browser. The password and the connection_string
    // (which embeds the password for URI connections) stay server-side; the UI
    // only needs to know *whether* a connection string is stored, via the
    // has_connection_string flag.
    const result = await pool.query(
      `
      SELECT ${PUBLIC_COLUMNS}
      FROM connections
      WHERE org_id = $1
      ORDER BY id DESC
      `,
      [gate.principal.orgId]
    );

    return NextResponse.json(result.rows.map(publicRow));
  } catch (error) {
    // This used to return `[]` with a 200. That made an unreachable metadata
    // database look exactly like "you have no connections yet" — the single
    // most misleading state this screen can be in.
    console.error("GET connections error:", error);
    return NextResponse.json(
      { error: "Could not read your saved connections. Is the app database reachable?" },
      { status: 500 }
    );
  }
}

async function readBody(request: NextRequest): Promise<Record<string, unknown> | null> {
  try {
    const body = await request.json();
    return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function send(answer: WriteAnswer): NextResponse {
  return NextResponse.json(answer.body, { status: answer.status });
}

const NOT_JSON = { error: "Expected a JSON body." };

/** Save a new connection. The work is in lib/connection-writes.ts, shared with a linked desktop. */
export async function POST(request: NextRequest) {
  const gate = await requirePermission("connections:create");
  if (!gate.ok) return gate.response;
  const body = await readBody(request);
  if (!body) return NextResponse.json(NOT_JSON, { status: 400 });
  return send(await createConnection(gate.principal, body));
}

/** Change a connection. A `base_version` turns a save over someone else's change into a 409. */
export async function PUT(request: NextRequest) {
  const gate = await requirePermission("connections:update");
  if (!gate.ok) return gate.response;
  const body = await readBody(request);
  if (!body) return NextResponse.json(NOT_JSON, { status: 400 });
  return send(await updateConnection(gate.principal, body));
}

/** Delete a connection, after the caller confirms what still uses it. */
export async function DELETE(request: NextRequest) {
  const gate = await requirePermission("connections:delete");
  if (!gate.ok) return gate.response;
  const body = await readBody(request);
  if (!body) return NextResponse.json(NOT_JSON, { status: 400 });
  return send(await deleteConnection(gate.principal, body));
}
