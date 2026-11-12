/**
 * Drift results, ready for the other side of the two-way sync
 * (docs/two-way-sync-plan.md, step 2). Only results travel: what a check
 * found, when and how. The snapshots and lineage behind them stay where the
 * check ran.
 *
 * Each side lists its own connections only: the website all of its own, a
 * desktop the ones that are not copies of the website's (site_id is set only on
 * a copy). The scheduler skips copies too (lib/drift-scheduler.ts), so each
 * schema is checked, and its history kept, in one place.
 */
import pool, { syncMetadataTables } from "@/lib/version-db";
import {
  DRIFT_HISTORY,
  LONGEST_DRIFT_SUMMARY,
  MOST_DRIFT_SCHEMAS,
  readDriftSchema,
  type WebsiteDriftSchema,
} from "@/lib/agent-rules";
import { toEnvironment } from "@/lib/environments";

/** Every schema tracked on this server's own connections, with its newest checks first. */
export async function listOwnDrift(orgId: number): Promise<WebsiteDriftSchema[]> {
  await syncMetadataTables();
  const { rows } = await pool.query<{
    connection_id: number;
    connection_name: string;
    environment: string | null;
    schema_name: string;
    label: string | null;
    interval_minutes: number | null;
    last_checked_at: Date | string | null;
    checks: unknown;
  }>(
    `SELECT t.connection_id, c.name AS connection_name, c.environment, t.schema_name, t.label,
            t.drift_check_interval_minutes AS interval_minutes, t.last_drift_check_at AS last_checked_at,
            COALESCE((
              SELECT json_agg(json_build_object(
                       'status', e.status, 'summary', left(COALESCE(e.summary, ''), $2),
                       'checkedAt', e.detected_at, 'source', e.source,
                       'acknowledged', e.acknowledged_at IS NOT NULL)
                     ORDER BY e.detected_at DESC, e.id DESC)
                FROM (SELECT d.id, d.status, d.summary, d.detected_at, d.source, d.acknowledged_at
                        FROM drift_events d
                       WHERE d.tracked_schema_id = t.id AND d.org_id = t.org_id
                       ORDER BY d.detected_at DESC, d.id DESC
                       LIMIT $3) e
            ), '[]') AS checks
       FROM tracked_schemas t
       JOIN connections c ON c.id = t.connection_id AND c.org_id = t.org_id
      WHERE t.org_id = $1 AND c.site_id IS NULL
      ORDER BY c.name, c.id, t.schema_name, t.id
      LIMIT $4`,
    [orgId, LONGEST_DRIFT_SUMMARY, DRIFT_HISTORY, MOST_DRIFT_SCHEMAS]
  );
  return rows.flatMap((row): WebsiteDriftSchema[] => {
    const schema = readDriftSchema({
      schema: row.schema_name,
      label: row.label,
      intervalMinutes: Number(row.interval_minutes ?? 0),
      lastCheckedAt: row.last_checked_at,
      checks: row.checks,
    });
    if (schema === null) return [];
    return [
      {
        ...schema,
        connectionId: Number(row.connection_id),
        connectionName: row.connection_name,
        environment: toEnvironment(row.environment),
      },
    ];
  });
}
