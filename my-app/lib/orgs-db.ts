import pool, { syncMetadataTables } from "./version-db";
import type { MetadataClient } from "./db/sequelize";
import { seedBuiltInRoles } from "./db/bootstrap";
import { ORG_SLUG_PATTERN, isOrgSlug } from "./org-slug";
import { ADMIN_ROLE } from "./permissions";

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
 * A person is found by their profile ID, which the sign-in session carries
 * (auth.ts), never by their email address. lib/accounts-db.ts explains why:
 * an address is only something a sign-in provider reports, and two ways of
 * signing in can report the same one.
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
 * A membership, with who holds it: the address and name the app knows them
 * by, from their profile. The gates put these in the principal, so the
 * address a screen or an audit row shows is always the profile's, whichever
 * way the person signed in this time.
 */
export type Member = Membership & {
  email: string;
  /** Null when no sign-in has ever said what they are called. */
  personName: string | null;
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

type MemberRow = {
  org_id: number;
  slug: string;
  name: string;
  is_default: boolean;
  role: string;
  email: string;
  person_name: string | null;
};

/** The columns every membership lookup reads, joined the same way. */
const MEMBERSHIP_SELECT = `SELECT o.id AS org_id, o.slug, o.name, o.is_default, m.role,
            p.email, p.name AS person_name
       FROM profiles p
       JOIN memberships m ON m.profile_id = p.id
       JOIN organizations o ON o.id = m.org_id`;

function toMembership(row: MemberRow): Membership {
  return {
    orgId: row.org_id,
    slug: row.slug,
    name: row.name,
    isDefault: row.is_default,
    role: row.role,
  };
}

function toMember(row: MemberRow | undefined): Member | null {
  if (!row) return null;
  return { ...toMembership(row), email: row.email, personName: row.person_name };
}

/**
 * The membership a signed-in person holds in the organization with this slug,
 * or null when they hold none there. Null is also the answer for a slug no
 * organization has, on purpose: the gate answers both the same way, so nobody
 * learns from it which organizations exist.
 */
export async function findMembership(profileId: number, slug: string): Promise<Member | null> {
  if (!SLUG.test(slug)) return null;
  await syncMetadataTables();
  const { rows } = await pool.query<MemberRow>(
    `${MEMBERSHIP_SELECT}
      WHERE p.id = $1 AND o.slug = $2`,
    [profileId, slug]
  );
  return toMember(rows[0]);
}

/**
 * The membership a signed-in person holds in the default organization, or
 * null when they hold none: an admin removed them after they signed in, or
 * the sign-in that should have added them could not reach the database.
 *
 * Only for a request that names no organization, which only the desktop
 * answers (see lib/auth-guard.ts).
 */
export async function findDefaultMembership(profileId: number): Promise<Member | null> {
  await syncMetadataTables();
  const { rows } = await pool.query<MemberRow>(
    `${MEMBERSHIP_SELECT}
      WHERE p.id = $1 AND o.is_default`,
    [profileId]
  );
  return toMember(rows[0]);
}

/**
 * Every organization a person belongs to, and their role in each, for the
 * switcher on the studio rail. Sorted by name, then ID, so the list reads the
 * same way every time and two organizations with one name keep their places.
 */
export async function listMemberships(profileId: number): Promise<Membership[]> {
  await syncMetadataTables();
  const { rows } = await pool.query<MemberRow>(
    `${MEMBERSHIP_SELECT}
      WHERE p.id = $1
      ORDER BY lower(o.name), o.id`,
    [profileId]
  );
  return rows.map(toMembership);
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
export async function findLastOrganization(profileId: number): Promise<string | null> {
  await syncMetadataTables();
  const { rows } = await pool.query<{ slug: string }>(
    // The join through memberships is what makes "as long as they still
    // belong to it" hold: last_org_id is only a hint, and it is not cleared
    // when someone is removed from that organization.
    `SELECT o.slug
       FROM profiles p
       JOIN memberships m ON m.profile_id = p.id
       JOIN organizations o ON o.id = m.org_id
      WHERE p.id = $1
      ORDER BY (o.id = p.last_org_id) IS TRUE DESC, o.is_default DESC, m.created_at, o.id
      LIMIT 1`,
    [profileId]
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
export async function rememberLastOrganization(profileId: number, orgId: number): Promise<void> {
  await syncMetadataTables();
  await pool.query(
    `UPDATE profiles SET last_org_id = $2
      WHERE id = $1 AND last_org_id IS DISTINCT FROM $2`,
    [profileId, orgId]
  );
}

/**
 * Every organization there is, for the switcher while authentication is off.
 * The bypass is an admin of every one of them (lib/auth-guard.ts), so each is
 * somewhere it can go. Sorted the same way as listMemberships.
 */
export async function listOrganizations(): Promise<Organization[]> {
  await syncMetadataTables();
  const { rows } = await pool.query<Organization>(
    `SELECT id, slug, name, is_default AS "isDefault"
       FROM organizations
      ORDER BY lower(name), id`
  );
  return rows;
}

/** What createOrganization did. Neither refusal wrote anything. */
export type Created =
  | { kind: "ok"; organization: Organization }
  /** Another organization holds the slug already. */
  | { kind: "taken" }
  /** The profile is gone: somebody deleted it after this person signed in. */
  | { kind: "no-profile" };

/**
 * Make an organization with this person as its Admin, and note it as the one
 * they last opened, so an address that names none takes them there next.
 *
 * It all happens in one transaction: the organization, its built-in roles
 * (seedBuiltInRoles, the same seeding every organization gets), the
 * membership, and the profile's last_org_id. A failure part way leaves
 * nothing behind, so there is never an organization without its roles, or
 * one that nobody can open.
 *
 * Two people asking for the same slug at once are settled by its unique
 * index, not by a check one of them could slip past: the second insert waits
 * for the first, then gives way, and that person hears the address is taken.
 *
 * The slug must already have passed isOrgSlug, and the name the rules in
 * lib/new-organization.ts. A slug that has not is a mistake in the caller,
 * and is thrown rather than stored: a reserved word would take an address the
 * app's own pages need.
 */
export async function createOrganization(
  profileId: number,
  organization: { slug: string; name: string }
): Promise<Created> {
  if (!isOrgSlug(organization.slug)) {
    throw new Error(`"${organization.slug}" is not an address an organization may have.`);
  }
  await syncMetadataTables();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const created = await createIn(client, profileId, organization);
    await client.query(created.kind === "ok" ? "COMMIT" : "ROLLBACK");
    return created;
  } catch (error) {
    // The ROLLBACK can fail too (the connection may be what broke), and the
    // error worth reporting is the first one.
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/** createOrganization's work, inside its transaction. */
async function createIn(
  client: MetadataClient,
  profileId: number,
  { slug, name }: { slug: string; name: string }
): Promise<Created> {
  // The lock the UPDATE at the end would take, taken now. It keeps the
  // profile from being deleted before the membership that names it is
  // written, and it lines up two organizations made by one person at the same
  // moment (a double click) instead of letting them trip over each other.
  const profile = await client.query(
    `SELECT id FROM profiles WHERE id = $1 FOR NO KEY UPDATE`,
    [profileId]
  );
  if (profile.rows.length === 0) return { kind: "no-profile" };

  const inserted = await client.query<Organization>(
    `INSERT INTO organizations (slug, name) VALUES ($1, $2)
     ON CONFLICT (slug) DO NOTHING
     RETURNING id, slug, name, is_default AS "isDefault"`,
    [slug, name]
  );
  const created = inserted.rows[0];
  if (!created) return { kind: "taken" };

  // The roles first: a membership names its role, and the foreign key from
  // one to the other needs the role to be there.
  await seedBuiltInRoles(client, created.id);
  await client.query(
    `INSERT INTO memberships (org_id, profile_id, role) VALUES ($1, $2, $3)`,
    [created.id, profileId, ADMIN_ROLE]
  );
  await client.query(`UPDATE profiles SET last_org_id = $2 WHERE id = $1`, [
    profileId,
    created.id,
  ]);
  return { kind: "ok", organization: created };
}
