import Sidebar from "../../components/Sidebar";
import Topbar from "../../components/Topbar";
import CopyButton from "../../components/CopyButton";
import SaveScriptButton, {
  type ChangeKind,
} from "../../components/SaveScriptButton";
import {
  generateMigration,
  renderMigrationScript,
} from "../../lib/generate-sql";
import pool from "../../lib/version-db";
import type {
  CompareTarget,
  ConstraintKind,
  TableSnapshot,
} from "../../lib/postgres";
import {
  fetchSchemaNames,
  fetchSchemaSnapshot,
  resolveCompareTargets,
} from "../../lib/postgres";
import {
  compareSchemas,
  describeTableMatch,
  describeConstraint,
  summarizeColumns,
  TABLE_DIMENSION_MAX,
  type CompareReport,
  type ConstraintDiff,
  type ScoreBreakdown,
  type TableMatch,
} from "../../lib/compare";

export const dynamic = "force-dynamic";

type PageProps = {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
};

type SavedConnection = {
  id: number;
  name: string;
  host: string;
  port: number;
  database_name: string;
  type: string;
  username: string;
  password: string | null;
  connection_string: string | null;
};

async function getSavedConnections(): Promise<SavedConnection[]> {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS connections (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        host TEXT NOT NULL,
        port INTEGER NOT NULL DEFAULT 5432,
        database_name TEXT NOT NULL DEFAULT 'postgres',
        type TEXT NOT NULL DEFAULT 'PostgreSQL',
        username TEXT NOT NULL,
        password TEXT NOT NULL,
        connection_string TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    const result = await pool.query(`
      SELECT id, name, host, port, database_name, type, username, password, connection_string
      FROM connections
      WHERE type = 'PostgreSQL'
      ORDER BY name ASC
    `);

    return result.rows;
  } catch (error) {
    console.error("Failed to load saved connections:", error);
    return [];
  }
}

function buildTargetFromConnection(
  connection: SavedConnection,
  side: "a" | "b",
): CompareTarget {
  const config = connection.connection_string
    ? { connectionString: connection.connection_string }
    : {
        host: connection.host,
        port: Number(connection.port) || 5432,
        database: connection.database_name,
        user: connection.username,
        password: String(connection.password ?? ""),
      };

  return {
    id: side,
    config,
    displayName: `${connection.name} (${connection.database_name})`,
  };
}

function envValue(name: string, fallback: string): string {
  const value = process.env[name]?.trim();
  return value && value.length > 0 ? value : fallback;
}

function pickValue(
  value: string | string[] | undefined,
  fallback: string,
): string {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  if (Array.isArray(value) && value[0]?.trim()) {
    return value[0].trim();
  }
  return fallback;
}

function getTargetById(targets: CompareTarget[], id: string): CompareTarget {
  return targets.find((target) => target.id === id) ?? targets[0];
}

function groupConstraintDiffs(
  diffs: ConstraintDiff[],
): Record<ConstraintKind | "FOREIGN KEY", ConstraintDiff[]> {
  return {
    "PRIMARY KEY": diffs.filter((diff) => diff.kind === "PRIMARY KEY"),
    UNIQUE: diffs.filter((diff) => diff.kind === "UNIQUE"),
    "FOREIGN KEY": diffs.filter((diff) => diff.kind === "FOREIGN KEY"),
    CHECK: diffs.filter((diff) => diff.kind === "CHECK"),
    EXCLUDE: diffs.filter((diff) => diff.kind === "EXCLUDE"),
  };
}

// ---------------------------------------------------------------------------
// Plain-English helpers
// ---------------------------------------------------------------------------

function matchConfidenceLabel(score: number): string {
  if (score >= 90) return "Very high confidence";
  if (score >= 75) return "High confidence";
  if (score >= 60) return "Good match";
  return "Partial match";
}

function renderScoreBar(score: number) {
  const label = matchConfidenceLabel(score);
  const fillClass =
    score >= 75
      ? "compare-score-bar-fill--high"
      : score >= 60
        ? "compare-score-bar-fill--medium"
        : "compare-score-bar-fill--low";

  return (
    <div className="compare-score-display">
      <div className="compare-score-display__header">
        <span className="compare-score-display__label">
          Match confidence — {label}
        </span>
        <span className="compare-score-display__value">{score}%</span>
      </div>
      <div className="compare-score-bar-track">
        <div
          className={`compare-score-bar-fill ${fillClass}`}
          style={{ width: `${score}%` }}
        />
      </div>
    </div>
  );
}

function renderBreakdown(breakdown: ScoreBreakdown) {
  const dims: Array<{
    label: string;
    value: number;
    max: number;
    hint: string;
  }> = [
    {
      label: "Name",
      value: breakdown.name,
      max: TABLE_DIMENSION_MAX.name,
      hint: "How similar the table names are",
    },
    {
      label: "Columns",
      value: breakdown.columns ?? 0,
      max: TABLE_DIMENSION_MAX.columns,
      hint: "How well the column structures match",
    },
    {
      label: "Constraints",
      value: breakdown.constraints,
      max: TABLE_DIMENSION_MAX.constraints,
      hint: "Keys, foreign keys, and rules overlap",
    },
  ];

  if (breakdown.relationships !== undefined) {
    dims.push({
      label: "Relationships",
      value: breakdown.relationships,
      max: TABLE_DIMENSION_MAX.relationships,
      hint: "How similarly this table connects to others via foreign keys",
    });
  }

  return (
    <div className="compare-breakdown">
      {dims.map((dim) => {
        const pct = Math.round((dim.value / dim.max) * 100);
        return (
          <span
            key={dim.label}
            className="compare-breakdown__item"
            title={dim.hint}
          >
            <span className="compare-breakdown__label">{dim.label}</span>
            <span className="compare-breakdown__score">{pct}%</span>
          </span>
        );
      })}
    </div>
  );
}

function classifyChange(change: string): "breaking" | "safe" | "info" {
  if (change.startsWith("Type changed")) return "breaking";
  if (change.includes("nullable to not null")) return "breaking";
  if (change.includes("not null to nullable")) return "safe";
  if (change.startsWith("Size/precision changed")) return "safe";
  if (change.startsWith("Order changed")) return "info";
  if (change.includes("Primary key participation changed")) return "breaking";
  return "info";
}

function constraintSectionTitle(kind: string): {
  title: string;
  description: string;
} {
  switch (kind) {
    case "Primary Key":
      return {
        title: "Primary Key",
        description:
          "The unique row identifier. Changing this affects how every other table that links here finds records.",
      };
    case "Unique Constraints":
      return {
        title: "Unique Constraints",
        description:
          "Rules that prevent duplicate values in a column or group of columns.",
      };
    case "Foreign Keys":
      return {
        title: "Foreign Keys",
        description:
          "Links to rows in other tables. Differences here mean the two schemas describe different relationships between data.",
      };
    case "Check Constraints":
      return {
        title: "Check Constraints",
        description:
          "Custom rules that every value in a column must satisfy (e.g. price > 0, status IN ('active','inactive')).",
      };
    case "Exclude Constraints":
      return {
        title: "Exclude Constraints",
        description:
          "Advanced rules that prevent two rows from having conflicting values at the same time (common in scheduling schemas).",
      };
    default:
      return { title: kind, description: "" };
  }
}

function healthBanner(report: CompareReport) {
  const hasMissingTables =
    report.summary.tablesOnlyInA > 0 || report.summary.tablesOnlyInB > 0;
  const hasChanges =
    report.summary.changedTables > 0 || report.summary.changedConstraints > 0;

  if (hasMissingTables) {
    const count = report.summary.tablesOnlyInA + report.summary.tablesOnlyInB;
    return (
      <div className="compare-health-banner compare-health-banner--error">
        ⚠ Schemas are out of sync — {count} table
        {count === 1 ? " exists" : "s exist"} in only one schema and need to be
        created in the other.
      </div>
    );
  }
  if (hasChanges) {
    return (
      <div className="compare-health-banner compare-health-banner--warning">
        ⚡ Differences detected — {report.summary.changedTables} table
        {report.summary.changedTables === 1 ? "" : "s"} have structural changes
        that need to be reviewed before deploying.
      </div>
    );
  }
  return (
    <div className="compare-health-banner compare-health-banner--success">
      ✓ Schemas are in sync — no structural differences found.
    </div>
  );
}

function renderTableList(
  title: string,
  description: string,
  tables: TableSnapshot[],
  sideClass: string,
) {
  return (
    <section className="compare-report-block">
      <div className="compare-report-block__header">
        <h3 className="compare-report-block__title">{title}</h3>
        <span className={`compare-pill ${sideClass}`}>{tables.length}</span>
      </div>
      <p className="compare-section-desc">{description}</p>
      {tables.length === 0 ? (
        <p className="compare-hint">None.</p>
      ) : (
        <div className="compare-stack">
          {tables.map((table) => (
            <div key={table.name} className="compare-note-card">
              <p className="compare-note-card__title">{table.name}</p>
              <p className="compare-note-card__text">
                Columns: {summarizeColumns(table.columns)}
              </p>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function renderRenameSection(report: CompareReport) {
  const accepted = report.matchedTables.filter((table) => !table.exact);
  const possible = report.possibleTableMatches;

  return (
    <section className="compare-report-block">
      <div className="compare-report-block__header">
        <h3 className="compare-report-block__title">Possible Renamed Tables</h3>
        <span className="compare-pill compare-pill--neutral">
          {accepted.length + possible.length}
        </span>
      </div>
      <p className="compare-section-desc">
        These tables have different names but very similar column structures —
        they may have been renamed between schemas. Review each one to confirm
        before treating it as a missing table.
      </p>

      {accepted.length === 0 && possible.length === 0 ? (
        <p className="compare-hint">No likely renamed tables were detected.</p>
      ) : (
        <div className="compare-stack">
          {accepted.map((table) => (
            <div
              key={`${table.left.name}-${table.right.name}`}
              className="compare-note-card"
            >
              <p className="compare-note-card__title">
                {table.left.name} <span className="compare-arrow">→</span>{" "}
                {table.right.name}
              </p>
              {renderScoreBar(table.score)}
              <p className="compare-note-card__text">
                The column structure, constraints, and FK relationships closely
                match. This table was likely renamed.
              </p>
            </div>
          ))}

          {possible.map((candidate) => (
            <div
              key={`${candidate.leftName}-${candidate.rightName}`}
              className="compare-note-card compare-note-card--warning"
            >
              <p className="compare-note-card__title">
                {candidate.leftName} <span className="compare-arrow">?</span>{" "}
                {candidate.rightName}
              </p>
              {renderScoreBar(candidate.score)}
              <p className="compare-note-card__text">
                Low-confidence match — the structure partially overlaps but this
                could be a coincidence. Check manually.
              </p>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function renderConstraintGroup(
  title: string,
  diffs: ConstraintDiff[],
  tableMatch: TableMatch,
) {
  if (diffs.length === 0) {
    return null;
  }

  const { title: displayTitle, description } = constraintSectionTitle(title);

  return (
    <div className="compare-detail-group">
      <h5 className="compare-detail-group__title">{displayTitle}</h5>
      {description && <p className="compare-section-desc">{description}</p>}
      <ul className="compare-bullet-list">
        {diffs.map((diff) => (
          <li
            key={`${title}-${diff.summary}`}
            className="compare-bullet-list__item"
          >
            {diff.summary}
          </li>
        ))}
      </ul>
      {title === "Foreign Keys" && (
        <div className="compare-constraint-catalog">
          <div className="compare-constraint-catalog__column">
            <p className="compare-constraint-catalog__label">
              {tableMatch.left.name}
            </p>
            <ul className="compare-bullet-list">
              {tableMatch.left.foreignKeys.map((constraint) => (
                <li
                  key={`${tableMatch.left.name}-${constraint.name}`}
                  className="compare-bullet-list__item"
                >
                  {describeConstraint(constraint)}
                </li>
              ))}
            </ul>
          </div>
          <div className="compare-constraint-catalog__column">
            <p className="compare-constraint-catalog__label">
              {tableMatch.right.name}
            </p>
            <ul className="compare-bullet-list">
              {tableMatch.right.foreignKeys.map((constraint) => (
                <li
                  key={`${tableMatch.right.name}-${constraint.name}`}
                  className="compare-bullet-list__item"
                >
                  {describeConstraint(constraint)}
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}

function renderMatchedTable(tableMatch: TableMatch) {
  const groupedConstraints = groupConstraintDiffs(tableMatch.constraintDiffs);
  const changedColumns = tableMatch.columnMatches.filter(
    (match) => match.changes.length > 0,
  );

  return (
    <article
      key={`${tableMatch.left.name}-${tableMatch.right.name}`}
      className="compare-result-card"
    >
      <div className="compare-result-card__header">
        <div>
          <h3 className="compare-result-card__title">
            {tableMatch.left.name}
            {tableMatch.exact ? null : (
              <>
                {" "}
                <span className="compare-arrow">→</span> {tableMatch.right.name}
              </>
            )}
          </h3>
          <p className="compare-result-card__subtitle">
            {describeTableMatch(tableMatch)}
          </p>
        </div>
        <span
          className={`compare-pill ${
            tableMatch.hasChanges
              ? "compare-pill--warning"
              : "compare-pill--success"
          }`}
        >
          {tableMatch.hasChanges ? "Differences found" : "No differences"}
        </span>
      </div>

      {renderScoreBar(tableMatch.score)}
      {renderBreakdown(tableMatch.breakdown)}

      {tableMatch.changedSections.length > 0 && (
        <div className="compare-chip-row">
          {tableMatch.changedSections.map((section) => (
            <span key={section} className="compare-chip">
              {section}
            </span>
          ))}
        </div>
      )}

      {!tableMatch.exact && (
        <div className="compare-similarity-notice">
          <strong>Why was this matched?</strong> These two tables have different
          names but the algorithm found them structurally similar — columns,
          data types, constraints, and foreign-key relationships all closely
          align. This is the rename-detection feature at work.{" "}
          <strong>Please verify</strong> that{" "}
          <code>{tableMatch.left.name}</code> and{" "}
          <code>{tableMatch.right.name}</code> really are the same table before
          treating this as a confirmed rename — if they are two separate tables
          that happen to look alike, they should be reviewed independently.
        </div>
      )}

      <div className="compare-detail-grid">
        <div className="compare-detail-group">
          <h5 className="compare-detail-group__title">Columns only in A</h5>
          <p className="compare-section-desc">
            These columns exist in A but are absent in B — B needs to add them
            to stay in sync.
          </p>
          {tableMatch.columnsOnlyInA.length === 0 ? (
            <p className="compare-hint">None.</p>
          ) : (
            <ul className="compare-bullet-list">
              {tableMatch.columnsOnlyInA.map((column) => (
                <li
                  key={`${tableMatch.left.name}-${column.name}`}
                  className="compare-bullet-list__item"
                >
                  {column.name}{" "}
                  <span className="compare-column-type">
                    {column.typeDisplay}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="compare-detail-group">
          <h5 className="compare-detail-group__title">Columns only in B</h5>
          <p className="compare-section-desc">
            These columns exist in B but are absent in A — A needs to add them
            to stay in sync.
          </p>
          {tableMatch.columnsOnlyInB.length === 0 ? (
            <p className="compare-hint">None.</p>
          ) : (
            <ul className="compare-bullet-list">
              {tableMatch.columnsOnlyInB.map((column) => (
                <li
                  key={`${tableMatch.right.name}-${column.name}`}
                  className="compare-bullet-list__item"
                >
                  {column.name}{" "}
                  <span className="compare-column-type">
                    {column.typeDisplay}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <div className="compare-detail-group">
        <h5 className="compare-detail-group__title">Changed Columns</h5>
        <p className="compare-section-desc">
          These columns exist in both tables but have differences. Breaking
          changes may cause errors in your application if not handled carefully.
        </p>
        {changedColumns.length === 0 ? (
          <p className="compare-hint">No column differences found.</p>
        ) : (
          <div className="compare-stack">
            {changedColumns.map((match) => (
              <div
                key={`${tableMatch.left.name}-${match.left.name}-${match.right.name}`}
                className="compare-note-card compare-note-card--subtle"
              >
                <p className="compare-note-card__title">
                  {match.left.name}
                  {match.exact ? null : (
                    <>
                      {" "}
                      <span className="compare-arrow">→</span>{" "}
                      {match.right.name}
                    </>
                  )}
                </p>
                <ul className="compare-bullet-list">
                  {match.changes.map((change) => {
                    const severity = classifyChange(change);
                    return (
                      <li
                        key={`${match.left.name}-${change}`}
                        className="compare-bullet-list__item"
                      >
                        <span
                          className={`compare-severity-tag compare-severity-tag--${severity}`}
                        >
                          {severity === "breaking"
                            ? "Breaking"
                            : severity === "safe"
                              ? "Safe"
                              : "Info"}
                        </span>
                        {change}
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </div>
        )}
      </div>

      {tableMatch.possibleColumnMatches.length > 0 && (
        <div className="compare-detail-group">
          <h5 className="compare-detail-group__title">
            Possible Renamed Columns
          </h5>
          <p className="compare-section-desc">
            These columns have different names but similar types and positions —
            they may have been renamed.
          </p>
          <div className="compare-stack">
            {tableMatch.possibleColumnMatches.map((candidate) => (
              <div
                key={`${tableMatch.left.name}-${candidate.leftName}-${candidate.rightName}`}
                className="compare-note-card compare-note-card--warning"
              >
                <p className="compare-note-card__title">
                  {candidate.leftName} <span className="compare-arrow">?</span>{" "}
                  {candidate.rightName}
                </p>
                {renderScoreBar(candidate.score)}
                <p className="compare-note-card__text">
                  Possible rename — check if this is intentional.
                </p>
              </div>
            ))}
          </div>
        </div>
      )}

      {renderConstraintGroup(
        "Primary Key",
        groupedConstraints["PRIMARY KEY"],
        tableMatch,
      )}
      {renderConstraintGroup(
        "Unique Constraints",
        groupedConstraints.UNIQUE,
        tableMatch,
      )}
      {renderConstraintGroup(
        "Foreign Keys",
        groupedConstraints["FOREIGN KEY"],
        tableMatch,
      )}
      {renderConstraintGroup(
        "Check Constraints",
        groupedConstraints.CHECK,
        tableMatch,
      )}
      {renderConstraintGroup(
        "Exclude Constraints",
        groupedConstraints.EXCLUDE,
        tableMatch,
      )}
    </article>
  );
}

function renderMigrationSection(report: CompareReport) {
  const script = generateMigration(report);
  const sqlText = renderMigrationScript(script);
  const breaking = script.statements.filter(
    (s) => s.severity === "breaking",
  ).length;
  const safe = script.statements.filter((s) => s.severity === "safe").length;
  const info = script.statements.filter((s) => s.severity === "info").length;

  const suggestedName = `sync_${report.right.schema}_to_${report.left.schema}`
    .replace(/[^a-z0-9_]/gi, "_")
    .toLowerCase();
  const suggestedDescription = `Sync ${report.right.database}.${report.right.schema} to match ${report.left.database}.${report.left.schema}`;
  const sourceLabel = `${report.left.database}.${report.left.schema} → ${report.right.database}.${report.right.schema}`;

  // Worst-case severity determines the version bump kind
  const overallKind: ChangeKind = script.statements.some(
    (s) => s.severity === "breaking",
  )
    ? "breaking"
    : script.statements.some(
          (s) => s.severity === "safe" || s.severity === "info",
        )
      ? "additive"
      : "patch";

  return (
    <div className="compare-card compare-card--spaced">
      <div className="compare-card__header">
        <div>
          <h2 className="compare-card__title">
            Migration Script: Right Syncs To Left
          </h2>
          <p className="compare-hint">
            This script modifies only the right/target schema{" "}
            <code className="compare-code">
              {report.right.database}.{report.right.schema}
            </code>{" "}
            so it matches the left/source schema{" "}
            <code className="compare-code">
              {report.left.database}.{report.left.schema}
            </code>
            . Put the newer desired schema on the left and the outdated schema
            on the right. Review every statement before running — breaking
            changes are flagged.
          </p>
        </div>
        <div className="compare-card__actions">
          {script.statements.length > 0 && (
            <SaveScriptButton
              sqlContent={sqlText}
              suggestedName={suggestedName}
              suggestedDescription={suggestedDescription}
              sourceLabel={sourceLabel}
              changeKind={overallKind}
            />
          )}
          <CopyButton text={sqlText} />
        </div>
      </div>

      <div className="compare-similarity-notice">
        <strong>Direction check:</strong> generated SQL always updates the right
        side to match the left side. If the left side is older than the right
        side, this becomes a downgrade script.
      </div>

      <div className="compare-chip-row">
        <span className="compare-severity-tag compare-severity-tag--breaking">
          {breaking} Breaking
        </span>
        <span className="compare-severity-tag compare-severity-tag--safe">
          {safe} Safe
        </span>
        <span className="compare-severity-tag compare-severity-tag--info">
          {info} Info
        </span>
      </div>

      {script.warnings.length > 0 && (
        <div className="compare-stack">
          {script.warnings.map((w) => (
            <p key={w} className="compare-hint compare-hint--error">
              {w}
            </p>
          ))}
        </div>
      )}

      {script.statements.length === 0 ? (
        <p className="compare-hint">
          No migration statements needed — schemas are already in sync.
        </p>
      ) : (
        <pre className="compare-codebox">{sqlText}</pre>
      )}
    </div>
  );
}

export default async function ComparePage({ searchParams }: PageProps) {
  const params = await searchParams;
  const savedConnections = await getSavedConnections();
  const resolved = resolveCompareTargets();

  const selectedLeftConnectionId = pickValue(
    params.leftConnection,
    savedConnections[0]?.id ? String(savedConnections[0].id) : "",
  );
  const selectedRightConnectionId = pickValue(
    params.rightConnection,
    savedConnections[1]?.id
      ? String(savedConnections[1].id)
      : savedConnections[0]?.id
        ? String(savedConnections[0].id)
        : "",
  );

  const leftConnection =
    savedConnections.find(
      (connection) => String(connection.id) === selectedLeftConnectionId,
    ) ?? savedConnections[0];

  const rightConnection =
    savedConnections.find(
      (connection) => String(connection.id) === selectedRightConnectionId,
    ) ??
    savedConnections[1] ??
    savedConnections[0];

  let leftTarget: CompareTarget | null = leftConnection
    ? buildTargetFromConnection(leftConnection, "a")
    : null;

  let rightTarget: CompareTarget | null = rightConnection
    ? buildTargetFromConnection(rightConnection, "b")
    : null;

  if ((!leftTarget || !rightTarget) && resolved.ok) {
    leftTarget = leftTarget ?? resolved.a;
    rightTarget = rightTarget ?? resolved.b;
  }

  if (!leftTarget || !rightTarget) {
    return (
      <div className="db-layout">
        <Sidebar current="Schema Comparison" />
        <main className="db-main">
          <Topbar
            title="Schema Comparison"
            text="Live PostgreSQL schema diffs for the current prototype."
          />
          <div className="compare-card">
            <h2 className="compare-card__title">No Saved Connections Found</h2>
            <p className="compare-hint compare-hint--error">
              Please add at least two PostgreSQL connections in the Connections
              page first.
            </p>
            {!resolved.ok ? (
              <p className="compare-hint">{resolved.error}</p>
            ) : null}
          </div>
        </main>
      </div>
    );
  }

  const [schemasA, schemasB] = await Promise.all([
    fetchSchemaNames(leftTarget.config),
    fetchSchemaNames(rightTarget.config),
  ]);

  const schemaErrors = [schemasA, schemasB].filter((result) => !result.ok);
  const schemaMap = new Map<string, string[]>();
  if (schemasA.ok) {
    schemaMap.set(leftTarget.id, schemasA.data);
  }
  if (schemasB.ok) {
    schemaMap.set(rightTarget.id, schemasB.data);
  }

  const leftSchemaOptions = schemaMap.get(leftTarget.id) ?? [];
  const rightSchemaOptions = schemaMap.get(rightTarget.id) ?? [];
  const leftSchemaFallback =
    leftSchemaOptions.find(
      (schema) => schema === envValue("COMPARE_SCHEMA_A", "public"),
    ) ??
    leftSchemaOptions[0] ??
    envValue("COMPARE_SCHEMA_A", "public");
  const rightSchemaFallback =
    rightSchemaOptions.find(
      (schema) => schema === envValue("COMPARE_SCHEMA_B", "public"),
    ) ??
    rightSchemaOptions[0] ??
    envValue("COMPARE_SCHEMA_B", "public");

  const leftSchema = pickValue(params.leftSchema, leftSchemaFallback);
  const rightSchema = pickValue(params.rightSchema, rightSchemaFallback);
  const selectionErrors: string[] = [];

  if (leftSchemaOptions.length > 0 && !leftSchemaOptions.includes(leftSchema)) {
    selectionErrors.push(
      `Schema ${leftSchema} was not found in ${leftTarget.displayName}.`,
    );
  }
  if (
    rightSchemaOptions.length > 0 &&
    !rightSchemaOptions.includes(rightSchema)
  ) {
    selectionErrors.push(
      `Schema ${rightSchema} was not found in ${rightTarget.displayName}.`,
    );
  }

  let report: CompareReport | null = null;
  const compareErrors = [
    ...schemaErrors
      .filter((result): result is { ok: false; error: string } => !result.ok)
      .map((result) => result.error),
    ...selectionErrors,
  ];

  if (compareErrors.length === 0) {
    const [leftSnapshot, rightSnapshot] = await Promise.all([
      fetchSchemaSnapshot(leftTarget.config, leftSchema),
      fetchSchemaSnapshot(rightTarget.config, rightSchema),
    ]);

    if (!leftSnapshot.ok) {
      compareErrors.push(
        `Could not load ${leftTarget.displayName}.${leftSchema}: ${leftSnapshot.error}`,
      );
    }
    if (!rightSnapshot.ok) {
      compareErrors.push(
        `Could not load ${rightTarget.displayName}.${rightSchema}: ${rightSnapshot.error}`,
      );
    }

    if (leftSnapshot.ok && rightSnapshot.ok) {
      report = compareSchemas(leftSnapshot.data, rightSnapshot.data);

      if (pickValue(params.run, "") === "1") {
        try {
          await pool.query(`
            CREATE TABLE IF NOT EXISTS schema_comparisons (
              id SERIAL PRIMARY KEY,
              schema_a TEXT NOT NULL,
              schema_b TEXT NOT NULL,
              compared_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
          `);

          await pool.query(
            `
            INSERT INTO schema_comparisons (schema_a, schema_b)
            VALUES ($1, $2)
            `,
            [
              `${leftTarget.displayName}.${leftSchema}`,
              `${rightTarget.displayName}.${rightSchema}`,
            ],
          );
        } catch (error) {
          console.error("Failed to save comparison history:", error);
        }
      }
    }
  }

  return (
    <div className="db-layout">
      <Sidebar current="Schema Comparison" />

      <main className="db-main">
        <Topbar
          title="Schema Comparison"
          text="Live PostgreSQL schema diffs and constraint analysis for the current prototype."
        />

        <div className="compare-card compare-card--setup compare-card--spaced">
          <div className="compare-card__header">
            <div>
              <h2 className="compare-card__title">Comparison Setup</h2>
              <p className="compare-hint">
                Pick the desired source schema on the left and the target schema
                to update on the right. Generated SQL always syncs right to
                left.
              </p>
            </div>
            <span className="compare-pill compare-pill--neutral">
              Right syncs to left
            </span>
          </div>

          <form action="/compare" className="compare-form-grid">
            <input type="hidden" name="run" value="1" />

            <div className="compare-form-card">
              <h3 className="compare-form-card__title">
                Left Side (A): Source / Desired
              </h3>
              <label className="compare-field">
                <span className="compare-field__label">
                  Source saved connection
                </span>
                <select
                  name="leftConnection"
                  defaultValue={leftConnection?.id ?? ""}
                  className="compare-select"
                >
                  {savedConnections.map((connection) => (
                    <option key={`left-${connection.id}`} value={connection.id}>
                      {connection.name} ({connection.database_name})
                    </option>
                  ))}
                </select>
              </label>
              <label className="compare-field">
                <span className="compare-field__label">Source schema</span>
                <select
                  name="leftSchema"
                  defaultValue={leftSchema}
                  className="compare-select"
                >
                  {leftSchemaOptions.map((schema) => (
                    <option key={`${leftTarget.id}-${schema}`} value={schema}>
                      {schema}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <div className="compare-form-card">
              <h3 className="compare-form-card__title">
                Right Side (B): Target / Outdated
              </h3>
              <label className="compare-field">
                <span className="compare-field__label">
                  Target saved connection
                </span>
                <select
                  name="rightConnection"
                  defaultValue={rightConnection?.id ?? ""}
                  className="compare-select"
                >
                  {savedConnections.map((connection) => (
                    <option
                      key={`right-${connection.id}`}
                      value={connection.id}
                    >
                      {connection.name} ({connection.database_name})
                    </option>
                  ))}
                </select>
              </label>
              <label className="compare-field">
                <span className="compare-field__label">
                  Target schema to update
                </span>
                <select
                  name="rightSchema"
                  defaultValue={rightSchema}
                  className="compare-select"
                >
                  {rightSchemaOptions.map((schema) => (
                    <option key={`${rightTarget.id}-${schema}`} value={schema}>
                      {schema}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <div className="compare-form-actions">
              <button
                type="submit"
                className="compare-btn compare-btn--primary"
              >
                Compare Schemas
              </button>
              <p className="compare-hint compare-hint--tight compare-hint--error">
                Direction matters: left is the version you want, right is the
                database/schema that will receive changes.
              </p>
              <p className="compare-hint compare-hint--tight">
                Connection options are loaded from the saved records in the
                Connections page.
              </p>
            </div>
          </form>
        </div>

        {compareErrors.length > 0 ? (
          <div className="compare-card">
            <h2 className="compare-card__title">Unable To Compare</h2>
            <div className="compare-stack">
              {compareErrors.map((error) => (
                <p key={error} className="compare-hint compare-hint--error">
                  {error}
                </p>
              ))}
            </div>
          </div>
        ) : null}

        {report ? (
          <>
            {healthBanner(report)}

            <div className="compare-summary-grid">
              <div className="compare-summary-card">
                <p className="compare-summary-card__label">
                  Missing from Target (B)
                </p>
                <h2 className="compare-summary-card__value">
                  {report.summary.tablesOnlyInA}
                </h2>
                <p className="compare-summary-card__hint">
                  Source tables that target does not have yet
                </p>
              </div>
              <div className="compare-summary-card">
                <p className="compare-summary-card__label">
                  Extra in Target (B)
                </p>
                <h2 className="compare-summary-card__value">
                  {report.summary.tablesOnlyInB}
                </h2>
                <p className="compare-summary-card__hint">
                  Target tables absent from the source schema
                </p>
              </div>
              <div className="compare-summary-card">
                <p className="compare-summary-card__label">
                  Tables With Changes
                </p>
                <h2 className="compare-summary-card__value">
                  {report.summary.changedTables}
                </h2>
                <p className="compare-summary-card__hint">
                  Same table in both but structure differs
                </p>
              </div>
              <div className="compare-summary-card">
                <p className="compare-summary-card__label">Rule Changes</p>
                <h2 className="compare-summary-card__value">
                  {report.summary.changedConstraints}
                </h2>
                <p className="compare-summary-card__hint">
                  Differences in keys, links, or validation rules
                </p>
              </div>
              <div className="compare-summary-card">
                <p className="compare-summary-card__label">Possible Renames</p>
                <h2 className="compare-summary-card__value">
                  {report.summary.likelyRenameCandidates}
                </h2>
                <p className="compare-summary-card__hint">
                  Tables that may have been renamed
                </p>
              </div>
            </div>

            <div className="compare-card compare-card--spaced">
              <div className="compare-card__header">
                <div>
                  <h2 className="compare-card__title">Comparison Report</h2>
                  <p className="compare-hint">
                    Comparing{" "}
                    <code className="compare-code">{report.left.database}</code>
                    .<code className="compare-code">{report.left.schema}</code>{" "}
                    against{" "}
                    <code className="compare-code">
                      {report.right.database}
                    </code>
                    .<code className="compare-code">{report.right.schema}</code>
                    .
                  </p>
                </div>
                <span className="compare-pill compare-pill--success">
                  {report.summary.identicalTables} identical
                </span>
              </div>

              {report.summary.changedTables === 0 &&
              report.summary.tablesOnlyInA === 0 &&
              report.summary.tablesOnlyInB === 0 &&
              report.summary.changedConstraints === 0 ? (
                <p className="compare-hint">
                  No schema differences were detected for the selected pair.
                </p>
              ) : null}

              <div className="compare-report-grid">
                {renderTableList(
                  "Tables Only In A",
                  `These tables exist in ${report.left.database}.${report.left.schema} but haven't been created in ${report.right.database}.${report.right.schema} yet. If B is your production database, this is a gap that needs to be filled.`,
                  report.tablesOnlyInA,
                  "compare-pill--danger",
                )}
                {renderTableList(
                  "Tables Only In B",
                  `These tables exist in ${report.right.database}.${report.right.schema} but are absent from ${report.left.database}.${report.left.schema}. They may be new tables added to B that A doesn't know about yet.`,
                  report.tablesOnlyInB,
                  "compare-pill--info",
                )}
              </div>

              {renderRenameSection(report)}

              <section className="compare-report-block">
                <div className="compare-report-block__header">
                  <h3 className="compare-report-block__title">
                    Matched Table Details
                  </h3>
                  <span className="compare-pill compare-pill--neutral">
                    {report.matchedTables.length}
                  </span>
                </div>

                {report.matchedTables.length === 0 ? (
                  <p className="compare-hint">No table matches were found.</p>
                ) : (
                  <div className="compare-stack">
                    {report.matchedTables.map((tableMatch) =>
                      renderMatchedTable(tableMatch),
                    )}
                  </div>
                )}
              </section>
            </div>

            {renderMigrationSection(report)}
          </>
        ) : null}
      </main>
    </div>
  );
}
