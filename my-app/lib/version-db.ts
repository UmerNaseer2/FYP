import { Pool } from "pg";
import { parse as parseConnectionString } from "pg-connection-string";

declare global {
  var __connectionsPgPool: Pool | undefined;
}

const connectionString = process.env.DATABASE_URL_A;

if (!connectionString) {
  // DATABASE_URL_A is the app's own metadata store (saved connections, lineage,
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
export async function ensureConnectionsTable(): Promise<void> {
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
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  // Bring older tables (created before SSL support) up to date.
  await pool.query(
    `ALTER TABLE connections ADD COLUMN IF NOT EXISTS ssl BOOLEAN NOT NULL DEFAULT false`
  );
}

export default pool;