import type { ClientConfig } from "pg";

import Sidebar from "../../components/Sidebar";
import Topbar from "../../components/Topbar";
import pool from "../../lib/version-db";
import { fetchSchemaNames } from "../../lib/postgres";
import {
  fetchSchemaVersionInfo,
  type ChangeLevel,
  type VersionDetectionResult,
} from "../../lib/version-detection";
import VersionSelector from "./VersionSelector";

export const dynamic = "force-dynamic";

type PageProps = {
  searchParams: Promise<{
    connection?: string;
    schemaA?: string;
    schemaB?: string;
  }>;
};

type SavedConnection = {
  id: number;
  name: string;
  host: string;
  port: number;
  database_name: string;
  type: string;
  username: string;
  password: string;
  connection_string?: string | null;
};

function toConfig(conn: SavedConnection): ClientConfig {
  if (conn.connection_string && conn.connection_string.trim() !== "") {
    return {
      connectionString: conn.connection_string.trim(),
    };
  }

  return {
    host: conn.host,
    port: Number(conn.port),
    database: conn.database_name,
    user: conn.username,
    password: conn.password,
  };
}

async function getConnections(): Promise<SavedConnection[]> {
  const result = await pool.query(`
    SELECT id, name, host, port, database_name, type, username, password, connection_string
    FROM connections
    WHERE type = 'PostgreSQL'
    ORDER BY id DESC
  `);

  return result.rows;
}

function pickSchema(
  schemas: string[],
  requested: string | undefined,
  fallbackIndex: number
) {
  if (requested && schemas.includes(requested)) return requested;
  return schemas[fallbackIndex] ?? schemas[0] ?? "";
}

function levelClass(level: ChangeLevel) {
  switch (level) {
    case "breaking":
      return "version-badge version-badge--breaking";
    case "additive":
      return "version-badge version-badge--additive";
    case "patch":
      return "version-badge version-badge--patch";
    default:
      return "version-badge version-badge--unknown";
  }
}

function compareVersions(a: VersionDetectionResult, b: VersionDetectionResult) {
  if (!a.hasVersionTable || !b.hasVersionTable) {
    return {
      statusClass: "version-result version-result--warning",
      title: "Fallback Structural Comparison Needed",
      message:
        "One or both schemas do not have a version table. Please use structural schema comparison instead.",
    };
  }

  if (a.comparableValue === null || b.comparableValue === null) {
    return {
      statusClass: "version-result version-result--warning",
      title: "Version Found, But Cannot Compare",
      message:
        "Both schemas have version information, but the version format cannot be compared clearly.",
    };
  }

  if (a.comparableValue > b.comparableValue) {
    return {
      statusClass: "version-result version-result--success",
      title: `${a.schema} is newer`,
      message: `${a.schema} version ${a.detectedVersion} is newer than ${b.schema} version ${b.detectedVersion}.`,
    };
  }

  if (b.comparableValue > a.comparableValue) {
    return {
      statusClass: "version-result version-result--success",
      title: `${b.schema} is newer`,
      message: `${b.schema} version ${b.detectedVersion} is newer than ${a.schema} version ${a.detectedVersion}.`,
    };
  }

  return {
    statusClass: "version-result version-result--info",
    title: "Both schemas have the same version",
    message: `Both schemas are at version ${a.detectedVersion}.`,
  };
}

function renderSummaryCard(title: string, version: VersionDetectionResult) {
  return (
    <div className="version-card">
      <p className="version-stat-label">{title}</p>
      <h3 className="version-stat-value">{version.schema}</h3>

      <p className="version-text">
        <strong>Version:</strong> {version.detectedVersion ?? "N/A"}
      </p>

      <p className="version-text">
        <strong>Table:</strong> {version.tableName ?? "Missing"}
      </p>

      <p className="version-text">
        <strong>Status:</strong>{" "}
        {version.hasVersionTable ? "Ready" : "Fallback needed"}
      </p>
    </div>
  );
}

function renderTimeline(title: string, version: VersionDetectionResult) {
  return (
    <section className="version-card">
      <div className="version-timeline-header">
        <div>
          <h3 className="version-card__title">{title}</h3>
          <p className="version-timeline-subtitle">
            Timeline is read from version tables such as script_patch.
          </p>
        </div>

        <span className="version-count-pill">{version.timeline.length}</span>
      </div>

      {version.timeline.length === 0 ? (
        <div className="version-empty">
          <p>No timeline data found.</p>
        </div>
      ) : (
        <div className="version-timeline">
          {version.timeline.map((entry, index) => (
            <div key={`${version.schema}-${index}`} className="version-entry">
              <div className="version-entry__line">
                <span className="version-entry__dot" />
              </div>

              <div className="version-entry__content">
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
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

export default async function VersionsPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const connections = await getConnections();

  if (connections.length === 0) {
    return (
      <div className="db-layout">
        <Sidebar current="Version Detection" />

        <main className="db-main">
          <Topbar
            title="Version Detection"
            text="Detect schema version information."
          />

          <section className="version-card">
            <h2 className="version-card__title">No Saved Connections</h2>
            <p className="version-text">
              Please add a PostgreSQL connection in the Connections page first.
            </p>
          </section>
        </main>
      </div>
    );
  }

  const selectedConnection =
    connections.find((conn) => String(conn.id) === params.connection) ??
    connections[0];

  const config = toConfig(selectedConnection);
  const schemas = await fetchSchemaNames(config);

  if (!schemas.ok) {
    return (
      <div className="db-layout">
        <Sidebar current="Version Detection" />

        <main className="db-main">
          <Topbar
            title="Version Detection"
            text="Detect schema version information."
          />

          <section className="version-card">
            <h2 className="version-card__title">Could Not Load Schemas</h2>
            <p className="version-text">{schemas.error}</p>
          </section>
        </main>
      </div>
    );
  }

  const schemaA = pickSchema(schemas.data, params.schemaA, 0);
  const schemaB = pickSchema(schemas.data, params.schemaB, 1);

  if (!schemaA || !schemaB) {
    return (
      <div className="db-layout">
        <Sidebar current="Version Detection" />

        <main className="db-main">
          <Topbar
            title="Version Detection"
            text="Detect schema version information."
          />

          <section className="version-card">
            <h2 className="version-card__title">Not Enough Schemas</h2>
            <p className="version-text">
              Please make sure this database has at least two user schemas.
            </p>
          </section>
        </main>
      </div>
    );
  }

  const versionA = await fetchSchemaVersionInfo(config, schemaA);
  const versionB = await fetchSchemaVersionInfo(config, schemaB);
  const comparison = compareVersions(versionA, versionB);

  return (
    <div className="db-layout">
      <Sidebar current="Version Detection" />

      <main className="db-main">
        <Topbar
          title="Version Detection"
          text="Detect version tables, compare schemas, and show timeline."
        />

        <section className="version-card">
          <h2 className="version-card__title">Select Connection and Schemas</h2>

          <VersionSelector
            connections={connections}
            schemas={schemas.data}
            selectedConnectionId={selectedConnection.id}
            schemaA={schemaA}
            schemaB={schemaB}
          />
        </section>

        <section className="version-card">
          <h2 className="version-card__title">Newer Schema Result</h2>

          <div className={comparison.statusClass}>
            <h3>{comparison.title}</h3>
            <p>{comparison.message}</p>
          </div>
        </section>

        <section className="version-summary-grid">
          {renderSummaryCard("Schema A", versionA)}
          {renderSummaryCard("Schema B", versionB)}

          <div className="version-card">
            <p className="version-stat-label">Connection</p>
            <h3 className="version-stat-value">{selectedConnection.name}</h3>
            <p className="version-text">
              {selectedConnection.host}:{selectedConnection.port}
            </p>
            <p className="version-text">
              <strong>Database:</strong> {selectedConnection.database_name}
            </p>
          </div>

          <div className="version-card">
            <p className="version-stat-label">Fallback</p>
            <h3 className="version-stat-value">
              {versionA.fallbackMode || versionB.fallbackMode ? "Needed" : "No"}
            </h3>
            <p className="version-text">
              If no version table exists, rely on structural comparison.
            </p>
          </div>
        </section>

        <div className="version-layout">
          <div className="version-layout__main">
            {renderTimeline("Schema A Timeline", versionA)}
          </div>

          <aside className="version-layout__side">
            {renderTimeline("Schema B Timeline", versionB)}
          </aside>
        </div>
      </main>
    </div>
  );
}