/**
 * Computers linked to an account, and the questions waiting for them
 * (lib/agent-rules.ts says why they exist).
 *
 * Kept here: a hash of each computer's token and of each link's device code, so
 * a copy of this database lets nobody act as a computer. The name and environment
 * of the connections a computer shares, and never a host, a user or a password.
 * Questions and answers for as long as they are useful, which sweepAgentRows ends.
 *
 * Linking works like signing in a television: the computer asks for a code, the
 * person checks that code on this site while signed in here, and the computer
 * collects its token. So it needs nothing from Microsoft or Azure beyond the
 * site's own sign-in, and works on any copy of the site.
 */
import { createHash, randomBytes, randomInt } from "node:crypto";
import pool, { syncMetadataTables } from "@/lib/version-db";
import {
  LINK_MINUTES,
  ONLINE_WITHIN_SECONDS,
  QUEUED_FOR_SECONDS,
  RUNNING_FOR_SECONDS,
  TOKEN_PREFIX,
  CODE_LENGTH,
  CODE_LETTERS,
  type Computer,
  type ComputerConnection,
} from "@/lib/agent-rules";
import type { AgentJob } from "@/lib/agent-jobs";

/** Enough for anyone linking at once, and a floor under what a stranger can fill. */
const MOST_OPEN_LINKS = 100;

const MOST_COMPUTERS_PER_PERSON = 10;

const MOST_WAITING_JOBS = 20;

/** Long enough for any answer to be read, since a phone waits two minutes at most. */
const KEEP_JOBS_MINUTES = 10;

/** A computer asks often, and only the online check reads this. */
const SEEN_EVERY_SECONDS = 30;

/** The database's text for a job given up on, as read by every query below. */
const GIVEN_UP = `(j.status = 'queued' AND j.created_at < now() - make_interval(secs => ${QUEUED_FOR_SECONDS}))
    OR (j.status = 'running' AND j.picked_at < now() - make_interval(secs => ${RUNNING_FOR_SECONDS}))`;

/** Only the hash is ever stored: these are as good as a password to whoever holds one. */
export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

function newUserCode(): string {
  return Array.from({ length: CODE_LENGTH }, () => CODE_LETTERS[randomInt(CODE_LETTERS.length)]).join("");
}

export type OpenedLink = { deviceCode: string; userCode: string };

/** Start a link for a computer, or null when too many are waiting already. */
export async function openLink(computerName: string): Promise<OpenedLink | null> {
  await syncMetadataTables();
  await pool.query("DELETE FROM agent_links WHERE expires_at <= now()");
  const deviceCode = randomBytes(32).toString("base64url");
  const userCode = newUserCode();
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO agent_links (device_code_hash, user_code, computer_name, expires_at)
     SELECT $1, $2, $3, now() + make_interval(mins => $4)
      WHERE (SELECT count(*) FROM agent_links) < $5
     ON CONFLICT (user_code) DO NOTHING
     RETURNING id`,
    [hashSecret(deviceCode), userCode, computerName, LINK_MINUTES, MOST_OPEN_LINKS]
  );
  return rows.length === 1 ? { deviceCode, userCode } : null;
}

/** The computer asking to be linked with this code, if the code is still good. */
export async function readLink(userCode: string): Promise<string | null> {
  await syncMetadataTables();
  const { rows } = await pool.query<{ computer_name: string }>(
    `SELECT computer_name FROM agent_links
      WHERE user_code = $1 AND expires_at > now() AND approved_at IS NULL`,
    [userCode]
  );
  return rows[0]?.computer_name ?? null;
}

/** Link the waiting computer to this person in this organization. False if the code is no good. */
export async function approveLink(userCode: string, orgId: number, profileId: number): Promise<boolean> {
  await syncMetadataTables();
  const { rowCount } = await pool.query(
    `UPDATE agent_links
        SET approved_org_id = $2, approved_profile_id = $3, approved_at = now()
      WHERE user_code = $1 AND expires_at > now() AND approved_at IS NULL`,
    [userCode, orgId, profileId]
  );
  return rowCount === 1;
}

/** Turn a computer away. Its next call hears the link is gone. */
export async function denyLink(userCode: string): Promise<void> {
  await syncMetadataTables();
  await pool.query("DELETE FROM agent_links WHERE user_code = $1 AND approved_at IS NULL", [userCode]);
}

export type ClaimResult =
  | { kind: "waiting" }
  | { kind: "gone" }
  | { kind: "linked"; token: string; org: { slug: string; name: string } };

/**
 * What a waiting computer hears. One statement, so a code that two calls present
 * at once links one computer rather than two.
 */
export async function claimLink(deviceCode: string): Promise<ClaimResult> {
  await syncMetadataTables();
  const hash = hashSecret(deviceCode);
  const token = TOKEN_PREFIX + randomBytes(32).toString("base64url");
  // The join is why the membership is checked again: the person may have left in
  // the moments since they approved.
  const { rows } = await pool.query<{ profile_id: number; slug: string; name: string }>(
    `WITH taken AS (
       DELETE FROM agent_links
        WHERE device_code_hash = $1 AND approved_at IS NOT NULL AND expires_at > now()
        RETURNING computer_name, approved_org_id, approved_profile_id
     ), added AS (
       INSERT INTO agents (org_id, profile_id, name, token_hash)
       SELECT t.approved_org_id, t.approved_profile_id, t.computer_name, $2
         FROM taken t
         JOIN memberships m ON m.org_id = t.approved_org_id AND m.profile_id = t.approved_profile_id
       RETURNING org_id, profile_id
     )
     SELECT a.profile_id, o.slug, o.name FROM added a JOIN organizations o ON o.id = a.org_id`,
    [hash, hashSecret(token)]
  );
  const linked = rows[0];
  if (linked) {
    await keepNewestComputers(linked.profile_id);
    return { kind: "linked", token, org: { slug: linked.slug, name: linked.name } };
  }
  const { rows: waiting } = await pool.query(
    "SELECT 1 FROM agent_links WHERE device_code_hash = $1 AND expires_at > now()",
    [hash]
  );
  return waiting.length === 1 ? { kind: "waiting" } : { kind: "gone" };
}

async function keepNewestComputers(profileId: number): Promise<void> {
  await pool.query(
    `DELETE FROM agents
      WHERE profile_id = $1
        AND id NOT IN (
          SELECT id FROM agents WHERE profile_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2
        )`,
    [profileId, MOST_COMPUTERS_PER_PERSON]
  );
}

export type AgentCaller = { id: number; orgId: number; profileId: number };

/**
 * The computer holding this token. The join ends the link the moment its person
 * leaves the organization, without anything having to remember to delete it.
 */
export async function findAgent(token: string): Promise<AgentCaller | null> {
  await syncMetadataTables();
  const { rows } = await pool.query<{ id: number; org_id: number; profile_id: number }>(
    `SELECT a.id, a.org_id, a.profile_id
       FROM agents a
       JOIN memberships m ON m.org_id = a.org_id AND m.profile_id = a.profile_id
      WHERE a.token_hash = $1`,
    [hashSecret(token)]
  );
  const row = rows[0];
  return row ? { id: row.id, orgId: row.org_id, profileId: row.profile_id } : null;
}

/** Unlink a computer, at its own asking. */
export async function removeAgent(agentId: number): Promise<void> {
  await pool.query("DELETE FROM agents WHERE id = $1", [agentId]);
}

/** Replace the connections a computer shares with this list. */
export async function replaceAgentConnections(agentId: number, connections: ComputerConnection[]): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM agent_connections WHERE agent_id = $1 AND local_id <> ALL($2::int[])", [
      agentId,
      connections.map((connection) => connection.id),
    ]);
    if (connections.length > 0) {
      await client.query(
        `INSERT INTO agent_connections (agent_id, local_id, name, environment, shared, drift)
         SELECT $1::int, u.id, u.name, u.environment, u.shared, u.drift::jsonb
           FROM unnest($2::int[], $3::text[], $4::text[], $5::boolean[], $6::text[]) AS u(id, name, environment, shared, drift)
         ON CONFLICT (agent_id, local_id)
         DO UPDATE SET name = EXCLUDED.name, environment = EXCLUDED.environment, shared = EXCLUDED.shared,
                       drift = EXCLUDED.drift`,
        [
          agentId,
          connections.map((connection) => connection.id),
          connections.map((connection) => connection.name),
          connections.map((connection) => connection.environment),
          connections.map((connection) => connection.shared !== false),
          connections.map((connection) => (connection.drift === undefined ? null : JSON.stringify(connection.drift))),
        ]
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export type PickedJob = { id: number; method: string; params: unknown };

/**
 * The oldest question waiting for this computer, now marked as running. One
 * statement, so it holds no transaction open through a transaction pooler.
 */
export async function nextAgentJob(agentId: number): Promise<PickedJob | null> {
  await pool.query(
    `UPDATE agents SET last_seen_at = now()
      WHERE id = $1 AND (last_seen_at IS NULL OR last_seen_at < now() - make_interval(secs => $2))`,
    [agentId, SEEN_EVERY_SECONDS]
  );
  const { rows } = await pool.query<PickedJob>(
    `UPDATE agent_jobs SET status = 'running', picked_at = now()
      WHERE id = (
        SELECT id FROM agent_jobs
         WHERE agent_id = $1 AND status = 'queued'
           AND created_at > now() - make_interval(secs => $2)
         ORDER BY id
         LIMIT 1
         FOR UPDATE SKIP LOCKED
      )
      RETURNING id, method, params`,
    [agentId, QUEUED_FOR_SECONDS]
  );
  return rows[0] ?? null;
}

/** The kind of question this computer is answering, or null if it holds no such job. */
export async function runningJobMethod(agentId: number, jobId: number): Promise<string | null> {
  const { rows } = await pool.query<{ method: string }>(
    "SELECT method FROM agent_jobs WHERE id = $1 AND agent_id = $2 AND status = 'running'",
    [jobId, agentId]
  );
  return rows[0]?.method ?? null;
}

/** Keep the answer. False if this computer holds no such running job. */
export async function finishAgentJob(
  agentId: number,
  jobId: number,
  answer: { result: unknown } | { refusal: string }
): Promise<boolean> {
  const done = "result" in answer;
  const { rowCount } = await pool.query(
    `UPDATE agent_jobs
        SET status = $3, result = $4::jsonb, refusal = $5, finished_at = now()
      WHERE id = $1 AND agent_id = $2 AND status = 'running'`,
    [
      jobId,
      agentId,
      done ? "done" : "failed",
      done ? JSON.stringify(answer.result) : null,
      done ? null : answer.refusal,
    ]
  );
  return rowCount === 1;
}

/**
 * This person's computers in this organization. Nobody else's, by design. With
 * `everything`, each computer's unshared connections too, for the website's
 * Connections page; without it only the ones picked for the phone.
 */
export async function listComputers(orgId: number, profileId: number, everything = false): Promise<Computer[]> {
  await syncMetadataTables();
  const { rows } = await pool.query<{
    id: number;
    name: string;
    online: boolean;
    last_seen_at: Date | null;
    connections: ComputerConnection[];
  }>(
    `SELECT a.id, a.name, a.last_seen_at,
            COALESCE(a.last_seen_at > now() - make_interval(secs => $3), false) AS online,
            COALESCE(
              (SELECT json_agg(json_build_object('id', c.local_id, 'name', c.name, 'environment', c.environment,
                                                 'shared', c.shared, 'drift', COALESCE(c.drift, '[]'::jsonb))
                               ORDER BY c.name, c.local_id)
                 FROM agent_connections c WHERE c.agent_id = a.id AND ($4 OR c.shared)),
              '[]'
            ) AS connections
       FROM agents a
      WHERE a.org_id = $1 AND a.profile_id = $2
      ORDER BY a.name, a.id`,
    [orgId, profileId, ONLINE_WITHIN_SECONDS, everything]
  );
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    online: row.online,
    lastSeenAt: row.last_seen_at ? row.last_seen_at.toISOString() : null,
    connections: row.connections,
  }));
}

/** One linked computer as the whole organization sees it. */
export type OrgComputer = {
  id: number;
  name: string;
  /** Who linked it, by their name. */
  owner: string;
  /** True for the person asking. */
  mine: boolean;
  online: boolean;
  lastSeenAt: string | null;
  /** The connections kept only on that computer, by name and environment. Nothing else leaves it. */
  connections: { id: number; name: string; environment: string }[];
};

/**
 * Every computer linked in this organization, with the connections only it
 * holds. Everyone who can read connections sees these by name, so a laptop's
 * databases are listed for the org the same way the server's local ones are.
 * Names and environments only: comparing or removing a computer stays its
 * owner's (listComputers, removeComputer).
 */
export async function listOrgComputers(orgId: number, profileId: number | null): Promise<OrgComputer[]> {
  await syncMetadataTables();
  const { rows } = await pool.query<{
    id: number;
    name: string;
    owner: string;
    mine: boolean;
    online: boolean;
    last_seen_at: Date | null;
    connections: OrgComputer["connections"];
  }>(
    `SELECT a.id, a.name, a.last_seen_at,
            COALESCE(NULLIF(btrim(p.name), ''), 'Someone in this organization') AS owner,
            COALESCE(a.profile_id = $2, false) AS mine,
            COALESCE(a.last_seen_at > now() - make_interval(secs => $3), false) AS online,
            COALESCE(
              (SELECT json_agg(json_build_object('id', c.local_id, 'name', c.name, 'environment', c.environment)
                               ORDER BY c.name, c.local_id)
                 FROM agent_connections c WHERE c.agent_id = a.id),
              '[]'
            ) AS connections
       FROM agents a
       LEFT JOIN profiles p ON p.id = a.profile_id
      WHERE a.org_id = $1
      ORDER BY (a.profile_id = $2) DESC NULLS LAST, owner, a.name, a.id`,
    [orgId, profileId, ONLINE_WITHIN_SECONDS]
  );
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    owner: row.owner,
    mine: row.mine,
    online: row.online,
    lastSeenAt: row.last_seen_at ? row.last_seen_at.toISOString() : null,
    connections: row.connections,
  }));
}

/** Unlink one of this person's computers. False if it is not theirs. */
export async function removeComputer(orgId: number, profileId: number, agentId: number): Promise<boolean> {
  await syncMetadataTables();
  const { rowCount } = await pool.query(
    "DELETE FROM agents WHERE id = $1 AND org_id = $2 AND profile_id = $3",
    [agentId, orgId, profileId]
  );
  return rowCount === 1;
}

export type JobCreated =
  | { kind: "created"; id: number }
  | { kind: "no-computer" }
  | { kind: "off" }
  | { kind: "not-shared" }
  | { kind: "too-many" };

/** Leave a question for one of this person's computers, after every check it needs. */
export async function createAgentJob(
  orgId: number,
  profileId: number,
  agentId: number,
  job: AgentJob,
  connectionIds: number[]
): Promise<JobCreated> {
  await syncMetadataTables();
  await sweepAgentRows();
  const { rows: found } = await pool.query<{ online: boolean; shared: number[] }>(
    `SELECT COALESCE(a.last_seen_at > now() - make_interval(secs => $4), false) AS online,
            ARRAY(SELECT c.local_id FROM agent_connections c WHERE c.agent_id = a.id AND c.shared) AS shared
       FROM agents a
      WHERE a.id = $1 AND a.org_id = $2 AND a.profile_id = $3`,
    [agentId, orgId, profileId, ONLINE_WITHIN_SECONDS]
  );
  const computer = found[0];
  if (!computer) return { kind: "no-computer" };
  if (!computer.online) return { kind: "off" };
  if (!connectionIds.every((id) => computer.shared.includes(id))) return { kind: "not-shared" };
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO agent_jobs (agent_id, method, params)
     SELECT $1::int, $2::text, $3::jsonb
      WHERE (SELECT count(*) FROM agent_jobs j
              WHERE j.agent_id = $1 AND j.status IN ('queued', 'running') AND NOT (${GIVEN_UP})) < $4
     RETURNING id`,
    [agentId, job.method, JSON.stringify(job.params), MOST_WAITING_JOBS]
  );
  return rows[0] ? { kind: "created", id: rows[0].id } : { kind: "too-many" };
}

export type JobRead =
  | { status: "waiting" }
  | { status: "done"; result: unknown }
  | { status: "failed"; refusal: string | null }
  | { status: "timed-out" };

/** How a question to one of this person's computers stands, or null if it is not theirs. */
export async function readAgentJobFor(orgId: number, profileId: number, jobId: number): Promise<JobRead | null> {
  await syncMetadataTables();
  const { rows } = await pool.query<{ status: string; result: unknown; refusal: string | null; given_up: boolean }>(
    `SELECT j.status, j.result, j.refusal, (${GIVEN_UP}) AS given_up
       FROM agent_jobs j
       JOIN agents a ON a.id = j.agent_id
      WHERE j.id = $1 AND a.org_id = $2 AND a.profile_id = $3`,
    [jobId, orgId, profileId]
  );
  const row = rows[0];
  if (!row) return null;
  if (row.status === "done") return { status: "done", result: row.result };
  if (row.status === "failed") return { status: "failed", refusal: row.refusal };
  return row.given_up ? { status: "timed-out" } : { status: "waiting" };
}

/**
 * Clear out old questions, old answers and links nobody approved. Called when a
 * question is asked and on every drift tick, so an answer does not stay in this
 * database for long even if nobody ever asks another.
 */
export async function sweepAgentRows(): Promise<void> {
  await pool.query("DELETE FROM agent_jobs WHERE created_at < now() - make_interval(mins => $1)", [
    KEEP_JOBS_MINUTES,
  ]);
  await pool.query("DELETE FROM agent_links WHERE expires_at <= now()");
}

