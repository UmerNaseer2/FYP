import Sidebar from "../../components/Sidebar";
import Topbar from "../../components/Topbar";
import {
  fetchSchemaNames,
  resolveCompareTargets,
  type CompareTarget,
} from "../../lib/postgres";
import {
  fetchSchemaVersionInfo,
  type ChangeLevel,
  type VersionDetectionResult,
} from "../../lib/version-detection";

export const dynamic = "force-dynamic";

type PageProps = {
  searchParams: Promise<{
    target?: string;
    schema?: string;
  }>;
};

function levelClass(level: ChangeLevel) {
  switch (level) {
    case "breaking":
      return "compare-pill compare-pill--danger";
    case "additive":
      return "compare-pill compare-pill--success";
    case "patch":
      return "compare-pill compare-pill--info";
    default:
      return "compare-pill compare-pill--neutral";
  }
}

function pickTarget(targets: CompareTarget[], targetId: string | undefined) {
  return targets.find((target) => target.id === targetId) ?? targets[0];
}

function pickSchema(schemas: string[], requested: string | undefined) {
  if (requested && schemas.includes(requested)) return requested;
  return schemas[0] ?? "";
}

function targetLabel(target: CompareTarget) {
  return `Database ${target.id.toUpperCase()} - ${target.displayName}`;
}

function renderVersionSummary(
  target: CompareTarget,
  version: VersionDetectionResult
) {
  return (
    <section className="version-summary-grid">
      <div className="version-card">
        <p className="version-stat-label">Database</p>
        <h3 className="version-stat-value">{target.displayName}</h3>
        <p className="version-text">Target {target.id.toUpperCase()}</p>
      </div>

      <div className="version-card">
        <p className="version-stat-label">Schema</p>
        <h3 className="version-stat-value">{version.schema}</h3>
        <p className="version-text">Selected environment/schema</p>
      </div>

      <div className="version-card">
        <p className="version-stat-label">Detected Version</p>
        <h3 className="version-stat-value">
          {version.detectedVersion ?? "N/A"}
        </h3>
        <p className="version-text">
          {version.hasVersionTable ? "Read from version table" : "No version row"}
        </p>
      </div>

      <div className="version-card">
        <p className="version-stat-label">Version Table</p>
        <h3 className="version-stat-value">
          {version.tableName ?? "Missing"}
        </h3>
        <p className="version-text">
          {version.hasVersionTable ? "Ready for script checks" : "Needs setup"}
        </p>
      </div>
    </section>
  );
}

function renderStatusCard(version: VersionDetectionResult) {
  if (version.hasVersionTable) {
    return (
      <section className="compare-report-block">
        <div className="compare-report-block__header">
          <div>
            <h2 className="compare-report-block__title">Version Status</h2>
            <p className="compare-section-desc">
              This schema has version history, so the runner can later compare
              it against approved scripts and identify pending versions.
            </p>
          </div>
          <span className="compare-pill compare-pill--success">Ready</span>
        </div>
        <p className="version-text">{version.message}</p>
      </section>
    );
  }

  return (
    <section className="compare-report-block">
      <div className="compare-report-block__header">
        <div>
          <h2 className="compare-report-block__title">Version Status</h2>
          <p className="compare-section-desc">
            This schema does not have a version table yet. Add
            <code className="compare-code"> script_patch </code>
            before using it for deployment version checks.
          </p>
        </div>
        <span className="compare-pill compare-pill--warning">Setup needed</span>
      </div>
      <p className="version-text">{version.message}</p>
    </section>
  );
}

function renderTimeline(version: VersionDetectionResult) {
  return (
    <section className="version-card">
      <div className="compare-report-block__header">
        <div>
          <h3 className="version-card__title">Version Timeline</h3>
          <p className="compare-section-desc">
            Applied scripts recorded inside this schema.
          </p>
        </div>

        <span className="compare-pill compare-pill--neutral">
          {version.timeline.length}
        </span>
      </div>

      {version.timeline.length === 0 ? (
        <p className="version-text">No timeline data found.</p>
      ) : (
        <div className="version-timeline">
          {version.timeline.map((entry, index) => (
            <div key={`${version.schema}-${index}`} className="version-entry">
              <div className="version-entry__top">
                <div>
                  <p className="version-entry__title">
                    {entry.version ?? entry.label}
                  </p>
                  <p className="version-entry__label">{entry.label}</p>
                </div>

                <span className={levelClass(entry.changeLevel)}>
                  {entry.changeLevel}
                </span>
              </div>

              <p className="version-entry__desc">
                {entry.description ?? "No description available."}
              </p>

              <p className="version-entry__meta">
                Applied at: {entry.appliedAt ?? "Unknown"} · Source:{" "}
                {entry.sourceTable}
              </p>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

export default async function VersionsPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const resolved = resolveCompareTargets();

  if (!resolved.ok) {
    return (
      <div className="db-layout">
        <Sidebar current="Version Detection" />

        <main className="db-main">
          <Topbar
            title="Version Detection"
            text="Check one schema's migration version history."
          />

          <div className="version-card">
            <h2 className="version-card__title">Configuration Error</h2>
            <p className="version-text">{resolved.error}</p>
          </div>
        </main>
      </div>
    );
  }

  const targets = [resolved.a, resolved.b];
  const selectedTarget = pickTarget(targets, params.target);
  const schemas = await fetchSchemaNames(selectedTarget.config);

  if (!schemas.ok) {
    return (
      <div className="db-layout">
        <Sidebar current="Version Detection" />

        <main className="db-main">
          <Topbar
            title="Version Detection"
            text="Check one schema's migration version history."
          />

          <section className="compare-card">
            <h2 className="compare-card__title">Select Schema</h2>
            <form className="compare-top">
              <select
                name="target"
                className="compare-select"
                defaultValue={selectedTarget.id}
              >
                {targets.map((target) => (
                  <option key={target.id} value={target.id}>
                    {targetLabel(target)}
                  </option>
                ))}
              </select>

              <button className="compare-btn compare-btn--primary" type="submit">
                Check Version
              </button>
            </form>
          </section>

          <div className="version-card">
            <h2 className="version-card__title">Could Not Load Schemas</h2>
            <p className="version-text">{schemas.error}</p>
          </div>
        </main>
      </div>
    );
  }

  const selectedSchema = pickSchema(schemas.data, params.schema);

  if (!selectedSchema) {
    return (
      <div className="db-layout">
        <Sidebar current="Version Detection" />

        <main className="db-main">
          <Topbar
            title="Version Detection"
            text="Check one schema's migration version history."
          />

          <section className="compare-card">
            <h2 className="compare-card__title">Select Schema</h2>
            <p className="compare-hint">
              No user schemas were found in {selectedTarget.displayName}.
            </p>
          </section>
        </main>
      </div>
    );
  }

  const version = await fetchSchemaVersionInfo(
    selectedTarget.config,
    selectedSchema
  );

  return (
    <div className="db-layout">
      <Sidebar current="Version Detection" />

      <main className="db-main">
        <Topbar
          title="Version Detection"
          text="Check one schema's migration version history."
        />

        <section className="compare-card">
          <h2 className="compare-card__title">Select Schema</h2>

          <form className="compare-top">
            <select
              name="target"
              className="compare-select"
              defaultValue={selectedTarget.id}
            >
              {targets.map((target) => (
                <option key={target.id} value={target.id}>
                  {targetLabel(target)}
                </option>
              ))}
            </select>

            <select
              name="schema"
              className="compare-select"
              defaultValue={selectedSchema}
            >
              {schemas.data.map((schema) => (
                <option key={schema} value={schema}>
                  {schema}
                </option>
              ))}
            </select>

            <button className="compare-btn compare-btn--primary" type="submit">
              Check Version
            </button>
          </form>
        </section>

        {renderVersionSummary(selectedTarget, version)}

        <div className="version-layout">
          <div className="version-layout__main">{renderTimeline(version)}</div>

          <aside className="version-layout__side">
            {renderStatusCard(version)}

            <section className="compare-report-block">
              <div className="compare-report-block__header">
                <div>
                  <h2 className="compare-report-block__title">How This Fits</h2>
                  <p className="compare-section-desc">
                    Schema comparison finds differences. SQL Scripts stores
                    approved migrations. Version detection tells the runner
                    what this one target schema has already applied.
                  </p>
                </div>
              </div>
            </section>
          </aside>
        </div>
      </main>
    </div>
  );
}
