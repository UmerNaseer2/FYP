import type { ClientConfig } from "pg";
import { getPoolForConfig } from "./postgres";
import type { CompareReport } from "./compare-types";
// Both live in change-level.ts, which imports nothing. This module opens
// database connections, so anything that reaches for the grading vocabulary
// through here drags `pg` along with it — which is exactly how the deploy
// screen, a client component, ended up asking the browser to resolve `dns`.
import { normalizeChangeLevel, type ChangeLevel } from "./change-level";

// Re-exported so callers that already read them from here keep working.
export { normalizeChangeLevel };
export type { ChangeLevel };

// Script groups: the per-group head rule and the group-by-group verdict. Pure,
// so the browser's timeline and this detector read one rule.
import {
  compareFamilyHeads,
  displayVersion,
  familyGaps,
  familyHeadRows,
  familyHeadsOf,
  hasFamilyHeads,
  listNames,
} from "./version-timeline";

/** How a schema numbers itself: dotted semver, or a plain running number. */
export type VersionScheme = "semver" | "numeric";

export type VersionTimelineEntry = {
  version: string | null;
  label: string;
  description: string | null;
  changeLevel: ChangeLevel;
  appliedAt: string | null;
  sourceTable: string;
  /**
   * False for a run the table records as failed (Flyway's success = false),
   * true when it records success, null or missing when it does not say. A
   * failed run never counts as the current version.
   */
  succeeded?: boolean | null;
  /** The script group (script_patch.script_name), or null when the table has no such column. */
  scriptName?: string | null;
};

export type VersionDetectionResult = {
  schema: string;
  hasVersionTable: boolean;
  tableName: string | null;
  detectedVersion: string | null;
  comparableValue: number | null;
  /**
   * Which way comparableValue counts. Two schemas are only comparable when
   * they count the same way — see ParsedVersion.
   */
  versionScheme: VersionScheme | null;
  timeline: VersionTimelineEntry[];
  /**
   * Each script group's highest version, read from the whole table rather than
   * from `timeline`, which stops at TIMELINE_ROW_LIMIT rows. Null when the
   * table has no script_name column or no row names a group. Versions only
   * compare inside one group, so when both sides have these,
   * determineNewerSchema judges group by group.
   */
  familyHeads: Record<string, string> | null;
  /**
   * True when the table holds more rows than `timeline` carries, because the
   * read stopped at TIMELINE_ROW_LIMIT. Kept as a flag and not only as words
   * in `message`, so a screen can say "all of it" or "as much as we read"
   * without having to read the sentence back.
   */
  truncated: boolean;
  fallbackMode: boolean;
  message: string;
};

// Tables that are version tables by name. The order is the priority when a
// schema has more than one, and the detection query sorts by it.
const KNOWN_VERSION_TABLES = [
  "script_patch",
  "schema_version",
  "schema_versions",
  "db_version",
  "version_control",
  "migrations",
  "flyway_schema_history",
  // Liquibase. Its name has neither "version" nor "migration" in it, so the
  // name-pattern route never found it: a Liquibase-managed schema was read as
  // having no version table at all, while the docs said it was supported.
  "databasechangelog",
  "sequelize_meta",
  // Rails and several Node migration tools keep their history here.
  "schema_migrations",
];

// The columns a version can be read from, best first.
const VERSION_COLUMNS = [
  "version",
  "version_name",
  "script_version",
  "patch_version",
  "tag",
  "migration_name",
  // Laravel's `migrations` table keeps its "2024_01_15_000000_…" names here.
  // It has no other version column, and with the old read-the-first-column
  // fallback gone it would otherwise stop being found.
  "migration",
  "name",
  "installed_rank",
];

/**
 * The columns a table found only by its NAME PATTERN must have to count as a
 * version table. Narrower than VERSION_COLUMNS on purpose: "name" and "tag" sit
 * on half the tables in any schema, and with them a "data_migration_log" that
 * has a name column would be read as the schema's version.
 */
const STRICT_VERSION_COLUMNS = [
  "version",
  "version_name",
  "script_version",
  "patch_version",
  "migration_name",
];

/** At most this many rows are read from a version table, newest first. */
const TIMELINE_ROW_LIMIT = 5000;

const TITLE_COLUMNS = [
  "title",
  "label",
  "name",
  "migration_name",
  "script_name",
];

const DESCRIPTION_COLUMNS = [
  "description",
  "notes",
  "comment",
  "change_note",
  "summary",
];

const DATE_COLUMNS = [
  "applied_at",
  "executed_at",
  "installed_on",
  // Liquibase's, which is also what orders its rows when no tag is set.
  "dateexecuted",
  "created_at",
  "updated_at",
];

const CHANGE_TYPE_COLUMNS = [
  "change_type",
  "change_level",
  "type",
  "level",
  "category",
];

function q(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

function findColumn(columns: string[], candidates: string[]): string | null {
  for (const candidate of candidates) {
    const found = columns.find(
      (column) => column.toLowerCase() === candidate.toLowerCase()
    );
    if (found) return found;
  }
  return null;
}

/**
 * Whether a candidate table really is a version table, judged by its columns.
 *
 * A table known by name (flyway_schema_history, script_patch, …) only needs a
 * column a version can be read from. A table picked up by its name pattern
 * (anything with "version" or "migration" in it) needs one of the strict
 * version columns — otherwise an app's own log table would be read as the
 * schema's version and put a verdict on the Compare screen.
 */
export function acceptVersionTable(tableName: string, columnNames: string[]): boolean {
  const known = KNOWN_VERSION_TABLES.includes(tableName.toLowerCase());
  return findColumn(columnNames, known ? VERSION_COLUMNS : STRICT_VERSION_COLUMNS) !== null;
}

/**
 * A version string turned into ONE number for display, plus HOW it was read.
 *
 * Never order by that number. It packs major × 1,000,000 + minor × 1,000 +
 * patch, so 1.1000.0 and 2.0.0 come out equal; ordering compares the parts
 * one by one instead (readVersionParts below).
 *
 * The scheme matters as much as the number. "2.3.1" and Flyway's
 * "20240115120000" are both perfectly good version strings, and both become
 * numbers here, but the numbers do not live on the same scale — comparing them
 * would announce that a schema stamped with a date is eight orders of magnitude
 * ahead of one on semver. Two schemas are only comparable when they count the
 * same way, so the caller gets told which way this one counted.
 */
type ParsedVersion = { scheme: VersionScheme; value: number };

/**
 * Dotted versions, one to three parts, with the missing parts read as zero.
 *
 * Three parts is the common case but not the only one: plenty of hand-rolled
 * tables store "2.3", and the earlier three-part-only pattern fell through to
 * the digits fallback for those, which turned "2.3" into 23 and "1.20" into
 * 120 — and so ranked 1.20 above 2.3.
 */
const DOTTED_VERSION = /^v?(\d+)\.(\d+)(?:\.(\d+))?/i;

function parseVersion(value: string | null): ParsedVersion | null {
  if (!value) return null;

  const dotted = value.trim().match(DOTTED_VERSION);

  if (dotted) {
    return {
      scheme: "semver",
      value:
        Number(dotted[1]) * 1_000_000 +
        Number(dotted[2]) * 1_000 +
        Number(dotted[3] ?? 0),
    };
  }

  // Whatever is left: a Flyway installed_rank, a timestamp-shaped migration
  // name, a bare "7". Monotonic within one table, meaningless against another
  // table that numbers itself differently — hence the scheme tag.
  const digits = value.replace(/[^\d]/g, "");
  return digits ? { scheme: "numeric", value: Number(digits) } : null;
}

/**
 * A version read as a list of numbers, for ordering: "2.10.1" is semver
 * [2, 10, 1], and "20240115120000" or "7" is one number. The scheme is decided
 * exactly the way parseVersion decides it, so the two never disagree.
 */
type VersionParts = { scheme: VersionScheme; parts: number[] };

function readVersionParts(value: string | null | undefined): VersionParts | null {
  const text = (value ?? "").trim();
  if (!text) return null;
  const dotted = text.match(/^v?(\d+(?:\.\d+)+)/i);
  if (dotted) return { scheme: "semver", parts: dotted[1].split(".").map(Number) };
  const digits = text.replace(/[^\d]/g, "");
  return digits ? { scheme: "numeric", parts: [Number(digits)] } : null;
}

/** Compare two part lists left to right; a missing part counts as 0. */
function compareParts(a: number[], b: number[]): number {
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** What pickCurrentVersion needs from a row. */
export type VersionRowLike = { version: string | null; succeeded?: boolean | null };

/**
 * The row that holds the schema's current version, or null when none qualifies.
 *
 * - A row whose run failed (Flyway's success = false) never counts: that
 *   migration did not happen, however high its number.
 * - A row with no version, or one with no number in it, never counts.
 * - When a table mixes schemes (a few "20240115" ranks among "1.4.0"
 *   releases), the scheme most rows use wins, and a tie goes to semver.
 * - Of the rest, the highest version wins, compared part by part: 1.10.0 is
 *   above 1.9.0, and 1.1000.0 is below 2.0.0.
 *
 * It used to be simply the first row of the timeline, which on a table with
 * failed runs or odd dates was often not the current version at all.
 */
export function pickCurrentVersion<Row extends VersionRowLike>(rows: Row[]): Row | null {
  const candidates: { row: Row; parsed: VersionParts }[] = [];
  for (const row of rows) {
    if (row.succeeded === false) continue;
    const parsed = readVersionParts(row.version);
    if (parsed) candidates.push({ row, parsed });
  }
  if (candidates.length === 0) return null;

  const semverCount = candidates.filter((c) => c.parsed.scheme === "semver").length;
  const scheme: VersionScheme = semverCount * 2 >= candidates.length ? "semver" : "numeric";

  // Rows that tie keep the first one given, which is the newer by date.
  let best: { row: Row; parsed: VersionParts } | null = null;
  for (const candidate of candidates) {
    if (candidate.parsed.scheme !== scheme) continue;
    if (best === null || compareParts(candidate.parsed.parts, best.parsed.parts) > 0) {
      best = candidate;
    }
  }
  return best ? best.row : null;
}

/** A date as milliseconds, or null when there is none or it does not parse. */
function timeOf(value: string | null): number | null {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? null : time;
}

/** Sort position of a version's scheme: semver, then plain numbers, then none. */
function schemeRank(parsed: VersionParts | null): number {
  if (!parsed) return 2;
  return parsed.scheme === "semver" ? 0 : 1;
}

/**
 * Timeline order, newest first: by date (rows with no date last), then by
 * version, highest first. Every pair is compared on the same keys in the same
 * order, so the result is consistent. The comparator this replaced picked a
 * different key for each pair, which can put A before B, B before C and C
 * before A — and then "the first row" depends on the order rows arrived in.
 */
function newestFirst(a: VersionTimelineEntry, b: VersionTimelineEntry): number {
  const aTime = timeOf(a.appliedAt);
  const bTime = timeOf(b.appliedAt);
  if (aTime !== bTime) {
    if (aTime === null) return 1;
    if (bTime === null) return -1;
    return bTime - aTime;
  }
  const aParts = readVersionParts(a.version);
  const bParts = readVersionParts(b.version);
  const rankDiff = schemeRank(aParts) - schemeRank(bParts);
  if (rankDiff !== 0) return rankDiff;
  return aParts && bParts ? compareParts(bParts.parts, aParts.parts) : 0;
}

/** Read a success column, which node-postgres returns as a boolean. */
function readSuccess(value: unknown): boolean | null {
  if (value === true || value === false) return value;
  if (value == null) return null;
  const text = String(value).trim().toLowerCase();
  if (text === "false" || text === "f" || text === "0") return false;
  if (text === "true" || text === "t" || text === "1") return true;
  return null;
}


function inferChangeLevel(
  row: Record<string, unknown>,
  changeTypeColumn: string | null
): ChangeLevel {
  if (changeTypeColumn && row[changeTypeColumn] != null) {
    const direct = normalizeChangeLevel(row[changeTypeColumn]);
    if (direct !== "unknown") return direct;
  }

  // No column says what kind of change this was, so fall back to reading the
  // row. Values only — the column NAMES are the same on every row and would
  // grade the whole table the same way.
  return normalizeChangeLevel(Object.values(row).join(" "));
}

/**
 * Find the schema's version table: the first candidate, in priority order,
 * whose columns pass acceptVersionTable. Returns its name and columns.
 *
 * Known names come first, in the order of KNOWN_VERSION_TABLES; tables found by
 * name pattern follow, alphabetically. This used to take the first candidate
 * whatever its columns, so the wrong table could win and no later one was ever
 * looked at. Each candidate costs one small catalog query, and a schema rarely
 * has more than two or three.
 */
async function detectVersionTable(
  cfg: ClientConfig,
  schemaName: string
): Promise<{ tableName: string; columns: string[] } | null> {
  const pool = getPoolForConfig(cfg);

  // Only names that say "version" or "migration", or Flyway's schema_history.
  // "%patch%", "%release%" and "%history%" used to be here as well, and picked
  // up tables such as order_history as the schema's version table.
  const result = await pool.query<{ table_name: string }>(
    `
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = $1
      AND table_type = 'BASE TABLE'
      AND (
        table_name::text = ANY($2::text[])
        OR table_name ILIKE '%version%'
        OR table_name ILIKE '%migration%'
        OR table_name ILIKE '%schema_history%'
      )
    ORDER BY COALESCE(array_position($2::text[], table_name::text), 99), table_name
    `,
    [schemaName, KNOWN_VERSION_TABLES]
  );

  for (const row of result.rows) {
    const columns = await getTableColumns(cfg, schemaName, row.table_name);
    if (acceptVersionTable(row.table_name, columns)) {
      return { tableName: row.table_name, columns };
    }
  }
  return null;
}

async function getTableColumns(
  cfg: ClientConfig,
  schemaName: string,
  tableName: string
): Promise<string[]> {
  const pool = getPoolForConfig(cfg);

  const result = await pool.query<{ column_name: string }>(
    `
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = $1
      AND table_name = $2
    ORDER BY ordinal_position
    `,
    [schemaName, tableName]
  );

  return result.rows.map((row) => row.column_name);
}

async function readTimeline(
  cfg: ClientConfig,
  schemaName: string,
  tableName: string,
  columns: string[]
): Promise<{ timeline: VersionTimelineEntry[]; truncated: boolean }> {
  const pool = getPoolForConfig(cfg);

  // detectVersionTable only accepts a table that has a version column, so this
  // is always found. There is no "first column" fallback any more: a table
  // with no version column is not a version table, and reading its id column
  // as a version made a confident verdict out of nothing.
  const versionColumn = findColumn(columns, VERSION_COLUMNS);
  if (!versionColumn) return { timeline: [], truncated: false };
  const titleColumn = findColumn(columns, TITLE_COLUMNS);
  const descriptionColumn = findColumn(columns, DESCRIPTION_COLUMNS);
  const appliedAtColumn = findColumn(columns, DATE_COLUMNS);
  const changeTypeColumn = findColumn(columns, CHANGE_TYPE_COLUMNS);
  // Flyway records success = false for a run that failed, and numbers its
  // runs in installed_rank. script_patch names each row's script family.
  const successColumn = findColumn(columns, ["success"]);
  // orderexecuted is Liquibase's counterpart: the order its changesets ran in.
  const rankColumn = findColumn(columns, ["installed_rank", "orderexecuted"]);
  const scriptNameColumn = findColumn(columns, ["script_name"]);

  // Only the columns this screen reads, each once. SELECT * dragged checksums
  // and whole script bodies along with every row.
  const selected: string[] = [];
  for (const column of [
    versionColumn,
    titleColumn,
    descriptionColumn,
    appliedAtColumn,
    changeTypeColumn,
    successColumn,
    rankColumn,
    scriptNameColumn,
  ]) {
    if (column && !selected.includes(column)) selected.push(column);
  }

  // Newest first, so the LIMIT keeps the newest rows. The old query had a
  // LIMIT and no ORDER BY, so on a long history it kept whichever rows came
  // back first — and the current version could be missing from them.
  const orderBy: string[] = [];
  if (appliedAtColumn) orderBy.push(`${q(appliedAtColumn)} DESC NULLS LAST`);
  if (rankColumn && rankColumn !== versionColumn) orderBy.push(`${q(rankColumn)} DESC NULLS LAST`);
  orderBy.push(`${q(versionColumn)} DESC NULLS LAST`);

  const result = await pool.query<Record<string, unknown>>(
    `SELECT ${selected.map((column) => q(column)).join(", ")} FROM ${q(schemaName)}.${q(tableName)} ` +
      `ORDER BY ${orderBy.join(", ")} LIMIT ${TIMELINE_ROW_LIMIT}`
  );

  const timeline: VersionTimelineEntry[] = result.rows.map((row, index) => {
    const version =
      row[versionColumn] !== undefined && row[versionColumn] !== null
        ? String(row[versionColumn])
        : null;

    const label =
      titleColumn && row[titleColumn] != null
        ? String(row[titleColumn])
        : version ?? `Entry ${index + 1}`;

    const description =
      descriptionColumn && row[descriptionColumn] != null
        ? String(row[descriptionColumn])
        : null;

    // node-postgres hands a timestamp column back as a Date, and String(Date)
    // is a 40-character locale string with a timezone NAME in it — unreadable
    // in a list and not parseable by the browser. ISO survives the trip and
    // formats on the other side.
    const rawAppliedAt = appliedAtColumn ? row[appliedAtColumn] : null;
    const appliedAt =
      rawAppliedAt instanceof Date
        ? rawAppliedAt.toISOString()
        : rawAppliedAt != null
          ? String(rawAppliedAt)
          : null;

    return {
      version,
      label,
      description,
      appliedAt,
      sourceTable: tableName,
      changeLevel: inferChangeLevel(row, changeTypeColumn),
      succeeded: successColumn ? readSuccess(row[successColumn]) : null,
      scriptName:
        scriptNameColumn && row[scriptNameColumn] != null ? String(row[scriptNameColumn]) : null,
    };
  });

  // The query sorted the raw column values, and a hand-made table may keep its
  // dates as text. Sort once more on the parsed values so the timeline reads
  // newest first whatever the column types are.
  timeline.sort(newestFirst);
  return { timeline, truncated: result.rows.length >= TIMELINE_ROW_LIMIT };
}

/**
 * Each script group's highest version, read from the whole table.
 *
 * A second, small query rather than a reading of the timeline: the timeline
 * stops at TIMELINE_ROW_LIMIT rows, and a group whose newest version is older
 * than that would lose its head. DISTINCT keeps one row per version however
 * often the table repeats it. Only a table with a script_name column has
 * groups; for any other table nothing is read and the answer is null.
 */
async function readFamilyHeads(
  cfg: ClientConfig,
  schemaName: string,
  tableName: string,
  columns: string[]
): Promise<Record<string, string> | null> {
  const scriptNameColumn = findColumn(columns, ["script_name"]);
  const versionColumn = findColumn(columns, VERSION_COLUMNS);
  if (!scriptNameColumn || !versionColumn) return null;
  // A failed run is not a head (familyHeadsOf skips it), so read Flyway-style
  // success along with the version when the table has it.
  const successColumn = findColumn(columns, ["success"]);
  const selected = successColumn
    ? [scriptNameColumn, versionColumn, successColumn]
    : [scriptNameColumn, versionColumn];

  const pool = getPoolForConfig(cfg);
  const result = await pool.query<Record<string, unknown>>(
    `SELECT DISTINCT ${selected.map((column) => q(column)).join(", ")} ` +
      `FROM ${q(schemaName)}.${q(tableName)}`
  );

  const heads = familyHeadsOf(
    result.rows.map((row) => ({
      scriptName: row[scriptNameColumn] != null ? String(row[scriptNameColumn]) : null,
      version: row[versionColumn] != null ? String(row[versionColumn]) : null,
      failed: successColumn ? readSuccess(row[successColumn]) === false : false,
    }))
  );
  return hasFamilyHeads(heads) ? heads : null;
}

export async function fetchSchemaVersionInfo(
  cfg: ClientConfig,
  schemaName: string
): Promise<VersionDetectionResult> {
  try {
    const found = await detectVersionTable(cfg, schemaName);

    if (!found) {
      return {
        schema: schemaName,
        hasVersionTable: false,
        tableName: null,
        detectedVersion: null,
        comparableValue: null,
        versionScheme: null,
        timeline: [],
        familyHeads: null,
        truncated: false,
        fallbackMode: true,
        message: "no version table in this schema",
      };
    }

    const { tableName, columns } = found;
    const { timeline, truncated } = await readTimeline(cfg, schemaName, tableName, columns);
    const familyHeads = await readFamilyHeads(cfg, schemaName, tableName, columns);
    // The current version is the highest one that ran, not simply the first row.
    const current = pickCurrentVersion(timeline);
    // When no row reads as a version number, still show the newest row — but
    // with no number, because there is nothing to rank it by.
    const shown = current ?? timeline[0] ?? null;
    const detectedVersion = shown?.version ?? shown?.label ?? null;
    const parsed = current ? parseVersion(current.version) : null;

    return {
      schema: schemaName,
      hasVersionTable: true,
      tableName,
      detectedVersion,
      comparableValue: parsed ? parsed.value : null,
      versionScheme: parsed ? parsed.scheme : null,
      timeline,
      familyHeads,
      truncated,
      fallbackMode: false,
      message: truncated
        ? `Version table found: ${tableName} — only the newest ` +
          `${TIMELINE_ROW_LIMIT.toLocaleString("en-US")} rows were read`
        : `Version table found: ${tableName}`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    return {
      schema: schemaName,
      hasVersionTable: false,
      tableName: null,
      detectedVersion: null,
      comparableValue: null,
      versionScheme: null,
      timeline: [],
      familyHeads: null,
      truncated: false,
      fallbackMode: true,
      message: `could not read a version table — ${message}`,
    };
  }
}

/**
 * Which side a version verdict points at. "diverged" is for script groups
 * that disagree: each side is ahead in at least one group (compareFamilyHeads),
 * so neither side is simply newer and neither is simply outdated.
 */
export type NewerSide = "left" | "right" | "same" | "diverged" | "unknown";

/** The verdict, and the sentence the screen prints under it. */
export type NewerSchemaVerdict = { newer: NewerSide; reason: string };

/** The parts to rank a side by, or null when it has no version number. */
function rankableParts(side: VersionDetectionResult): number[] | null {
  if (side.comparableValue === null) return null;
  return readVersionParts(side.detectedVersion)?.parts ?? null;
}

/**
 * A side's version as a verdict prints it: "v1.2.0" when the side keeps script
 * groups (this app wrote the version), exactly as written otherwise. The
 * version bar's headline and the timeline print versions by the same rule
 * (displayVersion), so all three show one spelling.
 */
function shownVersion(side: VersionDetectionResult): string {
  return displayVersion(side.detectedVersion ?? "", hasFamilyHeads(side.familyHeads));
}

/**
 * Which of two schemas declares the higher version, and why.
 *
 * "unknown" is a real answer here and the most common one. A schema with no
 * version table has nothing to say, and two schemas that number themselves
 * differently — one on semver, one on Flyway ranks — have nothing to say to
 * EACH OTHER: their numbers are both valid and on different scales, so the
 * only honest reading is that the structural diff is the answer.
 */
export function determineNewerSchema(
  left: VersionDetectionResult,
  right: VersionDetectionResult
): NewerSchemaVerdict {
  // Two databases each with a schema called "public" is the ordinary case, not
  // an odd one, and every sentence below names a side. "public is newer than
  // public" tells the reader nothing, and "public records no version of its
  // own" does not say WHICH public. Where the names collide, fall back to the
  // roles the screen itself prints above each row.
  const collides = left.schema === right.schema;
  const leftName = collides ? "the source schema" : left.schema;
  const rightName = collides ? "the target schema" : right.schema;
  // The same two names at the start of a sentence. Only the role phrases take a
  // capital: a schema's own name is printed exactly as it is spelled.
  const leftStart = collides ? "The source schema" : left.schema;
  const rightStart = collides ? "The target schema" : right.schema;

  // Script groups first. A table that names its scripts (script_patch) keeps
  // several version lines at once, and "the highest version in the table"
  // mixes them: users_migration v3.0.0 would outrank orders_migration v1.0.0,
  // though the two say nothing about each other. With groups on both sides,
  // each group is judged on its own.
  if (hasFamilyHeads(left.familyHeads) && hasFamilyHeads(right.familyHeads)) {
    const rows = familyHeadRows(left.familyHeads, right.familyHeads);
    const { verdict, leftAheadIn, rightAheadIn } = compareFamilyHeads(
      left.familyHeads,
      right.familyHeads
    );
    if (verdict === "right-behind") {
      return { newer: "left", reason: `${rightStart} is behind in ${familyGaps(rows, "right")}.` };
    }
    if (verdict === "left-behind") {
      return { newer: "right", reason: `${leftStart} is behind in ${familyGaps(rows, "left")}.` };
    }
    if (verdict === "diverged") {
      return {
        newer: "diverged",
        reason:
          `Diverged: ${leftName} is ahead in ${listNames(leftAheadIn)}, ` +
          `${rightName} in ${listNames(rightAheadIn)}, so neither schema is simply newer.`,
      };
    }
    return { newer: "same", reason: "Both schemas are at the same version in every script group." };
  }

  if (
    left.versionScheme !== null &&
    right.versionScheme !== null &&
    left.versionScheme !== right.versionScheme
  ) {
    return {
      newer: "unknown",
      reason:
        `${leftStart} numbers itself as ${shownVersion(left)} and ` +
        `${rightName} as ${shownVersion(right)}. Those are not the same ` +
        `kind of version, so neither one is "ahead" of the other.`,
    };
  }

  // Part by part, never by comparableValue: that packs a version into one
  // number for display, and 1.1000.0 packs to the same number as 2.0.0.
  const leftParts = rankableParts(left);
  const rightParts = rankableParts(right);
  if (leftParts && rightParts) {
    const order = compareParts(leftParts, rightParts);
    if (order > 0) {
      return {
        newer: "left",
        reason: `${leftStart} is newer based on version ${shownVersion(left)}.`,
      };
    }

    if (order < 0) {
      return {
        newer: "right",
        reason: `${rightStart} is newer based on version ${shownVersion(right)}.`,
      };
    }

    return {
      newer: "same",
      reason: "Both schemas have the same detected version.",
    };
  }

  // At least one side has no number to rank. Say WHICH — "version information
  // is missing" leaves the reader checking both schemas to find out whose.
  const blank = [left, right].filter((side) => rankableParts(side) === null);
  const reason =
    blank.length > 1
      ? (collides
          ? "Neither schema records a version of its own, "
          : `Neither ${leftName} nor ${rightName} records a version of its own, `) +
        "so the structural diff is the whole answer."
      : `${blank[0] === left ? leftStart : rightStart} records no version of its ` +
        "own, so there is nothing to rank the two against.";

  return { newer: "unknown", reason };
}

export function summarizeStructuralSeverity(report: CompareReport): {
  level: ChangeLevel;
  summary: string;
} {
  // Only the TARGET-only side is breaking: those are the tables a sync drops.
  // A source-only table is created, which takes nothing away — counting it as
  // breaking pushed a plain "we added a table" migration to a major bump.
  const dropsTables = report.tablesOnlyInB.length > 0;

  // Severity now travels with the change itself (lib/compare.ts decides it, and
  // the migration generator grades its statements with the same rule). This used
  // to match on the prose instead, and matched the wrong half of it: the
  // substring "nullable to not null" only appears in the DROP NOT NULL case,
  // which is the safe one, so the check fired on safe changes and missed the
  // SET NOT NULL that can actually fail.
  const hasBreakingColumnChanges = report.matchedTables.some((table) =>
    table.columnMatches.some((column) =>
      column.changes.some((change) => change.severity === "breaking")
    )
  );

  // Dropping a view, a routine or a type breaks whatever was calling it, and
  // none of that shows up in the table/column counts above.
  const dropsObjects = [
    ...report.objectDiffs,
    ...report.matchedTables.flatMap((table) => table.objectDiffs),
  ].some((diff) => diff.status === "onlyB");

  if (dropsTables || hasBreakingColumnChanges || dropsObjects) {
    return {
      level: "breaking",
      summary: "Structural comparison detected breaking changes.",
    };
  }

  if (
    report.tablesOnlyInA.length > 0 ||
    report.summary.changedTables > 0 ||
    report.summary.changedConstraints > 0
  ) {
    return {
      level: "additive",
      summary: "Structural comparison detected additive or minor changes.",
    };
  }

  return {
    level: "patch",
    summary: "No major structural changes detected.",
  };
}