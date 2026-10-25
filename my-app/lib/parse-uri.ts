/**
 * Client-safe `postgres://` URI parser. Lives in its own module (no `pg`
 * import) so the Connections drawer can show a live "Parsed" preview in the
 * browser, while the server uses the same helper inside `connection-config.ts`.
 */

/** The visible parts of a parsed `postgres://` URI (never the password). */
export type ParsedUri = {
  host: string;
  port: string;
  database: string;
  user: string;
  /** The `sslmode` query param if the URI carried one (e.g. "require"). */
  sslmode: string | null;
};

/**
 * Parse a `postgres://` / `postgresql://` URI into its visible parts. Returns
 * `null` when the string is empty or not a valid URL. Never throws.
 */
export function parsePostgresUri(raw: string): ParsedUri | null {
  const value = (raw ?? "").trim();
  if (!value) return null;

  try {
    // Swap the scheme so the built-in URL parser accepts it, then read parts.
    const url = new URL(value.replace(/^postgres(ql)?:/i, "http:"));
    return {
      host: url.hostname || "—",
      port: url.port || "5432",
      database: decodeURIComponent((url.pathname || "").replace(/^\//, "")) || "—",
      user: decodeURIComponent(url.username) || "—",
      sslmode: url.searchParams.get("sslmode"),
    };
  } catch {
    return null;
  }
}

/** Everything a `postgres://` URI carries, with "" for a part it leaves out. */
export type UriFields = {
  host: string;
  port: string;
  database: string;
  user: string;
  password: string;
};

/**
 * Split a `postgres://` URI into the Connections drawer's separate fields, for
 * when someone types a connection string and then switches to "Fields".
 * Returns `null` when the string is empty, has another scheme, or is not a
 * valid URL. Never throws.
 *
 * Unlike `parsePostgresUri`, this includes the password. It must only ever go
 * into the drawer's masked password field: never shown, logged or put back
 * into a visible connection string.
 */
export function uriToFields(raw: string): UriFields | null {
  const value = (raw ?? "").trim();
  if (!/^postgres(ql)?:\/\//i.test(value)) return null;

  try {
    const url = new URL(value.replace(/^postgres(ql)?:/i, "http:"));
    return {
      // A URI needs brackets around an IPv6 address; the Host field doesn't.
      host: url.hostname.replace(/^\[(.*)\]$/, "$1"),
      port: url.port,
      database: decodeURIComponent(url.pathname.replace(/^\//, "")),
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
    };
  } catch {
    return null;
  }
}
