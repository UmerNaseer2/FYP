import { Pool, type PoolConfig } from "pg";
import { parse as parseConnectionString } from "pg-connection-string";

export { parsePostgresUri, type ParsedUri } from "./parse-uri";

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
  /** Whether to negotiate SSL/TLS with the server. */
  ssl?: boolean | null;
};

const CONNECT_TIMEOUT_MS = 10000;

/**
 * Build a `pg` PoolConfig from saved/form input. SSL is driven *only* by the
 * `ssl` flag (the toggle), so behaviour is predictable regardless of any
 * `sslmode` inside a connection string. When SSL is on we accept the server's
 * certificate without local CA verification — hosted providers (Neon, Supabase,
 * RDS) commonly present chains the app host doesn't trust, and this tool only
 * reads schema metadata.
 */
export function buildPgConfig(input: ConnectionInput): PoolConfig {
  const ssl = input.ssl ? { rejectUnauthorized: false } : false;
  const raw = (input.connectionString ?? "").trim();

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
    password: input.password ?? "",
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

/** Successful test: light, honest facts gathered while the pool was open. */
export type TestSuccess = {
  ok: true;
  version: string;
  schemaCount: number;
  schemas: string[];
  latencyMs: number;
  ssl: boolean;
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
  const pool = new Pool(buildPgConfig(input));
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
      ssl: Boolean(input.ssl),
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
