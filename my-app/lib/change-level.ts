// How a change is graded — breaking, additive or patch — and nothing else.
//
// This lived in version-detection.ts, which opens a database connection to read
// somebody else's version table and so imports `pg`. change-type.ts needs only
// the grading, but a value import is a value import: the deploy screen is a
// client component, it calls changeTypeOf, and that dragged
// change-type → version-detection → postgres → pg into the browser bundle.
// Turbopack then failed to resolve node's `dns` from the browser and the whole
// /deploy page answered 500.
//
// So the vocabulary lives on its own, with no imports at all. Both sides read
// it: version-detection re-exports it so its own callers are unaffected, and
// change-type imports it directly.

/** What a version, a script or a diff can be graded as. */
export type ChangeLevel = "breaking" | "additive" | "patch" | "unknown";

/**
 * Build a whole-word matcher for one set of words.
 *
 * Whole words on purpose. This used to be a plain `text.includes("add")`, which
 * graded any migration whose description mentioned an *address* column as
 * additive, and `includes("drop")` did the same to "dropdown". A word boundary
 * is the difference between reading the description and pattern-matching it.
 *
 * The endings are spelled out below rather than derived from a suffix rule.
 * English is not regular enough for one — "create" loses its e in "creating",
 * "drop" doubles its p in "dropped" — and a list anybody can read and extend
 * beats a rule that has to be trusted.
 */
function wordMatcher(words: string[]): RegExp {
  return new RegExp(`\\b(?:${words.join("|")})\\b`, "i");
}

const BREAKING_WORDS = wordMatcher([
  "breaking",
  "major",
  "drop", "drops", "dropped", "dropping",
  "remove", "removes", "removed", "removing", "removal",
  "delete", "deletes", "deleted", "deleting", "deletion",
]);

const ADDITIVE_WORDS = wordMatcher([
  "additive",
  "minor",
  "add", "adds", "added", "adding", "addition",
  "create", "creates", "created", "creating", "creation",
]);

const PATCH_WORDS = wordMatcher([
  "patch", "patches", "patched",
  "fix", "fixes", "fixed",
  "small",
]);

/**
 * Grade one piece of text as breaking / additive / patch.
 *
 * Exported because it is the whole rule for how a foreign version table gets
 * colour-coded on the Compare screen, and a rule that reads prose deserves to
 * be pinned down by name rather than only through a database.
 */
export function normalizeChangeLevel(value: unknown): ChangeLevel {
  const text = String(value ?? "");

  if (BREAKING_WORDS.test(text)) return "breaking";
  if (ADDITIVE_WORDS.test(text)) return "additive";
  if (PATCH_WORDS.test(text)) return "patch";

  return "unknown";
}

/** The Pill tones a change level may take (components/ui/Pill). */
export type ChangeLevelTone = "break" | "pending" | "neutral";

/**
 * How every screen shows a change level as a pill: its word and its tone.
 *
 * One table, so the screens agree. Version Sync, Deploy, the schema page and
 * the Script Editor each picked their own colours, and the same level came out
 * green on one screen and blue or grey on another. The tones follow the
 * version timeline's dots (.vtl__dot.lvl-* in globals.css): breaking uses
 * --break, additive --pending, patch the grey --text-3. Green (--sync) is left
 * for "applied" and "in sync", so a level never reads as a status. A level
 * nobody recorded says so, as the timeline's legend does, rather than showing
 * "unknown" as if it were a level.
 */
export const CHANGE_LEVEL_PILL: Record<ChangeLevel, { word: string; tone: ChangeLevelTone }> = {
  breaking: { word: "breaking", tone: "break" },
  additive: { word: "additive", tone: "pending" },
  patch: { word: "patch", tone: "neutral" },
  unknown: { word: "level not recorded", tone: "neutral" },
};

/**
 * A stored change type (a ledger row's change_type) as the word its pill
 * shows. For text where a pill does not fit, such as a list entry: it reads
 * the value the same way the pill and the timeline dot do, so "major" in an
 * old ledger row is "breaking" here too, never the raw text.
 */
export function changeLevelWord(value: unknown): string {
  return CHANGE_LEVEL_PILL[normalizeChangeLevel(value)].word;
}
