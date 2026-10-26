import pool, { syncMetadataTables } from "./version-db";
import {
  attemptDetail,
  attemptOutcome,
  type AttemptContext,
  type AttemptResponseBody,
  type DeployAttemptRow,
} from "./deploy-attempts";

// Re-exported so a caller that only reads rows needs one import, not two.
export type { DeployAttemptRow };

/**
 * Writing and reading the deploy audit trail.
 *
 * lib/deploy-attempts.ts explains why the trail exists and holds the pure
 * classification; this file is the half that touches the metadata database and
 * therefore must never be imported from a client component.
 *
 * Every row belongs to one organization, the caller's, and is only ever read
 * back inside it. Somebody in one organization must not learn what anyone in
 * another tried to deploy, or that they tried at all.
 */

/**
 * Record one attempt, whatever came of it.
 *
 * Best-effort on purpose, and this is the one decision in the file worth
 * arguing about. The alternative — let a failure here fail the request — would
 * mean a metadata database that is briefly unreachable could turn a deploy
 * that committed perfectly well into a 500, and send the operator to re-run
 * migrations that are already applied. An audit trail that can break the thing
 * it audits is worse than one with a gap in it, so a write that fails is
 * logged for the server operator and swallowed.
 *
 * It is called AFTER the route has produced its answer, so nothing it does can
 * change what the operator is told.
 *
 * An attempt with no organization is not written. That is a request the gate
 * turned away: signed out, not a member, a role that may not deploy, or a
 * database that could not say which. The gate does not hand back who it
 * refused, so there is no organization to file the row under, and filing it
 * under some default one would show one organization's refusals to another.
 * Nothing a reader could see is lost: the gate runs before the route reads the
 * body, so such a row never named a connection or a schema, and the trail's
 * only reader (listDeployAttempts) asks by both.
 */
export async function recordDeployAttempt(
  context: AttemptContext,
  status: number,
  body: AttemptResponseBody | null
): Promise<void> {
  if (context.orgId === undefined) return;
  const outcome = attemptOutcome(status, body);
  try {
    await syncMetadataTables();
    // The caller's organization, which is also the connection's whenever the
    // connection was found: the route only looks a connection up inside the
    // caller's organization. A connection id it could not find there (deleted,
    // or another organization's) is still recorded, as the id this caller
    // asked for, in the caller's own trail, which tells them nothing new.
    //
    // org_id is the last value so the others keep their places.
    await pool.query(
      `INSERT INTO deploy_attempts
         (connection_id, schema_name, scripts, outcome, dry_run, http_status, detail, actor,
          org_id)
       VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, $8, $9)`,
      [
        context.connectionId ?? null,
        context.schemaName ?? null,
        // Stringified and cast: node-postgres sends a JS array as a Postgres
        // array literal, which a jsonb column refuses.
        JSON.stringify(context.scripts ?? []),
        outcome,
        context.dryRun === true,
        status,
        attemptDetail(outcome, body),
        context.actor ?? null,
        context.orgId,
      ]
    );
  } catch (error) {
    console.error("Deploy audit — could not record the attempt:", error);
  }
}

/**
 * The most recent attempts against one schema, newest first, in one
 * organization.
 *
 * Scoped to a connection and schema because that is the only question a
 * reader asks: "what has anyone tried against THIS database". A limit rather
 * than a page, because the screen showing it is a panel beside the deploy
 * controls and not a report — and because an unbounded read of an append-only
 * table grows without anybody noticing.
 */
export async function listDeployAttempts(input: {
  orgId: number;
  connectionId: number;
  schemaName: string;
  limit?: number;
}): Promise<DeployAttemptRow[]> {
  await syncMetadataTables();
  // Clamped rather than trusted: the caller is a query string.
  const limit = Math.min(Math.max(Math.trunc(input.limit ?? 20), 1), 100);
  const result = await pool.query<Omit<DeployAttemptRow, "created_at"> & { created_at: unknown }>(
    `SELECT id, connection_id, schema_name, scripts, outcome, dry_run,
            http_status, detail, actor, created_at
       FROM deploy_attempts
      WHERE connection_id = $1 AND schema_name = $2 AND org_id = $4
      ORDER BY created_at DESC, id DESC
      LIMIT $3`,
    [input.connectionId, input.schemaName, limit, input.orgId]
  );
  // node-postgres parses a timestamptz into a Date, not the string the row
  // type promises. It reaches the screen as a string anyway, because the route
  // serialises it on the way out — so the mismatch is invisible today and
  // would surface as `created_at.slice is not a function` the first time
  // anything read these rows on the server. Normalised here so the declared
  // type is true at every layer rather than only at the one that is used.
  return result.rows.map((row) => ({
    ...row,
    created_at: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
  }));
}
