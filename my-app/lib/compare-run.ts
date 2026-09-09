// ---------------------------------------------------------------------------
// compare-run.ts
// Everything the Compare screen needs, computed on the server.
//
// This is the whole of that screen's database work in one place: read the saved
// connections and comparison sets, work out what the query string is asking to
// compare, list the schemas on each end, take the snapshots, diff them and
// generate the migration. The screen itself is a client component that asks
// POST /api/compare for the result and renders it — the page never opens a
// connection, and the credentials never leave this process.
//
// That last point is why the return value is a set of *view* types rather than
// the working types: a CompareTarget carries the host and password it connects
// with, and a payload the browser receives must not.
// ---------------------------------------------------------------------------

import {
  generateMigration,
  generateRollback,
  manualNoteCount,
  renderMigrationScript,
  renderRollbackScript,
  type SqlStatement,
} from "@/lib/generate-sql";
import pool, { syncMetadataTables } from "@/lib/version-db";
import { buildPgConfig } from "@/lib/connection-config";
import type { CompareTarget, SchemaSnapshot } from "@/lib/postgres";
import {
  fetchSchemaNames,
  fetchSchemaSnapshot,
  resolveCompareTargets,
  POOL_MAX,
} from "@/lib/postgres";
import { mapWithLimit } from "@/lib/concurrency";
import { compareSchemas, type CompareReport } from "@/lib/compare";
import { compareRowData, type DataCompareReport } from "@/lib/compare-data";
import {
  determineNewerSchema,
  fetchSchemaVersionInfo,
  type ChangeLevel,
  type VersionDetectionResult,
} from "@/lib/version-detection";
import {
  findTrackedSchemas,
  getNextLineageVersion,
  trackedSchemaKey,
  type TrackedSchemaHead,
} from "@/lib/lineage-db";
import {
  environmentRank,
  isProduction,
  louderEnvironment,
  toEnvironment,
  type Environment,
} from "@/lib/environments";
import { tallyDelta } from "@/components/studio/DiffReport";
import type { ChangeKind } from "@/components/studio/MigrationWorkbench";
import {
  listComparisonSets,
  markComparisonSetRun,
  MAX_COMPARISON_TARGETS,
  type ComparisonSet,
} from "@/lib/comparison-sets";
import type {
  ComparisonSetOption,
  CurrentSelection,
} from "@/components/studio/ComparisonSetBar";

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

/**
 * How many targets are compared at the same time.
 *
 * The arithmetic that matters: a target needs one connection to read its
 * schema, and two more — source and target — for the whole of a row-data
 * compare. Nothing says those are different databases. Comparing `public`
 * against five sibling schemas in one database is an ordinary thing to do, and
 * then every one of those connections comes out of the same pool of POOL_MAX.
 *
 * Six targets started together would ask that pool for twelve connections,
 * each holding the one it got while waiting for a second that no one is going
 * to release: a deadlock, and one that only appears on the runs with the most
 * work in them. Two at a time needs four of the six, which leaves headroom for
 * the drift check or the page load that happens to land mid-comparison.
 *
 * The cost is wall-clock on multi-target runs, and it is smaller than it
 * looks — the targets were contending for the same six connections either way.
 */
const COMPARE_TARGET_CONCURRENCY = Math.max(1, Math.floor(POOL_MAX / 3));

// ---------------------------------------------------------------------------
// What the screen receives. Every type below is safe to serialise to a browser:
// names and schemas, never a host, a user or a password.
// ---------------------------------------------------------------------------

/** A saved connection as the pickers show it. */
export type ConnectionView = {
  id: number;
  name: string;
  database_name: string;
  environment: string | null;
};

/** One target row in the picker bar. */
export type TargetSlotView = {
  index: number;
  connectionId: number | null;
  /** "Name (database)" — what the picker prints for a fixed .env target. */
  displayName: string;
  schema: string;
  schemaOptions: string[];
  environment: Environment;
};

/** The source row in the picker bar. */
export type SourceView = {
  connectionId: number | null;
  displayName: string;
  schema: string;
  schemaOptions: string[];
  environment: Environment;
  /**
   * What the source schema's own version table says. Null when the run never
   * got as far as reading it — an unreachable source, or a schema that is not
   * there — in which case `sourceError` is the thing to read.
   */
  detectedVersion: DetectedVersion | null;
};

/** One target's finished comparison, with the connection details removed. */
export type OutcomeView = Omit<TargetOutcome, "connection" | "target"> & {
  displayName: string;
  /**
   * The database this target lives in, so a generated script can be named
   * after it. The report already carries a database name, but a connection
   * whose URI names it differently is the one the reader recognises.
   */
  connectionDatabase: string | null;
};

/** The whole screen in one value. */
export type CompareScreen =
  | {
      kind: "no-connections";
      /** Why the .env fallback pair could not be used either, if it could not. */
      resolveError: string | null;
    }
  | {
      kind: "ready";
      connections: ConnectionView[];
      usingEnvFallback: boolean;
      canAddTarget: boolean;
      maxTargets: number;
      sets: ComparisonSetOption[];
      activeSetId: number | null;
      setModified: boolean;
      selection: CurrentSelection;
      source: SourceView;
      sourceError: string | null;
      targets: TargetSlotView[];
      outcomes: OutcomeView[];
      allowDataLoss: boolean;
      compareData: boolean;
    };

function toConnectionView(connection: SavedConnection): ConnectionView {
  return {
    id: connection.id,
    name: connection.name,
    database_name: connection.database_name,
    environment: connection.environment,
  };
}

function toOutcomeView(outcome: TargetOutcome): OutcomeView {
  // Pulled apart by name rather than spread-and-delete so a field added to
  // TargetOutcome later cannot reach the browser by accident.
  const { connection, target, ...rest } = outcome;
  return {
    ...rest,
    displayName: target.displayName,
    connectionDatabase: connection ? connection.database_name : null,
  };
}

/**
 * The query string in the shape the selection code below reads it: one value
 * for a parameter given once, an array for one given several times.
 *
 * The target pickers all share the field names `targetConnection` and
 * `targetSchema`, so "two targets" is spelled as the same parameter twice —
 * which is exactly what a browser sends for a form with two of each select.
 */
function toParams(
  query: URLSearchParams,
): Record<string, string | string[] | undefined> {
  const params: Record<string, string | string[] | undefined> = {};
  for (const key of new Set(query.keys())) {
    const all = query.getAll(key);
    params[key] = all.length > 1 ? all : all[0];
  }
  return params;
}

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
    await syncMetadataTables();

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

/**
 * How many timeline entries travel to the browser with each schema.
 *
 * The detector reads up to 200 rows so it can sort them and pick the latest;
 * the screen shows a handful for context. Sending all 200 for the source and
 * every target would be most of the page's weight for rows nobody scrolls to.
 */
const VERSION_TIMELINE_SHOWN = 5;

/**
 * What a schema's OWN version table says about itself.
 *
 * Not the same thing as the lineage this app keeps: this is read out of the
 * target database, from whatever it already uses — Flyway's
 * flyway_schema_history, Liquibase, a hand-rolled schema_version, our own
 * script_patch. A schema that tracks its versions somewhere is telling you
 * which side is ahead, and that is worth knowing before you generate a
 * migration for it.
 */
export type DetectedVersion = {
  /** Where the version was read from, or null when the schema has no such table. */
  table: string | null;
  /** The latest version the table records, as written there. */
  version: string | null;
  /** The most recent few entries, newest first. */
  recent: {
    version: string | null;
    label: string;
    appliedAt: string | null;
    changeLevel: ChangeLevel;
  }[];
  /** Which table was found, or why there is no answer. Shown as-is. */
  message: string;
};

/** Trim a full detection result down to what the screen renders. */
function toDetectedVersion(info: VersionDetectionResult): DetectedVersion {
  return {
    table: info.tableName,
    version: info.detectedVersion,
    recent: info.timeline.slice(0, VERSION_TIMELINE_SHOWN).map((entry) => ({
      version: entry.version,
      // The detector falls back to the version string for its label when the
      // table has no title column, which renders as the version printed twice.
      // Plenty of those tables do carry a description — use it instead.
      label:
        entry.label === entry.version
          ? (entry.description ?? entry.label)
          : entry.label,
      appliedAt: entry.appliedAt,
      changeLevel: entry.changeLevel,
    })),
    message: info.message,
  };
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
  /** What this schema's own version table says. Null when it could not be read. */
  detectedVersion: DetectedVersion | null;
  /**
   * Which side is further ahead by those detected versions, and why. "unknown"
   * whenever either side has no version to compare, which is the common case
   * and the reason the structural diff below is the real answer.
   */
  versionVerdict: { newer: "left" | "right" | "same" | "unknown"; reason: string } | null;
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
  source: {
    snapshot: SchemaSnapshot;
    config: CompareTarget["config"];
    schema: string;
    versionInfo: VersionDetectionResult;
  },
  slot: {
    index: number;
    connection: SavedConnection | null;
    target: CompareTarget;
    schema: string;
    schemaOptions: string[];
    schemaListError: string | null;
  },
  head: TrackedSchemaHead | null,
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
    detectedVersion: null,
    versionVerdict: null,
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

  // The lineage head — the schema's own environment label and its current
  // version — was resolved for every target in one query before this fan-out
  // started, so all that is left here is the target database itself.
  const snapshot = await fetchSchemaSnapshot(slot.target.config, slot.schema);

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

  // Feature 5: what does this schema say about its own version? Read AFTER the
  // snapshot rather than beside it — same database, and the snapshot already
  // holds a connection, so racing them would only ask the target for two at
  // once to save a few milliseconds.
  const versionInfo = await fetchSchemaVersionInfo(slot.target.config, slot.schema);
  const versionVerdict = determineNewerSchema(source.versionInfo, versionInfo);

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
    detectedVersion: toDetectedVersion(versionInfo),
    versionVerdict,
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

/**
 * Run one comparison and return everything the screen draws.
 *
 * `record` is what writes a row per compared pair into the comparison history,
 * and it is a parameter rather than a query flag on purpose: the screen used to
 * be a server component whose GET wrote those rows, so every reload and every
 * shared link recorded a run that nobody performed. Only the POST asks for it
 * now.
 */
export async function runComparison(
  query: URLSearchParams,
  record: boolean,
): Promise<CompareScreen> {
  const params = toParams(query);
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
    return { kind: "no-connections", resolveError: resolved.ok ? null : resolved.error };
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
  let sourceVersionInfo: VersionDetectionResult | null = null;
  if (!sourceError) {
    const snapshot = await fetchSchemaSnapshot(sourceTarget.config, sourceSchema);
    if (!snapshot.ok) {
      sourceError = `Could not load ${sourceTarget.displayName}.${sourceSchema}: ${snapshot.error}`;
    } else {
      // The source's own version table, once, for every target to compare
      // against. fetchSchemaVersionInfo never throws — a schema with no
      // version table is the ordinary case and comes back as fallbackMode.
      const srcVersion = await fetchSchemaVersionInfo(sourceTarget.config, sourceSchema);
      sourceVersionInfo = srcVersion;

      // Every target's lineage head in one round trip, before any target
      // database is opened. Asking per target meant a query to the metadata
      // database landing in the middle of another database's introspection
      // transaction — correct, but needlessly tangled, and N round trips for
      // what one query answers.
      const heads = await findTrackedSchemas(
        resolvedTargets.flatMap((slot) =>
          slot.connection
            ? [{ connectionId: slot.connection.id, schemaName: slot.schema }]
            : [],
        ),
      );

      outcomes = await mapWithLimit(
        resolvedTargets,
        COMPARE_TARGET_CONCURRENCY,
        (slot) =>
          compareOneTarget(
            {
              snapshot: snapshot.data,
              config: sourceTarget.config,
              schema: sourceSchema,
              versionInfo: srcVersion,
            },
            slot,
            slot.connection
              ? heads.get(trackedSchemaKey(slot.connection.id, slot.schema)) ?? null
              : null,
            allowDataLoss,
            compareData,
          ),
      );
    }
  }

  // The sets were read at the top of this render, before we knew whether the
  // comparison would work, so the stamp written below is not in them yet.
  let justRanAt: string | null = null;

  const comparedPairs = outcomes.filter((outcome) => outcome.report);
  if (record && comparedPairs.length > 0) {
    // A set nobody has run for months is usually a set pointing at a database
    // that no longer exists, so the picker shows when each one last ran.
    if (activeSet) justRanAt = await markComparisonSetRun(activeSet.id);
  }

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

  return {
    kind: "ready",
    connections: savedConnections.map(toConnectionView),
    usingEnvFallback,
    canAddTarget,
    maxTargets: MAX_TARGETS,
    sets: setOptions,
    activeSetId: activeSet ? activeSet.id : null,
    setModified: activeSet ? !matchesSet(activeSet, selection) : false,
    selection,
    source: {
      connectionId: sourceConnection ? sourceConnection.id : null,
      displayName: sourceTarget.displayName,
      schema: sourceSchema,
      schemaOptions: sourceSchemaInfo.options,
      environment: sourceEnvironment,
      detectedVersion: sourceVersionInfo ? toDetectedVersion(sourceVersionInfo) : null,
    },
    sourceError,
    targets: resolvedTargets.map((slot) => ({
      index: slot.index,
      connectionId: slot.connection ? slot.connection.id : null,
      displayName: slot.target.displayName,
      schema: slot.schema,
      schemaOptions: slot.schemaOptions,
      environment: toEnvironment(slot.connection?.environment),
    })),
    outcomes: outcomes.map(toOutcomeView),
    allowDataLoss,
    compareData,
  };
}
