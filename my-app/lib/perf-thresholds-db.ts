import pool from "./version-db";
import {
  THRESHOLD_KEYS,
  THRESHOLDS,
  defaultSettings,
  toThresholdKey,
  validateThreshold,
  type ThresholdSetting,
} from "./perf-thresholds";

/**
 * Storing and reading the alert thresholds.
 *
 * What may be set and how a breach is decided is all in lib/perf-thresholds.ts,
 * which has no database in it. This file is only the round trip.
 */

/**
 * The settings for one schema, with every key present.
 *
 * A key with no stored row comes back as its suggested value, switched off.
 * That is what lets the settings screen render a complete form from one call
 * and never have to think about which rows happen to exist — and it means a
 * threshold added to THRESHOLD_KEYS in a later version appears on the screen of
 * an existing installation without anybody running anything.
 */
export async function getThresholds(
  connectionId: number,
  schema: string
): Promise<ThresholdSetting[]> {
  const result = await pool.query<{
    threshold_key: string;
    threshold_value: string | number;
    enabled: boolean;
  }>(
    `SELECT threshold_key, threshold_value, enabled
       FROM perf_thresholds
      WHERE connection_id = $1 AND schema_name = $2`,
    [connectionId, schema]
  );

  const stored = new Map<string, { value: number; enabled: boolean }>();
  for (const row of result.rows) {
    // A key the app no longer knows about is skipped rather than surfaced. The
    // CHECK constraint stops one being written, but a row from a version that
    // had a key this one has dropped is a real possibility, and it must not
    // reach evaluateThresholds where it would index THRESHOLDS as undefined.
    if (!toThresholdKey(row.threshold_key)) continue;
    stored.set(row.threshold_key, {
      value: Number(row.threshold_value),
      enabled: row.enabled,
    });
  }

  return THRESHOLD_KEYS.map((key) => {
    const row = stored.get(key);
    return row
      ? { key, value: row.value, enabled: row.enabled }
      : { key, value: THRESHOLDS[key].suggested, enabled: false };
  });
}

/**
 * Save a whole set of thresholds at once.
 *
 * The whole set rather than one row, because that is how the screen edits them:
 * a form with every rule on it and one Save. Upserted on the unique index so a
 * second save updates rather than failing, and run inside one transaction so a
 * half-saved form is not a state the app can be left in.
 *
 * Returns the sentences for anything rejected. An empty array means it saved.
 * Validation happens here as well as in the UI because the UI is not a gate —
 * this route is reachable directly.
 */
export async function saveThresholds(
  connectionId: number,
  schema: string,
  settings: ThresholdSetting[],
  updatedBy: string
): Promise<string[]> {
  const problems: string[] = [];
  const clean: ThresholdSetting[] = [];

  for (const setting of settings) {
    const key = toThresholdKey(setting.key);
    if (!key) {
      problems.push(`"${String(setting.key)}" is not something this app can watch.`);
      continue;
    }
    const value = Number(setting.value);
    const problem = validateThreshold(key, value);
    if (problem) {
      problems.push(problem);
      continue;
    }
    clean.push({ key, value, enabled: Boolean(setting.enabled) });
  }

  // Nothing is written when any part of the form is wrong. Saving the valid
  // half would leave the screen showing a mixture of what was asked for and
  // what was refused, with no way to tell which is which.
  if (problems.length > 0) return problems;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const setting of clean) {
      await client.query(
        `INSERT INTO perf_thresholds
           (connection_id, schema_name, threshold_key, threshold_value, enabled, updated_by, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, now())
         ON CONFLICT (connection_id, schema_name, threshold_key)
         DO UPDATE SET threshold_value = EXCLUDED.threshold_value,
                       enabled         = EXCLUDED.enabled,
                       updated_by      = EXCLUDED.updated_by,
                       updated_at      = now()`,
        [connectionId, schema, setting.key, setting.value, setting.enabled, updatedBy]
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }

  return [];
}

/**
 * The thresholds for a schema, best-effort.
 *
 * The analyse route wants to check a query it has just scored against whatever
 * rules are set, and failing to read them must not fail the analysis — the user
 * asked what their query does, not whether it broke an alert rule. An
 * unreadable table therefore reads as "every threshold at its suggested value,
 * switched off", which fires nothing.
 */
export async function getThresholdsOrDefaults(
  connectionId: number,
  schema: string
): Promise<ThresholdSetting[]> {
  try {
    return await getThresholds(connectionId, schema);
  } catch (error) {
    console.error(
      "Performance thresholds — could not be read:",
      error instanceof Error ? error.message : error
    );
    return defaultSettings();
  }
}
