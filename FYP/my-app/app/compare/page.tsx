import Sidebar from "../../components/Sidebar";
import Topbar from "../../components/Topbar";
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
  type CompareReport,
  type ConstraintDiff,
  type MatchCandidate,
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

function scoreBreakdownLabel(candidate: MatchCandidate): string {
  if (candidate.kind === "table") {
    return `Name ${candidate.breakdown.name}, constraints ${candidate.breakdown.constraints}, columns ${candidate.breakdown.columns ?? 0}`;
  }

  return `Name ${candidate.breakdown.name}, type ${candidate.breakdown.type ?? 0}, constraints ${candidate.breakdown.constraints}, order ${candidate.breakdown.order ?? 0}`;
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

function renderTableList(title: string, tables: TableSnapshot[], sideClass: string) {
  return (
    <section className="compare-report-block">
      <div className="compare-report-block__header">
        <h3 className="compare-report-block__title">{title}</h3>
        <span className={`compare-pill ${sideClass}`}>{tables.length}</span>
      </div>
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
        <h3 className="compare-report-block__title">Likely Rename Candidates</h3>
        <span className="compare-pill compare-pill--neutral">
          {accepted.length + possible.length}
        </span>
      </div>

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
              <p className="compare-note-card__text">
                Accepted similarity match at {table.score}%.
              </p>
              <p className="compare-note-card__meta">
                Name {table.breakdown.name}, constraints {table.breakdown.constraints},
                columns {table.breakdown.columns ?? 0}
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
              <p className="compare-note-card__text">
                Possible match at {candidate.score}%.
              </p>
              <p className="compare-note-card__meta">
                {scoreBreakdownLabel(candidate)}
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

  return (
    <div className="compare-detail-group">
      <h5 className="compare-detail-group__title">{title}</h5>
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

      <p className="compare-note-card__meta compare-note-card__meta--inline">
        Name {tableMatch.breakdown.name}, constraints {tableMatch.breakdown.constraints},
        columns {tableMatch.breakdown.columns ?? 0}
      </p>

      {tableMatch.changedSections.length > 0 && (
        <div className="compare-chip-row">
          {tableMatch.changedSections.map((section) => (
            <span key={section} className="compare-chip">
              {section}
            </span>
          ))}
        </div>
      )}

      <div className="compare-detail-grid">
        <div className="compare-detail-group">
          <h5 className="compare-detail-group__title">Columns Only In A</h5>
          {tableMatch.columnsOnlyInA.length === 0 ? (
            <p className="compare-hint">None.</p>
          ) : (
            <ul className="compare-bullet-list">
              {tableMatch.columnsOnlyInA.map((column) => (
                <li
                  key={`${tableMatch.left.name}-${column.name}`}
                  className="compare-bullet-list__item"
                >
                  {column.name} ({column.typeDisplay})
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="compare-detail-group">
          <h5 className="compare-detail-group__title">Columns Only In B</h5>
          {tableMatch.columnsOnlyInB.length === 0 ? (
            <p className="compare-hint">None.</p>
          ) : (
            <ul className="compare-bullet-list">
              {tableMatch.columnsOnlyInB.map((column) => (
                <li
                  key={`${tableMatch.right.name}-${column.name}`}
                  className="compare-bullet-list__item"
                >
                  {column.name} ({column.typeDisplay})
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <div className="compare-detail-group">
        <h5 className="compare-detail-group__title">Changed Matched Columns</h5>
        {changedColumns.length === 0 ? (
          <p className="compare-hint">No matched columns changed.</p>
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
                  {match.changes.map((change) => (
                    <li
                      key={`${match.left.name}-${change}`}
                      className="compare-bullet-list__item"
                    >
                      {change}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </div>

      {tableMatch.possibleColumnMatches.length > 0 && (
        <div className="compare-detail-group">
          <h5 className="compare-detail-group__title">Possible Renamed Columns</h5>
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
                <p className="compare-note-card__text">
                  Possible match at {candidate.score}%.
                </p>
                <p className="compare-note-card__meta">
                  {scoreBreakdownLabel(candidate)}
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
            text="Week-7 prototype for live PostgreSQL schema diffs."
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
          text="Week-7 prototype for live PostgreSQL schema diffs and constraint analysis."
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
            <div className="compare-summary-grid">
              <div className="compare-summary-card">
                <p className="compare-summary-card__label">Tables Only In A</p>
                <h2 className="compare-summary-card__value">
                  {report.summary.tablesOnlyInA}
                </h2>
                <p className="compare-summary-card__hint">
                  {report.left.database}.{report.left.schema}
                </p>
              </div>
              <div className="compare-summary-card">
                <p className="compare-summary-card__label">Tables Only In B</p>
                <h2 className="compare-summary-card__value">
                  {report.summary.tablesOnlyInB}
                </h2>
                <p className="compare-summary-card__hint">
                  {report.right.database}.{report.right.schema}
                </p>
              </div>
              <div className="compare-summary-card">
                <p className="compare-summary-card__label">Changed Matched Tables</p>
                <h2 className="compare-summary-card__value">
                  {report.summary.changedTables}
                </h2>
                <p className="compare-summary-card__hint">
                  Exact + similarity matches
                </p>
              </div>
              <div className="compare-summary-card">
                <p className="compare-summary-card__label">Changed Constraints</p>
                <h2 className="compare-summary-card__value">
                  {report.summary.changedConstraints}
                </h2>
                <p className="compare-summary-card__hint">
                  PK, unique, FK, check, exclude
                </p>
              </div>
              <div className="compare-summary-card">
                <p className="compare-summary-card__label">
                  Likely Rename Candidates
                </p>
                <h2 className="compare-summary-card__value">
                  {report.summary.likelyRenameCandidates}
                </h2>
                <p className="compare-summary-card__hint">
                  Accepted + possible similarity matches
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
                  report.tablesOnlyInA,
                  "compare-pill--danger"
                )}
                {renderTableList(
                  "Tables Only In B",
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
          </>
        ) : null}
      </main>
    </div>
  );
}
