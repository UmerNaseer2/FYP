// Two sides' versions on one timeline, and which side is behind in each
// script group.
//
// "Two sides" is the Compare screen's source and target, or Deploy's GitHub
// registry and the database. Each side hands over a flat list of the versions
// it knows. mergeTimelines lines them up with one row per version, so a
// version one side has and the other lacks shows as a gap in one list, rather
// than as two lists the reader has to line up by eye.
//
// A "script group" is a family of scripts that share a name
// (script_patch.script_name). Versions only compare inside one group:
// users_migration v3.0.0 says nothing about orders_migration v1.0.0.
// compareFamilyHeads answers "which side is behind" group by group. It is the
// one rule behind the version detector's verdict on the Compare screen and
// behind every "(Outdated)" label the screens print.
//
// Pure on purpose: no database, no fetch, no React. The detector runs it on
// the server and the timeline component runs it in the browser, so both read
// the same rule.
import { normalizeChangeLevel, type ChangeLevel } from "./change-level";
import { louderChangeType } from "./change-type";
import { vLabel } from "./rollback-plan";
import { compareVersions, highestVersion, looksLikeVersion, versionKey } from "./script-status";
// Type-only: version-detection opens database connections, and a value import
// from it would drag `pg` into the browser bundle.
import type { NewerSide } from "./version-detection";
import type { LedgerEntry as SyncLedgerEntry } from "./version-sync";

// ── Types ───────────────────────────────────────────────────────────────────

/** One version, as one side recorded it. */
export type TimelineEntry = {
  /** The script group (script_patch.script_name), or null when the table has none. */
  scriptName: string | null;
  /** As this side wrote it: "v1.2.0", "1.2.0", Flyway's "1.4", a Rails timestamp. */
  version: string;
  /** ISO timestamp of when it was applied, or null when the table does not say. */
  appliedAt: string | null;
  /**
   * Who applied it (spec 07 — execution history for auditing), or null when
   * the table does not say. Optional because most sides cannot answer it: a
   * registry file was never "applied by" anyone, and a ledger written by
   * another tool has no such column.
   */
  appliedBy?: string | null;
  changeType: ChangeLevel;
  /** The SQL that ran, or null when the table does not store it. */
  sqlContent: string | null;
  /** A title or description the table stores, if any. */
  label?: string | null;
  /** The run failed (Flyway's success = false). A failed entry is never a head. */
  failed?: boolean;
  /**
   * The side's own reader already decided this is its current version (the
   * version detector's pickCurrentVersion). When an entry in a group is marked,
   * the marked one is that side's head and the highest-version rule is not
   * used, so the timeline's HEAD and the headline above it name the same row.
   */
  isHead?: boolean;
};

/** A status word for one side of a row, such as Deploy's Applied / Pending / Skipped. */
export type TimelineStatus = {
  text: string;
  tone: "applied" | "pending" | "skipped" | "rolled-back" | "failed";
  /** The sentence that explains the word, shown as a tooltip. */
  title?: string;
};

/** One version on the merged timeline. */
export type TimelineRow = {
  /** The script group, or null for versions from a table without one. */
  family: string | null;
  /** As written: the left side's spelling when it has the version, else the right side's. */
  version: string;
  /** The row's identity inside its group. For matching only; never display it. */
  key: string;
  left: TimelineEntry | null;
  right: TimelineEntry | null;
  /** This row is the left side's head (its current version) in its group. */
  isLeftHead: boolean;
  isRightHead: boolean;
  /**
   * The left side's list is partial and stops above this version, so whether
   * the left side has it is not known. Always false when `left` is set.
   */
  leftUnknown: boolean;
  rightUnknown: boolean;
  /** The louder of the two sides' levels: a version graded breaking on either side reads breaking. */
  changeType: ChangeLevel;
  /** Set by the screen that draws the row (Deploy), never by mergeTimelines. */
  leftStatus?: TimelineStatus | null;
  rightStatus?: TimelineStatus | null;
};

/** What mergeTimelines needs to know about each side's list. */
export type MergeOptions = {
  /**
   * The left list is only part of a longer history: the newest few entries,
   * plus the head of every script group the side has (the Compare screen's
   * five-row preview is one). A partial list must include those heads; a group
   * it shows nothing of is read as a group the side does not have. Rows below
   * the oldest version it shows are marked leftUnknown rather than missing.
   */
  leftPartial?: boolean;
  rightPartial?: boolean;
};

/** One script group's head on each side, and which side is behind in it. */
export type FamilyHeadRow = {
  family: string;
  /** The left side's head, or null when the left side has no version in this group. */
  left: string | null;
  right: string | null;
  /** The side that is behind. A side with no version in the group is behind. Null when equal. */
  older: "left" | "right" | null;
};

export type FamilyHeadComparison = {
  /**
   * "left-behind": the right side is ahead in at least one group and behind in none.
   * "right-behind": the other way round.
   * "diverged": each side is ahead in at least one group.
   * "same": every group has the same head on both sides.
   */
  verdict: "left-behind" | "right-behind" | "same" | "diverged";
  /** The groups where the left side is ahead, by name. */
  leftAheadIn: string[];
  rightAheadIn: string[];
};

// ── Small shared rules ─────────────────────────────────────────────────────

/** A release number and nothing else: "1.2.0", "v2", "1.2.0.3". */
const PLAIN_VERSION = /^v?\d+(\.\d+)*$/i;

/**
 * The key two sides' versions are matched on inside one group.
 *
 * A plain release number goes through versionKey, the app's one
 * spelling-insensitive key, so "v1.2.0" on one side and "1.2.0" on the other
 * are one row. Anything else is matched exactly as written. versionKey reads
 * only the digits, so a Laravel name such as "2024_01_15_000000_create_users"
 * would share its key with "2024_01_15_000000_create_posts" and merge two
 * different migrations into one row.
 *
 * Exported so a screen can find the row for a version it holds (Deploy's
 * revertable version): TimelineRow.key is this key.
 */
export function timelineKey(version: string): string {
  const trimmed = version.trim();
  return PLAIN_VERSION.test(trimmed) ? versionKey(trimmed) : `text:${trimmed}`;
}

/** Code-point order, the same on the server and in every browser (localeCompare is not). */
function byName(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * A head from a heads map, or null. An own-property check, because a plain
 * lookup of a group called "constructor" would find Object's constructor.
 */
function headOf(heads: Record<string, string>, family: string): string | null {
  return Object.prototype.hasOwnProperty.call(heads, family) ? heads[family] : null;
}

/** A script_name that names a group: not null, not blank. */
function groupName(scriptName: string | null | undefined): string | null {
  return typeof scriptName === "string" && scriptName.trim() !== "" ? scriptName : null;
}

/**
 * A version as the screens print it.
 *
 * A version in a script group was written by this app (script_patch, the
 * registry) and reads "v1.2.0", the way Deploy prints it. A version another
 * tool wrote (Flyway's "1.4", Rails' "20240115120000") is printed exactly as
 * that tool wrote it: "v20240115120000" is a spelling nobody used.
 */
export function displayVersion(version: string, inScriptGroup: boolean): string {
  const trimmed = version.trim();
  return inScriptGroup && looksLikeVersion(trimmed) ? vLabel(trimmed) : trimmed;
}

/**
 * "users_migration", "a and b", "a, b and c", "a, b, c and 2 more". Long lists
 * are cut at `max` names so a verdict stays one readable sentence; the family
 * table on the screen lists every group.
 */
export function listNames(names: ReadonlyArray<string>, max = 3): string {
  if (names.length === 0) return "";
  if (names.length > max) return `${names.slice(0, max).join(", ")} and ${names.length - max} more`;
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * True when two stored scripts are the same text. Line endings and the
 * whitespace around the script do not count: a script saved on Windows and
 * the same one saved on a Mac ran the same statements.
 */
export function scriptsMatch(a: string, b: string): boolean {
  const clean = (sql: string) => sql.replace(/\r\n?/g, "\n").trim();
  return clean(a) === clean(b);
}

// ── Heads and verdicts ─────────────────────────────────────────────────────

/** What familyHeadsOf needs from a row. */
export type FamilyRowLike = {
  scriptName: string | null | undefined;
  version: string | null | undefined;
  failed?: boolean;
};

/**
 * Each script group's head: its highest version, by compareVersions.
 *
 * - A failed run never counts: that migration did not happen.
 * - A version that does not start with a number never counts (looksLikeVersion).
 * - A row with no script group (a null or blank script_name) belongs to none.
 *
 * On a tie ("1.2" and "1.2.0") the first one seen is kept, as highestVersion
 * keeps it. The version detector reads a whole script_patch with this and the
 * timeline marks its HEAD with the same rule, so the two cannot disagree.
 */
export function familyHeadsOf(rows: ReadonlyArray<FamilyRowLike>): Record<string, string> {
  const versionsByFamily = new Map<string, string[]>();
  for (const row of rows) {
    if (row.failed) continue;
    const family = groupName(row.scriptName);
    if (family === null || !looksLikeVersion(row.version)) continue;
    const list = versionsByFamily.get(family) ?? [];
    list.push(row.version);
    versionsByFamily.set(family, list);
  }

  const pairs: [string, string][] = [];
  for (const [family, versions] of versionsByFamily) {
    const head = highestVersion(versions);
    if (head !== null) pairs.push([family, head]);
  }
  // fromEntries, not heads[family] = ...: a group called "__proto__" would
  // otherwise replace the object's prototype instead of becoming a key.
  return Object.fromEntries(pairs);
}

/** True when a heads map names at least one group. */
export function hasFamilyHeads(
  heads: Record<string, string> | null | undefined
): heads is Record<string, string> {
  return heads != null && Object.keys(heads).length > 0;
}

/**
 * Every group either side has, by name, with each side's head and which side
 * is behind. A side with no version in a group is behind in it: the other side
 * has versions there that it lacks.
 */
export function familyHeadRows(
  leftHeads: Record<string, string>,
  rightHeads: Record<string, string>
): FamilyHeadRow[] {
  const families = [...new Set([...Object.keys(leftHeads), ...Object.keys(rightHeads)])].sort(byName);
  return families.map((family) => {
    const left = headOf(leftHeads, family);
    const right = headOf(rightHeads, family);
    let older: FamilyHeadRow["older"] = null;
    if (left === null) older = "left";
    else if (right === null) older = "right";
    else {
      const order = compareVersions(left, right);
      if (order < 0) older = "left";
      if (order > 0) older = "right";
    }
    return { family, left, right, older };
  });
}

/**
 * Which side is behind, group by group. The lists name the groups where each
 * side is ahead, sorted by name. A group only one side has counts as that
 * side being ahead.
 */
export function compareFamilyHeads(
  leftHeads: Record<string, string>,
  rightHeads: Record<string, string>
): FamilyHeadComparison {
  const rows = familyHeadRows(leftHeads, rightHeads);
  const leftAheadIn = rows.filter((row) => row.older === "right").map((row) => row.family);
  const rightAheadIn = rows.filter((row) => row.older === "left").map((row) => row.family);

  let verdict: FamilyHeadComparison["verdict"] = "same";
  if (leftAheadIn.length > 0 && rightAheadIn.length > 0) verdict = "diverged";
  else if (leftAheadIn.length > 0) verdict = "right-behind";
  else if (rightAheadIn.length > 0) verdict = "left-behind";

  return { verdict, leftAheadIn, rightAheadIn };
}

/**
 * The side whose label gets "(Outdated)": the one a verdict says is behind.
 * None for "same", "unknown" and "diverged" (in a divergence each side is
 * behind somewhere, and the family table marks each group instead).
 */
export function outdatedSideFor(newer: NewerSide | null | undefined): "left" | "right" | null {
  if (newer === "left") return "right";
  if (newer === "right") return "left";
  return null;
}

/**
 * "users_migration (v1.0.0 vs v3.0.0)" for each group where `behind` is the
 * side that is behind: its own head first, then the other side's. A side with
 * no version in the group reads "none", as in the family table on screen.
 * The verdict's reason and Compare's push warning both name groups with this,
 * so the two print the same numbers.
 */
export function familyGaps(rows: ReadonlyArray<FamilyHeadRow>, behind: "left" | "right"): string {
  const shown = (version: string | null) => (version === null ? "none" : displayVersion(version, true));
  return listNames(
    rows
      .filter((row) => row.older === behind)
      .map((row) => {
        const own = behind === "left" ? row.left : row.right;
        const other = behind === "left" ? row.right : row.left;
        return `${row.family} (${shown(own)} vs ${shown(other)})`;
      })
  );
}

/**
 * True when pushing Compare's migration would take the target (the right
 * side) back: its own version table is ahead ("right"), or ahead in some
 * script groups ("diverged"), and the migration has statements to run. With
 * the structures already in sync nothing moves, so there is nothing to warn
 * about. The version bar's warning and the push button's tick both ask this,
 * so one never appears without the other.
 */
export function pushMovesTargetBack(newer: NewerSide | null | undefined, inSync: boolean): boolean {
  return (newer === "right" || newer === "diverged") && !inSync;
}

/**
 * The side that is behind, for two COMPLETE lists (Deploy's registry and
 * database, Version Sync's source and target), judged group by group on each
 * group's head: the rule the version detector uses. A side with no version in
 * a group is behind in it, so a database with nothing applied is behind a
 * registry that holds versions. Null when neither side is simply behind (the
 * same heads, a divergence, or no script groups at all).
 *
 * Every entry needs its scriptName: an entry without one belongs to no group
 * and counts for nothing here. Not for a partial list either: a side read as
 * only its newest few entries can miss a whole group and look behind in it.
 */
export function outdatedSideOfEntries(
  left: ReadonlyArray<TimelineEntry>,
  right: ReadonlyArray<TimelineEntry>
): "left" | "right" | null {
  const { verdict } = compareFamilyHeads(familyHeadsOf(left), familyHeadsOf(right));
  if (verdict === "left-behind") return "left";
  if (verdict === "right-behind") return "right";
  return null;
}

/**
 * A version's title for the timeline, or null when it would only repeat what
 * the row already shows. A run given no title records the version itself as
 * its title (the apply route's fallback), and some rows carry the script
 * group's name, which the group heading already prints. "2.0.0" beside
 * v2.0.0 is the same words twice, so both read as no title.
 */
export function versionTitle(
  title: string | null | undefined,
  version: string,
  scriptName: string | null
): string | null {
  const text = title?.trim() ?? "";
  if (text === "") return null;
  if (scriptName !== null && text === scriptName.trim()) return null;
  // timelineKey reads "v2.0.0" and "2.0.0" as the same version.
  if (timelineKey(text) === timelineKey(version)) return null;
  return text;
}

/**
 * script_patch rows as timeline entries: the rows GET /api/versionsync/ledger
 * sends, which Compare loads for one side and Version Sync holds for both.
 */
export function ledgerTimelineEntries(entries: ReadonlyArray<SyncLedgerEntry>): TimelineEntry[] {
  return entries.map((entry) => ({
    scriptName: entry.scriptName,
    version: entry.version,
    appliedAt: entry.appliedAt,
    // The version detector grades a script_patch row by its change_type with
    // this same function, so a row gets the same dot whichever way it was read.
    changeType: normalizeChangeLevel(entry.changeType),
    sqlContent: entry.sqlContent,
    label: versionTitle(entry.title, entry.version, entry.scriptName),
  }));
}

// ── The merged timeline ────────────────────────────────────────────────────

/** The newest applied time on either side of a row, in ms, or null. */
function latestTime(row: TimelineRow): number | null {
  let latest: number | null = null;
  for (const entry of [row.left, row.right]) {
    if (!entry?.appliedAt) continue;
    const time = new Date(entry.appliedAt).getTime();
    if (!Number.isNaN(time) && (latest === null || time > latest)) latest = time;
  }
  return latest;
}

/**
 * Newest first. Versions by number, highest first ("1.10.0" above "1.9.9").
 * Names that are not versions go below every version, newest applied first.
 */
function newestFirst(a: TimelineRow, b: TimelineRow): number {
  const aIsVersion = looksLikeVersion(a.version);
  const bIsVersion = looksLikeVersion(b.version);
  if (aIsVersion !== bIsVersion) return aIsVersion ? -1 : 1;
  if (aIsVersion) {
    const order = compareVersions(b.version, a.version);
    if (order !== 0) return order;
  }
  const aTime = latestTime(a);
  const bTime = latestTime(b);
  if (aTime !== bTime) {
    if (aTime === null) return 1;
    if (bTime === null) return -1;
    return bTime - aTime;
  }
  return byName(a.version, b.version);
}

/**
 * Mark one side's head in one group: the entry its reader marked as current,
 * or else the highest version that did not fail (familyHeadsOf's rule).
 */
function markHead(rows: TimelineRow[], side: "left" | "right"): void {
  const flag = side === "left" ? "isLeftHead" : "isRightHead";
  const marked = rows.find((row) => row[side]?.isHead && !row[side]?.failed);
  if (marked) {
    marked[flag] = true;
    return;
  }

  const candidates = rows.filter((row) => row[side] !== null && !row[side]?.failed);
  const head = highestVersion(candidates.map((row) => row[side]?.version));
  if (head === null) return;
  const headRow = candidates.find((row) => row.key === timelineKey(head));
  if (headRow) headRow[flag] = true;
}

/**
 * Mark the rows a partial side lacks but may well have: those below the
 * lowest version it shows in the group. "Not on this side" would be a guess
 * there, because the side's list stops before it reaches them. A row it lacks
 * that is not a version cannot be placed against that floor, so it is marked
 * too. Rows are marked, never dropped: the other side's head can be one of
 * them, and a timeline that hid a HEAD would disagree with the headline.
 */
function markUnknown(rows: TimelineRow[], side: "left" | "right"): void {
  if (rows.every((row) => row[side] === null)) return; // the side lacks this whole group
  let floor: string | null = null;
  for (const row of rows) {
    const version = row[side]?.version;
    if (!looksLikeVersion(version)) continue;
    if (floor === null || compareVersions(version, floor) < 0) floor = version;
  }
  const flag = side === "left" ? "leftUnknown" : "rightUnknown";
  for (const row of rows) {
    if (row[side] !== null) continue;
    row[flag] = floor === null || !looksLikeVersion(row.version) || compareVersions(row.version, floor) < 0;
  }
}

/**
 * Both sides' versions as one list: one row per version per script group,
 * groups in order (no group first, then by name), newest first inside each.
 *
 * - "v1.2.0" and "1.2.0" are one row (versionKey). Names that are not plain
 *   release numbers are matched exactly as written.
 * - A side listing the same version twice keeps the first entry, unless that
 *   one failed and a later one did not.
 * - Each side's head is marked per group (see markHead).
 * - With a partial side, a row it may hold beyond its list is marked unknown
 *   for that side (see markUnknown), so a gap on screen is always a real gap.
 */
export function mergeTimelines(
  left: ReadonlyArray<TimelineEntry>,
  right: ReadonlyArray<TimelineEntry>,
  options: MergeOptions = {}
): TimelineRow[] {
  const groups = new Map<string | null, Map<string, TimelineRow>>();

  const place = (entry: TimelineEntry, side: "left" | "right") => {
    const version = entry.version.trim();
    if (version === "") return;
    const family = groupName(entry.scriptName);
    const key = timelineKey(version);

    let rows = groups.get(family);
    if (!rows) {
      rows = new Map();
      groups.set(family, rows);
    }
    let row = rows.get(key);
    if (!row) {
      row = {
        family,
        version,
        key,
        left: null,
        right: null,
        isLeftHead: false,
        isRightHead: false,
        leftUnknown: false,
        rightUnknown: false,
        changeType: "unknown",
      };
      rows.set(key, row);
    }
    const current = row[side];
    if (current === null || (current.failed && !entry.failed)) row[side] = entry;
  };
  for (const entry of left) place(entry, "left");
  for (const entry of right) place(entry, "right");

  const families = [...groups.keys()].sort((a, b) =>
    a === b ? 0 : a === null ? -1 : b === null ? 1 : byName(a, b)
  );

  const merged: TimelineRow[] = [];
  for (const family of families) {
    const rows = [...(groups.get(family)?.values() ?? [])];
    for (const row of rows) {
      const shown = row.left ?? row.right;
      if (shown) row.version = shown.version.trim();
      row.changeType = louderChangeType(row.left?.changeType ?? "unknown", row.right?.changeType ?? "unknown");
    }
    markHead(rows, "left");
    markHead(rows, "right");
    if (options.leftPartial) markUnknown(rows, "left");
    if (options.rightPartial) markUnknown(rows, "right");
    rows.sort(newestFirst);
    merged.push(...rows);
  }
  return merged;
}

/**
 * One side's head as its column heading prints it ("v1.2.0"), or null.
 *
 * Read off the rows' own HEAD marks (markHead), so the heading and the HEAD
 * marker cannot name two different versions. Null when the rows hold more
 * than one script group, because each group then has a head of its own and
 * the markers say which; null too when the side has no head in the rows.
 */
export function headVersionOf(rows: ReadonlyArray<TimelineRow>, side: "left" | "right"): string | null {
  const families = new Set(rows.map((row) => row.family));
  if (families.size !== 1) return null;
  const head = rows.find((row) => (side === "left" ? row.isLeftHead : row.isRightHead));
  const entry = head ? head[side] : null;
  if (!head || !entry) return null;
  return displayVersion(entry.version, head.family !== null);
}
