import type { ClientConfig } from "pg";
import { getPoolForConfig } from "./postgres";
import type { CompareReport } from "./compare-types";

export type ChangeLevel = "breaking" | "additive" | "patch" | "unknown";

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

function parseVersion(value: string | null): number | null {
  if (!value) return null;

  const semver = value.trim().match(/v?(\d+)\.(\d+)\.(\d+)/i);

  if (semver) {
    return (
      Number(semver[1]) * 1_000_000 +
      Number(semver[2]) * 1_000 +
      Number(semver[3])
    );
  }

  const digits = value.replace(/[^\d]/g, "");
  return digits ? Number(digits) : null;
}

function normalizeChangeLevel(value: unknown): ChangeLevel {
  const text = String(value ?? "").toLowerCase();

  if (
    text.includes("breaking") ||
    text.includes("major") ||
    text.includes("drop") ||
    text.includes("remove") ||
    text.includes("delete")
  ) {
    return "breaking";
  }

  if (
    text.includes("additive") ||
    text.includes("minor") ||
    text.includes("add") ||
    text.includes("create")
  ) {
    return "additive";
  }

  if (
    text.includes("patch") ||
    text.includes("fix") ||
    text.includes("small")
  ) {
    return "patch";
  }

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

  return normalizeChangeLevel(JSON.stringify(row));
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

    if (aVersion !== null && bVersion !== null) {
      return bVersion - aVersion;
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

    const appliedAt =
      appliedAtColumn && row[appliedAtColumn] != null
        ? String(row[appliedAtColumn])
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
        timeline: [],
        fallbackMode: true,
        message:
          "No version table found. System will use structural comparison fallback.",
      };
    }

    const timeline = await readTimeline(cfg, schemaName, tableName);
    const latest = timeline[0] ?? null;
    const detectedVersion = latest?.version ?? latest?.label ?? null;

    return {
      schema: schemaName,
      hasVersionTable: true,
      tableName,
      detectedVersion,
      comparableValue: parseVersion(detectedVersion),
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
      timeline: [],
      fallbackMode: true,
      message: `Version detection failed: ${message}`,
    };
  }
}

export function determineNewerSchema(
  left: VersionDetectionResult,
  right: VersionDetectionResult
): {
  newer: "left" | "right" | "same" | "unknown";
  reason: string;
} {
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

  return {
    newer: "unknown",
    reason:
      "Version information is missing, so the system uses structural comparison fallback.",
  };
}

export function summarizeStructuralSeverity(report: CompareReport): {
  level: ChangeLevel;
  summary: string;
} {
  const hasMissingTables =
    report.tablesOnlyInA.length > 0 || report.tablesOnlyInB.length > 0;

  const hasBreakingColumnChanges = report.matchedTables.some((table) =>
    table.columnMatches.some((column) =>
      column.changes.some(
        (change) =>
          change.startsWith("Type changed") ||
          change.includes("nullable to not null") ||
          change.includes("Primary key participation changed")
      )
    )
  );

  if (hasMissingTables || hasBreakingColumnChanges) {
    return {
      level: "breaking",
      summary: "Structural comparison detected breaking changes.",
    };
  }

  if (
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