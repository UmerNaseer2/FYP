import pool, { syncMetadataTables } from "./version-db";

/**
 * Organizations, and who belongs to which.
 *
 * An organization owns everything the app stores: its saved connections, its
 * tracked schemas, its roles and its history. A membership says that one
 * person belongs to one organization and holds one of that organization's
 * roles there. lib/auth-guard.ts asks this file, on every request, which
 * organization the request acts in and which role the person holds in it;
 * lib/roles-db.ts then says what that role may do.
 *
 * For now every request acts in the default organization: the one row in
 * `organizations` with is_default set, which lib/db/bootstrap.ts creates and
 * moves every older row into. Choosing between several organizations comes
 * with addresses that name one, and then both lookups below take the slug the
 * address names instead of asking for the default.
 *
 * Nothing here is cached, on purpose. An admin who removes someone, or changes
 * their role, expects it to hold from that person's very next request, not
 * from whenever a cache happens to expire. That is the same reason the sign-in
 * session no longer carries a role at all (see auth.ts).
 */

export type Organization = {
  id: number;
  slug: string;
  name: string;
  /**
   * True for the default organization. Its scripts sit at the top of the
   * GitHub registry, where every older install kept them, and any other
   * organization's sit under orgs/<id> (lib/registry-paths.ts). So the flag
   * must never move to another row once scripts exist: the scripts at the top
   * of the registry would then belong to a different organization.
   */
  isDefault: boolean;
};

/** One person's place in an organization: which one, and their role there. */
export type Membership = {
  orgId: number;
  slug: string;
  name: string;
  /** Whether that organization is the default one (see Organization.isDefault). */
  isDefault: boolean;
  role: string;
};

/**
 * The default organization, or null when there is none.
 *
 * The bootstrap always creates it, so null means somebody deleted the row by
 * hand. The partial unique index organizations_one_default_idx allows at most
 * one, so there is never a choice to make between two.
 */
export async function findDefaultOrganization(): Promise<Organization | null> {
  await syncMetadataTables();
  const { rows } = await pool.query<Organization>(
    `SELECT id, slug, name, is_default AS "isDefault" FROM organizations WHERE is_default`
  );
  return rows[0] ?? null;
}

/**
 * The membership a signed-in person holds in the default organization, or
 * null when they hold none: an admin removed them after they signed in, or
 * the sign-in that should have added them could not reach the database.
 */
export async function findMembership(email: string): Promise<Membership | null> {
  await syncMetadataTables();
  const { rows } = await pool.query<{
    org_id: number;
    slug: string;
    name: string;
    is_default: boolean;
    role: string;
  }>(
    // lower(email) so the lookup goes through profiles_email_key_idx, the
    // same way every other profile lookup does. Sign-in providers are not
    // consistent about the case of the address they hand back.
    `SELECT o.id AS org_id, o.slug, o.name, o.is_default, m.role
       FROM profiles p
       JOIN memberships m ON m.profile_id = p.id
       JOIN organizations o ON o.id = m.org_id
      WHERE lower(p.email) = $1 AND o.is_default`,
    [email.trim().toLowerCase()]
  );
  const row = rows[0];
  if (!row) return null;
  return {
    orgId: row.org_id,
    slug: row.slug,
    name: row.name,
    isDefault: row.is_default,
    role: row.role,
  };
}
