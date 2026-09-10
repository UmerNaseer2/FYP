import type { ClientConfig } from "pg";
import {
  fetchSchemaSnapshot,
  withoutToolTables,
  type SchemaSnapshot,
} from "./postgres";
import { buildPgConfig } from "./connection-config";
import { compareSchemas } from "./compare";
import type { CompareReport } from "./compare-types";
import type { ChangeLevel } from "./version-detection";
import { listSetNamesUsingConnection } from "./comparison-sets";
import pool, { syncMetadataTables } from "./version-db";
import { toEnvironment, type Environment } from "./environments";
import { snapshotFormatGap, type SnapshotFormatGap } from "./snapshot-format";
import { normalizeDriftInterval } from "./drift-schedule";
import { toDriftSource, type DriftSource } from "./drift-source";

/**
 * Phase 6 metadata store — "schema lineage".
 *
 * Everything here lives in the SAME Postgres metadata database as `connections`
 * and `comparison_sets` (the `DATABASE_URL_A` pool from `version-db`), and
 * the four tables are declared with the rest of them in lib/db/models.ts. We
 * deliberately do NOT introduce a separate Supabase data layer — Supabase is
 * only the auth provider in this app, and keeping all app metadata in one place
 * is simpler and less error-prone.
 *
 * The four tables:
 *   tracked_schemas    — one row per (connection, schema) the user is watching.
 *   snapshots          — a captured `SchemaSnapshot` (JSONB) at a point in time.
 *   lineage_migrations — the ordered history of a tracked schema (seq, version…).
 *   drift_events       — recorded drift checks, used by the audit feed (Phase 6B).
 *
 * A tracked schema's baseline is snapshot #1 + lineage migration seq 1 (v1.0.0).
 */

// ── Row shapes ────────────────────────────────────────────────────────────

export type TrackedSchemaRow = {
  id: number;
  connection_id: number;
  schema_name: string;
  label: string | null;
  /**
   * dev / staging / prod for this specific schema. Seeded from the connection
   * when the schema is first tracked, but stored separately: one server can
   * legitimately host a staging schema and a production one.
   */
  environment: Environment;
  created_at: string;
};

export type DriftStatus = "in_sync" | "drifted" | "unreachable";

// ── Pure helpers ──────────────────────────────────────────────────────────

/** The version a brand-new baseline (lineage seq 1) starts at. */
export const BASELINE_VERSION = "1.0.0";

/**
 * Work out the next semver from the current one and the change level. Matches
 * the convention already used in `app/scripts/page.tsx`:
 *   breaking → bump major, additive → bump minor, patch/unknown → bump patch.
 * Defensive about malformed input (treats missing parts as 0).
 */
export function getNextLineageVersion(
  currentVersion: string | null,
  changeLevel: ChangeLevel
): string {
  if (!currentVersion) return BASELINE_VERSION;

  const parts = currentVersion
    .replace(/^v/i, "")
    .split(".")
    .map((p) => parseInt(p.replace(/\D/g, ""), 10) || 0);
  const major = parts[0] ?? 0;
  const minor = parts[1] ?? 0;
  const patch = parts[2] ?? 0;

  if (changeLevel === "breaking") return `${major + 1}.0.0`;
  if (changeLevel === "additive") return `${major}.${minor + 1}.0`;
  // "patch" and "unknown" both take the smallest, safest bump.
  return `${major}.${minor}.${patch + 1}`;
}

// ── Lookups (used to back-wire Compare + Deploy) ───────────────────────────

export type TrackedSchemaHead = {
  trackedSchemaId: number;
  /** Lineage HEAD version, e.g. "1.0.0". Null only if lineage is empty. */
  headVersion: string | null;
  /** Latest drift result, null until a drift check has run. */
  driftStatus: DriftStatus | null;
  /** dev / staging / prod — what lets Compare warn before touching this one. */
  environment: Environment;
};

/** The (connection, schema) pair a caller wants a lineage head for. */
export type TrackedSchemaRef = { connectionId: number; schemaName: string };

/** How findTrackedSchemas keys its result — connection id and schema name. */
export function trackedSchemaKey(connectionId: number, schemaName: string): string {
  return `${connectionId}:${schemaName}`;
}

/**
 * Lineage heads for several (connection, schema) pairs in ONE query.
 *
 * The Compare screen wants this for every target it is about to read, and
 * asking per target was both N round trips and — worse — N round trips issued
 * while the target databases were mid-introspection. Resolving the whole set
 * up front means the fan-out that follows touches only the databases being
 * compared, which is easier to reason about and easier to bound.
 *
 * Pairs that are not tracked are simply absent from the map; callers already
 * treat "no head" as "not tracked".
 */
export async function findTrackedSchemas(
  refs: readonly TrackedSchemaRef[]
): Promise<Map<string, TrackedSchemaHead>> {
  const found = new Map<string, TrackedSchemaHead>();
  if (refs.length === 0) return found;

  await syncMetadataTables();
  const result = await pool.query<{
    connection_id: number;
    schema_name: string;
    id: number;
    environment: string | null;
    head_version: string | null;
    drift_status: DriftStatus | null;
  }>(
    `SELECT
       ts.connection_id,
       ts.schema_name,
       ts.id,
       ts.environment,
       head.version AS head_version,
       drift.status AS drift_status
     FROM unnest($1::int[], $2::text[]) AS want(connection_id, schema_name)
     JOIN tracked_schemas ts
       ON ts.connection_id = want.connection_id
      AND ts.schema_name = want.schema_name
     LEFT JOIN LATERAL (
       SELECT version FROM lineage_migrations lm
       WHERE lm.tracked_schema_id = ts.id
       ORDER BY lm.seq DESC LIMIT 1
     ) head ON TRUE
     LEFT JOIN LATERAL (
       SELECT status FROM drift_events de
       WHERE de.tracked_schema_id = ts.id
       ORDER BY de.detected_at DESC, de.id DESC LIMIT 1
     ) drift ON TRUE`,
    [refs.map((r) => r.connectionId), refs.map((r) => r.schemaName)]
  );

  for (const row of result.rows) {
    found.set(trackedSchemaKey(row.connection_id, row.schema_name), {
      trackedSchemaId: row.id,
      headVersion: row.head_version,
      driftStatus: row.drift_status,
      environment: toEnvironment(row.environment),
    });
  }
  return found;
}

/**
 * Find the tracked schema for a given (connection, schema) pair, with its
 * lineage HEAD version and latest drift status. Returns null when the pair
 * isn't being tracked — callers use that to fall back to honest "not tracked"
 * copy instead of inventing a version. Read-only; safe to call from a server
 * component or an API route.
 */
export async function findTrackedSchema(
  connectionId: number,
  schemaName: string
): Promise<TrackedSchemaHead | null> {
  const found = await findTrackedSchemas([{ connectionId, schemaName }]);
  return found.get(trackedSchemaKey(connectionId, schemaName)) ?? null;
}

/**
 * Advance a tracked schema's lineage after a sanctioned deploy/apply.
 *
 * Without this, a migration applied through the tool's own pipeline writes only
 * to the target's `script_patch` ledger and NEVER updates `lineage_migrations` —
 * so the next drift check compares the live (just-changed) structure against the
 * stale pre-deploy baseline and reports the tool's own deploy as "drift"
 * (issue #12). Here we capture the post-apply structure as the new expected
 * baseline and append a lineage node + in-sync marker.
 *
 * Best-effort by contract: the migration has already committed on the target, so
 * callers MUST treat a thrown error / `advanced:false` as non-fatal and still
 * report the apply as successful. Returns `advanced:false` (no work) when the
 * (connection, schema) pair isn't tracked — untracked schemas have no lineage.
 */
export async function recordAppliedMigrationToLineage(params: {
  connectionId: number;
  schemaName: string;
  targetConfig: ClientConfig;
  changeLevel: ChangeLevel;
  name: string;
  sqlRef: string | null;
}): Promise<{ advanced: boolean; reason?: string; seq?: number; version?: string }> {
  const { connectionId, schemaName, targetConfig, changeLevel, name, sqlRef } = params;
  await syncMetadataTables();

  // Only tracked schemas have a lineage to advance. Cheap metadata lookup first,
  // so an apply to an untracked schema skips the extra introspection round-trip.
  const tracked = await findTrackedSchema(connectionId, schemaName);
  if (!tracked) return { advanced: false, reason: "not tracked" };
  const trackedSchemaId = tracked.trackedSchemaId;

  // Only auto-advance when the schema is KNOWN CLEAN: last recorded status is
  // 'in_sync', or null (freshly tracked, baseline just captured). Any other status
  // ('drifted', or 'unreachable' — a check that couldn't confirm the state) means
  // we can't be sure the live structure is only the sanctioned change, so adopting
  // it as the new baseline could silently absorb unreviewed/unauthorized drift and
  // mark it in_sync forever. Leave it visible instead; the deploy still applied.
  if (tracked.driftStatus !== null && tracked.driftStatus !== "in_sync") {
    return { advanced: false, reason: `not auto-advancing: last drift status is '${tracked.driftStatus}', not in_sync` };
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Serialize lineage writes for this schema so a deploy and a concurrent
    // rebaseline can't both compute the same next seq and collide on the
    // UNIQUE (tracked_schema_id, seq) constraint.
    await client.query(`SELECT pg_advisory_xact_lock($1)`, [trackedSchemaId]);

    // Capture the post-apply structure UNDER the lock, so snapshot recency is
    // monotonic with seq allocation: two concurrent applies can't interleave such
    // that a lower-seq entry ends up holding a newer snapshot than HEAD.
    const live = await fetchSchemaSnapshot(targetConfig, schemaName);
    if (!live.ok) {
      await client.query("ROLLBACK");
      return { advanced: false, reason: `snapshot failed: ${live.error}` };
    }
    const tableCount = live.data.tables.length;

    const head = await client.query<{ version: string | null; seq: number | null }>(
      `SELECT version, seq FROM lineage_migrations
       WHERE tracked_schema_id = $1 ORDER BY seq DESC LIMIT 1`,
      [trackedSchemaId]
    );
    const headVersion = head.rows[0]?.version ?? null;
    const headSeq = head.rows[0]?.seq ?? 0;
    const nextSeq = headSeq + 1;
    const nextVersion = getNextLineageVersion(headVersion, changeLevel);

    const snap = await client.query<{ id: number }>(
      `INSERT INTO snapshots (tracked_schema_id, snapshot, table_count, label)
       VALUES ($1, $2::jsonb, $3, 'deploy') RETURNING id`,
      [trackedSchemaId, JSON.stringify(live.data), tableCount]
    );
    const snapshotId = snap.rows[0].id;

    await client.query(
      `INSERT INTO lineage_migrations
         (tracked_schema_id, seq, name, change_level, version, sql_ref, snapshot_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [trackedSchemaId, nextSeq, name.slice(0, 200), changeLevel, nextVersion, sqlRef, snapshotId]
    );

    const counts: DriftCounts = {
      tablesAdded: 0,
      tablesRemoved: 0,
      tablesChanged: 0,
      constraintsChanged: 0,
      objectsChanged: 0,
    };
    await client.query(
      `INSERT INTO drift_events
         (tracked_schema_id, status, summary, detail, baseline_snapshot_id, source)
       VALUES ($1, 'in_sync', $2, $3::jsonb, $4, 'deploy')`,
      [
        trackedSchemaId,
        `Deploy applied — ${buildDriftSummary(nextVersion, counts)}`,
        JSON.stringify(counts),
        snapshotId,
      ]
    );

    await client.query("COMMIT");
    return { advanced: true, seq: nextSeq, version: nextVersion };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// ── Schema-detail read model (Phase 8 — /schemas/[id]) ─────────────────────

/** Compact, display-ready summary of one captured snapshot. */
export type SnapshotSummary = {
  snapshotId: number;
  /** Label given when captured, e.g. "baseline". */
  label: string | null;
  tableCount: number;
  columnCount: number;
  constraintCount: number;
  /**
   * The object categories the comparison engine also reads. Each one is null
   * when the snapshot holds no record of that category at all, which is a
   * different thing from zero: snapshots captured before this app learned to
   * read indexes, views, sequences, types and routines are still sitting in
   * lineage_snapshots, and reporting them as "0 views" would tell somebody
   * reading an old baseline that the schema had none.
   */
  indexCount: number | null;
  triggerCount: number | null;
  viewCount: number | null;
  sequenceCount: number | null;
  typeCount: number | null;
  routineCount: number | null;
  /** Table names, for a short "what's inside" peek. */
  tableNames: string[];
  capturedAt: string;
};

/** One migration on a tracked schema's lineage, with its resulting snapshot. */
export type LineageNode = {
  id: number;
  seq: number;
  name: string;
  changeLevel: ChangeLevel;
  version: string;
  /** Reference to the SQL script (e.g. a GitHub path) — not the SQL text. */
  sqlRef: string | null;
  createdAt: string;
  /** seq 1 is the captured baseline (no migration script of its own). */
  isBaseline: boolean;
  /** The schema as it looked after this migration. Null if the row is missing. */
  snapshot: SnapshotSummary | null;
};

/** The connection a tracked schema points at — null once it's been deleted. */
export type LineageConnection = {
  id: number;
  name: string;
  host: string;
  port: number;
  database: string;
  type: string;
};

/** Everything the /schemas/[id] screen needs, in one read. */
export type LineageDetail = {
  trackedSchemaId: number;
  schemaName: string;
  label: string | null;
  environment: Environment;
  createdAt: string;
  connection: LineageConnection | null;
  headSeq: number | null;
  headVersion: string | null;
  /** Newest migration first (seq DESC). */
  migrations: LineageNode[];
  /** Latest drift check, or null if one has never run. */
  drift: {
    status: DriftStatus;
    summary: string | null;
    detail: unknown;
    detectedAt: string;
  } | null;
  /** How often the scheduler re-checks this schema; 0 is manual only. */
  driftIntervalMinutes: number;
};

/**
 * Reduce a full SchemaSnapshot to the counts + table names the detail screen
 * shows. Defensive about the JSONB shape (an older or partial snapshot may be
 * missing arrays), matching the "normalize DB output before using it" rule.
 */
function summarizeSnapshot(snap: SchemaSnapshot | null | undefined): {
  tableCount: number;
  columnCount: number;
  constraintCount: number;
  indexCount: number | null;
  triggerCount: number | null;
  viewCount: number | null;
  sequenceCount: number | null;
  typeCount: number | null;
  routineCount: number | null;
  tableNames: string[];
} {
  const tables = Array.isArray(snap?.tables) ? snap.tables : [];
  let columnCount = 0;
  let constraintCount = 0;
  const tableNames: string[] = [];

  // Table-scoped object counts. Both start null and only become numbers once a
  // table is found that actually carries the array, so a snapshot written
  // before the engine read indexes reports "not recorded" rather than "none".
  let indexCount: number | null = null;
  let triggerCount: number | null = null;

  for (const t of tables) {
    tableNames.push(typeof t?.name === "string" ? t.name : "(unnamed)");
    columnCount += Array.isArray(t?.columns) ? t.columns.length : 0;
    if (t?.primaryKey) constraintCount += 1;
    constraintCount += Array.isArray(t?.uniqueConstraints) ? t.uniqueConstraints.length : 0;
    constraintCount += Array.isArray(t?.foreignKeys) ? t.foreignKeys.length : 0;
    constraintCount += Array.isArray(t?.checkConstraints) ? t.checkConstraints.length : 0;
    constraintCount += Array.isArray(t?.excludeConstraints) ? t.excludeConstraints.length : 0;
    if (Array.isArray(t?.indexes)) indexCount = (indexCount ?? 0) + t.indexes.length;
    if (Array.isArray(t?.triggers)) triggerCount = (triggerCount ?? 0) + t.triggers.length;
  }

  return {
    tableCount: tables.length,
    columnCount,
    constraintCount,
    indexCount,
    triggerCount,
    viewCount: countRecorded(snap?.views),
    sequenceCount: countRecorded(snap?.sequences),
    typeCount: countRecorded(snap?.types),
    routineCount: countRecorded(snap?.routines),
    tableNames,
  };
}

/** Length of a schema-scoped collection, or null when it was never recorded. */
function countRecorded(items: unknown): number | null {
  return Array.isArray(items) ? items.length : null;
}

/**
 * Load the full lineage detail for one tracked schema: its connection (or null
 * if removed), every migration newest-first with a summary of the snapshot it
 * produced, and the latest drift check. Returns null when the id isn't tracked,
 * so the page can show a clean "not found" instead of crashing. Read-only and
 * safe to call directly from a server component (mirrors `findTrackedSchema`).
 */
export async function getLineageDetail(
  trackedSchemaId: number
): Promise<LineageDetail | null> {
  await syncMetadataTables();

  // ── 1. The tracked schema + its connection (LEFT JOIN: may be deleted) ─────
  const head = await pool.query<{
    id: number;
    schema_name: string;
    label: string | null;
    environment: string | null;
    drift_check_interval_minutes: number | null;
    created_at: string;
    connection_id: number;
    connection_name: string | null;
    connection_host: string | null;
    connection_port: number | null;
    connection_database: string | null;
    connection_type: string | null;
  }>(
    `SELECT
       ts.id, ts.schema_name, ts.label, ts.environment, ts.created_at, ts.connection_id,
       ts.drift_check_interval_minutes,
       c.name          AS connection_name,
       c.host          AS connection_host,
       c.port          AS connection_port,
       c.database_name AS connection_database,
       c.type          AS connection_type
     FROM tracked_schemas ts
     LEFT JOIN connections c ON c.id = ts.connection_id
     WHERE ts.id = $1`,
    [trackedSchemaId]
  );
  if (head.rows.length === 0) return null;
  const ts = head.rows[0];

  const connection: LineageConnection | null =
    ts.connection_name !== null
      ? {
          id: ts.connection_id,
          name: ts.connection_name,
          host: ts.connection_host ?? "",
          port: ts.connection_port ?? 5432,
          database: ts.connection_database ?? "",
          type: ts.connection_type ?? "",
        }
      : null;

  // ── 2. Lineage migrations, newest first, each with its snapshot ────────────
  const migRows = await pool.query<{
    id: number;
    seq: number;
    name: string;
    change_level: ChangeLevel;
    version: string;
    sql_ref: string | null;
    created_at: string;
    snapshot_id: number | null;
    snapshot_label: string | null;
    snapshot_captured_at: string | null;
    snapshot: SchemaSnapshot | null;
  }>(
    `SELECT
       lm.id, lm.seq, lm.name, lm.change_level, lm.version, lm.sql_ref, lm.created_at,
       s.id          AS snapshot_id,
       s.label       AS snapshot_label,
       s.captured_at AS snapshot_captured_at,
       s.snapshot    AS snapshot
     FROM lineage_migrations lm
     LEFT JOIN snapshots s ON s.id = lm.snapshot_id
     WHERE lm.tracked_schema_id = $1
     ORDER BY lm.seq DESC`,
    [trackedSchemaId]
  );

  const migrations: LineageNode[] = migRows.rows.map((m) => {
    const summary =
      m.snapshot_id !== null
        ? {
            snapshotId: m.snapshot_id,
            label: m.snapshot_label,
            capturedAt: m.snapshot_captured_at ?? m.created_at,
            ...summarizeSnapshot(m.snapshot),
          }
        : null;
    return {
      id: m.id,
      seq: m.seq,
      name: m.name,
      changeLevel: m.change_level,
      version: m.version,
      sqlRef: m.sql_ref,
      createdAt: m.created_at,
      isBaseline: m.seq === 1,
      snapshot: summary,
    };
  });

  // ── 3. Latest drift check (null until one has run) ─────────────────────────
  const drift = await pool.query<{
    status: DriftStatus;
    summary: string | null;
    detail: unknown;
    detected_at: string;
  }>(
    `SELECT status, summary, detail, detected_at
     FROM drift_events
     WHERE tracked_schema_id = $1
     ORDER BY detected_at DESC, id DESC
     LIMIT 1`,
    [trackedSchemaId]
  );

  return {
    trackedSchemaId: ts.id,
    schemaName: ts.schema_name,
    label: ts.label,
    environment: toEnvironment(ts.environment),
    createdAt: ts.created_at,
    connection,
    headSeq: migrations.length > 0 ? migrations[0].seq : null,
    headVersion: migrations.length > 0 ? migrations[0].version : null,
    migrations,
    drift:
      drift.rows.length > 0
        ? {
            status: drift.rows[0].status,
            summary: drift.rows[0].summary,
            detail: drift.rows[0].detail,
            detectedAt: drift.rows[0].detected_at,
          }
        : null,
    driftIntervalMinutes: normalizeDriftInterval(ts.drift_check_interval_minutes),
  };
}

// ── Drift recompute engine (Phase 6B + Phase 9) ────────────────────────────
//
// drift_events store only compact COUNTS, never the full structural report, so
// any screen that needs the actual Expected-vs-Actual diff must recompute it
// live. This is that single, shared recompute: load the EXPECTED snapshot
// (lineage HEAD, else most recent), capture the ACTUAL live structure, and run
// the same `compareSchemas` engine /compare uses. The drift API records the
// result; the drift detail page reads it without recording. One code path, so
// the dashboard, the deploy pre-check, and the drift screen can never disagree.

/** Compact, storable delta counts for a drift check. */
export type DriftCounts = {
  /** Tables present live but not in the expected snapshot. */
  tablesAdded: number;
  /** Tables in the expected snapshot but missing live. */
  tablesRemoved: number;
  tablesChanged: number;
  constraintsChanged: number;
  /** Views, functions, sequences, types, extensions and grants that differ. */
  // Optional because drift_events rows written before this field existed are
  // still in the database as JSONB — read it as `?? 0`, never directly.
  objectsChanged?: number;
};

/** Which lineage entry a drift check compared against. */
export type ExpectedRef = {
  version: string | null;
  seq: number | null;
  snapshotId: number | null;
  /**
   * What generation of the capture wrote that baseline, and what it therefore
   * could not have recorded.
   *
   * A stored snapshot is never rewritten, so a schema tracked a year ago is
   * still being compared against JSON produced by whatever build was running
   * that day. The comparator already refuses to report a category the baseline
   * never recorded (lib/compare.ts), which is the correct behaviour — but it
   * is silent about it, and silence reads as "checked, and clean". This says
   * so out loud instead. See lib/snapshot-format.ts.
   */
  format: SnapshotFormatGap;
};

/** Shared identity carried by every non-"not_found" computation outcome. */
type DriftSubject = {
  schemaName: string;
  label: string | null;
  environment: Environment;
  connection: LineageConnection | null;
  /**
   * How often the scheduler re-checks this schema, in minutes; 0 is manual
   * only. Carried on every outcome, including "unreachable", because a screen
   * that cannot show a result still has to say when the next attempt is.
   */
  driftIntervalMinutes: number;
};

/** Outcome of a live drift recompute — a clean discriminated union. */
export type DriftComputation =
  | { kind: "not_found" }
  | ({ kind: "no_baseline" } & DriftSubject)
  | ({ kind: "unreachable"; summary: string; expected: ExpectedRef } & DriftSubject)
  | ({
      kind: "ok";
      status: "in_sync" | "drifted";
      summary: string;
      counts: DriftCounts;
      report: CompareReport;
      expected: ExpectedRef;
    } & DriftSubject);

/** Turn a version + counts into the one-line summary stored on a drift event. */
export function buildDriftSummary(version: string | null, counts: DriftCounts): string {
  const objectsChanged = counts.objectsChanged ?? 0;
  const total =
    counts.tablesAdded +
    counts.tablesRemoved +
    counts.tablesChanged +
    counts.constraintsChanged +
    objectsChanged;
  if (total === 0) {
    return version
      ? `In sync with v${version} — no structural drift.`
      : "In sync — no structural drift.";
  }
  const parts: string[] = [];
  if (counts.tablesAdded) parts.push(`${counts.tablesAdded} table(s) added`);
  if (counts.tablesRemoved) parts.push(`${counts.tablesRemoved} table(s) removed`);
  if (counts.tablesChanged) parts.push(`${counts.tablesChanged} table(s) changed`);
  if (counts.constraintsChanged) parts.push(`${counts.constraintsChanged} constraint(s) changed`);
  if (objectsChanged) parts.push(`${objectsChanged} view/function/grant change(s)`);
  return `Drift vs v${version ?? "?"}: ${parts.join(", ")}.`;
}

/** Row holding everything needed to reach the live DB + name its connection. */
type TrackedConnRow = {
  schema_name: string;
  label: string | null;
  environment: string | null;
  connection_id: number;
  connection_name: string | null;
  host: string | null;
  port: number | null;
  database_name: string | null;
  type: string | null;
  username: string | null;
  password: string | null;
  connection_string: string | null;
  ssl: boolean | null;
  ssl_mode: string | null;
  drift_check_interval_minutes: number | null;
};

/**
 * Recompute one tracked schema's live drift (Expected snapshot ↔ Actual live).
 * Pure read: never writes a drift_events row — callers that want history do the
 * INSERT themselves. Defensive at every step (missing connection, no baseline,
 * unreachable database) so neither the API nor a server component can crash.
 */
export async function computeDriftDetail(
  trackedSchemaId: number
): Promise<DriftComputation> {
  await syncMetadataTables();

  // 1. Tracked schema + its connection (LEFT JOIN — connection may be deleted).
  // ssl_mode is added lazily, so make sure it exists before selecting it.
  await syncMetadataTables();
  const res = await pool.query<TrackedConnRow>(
    `SELECT
       ts.schema_name, ts.label, ts.environment, ts.connection_id,
       ts.drift_check_interval_minutes,
       c.name AS connection_name, c.host, c.port, c.database_name, c.type,
       c.username, c.password, c.connection_string, c.ssl, c.ssl_mode
     FROM tracked_schemas ts
     LEFT JOIN connections c ON c.id = ts.connection_id
     WHERE ts.id = $1`,
    [trackedSchemaId]
  );
  if (res.rows.length === 0) return { kind: "not_found" };
  const t = res.rows[0];

  const connection: LineageConnection | null =
    t.connection_name !== null
      ? {
          id: t.connection_id,
          name: t.connection_name,
          host: t.host ?? "",
          port: t.port ?? 5432,
          database: t.database_name ?? "",
          type: t.type ?? "",
        }
      : null;
  const subject: DriftSubject = {
    schemaName: t.schema_name,
    label: t.label,
    environment: toEnvironment(t.environment),
    connection,
    driftIntervalMinutes: normalizeDriftInterval(t.drift_check_interval_minutes),
  };

  // 2. The EXPECTED snapshot — lineage HEAD, else the most recent capture.
  let expected: SchemaSnapshot | null = null;
  const ref: ExpectedRef = {
    version: null,
    seq: null,
    snapshotId: null,
    format: snapshotFormatGap(null),
  };
  const head = await pool.query<{ id: number; snapshot: SchemaSnapshot; version: string; seq: number }>(
    `SELECT s.id, s.snapshot, lm.version, lm.seq
     FROM lineage_migrations lm
     JOIN snapshots s ON s.id = lm.snapshot_id
     WHERE lm.tracked_schema_id = $1
     ORDER BY lm.seq DESC
     LIMIT 1`,
    [trackedSchemaId]
  );
  if (head.rows.length > 0) {
    expected = withoutToolTables(head.rows[0].snapshot);
    ref.version = head.rows[0].version;
    ref.seq = head.rows[0].seq;
    ref.snapshotId = head.rows[0].id;
    // Read the format off the row as stored, before withoutToolTables — the
    // spread carries the stamp through, but the question is about what was
    // captured, not about what we chose to compare.
    ref.format = snapshotFormatGap(head.rows[0].snapshot);
  } else {
    const latest = await pool.query<{ id: number; snapshot: SchemaSnapshot }>(
      `SELECT id, snapshot FROM snapshots
       WHERE tracked_schema_id = $1
       ORDER BY captured_at DESC, id DESC LIMIT 1`,
      [trackedSchemaId]
    );
    if (latest.rows.length > 0) {
      expected = withoutToolTables(latest.rows[0].snapshot);
      ref.snapshotId = latest.rows[0].id;
      ref.format = snapshotFormatGap(latest.rows[0].snapshot);
    }
  }
  if (!expected) return { kind: "no_baseline", ...subject };

  // 3. Reach the live database. A removed/non-PostgreSQL connection is a normal
  //    "unreachable" state, not an error.
  if (!t.connection_name || t.type !== "PostgreSQL") {
    return {
      kind: "unreachable",
      ...subject,
      expected: ref,
      summary: t.connection_name
        ? "Connection is not a PostgreSQL database."
        : "The connection for this tracked schema has been removed.",
    };
  }

  const cfg = buildPgConfig({
    host: t.host,
    port: t.port,
    database: t.database_name,
    user: t.username,
    password: t.password,
    connectionString: t.connection_string,
    ssl: Boolean(t.ssl),
    sslMode: t.ssl_mode,
  });
  const live = await fetchSchemaSnapshot(cfg, t.schema_name);
  if (!live.ok) {
    return {
      kind: "unreachable",
      ...subject,
      expected: ref,
      summary: `Could not read live schema "${t.schema_name}" on "${t.connection_name}": ${live.error}`,
    };
  }

  // 4. Compare EXPECTED (left) vs ACTUAL live (right) and classify.
  const report = compareSchemas(expected, live.data);
  const s = report.summary;
  const counts: DriftCounts = {
    tablesAdded: s.tablesOnlyInB,
    tablesRemoved: s.tablesOnlyInA,
    tablesChanged: s.changedTables,
    constraintsChanged: s.changedConstraints,
    objectsChanged: report.objectDiffs.length,
  };
  // A dropped view is drift. Counting only tables and constraints let the hero
  // say "matches v3" directly above a card listing the view that went missing.
  const drifted =
    counts.tablesAdded > 0 ||
    counts.tablesRemoved > 0 ||
    counts.tablesChanged > 0 ||
    counts.constraintsChanged > 0 ||
    (counts.objectsChanged ?? 0) > 0;

  return {
    kind: "ok",
    ...subject,
    expected: ref,
    status: drifted ? "drifted" : "in_sync",
    counts,
    report,
    summary: buildDriftSummary(ref.version, counts),
  };
}

/** Everything the /drift detail tab needs for one tracked schema, in one read. */
export type DriftDetailView = {
  trackedSchemaId: number;
  schemaName: string;
  label: string | null;
  environment: Environment;
  connection: LineageConnection | null;
  /** The lineage entry the live structure was compared against. */
  expected: ExpectedRef;
  /** Outcome of the live recompute (computed now, never stale). */
  state: "drifted" | "in_sync" | "unreachable" | "no_baseline";
  summary: string;
  counts: DriftCounts | null;
  /** Full Expected-vs-Actual report — null when there is nothing to diff. */
  report: CompareReport | null;
  /** How often the scheduler re-checks this schema; 0 is manual only. */
  driftIntervalMinutes: number;
  /** The last drift check actually recorded (audit), null until one has run. */
  lastRecorded: {
    status: DriftStatus;
    detectedAt: string;
    acknowledgedAt: string | null;
  } | null;
};

/**
 * Read model for the drift detail screen. Runs a live recompute (so the diff is
 * always current) and pairs it with the last recorded drift_event for the
 * "last checked / acknowledged" line. Returns null only when the id isn't
 * tracked, so the page shows a clean not-found instead of crashing.
 */
export async function getDriftDetail(
  trackedSchemaId: number
): Promise<DriftDetailView | null> {
  const comp = await computeDriftDetail(trackedSchemaId);
  if (comp.kind === "not_found") return null;

  const rec = await pool.query<{
    status: DriftStatus;
    detected_at: string;
    acknowledged_at: string | null;
  }>(
    `SELECT status, detected_at, acknowledged_at
     FROM drift_events
     WHERE tracked_schema_id = $1
     ORDER BY detected_at DESC, id DESC
     LIMIT 1`,
    [trackedSchemaId]
  );
  const lastRecorded =
    rec.rows.length > 0
      ? {
          status: rec.rows[0].status,
          detectedAt: rec.rows[0].detected_at,
          acknowledgedAt: rec.rows[0].acknowledged_at,
        }
      : null;

  const base = {
    trackedSchemaId,
    schemaName: comp.schemaName,
    label: comp.label,
    environment: comp.environment,
    connection: comp.connection,
    driftIntervalMinutes: comp.driftIntervalMinutes,
    lastRecorded,
  };
  const noRef: ExpectedRef = {
    version: null,
    seq: null,
    snapshotId: null,
    format: snapshotFormatGap(null),
  };

  if (comp.kind === "no_baseline") {
    return {
      ...base,
      expected: noRef,
      state: "no_baseline",
      summary: "This tracked schema has no baseline snapshot to compare against.",
      counts: null,
      report: null,
    };
  }
  if (comp.kind === "unreachable") {
    return {
      ...base,
      expected: comp.expected,
      state: "unreachable",
      summary: comp.summary,
      counts: null,
      report: null,
    };
  }
  return {
    ...base,
    expected: comp.expected,
    state: comp.status,
    summary: comp.summary,
    counts: comp.counts,
    report: comp.report,
  };
}

// ── Audit feed (Phase 6B + Phase 9) ────────────────────────────────────────

/** One row in the drift audit feed. */
export type DriftEventFeedItem = {
  id: number;
  trackedSchemaId: number;
  schemaName: string;
  connectionName: string | null;
  status: DriftStatus;
  summary: string | null;
  /** Compact `DriftCounts` JSONB (or null for unreachable checks). */
  detail: unknown;
  detectedAt: string;
  /** Set when the event was acknowledged by a human (Phase 9). */
  acknowledgedAt: string | null;
  /** What ran this check — a person, the scheduler, a deploy. */
  source: DriftSource;
};

type DriftEventFeedRow = {
  id: number;
  tracked_schema_id: number;
  schema_name: string;
  connection_name: string | null;
  status: DriftStatus;
  summary: string | null;
  detail: unknown;
  detected_at: string;
  acknowledged_at: string | null;
  source: string | null;
};

/**
 * Drift check history, newest first. Pass a `trackedSchemaId` to scope it to one
 * schema (the detail screen's mini-history), or omit it for the full audit log.
 * Read-only; safe from a server component or an API route.
 */
export async function listDriftEvents(
  trackedSchemaId?: number | null,
  limit = 200
): Promise<DriftEventFeedItem[]> {
  await syncMetadataTables();

  const scoped = typeof trackedSchemaId === "number" && Number.isFinite(trackedSchemaId);
  const where = scoped ? "WHERE de.tracked_schema_id = $1" : "";
  const params = scoped ? [trackedSchemaId, limit] : [limit];

  const result = await pool.query<DriftEventFeedRow>(
    `SELECT
       de.id, de.tracked_schema_id, de.status, de.summary, de.detail,
       de.detected_at, de.acknowledged_at, de.source,
       ts.schema_name,
       c.name AS connection_name
     FROM drift_events de
     JOIN tracked_schemas ts ON ts.id = de.tracked_schema_id
     LEFT JOIN connections c ON c.id = ts.connection_id
     ${where}
     ORDER BY de.detected_at DESC, de.id DESC
     LIMIT ${scoped ? "$2" : "$1"}`,
    params
  );

  return result.rows.map((r) => ({
    id: r.id,
    trackedSchemaId: r.tracked_schema_id,
    schemaName: r.schema_name,
    connectionName: r.connection_name,
    status: r.status,
    summary: r.summary,
    detail: r.detail,
    detectedAt: r.detected_at,
    acknowledgedAt: r.acknowledged_at,
    source: toDriftSource(r.source),
  }));
}

// ── Tracked-schema list (Phase 7 + Phase 9) ────────────────────────────────

/** One tracked schema as the dashboard / drift selector needs it. */
export type TrackedSchemaListItem = {
  id: number;
  connectionId: number;
  schemaName: string;
  label: string | null;
  /**
   * dev / staging / prod for this schema. Read through toEnvironment, so rows
   * written before the column existed come back "unset" rather than looking
   * like a target somebody has actually vouched for.
   */
  environment: Environment;
  createdAt: string;
  /** Null when the underlying connection has been deleted. */
  connectionName: string | null;
  connectionHost: string | null;
  connectionDatabase: string | null;
  /** Lineage HEAD (highest seq) — null only if lineage is somehow empty. */
  headVersion: string | null;
  headSeq: number | null;
  migrationCount: number;
  /** Latest recorded drift result. Null until a check has run. */
  driftStatus: DriftStatus | null;
  driftSummary: string | null;
  driftCheckedAt: string | null;
  /**
   * How often the scheduler re-checks this schema, in minutes; 0 is manual
   * only. Read through normalizeDriftInterval so a value written by an older
   * build lands on a cadence the picker can actually show.
   */
  driftIntervalMinutes: number;
  /**
   * When a check last RAN, which is not the same as when a result was last
   * recorded: a scheduled check that finds nothing new writes no event row, on
   * purpose, so the audit log stays readable. Without this the dashboard would
   * say "checked 4 hours ago" about a schema being looked at every fifteen
   * minutes. Null on a row that has only ever been checked by an older build.
   */
  lastCheckedAt: string | null;
};

type TrackedListRow = {
  id: number;
  connection_id: number;
  schema_name: string;
  label: string | null;
  environment: string | null;
  drift_check_interval_minutes: number | null;
  created_at: string;
  connection_name: string | null;
  connection_host: string | null;
  connection_database: string | null;
  head_version: string | null;
  head_seq: number | null;
  migration_count: number;
  drift_status: DriftStatus | null;
  drift_summary: string | null;
  drift_checked_at: string | null;
  last_drift_check_at: string | null;
};

/**
 * List every tracked schema with its lineage HEAD and latest recorded drift —
 * the cheap metadata read behind both the dashboard grid and the drift schema
 * picker. Uses LATERAL joins so each schema gets exactly its own HEAD + newest
 * drift row. Read-only; safe from a server component or an API route.
 */
export async function listTrackedSchemas(): Promise<TrackedSchemaListItem[]> {
  await syncMetadataTables();

  const result = await pool.query<TrackedListRow>(`
    SELECT
      ts.id,
      ts.connection_id,
      ts.schema_name,
      ts.label,
      ts.environment,
      ts.drift_check_interval_minutes,
      ts.last_drift_check_at,
      ts.created_at,
      c.name           AS connection_name,
      c.host           AS connection_host,
      c.database_name  AS connection_database,
      head.version     AS head_version,
      head.seq         AS head_seq,
      COALESCE(counts.migration_count, 0) AS migration_count,
      drift.status     AS drift_status,
      drift.summary    AS drift_summary,
      drift.detected_at AS drift_checked_at
    FROM tracked_schemas ts
    LEFT JOIN connections c ON c.id = ts.connection_id
    LEFT JOIN LATERAL (
      SELECT version, seq
      FROM lineage_migrations lm
      WHERE lm.tracked_schema_id = ts.id
      ORDER BY lm.seq DESC
      LIMIT 1
    ) head ON TRUE
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int AS migration_count
      FROM lineage_migrations lm
      WHERE lm.tracked_schema_id = ts.id
    ) counts ON TRUE
    LEFT JOIN LATERAL (
      SELECT status, summary, detected_at
      FROM drift_events de
      WHERE de.tracked_schema_id = ts.id
      ORDER BY de.detected_at DESC, de.id DESC
      LIMIT 1
    ) drift ON TRUE
    ORDER BY ts.created_at DESC, ts.id DESC
  `);

  return result.rows.map((r) => ({
    id: r.id,
    connectionId: r.connection_id,
    schemaName: r.schema_name,
    label: r.label,
    environment: toEnvironment(r.environment),
    createdAt: r.created_at,
    connectionName: r.connection_name,
    connectionHost: r.connection_host,
    connectionDatabase: r.connection_database,
    headVersion: r.head_version,
    headSeq: r.head_seq,
    migrationCount: r.migration_count,
    driftStatus: r.drift_status,
    driftSummary: r.drift_summary,
    driftCheckedAt: r.drift_checked_at,
    driftIntervalMinutes: normalizeDriftInterval(r.drift_check_interval_minutes),
    lastCheckedAt: r.last_drift_check_at,
  }));
}

/** What a connection would leave behind if it were deleted right now. */
export type ConnectionDependents = {
  /** Tracked schemas pointing at this connection. */
  trackedSchemas: number;
  /** Their schema names, for showing in the confirm dialog. */
  schemaNames: string[];
  /** Snapshots hanging off those tracked schemas (cascade-deleted with them). */
  snapshots: number;
  /** Saved comparison sets that use this connection as their source or a target. */
  comparisonSets: number;
  /** Their names, for showing in the confirm dialog. */
  comparisonSetNames: string[];
};

/**
 * Count what depends on a connection, so DELETE can say what it is about to
 * orphan instead of silently doing it.
 *
 * There is deliberately no foreign key from `tracked_schemas` to `connections`
 * (see lib/db/models.ts) — orphans are a supported state and every
 * reader LEFT JOINs and degrades to "unreachable". That design decision is kept;
 * what changes is that the user is now told the number before they confirm.
 */
export async function getConnectionDependents(
  connectionId: number
): Promise<ConnectionDependents> {
  await syncMetadataTables();

  // Saved comparison sets are not lineage, but "what depends on this
  // connection?" is one question and the dialog asks it once. Counting them
  // here keeps the route to a single call, and comparison-sets does not import
  // this module, so the direction stays one way.
  const comparisonSetNames = await listSetNamesUsingConnection(connectionId);

  const tracked = await pool.query<{ id: number; schema_name: string }>(
    `SELECT id, schema_name FROM tracked_schemas WHERE connection_id = $1 ORDER BY schema_name`,
    [connectionId]
  );

  if (tracked.rows.length === 0) {
    return {
      trackedSchemas: 0,
      schemaNames: [],
      snapshots: 0,
      comparisonSets: comparisonSetNames.length,
      comparisonSetNames,
    };
  }

  const ids = tracked.rows.map((r) => r.id);
  const snapshots = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM snapshots WHERE tracked_schema_id = ANY($1::int[])`,
    [ids]
  );

  return {
    trackedSchemas: tracked.rows.length,
    schemaNames: tracked.rows.map((r) => r.schema_name),
    snapshots: Number(snapshots.rows[0]?.count ?? 0),
    comparisonSets: comparisonSetNames.length,
    comparisonSetNames,
  };
}
