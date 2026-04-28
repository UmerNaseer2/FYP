import Sidebar from "../../components/Sidebar";
import Topbar from "../../components/Topbar";
import {
  fetchSchemaSnapshot,
  resolveCompareTargets,
} from "../../lib/postgres";
import { compareSchemas } from "../../lib/compare";
import {
  determineNewerSchema,
  fetchSchemaVersionInfo,
  summarizeStructuralSeverity,
  type ChangeLevel,
  type VersionDetectionResult,
} from "../../lib/version-detection";

export const dynamic = "force-dynamic";

type PageProps = {
  searchParams: Promise<{
    left?: string;
    right?: string;
  }>;
};

const schemaOptions = [
  "ecom_v1",
  "ecom_v2",
  "hr_v1",
  "hr_v2",
  "uni_v1",
  "uni_v2",
];

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

function SchemaSelect({
  name,
  defaultValue,
}: {
  name: string;
  defaultValue: string;
}) {
  return (
    <select name={name} className="compare-select" defaultValue={defaultValue}>
      {schemaOptions.map((schema) => (
        <option key={`${name}-${schema}`} value={schema}>
          {schema}
        </option>
      ))}
    </select>
  );
}

function renderSchemaCard(title: string, version: VersionDetectionResult) {
  return (
    <div className="compare-schema-panel">
      <h4 className="compare-schema-panel__title">{title}</h4>

      <p>
        <strong>Schema:</strong> {version.schema}
      </p>

      <p>
        <strong>Version table:</strong> {version.tableName ?? "Not found"}
      </p>

      <p>
        <strong>Detected version:</strong> {version.detectedVersion ?? "N/A"}
      </p>

      <p>
        <strong>Mode:</strong>{" "}
        {version.hasVersionTable
          ? "Version-table comparison"
          : "Fallback structural comparison"}
      </p>

      <p className="version-text">{version.message}</p>
    </div>
  );
}

function renderTimeline(title: string, version: VersionDetectionResult) {
  return (
    <section className="version-card">
      <div className="compare-report-block__header">
        <h3 className="version-card__title">{title}</h3>

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
                <p className="version-entry__title">
                  {entry.version ?? entry.label}
                </p>

                <span className={levelClass(entry.changeLevel)}>
                  {entry.changeLevel}
                </span>
              </div>

              <p className="version-entry__desc">
                {entry.description ?? "No description available."}
              </p>

              <p className="version-entry__meta">
                Applied at: {entry.appliedAt ?? "Unknown"} • Source:{" "}
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

  const leftSchema = params.left ?? "ecom_v1";
  const rightSchema = params.right ?? "ecom_v2";

  const resolved = resolveCompareTargets();

  if (!resolved.ok) {
    return (
      <div className="db-layout">
        <Sidebar current="Version Detection" />

        <main className="db-main">
          <Topbar
            title="Version Detection"
            text="Check schema version and update status."
          />

          <div className="version-card">
            <h2 className="version-card__title">Configuration Error</h2>
            <p className="version-text">{resolved.error}</p>
          </div>
        </main>
      </div>
    );
  }

  const [leftVersion, rightVersion] = await Promise.all([
    fetchSchemaVersionInfo(resolved.a.config, leftSchema),
    fetchSchemaVersionInfo(resolved.b.config, rightSchema),
  ]);

  const newerInfo = determineNewerSchema(leftVersion, rightVersion);

  let fallbackLevel: ChangeLevel | null = null;
  let fallbackText: string | null = null;

  if (!leftVersion.hasVersionTable || !rightVersion.hasVersionTable) {
    const [leftSnapshot, rightSnapshot] = await Promise.all([
      fetchSchemaSnapshot(resolved.a.config, leftSchema),
      fetchSchemaSnapshot(resolved.b.config, rightSchema),
    ]);

    if (leftSnapshot.ok && rightSnapshot.ok) {
      const report = compareSchemas(leftSnapshot.data, rightSnapshot.data);
      const fallback = summarizeStructuralSeverity(report);

      fallbackLevel = fallback.level;
      fallbackText = fallback.summary;
    } else {
      fallbackLevel = "unknown";
      fallbackText = "Structural comparison could not run.";
    }
  }

  return (
    <div className="db-layout">
      <Sidebar current="Version Detection" />

      <main className="db-main">
        <Topbar
          title="Version Detection"
          text="Detect schema versions, compare newer schema, and show timeline."
        />

        <section className="compare-card">
          <h2 className="compare-card__title">Select Schemas</h2>

          <form className="compare-top">
            <SchemaSelect name="left" defaultValue={leftSchema} />
            <SchemaSelect name="right" defaultValue={rightSchema} />

            <button className="compare-btn compare-btn--primary" type="submit">
              Check Version
            </button>
          </form>
        </section>

        <section className="compare-report-block">
          <div className="compare-report-block__header">
            <div>
              <h2 className="compare-report-block__title">
                {leftSchema} vs {rightSchema}
              </h2>

              <p className="compare-section-desc">
                This checks whether each schema has a version control table.
                If version information is missing, the system uses structural
                comparison fallback.
              </p>
            </div>

            <span className="compare-pill compare-pill--neutral">
              Version check
            </span>
          </div>

          <div className="compare-schema-grid">
            {renderSchemaCard("Left Schema", leftVersion)}
            {renderSchemaCard("Right Schema", rightVersion)}
          </div>

          <div className="compare-note-card" style={{ marginTop: 16 }}>
            <h4 className="compare-note-card__title">Newer Schema Result</h4>
            <p className="compare-note-card__text">{newerInfo.reason}</p>
          </div>

          {fallbackText && fallbackLevel ? (
            <div className="compare-note-card" style={{ marginTop: 12 }}>
              <h4 className="compare-note-card__title">
                Fallback Structural Comparison
              </h4>

              <p className="compare-note-card__text">
                <span className={levelClass(fallbackLevel)}>
                  {fallbackLevel}
                </span>{" "}
                {fallbackText}
              </p>
            </div>
          ) : null}
        </section>

        <div className="compare-report-grid" style={{ marginTop: 20 }}>
          {renderTimeline(`Version Timeline — ${leftSchema}`, leftVersion)}
          {renderTimeline(`Version Timeline — ${rightSchema}`, rightVersion)}
        </div>
      </main>
    </div>
  );
}