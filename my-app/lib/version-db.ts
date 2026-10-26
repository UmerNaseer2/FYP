import { metadataPool } from "./db/sequelize";
import { syncMetadataTables } from "./db/bootstrap";
import { ADMIN_ROLE, DEFAULT_ROLE } from "./permissions";

/**
 * The app's own database — the one place that hands out a connection to it.
 *
 * `pool` is not a `pg.Pool` any more: it is a thin, pg-shaped view over
 * Sequelize's pool (lib/db/sequelize.ts). Keeping the shape means the metadata
 * reads that are genuinely SQL — a recursive walk up a lineage, an advisory
 * lock, an aggregate feed — stay written as SQL and still run on the same
 * single pool as the model calls, instead of a second pool competing for the
 * same connection limit.
 *
 * The tables themselves are defined in lib/db/models.ts and created by
 * `syncMetadataTables()`, re-exported here so every caller reaches the metadata
 * store through one module.
 */
const pool = metadataPool;

export { syncMetadataTables } from "./db/bootstrap";

/**
 * A row from `profiles`: who someone is. What they may do is not here. It is
 * their row in `memberships`, one for each organization they belong to.
 */
export type Profile = {
  id: number;
  email: string;
  name: string | null;
};

/**
 * Look up (or create) the profile for someone who has just authenticated, and
 * make sure they belong to an organization.
 *
 * Someone who belongs to no organization at all joins the default one. The
 * FIRST person to join it becomes its admin, because otherwise a fresh
 * deployment has nobody who can promote anyone. Everyone after them joins as a
 * viewer, and an admin decides from there. Someone who already belongs
 * somewhere is left exactly where they are: signing in never changes a role.
 *
 * It all happens in one transaction that holds the default organization's row
 * until it ends. Without that, two people signing in to a brand new deployment
 * at the same moment could both see an organization with no members yet, and
 * both become its admin.
 *
 * What a role may do is read separately, by the gates on every request (see
 * lib/auth-guard.ts), so this only ever decides where a new person starts.
 */
export async function upsertProfile(email: string, name: string | null): Promise<Profile> {
  await syncMetadataTables();

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // One statement rather than a read and then a write, so two sign-ins for
    // the same new person cannot race each other into a unique-violation
    // error page. The conflict target is the lower(email) index, because
    // sign-in providers are not consistent about the case they hand back and
    // "Umer@x" and "umer@x" are the same person. COALESCE keeps the name we
    // already have when a provider sends none.
    const { rows } = await client.query<Profile>(
      `INSERT INTO profiles (email, name, last_seen_at) VALUES ($1, $2, now())
       ON CONFLICT ((lower(email))) DO UPDATE
         SET last_seen_at = now(), name = COALESCE(EXCLUDED.name, profiles.name)
       RETURNING id, email, name`,
      [email.trim().toLowerCase(), name]
    );
    const profile = rows[0];

    // The lock that makes "the first person becomes admin" safe, see above.
    const org = await client.query<{ id: number }>(
      `SELECT id FROM organizations WHERE is_default FOR UPDATE`
    );
    const defaultId = org.rows[0]?.id;
    // No default organization means somebody deleted it by hand. The person
    // still gets their profile, and the gates answer "not a member" until an
    // organization exists again.
    if (defaultId !== undefined) {
      await client.query(
        `-- every organization: a member of any of them is not added to the default one
         INSERT INTO memberships (org_id, profile_id, role)
         SELECT $1::int, $2::int,
                CASE WHEN EXISTS (SELECT 1 FROM memberships WHERE org_id = $1::int)
                     THEN $4::text ELSE $3::text END
          WHERE NOT EXISTS (SELECT 1 FROM memberships WHERE profile_id = $2::int)
         ON CONFLICT DO NOTHING`,
        [defaultId, profile.id, ADMIN_ROLE, DEFAULT_ROLE]
      );
    }

    await client.query("COMMIT");
    return profile;
  } catch (error) {
    // The ROLLBACK can fail too (the connection may be what broke), and the
    // error worth reporting is the first one.
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export default pool;
