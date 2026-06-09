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
