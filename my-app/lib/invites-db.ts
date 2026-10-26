import { createHash, randomBytes } from "node:crypto";
import pool, { syncMetadataTables } from "./version-db";
import type { MetadataClient } from "./db/sequelize";
import { logRoleChanges } from "./roles-db";
import {
  EMAIL_INVITE_DAYS,
  LINK_INVITE_ROLE,
  isInviteToken,
  maskEmail,
  type LinkInviteDays,
  type PendingInvite,
} from "./invites";
import type { OrgSummary } from "./organization-list";

/**
 * Invitations in the database: making them, cancelling them, and taking one
 * to join its organization. lib/invites.ts says what an invitation is and
 * the rules screens share; this is the part only the server runs.
 *
 * The token. An invitation is found by a random token in its link. Only the
 * token's SHA-256 is stored, so the invites table is no list of working links:
 * a backup, a log of queries, or someone reading the table can see who was
 * invited but cannot join as them. The token itself is handed back once, to
 * the Admin who made it, and never again. A plain hash is enough because the
 * token is 32 random bytes: there is nothing to guess, so nothing a slow hash
 * would protect. Nothing here logs a token or its hash.
 *
 * Who may take one. A link is for whoever holds it. An invitation to an
 * address is for whoever can prove they own that address, and the proof is a
 * sign-in whose provider vouched for it: an identity of the caller with that
 * address and email_verified set (lib/accounts-db.ts says when a provider
 * vouches). A profile's own email is not enough. It is only the address the
 * person had when their profile was made, and it may be one no provider
 * vouches for today.
 *
 * Everything that writes runs in one transaction with its line in the change
 * log (lib/roles-db.ts logRoleChanges), so the Admin screen never shows an
 * invitation that was not made or misses one that was.
 */

type Queryable = Pick<MetadataClient, "query">;

/** The SHA-256 of a token, as the invites table stores it. */
export function hashInviteToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** A new token: 32 random bytes, in base64url so it fits in a link as it is. */
function newToken(): string {
  return randomBytes(32).toString("base64url");
}

type PendingRow = {
  id: number;
  kind: "email" | "link";
  email: string | null;
  role: string;
  role_label: string;
  invited_by: string | null;
  created_at: Date | string;
  expires_at: Date | string;
};

/** pg hands timestamptz back as a Date; JSON wants a string either way. */
function isoTime(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function toPending(row: PendingRow): PendingInvite {
  return {
    id: row.id,
    kind: row.kind,
    email: row.email,
    role: row.role,
    roleLabel: row.role_label,
    invitedBy: row.invited_by,
    createdAt: isoTime(row.created_at),
    expiresAt: isoTime(row.expires_at),
  };
}

/**
 * The invitations of one organization that can still be taken: not used, not
 * cancelled, and not run out. Newest first. With `id`, only that one.
 */
async function readPending(db: Queryable, orgId: number, id?: number): Promise<PendingInvite[]> {
  const { rows } = await db.query<PendingRow>(
    `SELECT i.id, i.kind, i.email, i.role, r.label AS role_label,
            p.email AS invited_by, i.created_at, i.expires_at
       FROM invites i
       JOIN roles r ON r.org_id = i.org_id AND r.name = i.role
       LEFT JOIN profiles p ON p.id = i.invited_by
      WHERE i.org_id = $1
        AND i.used_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now()
        AND ($2::int IS NULL OR i.id = $2)
      ORDER BY i.id DESC`,
    [orgId, id ?? null]
  );
  return rows.map(toPending);
}

/** The invitations of one organization that are waiting to be taken, newest first. */
export async function listPendingInvites(orgId: number): Promise<PendingInvite[]> {
  await syncMetadataTables();
  return readPending(pool, orgId);
}

/** What making an invitation did. Every refusal wrote nothing. */
export type InviteMade =
  | { kind: "made"; invite: PendingInvite; token: string }
  /** No role by that name here. It may have just been deleted. */
  | { kind: "no-role" }
  /** Someone with that address belongs to this organization already. */
  | { kind: "member" }
  /** Another Admin invited the same address at the same moment, and theirs went in first. */
  | { kind: "just-invited" };

/**
 * Run `work` in a transaction on a client of its own, committing when it
 * says to and rolling back otherwise, or when it throws.
 */
async function inTransaction<T>(
  work: (client: MetadataClient) => Promise<{ commit: boolean; result: T }>
): Promise<T> {
  await syncMetadataTables();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { commit, result } = await work(client);
    await client.query(commit ? "COMMIT" : "ROLLBACK");
    return result;
  } catch (error) {
    // The ROLLBACK can fail too (the connection may be what broke), and the
    // error worth reporting is the first one.
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Invite an email address into an organization with a role.
 *
 * The address must already be cleaned and checked (lib/invites.ts), and
 * `role` is a role's name, which is looked up here because Admins add and
 * delete roles. FOR KEY SHARE keeps that role from being deleted until this
 * commits, the same way a role change on the Users tab does.
 *
 * An earlier invitation to the same address that nobody took is cancelled
 * first, so there is only ever one way in for one address: the newest, with
 * the role the Admin picked last. The unique index invites_pending_email_key
 * holds that even when two Admins invite the same address at the same
 * moment. The second one's insert waits for the first, then fails, and that
 * Admin hears it was invited a moment ago.
 */
export async function createEmailInvite(
  orgId: number,
  input: { email: string; role: string; invitedBy: number; actor: string }
): Promise<InviteMade> {
  try {
    return await inTransaction<InviteMade>(async (client) => {
      const role = await client.query(
        `SELECT label FROM roles WHERE org_id = $1 AND name = $2 FOR KEY SHARE`,
        [orgId, input.role]
      );
      if (role.rows.length === 0) return { commit: false, result: { kind: "no-role" } };

      // A member already, under the address their profile was made with or
      // under one a provider vouched for when they signed in since.
      const member = await client.query(
        `SELECT 1 FROM memberships m
           JOIN profiles p ON p.id = m.profile_id
          WHERE m.org_id = $1
            AND (lower(p.email) = $2
                 OR EXISTS (SELECT 1 FROM identities d
                             WHERE d.profile_id = m.profile_id
                               AND lower(d.email) = $2 AND d.email_verified))
          LIMIT 1`,
        [orgId, input.email]
      );
      if (member.rows.length > 0) return { commit: false, result: { kind: "member" } };

      await client.query(
        `UPDATE invites SET revoked_at = now()
          WHERE org_id = $1 AND email = $2 AND used_at IS NULL AND revoked_at IS NULL`,
        [orgId, input.email]
      );
      const token = newToken();
      const inserted = await client.query<{ id: number }>(
        `INSERT INTO invites (org_id, token_hash, kind, email, role, invited_by, expires_at)
         VALUES ($1, $2, 'email', $3, $4, $5, now() + make_interval(days => $6::int))
         RETURNING id`,
        [orgId, hashInviteToken(token), input.email, input.role, input.invitedBy, EMAIL_INVITE_DAYS]
      );
      await logRoleChanges(client, orgId, [
        { role: input.role, kind: "invite", subject: input.email, actor: input.actor },
      ]);
      const [invite] = await readPending(client, orgId, inserted.rows[0].id);
      return { commit: true, result: { kind: "made", invite, token } };
    });
  } catch (error) {
    if (isUniqueViolation(error, "invites_pending_email_key")) return { kind: "just-invited" };
    throw error;
  }
}

function isUniqueViolation(error: unknown, constraint: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "23505" &&
    (error as { constraint?: unknown }).constraint === constraint
  );
}

/**
 * Make an invitation link into an organization, as a Viewer, lasting `days`.
 *
 * There is no address to check and no earlier link to cancel: an Admin may
 * keep several links going at once, say one per class, and cancel each on its
 * own. The change log's detail says how many days it was made for.
 */
export async function createLinkInvite(
  orgId: number,
  input: { days: LinkInviteDays; invitedBy: number; actor: string }
): Promise<Extract<InviteMade, { kind: "made" }>> {
  return inTransaction(async (client) => {
    const token = newToken();
    const inserted = await client.query<{ id: number }>(
      `INSERT INTO invites (org_id, token_hash, kind, email, role, invited_by, expires_at)
       VALUES ($1, $2, 'link', NULL, $3, $4, now() + make_interval(days => $5::int))
       RETURNING id`,
      [orgId, hashInviteToken(token), LINK_INVITE_ROLE, input.invitedBy, input.days]
    );
    await logRoleChanges(client, orgId, [
      { role: LINK_INVITE_ROLE, kind: "invite", detail: String(input.days), actor: input.actor },
    ]);
    const [invite] = await readPending(client, orgId, inserted.rows[0].id);
    return { commit: true, result: { kind: "made", invite, token } };
  });
}

/**
 * Cancel an invitation of this organization that nobody has taken yet. One
 * that was used, already cancelled, or belongs to another organization is
 * "not-found", the same answer as one that never existed.
 */
export async function cancelInvite(
  orgId: number,
  id: number,
  actor: string
): Promise<{ kind: "cancelled" } | { kind: "not-found" }> {
  return inTransaction<{ kind: "cancelled" } | { kind: "not-found" }>(async (client) => {
    const cancelled = await client.query<{ email: string | null; role: string }>(
      `UPDATE invites SET revoked_at = now()
        WHERE org_id = $1 AND id = $2 AND used_at IS NULL AND revoked_at IS NULL
        RETURNING email, role`,
      [orgId, id]
    );
    const row = cancelled.rows[0];
    if (!row) return { commit: false, result: { kind: "not-found" } };
    await logRoleChanges(client, orgId, [
      { role: row.role, kind: "cancel-invite", subject: row.email, actor },
    ]);
    return { commit: true, result: { kind: "cancelled" } };
  });
}

/**
 * What an invitation is, to the person holding its link. The invitation page
 * draws one view for each.
 *
 * Only an invitation this person can take names the organization it is for,
 * along with "member" (they are in it already, so they know) and
 * "wrong-account" (they are told which account to use, and the name of the
 * organization helps them tell whether the invitation is theirs at all). A
 * link that was cancelled, ran out, or was used says only that, because the
 * link could be anyone's.
 */
export type InviteLookup =
  /** No invitation has this token. Mistyped, made up, or its role was deleted. */
  | { kind: "invalid" }
  /** An Admin cancelled it, or invited the same address again since. */
  | { kind: "revoked" }
  | { kind: "expired" }
  /** An invitation to an address, which its owner has already taken. */
  | { kind: "used" }
  /** This person belongs to the organization already. */
  | { kind: "member"; organization: OrgSummary }
  /** An invitation to an address this person has not signed in with. */
  | { kind: "wrong-account"; organization: OrgSummary; maskedEmail: string }
  | {
      kind: "ok";
      organization: OrgSummary;
      role: string;
      roleLabel: string;
      invite: "email" | "link";
    }
  /** The profile behind the session is gone: somebody deleted it after this person signed in. */
  | { kind: "no-profile" };

/** What taking an invitation did. Only "joined" wrote anything. */
export type InviteAcceptance = Refusal | { kind: "joined"; organization: OrgSummary };

type Refusal = Exclude<InviteLookup, { kind: "ok" }>;

type FoundInvite = {
  id: number;
  org_id: number;
  slug: string;
  org_name: string;
  kind: "email" | "link";
  email: string | null;
  role: string;
  role_label: string;
  revoked: boolean;
  used: boolean;
  expired: boolean;
  member: boolean;
  vouched: boolean;
};

/**
 * Look an invitation up by its token and say what it is to this person.
 * `lock` takes the invitation's row for the rest of the transaction, so a
 * cancel that lands while someone is joining waits for them, or they for it.
 * An invitation that can be taken comes back with its row, for acceptInvite
 * to act on.
 */
async function judge(
  db: Queryable,
  token: string,
  profileId: number,
  { lock }: { lock: boolean }
): Promise<
  | { lookup: Refusal; found?: undefined }
  | { lookup: Extract<InviteLookup, { kind: "ok" }>; found: FoundInvite }
> {
  const { rows } = await db.query<FoundInvite>(
    `-- every organization: an invitation is found by its token before anyone knows its organization
     SELECT i.id, i.org_id, o.slug, o.name AS org_name, i.kind, i.email, i.role,
            r.label AS role_label,
            i.revoked_at IS NOT NULL AS revoked,
            i.used_at IS NOT NULL AS used,
            i.expires_at <= now() AS expired,
            EXISTS (SELECT 1 FROM memberships m
                     WHERE m.org_id = i.org_id AND m.profile_id = $2) AS member,
            EXISTS (SELECT 1 FROM identities d
                     WHERE d.profile_id = $2 AND lower(d.email) = i.email
                       AND d.email_verified) AS vouched
       FROM invites i
       JOIN organizations o ON o.id = i.org_id
       JOIN roles r ON r.org_id = i.org_id AND r.name = i.role
      WHERE i.token_hash = $1
      ${lock ? "FOR UPDATE OF i" : ""}`,
    [hashInviteToken(token), profileId]
  );
  const found = rows[0];
  if (!found) return { lookup: { kind: "invalid" } };

  // In this order: someone already in has nothing to take, whatever became of
  // the invitation since, and an invitation that cannot be taken by anyone is
  // not worth sending them off to another account for.
  const organization = { slug: found.slug, name: found.org_name };
  if (found.member) return { lookup: { kind: "member", organization } };
  if (found.revoked) return { lookup: { kind: "revoked" } };
  if (found.expired) return { lookup: { kind: "expired" } };
  if (found.used) return { lookup: { kind: "used" } };
  if (found.kind === "email" && !found.vouched) {
    return {
      lookup: { kind: "wrong-account", organization, maskedEmail: maskEmail(found.email ?? "") },
    };
  }
  return {
    lookup: {
      kind: "ok",
      organization,
      role: found.role,
      roleLabel: found.role_label,
      invite: found.kind,
    },
    found,
  };
}

/**
 * What the invitation with this token is to this person, for the invitation
 * page to draw before they choose to join. Changes nothing.
 */
export async function inspectInvite(token: string, profileId: number): Promise<InviteLookup> {
  if (!isInviteToken(token)) return { kind: "invalid" };
  await syncMetadataTables();
  const profile = await pool.query(`SELECT 1 FROM profiles WHERE id = $1`, [profileId]);
  if (profile.rows.length === 0) return { kind: "no-profile" };
  return (await judge(pool, token, profileId, { lock: false })).lookup;
}

/**
 * Take an invitation: join its organization with its role.
 *
 * Everything is checked again here, inside the transaction that joins, rather
 * than trusted from the page: the invitation may have been cancelled, used or
 * run out since the page was drawn, and a request does not have to come from
 * the page at all.
 *
 * The profile is locked first, as making an organization does
 * (lib/orgs-db.ts). That keeps it from being deleted before the membership
 * naming it is written, and it lines up a double click: the second request
 * waits for the first, then reads the invitation afresh and finds the person
 * is a member already.
 *
 * On joining: the membership, the invitation marked used (an invitation to an
 * address works once; a link stays open for the next person), the profile's
 * last organization set so the studio opens there next, and a "join" line in
 * the change log. The joiner is its actor, since it was their doing.
 */
export async function acceptInvite(token: string, profileId: number): Promise<InviteAcceptance> {
  if (!isInviteToken(token)) return { kind: "invalid" };
  return inTransaction<InviteAcceptance>(async (client) => {
    const profile = await client.query<{ email: string }>(
      `SELECT email FROM profiles WHERE id = $1 FOR NO KEY UPDATE`,
      [profileId]
    );
    const person = profile.rows[0];
    if (!person) return { commit: false, result: { kind: "no-profile" } };

    const judged = await judge(client, token, profileId, { lock: true });
    if (judged.found === undefined) return { commit: false, result: judged.lookup };
    const { lookup, found } = judged;

    const joined = await client.query(
      `INSERT INTO memberships (org_id, profile_id, role) VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING
       RETURNING profile_id`,
      [found.org_id, profileId, found.role]
    );
    if (joined.rows.length === 0) {
      return { commit: false, result: { kind: "member", organization: lookup.organization } };
    }
    if (found.kind === "email") {
      await client.query(
        `UPDATE invites SET used_at = now(), used_by = $3 WHERE org_id = $1 AND id = $2`,
        [found.org_id, found.id, profileId]
      );
    }
    await client.query(`UPDATE profiles SET last_org_id = $2 WHERE id = $1`, [
      profileId,
      found.org_id,
    ]);
    await logRoleChanges(client, found.org_id, [
      {
        role: found.role,
        kind: "join",
        subject: person.email,
        detail: found.kind,
        actor: person.email,
      },
    ]);
    return { commit: true, result: { kind: "joined", organization: lookup.organization } };
  });
}
