import { parsePostgresUri } from "./parse-uri";
import { ENVIRONMENTS, toEnvironment, type Environment } from "./environments";

/**
 * Validation for a saved connection, shared by the drawer form and the
 * /api/connections handlers.
 *
 * It lives in one isomorphic module on purpose. The previous split — a few
 * `required` checks in the browser, a different few in the route — let a direct
 * POST persist a row the rest of the app could not use: `type: "MySQL"` saved
 * cleanly but was filtered out of Compare and rejected by both test endpoints,
 * and a port of `-1` or `99999` went into an INTEGER column unchallenged.
 */

/** The only engine the compare/test paths accept. Enforced on save as well now. */
export const SUPPORTED_TYPES = ["PostgreSQL"] as const;
export type ConnectionType = (typeof SUPPORTED_TYPES)[number];

/**
 * How TLS is negotiated with a target.
 *   disable     - no TLS at all (plain local Postgres)
 *   require     - encrypt, but accept whatever certificate is presented
 *   verify-full - encrypt AND verify the certificate chain and hostname
 */
export const SSL_MODES = ["disable", "require", "verify-full"] as const;
export type SslMode = (typeof SSL_MODES)[number];

export const DEFAULT_SSL_MODE: SslMode = "disable";

/** What lib/parse-uri.ts substitutes for a part the URI doesn't carry. */
const MISSING = "\u2014";

export const PORT_MIN = 1;
export const PORT_MAX = 65535;

export const LIMITS = {
  name: 100,
  host: 255,
  database: 63, // Postgres NAMEDATALEN - 1
  username: 63,
  connectionString: 2048,
} as const;

/** A field-keyed map of problems: { port: "Port must be between 1 and 65535." } */
export type FieldErrors = Partial<Record<string, string>>;

export type ConnectionDraft = {
  name?: unknown;
  host?: unknown;
  port?: unknown;
  database_name?: unknown;
  type?: unknown;
  username?: unknown;
  password?: unknown;
  connection_string?: unknown;
  ssl_mode?: unknown;
  environment?: unknown;
};

/** What a draft looks like once it has been checked and normalised. */
export type NormalisedConnection = {
  name: string;
  host: string;
  port: number;
  database_name: string;
  type: ConnectionType;
  username: string;
  password: string;
  connection_string: string;
  ssl_mode: SslMode;
  environment: Environment;
};

/**
 * Hostname or IP literal. Deliberately permissive about what a *name* may
 * contain (Docker service names, `db.internal`, single labels) while still
 * rejecting the things that indicate the field was misused: whitespace, a
 * scheme, a port suffix, a path, credentials.
 */
const HOSTNAME_RE = /^(?=.{1,255}$)[a-zA-Z0-9_](?:[a-zA-Z0-9_-]*[a-zA-Z0-9_])?(?:\.[a-zA-Z0-9_](?:[a-zA-Z0-9_-]*[a-zA-Z0-9_])?)*$/;
const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function isIpv4(value: string): boolean {
  const m = value.match(IPV4_RE);
  if (!m) return false;
  return m.slice(1).every((octet) => {
    const n = Number(octet);
    return String(n) === String(Number(octet)) && n >= 0 && n <= 255;
  });
}

function isIpv6(value: string): boolean {
  // Accept bracketed and bare forms; the URL parser is the authority on shape.
  const bare = value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
  if (!bare.includes(":")) return false;
  try {
    // Throws for anything that isn't a valid IPv6 literal.
    return Boolean(new URL(`http://[${bare}]/`).hostname);
  } catch {
    return false;
  }
}

/** True when `value` is usable as a host: a hostname, an IPv4 or an IPv6 literal. */
export function isValidHost(value: string): boolean {
  const host = value.trim();
  if (!host || host.length > LIMITS.host) return false;
  if (/[\s/\\@]/.test(host)) return false; // scheme, path, credentials, spaces
  if (host.includes(":")) return isIpv6(host); // a bare "host:5432" is a port, not a host

  // An all-numeric dotted string is meant to be an IPv4 address, so hold it to
  // that standard rather than letting HOSTNAME_RE wave through a typo like
  // "999.1.1.1" or "10.0.0" as if it were a DNS name. (No real hostname ends in
  // an all-digit label, because no TLD is numeric.)
  if (/^[\d.]+$/.test(host)) return isIpv4(host);

  return HOSTNAME_RE.test(host);
}

/** Narrow an arbitrary value to a supported SSL mode. */
export function toSslMode(value: unknown): SslMode {
  const raw = String(value ?? "").trim().toLowerCase();
  return (SSL_MODES as readonly string[]).includes(raw) ? (raw as SslMode) : DEFAULT_SSL_MODE;
}

/**
 * Bridge for the legacy boolean `ssl` column: `true` meant "encrypt, don't
 * verify", which is exactly `require`. Used when reading rows written before
 * ssl_mode existed.
 */
export function sslModeFromLegacyBoolean(ssl: unknown): SslMode {
  return ssl ? "require" : "disable";
}

/** `require` and `verify-full` both negotiate TLS; only the verification differs. */
export function sslModeUsesTls(mode: SslMode): boolean {
  return mode !== "disable";
}

/**
 * Parse a port from anything the wire might carry. Returns null when the value
 * is not a whole number inside the valid range — the caller decides whether that
 * is "use the default" (absent) or "reject" (present but wrong).
 */
export function parsePort(value: unknown): number | null {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const n = Number(value);
  if (!Number.isInteger(n)) return null;
  if (n < PORT_MIN || n > PORT_MAX) return null;
  return n;
}

/**
 * Validate and normalise a connection draft.
 *
 * `mode` matters for the credential rule only: on create a credential is
 * mandatory, while on edit a blank password means "keep the stored one" and the
 * route resolves the effective credential against the existing row.
 */
export function validateConnection(
  draft: ConnectionDraft,
  mode: "create" | "edit" = "create"
): { ok: true; value: NormalisedConnection } | { ok: false; errors: FieldErrors } {
  const errors: FieldErrors = {};

  const name = String(draft.name ?? "").trim();
  const host = String(draft.host ?? "").trim();
  const database_name = String(draft.database_name ?? "").trim();
  const username = String(draft.username ?? "").trim();
  const password = String(draft.password ?? "");
  const connection_string = String(draft.connection_string ?? "").trim();
  const rawType = String(draft.type ?? "PostgreSQL").trim();
  const ssl_mode = toSslMode(draft.ssl_mode);
  // An omitted environment is the normal case for an older client, and "unset"
  // is a truthful answer to "which environment is this?".
  //
  // A value that was sent but is not one of ours is a different thing, and it
  // is not narrowed quietly. "production" instead of "prod" would be stored as
  // "unset" — the *lowest* rank — so the user would believe they had labelled a
  // live database and nothing would ever warn them about it. Silence in that
  // direction is the one failure this whole column exists to prevent.
  const rawEnvironment = String(draft.environment ?? "").trim();
  const environment = toEnvironment(rawEnvironment);

  const usingUri = connection_string !== "";

  if (rawEnvironment !== "" && rawEnvironment.toLowerCase() !== environment) {
    errors.environment =
      `"${rawEnvironment}" is not an environment. Use one of: ${ENVIRONMENTS.join(", ")}.`;
  }

  if (!name) errors.name = "Give this connection a name.";
  else if (name.length > LIMITS.name) errors.name = `Name must be ${LIMITS.name} characters or fewer.`;

  if (!(SUPPORTED_TYPES as readonly string[]).includes(rawType)) {
    errors.type = `Only ${SUPPORTED_TYPES.join(", ")} is supported right now.`;
  }

  if (usingUri) {
    if (connection_string.length > LIMITS.connectionString) {
      errors.connection_string = "That connection string is too long.";
    } else {
      const parsed = parsePostgresUri(connection_string);
      if (!parsed) {
        // The URL parser rejects an out-of-range port outright, which would
        // otherwise surface as a vague "doesn't parse". Name the real cause.
        const portish = connection_string.match(/:(\d+)(?:[/?]|$)/);
        errors.connection_string =
          portish && parsePort(portish[1]) === null
            ? `The URI's port must be between ${PORT_MIN} and ${PORT_MAX}.`
            : "That doesn't parse as a postgres:// URI.";
      } else if (parsed.host === MISSING || !isValidHost(parsed.host)) {
        errors.connection_string = "The URI has no usable host.";
      } else if (parsed.port && parsePort(parsed.port) === null) {
        errors.connection_string = `The URI's port must be between ${PORT_MIN} and ${PORT_MAX}.`;
      }
    }
  } else {
    if (!host) errors.host = "Enter a host.";
    else if (!isValidHost(host)) errors.host = "That isn't a valid hostname or IP address.";

    if (!database_name) errors.database_name = "Enter a database name.";
    else if (database_name.length > LIMITS.database) {
      errors.database_name = `Database name must be ${LIMITS.database} characters or fewer.`;
    }

    if (!username) errors.username = "Enter a username.";
    else if (username.length > LIMITS.username) {
      errors.username = `Username must be ${LIMITS.username} characters or fewer.`;
    }

    // Absent is fine (defaults to 5432); present-but-invalid is not.
    const portGiven = draft.port !== null && draft.port !== undefined && String(draft.port).trim() !== "";
    if (portGiven && parsePort(draft.port) === null) {
      errors.port = `Port must be a whole number between ${PORT_MIN} and ${PORT_MAX}.`;
    }

    if (mode === "create" && !password) {
      errors.password = "Enter a password, or switch to a connection string.";
    }
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };

  // parsePostgresUri reports a missing part as "—" (the same sentinel the
  // drawer's live preview shows). That is fine on screen but must never be
  // written to a column, so drop it back to empty here.
  const fromUri = usingUri ? parsePostgresUri(connection_string) : null;
  const uriPart = (value: string | undefined) =>
    !value || value === MISSING ? "" : value;

  return {
    ok: true,
    value: {
      name,
      host: usingUri ? (uriPart(fromUri?.host) || host) : host,
      port: usingUri
        ? (parsePort(fromUri?.port) ?? 5432)
        : (parsePort(draft.port) ?? 5432),
      database_name: usingUri
        ? (uriPart(fromUri?.database) || database_name)
        : database_name,
      type: rawType as ConnectionType,
      username: usingUri ? (uriPart(fromUri?.user) || username) : username,
      password,
      connection_string,
      ssl_mode,
      environment,
    },
  };
}

/** Flatten field errors into one sentence for a plain-text error response. */
export function summariseErrors(errors: FieldErrors): string {
  return Object.values(errors).filter(Boolean).join(" ");
}
