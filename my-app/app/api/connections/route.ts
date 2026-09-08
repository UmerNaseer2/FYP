import { NextRequest, NextResponse } from "next/server";
import { requireEditor, requireViewer } from "@/lib/auth-guard";
import pool, { ensureConnectionsTable } from "@/lib/version-db";
import { getConnectionDependents } from "@/lib/lineage-db";
import { checkConnectableHost } from "@/lib/connection-config";
import { encryptSecret } from "@/lib/secret-store";
import {
  sslModeFromLegacyBoolean,
  sslModeUsesTls,
  summariseErrors,
  toSslMode,
  validateConnection,
  type SslMode,
} from "@/lib/connection-validate";

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
 *  4. `environment` is a typed dev / staging / prod label, not free text in the
 *     name. It is what lets Compare and Deploy say "this target is production"
 *     before they generate or run anything.
 */

/** Columns safe to return to the browser. */
const PUBLIC_COLUMNS = `id, name, host, port, database_name, type, username,
                (connection_string IS NOT NULL AND connection_string <> '') AS has_connection_string,
                ssl, ssl_mode, environment`;

export async function GET() {
  const gate = await requireViewer();
  if (!gate.ok) return gate.response;

  try {
    await ensureConnectionsTable();

    // Never send secrets to the browser. The password and the connection_string
    // (which embeds the password for URI connections) stay server-side; the UI
    // only needs to know *whether* a connection string is stored, via the
    // has_connection_string flag.
    const result = await pool.query(`
      SELECT ${PUBLIC_COLUMNS}
      FROM connections
      ORDER BY id DESC
    `);

    return NextResponse.json(result.rows);
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

export async function POST(request: NextRequest) {
  const gate = await requireEditor();
  if (!gate.ok) return gate.response;

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  // Accept either the new three-way mode or the old boolean, so an older client
  // (or a saved bookmarklet/curl) keeps working.
  const ssl_mode: SslMode =
    body.ssl_mode !== undefined && body.ssl_mode !== null && body.ssl_mode !== ""
      ? toSslMode(body.ssl_mode)
      : sslModeFromLegacyBoolean(body.ssl);

  const checked = validateConnection({ ...body, ssl_mode }, "create");
  if (!checked.ok) {
    return NextResponse.json(
      { error: summariseErrors(checked.errors), errors: checked.errors },
      { status: 400 }
    );
  }
  const value = checked.value;

  // The SSRF guard used to run only on "Test connection", which meant a blocked
  // host could still be saved and then dialled by Deploy, Drift or Compare.
  const hostCheck = checkConnectableHost(value.host);
  if (!hostCheck.ok) {
    return NextResponse.json({ error: hostCheck.message }, { status: 400 });
  }

  try {
    await ensureConnectionsTable();

    const result = await pool.query(
      `
      INSERT INTO connections
      (name, host, port, database_name, type, username, password, connection_string, ssl, ssl_mode, environment)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      RETURNING ${PUBLIC_COLUMNS}
      `,
      [
        value.name,
        value.host,
        value.port,
        value.database_name,
        value.type,
        value.username,
        encryptSecret(value.password) ?? "",
        encryptSecret(value.connection_string) || null,
        sslModeUsesTls(value.ssl_mode),
        value.ssl_mode,
        value.environment,
      ]
    );

    return NextResponse.json(result.rows[0]);
  } catch (error) {
    console.error("POST connection error:", error);
    return NextResponse.json({ error: "Failed to save connection." }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  const gate = await requireEditor();
  if (!gate.ok) return gate.response;

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  const id = Number(body.id);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "A connection id is required." }, { status: 400 });
  }

  const ssl_mode: SslMode =
    body.ssl_mode !== undefined && body.ssl_mode !== null && body.ssl_mode !== ""
      ? toSslMode(body.ssl_mode)
      : sslModeFromLegacyBoolean(body.ssl);

  // "edit" mode: a blank password means "keep the stored one", so it is not an
  // error here the way it is on create.
  const checked = validateConnection({ ...body, ssl_mode }, "edit");
  if (!checked.ok) {
    return NextResponse.json(
      { error: summariseErrors(checked.errors), errors: checked.errors },
      { status: 400 }
    );
  }
  const value = checked.value;

  const hostCheck = checkConnectableHost(value.host);
  if (!hostCheck.ok) {
    return NextResponse.json({ error: hostCheck.message }, { status: 400 });
  }

  // …EXCEPT when the editor switched to Fields mode: there the user is
  // redefining the target by loose host/port/user fields, so any stored URI
  // must be cleared — otherwise the old URI would still win over the fields.
  const clearConnectionString = Boolean(body.clear_connection_string);

  try {
    await ensureConnectionsTable();

    // Work out what credential the row would have AFTER this update, and refuse
    // to save a connection that would end up with neither a password nor a
    // connection string (otherwise it silently becomes impossible to
    // authenticate). POST guards this on create; PUT has to read the existing
    // row first, because a blank password means "keep the stored one" and
    // `clearConnectionString` wipes any stored URI.
    const existing = await pool.query<{ password: string | null; connection_string: string | null }>(
      `SELECT password, connection_string FROM connections WHERE id = $1`,
      [id]
    );
    if (existing.rows.length === 0) {
      return NextResponse.json({ error: "Connection not found." }, { status: 404 });
    }

    // These stay encrypted — we only need to know whether they are non-empty.
    const storedPassword = String(existing.rows[0].password ?? "");
    const storedConnString = String(existing.rows[0].connection_string ?? "");

    // Mirror the CASE logic in the UPDATE below exactly.
    const effectivePassword = value.password === "" ? storedPassword : value.password;
    const effectiveConnString = clearConnectionString
      ? ""
      : value.connection_string === ""
        ? storedConnString
        : value.connection_string;

    if (!effectivePassword && !effectiveConnString) {
      return NextResponse.json(
        {
          error:
            "This connection would have no password or connection string. " +
            "Enter a password (or keep a connection string) before saving.",
        },
        { status: 400 }
      );
    }

    const result = await pool.query(
      `
      UPDATE connections
      SET name = $1,
          host = $2,
          port = $3,
          database_name = $4,
          type = $5,
          username = $6,
          password = CASE WHEN $7 = '' THEN password ELSE $7 END,
          connection_string = CASE
            WHEN $8 THEN NULL
            WHEN $9 = '' THEN connection_string
            ELSE $9
          END,
          ssl = $10,
          ssl_mode = $11,
          environment = $12
      WHERE id = $13
      RETURNING ${PUBLIC_COLUMNS}
      `,
      [
        value.name,
        value.host,
        value.port,
        value.database_name,
        value.type,
        value.username,
        // Encrypt only a value the user actually typed; "" still means "keep".
        encryptSecret(value.password) ?? "",
        clearConnectionString,
        encryptSecret(value.connection_string) ?? "",
        sslModeUsesTls(value.ssl_mode),
        value.ssl_mode,
        value.environment,
        id,
      ]
    );

    if (result.rows.length === 0) {
      return NextResponse.json({ error: "Connection not found." }, { status: 404 });
    }

    return NextResponse.json(result.rows[0]);
  } catch (error) {
    console.error("PUT connection error:", error);
    return NextResponse.json({ error: "Failed to update connection." }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  const gate = await requireEditor();
  if (!gate.ok) return gate.response;

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  const id = Number(body.id);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "Connection ID is required." }, { status: 400 });
  }

  try {
    await ensureConnectionsTable();

    const existing = await pool.query<{ name: string }>(
      `SELECT name FROM connections WHERE id = $1`,
      [id]
    );
    if (existing.rows.length === 0) {
      return NextResponse.json({ error: "Connection not found." }, { status: 404 });
    }

    // tracked_schemas deliberately has no foreign key to connections (see the
    // note in lib/lineage-db), so deleting a connection silently orphans every
    // tracked schema, snapshot and drift event that pointed at it. Say what
    // will be lost and make the caller confirm.
    const dependents = await getConnectionDependents(id);
    if (dependents.trackedSchemas > 0 && body.confirm !== true) {
      return NextResponse.json(
        {
          error:
            `"${existing.rows[0].name}" is still used by ${dependents.trackedSchemas} tracked ` +
            `schema${dependents.trackedSchemas === 1 ? "" : "s"}. Deleting it also removes ` +
            `${dependents.snapshots} snapshot${dependents.snapshots === 1 ? "" : "s"} and ` +
            `${dependents.snapshots === 1 ? "its" : "their"} drift history.`,
          dependents,
          needsConfirmation: true,
        },
        { status: 409 }
      );
    }

    await pool.query("DELETE FROM connections WHERE id = $1", [id]);

    return NextResponse.json({ success: true, dependents });
  } catch (error) {
    console.error("DELETE connection error:", error);
    return NextResponse.json({ error: "Failed to delete connection." }, { status: 500 });
  }
}
