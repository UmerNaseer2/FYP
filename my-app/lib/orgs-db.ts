import pool, { syncMetadataTables } from "./version-db";
import { ORG_SLUG_PATTERN } from "./org-slug";

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
 * A request names its organization by slug: the page's address does
 * (/acme/compare), and its API calls carry the same slug in a header
 * (lib/api-fetch.ts). The desktop is the one exception. It has a single
 * organization of its own, and its calls from outside any page name none, so
 * they act in the default organization: the one row in `organizations` with
 * is_default set, which lib/db/bootstrap.ts creates and moves every older row
 * into.
 *
 * Nothing here is cached, on purpose. An admin who removes someone, or changes
 * their role, expects it to hold from that person's very next request, not
 * from whenever a cache happens to expire. That is the same reason the sign-in
 * session no longer carries a role at all (see auth.ts).
 */

/** ORG_SLUG_PATTERN, ready to test with. */
const SLUG = new RegExp(ORG_SLUG_PATTERN);

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
 * The organization with this slug, or null when there is none.
 *
 * Only the bypass asks this, since it acts as an admin of whichever
 * organization the address names. Everyone else is looked up through their
 * membership (findMembership), which answers both questions at once.
 */
export async function findOrganization(slug: string): Promise<Organization | null> {
  // A slug that cannot exist is not worth a round trip, and the database
  // never sees text it did not ask for.
  if (!SLUG.test(slug)) return null;
  await syncMetadataTables();
  const { rows } = await pool.query<Organization>(
    `SELECT id, slug, name, is_default AS "isDefault" FROM organizations WHERE slug = $1`,
    [slug]
  );
  return rows[0] ?? null;
}

type MembershipRow = {
  org_id: number;
  slug: string;
  name: string;
  is_default: boolean;
  role: string;
};

/** The columns every membership lookup reads, joined the same way. */
const MEMBERSHIP_SELECT = `SELECT o.id AS org_id, o.slug, o.name, o.is_default, m.role
       FROM profiles p
       JOIN memberships m ON m.profile_id = p.id
       JOIN organizations o ON o.id = m.org_id`;

function toMembership(row: MembershipRow | undefined): Membership | null {
  if (!row) return null;
  return {
    orgId: row.org_id,
    slug: row.slug,
    name: row.name,
    isDefault: row.is_default,
    role: row.role,
  };
}

/**
 * The key every lookup by email uses. lower(email) in the queries goes through
 * profiles_email_key_idx, the same way every other profile lookup does:
 * sign-in providers are not consistent about the case of the address they
 * hand back.
 */
function emailKey(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * The membership a signed-in person holds in the organization with this slug,
 * or null when they hold none there. Null is also the answer for a slug no
 * organization has, on purpose: the gate answers both the same way, so nobody
 * learns from it which organizations exist.
 */
export async function findMembership(email: string, slug: string): Promise<Membership | null> {
  if (!SLUG.test(slug)) return null;
  await syncMetadataTables();
  const { rows } = await pool.query<MembershipRow>(
    `${MEMBERSHIP_SELECT}
      WHERE lower(p.email) = $1 AND o.slug = $2`,
    [emailKey(email), slug]
  );
  return toMembership(rows[0]);
}

/**
 * The membership a signed-in person holds in the default organization, or
 * null when they hold none: an admin removed them after they signed in, or
 * the sign-in that should have added them could not reach the database.
 *
 * Only for a request that names no organization, which only the desktop
 * answers (see lib/auth-guard.ts).
 */
export async function findDefaultMembership(email: string): Promise<Membership | null> {
  await syncMetadataTables();
  const { rows } = await pool.query<MembershipRow>(
    `${MEMBERSHIP_SELECT}
      WHERE lower(p.email) = $1 AND o.is_default`,
    [emailKey(email)]
  );
  return toMembership(rows[0]);
}

/**
 * The slug of the organization to open for someone who did not name one, or
 * null when they belong to none.
 *
 * That is the organization they last opened (rememberLastOrganization), as
 * long as they still belong to it. Failing that, the default organization if
 * they are in it, and then the one they joined first. The order is total, so
 * the same person always lands in the same place.
 */
export async function findLastOrganization(email: string): Promise<string | null> {
  await syncMetadataTables();
  const { rows } = await pool.query<{ slug: string }>(
    // The join through memberships is what makes "as long as they still
    // belong to it" hold: last_org_id is only a hint, and it is not cleared
    // when someone is removed from that organization.
    `SELECT o.slug
       FROM profiles p
       JOIN memberships m ON m.profile_id = p.id
       JOIN organizations o ON o.id = m.org_id
      WHERE lower(p.email) = $1
      ORDER BY (o.id = p.last_org_id) IS TRUE DESC, o.is_default DESC, m.created_at, o.id
      LIMIT 1`,
    [emailKey(email)]
  );
  return rows[0]?.slug ?? null;
}

/**
 * Note that someone has opened an organization, so the next address that
 * names none (an old bookmark, the sign-in page's way back) takes them there
 * again. See findLastOrganization.
 *
 * It only writes when the organization is a different one, so opening page
 * after page in the same organization costs a read and nothing else.
 */
export async function rememberLastOrganization(email: string, orgId: number): Promise<void> {
  await syncMetadataTables();
  await pool.query(
    `UPDATE profiles SET last_org_id = $2
      WHERE lower(email) = $1 AND last_org_id IS DISTINCT FROM $2`,
    [emailKey(email), orgId]
  );
}
