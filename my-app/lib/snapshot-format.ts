/**
 * What generation of this tool captured a snapshot, and what that generation
 * knew how to look at.
 *
 * A snapshot is stored as JSONB and never rewritten (lib/lineage-db.ts), so the
 * baseline a tracked schema is compared against was produced by whatever build
 * of this app happened to be running the day it was captured. Every time the
 * capture learned about a new kind of object — views, then grants, then row
 * security — the shape of that JSON changed, and an old baseline silently
 * stopped covering the new category.
 *
 * The comparator already survives that: a category is compared only when BOTH
 * sides recorded it (see the note on SchemaSnapshot in lib/postgres.ts), so
 * nothing is ever reported as "added" merely because the baseline predates it.
 * What the comparator could not do is say WHY, because `undefined` has two
 * meanings — "captured by a build that had never heard of this" and "captured
 * by a build that tried and was not allowed to". It guessed the first.
 *
 * Stamping the capture with a version separates them, and buys two more things:
 * a stored baseline can be judged stale WITHOUT running a comparison, and a
 * future change that alters an existing field rather than adding a new one has
 * somewhere to be detected. Optionality cannot help with that second case —
 * `undefined` never appears — so a version number is the only thing that can.
 *
 * Deliberately import-free, like lib/change-level.ts: the drift screen, the API
 * routes and the tests all read it, and pulling lib/postgres in for a constant
 * would drag the `pg` driver into the browser bundle.
 */

/**
 * The version stamped onto every snapshot this build captures.
 *
 * Bump it whenever the SHAPE changes — a new collection, a new field on an
 * existing one, or a change to how an existing value is rendered — and add a
 * row to SNAPSHOT_FORMAT_HISTORY saying what changed. Do not bump it for a bug
 * fix that leaves the shape alone.
 */
export const SNAPSHOT_FORMAT_VERSION = 4;

/**
 * What each version of the capture added, newest last.
 *
 * Versions 1 to 3 are reconstructed from the order the categories arrived in
 * lib/postgres.ts, and no stored snapshot carries those numbers — the field did
 * not exist yet. They are here so that the note shown to a user about an
 * unstamped baseline can name the categories it is missing rather than only
 * saying it is old.
 */
export const SNAPSHOT_FORMAT_HISTORY: ReadonlyArray<{
  version: number;
  adds: string;
}> = [
  { version: 1, adds: "tables, columns, primary keys, unique, foreign and check constraints" },
  { version: 2, adds: "indexes, triggers, views, sequences, types and routines" },
  { version: 3, adds: "collations, extensions, grants, row-level security and partitioning" },
  { version: 4, adds: "the format stamp itself" },
];

/**
 * The optional collections, in the order a reader would want them listed.
 *
 * `key` is the property on SchemaSnapshot; `label` is what to call it on
 * screen. Table-scoped categories (indexes, triggers, row security,
 * partitioning) are NOT here — they live inside each table, so their presence
 * is per-table and the comparator already reports it per-category through
 * `comparedObjectCategories`. This list is only about the schema-level shape,
 * which is what a stored baseline can be judged on without a comparison.
 */
export const SNAPSHOT_CATEGORIES: ReadonlyArray<{ key: string; label: string }> = [
  { key: "views", label: "views" },
  { key: "sequences", label: "sequences" },
  { key: "types", label: "types" },
  { key: "collations", label: "collations" },
  { key: "routines", label: "functions" },
  { key: "extensions", label: "extensions" },
  { key: "privileges", label: "grants" },
];

/** The least a value has to look like for this module to read it. */
export type VersionedSnapshot = {
  formatVersion?: number;
  [key: string]: unknown;
};

/**
 * The stamped version, or null when the snapshot predates stamping.
 *
 * Null is not zero. A snapshot captured the day before this shipped may well
 * record every category there is; all null says is that nothing in the JSON
 * claims a version, so the categories have to be counted instead of trusted.
 */
export function snapshotFormatVersion(snapshot: VersionedSnapshot | null | undefined): number | null {
  const declared = snapshot?.formatVersion;
  return typeof declared === "number" && Number.isFinite(declared) ? declared : null;
}

/** The schema-level categories this snapshot actually recorded. */
export function recordedCategories(snapshot: VersionedSnapshot | null | undefined): string[] {
  if (!snapshot) return [];
  return SNAPSHOT_CATEGORIES.filter((c) => Array.isArray(snapshot[c.key])).map((c) => c.label);
}

/** The schema-level categories this snapshot has no record of either way. */
export function unrecordedCategories(snapshot: VersionedSnapshot | null | undefined): string[] {
  if (!snapshot) return [];
  return SNAPSHOT_CATEGORIES.filter((c) => !Array.isArray(snapshot[c.key])).map((c) => c.label);
}

/**
 * How a stored baseline stands against the capture running right now.
 *
 * `kind` is what to do about it, not merely what it is:
 *   current  — nothing to say.
 *   older    — this build can see things the baseline never recorded, so those
 *              categories are being skipped. Re-baselining fixes it.
 *   newer    — the baseline came from a LATER build than this one. Rare, and
 *              only reachable by downgrading, but worth naming because the
 *              skipped categories are then on this side and re-baselining would
 *              make it worse.
 *   unstamped — no version to compare, so the categories were counted instead.
 */
export type SnapshotFormatGap = {
  kind: "current" | "older" | "newer" | "unstamped";
  /** The baseline's declared version, null when it predates stamping. */
  baselineVersion: number | null;
  /** What this build stamps, so a screen can print both sides. */
  currentVersion: number;
  /** Schema-level categories the baseline has no record of. Never null. */
  missing: string[];
  /** One sentence for the screen, or null when there is nothing to say. */
  note: string | null;
};

/** English list: "views", "views and grants", "views, types and grants". */
function joinList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/**
 * Compare a stored baseline's format against this build's.
 *
 * Takes the baseline alone rather than both sides on purpose: the live capture
 * is always this build, so the second side is a constant, and a caller that had
 * to pass it could pass the wrong one.
 */
export function snapshotFormatGap(
  baseline: VersionedSnapshot | null | undefined
): SnapshotFormatGap {
  const baselineVersion = snapshotFormatVersion(baseline);
  const missing = unrecordedCategories(baseline);

  if (baselineVersion !== null && baselineVersion > SNAPSHOT_FORMAT_VERSION) {
    return {
      kind: "newer",
      baselineVersion,
      currentVersion: SNAPSHOT_FORMAT_VERSION,
      missing,
      note:
        `This baseline was captured by a newer build of Schema Studio ` +
        `(snapshot format ${baselineVersion}; this build writes ${SNAPSHOT_FORMAT_VERSION}). ` +
        `Anything that build recorded and this one does not is left out of the comparison.`,
    };
  }

  if (missing.length === 0) {
    return {
      kind: baselineVersion === null ? "unstamped" : "current",
      baselineVersion,
      currentVersion: SNAPSHOT_FORMAT_VERSION,
      missing,
      note: null,
    };
  }

  // Both remaining cases say the same thing to the reader — some categories are
  // not being compared and re-baselining is the fix — so they share a sentence
  // and differ only in how confident it is about the reason.
  const reason =
    baselineVersion === null
      ? "This baseline predates snapshot format stamping"
      : `This baseline is snapshot format ${baselineVersion}; this build writes ${SNAPSHOT_FORMAT_VERSION}`;
  return {
    kind: baselineVersion === null ? "unstamped" : "older",
    baselineVersion,
    currentVersion: SNAPSHOT_FORMAT_VERSION,
    missing,
    note:
      `${reason}, and it has no record of ${joinList(missing)}. ` +
      `Those are left out of the drift check rather than reported as new — ` +
      `re-baseline this schema to start covering them.`,
  };
}
