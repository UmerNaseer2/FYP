import { Pool, type PoolConfig } from "pg";
import { parse as parseConnectionString } from "pg-connection-string";
import { decryptSecret } from "./secret-store";
import {
  sslModeFromLegacyBoolean,
  sslModeUsesTls,
  toSslMode,
  type SslMode,
} from "./connection-validate";

export { parsePostgresUri, type ParsedUri } from "./parse-uri";
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

/** A 32-bit address written back as a dotted quad. */
function dottedQuad(value: number): string {
  return [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join(
    "."
  );
}

/**
 * The IPv4 address a host literal really names, or null when it names none.
 *
 * A blocklist that compares strings only blocks the spellings it was shown.
 * `::ffff:127.0.0.1` and `2130706433` are both loopback to every resolver there
 * is, and neither of them starts with "127.", so both walked straight past the
 * check below. Normalising first is what makes that check about the address
 * rather than about how somebody chose to type it.
 *
 * Deliberately narrow — IPv4-mapped IPv6 and the bare 32-bit integer. Per-octet
 * octal ("0177.0.0.1") is left alone on purpose: platforms disagree about what
 * it means, macOS resolves it to the public 177.0.0.1, and guessing wrong would
 * block a host that is genuinely reachable.
 */
function toIPv4Literal(host: string): string | null {
  // ::ffff:127.0.0.1 and ::127.0.0.1 — the dotted tail is the address.
  const mapped = /^::(?:ffff:)?(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(host);
  if (mapped) return mapped[1];

  // ::ffff:7f00:1 — the same address written as two hex groups.
  const hex = /^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
  if (hex) {
    return dottedQuad(((parseInt(hex[1], 16) << 16) + parseInt(hex[2], 16)) >>> 0);
  }

  // A bare 32-bit number: 2130706433 is 127.0.0.1, 2852039166 is the metadata
  // service. Every C resolver accepts this form.
  if (/^\d+$/.test(host)) {
    const value = Number(host);
    if (Number.isInteger(value) && value >= 0 && value <= 0xffffffff) {
      return dottedQuad(value);
    }
  }

  return null;
}

/**
 * Guard the connection-TEST endpoints against being used as a server-side
 * request forgery (SSRF) / internal port scanner. These endpoints dial whatever
 * host:port the caller names, so without this an outside caller could probe the
 * server's private network or cloud metadata service.
 *
 *   - Cloud metadata + link-local addresses are blocked ALWAYS — they are never
 *     a real database and are the classic SSRF target.
 *   - Loopback + RFC1918 private ranges are blocked in PRODUCTION only (so local
 *     development against a localhost Postgres still works). Set
 *     ALLOW_PRIVATE_DB_HOSTS=true to opt back in on a trusted/VPC deployment.
 *
 * Note: this checks the literal host only; a public hostname that resolves to an
 * internal IP (DNS rebinding) is not caught here. The real long-term fix is
 * server-side authentication on these routes.
 */
export function checkConnectableHost(
  host: string | undefined
): { ok: true } | { ok: false; message: string } {
  const raw = (host ?? "").trim().toLowerCase();
  // A connection string carries an IPv6 literal in brackets. The address is
  // what is being judged, not the punctuation a URL needed around it.
  const h = raw.startsWith("[") && raw.endsWith("]") ? raw.slice(1, -1) : raw;

  // Every spelling of the same address has to get the same answer, so both the
  // literal and its normalised form are tested.
  const forms = [h];
  const normalised = toIPv4Literal(h);
  if (normalised !== null) forms.push(normalised);

  const alwaysBlocked = forms.some(
    (f) =>
      f === "metadata.google.internal" ||
      f.startsWith("169.254.") || // IPv4 link-local, incl. 169.254.169.254 metadata
      f.startsWith("fe80:") || // IPv6 link-local
      f === "::" ||
      f === "0.0.0.0"
  );
  if (alwaysBlocked) {
    return { ok: false, message: "That host isn't allowed." };
  }

  const blockPrivate =
    process.env.NODE_ENV === "production" &&
    process.env.ALLOW_PRIVATE_DB_HOSTS !== "true";
  if (blockPrivate) {
    const isPrivate = forms.some(
      (f) =>
        f === "localhost" ||
        f.endsWith(".localhost") ||
        f.startsWith("127.") ||
        f === "::1" ||
        f.startsWith("10.") ||
        f.startsWith("192.168.") ||
        /^172\.(1[6-9]|2\d|3[01])\./.test(f) ||
        f.endsWith(".internal") ||
        f.endsWith(".local")
    );
    if (isPrivate) {
      return {
        ok: false,
        message: "Connections to internal/private hosts are disabled on this server.",
      };
    }
  }

  return { ok: true };
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
      error: "This connection's stored credentials can't be read on this server.",
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
