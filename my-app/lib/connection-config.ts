import { Pool, type PoolConfig } from "pg";
import { parse as parseConnectionString } from "pg-connection-string";
import { decryptSecret, UNREADABLE_CREDENTIALS_MESSAGE } from "./secret-store";
import { BlockedHostError, checkConnectableHost } from "./host-guard";
import {
  sslModeFromLegacyBoolean,
  sslModeUsesTls,
  toSslMode,
  type SslMode,
} from "./connection-validate";

export { parsePostgresUri, type ParsedUri } from "./parse-uri";
// The host rule itself lives in lib/host-guard so that lib/postgres can check a
// host before opening a pool without importing this module. Re-exported because
// this is where callers have always found it.
export { BlockedHostError, checkConnectableHost } from "./host-guard";
export type { SslMode };

/**
 * Connection setup for the Connections screen: turn a saved row or a drawer
 * form into a working `pg` config, run a real "test connection", and translate
 * raw driver errors into clean, user-readable messages.
 *
 * This is deliberately separate from `lib/postgres.ts` (compare introspection)
 * and `lib/compare.ts` (diff logic). It only deals with *reaching* a server.
 */

/** Raw input from a saved connection row or the add/edit drawer. */
export type ConnectionInput = {
  host?: string | null;
  port?: number | string | null;
  database?: string | null;
  user?: string | null;
  password?: string | null;
  /** A full `postgres://…` URI. When present it wins over the loose fields. */
  connectionString?: string | null;
  /**
   * Legacy on/off flag, kept because the `connections.ssl` column still exists
   * and older callers still pass it. Used only when `sslMode` is absent.
   */
  ssl?: boolean | null;
  /**
   * How to negotiate TLS: "disable", "require" (encrypt, don't verify the
   * certificate) or "verify-full" (encrypt and verify). Optional so a call site
   * that hasn't been updated falls back to the exact legacy boolean behaviour
   * rather than silently changing what it does.
   */
  sslMode?: SslMode | string | null;
};

const CONNECT_TIMEOUT_MS = 10000;

/**
 * Work out the effective TLS mode for an input.
 *
 * `sslMode` wins when present. When it is absent — an older row, or a call site
 * that still selects only the `ssl` column — we fall back to the boolean, where
 * `true` has always meant "encrypt but don't verify", i.e. `require`.
 */
export function effectiveSslMode(input: ConnectionInput): SslMode {
  return input.sslMode !== null && input.sslMode !== undefined && input.sslMode !== ""
    ? toSslMode(input.sslMode)
    : sslModeFromLegacyBoolean(input.ssl);
}

/** Translate a mode into what the `pg` driver wants for its `ssl` option. */
function sslOptionFor(mode: SslMode): PoolConfig["ssl"] {
  if (!sslModeUsesTls(mode)) return false;
  // "require" encrypts the wire but accepts any certificate — hosted providers
  // (Neon, Supabase, RDS) commonly present chains the app host doesn't trust.
  // "verify-full" is the strict setting for anyone who can trust the chain.
  return { rejectUnauthorized: mode === "verify-full" };
}

/**
 * Build a `pg` PoolConfig from saved/form input.
 *
 * TLS is driven *only* by the resolved mode, so behaviour is predictable
 * regardless of any `sslmode` inside a connection string.
 *
 * Credentials are decrypted here. This function is the single choke point every
 * consumer of a stored credential passes through (the connections, lineage,
 * schema, scripts and versionsync routes, the Compare page and
 * runConnectionTest), which is why encryption at rest can be added without
 * touching any of them. decryptSecret passes plaintext through unchanged, so
 * rows written before encryption existed — and values typed straight into the
 * drawer — keep working.
 */
export function buildPgConfig(input: ConnectionInput): PoolConfig {
  const ssl = sslOptionFor(effectiveSslMode(input));
  const raw = (decryptSecret(input.connectionString) ?? "").trim();

  if (raw) {
    // Parse ourselves so we control SSL uniformly (don't pass the string
    // straight through, where an embedded sslmode could fight the toggle).
    const parsed = parseConnectionString(raw);
    return {
      host: parsed.host ?? undefined,
      port: parsed.port ? Number(parsed.port) : undefined,
      database: parsed.database ?? undefined,
      user: parsed.user ?? undefined,
      password: parsed.password ?? undefined,
      ssl,
      connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    };
  }

  return {
    host: (input.host ?? "localhost").trim() || "localhost",
    port: Number(input.port ?? 5432) || 5432,
    database: (input.database ?? "postgres").trim() || "postgres",
    user: (input.user ?? "postgres").trim() || "postgres",
    password: decryptSecret(input.password) ?? "",
    ssl,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
  };
}

/**
 * Translate a raw driver/network error into a clean message. `sslRequired` is
 * set when the server refused the connection because it demands SSL — the UI
 * uses it to nudge the user to turn the SSL toggle on.
 */
export function describeDbError(error: unknown): {
  message: string;
  sslRequired: boolean;
  detail: string;
} {
  // A host this server refuses to dial never reached the network, so none of
  // the driver patterns below can apply. Its message is already written for the
  // person reading it, and saying "check the connection details" instead would
  // send them looking for a fault in a connection that is fine.
  if (error instanceof BlockedHostError) {
    return { message: error.message, sslRequired: false, detail: error.message };
  }

  const err = error as { message?: string; code?: string } | undefined;
  const detail = (err?.message ?? String(error)).trim();
  const lower = detail.toLowerCase();
  const code = err?.code;

  // Server requires SSL but we connected without it. Providers phrase this
  // several ways: stock Postgres says "SSL connection is required"; hosted
  // proxies (Neon, some poolers) say "connection is insecure (try using
  // `sslmode=require`)"; others just mention requiring SSL.
  if (
    lower.includes("ssl connection is required") ||
    lower.includes("connection is insecure") ||
    lower.includes("sslmode=require") ||
    lower.includes("ssl is required") ||
    lower.includes("ssl required") ||
    (lower.includes("no encryption") && lower.includes("pg_hba")) ||
    (code === "28000" && lower.includes("ssl"))
  ) {
    return {
      message: "SSL required by server — turn SSL on and try again.",
      sslRequired: true,
      detail,
    };
  }

  // We tried SSL but the server doesn't speak it.
  if (lower.includes("does not support ssl") || lower.includes("server does not support ssl")) {
    return {
      message: "This server doesn't support SSL — turn SSL off and try again.",
      sslRequired: false,
      detail,
    };
  }

  if (code === "ECONNREFUSED" || lower.includes("econnrefused")) {
    return {
      message: "Connection refused. Check the host and port, and that the server is running.",
      sslRequired: false,
      detail,
    };
  }

  if (code === "ENOTFOUND" || code === "EAI_AGAIN" || lower.includes("getaddrinfo")) {
    return { message: "Host not found. Check the hostname.", sslRequired: false, detail };
  }

  if (code === "28P01" || lower.includes("password authentication failed")) {
    return {
      message: "Authentication failed. Check the username and password.",
      sslRequired: false,
      detail,
    };
  }

  if (code === "3D000" || lower.includes("does not exist")) {
    return { message: "That database doesn't exist on the server.", sslRequired: false, detail };
  }

  if (lower.includes("timeout") || lower.includes("timed out")) {
    return {
      message: "Connection timed out. The server may be unreachable or behind a firewall.",
      sslRequired: false,
      detail,
    };
  }

  return { message: "Could not connect. Check the connection details and try again.", sslRequired: false, detail };
}

/**
 * Check the host `pg` will really dial for this input.
 *
 * `checkConnectableHost(host)` on the fields of a saved row judges the hostname
 * written in the URL, and that is not always where the driver goes. In
 * `postgres://user:pw@db.example.com/app?host=169.254.169.254` the query
 * parameter wins over the hostname (so do `?port=` and `?user=`), and
 * `postgres://user:pw@/app` names no host at all. Saving used to read the URL
 * and see a database on the internet, while Compare, Deploy and Drift dialled
 * the cloud metadata service. buildPgConfig resolves an input exactly the way
 * the driver does, so the check runs on what it produces.
 *
 * `{ ok: true }` when the input cannot be resolved at all — a stored secret
 * this server cannot decrypt, a string the parser rejects. There is nothing to
 * judge, refusing the save would strand a row nobody can even rename, and
 * getPoolForConfig checks again before any socket opens.
 */
export function checkConnectionTarget(
  input: ConnectionInput
): { ok: true } | { ok: false; message: string } {
  let host: string | undefined;
  try {
    host = buildPgConfig(input).host;
  } catch {
    return { ok: true };
  }
  return checkConnectableHost(host);
}

/** Successful test: light, honest facts gathered while the pool was open. */
export type TestSuccess = {
  ok: true;
  version: string;
  schemaCount: number;
  schemas: string[];
  latencyMs: number;
  /** True when the connection was encrypted. Kept for existing UI callers. */
  ssl: boolean;
  /** The mode actually used, so the UI can say "require" vs "verify-full". */
  sslMode: SslMode;
};

export type TestFailure = {
  ok: false;
  error: string;
  sslRequired: boolean;
  detail: string;
};

export type TestResult = TestSuccess | TestFailure;

/** Trim `version()` output ("PostgreSQL 16.2 on x86_64…") down to "PostgreSQL 16.2". */
function shortenVersion(version: string): string {
  const match = version.match(/^PostgreSQL\s+[\d.]+/i);
  return match ? match[0] : version.split(" ").slice(0, 2).join(" ");
}

/**
 * Open a throwaway pool, confirm the server answers, and gather a few honest
 * facts (version, visible schemas, round-trip latency). Always closes the pool.
 */
export async function runConnectionTest(input: ConnectionInput): Promise<TestResult> {
  const sslMode = effectiveSslMode(input);

  let config: PoolConfig;
  try {
    config = buildPgConfig(input);
  } catch (error) {
    // buildPgConfig throws only when a stored secret can't be decrypted (wrong
    // or missing APP_ENCRYPTION_KEY). Say that plainly — passing ciphertext to
    // the driver instead would surface as "password authentication failed" and
    // send you looking at the wrong problem.
    console.error("Could not prepare the connection:", error);
    return {
      ok: false,
      error: UNREADABLE_CREDENTIALS_MESSAGE,
      sslRequired: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }

  // SSRF guard: refuse to dial blocked internal/metadata hosts before opening
  // a socket. buildPgConfig has already resolved the effective host (whether it
  // came from loose fields or a connection string).
  const hostCheck = checkConnectableHost(config.host);
  if (!hostCheck.ok) {
    return { ok: false, error: hostCheck.message, sslRequired: false, detail: "" };
  }

  const pool = new Pool(config);
  const started = Date.now();

  try {
    const versionResult = await pool.query<{ version: string }>("SELECT version() AS version");
    const schemaResult = await pool.query<{ schema_name: string }>(
      `SELECT schema_name
       FROM information_schema.schemata
       WHERE schema_name <> 'information_schema'
         AND schema_name NOT LIKE 'pg_%'
       ORDER BY schema_name`
    );

    const latencyMs = Date.now() - started;
    const schemas = schemaResult.rows.map((row) => row.schema_name);

    return {
      ok: true,
      version: shortenVersion(versionResult.rows[0]?.version ?? "PostgreSQL"),
      schemaCount: schemas.length,
      schemas,
      latencyMs,
      ssl: sslModeUsesTls(sslMode),
      sslMode,
    };
  } catch (error) {
    console.error("Connection test failed:", error);
    // describeDbError uses `message`; the TestFailure shape (and the UI) use
    // `error`, so map it across explicitly rather than spreading.
    const described = describeDbError(error);
    return {
      ok: false,
      error: described.message,
      sslRequired: described.sslRequired,
      detail: described.detail,
    };
  } finally {
    await pool.end().catch(() => {
      /* pool may never have connected — nothing to close */
    });
  }
}
