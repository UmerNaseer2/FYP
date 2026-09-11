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
  migrationChangeLevel,
  renderMigrationScript,
  renderRollbackScript,
  type SqlStatement,
} from "@/lib/generate-sql";
import pool, { syncMetadataTables } from "@/lib/version-db";
import { buildPgConfig } from "@/lib/connection-config";
import type { CompareTarget, SchemaSnapshot } from "@/lib/postgres";
import { fetchSchemaNames, fetchSchemaSnapshot, POOL_MAX } from "@/lib/postgres";
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
  type ComparisonSet,
} from "@/lib/comparison-sets";
import { matchesSet, MAX_COMPARISON_TARGETS } from "@/lib/comparison-set-rules";
import {
  databaseIdentity,
  findDuplicateTargets,
  missingConnectionMessage,
  missingSourceMessage,
  type CurrentSelection,
} from "@/lib/compare-selection";
import type { ComparisonSetOption } from "@/components/studio/ComparisonSetBar";

/**
 * How many targets one comparison may hold.
 *
 * Not a technical limit — every target is one more schema introspection and one
 * more workbench on the page, and past half a dozen the screen stops being
 * readable long before the queries become slow. Saved comparison sets are the
 * answer to "I have twenty databases", not a taller page.
 *
 * The number itself lives in lib/comparison-set-rules because the save
 * endpoint enforces it too, and a limit only one of them knows about is not a
 * limit.
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
  /** Null when this target has no saved connection — never picked, or deleted. */
  connectionId: number | null;
  /**
   * "Name (database)", or — for a connection that has been deleted — the name
   * a saved set remembers for it, so the reader can tell which one is gone.
   */
  displayName: string;
  schema: string;
  schemaOptions: string[];
  environment: Environment;
  /** Why this target has no connection to read, or null when it has one. */
  missingMessage: string | null;
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
  /**
   * Why the source has no connection to read — never picked, or deleted since
   * a saved set was made — or null when it has one. Nothing is compared while
   * this is set: a stand-in database compared under the source's name would be
   * a result for a pair nobody chose.
   */
  missingMessage: string | null;
};

/** One target's finished comparison, with the connection details removed. */
export type OutcomeView = Omit<TargetOutcome, "connection"> & {
  /**
   * The database this target lives in, so a generated script can be named
   * after it. The report already carries a database name, but a connection
   * whose URI names it differently is the one the reader recognises.
   */
  connectionDatabase: string | null;
};

/** The whole screen in one value. */
export type CompareScreen =
  | { kind: "no-connections" }
  | {
      kind: "ready";
      connections: ConnectionView[];
      canAddTarget: boolean;
      maxTargets: number;
      sets: ComparisonSetOption[];
      activeSetId: number | null;
      /**
       * The URL named a saved set that no longer exists. Nothing is run — the
       * link promised that set, and the default pickers are not it.
       */
      setNotFound: boolean;
      setModified: boolean;
      selection: CurrentSelection;
      source: SourceView;
      sourceError: string | null;
      targets: TargetSlotView[];
      outcomes: OutcomeView[];
      allowDataLoss: boolean;
      compareData: boolean;
      /**
       * Whether somebody actually asked for this comparison: `run=1`, which
       * the Compare button, a saved set and the links from the dashboard,
       * Drift and a schema's page all send. False on a bare /compare and after
       * Add target or Remove — the pickers changed, nobody pressed Compare,
       * and `outcomes` is deliberately empty.
       */
      asked: boolean;
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
  // The saved connection carries the host, user and password, so it is taken
  // out by name before anything is sent. Everything else in TargetOutcome
  // travels to the browser — keep credentials out of it.
  const { connection, ...rest } = outcome;
  return {
    ...rest,
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
// Engine plumbing: the saved connections and sets this screen reads, and the
// small helpers that turn a saved connection and a query string into
// something the comparison below can use.
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
    // Not swallowed. An empty list here would tell the reader to go and add a
    // connection they already have; failing says what is actually wrong.
    console.error("Failed to load saved connections:", error);
    throw error;
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
 *
 * An empty value is kept, not dropped: `targetConnection=` is how the form
 * spells "this target has no connection", and dropping it would shift every
 * later target onto the wrong schema.
 */
function paramList(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  return (Array.isArray(value) ? value : [value]).map((entry) => entry.trim());
}

/**
 * The first value of a parameter, "" when it is present but empty, and
 * undefined only when it is absent. Unlike pickValue, "present but empty" is
 * an answer: the source picker sends it when no connection is picked, and
 * filling that in with a default would compare a database nobody chose.
 */
function firstParam(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  return (Array.isArray(value) ? (value[0] ?? "") : value).trim();
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
  /** "Name (database)", or the remembered name of a deleted connection. */
  displayName: string;
  schema: string;
  schemaOptions: string[];
  environment: Environment;
  /**
   * The target names the same database AND the same schema as the source.
   * "Same database" is the same host, port and database name — not the same
   * saved entry, since two entries for one database are still one database.
   *
   * Comparing a schema with itself always answers "identical", and rendering
   * that as a report — 0 changes, 0 tables, everything in sync — reads as a
   * finding about two databases. It is not one; it is the question not having
   * been asked yet. The screen says so instead, and no snapshot is taken.
   */
  sameAsSource: boolean;
  /** Null when the target could not be read — `error` then says why. */
  report: CompareReport | null;
  /** Row-level comparison, or null when the run did not ask for one. */
  data: DataCompareReport | null;
  error: string | null;
  /**
   * Why there is no report, when there is none.
   *
   * `delta === null` used to be the only signal, and the summary bar counted
   * every one of them as "unreachable" — including a server that answered
   * perfectly well and simply has no schema by that name, and including a
   * target compared with itself, which was never dialled at all.
   *
   * "duplicate" is a target that repeats an earlier one, and "no-connection"
   * one whose saved connection is gone or was never picked. Neither is dialled.
   */
  failure: "unreachable" | "schema-missing" | "duplicate" | "no-connection" | null;
  /**
   * The index of the earlier target this one repeats — same database, same
   * schema — or null. Its report would be a copy of that one's.
   */
  duplicateOf: number | null;
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

/**
 * Diff one target against the already-loaded source snapshot and derive
 * everything the report and the workbench need.
 *
 * The source snapshot is passed in rather than fetched here on purpose: it is
 * identical for every target, so reading it once and reusing it turns an N-way
 * compare into N+1 introspections instead of 2N.
 */
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
    /** Null when the target has no saved connection; `missingMessage` says why. */
    target: CompareTarget | null;
    displayName: string;
    missingMessage: string | null;
    schema: string;
    schemaOptions: string[];
    schemaListError: string | null;
    /** Same host, port and database as the source — see databaseIdentity. */
    onSourceDatabase: boolean;
    duplicateOf: number | null;
  },
  head: TrackedSchemaHead | null,
  allowDataLoss: boolean,
  compareData: boolean,
): Promise<TargetOutcome> {
  const connectionEnvironment = toEnvironment(slot.connection?.environment);

  const empty = {
    index: slot.index,
    connection: slot.connection,
    displayName: slot.displayName,
    duplicateOf: slot.duplicateOf,
    schema: slot.schema,
    schemaOptions: slot.schemaOptions,
    sameAsSource: false,
    report: null,
    data: null,
    failure: null as TargetOutcome["failure"],
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

  // Nothing to dial. The message says whether the connection was deleted or
  // never picked, and the target keeps its place so the reader can fix it —
  // it is never quietly pointed at some other database instead.
  if (!slot.target) {
    return {
      ...empty,
      environment: connectionEnvironment,
      failure: "no-connection",
      error: slot.missingMessage,
    };
  }
  const target = slot.target;

  // Asked before anything is read. A schema against itself has no answer worth
  // fetching, and the "0 changes" it would produce is the one result on this
  // screen a reader can act on wrongly — it looks like two databases agreeing.
  if (slot.onSourceDatabase && slot.schema === source.schema) {
    return { ...empty, sameAsSource: true, environment: connectionEnvironment, error: null };
  }

  // A repeat of an earlier target would be the same report twice — and, with
  // row data ticked, the same tables read twice. Point at the first instead.
  if (slot.duplicateOf !== null) {
    const first = slot.duplicateOf + 1;
    return {
      ...empty,
      environment: connectionEnvironment,
      failure: "duplicate",
      error: `Same database and schema as target ${first}, so it is not compared a second time — see target ${first} above.`,
    };
  }

  if (slot.schemaListError) {
    // The driver message on its own ("connect ECONNREFUSED 127.0.0.1:5432") does
    // not say which of several targets it came from.
    return {
      ...empty,
      environment: connectionEnvironment,
      failure: "unreachable",
      error: `Could not reach ${slot.displayName}: ${slot.schemaListError}`,
    };
  }
  if (slot.schemaOptions.length > 0 && !slot.schemaOptions.includes(slot.schema)) {
    // The server answered — that is how we know which schemas it has. Nothing
    // here is unreachable.
    return {
      ...empty,
      environment: connectionEnvironment,
      failure: "schema-missing",
      error: `Schema ${slot.schema} was not found in ${slot.displayName}.`,
    };
  }

  // The lineage head — the schema's own environment label and its current
  // version — was resolved for every target in one query before this fan-out
  // started, so all that is left here is the target database itself.
  const snapshot = await fetchSchemaSnapshot(target.config, slot.schema);

  const environment = louderEnvironment(
    connectionEnvironment,
    head ? head.environment : "unset",
  );

  if (!snapshot.ok) {
    return {
      ...empty,
      environment,
      failure: "unreachable",
      error: `Could not load ${target.displayName}.${slot.schema}: ${snapshot.error}`,
    };
  }

  // Feature 5: what does this schema say about its own version? Read AFTER the
  // snapshot rather than beside it — same database, and the snapshot already
  // holds a connection, so racing them would only ask the target for two at
  // once to save a few milliseconds.
  const versionInfo = await fetchSchemaVersionInfo(target.config, slot.schema);
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
        { config: target.config, schema: slot.schema },
      )
    : null;

  // Safe mode. DROP TABLE / DROP COLUMN are always generated so the diff can
  // show what a full sync would remove, but they are only armed in the rendered
  // SQL when the user explicitly ticks "allow data loss" on the form.
  const script = generateMigration(report, { allowDataLoss });
  // The down script that undoes the migration above. It is built from the same
  // flag so its header can say whether the drops it is "restoring" ever ran.
  const rollback = generateRollback(report, { allowDataLoss });

  // The tally grades the run, not the file: safe mode comments its destructive
  // statements out, so counting them made a script that does nothing advertise
  // a breaking change and propose a major version bump. Same predicate
  // migrationChangeLevel uses, so the two cannot disagree.
  const willRun = script.statements.filter(
    (s) =>
      s.kind !== "MANUAL" &&
      !((s.destructive || s.needsArmedDrop === true) && !allowDataLoss),
  );
  const { breaking, safe, info } = tallySeverities(willRun);

  // migrationChangeLevel also answers "unknown", which it never reaches from a
  // generated script — the workbench has no such level, so fold it into patch.
  const level = migrationChangeLevel(script);
  const overallKind: ChangeKind = level === "unknown" ? "patch" : level;

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
    overallKind,
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
 * `record` stamps the open saved set's "last run" time, and only the screen's
 * POST passes it. It is a parameter rather than a query flag on purpose: the
 * screen used to be a server component whose GET wrote to the database, so
 * every reload and every shared link counted as a run nobody performed.
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

  // Nothing to compare with: point at Connections rather than rendering an
  // empty form that cannot do anything.
  if (savedConnections.length === 0) {
    return { kind: "no-connections" };
  }

  // -------------------------------------------------------------------------
  // Selection. `source*` / `target*` are the current parameter names; the older
  // `left*` / `right*` pair is still honoured so links written before the
  // rename keep working.
  // -------------------------------------------------------------------------
  const defaultConnectionId = String(savedConnections[0].id);

  // `?set=<id>` opens a saved comparison. It only seeds the pickers: the moment
  // the form is submitted the selects send real values, and those win. A set
  // that kept overriding them would make the page impossible to edit — you
  // would change a dropdown, press Compare, and watch it snap back.
  const requestedSetId = pickValue(params.set, "");
  const activeSet =
    savedSets.find((set) => String(set.id) === requestedSetId) ?? null;

  const requestedTargetConnections = paramList(
    params.targetConnection ?? params.rightConnection,
  );
  const requestedTargetSchemas = paramList(params.targetSchema ?? params.rightSchema);
  // Present at all, even empty. The form always sends these, so their presence
  // is what says "the pickers were submitted" rather than "a set was opened".
  const hasExplicitTargets = [
    params.targetConnection,
    params.rightConnection,
    params.targetSchema,
    params.rightSchema,
  ].some((value) => value !== undefined);

  // A saved-set link whose set has since been deleted. Running it would compare
  // whatever the pickers default to, under a link that promised something else,
  // so it only fills the pickers and the screen says why.
  const setNotFound = requestedSetId !== "" && activeSet === null;

  // Did anybody actually ask for this comparison?
  //
  // A migration generated for a pair nobody chose reads as a recommendation, so
  // only `run=1` runs one. The Compare button sends it, and so do saved-set
  // links and the links from the dashboard, Drift and a schema's page. Add
  // target and Remove do not: they change the pickers, and nobody has pressed
  // Compare on the result yet.
  const asked =
    pickValue(params.run, "") === "1" && !(setNotFound && !hasExplicitTargets);

  // The source as the URL names it. Present but empty means the picker was
  // submitted with nothing chosen, and that stays "no source" — it is not
  // quietly replaced with the first connection.
  const requestedSource = firstParam(params.sourceConnection ?? params.leftConnection);
  const sourceConnectionId =
    requestedSource ??
    (activeSet
      ? activeSet.sourceConnectionId === null
        ? ""
        : String(activeSet.sourceConnectionId)
      : defaultConnectionId);
  // The name a saved set remembers for a source that has since been deleted,
  // so the screen can say which one is gone.
  const sourceMissingLabel =
    activeSet && activeSet.sourceConnectionId === null && sourceConnectionId === ""
      ? activeSet.sourceConnectionLabel
      : null;

  /**
   * What a fresh Add target — or the first target on a bare /compare — starts
   * on.
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

  /** One target as the URL or the saved set describes it, before any lookup. */
  type Slot = {
    connectionId: string;
    schema: string;
    /** The name a saved set remembers for a connection that was deleted. */
    missingLabel: string | null;
  };

  // Pair the two lists by index. Length is taken from the longer of them, so a
  // target whose connection is missing from the URL still keeps its schema.
  const slotCount = Math.max(
    requestedTargetConnections.length,
    requestedTargetSchemas.length,
  );
  let slots: Slot[] = hasExplicitTargets
    ? Array.from({ length: slotCount }, (_, index) => ({
        connectionId: requestedTargetConnections[index] ?? "",
        schema: requestedTargetSchemas[index] ?? "",
        missingLabel: null,
      }))
    : (activeSet?.targets ?? []).map((target) =>
        // A deleted connection keeps its place, empty, under the name the set
        // remembers. It is never moved onto another database: the reader sees
        // which one is gone and picks the replacement.
        target.connectionId === null
          ? { connectionId: "", schema: target.schema, missingLabel: target.connectionLabel }
          : { connectionId: String(target.connectionId), schema: target.schema, missingLabel: null },
      );

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

  // "Add target" appends a target on the default connection, with that
  // connection's default schema.
  if (pickValue(params.addTarget, "") === "1" && slots.length < MAX_TARGETS) {
    slots.push({ connectionId: defaultTargetConnectionId, schema: "", missingLabel: null });
  }

  if (slots.length === 0) {
    slots = [{ connectionId: defaultTargetConnectionId, schema: "", missingLabel: null }];
  }
  slots = slots.slice(0, MAX_TARGETS);

  // No fallbacks. A connection that is not there is reported as missing; a
  // stand-in compared under its name would be a result for a pair nobody chose.
  const findConnection = (id: string) =>
    id === ""
      ? null
      : savedConnections.find((connection) => String(connection.id) === id) ?? null;

  const sourceConnection = findConnection(sourceConnectionId);
  const sourceTarget = sourceConnection
    ? buildTargetFromConnection(sourceConnection, "source")
    : null;
  const sourceMissingMessage = sourceConnection
    ? null
    : missingSourceMessage(sourceConnectionId, sourceMissingLabel);

  const targetSlots = slots.map((slot, index) => {
    const connection = findConnection(slot.connectionId);
    const target = connection
      ? buildTargetFromConnection(connection, `target-${index}`)
      : null;
    return {
      index,
      connection,
      target,
      requestedSchema: slot.schema,
      missingLabel: slot.missingLabel,
      displayName: target ? target.displayName : slot.missingLabel || "No connection",
      missingMessage: connection
        ? null
        : missingConnectionMessage(slot.connectionId, slot.missingLabel),
    };
  });

  // -------------------------------------------------------------------------
  // Schema lists. Two targets on the same connection ask the same question, so
  // look each connection up once and share the answer. A side with no
  // connection has nothing to ask.
  // -------------------------------------------------------------------------
  const configsByKey = new Map<string, CompareTarget>();
  const keyFor = (connection: SavedConnection) => `conn:${connection.id}`;

  if (sourceConnection && sourceTarget) {
    configsByKey.set(keyFor(sourceConnection), sourceTarget);
  }
  for (const slot of targetSlots) {
    if (slot.connection && slot.target) {
      configsByKey.set(keyFor(slot.connection), slot.target);
    }
  }

  const keys = [...configsByKey.keys()];
  const schemaResults = await Promise.all(
    keys.map((key) => fetchSchemaNames(configsByKey.get(key)!.config)),
  );
  const schemaLists = new Map(keys.map((key, i) => [key, schemaResults[i]]));

  function schemasFor(connection: SavedConnection | null) {
    const result = connection ? schemaLists.get(keyFor(connection)) : undefined;
    if (!result) return { options: [] as string[], error: null as string | null };
    return result.ok
      ? { options: result.data, error: null }
      : { options: [] as string[], error: result.error };
  }

  /**
   * Prefer what was asked for, then `public`, then whatever exists.
   *
   * `avoid` names a schema this side should not land on by accident — the
   * source's, when the target is on the same database. Without it a project
   * with one saved connection opened Compare with both sides defaulted to the
   * same schema and rendered "0 changes · 0 tables", which reads as a finding
   * about two databases rather than what it was: the tool comparing something
   * with itself because nobody had chosen yet. It only steers the DEFAULT — an
   * explicitly requested schema is always honoured, including when it is the
   * same on both sides, because that is then a choice somebody made.
   */
  function resolveSchema(requested: string, options: string[], avoid?: string): string {
    if (requested.length > 0) return requested;
    const candidates =
      avoid === undefined ? options : options.filter((schema) => schema !== avoid);
    return (
      candidates.find((schema) => schema === "public") ??
      candidates[0] ??
      options[0] ??
      "public"
    );
  }

  const requestedSourceSchema =
    firstParam(params.sourceSchema ?? params.leftSchema) ?? activeSet?.sourceSchema ?? "";
  const sourceSchemaInfo = schemasFor(sourceConnection);
  // A missing source keeps the schema it asked for, so picking a connection
  // again does not also lose the schema.
  const sourceSchema = sourceTarget
    ? resolveSchema(requestedSourceSchema, sourceSchemaInfo.options)
    : requestedSourceSchema;
  const sourceEnvironment = toEnvironment(sourceConnection?.environment);
  // Same host, port and database name — not the same saved entry, since two
  // entries for one database are still one database. See databaseIdentity.
  const sourceIdentity = sourceTarget ? databaseIdentity(sourceTarget.config) : null;

  const resolvedTargets = targetSlots.map((slot) => {
    const info = schemasFor(slot.connection);
    // Only a target on the SAME database has the source's schema to avoid. On a
    // different one, a schema of the same name is a perfectly ordinary thing to
    // compare — dev.public against prod.public is the tool's whole point.
    const onSourceDatabase =
      slot.target !== null &&
      sourceIdentity !== null &&
      databaseIdentity(slot.target.config) === sourceIdentity;
    return {
      ...slot,
      schemaOptions: info.options,
      schemaListError: info.error,
      schema: slot.target
        ? resolveSchema(
            slot.requestedSchema,
            info.options,
            onSourceDatabase ? sourceSchema : undefined,
          )
        : slot.requestedSchema,
      onSourceDatabase,
    };
  });

  // A target that repeats an earlier one — same database, same schema — is
  // compared once, under the first. A target that IS the source is left out:
  // it already says so on its own, and repeats nothing.
  const duplicateOf = findDuplicateTargets(
    resolvedTargets.map((slot) =>
      slot.target && !(slot.onSourceDatabase && slot.schema === sourceSchema)
        ? `${databaseIdentity(slot.target.config)}|${slot.schema}`
        : `skip:${slot.index}`,
    ),
  );

  // -------------------------------------------------------------------------
  // The compare itself. One source snapshot, then every target — a slow or
  // unreachable target holds up only its own section.
  // -------------------------------------------------------------------------
  // An unticked checkbox submits nothing, so "absent" cannot be told apart from
  // "never submitted". The same rule as the targets settles it: while the
  // selection is still the set's, so are these; once the form has been
  // submitted the checkboxes are authoritative.
  const allowDataLoss =
    activeSet && !hasExplicitTargets
      ? activeSet.allowDataLoss
      : pickValue(params.allowDataLoss, "") === "1";
  const compareData =
    activeSet && !hasExplicitTargets
      ? activeSet.compareData
      : pickValue(params.compareData, "") === "1";

  // Only asked of a source that exists. A missing one has its own message,
  // which says whether it was deleted or never picked.
  let sourceError: string | null = null;
  if (sourceTarget) {
    if (sourceSchemaInfo.error) {
      sourceError = `Could not reach ${sourceTarget.displayName}: ${sourceSchemaInfo.error}`;
    } else if (
      sourceSchemaInfo.options.length > 0 &&
      !sourceSchemaInfo.options.includes(sourceSchema)
    ) {
      sourceError = `Schema ${sourceSchema} was not found in ${sourceTarget.displayName}.`;
    }
  }

  let outcomes: TargetOutcome[] = [];
  let sourceVersionInfo: VersionDetectionResult | null = null;
  // No outcomes without `asked`: the schema lists above are what the pickers
  // need, and going further would open both databases for a question nobody
  // put. The screen renders the pickers and says so.
  if (sourceTarget && !sourceError && asked) {
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
            { ...slot, duplicateOf: duplicateOf[slot.index] },
            slot.connection
              ? heads.get(trackedSchemaKey(slot.connection.id, slot.schema)) ?? null
              : null,
            allowDataLoss,
            compareData,
          ),
      );
    }
  }

  // What the Save button would write: exactly what is on screen right now,
  // including a side whose connection is gone — null, under the name it had.
  const selection: CurrentSelection = {
    sourceConnectionId: sourceConnection ? sourceConnection.id : null,
    sourceConnectionLabel: sourceTarget?.displayName ?? sourceMissingLabel ?? "",
    sourceSchema,
    allowDataLoss,
    compareData,
    targets: resolvedTargets.map((slot) => ({
      connectionId: slot.connection ? slot.connection.id : null,
      connectionLabel: slot.target ? slot.target.displayName : (slot.missingLabel ?? ""),
      schema: slot.schema,
    })),
  };

  // Compared with the set BEFORE the stamp below. A run only counts as running
  // the set when it ran the set as saved: an edited selection is a different
  // comparison, and stamping it would say the set still works when nobody ran
  // the set.
  const setModified = activeSet ? !matchesSet(activeSet, selection) : false;

  // The sets were read at the top of this render, before we knew whether the
  // comparison would work, so the stamp written below is not in them yet.
  let justRanAt: string | null = null;

  const comparedPairs = outcomes.filter((outcome) => outcome.report);
  if (record && comparedPairs.length > 0 && activeSet && !setModified) {
    // A set nobody has run for months is usually a set pointing at a database
    // that no longer exists, so the picker shows when each one last ran.
    justRanAt = await markComparisonSetRun(activeSet.id);
  }

  const canAddTarget = resolvedTargets.length < MAX_TARGETS;

  const setOptions: ComparisonSetOption[] = savedSets.map((set) => {
    // The source counts as well as the targets: a set that reads production —
    // row data included — is worth knowing about before anyone opens it.
    const liveSource =
      set.sourceConnectionId === null
        ? null
        : findConnection(String(set.sourceConnectionId));
    return {
      id: set.id,
      name: set.name,
      targetCount: set.targets.length,
      hasProduction:
        (liveSource !== null && isProduction(toEnvironment(liveSource.environment))) ||
        set.targets.some((target) => isProduction(target.environment)),
      compareData: set.compareData,
      hasMissingConnection:
        set.sourceConnectionId === null ||
        set.targets.some((target) => target.connectionId === null),
      lastRunAt: set.id === activeSet?.id && justRanAt ? justRanAt : set.lastRunAt,
    };
  });

  return {
    kind: "ready",
    connections: savedConnections.map(toConnectionView),
    canAddTarget,
    maxTargets: MAX_TARGETS,
    sets: setOptions,
    activeSetId: activeSet ? activeSet.id : null,
    setNotFound,
    setModified,
    selection,
    source: {
      connectionId: sourceConnection ? sourceConnection.id : null,
      displayName: sourceTarget
        ? sourceTarget.displayName
        : sourceMissingLabel || "No connection",
      schema: sourceSchema,
      schemaOptions: sourceSchemaInfo.options,
      environment: sourceEnvironment,
      detectedVersion: sourceVersionInfo ? toDetectedVersion(sourceVersionInfo) : null,
      missingMessage: sourceMissingMessage,
    },
    sourceError,
    targets: resolvedTargets.map((slot) => ({
      index: slot.index,
      connectionId: slot.connection ? slot.connection.id : null,
      displayName: slot.displayName,
      schema: slot.schema,
      schemaOptions: slot.schemaOptions,
      environment: toEnvironment(slot.connection?.environment),
      missingMessage: slot.missingMessage,
    })),
    outcomes: outcomes.map(toOutcomeView),
    allowDataLoss,
    compareData,
    asked,
  };
}
