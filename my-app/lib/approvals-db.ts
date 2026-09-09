import { createHash } from "node:crypto";
import pool, { ensureMetadataSchema } from "./version-db";

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
 */

/** One migration as it goes into a fingerprint. */
export type ApprovalScript = {
  scriptName: string;
  version: string;
  sqlContent: string;
};

export type ApprovalStatus = "pending" | "approved" | "rejected" | "used";

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
};

const COLUMNS = `id, connection_id, schema_name, script_name, target_version,
  run_fingerprint, migration_count, breaking_count, requested_by, requested_at,
  status, decided_by, decided_at, self_approved, note, used_at`;

let tableReady: Promise<void> | null = null;

/**
 * Create the approvals table. Same lazy-DDL idiom as the rest of the metadata
 * store: the repo carries no .sql files, so every table is created by the first
 * request that needs it.
 */
export function ensureApprovalsTable(): Promise<void> {
  if (!tableReady) {
    tableReady = createApprovalsTable().catch((error) => {
      // Not cached on failure — the next caller retries rather than inheriting
      // a permanently broken promise from one bad boot.
      tableReady = null;
      throw error;
    });
  }
  return tableReady;
}

async function createApprovalsTable(): Promise<void> {
  await ensureMetadataSchema();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS deploy_approvals (
      id SERIAL PRIMARY KEY,
      connection_id INTEGER NOT NULL,
      schema_name TEXT NOT NULL,
      script_name TEXT NOT NULL,
      target_version TEXT NOT NULL,
      run_fingerprint TEXT NOT NULL,
      migration_count INTEGER NOT NULL,
      breaking_count INTEGER NOT NULL DEFAULT 0,
      requested_by TEXT NOT NULL,
      requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'approved', 'rejected', 'used')),
      decided_by TEXT,
      decided_at TIMESTAMPTZ,
      self_approved BOOLEAN NOT NULL DEFAULT false,
      note TEXT,
      used_at TIMESTAMPTZ,
      -- The two-person rule, in the database.
      --
      -- A route that forgets to compare the two emails cannot create a
      -- self-approved row by accident; it gets an error instead. The one
      -- exception is flagged, not hidden: self_approved is set only while the
      -- auth bypass is on, when the app has exactly one principal and the rule
      -- is unsatisfiable. An audit can then tell the two apart by reading one
      -- column.
      CONSTRAINT deploy_approvals_two_person_check CHECK (
        decided_by IS NULL
        OR self_approved
        OR lower(decided_by) <> lower(requested_by)
      )
    )
  `);
  // Finding the approval that covers a run is the hot path — the apply route
  // does it on every production deploy.
  await pool.query(
    `CREATE INDEX IF NOT EXISTS deploy_approvals_target_idx
       ON deploy_approvals (connection_id, schema_name, script_name, status)`
  );
}

/**
 * Hash the exact SQL of a run.
 *
 * Order matters and is preserved: the same migrations in a different order are
 * a different run, and would produce a different database. Names and versions
 * go into the hash too, so an approval for v1.2.0 cannot cover v1.3.0 even if
 * the two happen to hold identical SQL.
 */
export function runFingerprint(scripts: ApprovalScript[]): string {
  const body = scripts
    .map((s) => `${s.scriptName} ${s.version} ${s.sqlContent}`)
    .join("\n-- next migration --\n");
  return createHash("sha256").update(body, "utf8").digest("hex");
}

export async function createApprovalRequest(input: {
  connectionId: number;
  schemaName: string;
  scriptName: string;
  targetVersion: string;
  scripts: ApprovalScript[];
  breakingCount: number;
  requestedBy: string;
  note: string | null;
}): Promise<DeployApproval> {
  await ensureApprovalsTable();
  const fingerprint = runFingerprint(input.scripts);

  // An identical request that is still open is the same request. Returning it
  // rather than inserting a second row keeps the approver from seeing the same
  // run twice because someone pressed the button twice.
  const open = await pool.query<DeployApproval>(
    `SELECT ${COLUMNS} FROM deploy_approvals
      WHERE connection_id = $1 AND schema_name = $2 AND run_fingerprint = $3
        AND status IN ('pending', 'approved')
      ORDER BY id DESC LIMIT 1`,
    [input.connectionId, input.schemaName, fingerprint]
  );
  if (open.rows.length > 0) return open.rows[0];

  const created = await pool.query<DeployApproval>(
    `INSERT INTO deploy_approvals
       (connection_id, schema_name, script_name, target_version, run_fingerprint,
        migration_count, breaking_count, requested_by, note)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
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
    ]
  );
  return created.rows[0];
}

/** Every approval for one target, newest first. */
export async function listApprovals(
  connectionId: number,
  schemaName: string,
  scriptName: string | null
): Promise<DeployApproval[]> {
  await ensureApprovalsTable();
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
    return (
      "You asked for this deploy, so you cannot approve it. " +
      "A production run needs a second person."
    );
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
  await ensureApprovalsTable();
  const result = await pool.query<DeployApproval>(
    `UPDATE deploy_approvals
        SET status = $2, decided_by = $3, decided_at = now(),
            self_approved = $4, note = COALESCE($5, note)
      WHERE id = $1 AND status = 'pending'
      RETURNING ${COLUMNS}`,
    [
      input.id,
      input.approve ? "approved" : "rejected",
      input.decidedBy,
      input.selfApproved,
      input.note,
    ]
  );
  return result.rows[0] ?? null;
}

/** Read one approval by id, or null when there is no such row. */
export async function getApproval(id: number): Promise<DeployApproval | null> {
  await ensureApprovalsTable();
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
 */
export async function claimApproval(input: {
  connectionId: number;
  schemaName: string;
  scripts: ApprovalScript[];
}): Promise<DeployApproval | null> {
  await ensureApprovalsTable();
  const fingerprint = runFingerprint(input.scripts);
  const result = await pool.query<DeployApproval>(
    `UPDATE deploy_approvals
        SET status = 'used', used_at = now()
      WHERE id = (
        SELECT id FROM deploy_approvals
         WHERE connection_id = $1 AND schema_name = $2
           AND run_fingerprint = $3 AND status = 'approved'
         ORDER BY id ASC LIMIT 1
         FOR UPDATE SKIP LOCKED
      )
      RETURNING ${COLUMNS}`,
    [input.connectionId, input.schemaName, fingerprint]
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
