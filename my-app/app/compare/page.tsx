import Sidebar from "../../components/Sidebar";
import Topbar from "../../components/Topbar";
import CopyButton from "../../components/CopyButton";
import { generateMigration, renderMigrationScript } from "../../lib/generate-sql";
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

function envValue(name: string, fallback: string): string {
  const value = process.env[name]?.trim();
  return value && value.length > 0 ? value : fallback;
}

function pickValue(
  value: string | string[] | undefined,
  fallback: string
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

function groupConstraintDiffs(diffs: ConstraintDiff[]): Record<ConstraintKind | "FOREIGN KEY", ConstraintDiff[]> {
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
  const dims: Array<{ label: string; value: number; max: number; hint: string }> = [
    { label: "Name",         value: breakdown.name,         max: TABLE_DIMENSION_MAX.name,        hint: "How similar the table names are" },
    { label: "Columns",      value: breakdown.columns ?? 0, max: TABLE_DIMENSION_MAX.columns,     hint: "How well the column structures match" },
    { label: "Constraints",  value: breakdown.constraints,  max: TABLE_DIMENSION_MAX.constraints, hint: "Keys, foreign keys, and rules overlap" },
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
          <span key={dim.label} className="compare-breakdown__item" title={dim.hint}>
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
        {count === 1 ? "" : "s"} exist in only one schema and need to be
        created in the other.
      </div>
    );
  }
  if (hasChanges) {
    return (
      <div className="compare-health-banner compare-health-banner--warning">
        ⚡ Differences detected — {report.summary.changedTables} table
        {report.summary.changedTables === 1 ? "" : "s"} have structural
        changes that need to be reviewed before deploying.
      </div>
    );
  }
  return (
    <div className="compare-health-banner compare-health-banner--success">
      ✓ Schemas are in sync — no structural differences found.
    </div>
  );
}

function renderTableList(title: string, description: string, tables: TableSnapshot[], sideClass: string) {
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
  tableMatch: TableMatch
) {
  if (diffs.length === 0) {
    return null;
  }

  const { title: displayTitle, description } = constraintSectionTitle(title);

  return (
    <div className="compare-detail-group">
      <h5 className="compare-detail-group__title">{displayTitle}</h5>
      {description && (
        <p className="compare-section-desc">{description}</p>
      )}
      <ul className="compare-bullet-list">
        {diffs.map((diff) => (
          <li key={`${title}-${diff.summary}`} className="compare-bullet-list__item">
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
    (match) => match.changes.length > 0
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
          <h5 className="compare-detail-group__title">
            Columns only in A
          </h5>
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
                  <span className="compare-column-type">{column.typeDisplay}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="compare-detail-group">
          <h5 className="compare-detail-group__title">
            Columns only in B
          </h5>
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
                  <span className="compare-column-type">{column.typeDisplay}</span>
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
                      <span className="compare-arrow">→</span> {match.right.name}
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
          <h5 className="compare-detail-group__title">Possible Renamed Columns</h5>
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

      {renderConstraintGroup("Primary Key", groupedConstraints["PRIMARY KEY"], tableMatch)}
      {renderConstraintGroup("Unique Constraints", groupedConstraints.UNIQUE, tableMatch)}
      {renderConstraintGroup("Foreign Keys", groupedConstraints["FOREIGN KEY"], tableMatch)}
      {renderConstraintGroup("Check Constraints", groupedConstraints.CHECK, tableMatch)}
      {renderConstraintGroup("Exclude Constraints", groupedConstraints.EXCLUDE, tableMatch)}
    </article>
  );
}

function renderMigrationSection(report: CompareReport) {
  const script = generateMigration(report);
  const sqlText = renderMigrationScript(script);
  const breaking = script.statements.filter((s) => s.severity === "breaking").length;
  const safe = script.statements.filter((s) => s.severity === "safe").length;
  const info = script.statements.filter((s) => s.severity === "info").length;

  return (
    <div className="compare-card compare-card--spaced">
      <div className="compare-card__header">
        <div>
          <h2 className="compare-card__title">Migration Script</h2>
          <p className="compare-hint">
            SQL to bring{" "}
            <code className="compare-code">
              {report.right.database}.{report.right.schema}
            </code>{" "}
            in sync with{" "}
            <code className="compare-code">
              {report.left.database}.{report.left.schema}
            </code>
            . Review every statement before running — breaking changes are
            flagged.
          </p>
        </div>
        <CopyButton text={sqlText} />
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
  const resolved = resolveCompareTargets();

  if (!resolved.ok) {
    return (
      <div className="db-layout">
        <Sidebar current="Schema Comparison" />
        <main className="db-main">
          <Topbar
            title="Schema Comparison"
            text="Live PostgreSQL schema diffs for the current prototype."
          />
          <div className="compare-card">
            <h2 className="compare-card__title">PostgreSQL Targets</h2>
            <p className="compare-hint compare-hint--error">{resolved.error}</p>
            <p className="compare-hint">
              Configure <code className="compare-code">DATABASE_URL</code> or the
              pair <code className="compare-code">DATABASE_URL_A</code> /{" "}
              <code className="compare-code">DATABASE_URL_B</code> to continue.
            </p>
          </div>
        </main>
      </div>
    );
  }

  const targets = [resolved.a, resolved.b];
  const defaultLeftDb = pickValue(params.leftDb, resolved.a.id);
  const defaultRightDb = pickValue(params.rightDb, resolved.b.id);
  const leftTarget = getTargetById(targets, defaultLeftDb);
  const rightTarget = getTargetById(targets, defaultRightDb);

  const [schemasA, schemasB] = await Promise.all([
    fetchSchemaNames(resolved.a.config),
    fetchSchemaNames(resolved.b.config),
  ]);

  const schemaErrors = [schemasA, schemasB].filter((result) => !result.ok);
  const schemaMap = new Map<string, string[]>();
  if (schemasA.ok) {
    schemaMap.set(resolved.a.id, schemasA.data);
  }
  if (schemasB.ok) {
    schemaMap.set(resolved.b.id, schemasB.data);
  }

  const leftSchemaOptions = schemaMap.get(leftTarget.id) ?? [];
  const rightSchemaOptions = schemaMap.get(rightTarget.id) ?? [];
  const leftSchemaFallback =
    leftSchemaOptions.find(
      (schema) => schema === envValue("COMPARE_SCHEMA_A", "public")
    ) ??
    leftSchemaOptions[0] ??
    envValue("COMPARE_SCHEMA_A", "public");
  const rightSchemaFallback =
    rightSchemaOptions.find(
      (schema) => schema === envValue("COMPARE_SCHEMA_B", "public")
    ) ??
    rightSchemaOptions[0] ??
    envValue("COMPARE_SCHEMA_B", "public");

  const leftSchema = pickValue(params.leftSchema, leftSchemaFallback);
  const rightSchema = pickValue(params.rightSchema, rightSchemaFallback);
  const selectionErrors: string[] = [];

  if (leftSchemaOptions.length > 0 && !leftSchemaOptions.includes(leftSchema)) {
    selectionErrors.push(
      `Schema ${leftSchema} was not found in ${leftTarget.displayName}.`
    );
  }
  if (rightSchemaOptions.length > 0 && !rightSchemaOptions.includes(rightSchema)) {
    selectionErrors.push(
      `Schema ${rightSchema} was not found in ${rightTarget.displayName}.`
    );
  }

  let report: CompareReport | null = null;
  const compareErrors = [...schemaErrors
    .filter((result): result is { ok: false; error: string } => !result.ok)
    .map((result) => result.error), ...selectionErrors];

  if (compareErrors.length === 0) {
    const [leftSnapshot, rightSnapshot] = await Promise.all([
      fetchSchemaSnapshot(leftTarget.config, leftSchema),
      fetchSchemaSnapshot(rightTarget.config, rightSchema),
    ]);

    if (!leftSnapshot.ok) {
      compareErrors.push(
        `Could not load ${leftTarget.displayName}.${leftSchema}: ${leftSnapshot.error}`
      );
    }
    if (!rightSnapshot.ok) {
      compareErrors.push(
        `Could not load ${rightTarget.displayName}.${rightSchema}: ${rightSnapshot.error}`
      );
    }

    if (leftSnapshot.ok && rightSnapshot.ok) {
      report = compareSchemas(leftSnapshot.data, rightSnapshot.data);
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
                Pick any two schemas from the preset database targets, then review
                table, column, and constraint differences in one report.
              </p>
            </div>
            <span className="compare-pill compare-pill--neutral">
              Diff report only
            </span>
          </div>

          <form action="/compare" className="compare-form-grid">
            <div className="compare-form-card">
              <h3 className="compare-form-card__title">Left Side (A)</h3>
              <label className="compare-field">
                <span className="compare-field__label">Database target</span>
                <select
                  name="leftDb"
                  defaultValue={leftTarget.id}
                  className="compare-select"
                >
                  {targets.map((target) => (
                    <option key={target.id} value={target.id}>
                      {target.displayName}
                    </option>
                  ))}
                </select>
              </label>
              <label className="compare-field">
                <span className="compare-field__label">Schema</span>
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
              <h3 className="compare-form-card__title">Right Side (B)</h3>
              <label className="compare-field">
                <span className="compare-field__label">Database target</span>
                <select
                  name="rightDb"
                  defaultValue={rightTarget.id}
                  className="compare-select"
                >
                  {targets.map((target) => (
                    <option key={target.id} value={target.id}>
                      {target.displayName}
                    </option>
                  ))}
                </select>
              </label>
              <label className="compare-field">
                <span className="compare-field__label">Schema</span>
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
              <button type="submit" className="compare-btn compare-btn--primary">
                Compare Schemas
              </button>
              <p className="compare-hint compare-hint--tight">
                Targets come from <code className="compare-code">DATABASE_URL</code>,{" "}
                <code className="compare-code">DATABASE_URL_A</code>, and{" "}
                <code className="compare-code">DATABASE_URL_B</code>.
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
                <p className="compare-summary-card__label">Missing from B</p>
                <h2 className="compare-summary-card__value">
                  {report.summary.tablesOnlyInA}
                </h2>
                <p className="compare-summary-card__hint">
                  Tables in A that B doesn&apos;t have yet
                </p>
              </div>
              <div className="compare-summary-card">
                <p className="compare-summary-card__label">Missing from A</p>
                <h2 className="compare-summary-card__value">
                  {report.summary.tablesOnlyInB}
                </h2>
                <p className="compare-summary-card__hint">
                  Tables in B that A doesn&apos;t have yet
                </p>
              </div>
              <div className="compare-summary-card">
                <p className="compare-summary-card__label">Tables With Changes</p>
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
                    Comparing <code className="compare-code">{report.left.database}</code>.
                    <code className="compare-code">{report.left.schema}</code> against{" "}
                    <code className="compare-code">{report.right.database}</code>.
                    <code className="compare-code">{report.right.schema}</code>.
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
                  "compare-pill--danger"
                )}
                {renderTableList(
                  "Tables Only In B",
                  `These tables exist in ${report.right.database}.${report.right.schema} but are absent from ${report.left.database}.${report.left.schema}. They may be new tables added to B that A doesn't know about yet.`,
                  report.tablesOnlyInB,
                  "compare-pill--info"
                )}
              </div>

              {renderRenameSection(report)}

              <section className="compare-report-block">
                <div className="compare-report-block__header">
                  <h3 className="compare-report-block__title">Matched Table Details</h3>
                  <span className="compare-pill compare-pill--neutral">
                    {report.matchedTables.length}
                  </span>
                </div>

                {report.matchedTables.length === 0 ? (
                  <p className="compare-hint">No table matches were found.</p>
                ) : (
                  <div className="compare-stack">
                    {report.matchedTables.map((tableMatch) =>
                      renderMatchedTable(tableMatch)
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
