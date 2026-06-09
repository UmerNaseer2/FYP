import { fetchSchemaSnapshot, type SchemaSnapshot } from "./postgres";
import { buildPgConfig } from "./connection-config";
import { compareSchemas } from "./compare";
import type { CompareReport } from "./compare-types";
import type { ChangeLevel } from "./version-detection";
import pool, { ensureMetadataSchema } from "./version-db";

/**
 * Phase 6 metadata store — "schema lineage".
 *
 * Everything here lives in the SAME Postgres metadata database as `connections`
 * and `schema_comparisons` (the `DATABASE_URL_A` pool from `version-db`), using
 * the same `ensureMetadataSchema()` + `CREATE TABLE IF NOT EXISTS` pattern. We
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
  created_at: string;
};

export type SnapshotRow = {
  id: number;
  tracked_schema_id: number;
  snapshot: SchemaSnapshot;
  table_count: number;
  label: string | null;
  captured_at: string;
};

export type LineageMigrationRow = {
  id: number;
  tracked_schema_id: number;
  seq: number;
  name: string;
  change_level: ChangeLevel;
  version: string;
  /** Reference to the SQL (e.g. a GitHub script path) — not the SQL itself. */
  sql_ref: string | null;
  /** The snapshot that represents the schema AFTER this migration. */
  snapshot_id: number | null;
  created_at: string;
};

export type DriftStatus = "in_sync" | "drifted" | "unreachable";

export type DriftEventRow = {
  id: number;
  tracked_schema_id: number;
  status: DriftStatus;
  summary: string | null;
  /** Compact delta counts (added/removed/changed) — for the audit feed. */
  detail: unknown;
  baseline_snapshot_id: number | null;
  detected_at: string;
  /** Set when a human marks this drift event reviewed (Phase 9). Null otherwise. */
  acknowledged_at: string | null;
};

// ── Schema setup ──────────────────────────────────────────────────────────

/**
 * Create the lineage tables if they don't exist. Idempotent and cheap, so call
 * it at the top of every lineage route (mirrors how the connections route calls
 * `createConnectionsTable()`).
 *
 * Note: we intentionally do NOT add a hard foreign key from `tracked_schemas`
 * to `connections`. Connections are hard-deleted elsewhere, and we don't want
 * the create order of the two tables to matter; instead the list query
 * LEFT JOINs `connections` and surfaces a removed connection as "unreachable".
 * The internal foreign keys (everything → tracked_schemas) DO cascade, so
 * untracking a schema cleanly removes its snapshots, lineage and drift events.
 */
export async function ensureLineageTables(): Promise<void> {
  await ensureMetadataSchema();

  await pool.query(`
    CREATE TABLE IF NOT EXISTS tracked_schemas (
      id SERIAL PRIMARY KEY,
      connection_id INTEGER NOT NULL,
      schema_name TEXT NOT NULL,
      label TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (connection_id, schema_name)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS snapshots (
      id SERIAL PRIMARY KEY,
      tracked_schema_id INTEGER NOT NULL
        REFERENCES tracked_schemas(id) ON DELETE CASCADE,
      snapshot JSONB NOT NULL,
      table_count INTEGER NOT NULL DEFAULT 0,
      label TEXT,
      captured_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS lineage_migrations (
      id SERIAL PRIMARY KEY,
      tracked_schema_id INTEGER NOT NULL
        REFERENCES tracked_schemas(id) ON DELETE CASCADE,
      seq INTEGER NOT NULL,
      name TEXT NOT NULL,
      change_level TEXT NOT NULL,
      version TEXT NOT NULL,
      sql_ref TEXT,
      snapshot_id INTEGER REFERENCES snapshots(id) ON DELETE SET NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (tracked_schema_id, seq)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS drift_events (
      id SERIAL PRIMARY KEY,
      tracked_schema_id INTEGER NOT NULL
        REFERENCES tracked_schemas(id) ON DELETE CASCADE,
      status TEXT NOT NULL,
      summary TEXT,
      detail JSONB,
      baseline_snapshot_id INTEGER REFERENCES snapshots(id) ON DELETE SET NULL,
      detected_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Phase 9 — an additive "acknowledged" marker on a drift event. Run as a
  // separate ADD COLUMN IF NOT EXISTS so existing drift_events tables pick it up
  // without a migration; it stays idempotent and cheap alongside the creates.
  await pool.query(
    `ALTER TABLE drift_events ADD COLUMN IF NOT EXISTS acknowledged_at TIMESTAMP`
  );
}

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
};

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
  await ensureLineageTables();
  const result = await pool.query<{
    id: number;
    head_version: string | null;
    drift_status: DriftStatus | null;
  }>(
    `SELECT
       ts.id,
       head.version AS head_version,
       drift.status AS drift_status
     FROM tracked_schemas ts
     LEFT JOIN LATERAL (
       SELECT version FROM lineage_migrations lm
       WHERE lm.tracked_schema_id = ts.id
       ORDER BY lm.seq DESC LIMIT 1
     ) head ON TRUE
     LEFT JOIN LATERAL (
       SELECT status FROM drift_events de
       WHERE de.tracked_schema_id = ts.id
       ORDER BY de.detected_at DESC, de.id DESC LIMIT 1
     ) drift ON TRUE
     WHERE ts.connection_id = $1 AND ts.schema_name = $2
     LIMIT 1`,
    [connectionId, schemaName]
  );
  if (result.rows.length === 0) return null;
  const r = result.rows[0];
  return {
    trackedSchemaId: r.id,
    headVersion: r.head_version,
    driftStatus: r.drift_status,
  };
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
  tableNames: string[];
} {
  const tables = Array.isArray(snap?.tables) ? snap.tables : [];
  let columnCount = 0;
  let constraintCount = 0;
  const tableNames: string[] = [];

  for (const t of tables) {
    tableNames.push(typeof t?.name === "string" ? t.name : "(unnamed)");
    columnCount += Array.isArray(t?.columns) ? t.columns.length : 0;
    if (t?.primaryKey) constraintCount += 1;
    constraintCount += Array.isArray(t?.uniqueConstraints) ? t.uniqueConstraints.length : 0;
    constraintCount += Array.isArray(t?.foreignKeys) ? t.foreignKeys.length : 0;
    constraintCount += Array.isArray(t?.checkConstraints) ? t.checkConstraints.length : 0;
    constraintCount += Array.isArray(t?.excludeConstraints) ? t.excludeConstraints.length : 0;
  }

  return { tableCount: tables.length, columnCount, constraintCount, tableNames };
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
  await ensureLineageTables();

  // ── 1. The tracked schema + its connection (LEFT JOIN: may be deleted) ─────
  const head = await pool.query<{
    id: number;
    schema_name: string;
    label: string | null;
    created_at: string;
    connection_id: number;
    connection_name: string | null;
    connection_host: string | null;
    connection_port: number | null;
    connection_database: string | null;
    connection_type: string | null;
  }>(
    `SELECT
       ts.id, ts.schema_name, ts.label, ts.created_at, ts.connection_id,
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
};

/** Which lineage entry a drift check compared against. */
export type ExpectedRef = {
  version: string | null;
  seq: number | null;
  snapshotId: number | null;
};

/** Shared identity carried by every non-"not_found" computation outcome. */
type DriftSubject = {
  schemaName: string;
  label: string | null;
  connection: LineageConnection | null;
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
  const total =
    counts.tablesAdded + counts.tablesRemoved + counts.tablesChanged + counts.constraintsChanged;
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
  return `Drift vs v${version ?? "?"}: ${parts.join(", ")}.`;
}

/** Row holding everything needed to reach the live DB + name its connection. */
type TrackedConnRow = {
  schema_name: string;
  label: string | null;
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
  await ensureLineageTables();

  // 1. Tracked schema + its connection (LEFT JOIN — connection may be deleted).
  const res = await pool.query<TrackedConnRow>(
    `SELECT
       ts.schema_name, ts.label, ts.connection_id,
       c.name AS connection_name, c.host, c.port, c.database_name, c.type,
       c.username, c.password, c.connection_string, c.ssl
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
  const subject: DriftSubject = { schemaName: t.schema_name, label: t.label, connection };

  // 2. The EXPECTED snapshot — lineage HEAD, else the most recent capture.
  let expected: SchemaSnapshot | null = null;
  const ref: ExpectedRef = { version: null, seq: null, snapshotId: null };
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
    expected = head.rows[0].snapshot;
    ref.version = head.rows[0].version;
    ref.seq = head.rows[0].seq;
    ref.snapshotId = head.rows[0].id;
  } else {
    const latest = await pool.query<{ id: number; snapshot: SchemaSnapshot }>(
      `SELECT id, snapshot FROM snapshots
       WHERE tracked_schema_id = $1
       ORDER BY captured_at DESC, id DESC LIMIT 1`,
      [trackedSchemaId]
    );
    if (latest.rows.length > 0) {
      expected = latest.rows[0].snapshot;
      ref.snapshotId = latest.rows[0].id;
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
  };
  const drifted =
    counts.tablesAdded > 0 ||
    counts.tablesRemoved > 0 ||
    counts.tablesChanged > 0 ||
    counts.constraintsChanged > 0;

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
  connection: LineageConnection | null;
  /** The lineage entry the live structure was compared against. */
  expected: ExpectedRef;
  /** Outcome of the live recompute (computed now, never stale). */
  state: "drifted" | "in_sync" | "unreachable" | "no_baseline";
  summary: string;
  counts: DriftCounts | null;
  /** Full Expected-vs-Actual report — null when there is nothing to diff. */
  report: CompareReport | null;
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
    connection: comp.connection,
    lastRecorded,
  };
  const noRef: ExpectedRef = { version: null, seq: null, snapshotId: null };

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
  await ensureLineageTables();

  const scoped = typeof trackedSchemaId === "number" && Number.isFinite(trackedSchemaId);
  const where = scoped ? "WHERE de.tracked_schema_id = $1" : "";
  const params = scoped ? [trackedSchemaId, limit] : [limit];

  const result = await pool.query<DriftEventFeedRow>(
    `SELECT
       de.id, de.tracked_schema_id, de.status, de.summary, de.detail,
       de.detected_at, de.acknowledged_at,
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
  }));
}

// ── Tracked-schema list (Phase 7 + Phase 9) ────────────────────────────────

/** One tracked schema as the dashboard / drift selector needs it. */
export type TrackedSchemaListItem = {
  id: number;
  connectionId: number;
  schemaName: string;
  label: string | null;
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
};

type TrackedListRow = {
  id: number;
  connection_id: number;
  schema_name: string;
  label: string | null;
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
};

/**
 * List every tracked schema with its lineage HEAD and latest recorded drift —
 * the cheap metadata read behind both the dashboard grid and the drift schema
 * picker. Uses LATERAL joins so each schema gets exactly its own HEAD + newest
 * drift row. Read-only; safe from a server component or an API route.
 */
export async function listTrackedSchemas(): Promise<TrackedSchemaListItem[]> {
  await ensureLineageTables();

  const result = await pool.query<TrackedListRow>(`
    SELECT
      ts.id,
      ts.connection_id,
      ts.schema_name,
      ts.label,
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
  }));
}
