import type {
  AccessRequest,
  InboxRequest,
  RequestAnswer,
} from "./access-requests";
import { WAITING_REQUESTS_MAX } from "./access-requests";
import pool, { syncMetadataTables } from "./version-db";

/** The queries behind lib/access-requests.ts. Every one names the organization. */

const COLUMNS = `id, requested_by, requested_by_name, permission, message, status,
  decided_by, decided_at, decision_note, created_at`;

export type NewRequest = {
  orgId: number;
  email: string;
  name: string | null;
  permission: string | null;
  message: string | null;
};

export type CreateResult =
  | { kind: "created"; request: AccessRequest }
  /** The same thing is already waiting from this person. */
  | { kind: "already"; request: AccessRequest }
  | { kind: "too-many" };

/**
 * Records a request. Asking twice for the same permission answers with the one
 * already waiting. Two asks at the same moment could both get through, which
 * only means one extra row for someone to answer, so a lock would be overkill.
 */
export async function createAccessRequest(request: NewRequest): Promise<CreateResult> {
  await syncMetadataTables();
  if (request.permission !== null) {
    const waiting = await pool.query<AccessRequest>(
      `SELECT ${COLUMNS} FROM access_requests
        WHERE org_id = $1 AND lower(requested_by) = lower($2)
          AND permission = $3 AND status = 'pending'
        ORDER BY id LIMIT 1`,
      [request.orgId, request.email, request.permission]
    );
    if (waiting.rows[0]) return { kind: "already", request: waiting.rows[0] };
  }
  const count = await pool.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM access_requests
      WHERE org_id = $1 AND lower(requested_by) = lower($2) AND status = 'pending'`,
    [request.orgId, request.email]
  );
  if ((count.rows[0]?.count ?? 0) >= WAITING_REQUESTS_MAX) return { kind: "too-many" };
  const inserted = await pool.query<AccessRequest>(
    `INSERT INTO access_requests
       (org_id, requested_by, requested_by_name, permission, message, status, created_at)
     VALUES ($1, $2, $3, $4, $5, 'pending', now())
     RETURNING ${COLUMNS}`,
    [request.orgId, request.email, request.name, request.permission, request.message]
  );
  return { kind: "created", request: inserted.rows[0] };
}

/** This person's own requests, newest first. */
export async function listOwnRequests(orgId: number, email: string): Promise<AccessRequest[]> {
  await syncMetadataTables();
  const result = await pool.query<AccessRequest>(
    `SELECT ${COLUMNS} FROM access_requests
      WHERE org_id = $1 AND lower(requested_by) = lower($2)
      ORDER BY id DESC LIMIT 50`,
    [orgId, email]
  );
  return result.rows;
}

/**
 * Requests waiting for an answer, oldest first, leaving out the reader's own:
 * nobody answers their own request. Each comes with the asker's current role,
 * and with no role at all once they have left, so the page offers nothing it
 * could not do.
 */
export async function listRequestInbox(orgId: number, readerEmail: string): Promise<InboxRequest[]> {
  await syncMetadataTables();
  const result = await pool.query<InboxRequest>(
    `SELECT a.id, a.requested_by, a.requested_by_name, a.permission, a.message, a.status,
            a.decided_by, a.decided_at, a.decision_note, a.created_at,
            m.profile_id AS member_id, m.role AS member_role, r.label AS member_role_label
       FROM access_requests a
       LEFT JOIN profiles p ON lower(p.email) = lower(a.requested_by)
       LEFT JOIN memberships m ON m.profile_id = p.id AND m.org_id = a.org_id
       LEFT JOIN roles r ON r.org_id = a.org_id AND r.name = m.role
      WHERE a.org_id = $1 AND a.status = 'pending' AND lower(a.requested_by) <> lower($2)
      ORDER BY a.id LIMIT 100`,
    [orgId, readerEmail]
  );
  return result.rows;
}

export async function countRequestInbox(orgId: number, readerEmail: string): Promise<number> {
  await syncMetadataTables();
  const result = await pool.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM access_requests
      WHERE org_id = $1 AND status = 'pending' AND lower(requested_by) <> lower($2)`,
    [orgId, readerEmail]
  );
  return result.rows[0]?.count ?? 0;
}

export async function getAccessRequest(orgId: number, id: number): Promise<AccessRequest | null> {
  await syncMetadataTables();
  const result = await pool.query<AccessRequest>(
    `SELECT ${COLUMNS} FROM access_requests WHERE id = $1 AND org_id = $2`,
    [id, orgId]
  );
  return result.rows[0] ?? null;
}

/**
 * Records an answer. Only a request still waiting can take one, so two people
 * answering at once cannot overwrite each other: the later one gets null.
 */
export async function answerAccessRequest(
  orgId: number,
  id: number,
  answer: RequestAnswer,
  decidedBy: string,
  note: string | null
): Promise<AccessRequest | null> {
  await syncMetadataTables();
  const result = await pool.query<AccessRequest>(
    `UPDATE access_requests
        SET status = $3, decided_by = $4, decided_at = now(), decision_note = $5
      WHERE id = $1 AND org_id = $2 AND status = 'pending'
      RETURNING ${COLUMNS}`,
    [id, orgId, answer, decidedBy, note]
  );
  return result.rows[0] ?? null;
}

/** Takes back a person's own request, if it is still waiting. */
export async function withdrawAccessRequest(
  orgId: number,
  id: number,
  email: string
): Promise<AccessRequest | null> {
  await syncMetadataTables();
  const result = await pool.query<AccessRequest>(
    `UPDATE access_requests SET status = 'withdrawn'
      WHERE id = $1 AND org_id = $2 AND lower(requested_by) = lower($3) AND status = 'pending'
      RETURNING ${COLUMNS}`,
    [id, orgId, email]
  );
  return result.rows[0] ?? null;
}

/** How many of this person's requests were answered after `since` (null: ever). */
export async function countRequestsAnsweredSince(
  orgId: number,
  email: string,
  since: string | Date | null
): Promise<number> {
  await syncMetadataTables();
  const result = await pool.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM access_requests
      WHERE org_id = $1 AND lower(requested_by) = lower($2)
        AND status IN ('allowed', 'declined', 'done')
        AND ($3::timestamptz IS NULL OR decided_at > $3::timestamptz)`,
    [orgId, email, since]
  );
  return result.rows[0]?.count ?? 0;
}

/** When this person last read their answers here, if they ever have. */
export async function readRequestsSeen(orgId: number, profileId: number): Promise<string | null> {
  await syncMetadataTables();
  const result = await pool.query<{ requests_seen_at: string | null }>(
    `SELECT requests_seen_at FROM memberships WHERE org_id = $1 AND profile_id = $2`,
    [orgId, profileId]
  );
  return result.rows[0]?.requests_seen_at ?? null;
}

export async function markRequestsSeen(orgId: number, profileId: number): Promise<void> {
  await syncMetadataTables();
  await pool.query(
    `UPDATE memberships SET requests_seen_at = now() WHERE org_id = $1 AND profile_id = $2`,
    [orgId, profileId]
  );
}
