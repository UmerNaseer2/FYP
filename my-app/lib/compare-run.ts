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
  statementsThatRun,
} from "@/lib/generate-sql";
import pool, { syncMetadataTables } from "@/lib/version-db";
import { buildPgConfig } from "@/lib/connection-config";
import { UNREADABLE_CREDENTIALS_MESSAGE } from "@/lib/secret-store";
import type { CompareTarget, SchemaSnapshot } from "@/lib/postgres";
import { fetchSchemaNames, fetchSchemaSnapshot, POOL_MAX } from "@/lib/postgres";
import { mapWithLimit } from "@/lib/concurrency";
import { compareSchemas, type CompareReport } from "@/lib/compare";
import type { ChangeSeverity } from "@/lib/compare-types";
import { compareRowData, type DataCompareReport } from "@/lib/compare-data";
import {
  determineNewerSchema,
  fetchSchemaVersionInfo,
  pickCurrentVersion,
  type NewerSchemaVerdict,
  type VersionDetectionResult,
} from "@/lib/version-detection";
import { toDetectedVersion, type DetectedVersion } from "@/lib/detected-version";
import {
  findTrackedSchemas,
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
import { buildDiffDocument } from "@/lib/compare-export";
import {
  compareRuns,
  describeDelta,
  describeItem,
  snapshotChanges,
} from "@/lib/comparison-history";
import {
  pairKey,
  readPreviousRuns,
  recordRuns,
  type RunPair,
  type RunRecord,
} from "@/lib/comparison-history-db";
import { matchesSet, MAX_COMPARISON_TARGETS } from "@/lib/comparison-set-rules";
import {
  databaseIdentity,
  findDuplicateTargets,
  missingConnectionMessage,
  missingSourceMessage,
  type CurrentSelection,
} from "@/lib/compare-selection";
import { buildSwapHref } from "@/lib/compare-links";
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
  /**
   * Why this target has nothing to read: no saved connection, or one whose
   * credentials can't be read on this server. Null when it has one it can use.
   */
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
  /**
   * The id of the saved connection this target was compared through, or null
   * when the slot had none (the environment fallback). The Migration Workbench
   * sends it to the preflight route to read the version already applied to
   * this target. Only the id travels: the host, user and password stay on the
   * server.
   */
  connectionId: number | null;
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
       * The tables the row-data compare was limited to, or [] for all of them
       * (spec 04 — "compare all or selected table data").
       *
       * Named by the label the report gives a table, which is what the screen
       * displayed and what its checkboxes send back. Echoed here rather than
       * read from the URL by the screen so that one piece of code decides what
       * the parameter means — the same reason the whole query string is sent to
       * this module instead of being parsed in the browser.
       */
      dataTables: string[];
      /**
       * Whether somebody actually asked for this comparison: `run=1`, which
       * the Compare button, a saved set and the links from the dashboard,
       * Drift and a schema's page all send. False on a bare /compare and after
       * Add target or Remove — the pickers changed, nobody pressed Compare,
       * and `outcomes` is deliberately empty.
       */
      asked: boolean;
      /**
       * The same comparison the other way round, run at once. The Migration
       * Workbench offers it when a push would move the target backwards. Null
       * unless there is exactly one target and both sides have a saved
       * connection (buildSwapHref).
       */
      swapHref: string | null;
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
    connectionId: connection ? connection.id : null,
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

/** How Compare names a saved connection: its name, then the database it opens. */
function connectionDisplayName(connection: SavedConnection): string {
  return `${connection.name} (${connection.database_name})`;
}

/**
 * buildTargetFromConnection, or why it could not be built.
 *
 * buildPgConfig decrypts the saved password, and throws when this server's
 * APP_ENCRYPTION_KEY is missing or is not the key it was saved with. Left
 * uncaught, that took the whole Compare page down over one side. Caught, the
 * side stays on screen under its own name and says what to fix.
 */
function tryBuildTarget(
  connection: SavedConnection,
  id: string,
): { target: CompareTarget; credentialError: null } | { target: null; credentialError: string } {
  try {
    return { target: buildTargetFromConnection(connection, id), credentialError: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Compare — could not read the credentials of "${connection.name}":`, message);
    return {
      target: null,
      credentialError: `Could not use ${connectionDisplayName(connection)}. ${UNREADABLE_CREDENTIALS_MESSAGE}`,
    };
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
    displayName: connectionDisplayName(connection),
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

// What the screen shows of each schema's own version table. The type and its
// trimming live in lib/detected-version.ts, which has no database imports, so
// the browser can import the type and a test can check the trimming.
export type { DetectedVersion } from "@/lib/detected-version";

/** One schema's detection result, trimmed for the screen. */
function detectedFor(info: VersionDetectionResult): DetectedVersion {
  return toDetectedVersion(info, pickCurrentVersion(info.timeline));
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
  failure:
    | "unreachable"
    | "schema-missing"
    | "duplicate"
    | "no-connection"
    /**
     * This target's comparison threw. Kept apart from "unreachable" because
     * the server may well have answered perfectly: the fault is on this side,
     * and counting it as an unreachable database sends the reader to check a
     * network that is fine. See the catch around compareOneTarget.
     */
    | "failed"
    | null;
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
  /** What this schema's own version table says. Null when it could not be read. */
  detectedVersion: DetectedVersion | null;
  /**
   * Which side is further ahead by those detected versions, and why. "unknown"
   * whenever either side has no version to compare, which is the common case
   * and the reason the structural diff below is the real answer.
   */
  versionVerdict: NewerSchemaVerdict | null;
  /**
   * How this pair's differences compare with the last recorded run of the same
   * pair. Null when there is no earlier run to compare with — which is every
   * first comparison, and which the screen says nothing about rather than
   * reporting "nothing appeared" as if that were a finding about the schemas.
   *
   * Filled in after the fan-out rather than inside compareOneTarget, because
   * every target's previous run is read in one query — see readPreviousRuns.
   */
  history: ComparisonHistoryView | null;
};

/** "Since the comparison on 12 September: 2 new differences." */
export type ComparisonHistoryView = {
  /** When the run being compared with happened, as stored. */
  since: string;
  /** Who ran it — see actorFor for why this is not always an address. */
  by: string;
  /** The whole thing in one sentence. See describeDelta. */
  sentence: string;
  /** Differences this run has that the previous one did not. */
  appeared: HistoryLine[];
  /** Differences the previous run had that this one does not. */
  resolved: HistoryLine[];
};

export type HistoryLine = { label: string; severity: ChangeSeverity };

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
 * A target's identity with every result field emptied — what each of the
 * outcomes below starts from, and what the safety net around this function
 * falls back to.
 *
 * Lifted out of compareOneTarget so the catch in the fan-out can build one
 * without calling back into the function that just threw. `environment` and
 * `error` are deliberately absent: every caller sets them, and a default for
 * either would be a claim rather than a blank.
 */
function blankOutcome(slot: {
  index: number;
  connection: SavedConnection | null;
  displayName: string;
  schema: string;
  schemaOptions: string[];
  duplicateOf: number | null;
}): Omit<TargetOutcome, "environment" | "error"> {
  return {
    index: slot.index,
    connection: slot.connection,
    displayName: slot.displayName,
    duplicateOf: slot.duplicateOf,
    schema: slot.schema,
    schemaOptions: slot.schemaOptions,
    sameAsSource: false,
    report: null,
    data: null,
    failure: null,
    delta: null,
    sqlText: "",
    rollbackText: "",
    rollbackStatementCount: 0,
    rollbackCounts: { breaking: 0, safe: 0, info: 0 },
    rollbackWarnings: [],
    statementCount: 0,
    heldBackCount: 0,
    manualCount: 0,
    rollbackManualCount: 0,
    counts: { breaking: 0, safe: 0, info: 0 },
    overallKind: "patch",
    warnings: [],
    detectedVersion: null,
    versionVerdict: null,
    // Filled in after the fan-out, and only for a target that produced a
    // report — see attachHistory.
    history: null,
  };
}

/**
 * compareOneTarget with a net under it.
 *
 * Every failure that function KNOWS about it returns as an outcome — an
 * unreachable server, a missing schema, a connection that was deleted. The
 * hazard is the one it does not know about: anything thrown from the
 * introspection, the diff or the SQL generation that follows leaves the
 * function without returning, and mapWithLimit hands that rejection straight to
 * the caller. A run comparing six targets then shows nothing at all — not five
 * good reports and one failure, but a blank page — because one of them tripped
 * over a catalog shape nobody anticipated. The five that worked were real
 * results and there is no reason to lose them.
 *
 * So the throw becomes that target's own error, in its own slot, and every
 * other target keeps its report. It is a net, not a cure: reaching it means
 * something unforeseen happened, which is why the message says so plainly
 * rather than dressing it up as a database problem.
 */
async function compareOneTargetSafely(
  source: Parameters<typeof compareOneTarget>[0],
  slot: Parameters<typeof compareOneTarget>[1],
  head: TrackedSchemaHead | null,
  allowDataLoss: boolean,
  compareData: boolean,
  dataTables: string[],
): Promise<TargetOutcome> {
  try {
    return await compareOneTarget(source, slot, head, allowDataLoss, compareData, dataTables);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ...blankOutcome(slot),
      environment: toEnvironment(slot.connection?.environment),
      // Not "unreachable": the server may have answered every query it was
      // asked. Saying it could not be reached would send the reader to check a
      // network that is working.
      failure: "failed",
      error:
        `Comparing ${slot.displayName} failed unexpectedly, so this target has ` +
        `no report. The other targets in this run are unaffected. ${detail}`,
    };
  }
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
    /**
     * Null when the target has no saved connection (`missingMessage` says why)
     * or has one whose credentials can't be read (`credentialError` says why).
     */
    target: CompareTarget | null;
    displayName: string;
    missingMessage: string | null;
    credentialError: string | null;
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
  /** The tables to read rows from, or [] for every table. See CompareScreen. */
  dataTables: string[],
): Promise<TargetOutcome> {
  const connectionEnvironment = toEnvironment(slot.connection?.environment);

  const empty = blankOutcome(slot);

  // Nothing to dial. The message says whether the connection was deleted or
  // never picked, and the target keeps its place so the reader can fix it —
  // it is never quietly pointed at some other database instead.
  if (!slot.target) {
    // A saved connection whose password this server can't decrypt. It is
    // there, so "no connection" would be wrong; nothing could be dialled, which
    // is what "unreachable" means here, and the message says what to fix.
    if (slot.credentialError) {
      return {
        ...empty,
        environment: connectionEnvironment,
        failure: "unreachable",
        error: slot.credentialError,
      };
    }
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
        { only: dataTables },
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
  // a breaking change and propose a major version bump. statementsThatRun is
  // the list migrationChangeLevel and the SQL header count too, so none of the
  // three can disagree.
  const willRun = statementsThatRun(script);
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
    detectedVersion: detectedFor(versionInfo),
    versionVerdict,
  };
}

/**
 * Say what has changed since the last run of each pair, and record this one.
 *
 * Runs after the fan-out rather than inside compareOneTarget so that every
 * target's previous run is read in ONE query to the metadata database, instead
 * of one per target landing in the middle of another database's introspection.
 *
 * The history covers the STRUCTURAL differences only — buildDiffDocument's
 * change list, the same rows the export writes. Row counts move every time
 * anybody inserts anything, so folding them in would report drift on every run
 * of a database that is simply being used, and bury the schema change that
 * actually matters.
 *
 * Failures cost the history and never the comparison: readPreviousRuns and
 * recordRuns both swallow their own errors, and the work here is skipped
 * entirely when there is no pair to file a run under.
 */
async function attachHistory(
  outcomes: TargetOutcome[],
  sourceConnectionId: number | null,
  sourceSchema: string,
  setId: number | null,
  record: { ranBy: string } | null,
): Promise<TargetOutcome[]> {
  // History is filed against the two SAVED CONNECTIONS, so a comparison whose
  // source connection has been deleted has nothing to file under and nothing
  // to look up. That is the honest answer rather than a gap: the run it would
  // be compared with was measured through a connection that no longer exists.
  if (sourceConnectionId === null) return outcomes;

  // Keyed by pair, so a pair that somehow appears twice is stored once. Two
  // targets naming the same database and schema are caught earlier and the
  // second never gets a report (see duplicateOf), but a second row for one
  // pair in one run would make that run its own predecessor.
  const current = new Map<string, { pair: RunPair; findings: ReturnType<typeof snapshotChanges> }>();
  for (const outcome of outcomes) {
    if (!outcome.report || !outcome.connection) continue;
    const pair: RunPair = {
      sourceConnectionId,
      sourceSchema,
      targetConnectionId: outcome.connection.id,
      targetSchema: outcome.schema,
    };
    current.set(pairKey(pair), {
      pair,
      findings: snapshotChanges(buildDiffDocument(outcome.report).changes),
    });
  }
  if (current.size === 0) return outcomes;

  const previous = await readPreviousRuns([...current.values()].map((entry) => entry.pair));

  const withHistory = outcomes.map((outcome) => {
    if (!outcome.report || !outcome.connection) return outcome;
    const key = pairKey({
      sourceConnectionId,
      sourceSchema,
      targetConnectionId: outcome.connection.id,
      targetSchema: outcome.schema,
    });
    const before = previous.get(key);
    const now = current.get(key);
    if (!before || !now) return outcome;

    const delta = compareRuns(before.findings, now.findings);
    return {
      ...outcome,
      history: {
        since: before.ranAt,
        by: before.ranBy,
        sentence: describeDelta(delta, formatRunTime(before.ranAt)),
        appeared: delta.appeared.map(toHistoryLine),
        resolved: delta.resolved.map(toHistoryLine),
      },
    };
  });

  // Written AFTER the lookup above, or this run would be its own predecessor
  // and every comparison would report that nothing had changed since itself.
  if (record) {
    const records: RunRecord[] = [...current.values()].map((entry) => ({
      pair: entry.pair,
      setId,
      ranBy: record.ranBy,
      findings: entry.findings,
    }));
    await recordRuns(records);
  }

  return withHistory;
}

function toHistoryLine(item: { key: string; severity: ChangeSeverity }): HistoryLine {
  return { label: describeItem(item), severity: item.severity };
}

/**
 * A stored timestamp as the sentence wants it: "on 12 Sep 2026, 14:30".
 *
 * Formatted here rather than in the browser because the sentence is built here
 * — and left as the raw string if it cannot be parsed, since a run that reads
 * "on Invalid Date" is worse than one that reads as the stamp the database
 * returned.
 */
function formatRunTime(stamp: string): string {
  const at = new Date(stamp);
  if (Number.isNaN(at.getTime())) return `at ${stamp}`;
  return `on ${at.toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })}`;
}

/**
 * Run one comparison and return everything the screen draws.
 *
 * `record` stamps the open saved set's "last run" time and stores what each
 * pair was found to differ by, and only the screen's POST passes it. It is a
 * parameter rather than a query flag on purpose: the screen used to be a server
 * component whose GET wrote to the database, so every reload and every shared
 * link counted as a run nobody performed.
 *
 * It carries who to record rather than being a boolean, so that recording a run
 * without knowing who ran it is not a thing this function can be asked to do.
 * Passing null still READS the history — what the last run found is worth
 * showing on a reloaded page; it is the writing that needs somebody to have
 * pressed the button.
 */
export async function runComparison(
  query: URLSearchParams,
  record: { ranBy: string } | null,
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

  // A connection that is there but whose credentials can't be read has no
  // target (nothing to dial) and a credentialError saying why. Its name is
  // still the one shown: it is the connection the reader picked.
  const sourceConnection = findConnection(sourceConnectionId);
  const sourceBuilt = sourceConnection ? tryBuildTarget(sourceConnection, "source") : null;
  const sourceTarget = sourceBuilt ? sourceBuilt.target : null;
  const sourceMissingMessage = sourceConnection
    ? null
    : missingSourceMessage(sourceConnectionId, sourceMissingLabel);

  const targetSlots = slots.map((slot, index) => {
    const connection = findConnection(slot.connectionId);
    const built = connection ? tryBuildTarget(connection, `target-${index}`) : null;
    return {
      index,
      connection,
      target: built ? built.target : null,
      credentialError: built ? built.credentialError : null,
      requestedSchema: slot.schema,
      missingLabel: slot.missingLabel,
      displayName: connection
        ? connectionDisplayName(connection)
        : slot.missingLabel || "No connection",
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
  // Which tables the row compare is limited to, seeded from the saved set on
  // the same terms as the two checkboxes above: the URL wins when the page
  // carries its own targets, and otherwise the set supplies it.
  //
  // A set that stored no selection — either because it chose every table, or
  // because it was saved before sets remembered one — has an empty list here,
  // and an empty list already means every table. So the old behaviour is what
  // those sets still get, without a second code path to keep in step.
  const dataTables =
    activeSet && !hasExplicitTargets ? activeSet.dataTables : paramList(params.dataTable);

  // Only asked of a source that can be read. A missing one has its own
  // message, which says whether it was deleted or never picked. One whose
  // credentials can't be read starts out with that as its error, so nothing
  // below opens anything and the banner says what to fix.
  let sourceError: string | null = sourceBuilt ? sourceBuilt.credentialError : null;
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
          compareOneTargetSafely(
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
            dataTables,
          ),
      );
    }
  }

  // What the Save button would write: exactly what is on screen right now,
  // including a side whose connection is gone — null, under the name it had.
  const selection: CurrentSelection = {
    sourceConnectionId: sourceConnection ? sourceConnection.id : null,
    sourceConnectionLabel: sourceConnection
      ? connectionDisplayName(sourceConnection)
      : sourceMissingLabel ?? "",
    sourceSchema,
    allowDataLoss,
    compareData,
    dataTables,
    targets: resolvedTargets.map((slot) => ({
      connectionId: slot.connection ? slot.connection.id : null,
      connectionLabel: slot.connection
        ? connectionDisplayName(slot.connection)
        : (slot.missingLabel ?? ""),
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

  // What each pair differed by last time, and — when somebody pressed the
  // button — a record of what it differs by now. Both are best-effort: see the
  // note at the top of comparison-history-db.
  outcomes = await attachHistory(
    outcomes,
    sourceConnection ? sourceConnection.id : null,
    sourceSchema,
    activeSet ? activeSet.id : null,
    record,
  );

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
      displayName: sourceConnection
        ? connectionDisplayName(sourceConnection)
        : sourceMissingLabel || "No connection",
      schema: sourceSchema,
      schemaOptions: sourceSchemaInfo.options,
      environment: sourceEnvironment,
      detectedVersion: sourceVersionInfo ? detectedFor(sourceVersionInfo) : null,
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
      // The picker says why it has nothing to list: no connection, or one
      // whose credentials can't be read here.
      missingMessage: slot.missingMessage ?? slot.credentialError,
    })),
    outcomes: outcomes.map(toOutcomeView),
    allowDataLoss,
    compareData,
    dataTables,
    asked,
    swapHref: buildSwapHref(selection),
  };
}
