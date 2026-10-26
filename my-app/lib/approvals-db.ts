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
 *
 * A request also keeps a copy of its SQL, in `scripts`, so that a paired
 * phone can show the approver what they are deciding. The copy is only for
 * reading. What an approval covers is still pinned by the fingerprint, and
 * the phone's route hands the copy out only when it hashes back to it (see
 * getApprovalScripts).
 *
 * Every row belongs to one organization, the one that owns its connection. A
 * request is written with INSERT ... SELECT from that connection, filtered by
 * the caller's organization as well as its id, so a request can only be made
 * on a connection the caller's organization owns, and it lands in that
 * organization. Every read, decision, claim and release names the organization
 * next to the id. A row from another organization reads as missing, and an
 * approval given in one organization can never be spent by a run in another,
 * even on a run whose SQL hashes to the same fingerprint.
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

/**
 * Stands in for a person's email wherever the only question is "is this still
 * the same person?".
 *
 * The desktop app remembers who set up approvals on a paired phone, so that a
 * yes from that phone is refused once somebody else is signed in on the
 * computer. Comparing is all it ever does, so it keeps this hash instead of
 * the address. Lower-cased, like every other email comparison in this file.
 */
export function approverKey(email: string): string {
  return createHash("sha256")
    .update(`schema-studio approver\n${email.trim().toLowerCase()}`, "utf8")
    .digest("hex");
}

/**
 * The most SQL a request keeps a copy of: one million characters, over every
 * script in the run. A phone is sent the whole copy in one answer, and a run
 * bigger than this is better read on the Deploy screen anyway. A request over
 * it works exactly the same. It just has no copy, and the phone says so.
 */
export const MAX_STORED_SQL_CHARS = 1_000_000;

/**
 * Whether PostgreSQL can keep this text inside JSONB. It refuses a NUL
 * character and half of a surrogate pair (text that does not survive being
 * written as UTF-8), and either would otherwise fail the whole request over a
 * copy that is only there to be read.
 */
function jsonbCanHold(text: string): boolean {
  return !text.includes(String.fromCharCode(0)) && Buffer.from(text, "utf8").toString("utf8") === text;
}

/**
 * The run as the `scripts` column keeps it, or null when it is too big or
 * cannot be kept. JSON text rather than an array, because pg would send a
 * JavaScript array as a PostgreSQL array, which a ::jsonb cast refuses.
 */
function storedScripts(scripts: ApprovalScript[]): string | null {
  const size = scripts.reduce((total, script) => total + script.sqlContent.length, 0);
  if (size > MAX_STORED_SQL_CHARS) return null;
  // Exactly these three fields, whatever else the caller's objects carry, so
  // the copy hashes back to the fingerprint.
  const kept = scripts.map(({ scriptName, version, sqlContent }) => ({ scriptName, version, sqlContent }));
  if (!kept.every((script) => Object.values(script).every(jsonbCanHold))) return null;
  return JSON.stringify(kept);
}

/** A copy read back from the `scripts` column, or null when there is none or it is not one storedScripts wrote. */
function readStoredScripts(value: unknown): ApprovalScript[] | null {
  if (!Array.isArray(value)) return null;
  const scripts: ApprovalScript[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) return null;
    const { scriptName, version, sqlContent } = item as Record<string, unknown>;
    if (typeof scriptName !== "string" || typeof version !== "string" || typeof sqlContent !== "string") {
      return null;
    }
    scripts.push({ scriptName, version, sqlContent });
  }
  return scripts;
}

/**
 * Ask for approval of one run, or hand back the identical request that is
 * still open.
 *
 * Null when the connection is not one the organization owns: deleted, never
 * saved, or another organization's. The route answers all three the same way.
 */
export async function createApprovalRequest(input: {
  /** The caller's organization, which must own the connection. */
  orgId: number;
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
}): Promise<DeployApproval | null> {
  await syncMetadataTables();
  const fingerprint = runFingerprint(input.scripts, input.action);
  const scripts = storedScripts(input.scripts);

  // An identical request that is still open is the same request. Returning it
  // rather than inserting a second row keeps the approver from seeing the same
  // run twice because someone pressed the button twice.
  const open = await pool.query<DeployApproval>(
    `SELECT ${COLUMNS} FROM deploy_approvals
      WHERE connection_id = $1 AND schema_name = $2 AND run_fingerprint = $3
        AND action = $4 AND org_id = $5
        AND status IN ('pending', 'approved')
        -- An approved row that has expired cannot be claimed, so handing it
        -- back here would show "approved" on a screen whose Deploy button then
        -- says the run needs approval. Let it fall through to a fresh request.
        AND ${UNEXPIRED}
      ORDER BY id DESC LIMIT 1`,
    [input.connectionId, input.schemaName, fingerprint, input.action, input.orgId]
  );
  if (open.rows.length > 0) {
    // A request made before copies were kept gets one now, so a phone can
    // show it after somebody asks again. The fingerprints matched, so this is
    // the SQL that request covers.
    if (scripts !== null) {
      await pool.query(
        `UPDATE deploy_approvals SET scripts = $2::jsonb
          WHERE id = $1 AND org_id = $3 AND scripts IS NULL`,
        [open.rows[0].id, scripts, input.orgId]
      );
    }
    return open.rows[0];
  }

  // The organization comes from the connection row, and only when that row is
  // the caller's organization's. No such row means no insert, and null.
  const created = await pool.query<DeployApproval>(
    `INSERT INTO deploy_approvals
       (org_id, connection_id, schema_name, script_name, target_version, run_fingerprint,
        migration_count, breaking_count, requested_by, note, action, scripts)
     SELECT c.org_id, c.id, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb
       FROM connections c
      WHERE c.id = $1 AND c.org_id = $12
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
      scripts,
      input.orgId,
    ]
  );
  return created.rows[0] ?? null;
}

/** Every approval for one target, deploys and rollbacks together, newest first. */
export async function listApprovals(
  orgId: number,
  connectionId: number,
  schemaName: string,
  scriptName: string | null
): Promise<DeployApproval[]> {
  await syncMetadataTables();
  const result = await pool.query<DeployApproval>(
    `SELECT ${COLUMNS} FROM deploy_approvals
      WHERE connection_id = $1 AND schema_name = $2 AND org_id = $4
        AND ($3::text IS NULL OR script_name = $3)
      ORDER BY id DESC LIMIT 50`,
    [connectionId, schemaName, scriptName, orgId]
  );
  return result.rows;
}

/**
 * Why this person may not decide this request, or null when they may.
 *
 * `selfAllowed` is true when the person may decide their own request, which
 * is mayDecideOwn below.
 */
export function decisionBlockReason(
  approval: DeployApproval,
  deciderEmail: string,
  selfAllowed: boolean
): string | null {
  if (approval.status !== "pending") {
    return `This request is already ${approval.status}.`;
  }
  if (selfAllowed) return null;
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
 * write — someone else decided it first, and their decision stands. Also null
 * for another organization's row, which this never touches.
 */
export async function decideApproval(input: {
  /** The decider's organization, which must own the request. */
  orgId: number;
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
      WHERE id = $1 AND org_id = $8 AND status = 'pending'
      RETURNING ${COLUMNS}`,
    [
      input.id,
      input.approve ? "approved" : "rejected",
      input.decidedBy,
      input.selfApproved,
      input.note,
      input.approve,
      APPROVAL_VALID_HOURS,
      input.orgId,
    ]
  );
  return result.rows[0] ?? null;
}

/**
 * Read one approval by id, or null when the organization has no such row.
 * Another organization's row reads as missing, the same answer a deleted one
 * gets.
 */
export async function getApproval(orgId: number, id: number): Promise<DeployApproval | null> {
  await syncMetadataTables();
  const result = await pool.query<DeployApproval>(
    `SELECT ${COLUMNS} FROM deploy_approvals WHERE id = $1 AND org_id = $2`,
    [id, orgId]
  );
  return result.rows[0] ?? null;
}

/** A request waiting for a decision, and whether a copy of its SQL was kept. */
export type PendingApproval = DeployApproval & { has_sql: boolean };

/**
 * The newest hundred requests still waiting for a decision, on every
 * connection in the organization, for the phone's route. The desktop app then
 * keeps only the ones on connections shared with phones. The copies of their
 * SQL stay behind: getApprovalScripts reads one at a time.
 */
export async function listPendingApprovals(orgId: number): Promise<PendingApproval[]> {
  await syncMetadataTables();
  const result = await pool.query<PendingApproval>(
    `SELECT ${COLUMNS}, scripts IS NOT NULL AS has_sql FROM deploy_approvals
      WHERE status = 'pending' AND org_id = $1
      ORDER BY id DESC LIMIT 100`,
    [orgId]
  );
  return result.rows;
}

/**
 * One request and the copy of its SQL, or null when the organization has no
 * such row.
 *
 * `scripts` is the copy only when it hashes back to the request's own
 * fingerprint. The fingerprint is what an approval covers, so a copy that
 * disagreed with it (a row changed by hand, say) would show the approver SQL
 * other than the SQL their yes lets run. `copy` says why `scripts` is null.
 */
export async function getApprovalScripts(
  orgId: number,
  id: number
): Promise<{
  approval: DeployApproval;
  scripts: ApprovalScript[] | null;
  copy: "kept" | "not-kept" | "does-not-match";
} | null> {
  await syncMetadataTables();
  const result = await pool.query<DeployApproval & { scripts: unknown }>(
    `SELECT ${COLUMNS}, scripts FROM deploy_approvals WHERE id = $1 AND org_id = $2`,
    [id, orgId]
  );
  const row = result.rows[0];
  if (!row) return null;
  const { scripts: stored, ...approval } = row;
  const scripts = readStoredScripts(stored);
  if (scripts === null) return { approval, scripts: null, copy: "not-kept" };
  if (runFingerprint(scripts, approval.action) !== approval.run_fingerprint) {
    return { approval, scripts: null, copy: "does-not-match" };
  }
  return { approval, scripts, copy: "kept" };
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
  /** The organization the run is in. Only its own approvals can be spent. */
  orgId: number;
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
           AND run_fingerprint = $3 AND action = $4 AND org_id = $5
           AND status = 'approved'
           AND ${UNEXPIRED}
         ORDER BY id ASC LIMIT 1
         FOR UPDATE SKIP LOCKED
      ) AND org_id = $5
      RETURNING ${COLUMNS}`,
    [input.connectionId, input.schemaName, fingerprint, input.action, input.orgId]
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
export async function releaseApproval(orgId: number, id: number): Promise<void> {
  await pool.query(
    `UPDATE deploy_approvals
        SET status = 'approved', used_at = NULL
      WHERE id = $1 AND org_id = $2 AND status = 'used'`,
    [id, orgId]
  );
}

/**
 * Whether this person may decide a request they made themselves. Two cases:
 *
 * - The demo, with sign-in switched off, has exactly one principal, so a
 *   second person cannot exist.
 * - An organization whose Admin switched its two-person rule off (the
 *   Organization tab). The rule is on for every new organization.
 *
 * Either way the row records it, in `self_approved`, rather than looking like
 * a two-person approval, and deciding still needs Approvals: Approve.
 */
export function mayDecideOwn(principal: { bypass: boolean; orgTwoPersonRule: boolean }): boolean {
  return principal.bypass || !principal.orgTwoPersonRule;
}
