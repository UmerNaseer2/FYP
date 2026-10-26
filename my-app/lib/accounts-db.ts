import pool, { syncMetadataTables } from "./version-db";
import type { MetadataClient } from "./db/sequelize";
import { ADMIN_ROLE, DEFAULT_ROLE } from "./permissions";

/**
 * Who has just signed in, and which person in this app that is.
 *
 * A person (a row in `profiles`) can have more than one way of signing in: a
 * Microsoft account, a GitHub account, or both. Each is a row in `identities`,
 * found by the provider's own fixed ID for the account, never by the email
 * address it reports. lib/db/models.ts explains why: an address is something
 * people can change, and on Microsoft's multi-tenant sign-in any organization's
 * admin can put any address on their own accounts. Matching on the address
 * would let a stranger sign in as someone else by giving an account their
 * address.
 *
 * auth.ts calls identityFrom() and then resolveIdentity() on every sign-in, and
 * puts the profile ID it gets back into the session. Every request after that
 * finds the person by that ID (lib/auth-guard.ts), so the address a provider
 * hands over is only ever read here.
 */

/** A sign-in, reduced to what deciding who it is needs. */
export type SignInIdentity = {
  provider: "microsoft" | "github";
  /** The provider's fixed ID for the account. See lib/db/models.ts. */
  subject: string;
  email: string;
  /** True when the provider vouches that the address belongs to this account. */
  emailVerified: boolean;
  name: string | null;
  /**
   * True for an account in the client's own Microsoft tenant (the one
   * AZURE_AD_TENANT_ID names), which is where every account from before this
   * table came from, and whose admins are the client's own IT.
   */
  homeTenant: boolean;
};

/**
 * What resolveIdentity() decided.
 *   - "ok": the person, by their profile ID, and the address the app knows
 *     them by (their profile's, which can differ from what the provider sent
 *     this time).
 *   - "taken": the address belongs to somebody here who signs in another way.
 *     Linking it to this account on the provider's word alone is the very
 *     takeover the identities table exists to stop, so the person is asked to
 *     sign in the way they did before.
 *   - "unverified": an account not seen before, whose provider does not vouch
 *     for its address. Making it a person under that address would let it hold
 *     an address that is not its own, and an invitation sent there would then
 *     go to it. The answer is the same whether or not somebody here has the
 *     address, so trying addresses that are not your own never shows which
 *     ones have an account.
 */
export type Resolved =
  | { kind: "ok"; profileId: number; email: string }
  | { kind: "taken" }
  | { kind: "unverified" };

/** What auth.ts's signIn callback is handed, as much of it as this reads. */
export type SignInParams = {
  user: { id?: string | null; email?: string | null; name?: string | null };
  account?: { provider: string } | null;
  profile?: Record<string, unknown> | null;
};

/** A value, if it is a string with something in it. */
function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** The desktop app starts this server with SCHEMA_STUDIO_DESKTOP=1 (see auth.config.ts). */
function inDesktopApp(): boolean {
  return process.env.SCHEMA_STUDIO_DESKTOP === "1";
}

/**
 * The sign-in Auth.js is asking about, or null when it does not say who signed
 * in or gives no address to know them by.
 *
 * Each provider hands its details over in its own shape:
 *   - Microsoft in the browser: the ID token's claims, as `profile`. The
 *     account is `tid:oid`, the tenant and the object ID, which together name
 *     one account for every app (`sub` would do too, but it differs between
 *     apps, and the desktop app is registered separately). The address is the
 *     `email` claim, or for a work account with no mailbox its sign-in name,
 *     which is an address as well. An account in the home tenant is trusted
 *     with its address, as it always was here. One from anywhere else is only
 *     when Microsoft says the address's domain is verified (`xms_edov`, an
 *     optional claim the app registration has to ask for, and only ever about
 *     the `email` claim).
 *   - Microsoft in the desktop app: lib/desktop-sign-in.ts has already checked
 *     the token, refused any tenant but the home one, and put `tid:oid` in
 *     `user.id`.
 *   - GitHub: the user's details from GitHub's API, as `profile`, with the
 *     address and whether GitHub has verified it filled in by auth.config.ts
 *     from the account's primary address. The account is the numeric user ID,
 *     which stays the same when someone renames their account.
 *
 * The IDs are lowercased, because Microsoft writes them in lowercase and one
 * pasted from the Azure portal in capitals is still the same ID.
 */
export function identityFrom({ user, account, profile }: SignInParams): SignInIdentity | null {
  const name = text(user.name);
  switch (account?.provider) {
    case "microsoft-entra-id": {
      const tid = text(profile?.tid)?.toLowerCase();
      const oid = text(profile?.oid)?.toLowerCase();
      const claimed = text(profile?.email);
      const email = [claimed, text(profile?.preferred_username)].find(
        (value): value is string => value !== null && value.includes("@")
      );
      if (!tid || !oid || !email) return null;
      const homeTenant = tid === (process.env.AZURE_AD_TENANT_ID ?? "").trim().toLowerCase();
      return {
        provider: "microsoft",
        subject: `${tid}:${oid}`,
        email,
        emailVerified: homeTenant || (email === claimed && profile?.xms_edov === true),
        name,
        homeTenant,
      };
    }
    case "desktop": {
      const subject = text(user.id)?.toLowerCase();
      const email = text(user.email);
      if (!subject || !email) return null;
      return {
        provider: "microsoft",
        subject,
        email,
        emailVerified: true,
        name,
        homeTenant: true,
      };
    }
    case "github": {
      const id = profile?.id;
      const subject = typeof id === "number" || typeof id === "string" ? text(String(id)) : null;
      const email = text(profile?.email);
      if (!subject || !email) return null;
      return {
        provider: "github",
        subject,
        email,
        emailVerified: profile?.email_verified === true,
        name,
        homeTenant: false,
      };
    }
    default:
      return null;
  }
}

/**
 * A sign-in that met another one for the same person or address halfway
 * through. The whole decision is made again from the start, and the second
 * time it finds what the other one wrote.
 */
const RACED = Symbol("raced");

/**
 * Three is plenty: a decision only races with another sign-in for the same
 * account or address, and the second try sees that sign-in's work.
 */
const ATTEMPTS = 3;

/**
 * The person `who` is, making them an account if they are new. One
 * transaction, so a sign-in never leaves half a person behind:
 *
 *   1. An account seen before is that person, whatever address it reports
 *      today. Their name and when they were last seen are brought up to date;
 *      their address here is not, because it is what the app and its admins
 *      know them by.
 *   2. Otherwise, an address the provider does not vouch for goes no further
 *      ("unverified", see Resolved).
 *   3. An address that already has a person is theirs, and this account is
 *      linked to them in one case only: an account in the home tenant,
 *      signing in to a person with no account linked at all. Those are the
 *      people from before this table, who all signed in through the home
 *      tenant by address, and are now matched to their account on their first
 *      sign-in since. Anything else is "taken" (see Resolved).
 *   4. Otherwise this is someone new, and they get a person of their own.
 *
 * Then where they start (joinOnSignIn). Signing in never changes a role
 * somebody already has.
 *
 * Two sign-ins at the same moment are settled by the unique indexes, never by
 * a check that the other could slip past: each insert gives way on a conflict
 * rather than failing, the transaction starts over, and the second time round
 * it finds the other sign-in's rows. The address match holds the person's row
 * until the end, so two accounts cannot both be linked to them at once.
 */
export async function resolveIdentity(signIn: SignInIdentity): Promise<Resolved> {
  await syncMetadataTables();
  // Stored in lower case, because providers are not consistent about the case
  // they hand back, and "Umer@x" and "umer@x" are the same person.
  const who = { ...signIn, email: signIn.email.trim().toLowerCase() };

  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await settle(client, who);
      if (result !== RACED && result.kind === "ok") {
        await client.query("COMMIT");
        return result;
      }
      // A refusal has written nothing, and a race has to undo what it wrote.
      await client.query("ROLLBACK");
      if (result !== RACED) return result;
    } catch (error) {
      // The ROLLBACK can fail too (the connection may be what broke), and the
      // error worth reporting is the first one.
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }
  throw new Error(
    `Could not settle the account for a ${who.provider} sign-in in ${ATTEMPTS} tries.`
  );
}

/** One try at resolveIdentity's decision, inside its transaction. */
async function settle(
  client: MetadataClient,
  who: SignInIdentity
): Promise<Resolved | typeof RACED> {
  // 1. An account seen before.
  const known = await client.query<{ identity_id: number; profile_id: number; email: string }>(
    `SELECT i.id AS identity_id, p.id AS profile_id, p.email
       FROM identities i JOIN profiles p ON p.id = i.profile_id
      WHERE i.provider = $1 AND i.subject = $2`,
    [who.provider, who.subject]
  );
  if (known.rows.length > 0) {
    const { identity_id, profile_id, email } = known.rows[0];
    await client.query(
      `UPDATE identities SET email = $2, email_verified = $3, last_seen_at = now() WHERE id = $1`,
      [identity_id, who.email, who.emailVerified]
    );
    await seen(client, profile_id, who.name);
    await joinOnSignIn(client, profile_id, who);
    return { kind: "ok", profileId: profile_id, email };
  }

  // 2. An address nobody vouches for.
  if (!who.emailVerified) return { kind: "unverified" };

  // 3. An address that already has a person. Held until the transaction ends,
  // so a second account cannot be linked to them in the meantime.
  const byEmail = await client.query<{ id: number; email: string }>(
    `SELECT id, email FROM profiles WHERE lower(email) = lower($1) FOR UPDATE`,
    [who.email]
  );
  if (byEmail.rows.length > 0) {
    const { id, email } = byEmail.rows[0];
    if (!(who.provider === "microsoft" && who.homeTenant)) return { kind: "taken" };
    const linked = await client.query(`SELECT 1 FROM identities WHERE profile_id = $1 LIMIT 1`, [
      id,
    ]);
    if (linked.rows.length > 0) return { kind: "taken" };
    if (!(await addIdentity(client, id, who))) return RACED;
    await seen(client, id, who.name);
    await joinOnSignIn(client, id, who);
    return { kind: "ok", profileId: id, email };
  }

  // 4. Someone new. The unique index is on lower(email), so a row written by
  // hand in capitals was still found in step 3.
  const created = await client.query<{ id: number; email: string }>(
    `INSERT INTO profiles (email, name, last_seen_at) VALUES ($1, $2, now())
     ON CONFLICT ((lower(email))) DO NOTHING
     RETURNING id, email`,
    [who.email, who.name]
  );
  if (created.rows.length === 0) return RACED;
  const { id, email } = created.rows[0];
  if (!(await addIdentity(client, id, who))) return RACED;
  await joinOnSignIn(client, id, who);
  return { kind: "ok", profileId: id, email };
}

/** Links `who`'s account to a person. False when another sign-in just did. */
async function addIdentity(
  client: MetadataClient,
  profileId: number,
  who: SignInIdentity
): Promise<boolean> {
  const { rows } = await client.query(
    `INSERT INTO identities (provider, subject, profile_id, email, email_verified, last_seen_at)
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (provider, subject) DO NOTHING
     RETURNING id`,
    [who.provider, who.subject, profileId, who.email, who.emailVerified]
  );
  return rows.length > 0;
}

/**
 * Marks a person as seen now. COALESCE keeps the name already stored when a
 * provider sends none.
 */
async function seen(client: MetadataClient, profileId: number, name: string | null) {
  await client.query(
    `UPDATE profiles SET last_seen_at = now(), name = COALESCE($2, name) WHERE id = $1`,
    [profileId, name]
  );
}

/**
 * Where someone starts. Nobody is moved once they belong somewhere, and a role
 * somebody already has is never changed.
 *
 *   - In the desktop app, the default organization is the one person's own,
 *     and they join it if they belong nowhere yet: as its admin when it is
 *     empty, which on a new install it is, and as a viewer otherwise (a
 *     restored backup that already has an admin).
 *   - On the web, nobody joins an organization just by signing in. They make
 *     their own (/onboarding) or accept an invitation to someone else's. The
 *     one exception is a fresh deployment, whose default organization nobody
 *     could otherwise ever administer: the first person from the home tenant
 *     to sign in while it has no members at all becomes its admin. Only the
 *     home tenant, because anyone at all can sign in with GitHub or a
 *     Microsoft account from elsewhere, and the default organization holds
 *     everything from before there were others.
 *
 * Both take the default organization's row first and hold it to the end of
 * the transaction. Without that, two people signing in to a new deployment at
 * the same moment could both find it empty, and both become its admin.
 */
async function joinOnSignIn(client: MetadataClient, profileId: number, who: SignInIdentity) {
  const desktop = inDesktopApp();
  if (!desktop && !who.homeTenant) return;

  const org = await client.query<{ id: number }>(
    `SELECT id FROM organizations WHERE is_default FOR UPDATE`
  );
  const defaultId = org.rows[0]?.id;
  // No default organization means somebody deleted it by hand. The person
  // still signs in, and the gates answer "not a member" until there is one.
  if (defaultId === undefined) return;

  if (desktop) {
    await client.query(
      `-- every organization: a member of any of them stays where they are
       INSERT INTO memberships (org_id, profile_id, role)
       SELECT $1::int, $2::int,
              CASE WHEN EXISTS (SELECT 1 FROM memberships WHERE org_id = $1::int)
                   THEN $4::text ELSE $3::text END
        WHERE NOT EXISTS (SELECT 1 FROM memberships WHERE profile_id = $2::int)
       ON CONFLICT DO NOTHING`,
      [defaultId, profileId, ADMIN_ROLE, DEFAULT_ROLE]
    );
  } else {
    await client.query(
      `INSERT INTO memberships (org_id, profile_id, role)
       SELECT $1::int, $2::int, $3::text
        WHERE NOT EXISTS (SELECT 1 FROM memberships WHERE org_id = $1::int)
       ON CONFLICT DO NOTHING`,
      [defaultId, profileId, ADMIN_ROLE]
    );
  }
}
