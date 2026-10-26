import pool, { syncMetadataTables } from "./version-db";
import type { MetadataClient } from "./db/sequelize";
import { seedBuiltInRoles } from "./db/bootstrap";
import { ORG_SLUG_PATTERN, isOrgSlug } from "./org-slug";
import { ADMIN_ROLE } from "./permissions";
import { logRoleChanges } from "./roles-db";

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
  /**
   * Whether a production deploy or rollback needs a second person to approve
   * it. On by default. An Admin can switch it off for an organization of one
   * (the Organization tab), and then whoever asked may clear their own
   * request, which the approval row records as a self-approval.
   */
  twoPersonRule: boolean;
};

/** One person's place in an organization: which one, and their role there. */
export type Membership = {
  orgId: number;
  slug: string;
  name: string;
  /** Whether that organization is the default one (see Organization.isDefault). */
  isDefault: boolean;
  /** That organization's two-person rule (see Organization.twoPersonRule). */
  twoPersonRule: boolean;
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
    `SELECT id, slug, name, is_default AS "isDefault", two_person_rule AS "twoPersonRule" FROM organizations WHERE is_default`
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
    `SELECT id, slug, name, is_default AS "isDefault", two_person_rule AS "twoPersonRule" FROM organizations WHERE slug = $1`,
    [slug]
  );
  return rows[0] ?? null;
}

type MemberRow = {
  org_id: number;
  slug: string;
  name: string;
  is_default: boolean;
  two_person_rule: boolean;
  role: string;
  email: string;
  person_name: string | null;
};

/** The columns every membership lookup reads, joined the same way. */
const MEMBERSHIP_SELECT = `SELECT o.id AS org_id, o.slug, o.name, o.is_default, o.two_person_rule, m.role,
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
    twoPersonRule: row.two_person_rule,
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
    `SELECT id, slug, name, is_default AS "isDefault", two_person_rule AS "twoPersonRule"
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
     RETURNING id, slug, name, is_default AS "isDefault", two_person_rule AS "twoPersonRule"`,
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

/** What updateOrganization did. */
export type Updated =
  | { kind: "ok"; organization: Organization }
  /** The organization is gone: someone deleted it a moment ago. */
  | { kind: "not-found" };

/**
 * Rename an organization, switch its two-person rule, or both, from the
 * Organization tab. Only what is given changes, and each change that really
 * changes something gets its own line in the change log, written in the same
 * transaction, so the log never shows a change that did not happen or misses
 * one that did.
 *
 * The slug stays as it is. It is in every address and bookmark anyone has for
 * the organization, and in the API calls of every page open on it right now,
 * so changing it would break all of those at once for a cosmetic gain.
 *
 * The log rows name the admin role because every row names a role, and the
 * Organization tab is the admin role's alone. The new name is the subject and
 * the old one the detail, so the line can say both.
 */
export async function updateOrganization(
  orgId: number,
  changes: { name?: string; twoPersonRule?: boolean },
  actor: string
): Promise<Updated> {
  await syncMetadataTables();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Locked, so two Admins saving at once are lined up and each log line
    // says what the name or the rule really was before that save.
    const found = await client.query<Organization>(
      `SELECT id, slug, name, is_default AS "isDefault", two_person_rule AS "twoPersonRule"
         FROM organizations WHERE id = $1 FOR NO KEY UPDATE`,
      [orgId]
    );
    const before = found.rows[0];
    if (!before) {
      await client.query("ROLLBACK");
      return { kind: "not-found" };
    }
    const after: Organization = {
      ...before,
      name: changes.name ?? before.name,
      twoPersonRule: changes.twoPersonRule ?? before.twoPersonRule,
    };
    await client.query(
      `UPDATE organizations SET name = $2, two_person_rule = $3 WHERE id = $1`,
      [orgId, after.name, after.twoPersonRule]
    );
    await logRoleChanges(client, orgId, [
      ...(after.name !== before.name
        ? [
            {
              role: ADMIN_ROLE,
              kind: "rename-organization" as const,
              subject: after.name,
              detail: before.name,
              actor,
            },
          ]
        : []),
      ...(after.twoPersonRule !== before.twoPersonRule
        ? [
            {
              role: ADMIN_ROLE,
              kind: "two-person-rule" as const,
              detail: after.twoPersonRule ? "on" : "off",
              actor,
            },
          ]
        : []),
    ]);
    await client.query("COMMIT");
    return { kind: "ok", organization: after };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/** What deleteOrganization did. Every refusal left everything as it was. */
export type Deleted =
  | { kind: "deleted" }
  | { kind: "not-found" }
  /** The name typed to confirm is not the organization's. */
  | { kind: "mismatch" }
  /** The default organization, which this install cannot do without. */
  | { kind: "default" };

/**
 * Delete an organization and everything it owns, once the Admin has typed its
 * name to confirm.
 *
 * Every table that belongs to an organization points at it with ON DELETE
 * CASCADE (lib/db/bootstrap.ts), so one DELETE takes its memberships, roles,
 * saved connections (with their stored database passwords), tracked schemas,
 * history, approvals, invitations and change log with it, all in the one
 * statement. Anyone who last opened it has their last_org_id emptied by its
 * own foreign key, and lands on their other organizations, or on making one,
 * next time. Their profiles stay: they may belong elsewhere, or be invited
 * again.
 *
 * Nothing about the deletion can go in the organization's own change log,
 * because that log goes with it. The server's log says who did it.
 *
 * The scripts it kept in the GitHub registry stay there (under orgs/<id>):
 * they are in the repository's history whatever happens here, and removing
 * files from a repository is for whoever owns it.
 *
 * The default organization cannot be deleted. The desktop app and the demo
 * act in it, and its scripts sit at the top of the registry, where no other
 * organization's may (see Organization.isDefault).
 *
 * The name is compared inside the transaction, against the row as it is now,
 * so a rename that lands between opening the dialog and confirming it makes
 * the confirmation fail rather than delete something under another name.
 */
export async function deleteOrganization(orgId: number, confirmName: string): Promise<Deleted> {
  await syncMetadataTables();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const found = await client.query<{ name: string; is_default: boolean }>(
      `SELECT name, is_default FROM organizations WHERE id = $1 FOR UPDATE`,
      [orgId]
    );
    const row = found.rows[0];
    const refusal: Deleted | null = !row
      ? { kind: "not-found" }
      : row.is_default
        ? { kind: "default" }
        : row.name !== confirmName
          ? { kind: "mismatch" }
          : null;
    if (refusal) {
      await client.query("ROLLBACK");
      return refusal;
    }
    await client.query(`DELETE FROM organizations WHERE id = $1`, [orgId]);
    await client.query("COMMIT");
    return { kind: "deleted" };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
