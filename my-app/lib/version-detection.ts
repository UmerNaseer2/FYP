import type { ClientConfig } from "pg";
import { getPoolForConfig } from "./postgres";
import type { CompareReport } from "./compare-types";

export type ChangeLevel = "breaking" | "additive" | "patch" | "unknown";

/** How a schema numbers itself: dotted semver, or a plain running number. */
export type VersionScheme = "semver" | "numeric";

export type VersionTimelineEntry = {
  version: string | null;
  label: string;
  description: string | null;
  changeLevel: ChangeLevel;
  appliedAt: string | null;
  sourceTable: string;
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
  fallbackMode: boolean;
  message: string;
};

const KNOWN_VERSION_TABLES = [
  "script_patch",
  "schema_version",
  "schema_versions",
  "db_version",
  "version_control",
  "migrations",
  "flyway_schema_history",
  "sequelize_meta",
];

const VERSION_COLUMNS = [
  "version",
  "version_name",
  "script_version",
  "patch_version",
  "tag",
  "migration_name",
  "name",
  "installed_rank",
];

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
 * A version string turned into something orderable, plus HOW it was read.
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

async function detectVersionTable(
  cfg: ClientConfig,
  schemaName: string
): Promise<string | null> {
  const pool = getPoolForConfig(cfg);

  const result = await pool.query<{ table_name: string }>(
    `
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = $1
      AND table_type = 'BASE TABLE'
      AND (
        table_name = ANY($2)
        OR table_name ILIKE '%version%'
        OR table_name ILIKE '%patch%'
        OR table_name ILIKE '%migration%'
        OR table_name ILIKE '%schema_history%'
        OR table_name ILIKE '%release%'
        OR table_name ILIKE '%history%'
      )
    ORDER BY
      CASE
        WHEN table_name = 'script_patch' THEN 0
        WHEN table_name = 'schema_version' THEN 1
        WHEN table_name = 'schema_versions' THEN 2
        WHEN table_name = 'db_version' THEN 3
        WHEN table_name = 'version_control' THEN 4
        WHEN table_name = 'migrations' THEN 5
        WHEN table_name = 'flyway_schema_history' THEN 6
        WHEN table_name = 'sequelize_meta' THEN 7
        ELSE 99
      END,
      table_name
    `,
    [schemaName, KNOWN_VERSION_TABLES]
  );

  return result.rows[0]?.table_name ?? null;
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
  tableName: string
): Promise<VersionTimelineEntry[]> {
  const pool = getPoolForConfig(cfg);
  const columns = await getTableColumns(cfg, schemaName, tableName);

  const versionColumn = findColumn(columns, VERSION_COLUMNS) ?? columns[0];
  const titleColumn = findColumn(columns, TITLE_COLUMNS);
  const descriptionColumn = findColumn(columns, DESCRIPTION_COLUMNS);
  const appliedAtColumn = findColumn(columns, DATE_COLUMNS);
  const changeTypeColumn = findColumn(columns, CHANGE_TYPE_COLUMNS);

  const result = await pool.query<Record<string, unknown>>(
    `SELECT * FROM ${q(schemaName)}.${q(tableName)} LIMIT 200`
  );

  const rows = [...result.rows].sort((a, b) => {
    const aVersion = parseVersion(String(a[versionColumn] ?? ""));
    const bVersion = parseVersion(String(b[versionColumn] ?? ""));

    // Same table, so the two rows almost always number themselves the same
    // way. When they do not, the version is not a usable sort key and the
    // applied-at date below is the better one.
    if (aVersion && bVersion && aVersion.scheme === bVersion.scheme) {
      return bVersion.value - aVersion.value;
    }

    if (appliedAtColumn) {
      const aDate = new Date(String(a[appliedAtColumn] ?? "")).getTime();
      const bDate = new Date(String(b[appliedAtColumn] ?? "")).getTime();

      if (!Number.isNaN(aDate) && !Number.isNaN(bDate)) {
        return bDate - aDate;
      }
    }

    return 0;
  });

  return rows.map((row, index) => {
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
    };
  });
}

export async function fetchSchemaVersionInfo(
  cfg: ClientConfig,
  schemaName: string
): Promise<VersionDetectionResult> {
  try {
    const tableName = await detectVersionTable(cfg, schemaName);

    if (!tableName) {
      return {
        schema: schemaName,
        hasVersionTable: false,
        tableName: null,
        detectedVersion: null,
        comparableValue: null,
        versionScheme: null,
        timeline: [],
        fallbackMode: true,
        message: "no version table in this schema",
      };
    }

    const timeline = await readTimeline(cfg, schemaName, tableName);
    const latest = timeline[0] ?? null;
    const detectedVersion = latest?.version ?? latest?.label ?? null;
    const parsed = parseVersion(detectedVersion);

    return {
      schema: schemaName,
      hasVersionTable: true,
      tableName,
      detectedVersion,
      comparableValue: parsed ? parsed.value : null,
      versionScheme: parsed ? parsed.scheme : null,
      timeline,
      fallbackMode: false,
      message: `Version table found: ${tableName}`,
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
      fallbackMode: true,
      message: `could not read a version table — ${message}`,
    };
  }
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
): {
  newer: "left" | "right" | "same" | "unknown";
  reason: string;
} {
  if (
    left.versionScheme !== null &&
    right.versionScheme !== null &&
    left.versionScheme !== right.versionScheme
  ) {
    return {
      newer: "unknown",
      reason:
        `${left.schema} numbers itself as ${left.detectedVersion} and ` +
        `${right.schema} as ${right.detectedVersion}. Those are not the same ` +
        `kind of version, so neither one is "ahead" of the other.`,
    };
  }

  if (left.comparableValue !== null && right.comparableValue !== null) {
    if (left.comparableValue > right.comparableValue) {
      return {
        newer: "left",
        reason: `${left.schema} is newer based on version ${left.detectedVersion}.`,
      };
    }

    if (right.comparableValue > left.comparableValue) {
      return {
        newer: "right",
        reason: `${right.schema} is newer based on version ${right.detectedVersion}.`,
      };
    }

    return {
      newer: "same",
      reason: "Both schemas have the same detected version.",
    };
  }

  // At least one side has no number to rank. Say WHICH — "version information
  // is missing" leaves the reader checking both schemas to find out whose.
  const blank = [left, right].filter((side) => side.comparableValue === null);
  const reason =
    blank.length > 1
      ? `Neither ${left.schema} nor ${right.schema} records a version of its own, ` +
        "so the structural diff is the whole answer."
      : `${blank[0].schema} records no version of its own, so there is nothing ` +
        "to rank the two against.";

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