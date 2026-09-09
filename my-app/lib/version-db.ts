import { fn, col, where as whereFn } from "sequelize";
import { metadataPool } from "./db/sequelize";
import { Profile as ProfileModel } from "./db/models";
import { syncMetadataTables } from "./db/bootstrap";

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

/** A row from `profiles`, as the session callback and the admin screen see it. */
export type Profile = {
  id: number;
  email: string;
  name: string | null;
  role: string;
};

function toProfile(row: ProfileModel): Profile {
  return { id: row.id, email: row.email, name: row.name ?? null, role: row.role };
}

/**
 * Match an email case-insensitively, through the `profiles_email_key_idx`
 * functional index. Sign-in providers are not consistent about the case they
 * hand back, and "Umer@x" and "umer@x" are the same person.
 */
function sameEmail(normalised: string) {
  return whereFn(fn("lower", col("email")), normalised);
}

/**
 * Look up (or create) the profile for someone who has just authenticated.
 *
 * The FIRST person to sign in becomes `admin` — otherwise a fresh deployment
 * has a profiles table full of viewers and nobody who can promote anyone. Every
 * subsequent sign-in gets `viewer` and has to be promoted from the admin screen.
 */
export async function upsertProfile(email: string, name: string | null): Promise<Profile> {
  await syncMetadataTables();

  const normalised = email.trim().toLowerCase();

  const existing = await ProfileModel.findOne({ where: sameEmail(normalised) });
  if (existing) {
    existing.last_seen_at = new Date();
    // Only overwrite the name when the provider actually sent one, so a
    // sign-in that omits it does not blank out a name we already had.
    if (name !== null) existing.name = name;
    await existing.save();
    return toProfile(existing);
  }

  const role = (await ProfileModel.count()) === 0 ? "admin" : "viewer";

  // findOrCreate rather than create: two people signing in at the same moment
  // would otherwise race, and the loser would see a unique-violation error page
  // instead of their account.
  const [created] = await ProfileModel.findOrCreate({
    where: { email: normalised },
    defaults: { email: normalised, name, role, last_seen_at: new Date() },
  });
  return toProfile(created);
}

/** Read just the role for an email. Returns null when there is no profile. */
export async function getProfileRole(email: string): Promise<string | null> {
  await syncMetadataTables();
  const row = await ProfileModel.findOne({
    where: sameEmail(email.trim().toLowerCase()),
    attributes: ["role"],
  });
  return row?.role ?? null;
}

export default pool;
