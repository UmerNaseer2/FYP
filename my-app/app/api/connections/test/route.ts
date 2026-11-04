import { NextRequest, NextResponse } from "next/server";
import { requirePermission, type Principal } from "@/lib/auth-guard";
import { hasPermission, refusalMessage } from "@/lib/permissions";
import pool, { syncMetadataTables } from "@/lib/version-db";
import { runConnectionTest } from "@/lib/connection-config";
import {
  REENTER_PASSWORD_MESSAGE,
  parsePort,
  savedPasswordWouldMove,
  sslModeFromLegacyBoolean,
  toSslMode,
  type SslMode,
} from "@/lib/connection-validate";

/**
 * Test a connection from the add/edit drawer (fields or URI + SSL).
 *
 * The drawer sends the same payload Save sends. While it edits a saved
 * connection it also sends that row's id, and then a blank password or a blank
 * connection string means "keep the saved one", exactly as it does for
 * PUT /api/connections. The saved values are filled in below the same way, so
 * Test dials what Save would store, with the SSL mode that is on screen.
 */
export async function POST(request: NextRequest) {
  const gate = await requirePermission("connections:create", "connections:update");
  if (!gate.ok) return gate.response;

  try {
    const body = await request.json();

    const type = String(body.type ?? "PostgreSQL");
    if (type !== "PostgreSQL") {
      return failure("Only PostgreSQL is supported right now.", 400);
    }

    // A port outside 1-65535 makes the driver throw something opaque
    // ("Invalid URL", "port should be >= 0"). Name the real problem instead.
    const portGiven =
      body.port !== null && body.port !== undefined && String(body.port).trim() !== "";
    if (portGiven && parsePort(body.port) === null) {
      return failure("Port must be a whole number between 1 and 65535.", 400);
    }

    const sslMode: SslMode =
      body.ssl_mode !== undefined && body.ssl_mode !== null && body.ssl_mode !== ""
        ? toSslMode(body.ssl_mode)
        : sslModeFromLegacyBoolean(body.ssl);

    // A new connection: test exactly what was typed.
    let password = body.password;
    let connectionString = body.connection_string;

    // An edit: fill in what Save would keep from the saved row.
    if (body.id !== undefined && body.id !== null) {
      const kept = await keptCredentials(gate.principal, body, sslMode);
      if (!kept.ok) return failure(kept.error, kept.status);
      password = kept.password;
      connectionString = kept.connectionString;
    }

    // runConnectionTest refuses a blocked host (ALLOW_PRIVATE_DB_HOSTS and the
    // rest) on the config it builds, so a kept connection string is checked too.
    const result = await runConnectionTest({
      host: body.host,
      port: body.port,
      database: body.database_name,
      user: body.username,
      password,
      connectionString,
      ssl: Boolean(body.ssl),
      sslMode,
    });

    // Always 200: the drawer reads `ok` and renders the matching banner.
    return NextResponse.json(result);
  } catch (error) {
    console.error("Test connection route error:", error);
    return failure("Could not run the test.", 200);
  }
}

/** A test that did not run, in the shape the drawer reads. */
function failure(error: string, status: number) {
  return NextResponse.json({ ok: false, error, sslRequired: false, detail: "" }, { status });
}

type Kept =
  | { ok: true; password: string; connectionString: string }
  | { ok: false; status: number; error: string };

/**
 * The password and connection string that saving this edit would leave on the
 * row. The same rules as PUT /api/connections:
 *
 *  - a blank password keeps the saved one;
 *  - a blank connection string keeps the saved one, unless the editor switched
 *    to Fields mode (clear_connection_string), which drops it;
 *  - a kept password may not be sent to a different host, port or user, or
 *    over weaker TLS (savedPasswordWouldMove). Save refuses that edit, and a
 *    test must not hand the saved password to a server the editor chose.
 *
 * The saved values stay encrypted here. runConnectionTest decrypts them inside
 * buildPgConfig, and nothing read from the row is sent back to the browser.
 */
async function keptCredentials(
  principal: Principal,
  body: Record<string, unknown>,
  sslMode: SslMode
): Promise<Kept> {
  // Using a saved connection's credentials is part of editing it, which needs
  // Connections: Update, the same box PUT and test-saved ask for.
  if (!hasPermission(principal, "connections:update")) {
    return {
      ok: false,
      status: 403,
      error: refusalMessage(principal.roleLabel, "connections:update"),
    };
  }

  const id = Number(body.id);
  if (!Number.isInteger(id) || id <= 0) {
    return { ok: false, status: 400, error: "Connection ID is required." };
  }

  // The ssl_mode column is added lazily; make sure it exists before selecting it.
  await syncMetadataTables();
  const result = await pool.query<{
    password: string | null;
    connection_string: string | null;
    host: string | null;
    port: number | null;
    username: string | null;
    ssl: boolean | null;
    ssl_mode: string | null;
  }>(
    `SELECT password, connection_string, host, port, username, ssl, ssl_mode
       FROM connections
      WHERE id = $1 AND org_id = $2`,
    [id, principal.orgId]
  );
  const saved = result.rows[0];

  // Another organization's connection reads as missing, the same answer a
  // deleted one gets, so this cannot be used to learn which ids exist.
  if (!saved) return { ok: false, status: 404, error: "Connection not found." };

  const storedPassword = String(saved.password ?? "");
  const storedConnString = String(saved.connection_string ?? "");
  const typedPassword = String(body.password ?? "");
  const typedConnString = String(body.connection_string ?? "").trim();

  const password = typedPassword === "" ? storedPassword : typedPassword;
  const connectionString = body.clear_connection_string
    ? ""
    : typedConnString === ""
      ? storedConnString
      : typedConnString;

  // Only when the loose fields are what will be dialled: a connection string
  // decides the destination itself and carries its own password.
  const keepsSavedPassword = typedPassword === "" && storedPassword !== "";
  if (keepsSavedPassword && !connectionString) {
    const moved = savedPasswordWouldMove(
      {
        host: String(saved.host ?? ""),
        port: Number(saved.port),
        username: String(saved.username ?? ""),
        sslMode: saved.ssl_mode ? toSslMode(saved.ssl_mode) : sslModeFromLegacyBoolean(saved.ssl),
      },
      {
        host: String(body.host ?? ""),
        port: parsePort(body.port) ?? 5432,
        username: String(body.username ?? ""),
        sslMode,
      }
    );
    if (moved) return { ok: false, status: 400, error: REENTER_PASSWORD_MESSAGE };
  }

  return { ok: true, password, connectionString };
}
