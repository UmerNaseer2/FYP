import Link from "next/link";
import { generateMigration, renderMigrationScript } from "@/lib/generate-sql";
import pool, { ensureConnectionsTable, ensureMetadataSchema } from "@/lib/version-db";
import { buildPgConfig } from "@/lib/connection-config";
import type { CompareTarget } from "@/lib/postgres";
import {
  fetchSchemaNames,
  fetchSchemaSnapshot,
  resolveCompareTargets,
} from "@/lib/postgres";
import { compareSchemas, type CompareReport } from "@/lib/compare";
import { findTrackedSchema, getNextLineageVersion } from "@/lib/lineage-db";
import { DiffReport, tallyDelta } from "@/components/studio/DiffReport";
import { MigrationWorkbench } from "@/components/studio/MigrationWorkbench";
import type { ChangeKind } from "@/components/studio/MigrationWorkbench";
import { EmptyState } from "@/components/ui/EmptyState";
import { CompareIcon, AlertTriangleIcon, ConnectionsIcon } from "@/components/ui/icons";

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
  ssl: boolean;
};

// ---------------------------------------------------------------------------
// Engine plumbing — unchanged from the legacy page. The compare itself (form-GET
// selection, env fallbacks, snapshot fetch, diff) is correctness-critical, so we
// reuse it verbatim and only swap the presentation underneath.
// ---------------------------------------------------------------------------

async function getSavedConnections(): Promise<SavedConnection[]> {
  try {
    // Shared DDL (lib/version-db) guarantees the `ssl` column exists.
    await ensureConnectionsTable();

    const result = await pool.query(`
      SELECT id, name, host, port, database_name, type, username, password, connection_string, ssl
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
  // Build the target config the same SSL/URI-aware way as every other
  // target-connecting route (Connections test, Deploy, Drift). This is what
  // lets hosted databases (Supabase, Neon, RDS) — which require SSL — actually
  // connect from Compare, instead of silently dropping the ssl flag.
  const config = buildPgConfig({
    host: connection.host,
    port: connection.port,
    database: connection.database_name,
    user: connection.username,
    password: connection.password,
    connectionString: connection.connection_string,
    ssl: connection.ssl,
  });

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

// ---------------------------------------------------------------------------
// Small presentational pieces
// ---------------------------------------------------------------------------

/** One LIVE source selector inside the source bar (connection + schema). */
function SourcePicker({
  side,
  connections,
  selectedConnectionId,
  schemaOptions,
  selectedSchema,
}: {
  side: "left" | "right";
  connections: SavedConnection[];
  selectedConnectionId: string;
  schemaOptions: string[];
  selectedSchema: string;
}) {
  const role = side === "left" ? "Source · desired" : "Target · updated";
  return (
    <div className="picker">
      <span className="kind live" title="Live PostgreSQL introspection">
        live
      </span>
      <div className="body">
        <span className="text-[10px]" style={{ color: "var(--text-3)" }}>
          {role}
        </span>
        <select
          name={`${side}Connection`}
          defaultValue={selectedConnectionId}
          className="picker-select"
          aria-label={`${side} connection`}
        >
          {connections.map((connection) => (
            <option key={`${side}-${connection.id}`} value={connection.id}>
              {connection.name} ({connection.database_name})
            </option>
          ))}
        </select>
        <select
          name={`${side}Schema`}
          defaultValue={selectedSchema}
          className="picker-select picker-select--sub"
          aria-label={`${side} schema`}
        >
          {schemaOptions.length === 0 ? (
            <option value={selectedSchema}>{selectedSchema}</option>
          ) : (
            schemaOptions.map((schema) => (
              <option key={`${side}-schema-${schema}`} value={schema}>
                {schema}
              </option>
            ))
          )}
        </select>
      </div>
    </div>
  );
}

function PageHeader() {
  return (
    <div className="mb-4">
      <div className="section-title mb-2">Compare &amp; Author</div>
      <h1 className="text-[28px] font-semibold tracking-[-0.018em]">
        Turn a diff into editable SQL.
      </h1>
      <p className="text-[13.5px] mt-1.5 max-w-[64ch]" style={{ color: "var(--text-2)" }}>
        Pick two live PostgreSQL sources and we&apos;ll surface the differences and
        generate the migration to bridge them. The generated SQL always updates the{" "}
        <b>right / target</b> schema to match the <b>left / source</b> schema — you can
        edit it freely before saving.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

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

  // No usable pair → friendly empty state pointing at Connections.
  if (!leftTarget || !rightTarget) {
    return (
      <EmptyState
        icon={<CompareIcon size={22} />}
        title="Add a couple of connections to compare"
        description={
          <>
            Schema comparison needs at least two saved PostgreSQL connections.
            {!resolved.ok ? (
              <span className="block mt-2" style={{ color: "var(--text-3)" }}>
                {resolved.error}
              </span>
            ) : null}
          </>
        }
        actions={
          <Link href="/connections" className="btn btn-primary btn-sm">
            <ConnectionsIcon size={14} />
            Go to Connections
          </Link>
        }
      />
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
  if (rightSchemaOptions.length > 0 && !rightSchemaOptions.includes(rightSchema)) {
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
          await ensureMetadataSchema();
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

  // Derive the migration + workbench inputs (only when we have a report).
  const script = report ? generateMigration(report) : null;
  const sqlText = script ? renderMigrationScript(script) : "";
  const breaking = script
    ? script.statements.filter((s) => s.severity === "breaking").length
    : 0;
  const safe = script
    ? script.statements.filter((s) => s.severity === "safe").length
    : 0;
  const info = script
    ? script.statements.filter((s) => s.severity === "info").length
    : 0;
  const overallKind: ChangeKind =
    breaking > 0 ? "breaking" : safe + info > 0 ? "additive" : "patch";

  // If the target (right) schema is tracked, derive the real next version for
  // each change level from its lineage HEAD. Null when it isn't tracked — the
  // workbench then shows an honest "track it" message instead of a number.
  let targetVersions:
    | { current: string | null; breaking: string; additive: string; patch: string }
    | null = null;
  if (report && script && rightConnection) {
    const head = await findTrackedSchema(rightConnection.id, rightSchema);
    if (head) {
      targetVersions = {
        current: head.headVersion,
        breaking: getNextLineageVersion(head.headVersion, "breaking"),
        additive: getNextLineageVersion(head.headVersion, "additive"),
        patch: getNextLineageVersion(head.headVersion, "patch"),
      };
    }
  }

  const delta = report ? tallyDelta(report) : null;

  return (
    <div className="px-8 py-8">
      <PageHeader />

      {/* Source selectors — plain form-GET, same selection model as before. */}
      <form action="/compare" className="source-bar">
        <input type="hidden" name="run" value="1" />
        <SourcePicker
          side="left"
          connections={savedConnections}
          selectedConnectionId={leftConnection?.id ? String(leftConnection.id) : ""}
          schemaOptions={leftSchemaOptions}
          selectedSchema={leftSchema}
        />
        <SourcePicker
          side="right"
          connections={savedConnections}
          selectedConnectionId={rightConnection?.id ? String(rightConnection.id) : ""}
          schemaOptions={rightSchemaOptions}
          selectedSchema={rightSchema}
        />
        <button type="submit" className="btn btn-primary self-center">
          <CompareIcon size={14} />
          Compare
        </button>
      </form>

      {/* Errors that blocked the compare */}
      {compareErrors.length > 0 && (
        <div className="warn-inline mt-4" style={{ flexDirection: "column", gap: 6 }}>
          <div className="flex items-center gap-2">
            <span className="ico">
              <AlertTriangleIcon size={14} />
            </span>
            <b>Unable to compare</b>
          </div>
          <ul className="space-y-1" style={{ paddingLeft: 22 }}>
            {compareErrors.map((error) => (
              <li key={error} className="text-[12.5px]" style={{ color: "var(--text-2)" }}>
                {error}
              </li>
            ))}
          </ul>
        </div>
      )}

      {report && delta && script ? (
        <>
          {/* Diff summary strip */}
          <div className="flex items-center gap-2 flex-wrap mt-6 mb-3">
            <span className="section-title">Diff</span>
            <span className="text-[13px]" style={{ color: "var(--text-2)" }}>
              <b>{delta.total}</b> change{delta.total === 1 ? "" : "s"} ·{" "}
              <b>
                {delta.tablesTouched} table{delta.tablesTouched === 1 ? "" : "s"}
              </b>
            </span>
            <span style={{ width: 1, height: 18, background: "var(--border)" }} className="mx-1" />
            <span className="delta delta-add" style={delta.adds ? undefined : { opacity: 0.5 }}>
              + {delta.adds}
            </span>
            <span className="delta delta-chg" style={delta.chgs ? undefined : { opacity: 0.5 }}>
              ~ {delta.chgs}
            </span>
            <span className="delta delta-rem" style={delta.rems ? undefined : { opacity: 0.5 }}>
              − {delta.rems}
            </span>
            <span className="ml-auto text-[12px]" style={{ color: "var(--text-3)" }}>
              comparing{" "}
              <span className="mono">
                {report.left.database}.{report.left.schema}
              </span>{" "}
              →{" "}
              <span className="mono">
                {report.right.database}.{report.right.schema}
              </span>
            </span>
          </div>

          {/* Two-column body: diff canvas (left) + migration draft (right, sticky) */}
          <div
            className="grid gap-6"
            style={{ gridTemplateColumns: "minmax(0, 1fr) 480px" }}
          >
            <DiffReport report={report} />
            <MigrationWorkbench
              initialSql={sqlText}
              statementCount={script.statements.length}
              suggestedName={`sync_${report.right.schema}_to_${report.left.schema}`
                .replace(/[^a-z0-9_]/gi, "_")
                .toLowerCase()}
              suggestedDescription={`Sync ${report.right.database}.${report.right.schema} to match ${report.left.database}.${report.left.schema}`}
              targetLabel={`${report.right.database}.${report.right.schema}`}
              targetSchema={report.right.schema}
              targetDatabase={rightConnection?.database_name ?? report.right.database}
              suggestedKind={overallKind}
              counts={{ breaking, safe, info }}
              warnings={script.warnings}
              targetVersions={targetVersions}
            />
          </div>
        </>
      ) : null}
    </div>
  );
}
