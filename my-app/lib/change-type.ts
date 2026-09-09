// How a script's change type is decided, in one place.
//
// The deploy screen only ever sees a script as text — it pulls the .sql file
// out of GitHub — so for a long time it worked the type out by searching that
// text for "drop table" and friends. Two things were wrong with that. The
// search ran over the comments as well as the SQL, and a safe-mode script says
// "(DROP TABLE / DROP COLUMN) are commented out below" in its own header, so a
// migration that only ADDS things graded itself breaking and forced a major
// version bump. And the accurate answer already existed: the generator knows
// exactly which statements it wrote and how severe each one is, and then threw
// that away at render time.
//
// So the generator now stamps its answer into the script header, and this
// module reads it. The text search is still here, because a hand-written script
// or one from an older version has no stamp — but it runs on a masked copy with
// every comment, literal and quoted identifier blanked out.
import { maskNonCode } from "./sql-guard";
import { normalizeChangeLevel, type ChangeLevel } from "./version-detection";

/**
 * The header line the generator writes and this module reads back.
 *
 * A comment, so it is inert SQL wherever the script ends up, and a fixed key so
 * reading it never depends on the prose around it.
 */
export const CHANGE_TYPE_HEADER_KEY = "Change-type";

/**
 * What a script can be graded as.
 *
 * "unknown" is a reading of somebody else's version table — it is never a
 * verdict this module reaches, so callers do not have to handle it.
 */
export type ScriptChangeType = Exclude<ChangeLevel, "unknown">;

/** Write the stamp the generator puts in a rendered script header. */
export function changeTypeHeaderLine(level: ChangeLevel): string {
  return `-- ${CHANGE_TYPE_HEADER_KEY}: ${level}`;
}

/**
 * Read the generator's own grading back out of a script, or null when the
 * script does not carry one.
 *
 * Only the header is searched — the first lines, before any statement — so a
 * stray line of the same shape further down cannot restate the answer.
 */
export function readChangeTypeHeader(sql: string): ScriptChangeType | null {
  const pattern = new RegExp(`^\\s*--\\s*${CHANGE_TYPE_HEADER_KEY}\\s*:\\s*(\\w+)`, "i");
  for (const line of sql.split(/\r?\n/)) {
    const match = line.match(pattern);
    if (match) {
      const level = normalizeChangeLevel(match[1]);
      return level === "unknown" ? null : level;
    }
    // Stop at the first line that is neither blank nor a comment: everything
    // after that is the body, and the stamp belongs to the header.
    const trimmed = line.trim();
    if (trimmed.length > 0 && !trimmed.startsWith("--")) return null;
  }
  return null;
}

/**
 * Grade a script by reading the SQL it will actually run.
 *
 * The scan runs on maskNonCode's output, so a keyword inside a comment, a
 * string literal or a quoted identifier counts for nothing — which is what
 * makes a safe-mode script, whose drops are all commented out, grade as what it
 * really does rather than as what it describes.
 */
export function inferChangeTypeFromSql(sql: string): ScriptChangeType {
  const code = maskNonCode(sql).toLowerCase();
  if (
    /\bdrop\s+table\b/.test(code) ||
    /\bdrop\s+column\b/.test(code) ||
    /\bdrop\s+constraint\b/.test(code) ||
    /\bset\s+not\s+null\b/.test(code) ||
    /\balter\s+column\b/.test(code) ||
    /\brename\b/.test(code)
  ) {
    return "breaking";
  }
  if (
    /\bcreate\s+table\b/.test(code) ||
    /\badd\s+column\b/.test(code) ||
    /\badd\s+constraint\b/.test(code) ||
    /\bcreate\s+index\b/.test(code)
  ) {
    return "additive";
  }
  return "patch";
}

/**
 * The change type of a script: what the generator recorded if it wrote this
 * one, otherwise what the SQL itself says.
 */
export function changeTypeOf(sql: string): ScriptChangeType {
  return readChangeTypeHeader(sql) ?? inferChangeTypeFromSql(sql);
}
