import { createHash } from "node:crypto";
import pool, { syncMetadataTables } from "./version-db";
import {
  fingerprintBody,
  rollbackFingerprintBody,
  type ApprovalScript,
} from "./approval-fingerprint";

export type { ApprovalScript };

/**
 * Deploy approvals — the two-person rule for production runs.
 *
 * Before this existed, a production deploy was gated by a checkbox the same
 * person ticked a second before pressing Deploy. That is a speed bump, not a
 * control: it asks the operator to confirm what they already decided. A real
 * gate needs a SECOND person, and it needs to be enforced where the run
 * actually happens — in the apply route, not in a disabled button.
 *
 * The shape of the rule:
 *
 *   1. Someone requests approval for one exact run — a connection, a schema, a
 *      script group, a target version, and the SQL of every migration in it.
 *   2. Someone ELSE approves or rejects it. "Someone else" is enforced by a
 *      CHECK constraint, so it holds even if a future route forgets to look.
 *   3. The apply route claims the approval before it runs, which makes an
 *      approval good for exactly one run. If the run fails, the claim is
 *      released so the same approval still covers the retry.
 *
 * What is being approved is pinned by `run_fingerprint`, a hash of the exact
 * SQL. Edit a migration after approval and the fingerprint stops matching, so
 * the approval no longer authorises anything — which is the whole point. An
 * approval that could be re-used against different SQL would be worse than no
 * approval, because it would carry a second person's name.
 *
 * An approval also stops being good after a while. The fingerprint pins WHAT
 * was approved, but not WHEN: an approval given a month ago was a judgement
 * about a database as it stood a month ago, and the second person is not there
 * to be asked whether it still holds. So a decision carries an expiry, and a
 * claim ignores a row past it — the run is simply unapproved again, and asking
 * costs one more click. See APPROVAL_VALID_HOURS.
 *
 * Rollbacks on production follow the same rule through the same table. The
 * `action` column says which route may spend a row ("deploy" for the apply
 * route, "revert" for the revert route), and a rollback's fingerprint is built
 * under a different header (rollbackFingerprintBody), so an approval for one
 * can never be spent on the other.
 */

export type ApprovalStatus = "pending" | "approved" | "rejected" | "used";

/** What an approval authorises: a deploy (apply route) or a rollback (revert route). */
export type ApprovalAction = "deploy" | "revert";

/** True for "deploy" and "revert", the only two values the table accepts. */
export function isApprovalAction(value: unknown): value is ApprovalAction {
  return value === "deploy" || value === "revert";
}

/** One row of `deploy_approvals`, as every screen and route sees it. */
export type DeployApproval = {
  id: number;
  connection_id: number;
  schema_name: string;
  script_name: string;
  target_version: string;
  run_fingerprint: string;
  migration_count: number;
  breaking_count: number;
  requested_by: string;
  requested_at: string;
  status: ApprovalStatus;
  decided_by: string | null;
  decided_at: string | null;
  self_approved: boolean;
  note: string | null;
  used_at: string | null;
  action: ApprovalAction;
  /**
   * When this approval stops authorising the run. Set when it is approved, and
   * null on a row decided before this column existed — those never expire,
   * because retro-fitting an expiry onto a decision somebody already made would
   * be this tool inventing an answer on their behalf.
   */
  expires_at: string | null;
};

/**
 * How long an approval lasts once it is given: one week.
 *
 * Long enough that a deploy planned for "after the weekend" still goes ahead
 * without asking twice, short enough that a month-old yes does not quietly
 * unlock a production run. An expired approval is not an error state — the run
 * just reads as unapproved, exactly as it did before anybody looked at it.
 */
export const APPROVAL_VALID_HOURS = 24 * 7;

/** An approval that is still good: approved, and not past its expiry. */
const UNEXPIRED = `(expires_at IS NULL OR expires_at > now())`;

const COLUMNS = `id, connection_id, schema_name, script_name, target_version,
  run_fingerprint, migration_count, breaking_count, requested_by, requested_at,
  status, decided_by, decided_at, self_approved, note, used_at, action, expires_at`;

/**
 * Hash the exact SQL of a run.
 *
 * The text being hashed is built by lib/approval-fingerprint, which the Deploy
 * screen also uses — the screen has to reach the same hex string to know
 * whether the run in front of the user is the approved one. A deploy hashes
 * fingerprintBody and a rollback hashes rollbackFingerprintBody, so the same
 * scripts give two different fingerprints.
 */
export function runFingerprint(scripts: ApprovalScript[], action: ApprovalAction): string {
  const body = action === "revert" ? rollbackFingerprintBody(scripts) : fingerprintBody(scripts);
  return createHash("sha256").update(body, "utf8").digest("hex");
}

export async function createApprovalRequest(input: {
  connectionId: number;
  schemaName: string;
  scriptName: string;
  targetVersion: string;
  /** For a rollback: the rollback SQL that will run, newest version first. */
  scripts: ApprovalScript[];
  breakingCount: number;
  requestedBy: string;
  note: string | null;
  action: ApprovalAction;
}): Promise<DeployApproval> {
  await syncMetadataTables();
  const fingerprint = runFingerprint(input.scripts, input.action);

  // An identical request that is still open is the same request. Returning it
  // rather than inserting a second row keeps the approver from seeing the same
  // run twice because someone pressed the button twice.
  const open = await pool.query<DeployApproval>(
    `SELECT ${COLUMNS} FROM deploy_approvals
      WHERE connection_id = $1 AND schema_name = $2 AND run_fingerprint = $3
        AND action = $4
        AND status IN ('pending', 'approved')
        -- An approved row that has expired cannot be claimed, so handing it
        -- back here would show "approved" on a screen whose Deploy button then
        -- says the run needs approval. Let it fall through to a fresh request.
        AND ${UNEXPIRED}
      ORDER BY id DESC LIMIT 1`,
    [input.connectionId, input.schemaName, fingerprint, input.action]
  );
  if (open.rows.length > 0) return open.rows[0];

  const created = await pool.query<DeployApproval>(
    `INSERT INTO deploy_approvals
       (connection_id, schema_name, script_name, target_version, run_fingerprint,
        migration_count, breaking_count, requested_by, note, action)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING ${COLUMNS}`,
    [
      input.connectionId,
      input.schemaName,
      input.scriptName,
      input.targetVersion,
      fingerprint,
      input.scripts.length,
      input.breakingCount,
      input.requestedBy,
      input.note,
      input.action,
    ]
  );
  return created.rows[0];
}

/** Every approval for one target, deploys and rollbacks together, newest first. */
export async function listApprovals(
  connectionId: number,
  schemaName: string,
  scriptName: string | null
): Promise<DeployApproval[]> {
  await syncMetadataTables();
  const result = await pool.query<DeployApproval>(
    `SELECT ${COLUMNS} FROM deploy_approvals
      WHERE connection_id = $1 AND schema_name = $2
        AND ($3::text IS NULL OR script_name = $3)
      ORDER BY id DESC LIMIT 50`,
    [connectionId, schemaName, scriptName]
  );
  return result.rows;
}

/** Why this person may not decide this request, or null when they may. */
export function decisionBlockReason(
  approval: DeployApproval,
  deciderEmail: string,
  bypass: boolean
): string | null {
  if (approval.status !== "pending") {
    return `This request is already ${approval.status}.`;
  }
  if (bypass) return null;
  if (approval.requested_by.toLowerCase() === deciderEmail.toLowerCase()) {
    return approval.action === "revert"
      ? "You asked for this rollback, so you cannot approve it. " +
          "A rollback on production needs a second person."
      : "You asked for this deploy, so you cannot approve it. " +
          "A production run needs a second person.";
  }
  return null;
}

/**
 * Approve or reject a pending request.
 *
 * Returns null when the row moved out of `pending` between the check and the
 * write — someone else decided it first, and their decision stands.
 */
export async function decideApproval(input: {
  id: number;
  approve: boolean;
  decidedBy: string;
  /** True when the decider is the bypass principal — recorded, not hidden. */
  selfApproved: boolean;
  note: string | null;
}): Promise<DeployApproval | null> {
  await syncMetadataTables();
  const result = await pool.query<DeployApproval>(
    // The clock starts at the decision, not at the request: the window is how
    // long this person's judgement stands, and a request that waited three days
    // for an answer should not arrive already half spent. A rejection gets no
    // expiry — there is nothing to expire.
    `UPDATE deploy_approvals
        SET status = $2, decided_by = $3, decided_at = now(),
            self_approved = $4, note = COALESCE($5, note),
            expires_at = CASE WHEN $6 THEN now() + make_interval(hours => $7) END
      WHERE id = $1 AND status = 'pending'
      RETURNING ${COLUMNS}`,
    [
      input.id,
      input.approve ? "approved" : "rejected",
      input.decidedBy,
      input.selfApproved,
      input.note,
      input.approve,
      APPROVAL_VALID_HOURS,
    ]
  );
  return result.rows[0] ?? null;
}

/** Read one approval by id, or null when there is no such row. */
export async function getApproval(id: number): Promise<DeployApproval | null> {
  await syncMetadataTables();
  const result = await pool.query<DeployApproval>(
    `SELECT ${COLUMNS} FROM deploy_approvals WHERE id = $1`,
    [id]
  );
  return result.rows[0] ?? null;
}

/**
 * Claim the approval that covers this exact run, marking it used.
 *
 * Claiming BEFORE the run is deliberate. An approval authorises one run; if two
 * operators press Deploy at the same moment, exactly one of them gets the row
 * and the other is told to ask again. The `status = 'approved'` predicate in
 * the WHERE clause is what makes that a race-free single UPDATE rather than a
 * read followed by a write.
 *
 * A row past its expiry is left where it is rather than claimed: nothing is
 * marked used, the caller reads null, and the route answers "this run needs
 * approval" — the same answer it gives for a run nobody has looked at.
 *
 * `action` is required, not defaulted: the apply route passes "deploy" and the
 * revert route passes "revert", and a caller that forgot to say which would
 * otherwise quietly spend the wrong kind of approval.
 */
export async function claimApproval(input: {
  connectionId: number;
  schemaName: string;
  scripts: ApprovalScript[];
  action: ApprovalAction;
}): Promise<DeployApproval | null> {
  await syncMetadataTables();
  const fingerprint = runFingerprint(input.scripts, input.action);
  const result = await pool.query<DeployApproval>(
    `UPDATE deploy_approvals
        SET status = 'used', used_at = now()
      WHERE id = (
        SELECT id FROM deploy_approvals
         WHERE connection_id = $1 AND schema_name = $2
           AND run_fingerprint = $3 AND action = $4
           AND status = 'approved'
           AND ${UNEXPIRED}
         ORDER BY id ASC LIMIT 1
         FOR UPDATE SKIP LOCKED
      )
      RETURNING ${COLUMNS}`,
    [input.connectionId, input.schemaName, fingerprint, input.action]
  );
  return result.rows[0] ?? null;
}

/**
 * Hand a claimed approval back after a run that did not commit.
 *
 * The transaction rolled back, so nothing was deployed and the second person's
 * decision still stands for the same SQL — making them approve it again would
 * be asking them to re-read what they already read. If the operator edits a
 * migration before retrying, the fingerprint changes and this row stops
 * matching on its own.
 */
export async function releaseApproval(id: number): Promise<void> {
  await pool.query(
    `UPDATE deploy_approvals
        SET status = 'approved', used_at = NULL
      WHERE id = $1 AND status = 'used'`,
    [id]
  );
}
