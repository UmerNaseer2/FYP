import { Pool } from "pg";
import { parse as parseConnectionString } from "pg-connection-string";

declare global {
  var __connectionsPgPool: Pool | undefined;
}

const connectionString = process.env.DATABASE_URL_A;

if (!connectionString) {
  // DATABASE_URL_A is the- app's own metadata store (saved connections, lineage,
  // drift). Without it the app can't function, so fail loudly with a message
  // that names where to set it in both environments.
  throw new Error(
    "DATABASE_URL_A is not set. Add it to your environment — .env.local for local dev, or your Vercel project's Environment Variables for deployment."
  );
}

// Hosted Postgres (Supabase, Neon, RDS) requires SSL but commonly presents a
// cert chain the runtime doesn't trust, so accept the cert without local CA
// verification — the same thing lib/connection-config.ts does for target DBs.
// Local Postgres (localhost) speaks no SSL, so leave it off there.
const metadataHost = (() => {
  try {
    return parseConnectionString(connectionString).host ?? "";
  } catch {
    return "";
  }
})();
const isLocalHost =
  metadataHost === "" ||
  metadataHost === "localhost" ||
  metadataHost === "127.0.0.1" ||
  metadataHost === "::1";

const pool =
  globalThis.__connectionsPgPool ??
  new Pool({
    connectionString,
    max: 5,
    ssl: isLocalHost ? false : { rejectUnauthorized: false },
  });

if (process.env.NODE_ENV !== "production") {
  globalThis.__connectionsPgPool = pool;
}

/**
 * Make sure the `public` schema exists before we create our metadata tables
 * (connections, schema_comparisons, …) in it.
 *
 * Our tables are created unqualified, so they land in whatever the search_path
 * points at — normally `public`. Some target databases have had `public`
 * dropped (e.g. ones set up with only custom comparison schemas); there, an
 * unqualified `CREATE TABLE` fails with "no schema has been selected to create
 * in" (Postgres error 3F000). Re-creating it is idempotent and cheap, so call
 * this once right before any `CREATE TABLE IF NOT EXISTS …` on this pool.
 */
export async function ensureMetadataSchema(): Promise<void> {
  await pool.query("CREATE SCHEMA IF NOT EXISTS public");
}

/**
 * Create (and bring up to date) the `connections` table that stores saved
 * database targets. This is the single source of truth for that table's shape —
 * every reader/writer (the connections API and the Compare page) calls this
 * first so the columns, including `ssl`, are guaranteed to exist consistently.
 */

/**
 * Run a lazy-DDL function at most once per process.
 *
 * The `connections` table is read by ten routes, and each has to be sure the
 * columns it selects exist before it selects them — otherwise the first person
 * to open Deploy on a database created by an older build hits "column ssl_mode
 * does not exist". Without this memo that guarantee would cost a handful of DDL
 * round-trips on every request; with it, the first request in a process pays
 * and the rest are free.
 *
 * A failure is deliberately NOT cached: the next caller retries, so a database
 * that was briefly unreachable heals itself instead of staying broken until the
 * server restarts.
 */
function once(run: () => Promise<void>): () => Promise<void> {
  let inFlight: Promise<void> | null = null;
  return () => {
    if (!inFlight) {
      inFlight = run().catch((error) => {
        inFlight = null;
        throw error;
      });
    }
    return inFlight;
  };
}

async function createConnectionsTable(): Promise<void> {
  await ensureMetadataSchema();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS connections (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      host TEXT NOT NULL,
      port INTEGER NOT NULL DEFAULT 5432,
      database_name TEXT NOT NULL DEFAULT 'postgres',
      type TEXT NOT NULL DEFAULT 'PostgreSQL',
      username TEXT NOT NULL,
      password TEXT NOT NULL,
      connection_string TEXT,
      ssl BOOLEAN NOT NULL DEFAULT false,
      ssl_mode TEXT NOT NULL DEFAULT 'disable'
        CHECK (ssl_mode IN ('disable', 'require', 'verify-full')),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  // Bring older tables (created before SSL support) up to date.
  await pool.query(
    `ALTER TABLE connections ADD COLUMN IF NOT EXISTS ssl BOOLEAN NOT NULL DEFAULT false`
  );

  // `ssl_mode` replaces the boolean with a three-way choice (disable / require /
  // verify-full). The boolean is kept in step on every write so a rollback to an
  // older build still reads the right thing; `ssl_mode` is what the driver uses.
  await pool.query(
    `ALTER TABLE connections ADD COLUMN IF NOT EXISTS ssl_mode TEXT NOT NULL DEFAULT 'disable'`
  );
  // Backfill: ssl = true meant "encrypt but don't verify the certificate",
  // which is exactly `require`. Only touches rows still on the default.
  await pool.query(
    `UPDATE connections SET ssl_mode = 'require' WHERE ssl IS TRUE AND ssl_mode = 'disable'`
  );
  // The CHECK is added separately (and tolerantly) because ADD COLUMN IF NOT
  // EXISTS cannot carry one onto a table that already has the column.
  try {
    await pool.query(
      `ALTER TABLE connections ADD CONSTRAINT connections_ssl_mode_check
         CHECK (ssl_mode IN ('disable', 'require', 'verify-full'))`
    );
  } catch (error) {
    // 42710 duplicate_object: the constraint is already there, which is the
    // normal path on every call after the first.
    if ((error as { code?: string })?.code !== "42710") throw error;
  }
}

export const ensureConnectionsTable = once(createConnectionsTable);

/**
 * Create the `profiles` table that backs sign-in and role checks.
 *
 * This table is the reason auth could not be switched on before: the NextAuth
 * session callback read it, nothing ever created it, and the repo carries no
 * .sql files. It follows the same lazy-DDL idiom as `connections` above, so it
 * appears the first time anyone signs in or an admin lists users.
 */
async function createProfilesTable(): Promise<void> {
  await ensureMetadataSchema();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS profiles (
      id SERIAL PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      name TEXT,
      role TEXT NOT NULL DEFAULT 'viewer'
        CHECK (role IN ('viewer', 'editor', 'admin')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_seen_at TIMESTAMPTZ
    )
  `);
  // Email lookups happen on every session read, so index them. UNIQUE already
  // provides the index; this is belt-and-braces for tables created by hand.
  await pool.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS profiles_email_key_idx ON profiles (lower(email))`
  );
}

export const ensureProfilesTable = once(createProfilesTable);

/** A row from `profiles`, as the session callback and the admin screen see it. */
export type Profile = {
  id: number;
  email: string;
  name: string | null;
  role: string;
};

/**
 * Look up (or create) the profile for someone who has just authenticated.
 *
 * The FIRST person to sign in becomes `admin` — otherwise a fresh deployment
 * has a profiles table full of viewers and nobody who can promote anyone. Every
 * subsequent sign-in gets `viewer` and has to be promoted from the admin screen.
 */
export async function upsertProfile(email: string, name: string | null): Promise<Profile> {
  await ensureProfilesTable();

  const normalised = email.trim().toLowerCase();

  const existing = await pool.query<Profile>(
    `UPDATE profiles
        SET last_seen_at = now(),
            name = COALESCE($2, name)
      WHERE lower(email) = $1
      RETURNING id, email, name, role`,
    [normalised, name]
  );
  if (existing.rows.length > 0) return existing.rows[0];

  const isFirstUser = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM profiles`
  );
  const role = isFirstUser.rows[0]?.count === "0" ? "admin" : "viewer";

  // ON CONFLICT covers two people signing in at the same moment.
  const created = await pool.query<Profile>(
    `INSERT INTO profiles (email, name, role, last_seen_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (email) DO UPDATE SET last_seen_at = now()
     RETURNING id, email, name, role`,
    [normalised, name, role]
  );
  return created.rows[0];
}

/** Read just the role for an email. Returns null when there is no profile. */
export async function getProfileRole(email: string): Promise<string | null> {
  await ensureProfilesTable();
  const result = await pool.query<{ role: string }>(
    `SELECT role FROM profiles WHERE lower(email) = $1`,
    [email.trim().toLowerCase()]
  );
  return result.rows[0]?.role ?? null;
}

export default pool;