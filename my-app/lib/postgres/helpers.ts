/**
 * Small helpers the catalog readers share: turning what the driver hands back
 * into arrays and strings, quoting, and the list of this tool's own tables
 * that every read leaves out.
 */

// Bookkeeping this tool writes into the schemas it manages. Comparing a target
// against a baseline must not report our own ledgers as a difference, or the
// first migration and the first revert each invent drift out of nothing.
export const COMPARE_IGNORED_TABLES = ["script_patch", "script_patch_reverted"];

/**
 * Read a `json_agg(...)` column back as an array.
 *
 * node-postgres parses a json column into real JavaScript values, but PGlite
 * (used for local verification) hands the same column back as text — the same
 * split coerceTextArray exists for.
 */
export function coerceJsonArray<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (typeof value !== "string") return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

/**
 * A JSON value that is a non-empty string, or null.
 *
 * Used on catalog columns read through to_jsonb, where a column the server
 * version does not have comes back `undefined` rather than raising an error —
 * which is the whole reason those columns are read that way.
 */
export function textOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** A SQL string literal, for values that go in a statement rather than names. */
export function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function coerceTextArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((entry) => String(entry).trim())
      .filter((entry) => entry.length > 0);
  }

  if (typeof value !== "string") {
    return [];
  }

  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed === "{}") {
    return [];
  }

  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    const inner = trimmed.slice(1, -1).trim();
    if (inner.length === 0) {
      return [];
    }

    return inner
      .split(",")
      .map((entry) => entry.replace(/^"(.*)"$/, "$1").trim())
      .filter((entry) => entry.length > 0);
  }

  return [trimmed];
}

/**
 * Role names as `TO ...` wants them.
 *
 * `public` is a keyword here, not a role: PostgreSQL has no role called public,
 * so `TO "public"` fails with `role "public" does not exist` while `TO public`
 * is the "everybody" form pg_policies reports for an unrestricted policy. Same
 * for the CURRENT_USER family. Everything else is a real role name and gets
 * quoted like any other identifier.
 */
const UNQUOTED_ROLE_SPECS = new Set([
  "public",
  "current_role",
  "current_user",
  "session_user",
]);

export function quoteRole(role: string): string {
  if (UNQUOTED_ROLE_SPECS.has(role.toLowerCase())) {
    return role.toLowerCase();
  }
  return `"${role.replace(/"/g, '""')}"`;
}
