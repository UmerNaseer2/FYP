import Link from "next/link";
import {
  generateMigration,
  generateRollback,
  manualNoteCount,
  renderMigrationScript,
  renderRollbackScript,
  type SqlStatement,
} from "@/lib/generate-sql";
import pool, { ensureConnectionsTable, ensureMetadataSchema } from "@/lib/version-db";
import { buildPgConfig } from "@/lib/connection-config";
import type { CompareTarget, SchemaSnapshot } from "@/lib/postgres";
import {
  fetchSchemaNames,
  fetchSchemaSnapshot,
  resolveCompareTargets,
} from "@/lib/postgres";
import { compareSchemas, type CompareReport } from "@/lib/compare";
import { compareRowData, type DataCompareReport } from "@/lib/compare-data";
import { findTrackedSchema, getNextLineageVersion } from "@/lib/lineage-db";
import {
  environmentRank,
  isProduction,
  louderEnvironment,
  toEnvironment,
  type Environment,
} from "@/lib/environments";
import { buildDiffDocument } from "@/lib/compare-export";
import { DiffReport, tallyDelta } from "@/components/studio/DiffReport";
import { ExportBar } from "@/components/studio/ExportBar";
import { SummaryMatrix } from "@/components/studio/SummaryMatrix";
import { DataCompare } from "@/components/studio/DataCompare";
import { MigrationWorkbench } from "@/components/studio/MigrationWorkbench";
import type { ChangeKind } from "@/components/studio/MigrationWorkbench";
import {
  listComparisonSets,
  markComparisonSetRun,
  MAX_COMPARISON_TARGETS,
  type ComparisonSet,
} from "@/lib/comparison-sets";
import {
  ComparisonSetBar,
  type ComparisonSetOption,
  type CurrentSelection,
} from "@/components/studio/ComparisonSetBar";
import { EmptyState } from "@/components/ui/EmptyState";
import { Select } from "@/components/ui/Select";
import { EnvironmentPill } from "@/components/ui/EnvironmentPill";
import {
  CompareIcon,
  AlertTriangleIcon,
  ConnectionsIcon,
  PlusIcon,
  XIcon,
} from "@/components/ui/icons";

export const dynamic = "force-dynamic";

/**
 * How many targets one comparison may hold.
 *
 * Not a technical limit — every target is one more schema introspection and one
 * more workbench on the page, and past half a dozen the screen stops being
 * readable long before the queries become slow. Saved comparison sets are the
 * answer to "I have twenty databases", not a taller page.
 *
 * The number itself lives in lib/comparison-sets because the save endpoint
 * enforces it too, and a limit only one of them knows about is not a limit.
 */
const MAX_TARGETS = MAX_COMPARISON_TARGETS;

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
  ssl_mode: string | null;
  environment: string | null;
};

// ---------------------------------------------------------------------------
// Engine plumbing. The compare itself (form-GET selection, env fallbacks,
// snapshot fetch, diff) is correctness-critical, so it is unchanged from the
// two-sided version — it simply runs once per target now instead of once.
// ---------------------------------------------------------------------------

async function getSavedConnections(): Promise<SavedConnection[]> {
  try {
    // Shared DDL (lib/version-db) guarantees the `ssl` and `environment`
    // columns exist.
    await ensureConnectionsTable();

    const result = await pool.query(`
      SELECT id, name, host, port, database_name, type, username, password,
             connection_string, ssl, ssl_mode, environment
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

/**
 * Saved comparison sets, or an empty list if the table cannot be read.
 *
 * Deliberately non-fatal: the sets are a convenience on top of the page, and a
 * metadata database that is briefly unhappy should cost you the shortcut, not
 * the ability to compare two schemas.
 */
async function getComparisonSets(): Promise<ComparisonSet[]> {
  try {
    return await listComparisonSets();
  } catch (error) {
    console.error("Failed to read comparison sets:", error);
    return [];
  }
}

/**
 * Does the selection on screen still match the set it was opened from?
 *
 * Used only to decide whether to say "changed since it was saved". Order
 * matters: a set is an ordered list of targets, and swapping target 1 and
 * target 2 swaps which migration appears first on the page.
 */
function matchesSet(set: ComparisonSet, selection: CurrentSelection): boolean {
  return (
    set.sourceConnectionId === selection.sourceConnectionId &&
    set.sourceSchema === selection.sourceSchema &&
    set.allowDataLoss === selection.allowDataLoss &&
    set.targets.length === selection.targets.length &&
    set.targets.every(
      (target, index) =>
        target.connectionId === selection.targets[index].connectionId &&
        target.schema === selection.targets[index].schema,
    )
  );
}

function buildTargetFromConnection(
  connection: SavedConnection,
  id: string,
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
    sslMode: connection.ssl_mode,
  });

  return {
    id,
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

/**
 * Every value of a repeated query parameter, in the order the form submitted
 * them. The target pickers all share one field name, so `?targetConnection=3
 * &targetConnection=7` is how "two targets" is spelled in the URL — and because
 * the connection and schema selects are rendered in step, index i of one list
 * always belongs with index i of the other.
 */
function pickList(value: string | string[] | undefined): string[] {
  if (typeof value === "string") {
    return value.trim().length > 0 ? [value.trim()] : [];
  }
  if (Array.isArray(value)) {
    return value.map((entry) => entry.trim());
  }
  return [];
}

/** One target's fully-resolved comparison, or the reason it could not run. */
type TargetOutcome = {
  /** Position in the form. Also what the "remove" button submits. */
  index: number;
  connection: SavedConnection | null;
  target: CompareTarget;
  schema: string;
  schemaOptions: string[];
  environment: Environment;
  /** Null when the target could not be read — `error` then says why. */
  report: CompareReport | null;
  /** Row-level comparison, or null when the run did not ask for one. */
  data: DataCompareReport | null;
  error: string | null;
  delta: ReturnType<typeof tallyDelta> | null;
  sqlText: string;
  rollbackText: string;
  rollbackStatementCount: number;
  rollbackCounts: { breaking: number; safe: number; info: number };
  rollbackWarnings: string[];
  statementCount: number;
  heldBackCount: number;
  /**
   * How many of those statements are MANUAL notes — comments describing work
   * no statement can do. Counted in statementCount, because they are in the
   * script and the reader has to see them, but they run nothing.
   */
  manualCount: number;
  rollbackManualCount: number;
  counts: { breaking: number; safe: number; info: number };
  overallKind: ChangeKind;
  warnings: string[];
  targetVersions:
    | { current: string | null; breaking: string; additive: string; patch: string }
    | null;
};

/**
 * Diff one target against the already-loaded source snapshot and derive
 * everything the report and the workbench need.
 *
 * The source snapshot is passed in rather than fetched here on purpose: it is
 * identical for every target, so reading it once and reusing it turns an N-way
 * compare into N+1 introspections instead of 2N.
 */
/**
 * Count a script's statements by severity.
 *
 * Shared by the migration and its rollback because the two do not grade alike —
 * a safe ADD COLUMN reverses into a breaking DROP COLUMN — and the workbench
 * needs a separate tally for each tab.
 */
function tallySeverities(statements: SqlStatement[]): {
  breaking: number;
  safe: number;
  info: number;
} {
  return {
    breaking: statements.filter((s) => s.severity === "breaking").length,
    safe: statements.filter((s) => s.severity === "safe").length,
    info: statements.filter((s) => s.severity === "info").length,
  };
}

async function compareOneTarget(
  source: { snapshot: SchemaSnapshot; config: CompareTarget["config"]; schema: string },
  slot: {
    index: number;
    connection: SavedConnection | null;
    target: CompareTarget;
    schema: string;
    schemaOptions: string[];
    schemaListError: string | null;
  },
  allowDataLoss: boolean,
  compareData: boolean,
): Promise<TargetOutcome> {
  const connectionEnvironment = toEnvironment(slot.connection?.environment);

  const empty = {
    index: slot.index,
    connection: slot.connection,
    target: slot.target,
    schema: slot.schema,
    schemaOptions: slot.schemaOptions,
    report: null,
    data: null,
    delta: null,
    sqlText: "",
    rollbackText: "",
    rollbackStatementCount: 0,
    rollbackCounts: { breaking: 0, safe: 0, info: 0 },
    rollbackWarnings: [] as string[],
    statementCount: 0,
    heldBackCount: 0,
    manualCount: 0,
    rollbackManualCount: 0,
    counts: { breaking: 0, safe: 0, info: 0 },
    overallKind: "patch" as ChangeKind,
    warnings: [] as string[],
    targetVersions: null,
  };

  if (slot.schemaListError) {
    // The driver message on its own ("connect ECONNREFUSED 127.0.0.1:5432") does
    // not say which of several targets it came from.
    return {
      ...empty,
      environment: connectionEnvironment,
      error: `Could not reach ${slot.target.displayName}: ${slot.schemaListError}`,
    };
  }
  if (slot.schemaOptions.length > 0 && !slot.schemaOptions.includes(slot.schema)) {
    return {
      ...empty,
      environment: connectionEnvironment,
      error: `Schema ${slot.schema} was not found in ${slot.target.displayName}.`,
    };
  }

  // The lineage head gives us both the schema's own environment label and the
  // next version number, so ask for it alongside the snapshot rather than after.
  const [snapshot, head] = await Promise.all([
    fetchSchemaSnapshot(slot.target.config, slot.schema),
    slot.connection
      ? findTrackedSchema(slot.connection.id, slot.schema)
      : Promise.resolve(null),
  ]);

  const environment = louderEnvironment(
    connectionEnvironment,
    head ? head.environment : "unset",
  );

  if (!snapshot.ok) {
    return {
      ...empty,
      environment,
      error: `Could not load ${slot.target.displayName}.${slot.schema}: ${snapshot.error}`,
    };
  }

  const report = compareSchemas(source.snapshot, snapshot.data);

  // Row data is read only when the form asks for it. Every other query on this
  // page reads catalog metadata; this one reads the tables themselves, which is
  // not something a page render should do to somebody's production database
  // because they happened to open a URL.
  const data = compareData
    ? await compareRowData(
        report,
        { config: source.config, schema: source.schema },
        { config: slot.target.config, schema: slot.schema },
      )
    : null;

  // Safe mode. DROP TABLE / DROP COLUMN are always generated so the diff can
  // show what a full sync would remove, but they are only armed in the rendered
  // SQL when the user explicitly ticks "allow data loss" on the form.
  const script = generateMigration(report, { allowDataLoss });
  // The down script that undoes the migration above. It is built from the same
  // flag so its header can say whether the drops it is "restoring" ever ran.
  const rollback = generateRollback(report, { allowDataLoss });

  const { breaking, safe, info } = tallySeverities(script.statements);

  return {
    ...empty,
    environment,
    error: null,
    report,
    data,
    delta: tallyDelta(report),
    sqlText: renderMigrationScript(script),
    rollbackText: renderRollbackScript(rollback),
    rollbackStatementCount: rollback.statements.length,
    rollbackCounts: tallySeverities(rollback.statements),
    rollbackWarnings: rollback.warnings,
    statementCount: script.statements.length,
    // Not destructiveCount: safe mode also holds back a matview rebuild, which
    // destroys nothing but does nothing either while the old view is there.
    heldBackCount: allowDataLoss ? 0 : script.heldBackCount,
    manualCount: manualNoteCount(script.statements),
    rollbackManualCount: manualNoteCount(rollback.statements),
    counts: { breaking, safe, info },
    overallKind: breaking > 0 ? "breaking" : safe + info > 0 ? "additive" : "patch",
    warnings: script.warnings,
    // When the target schema is tracked, derive the real next version for each
    // change level from its lineage HEAD. Null when it isn't tracked — the
    // workbench then shows an honest "track it" message instead of a number.
    targetVersions: head
      ? {
          current: head.headVersion,
          breaking: getNextLineageVersion(head.headVersion, "breaking"),
          additive: getNextLineageVersion(head.headVersion, "additive"),
          patch: getNextLineageVersion(head.headVersion, "patch"),
        }
      : null,
  };
}

// ---------------------------------------------------------------------------
// Small presentational pieces
// ---------------------------------------------------------------------------

/**
 * One LIVE selector (connection + schema) inside the picker bar.
 *
 * All the target pickers share the field names `targetConnection` and
 * `targetSchema`, so the browser submits them as two parallel lists — that is
 * what makes "add another target" work with a plain <form> and no JavaScript.
 */
function SlotPicker({
  role,
  fieldPrefix,
  connections,
  selectedConnectionId,
  fixedConnectionLabel,
  schemaOptions,
  selectedSchema,
  environment,
}: {
  role: string;
  fieldPrefix: "source" | "target";
  connections: SavedConnection[];
  selectedConnectionId: string;
  /** Shown instead of a picker when the target came from .env, not a connection. */
  fixedConnectionLabel?: string;
  schemaOptions: string[];
  selectedSchema: string;
  environment: Environment;
}) {
  return (
    <div className="picker">
      <span className="kind live" title="Live PostgreSQL introspection">
        live
      </span>
      <div className="body">
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-[10px]" style={{ color: "var(--text-3)" }}>
            {role}
          </span>
          <EnvironmentPill environment={environment} />
        </div>
        {fixedConnectionLabel ? (
          <span className="text-[13.5px] font-medium truncate" title={fixedConnectionLabel}>
            {fixedConnectionLabel}
          </span>
        ) : (
          <Select
            name={`${fieldPrefix}Connection`}
            value={selectedConnectionId}
            ariaLabel={`${role} connection`}
            placeholder="Select a connection"
            options={connections.map((connection) => ({
              value: String(connection.id),
              label: `${connection.name} (${connection.database_name})`,
            }))}
          />
        )}
        <Select
          name={`${fieldPrefix}Schema`}
          value={selectedSchema}
          ariaLabel={`${role} schema`}
          variant="sub"
          mono
          options={
            schemaOptions.length === 0
              ? [{ value: selectedSchema, label: selectedSchema }]
              : schemaOptions.map((schema) => ({ value: schema, label: schema }))
          }
        />
      </div>
    </div>
  );
}

function PageHeader({ targetCount }: { targetCount: number }) {
  return (
    <div className="mb-4">
      <div className="section-title mb-2">Compare &amp; Author</div>
      <h1 className="text-[28px] font-semibold tracking-[-0.018em]">
        Turn a diff into editable SQL.
      </h1>
      <p className="text-[13.5px] mt-1.5 max-w-[64ch]" style={{ color: "var(--text-2)" }}>
        Pick one <b>source</b> schema and compare it against{" "}
        {targetCount === 1 ? "a target." : `${targetCount} targets at once.`} Each
        target gets its own diff and its own migration, and every generated script
        updates <b>that target</b> to match the source — you can edit it freely
        before saving.
      </p>
    </div>
  );
}

/** The one-line "X of Y targets differ" bar above the per-target sections. */
function RunSummary({ outcomes }: { outcomes: TargetOutcome[] }) {
  const compared = outcomes.filter((o) => o.delta);
  const differing = compared.filter((o) => (o.delta?.total ?? 0) > 0).length;
  const inSync = compared.length - differing;
  const failed = outcomes.length - compared.length;
  const production = outcomes.filter((o) => isProduction(o.environment)).length;

  return (
    <div className="compare-header flex items-center gap-2 flex-wrap mt-6">
      <span className="section-title">Results</span>
      <span className="text-[13px]" style={{ color: "var(--text-2)" }}>
        <b>{outcomes.length}</b> target{outcomes.length === 1 ? "" : "s"}
      </span>
      <span style={{ width: 1, height: 18, background: "var(--border)" }} className="mx-1" />
      <span className="delta delta-chg" style={differing ? undefined : { opacity: 0.5 }}>
        {differing} differing
      </span>
      <span className="delta delta-add" style={inSync ? undefined : { opacity: 0.5 }}>
        {inSync} in sync
      </span>
      {failed > 0 && <span className="delta delta-rem">{failed} unreachable</span>}
      {production > 0 && (
        <span className="pill pill-break">
          {production} production
        </span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default async function ComparePage({ searchParams }: PageProps) {
  const params = await searchParams;
  const [savedConnections, savedSets] = await Promise.all([
    getSavedConnections(),
    getComparisonSets(),
  ]);
  const resolved = resolveCompareTargets();

  // With no saved connections at all we fall back to the .env pair, which is
  // fixed at one source and one target — there is nothing to add a target from.
  const envTargets = resolved.ok ? resolved.targets : [];
  const usingEnvFallback = savedConnections.length === 0 && envTargets.length >= 2;

  // Nothing to compare with: point at Connections rather than rendering an
  // empty form that cannot do anything.
  if (savedConnections.length === 0 && !usingEnvFallback) {
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

  // -------------------------------------------------------------------------
  // Selection. `source*` / `target*` are the current parameter names; the older
  // `left*` / `right*` pair is still honoured because every deep link into this
  // page from the dashboard, Drift and a schema's detail page uses it.
  // -------------------------------------------------------------------------
  const defaultConnectionId = savedConnections[0]?.id
    ? String(savedConnections[0].id)
    : "";

  // `?set=<id>` opens a saved comparison. It only seeds the pickers: the moment
  // the form is submitted the selects send real values, and those win. A set
  // that kept overriding them would make the page impossible to edit — you
  // would change a dropdown, press Compare, and watch it snap back.
  const activeSet =
    savedSets.find((set) => String(set.id) === pickValue(params.set, "")) ?? null;

  const requestedTargetConnections = pickList(
    params.targetConnection ?? params.rightConnection,
  );
  const requestedTargetSchemas = pickList(params.targetSchema ?? params.rightSchema);
  const hasExplicitTargets =
    requestedTargetConnections.length > 0 || requestedTargetSchemas.length > 0;

  const sourceConnectionId = pickValue(
    params.sourceConnection ?? params.leftConnection,
    activeSet?.sourceConnectionId
      ? String(activeSet.sourceConnectionId)
      : defaultConnectionId,
  );

  /**
   * What an unconfigured target falls back to — a fresh "Add target", or a slot
   * in a saved set whose connection has since been deleted.
   *
   * Ordered by environment, not alphabetically. This used to be "the second
   * connection by name", which on this very fixture data meant a blank target
   * silently landed on Production: a database nobody chose, sitting under a
   * generated migration. Production sorts last here, so it is only ever the
   * default when it is the only thing left to pick.
   *
   * The source is excluded because comparing a schema against itself produces
   * an empty diff and no useful migration. `sort` is stable, so connections in
   * the same environment keep the alphabetical order the picker shows.
   */
  const defaultTargetConnection = savedConnections
    .filter((connection) => String(connection.id) !== sourceConnectionId)
    .sort(
      (a, b) =>
        environmentRank(toEnvironment(a.environment)) -
        environmentRank(toEnvironment(b.environment)),
    )[0];
  const defaultTargetConnectionId = defaultTargetConnection
    ? String(defaultTargetConnection.id)
    : defaultConnectionId;

  // Pair the two lists by index. Length is taken from the longer of them: in
  // the .env fallback there is no connection picker to submit, so the schemas
  // arrive on their own and would otherwise be thrown away.
  const slotCount = Math.max(
    requestedTargetConnections.length,
    requestedTargetSchemas.length,
  );
  let slots = hasExplicitTargets
    ? Array.from({ length: slotCount }, (_, index) => ({
        connectionId: requestedTargetConnections[index] ?? "",
        schema: requestedTargetSchemas[index] ?? "",
      }))
    : (activeSet?.targets ?? []).map((target) => ({
        // A deleted connection leaves the slot blank, which falls through to
        // the default below — the set keeps its shape and the user picks a
        // replacement, instead of the target vanishing without explanation.
        connectionId: target.connectionId ? String(target.connectionId) : "",
        schema: target.schema,
      }));

  // "Remove" submits the index it sits on. The last target is never removable —
  // a comparison with no targets is not a comparison.
  const removeIndex = Number(pickValue(params.removeTarget, "-1"));
  if (
    slots.length > 1 &&
    Number.isInteger(removeIndex) &&
    removeIndex >= 0 &&
    removeIndex < slots.length
  ) {
    slots = slots.filter((_, index) => index !== removeIndex);
  }

  // "Add target" appends an unconfigured slot, which then falls back to the
  // default connection and that connection's first schema.
  if (pickValue(params.addTarget, "") === "1" && slots.length < MAX_TARGETS) {
    slots.push({ connectionId: "", schema: "" });
  }

  if (slots.length === 0) {
    slots = [{ connectionId: "", schema: "" }];
  }
  slots = slots.slice(0, MAX_TARGETS);

  const findConnection = (id: string) =>
    savedConnections.find((connection) => String(connection.id) === id) ?? null;

  const sourceConnection = usingEnvFallback
    ? null
    : findConnection(sourceConnectionId) ?? savedConnections[0] ?? null;

  const sourceTarget: CompareTarget = sourceConnection
    ? buildTargetFromConnection(sourceConnection, "source")
    : envTargets[0];

  const targetSlots = slots.map((slot, index) => {
    const connection = usingEnvFallback
      ? null
      : findConnection(slot.connectionId) ??
        findConnection(defaultTargetConnectionId) ??
        savedConnections[0] ??
        null;
    return {
      index,
      connection,
      requestedSchema: slot.schema,
      target: connection
        ? buildTargetFromConnection(connection, `target-${index}`)
        : envTargets[1],
    };
  });

  // -------------------------------------------------------------------------
  // Schema lists. Two targets on the same connection ask the same question, so
  // look each distinct database up once and share the answer.
  // -------------------------------------------------------------------------
  const configsByKey = new Map<string, CompareTarget>();
  const keyFor = (connection: SavedConnection | null, target: CompareTarget) =>
    connection ? `conn:${connection.id}` : `env:${target.id}`;

  configsByKey.set(keyFor(sourceConnection, sourceTarget), sourceTarget);
  for (const slot of targetSlots) {
    configsByKey.set(keyFor(slot.connection, slot.target), slot.target);
  }

  const keys = [...configsByKey.keys()];
  const schemaResults = await Promise.all(
    keys.map((key) => fetchSchemaNames(configsByKey.get(key)!.config)),
  );
  const schemaLists = new Map(keys.map((key, i) => [key, schemaResults[i]]));

  function schemasFor(connection: SavedConnection | null, target: CompareTarget) {
    const result = schemaLists.get(keyFor(connection, target));
    if (!result) return { options: [] as string[], error: null as string | null };
    return result.ok
      ? { options: result.data, error: null }
      : { options: [] as string[], error: result.error };
  }

  /** Prefer what was asked for, then the configured default, then whatever exists. */
  function resolveSchema(
    requested: string,
    options: string[],
    envName: string,
  ): string {
    if (requested.length > 0) return requested;
    const preferred = envValue(envName, "public");
    return options.find((schema) => schema === preferred) ?? options[0] ?? preferred;
  }

  const sourceSchemaInfo = schemasFor(sourceConnection, sourceTarget);
  const sourceSchema = resolveSchema(
    pickValue(params.sourceSchema ?? params.leftSchema, activeSet?.sourceSchema ?? ""),
    sourceSchemaInfo.options,
    "COMPARE_SCHEMA_A",
  );
  const sourceEnvironment = toEnvironment(sourceConnection?.environment);

  const resolvedTargets = targetSlots.map((slot) => {
    const info = schemasFor(slot.connection, slot.target);
    return {
      ...slot,
      schemaOptions: info.options,
      schemaListError: info.error,
      schema: resolveSchema(slot.requestedSchema, info.options, "COMPARE_SCHEMA_B"),
    };
  });

  // -------------------------------------------------------------------------
  // The compare itself. One source snapshot, then every target in parallel —
  // a slow or unreachable target holds up only its own section.
  // -------------------------------------------------------------------------
  // An unticked checkbox submits nothing, so "absent" cannot be told apart from
  // "never submitted". The same rule as the targets settles it: while the
  // selection is still the set's, so is this; once the form has been submitted
  // the checkbox is authoritative.
  const allowDataLoss =
    activeSet && !hasExplicitTargets
      ? activeSet.allowDataLoss
      : pickValue(params.allowDataLoss, "") === "1";

  // Row comparison is per-run and never remembered in a saved set: reading a
  // production table is a decision worth taking again each time, not one a set
  // loaded from a dropdown can make on the reader's behalf.
  const compareData = pickValue(params.compareData, "") === "1";

  let sourceError: string | null = sourceSchemaInfo.error
    ? `Could not reach ${sourceTarget.displayName}: ${sourceSchemaInfo.error}`
    : null;
  if (
    !sourceError &&
    sourceSchemaInfo.options.length > 0 &&
    !sourceSchemaInfo.options.includes(sourceSchema)
  ) {
    sourceError = `Schema ${sourceSchema} was not found in ${sourceTarget.displayName}.`;
  }

  let outcomes: TargetOutcome[] = [];
  if (!sourceError) {
    const snapshot = await fetchSchemaSnapshot(sourceTarget.config, sourceSchema);
    if (!snapshot.ok) {
      sourceError = `Could not load ${sourceTarget.displayName}.${sourceSchema}: ${snapshot.error}`;
    } else {
      outcomes = await Promise.all(
        resolvedTargets.map((slot) =>
          compareOneTarget(
            {
              snapshot: snapshot.data,
              config: sourceTarget.config,
              schema: sourceSchema,
            },
            slot,
            allowDataLoss,
            compareData,
          ),
        ),
      );
    }
  }

  // The sets were read at the top of this render, before we knew whether the
  // comparison would work, so the stamp written below is not in them yet.
  let justRanAt: string | null = null;

  // Comparison history. One row per target, so a three-target run leaves three
  // entries rather than pretending it was a single two-sided compare.
  const comparedPairs = outcomes.filter((outcome) => outcome.report);
  if (pickValue(params.run, "") === "1" && comparedPairs.length > 0) {
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

      const left = `${sourceTarget.displayName}.${sourceSchema}`;
      await Promise.all(
        comparedPairs.map((outcome) =>
          pool.query(
            `INSERT INTO schema_comparisons (schema_a, schema_b) VALUES ($1, $2)`,
            [left, `${outcome.target.displayName}.${outcome.schema}`],
          ),
        ),
      );
    } catch (error) {
      console.error("Failed to save comparison history:", error);
    }

    // A set nobody has run for months is usually a set pointing at a database
    // that no longer exists, so the picker shows when each one last ran.
    if (activeSet) justRanAt = await markComparisonSetRun(activeSet.id);
  }

  const productionTargets = outcomes.filter((outcome) =>
    isProduction(outcome.environment),
  );
  const canAddTarget = !usingEnvFallback && resolvedTargets.length < MAX_TARGETS;

  // What the Save button would write: exactly what is on screen right now.
  const selection: CurrentSelection = {
    sourceConnectionId: sourceConnection ? sourceConnection.id : null,
    sourceConnectionLabel: sourceTarget.displayName,
    sourceSchema,
    allowDataLoss,
    targets: resolvedTargets.map((slot) => ({
      connectionId: slot.connection ? slot.connection.id : null,
      connectionLabel: slot.target.displayName,
      schema: slot.schema,
    })),
  };

  const setOptions: ComparisonSetOption[] = savedSets.map((set) => ({
    id: set.id,
    name: set.name,
    targetCount: set.targets.length,
    hasProduction: set.targets.some((target) => isProduction(target.environment)),
    hasMissingConnection:
      set.sourceConnectionId === null ||
      set.targets.some((target) => target.connectionId === null),
    lastRunAt: set.id === activeSet?.id && justRanAt ? justRanAt : set.lastRunAt,
  }));

  return (
    <div className="px-4 sm:px-8 py-6 sm:py-8">
      <PageHeader targetCount={resolvedTargets.length} />

      {/* Saved sets sit above the pickers because they change what the pickers
          show. Its own island, not part of the form below — saving writes to
          the database, and this page's form is a GET that has to stay safe to
          reload and share. */}
      <ComparisonSetBar
        sets={setOptions}
        activeSetId={activeSet ? activeSet.id : null}
        modified={activeSet ? !matchesSet(activeSet, selection) : false}
        selection={selection}
        canSave={!usingEnvFallback}
      />

      {/* Selection — plain form-GET. The target pickers repeat one pair of field
          names, so the browser submits them as parallel lists and "add target"
          needs no client state at all. */}
      <form action="/compare" className="source-bar">
        <input type="hidden" name="run" value="1" />
        {/* Carried through every submit so the bar still knows which set is
            open after you add a target or press Compare. */}
        {activeSet && <input type="hidden" name="set" value={String(activeSet.id)} />}

        <div className="source-bar__group">
          <div className="source-bar__label">Source · the schema you want</div>
          <div className="source-bar__slot">
            <SlotPicker
              role="Source · desired"
              fieldPrefix="source"
              connections={savedConnections}
              selectedConnectionId={
                sourceConnection ? String(sourceConnection.id) : ""
              }
              fixedConnectionLabel={
                usingEnvFallback ? sourceTarget.displayName : undefined
              }
              schemaOptions={sourceSchemaInfo.options}
              selectedSchema={sourceSchema}
              environment={sourceEnvironment}
            />
          </div>
        </div>

        <div className="source-bar__group">
          <div className="source-bar__label">
            {resolvedTargets.length === 1
              ? "Target · the schema that gets updated"
              : `${resolvedTargets.length} targets · each gets its own migration`}
          </div>
          <div className="source-bar__grid">
            {resolvedTargets.map((slot, index) => (
              <div className="source-bar__slot" key={`target-${index}`}>
                <SlotPicker
                  role={
                    resolvedTargets.length === 1
                      ? "Target · updated"
                      : `Target ${index + 1} · updated`
                  }
                  fieldPrefix="target"
                  connections={savedConnections}
                  selectedConnectionId={
                    slot.connection ? String(slot.connection.id) : ""
                  }
                  fixedConnectionLabel={
                    usingEnvFallback ? slot.target.displayName : undefined
                  }
                  schemaOptions={slot.schemaOptions}
                  selectedSchema={slot.schema}
                  environment={
                    outcomes[index]?.environment ??
                    toEnvironment(slot.connection?.environment)
                  }
                />
                {resolvedTargets.length > 1 && (
                  <button
                    type="submit"
                    name="removeTarget"
                    value={String(index)}
                    className="btn btn-ghost btn-icon self-start"
                    title={`Remove target ${index + 1}`}
                    aria-label={`Remove target ${index + 1}`}
                  >
                    <XIcon size={14} />
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>

        <div className="source-bar__actions">
          {canAddTarget ? (
            <button type="submit" name="addTarget" value="1" className="btn btn-ghost btn-sm">
              <PlusIcon size={14} />
              Add target
            </button>
          ) : !usingEnvFallback ? (
            <span className="text-[12px]" style={{ color: "var(--text-3)" }}>
              {MAX_TARGETS} targets is the maximum for one comparison.
            </span>
          ) : null}
          <label
            className="flex items-center gap-2 text-[12.5px] cursor-pointer"
            style={{ color: "var(--text-2)" }}
            title="DROP TABLE and DROP COLUMN are commented out unless this is ticked."
          >
            <input
              type="checkbox"
              name="allowDataLoss"
              value="1"
              defaultChecked={allowDataLoss}
            />
            Allow data loss
          </label>
          <label
            className="flex items-center gap-2 text-[12.5px] cursor-pointer"
            style={{ color: "var(--text-2)" }}
            title="Also read the rows of every table and report which ones differ. Slower, and it reads table data rather than just the catalog."
          >
            <input
              type="checkbox"
              name="compareData"
              value="1"
              defaultChecked={compareData}
            />
            Compare row data
          </label>
          <span className="source-bar__spacer" />
          <button type="submit" className="btn btn-primary">
            <CompareIcon size={14} />
            Compare
          </button>
        </div>
      </form>

      {/* A production target is worth saying once at the top, before the reader
          scrolls into a workbench with a "push to registry" button in it. */}
      {productionTargets.length > 0 && (
        <div className="warn-inline mt-4">
          <span className="ico">
            <AlertTriangleIcon size={14} />
          </span>
          <span>
            <b>
              {productionTargets.length === 1
                ? "One target is production"
                : `${productionTargets.length} targets are production`}
              :
            </b>{" "}
            {productionTargets
              .map((outcome) => `${outcome.target.displayName}.${outcome.schema}`)
              .join(", ")}
            . Read the generated SQL before you push it — on production a dropped
            column is not recoverable from this app.
          </span>
        </div>
      )}

      {/* A source we cannot read blocks every target, so it is reported once. */}
      {sourceError && (
        <div className="warn-inline mt-4" style={{ flexDirection: "column", gap: 6 }}>
          <div className="flex items-center gap-2">
            <span className="ico">
              <AlertTriangleIcon size={14} />
            </span>
            <b>Unable to read the source schema</b>
          </div>
          <p className="text-[12.5px]" style={{ color: "var(--text-2)", paddingLeft: 22 }}>
            {sourceError}
          </p>
        </div>
      )}

      {outcomes.length > 1 && <RunSummary outcomes={outcomes} />}

      {outcomes.map((outcome) => (
        <section key={`outcome-${outcome.index}`} className="mt-6">
          {/* Per-target header: what is being compared, and how much differs. */}
          <div className="compare-header flex items-center gap-2 flex-wrap mb-3">
            <span className="section-title">
              {outcomes.length === 1 ? "Diff" : `Target ${outcome.index + 1}`}
            </span>
            <EnvironmentPill environment={outcome.environment} />
            {outcome.delta ? (
              <>
                <span className="text-[13px]" style={{ color: "var(--text-2)" }}>
                  <b>{outcome.delta.total}</b> change
                  {outcome.delta.total === 1 ? "" : "s"} ·{" "}
                  <b>
                    {outcome.delta.tablesTouched} table
                    {outcome.delta.tablesTouched === 1 ? "" : "s"}
                  </b>
                </span>
                <span
                  style={{ width: 1, height: 18, background: "var(--border)" }}
                  className="mx-1"
                />
                <span
                  className="delta delta-add"
                  style={outcome.delta.adds ? undefined : { opacity: 0.5 }}
                >
                  + {outcome.delta.adds}
                </span>
                <span
                  className="delta delta-chg"
                  style={outcome.delta.chgs ? undefined : { opacity: 0.5 }}
                >
                  ~ {outcome.delta.chgs}
                </span>
                <span
                  className="delta delta-rem"
                  style={outcome.delta.rems ? undefined : { opacity: 0.5 }}
                >
                  − {outcome.delta.rems}
                </span>
              </>
            ) : null}
            <span className="ml-auto text-[12px]" style={{ color: "var(--text-3)" }}>
              <span className="mono">
                {sourceTarget.displayName}.{sourceSchema}
              </span>{" "}
              →{" "}
              <span className="mono">
                {outcome.target.displayName}.{outcome.schema}
              </span>
            </span>
          </div>

          {outcome.error ? (
            <div className="warn-inline">
              <span className="ico">
                <AlertTriangleIcon size={14} />
              </span>
              <span>{outcome.error}</span>
            </div>
          ) : outcome.report ? (
            <>
              {isProduction(outcome.environment) && (
                <div className="warn-inline mb-3">
                  <span className="ico">
                    <AlertTriangleIcon size={14} />
                  </span>
                  <span>
                    <b>This target is production.</b> The migration below rewrites{" "}
                    <span className="mono">
                      {outcome.target.displayName}.{outcome.schema}
                    </span>
                    {outcome.counts.breaking > 0
                      ? ` and contains ${outcome.counts.breaking} breaking statement${
                          outcome.counts.breaking === 1 ? "" : "s"
                        }.`
                      : "."}
                  </span>
                </div>
              )}

              {/* Two-column body: diff canvas (left) + migration draft (right,
                  sticky). Stacks under 980px via the .compare-layout rule. */}
              <div className="compare-layout">
                <div className="space-y-3">
                  {/* Built on the server: the export has to grade every change
                      with the same functions the canvas below grades them
                      with, and those live in the compare engine. */}
                  <ExportBar doc={buildDiffDocument(outcome.report, outcome.data)} />
                  {/* The board first, then the narrative. The diff below only
                      shows what changed, so it cannot say "nothing happened to
                      your views" — this can, and it is the answer people scroll
                      the whole page looking for. */}
                  <SummaryMatrix report={outcome.report} />
                  <DiffReport report={outcome.report} allowDataLoss={allowDataLoss} />
                  {outcome.data && <DataCompare result={outcome.data} />}
                </div>
                <MigrationWorkbench
                  initialSql={outcome.sqlText}
                  statementCount={outcome.statementCount}
                  heldBackCount={outcome.heldBackCount}
                  manualCount={outcome.manualCount}
                  rollbackManualCount={outcome.rollbackManualCount}
                  initialRollbackSql={outcome.rollbackText}
                  rollbackStatementCount={outcome.rollbackStatementCount}
                  rollbackCounts={outcome.rollbackCounts}
                  rollbackWarnings={outcome.rollbackWarnings}
                  // Named after both ends, not just the schemas: with several
                  // targets on one page they are usually all called "public",
                  // and three drafts called sync_public_to_public would be
                  // impossible to tell apart in the registry or in review.
                  suggestedName={`sync_${outcome.report.right.database}_${outcome.report.right.schema}_from_${outcome.report.left.database}_${outcome.report.left.schema}`
                    .replace(/[^a-z0-9_]/gi, "_")
                    .toLowerCase()}
                  suggestedDescription={`Sync ${outcome.report.right.database}.${outcome.report.right.schema} to match ${outcome.report.left.database}.${outcome.report.left.schema}`}
                  targetLabel={`${outcome.report.right.database}.${outcome.report.right.schema}`}
                  targetSchema={outcome.report.right.schema}
                  targetDatabase={
                    outcome.connection?.database_name ?? outcome.report.right.database
                  }
                  suggestedKind={outcome.overallKind}
                  counts={outcome.counts}
                  warnings={outcome.warnings}
                  targetVersions={outcome.targetVersions}
                />
              </div>
            </>
          ) : null}
        </section>
      ))}
    </div>
  );
}
