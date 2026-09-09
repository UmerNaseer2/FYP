import pool, { syncMetadataTables } from "./version-db";
import { toEnvironment, type Environment } from "./environments";

/**
 * Saved comparison sets — a named source + ordered list of targets that can be
 * re-opened and re-run.
 *
 * A set is an input, saved on purpose, so that "the nightly check: dev, staging
 * and prod against the model schema" is one click instead of six dropdowns
 * every morning. `last_run_at` on the set is the only history kept — the answer
 * to "when did I last run this", which is what the picker shows.
 *
 * Lives in the same metadata database as `connections` and the lineage tables,
 * and is declared with them as a Sequelize model in `lib/db/models.ts`.
 */

/**
 * How many targets one set (and one comparison) may hold.
 *
 * Defined here rather than on the Compare page because the API validates
 * against it too, and a limit the screen enforces but the endpoint does not is
 * not a limit.
 */
export const MAX_COMPARISON_TARGETS = 6;

/** Longest set name we store. Long enough to be descriptive, short enough to fit a dropdown. */
const MAX_NAME_LENGTH = 60;

// ── Row shapes ────────────────────────────────────────────────────────────

export type ComparisonSetTarget = {
  position: number;
  /**
   * The saved connection this target points at, or null if that connection has
   * since been deleted — the foreign key is ON DELETE SET NULL, so the set
   * survives losing one of its members instead of silently shrinking.
   */
  connectionId: number | null;
  /** What the connection was called when the set was saved. Kept so a deleted
   *  connection can still be named on screen ("Prod — RDS", no longer saved). */
  connectionLabel: string;
  schema: string;
  /** The connection's environment *now*, or "unset" if it is gone. */
  environment: Environment;
};

export type ComparisonSet = {
  id: number;
  name: string;
  sourceConnectionId: number | null;
  sourceConnectionLabel: string;
  sourceSchema: string;
  allowDataLoss: boolean;
  createdAt: string;
  updatedAt: string;
  lastRunAt: string | null;
  targets: ComparisonSetTarget[];
};

// ── Reads ─────────────────────────────────────────────────────────────────

type SetRow = {
  id: number;
  name: string;
  source_connection_id: number | null;
  source_connection_label: string | null;
  source_schema: string;
  allow_data_loss: boolean;
  created_at: string;
  updated_at: string;
  last_run_at: string | null;
  live_source_name: string | null;
};

type TargetRow = {
  set_id: number;
  position: number;
  connection_id: number | null;
  connection_label: string | null;
  schema_name: string;
  live_name: string | null;
  live_environment: string | null;
};

/**
 * Prefer the connection's current name over the one saved with the set, so
 * renaming a connection updates every set that uses it. Fall back to the saved
 * label only when the connection is gone, which is the whole reason we keep it.
 */
function label(live: string | null, saved: string | null): string {
  return live ?? saved ?? "Deleted connection";
}

function toSet(row: SetRow, targets: ComparisonSetTarget[]): ComparisonSet {
  return {
    id: row.id,
    name: row.name,
    sourceConnectionId: row.source_connection_id,
    sourceConnectionLabel: label(row.live_source_name, row.source_connection_label),
    sourceSchema: row.source_schema,
    allowDataLoss: row.allow_data_loss,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastRunAt: row.last_run_at,
    targets,
  };
}

const SET_SELECT = `
  SELECT s.id, s.name, s.source_connection_id, s.source_connection_label,
         s.source_schema, s.allow_data_loss, s.created_at, s.updated_at,
         s.last_run_at, c.name AS live_source_name
    FROM comparison_sets s
    LEFT JOIN connections c ON c.id = s.source_connection_id
`;

const TARGET_SELECT = `
  SELECT t.set_id, t.position, t.connection_id, t.connection_label, t.schema_name,
         c.name AS live_name, c.environment AS live_environment
    FROM comparison_set_targets t
    LEFT JOIN connections c ON c.id = t.connection_id
`;

function toTarget(row: TargetRow): ComparisonSetTarget {
  return {
    position: row.position,
    connectionId: row.connection_id,
    connectionLabel: label(row.live_name, row.connection_label),
    schema: row.schema_name,
    environment: toEnvironment(row.live_environment),
  };
}

/** Every saved set, alphabetically, each with its targets in saved order. */
/**
 * Names of the saved sets that point at a connection, either as their source or
 * as one of their targets.
 *
 * Deleting a connection does not delete the sets that use it — the foreign keys
 * are ON DELETE SET NULL and each target keeps the label the connection had —
 * but the set does lose its way to reach that database. The delete dialog says
 * so, and this is what it counts.
 */
export async function listSetNamesUsingConnection(
  connectionId: number
): Promise<string[]> {
  await syncMetadataTables();

  const result = await pool.query<{ name: string }>(
    `SELECT DISTINCT s.name
       FROM comparison_sets s
       LEFT JOIN comparison_set_targets t ON t.set_id = s.id
      WHERE s.source_connection_id = $1 OR t.connection_id = $1
      ORDER BY s.name`,
    [connectionId]
  );

  return result.rows.map((r) => r.name);
}

export async function listComparisonSets(): Promise<ComparisonSet[]> {
  await syncMetadataTables();

  // Two plain queries stitched in JS rather than one query with a JSON
  // aggregate: there are never many sets, and this stays readable.
  const [sets, targets] = await Promise.all([
    pool.query<SetRow>(`${SET_SELECT} ORDER BY lower(s.name)`),
    pool.query<TargetRow>(`${TARGET_SELECT} ORDER BY t.set_id, t.position`),
  ]);

  const byId = new Map<number, ComparisonSetTarget[]>();
  for (const row of targets.rows) {
    const list = byId.get(row.set_id) ?? [];
    list.push(toTarget(row));
    byId.set(row.set_id, list);
  }

  return sets.rows.map((row) => toSet(row, byId.get(row.id) ?? []));
}

/** One set by id, or null if it has been deleted since the link was made. */
export async function getComparisonSet(id: number): Promise<ComparisonSet | null> {
  if (!Number.isInteger(id) || id <= 0) return null;
  await syncMetadataTables();

  const sets = await pool.query<SetRow>(`${SET_SELECT} WHERE s.id = $1`, [id]);
  if (sets.rows.length === 0) return null;

  const targets = await pool.query<TargetRow>(
    `${TARGET_SELECT} WHERE t.set_id = $1 ORDER BY t.position`,
    [id]
  );
  return toSet(sets.rows[0], targets.rows.map(toTarget));
}

// ── Writes ────────────────────────────────────────────────────────────────

export type SaveComparisonSetInput = {
  name: string;
  sourceConnectionId: number;
  sourceConnectionLabel: string;
  sourceSchema: string;
  allowDataLoss: boolean;
  targets: {
    connectionId: number;
    connectionLabel: string;
    schema: string;
  }[];
};

export type SaveResult =
  | { ok: true; set: ComparisonSet; created: boolean }
  | { ok: false; error: string };

/** Reject early with a sentence the user can act on, rather than a constraint violation. */
function validate(input: SaveComparisonSetInput): string | null {
  const name = input.name.trim();
  if (name.length === 0) return "Give the set a name so you can find it again.";
  if (name.length > MAX_NAME_LENGTH) {
    return `Set names are limited to ${MAX_NAME_LENGTH} characters.`;
  }
  if (!Number.isInteger(input.sourceConnectionId) || input.sourceConnectionId <= 0) {
    return "The source needs to be a saved connection before the set can be saved.";
  }
  if (input.sourceSchema.trim().length === 0) {
    return "The source schema is missing.";
  }
  if (input.targets.length === 0) {
    return "A set needs at least one target.";
  }
  if (input.targets.length > MAX_COMPARISON_TARGETS) {
    return `A set can hold at most ${MAX_COMPARISON_TARGETS} targets.`;
  }
  for (const target of input.targets) {
    if (!Number.isInteger(target.connectionId) || target.connectionId <= 0) {
      return "Every target needs to be a saved connection before the set can be saved.";
    }
    if (target.schema.trim().length === 0) {
      return "One of the targets has no schema selected.";
    }
  }
  return null;
}

/**
 * Save a set, replacing one of the same name if it exists.
 *
 * Save and update are one operation on purpose. The alternative — a Save button
 * and a separate Update button — makes the user decide which one they mean
 * before they have thought about it, and gets it wrong often enough to leave
 * "Nightly check" and "Nightly check 2" side by side in the dropdown.
 *
 * The whole thing runs in a transaction because the targets are deleted before
 * they are re-inserted: a failure halfway through would otherwise leave a set
 * with fewer targets than it had before the save.
 */
export async function saveComparisonSet(
  input: SaveComparisonSetInput
): Promise<SaveResult> {
  const problem = validate(input);
  if (problem) return { ok: false, error: problem };

  await syncMetadataTables();

  const name = input.name.trim();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const upsert = await client.query<{ id: number; created: boolean }>(
      // The stored label is what names a side after its connection is deleted,
      // so it must never be blank. A caller that does not send one is not asked
      // to guess: the connection's current name is right here.
      `INSERT INTO comparison_sets
         (name, source_connection_id, source_connection_label, source_schema,
          allow_data_loss)
       VALUES ($1, $2,
               COALESCE(NULLIF($3, ''), (SELECT name FROM connections WHERE id = $2), ''),
               $4, $5)
       ON CONFLICT (lower(name)) DO UPDATE
         SET name = EXCLUDED.name,
             source_connection_id = EXCLUDED.source_connection_id,
             source_connection_label = EXCLUDED.source_connection_label,
             source_schema = EXCLUDED.source_schema,
             allow_data_loss = EXCLUDED.allow_data_loss,
             updated_at = now()
       RETURNING id, (xmax = 0) AS created`,
      [
        name,
        input.sourceConnectionId,
        input.sourceConnectionLabel,
        input.sourceSchema.trim(),
        input.allowDataLoss,
      ]
    );

    const id = upsert.rows[0].id;
    const created = upsert.rows[0].created;

    // Replace rather than reconcile: the target list is short and always sent
    // whole, so working out which rows moved would be more code and more ways
    // to be wrong than deleting three rows and writing three back.
    await client.query(`DELETE FROM comparison_set_targets WHERE set_id = $1`, [id]);

    for (const [position, target] of input.targets.entries()) {
      await client.query(
        `INSERT INTO comparison_set_targets
           (set_id, position, connection_id, connection_label, schema_name)
         VALUES ($1, $2, $3,
                 COALESCE(NULLIF($4, ''), (SELECT name FROM connections WHERE id = $3), ''),
                 $5)`,
        [id, position, target.connectionId, target.connectionLabel, target.schema.trim()]
      );
    }

    await client.query("COMMIT");

    const saved = await getComparisonSet(id);
    return saved
      ? { ok: true, set: saved, created }
      : { ok: false, error: "The set was saved but could not be read back." };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/** Delete a set. Its targets go with it through ON DELETE CASCADE. */
export async function deleteComparisonSet(id: number): Promise<boolean> {
  if (!Number.isInteger(id) || id <= 0) return false;
  await syncMetadataTables();
  const result = await pool.query(`DELETE FROM comparison_sets WHERE id = $1`, [id]);
  return (result.rowCount ?? 0) > 0;
}

/**
 * Stamp a set as run. Called from the Compare page after a comparison that was
 * opened from a set, so the picker can say when each one was last exercised —
 * a set nobody has run for two months is usually a set pointing at a database
 * that no longer exists.
 *
 * Returns the timestamp it wrote so the caller can show it without re-reading:
 * the page loads its sets before it knows whether the comparison worked, so
 * without this the run you just did would read "never run" until you reloaded.
 *
 * Deliberately swallows its own errors and returns null: failing to record a
 * timestamp must never turn a successful comparison into an error page.
 */
export async function markComparisonSetRun(id: number): Promise<string | null> {
  if (!Number.isInteger(id) || id <= 0) return null;
  try {
    await syncMetadataTables();
    const result = await pool.query<{ last_run_at: string }>(
      `UPDATE comparison_sets SET last_run_at = now() WHERE id = $1
       RETURNING last_run_at`,
      [id]
    );
    return result.rows[0]?.last_run_at ?? null;
  } catch (error) {
    console.error("Failed to stamp comparison set run time:", error);
    return null;
  }
}
