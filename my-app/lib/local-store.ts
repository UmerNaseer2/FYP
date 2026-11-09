import { Pool } from "pg";
import { metadataWantsSsl } from "./db/metadata-ssl";
import { encryptSecret } from "./secret-store";
import {
  forgetLocalSecret,
  localStoreConfigured,
  rememberLocalSecret,
  replaceLocalSecrets,
  type LocalEntry,
} from "./local-secrets";

/**
 * This machine's own store for local connections' passwords.
 *
 * It is a single table in the PostgreSQL that `LOCAL_DATABASE_URL` names (on
 * the Swinburne server, the compose `db`). The shared database only ever sees
 * a marker (lib/local-secrets); the password itself is saved here, encrypted
 * with this machine's APP_ENCRYPTION_KEY like any other stored secret.
 *
 * With no `LOCAL_DATABASE_URL` every function here does nothing, so Vercel, the
 * desktop app and the client's container image behave exactly as before.
 *
 * Entries are never removed on their own. A row whose connection was deleted
 * somewhere else stays behind, harmless: cleaning up automatically would wipe
 * every password here the day the shared database is pointed somewhere new by
 * mistake.
 */

const RETRY_AFTER_MS = 30_000;

type StoreState = {
  pool: Pool | null;
  loading: Promise<void> | null;
  failedAt: number;
};

const holder = globalThis as typeof globalThis & { __schemaStudioLocalStore?: StoreState };

function state(): StoreState {
  if (!holder.__schemaStudioLocalStore) {
    holder.__schemaStudioLocalStore = { pool: null, loading: null, failedAt: 0 };
  }
  return holder.__schemaStudioLocalStore;
}

function pool(): Pool {
  const current = state();
  if (!current.pool) {
    const url = process.env.LOCAL_DATABASE_URL!.trim();
    current.pool = new Pool({
      connectionString: url,
      ssl: metadataWantsSsl(url) ? { rejectUnauthorized: false } : undefined,
      max: 2,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 10_000,
    });
    // An idle client dropped by the server must not take the process with it.
    current.pool.on("error", (error) => {
      console.error(`Local password store: ${error.message}`);
    });
  }
  return current.pool;
}

const CREATE_TABLE = `CREATE TABLE IF NOT EXISTS local_secrets (
  key TEXT PRIMARY KEY,
  password TEXT,
  connection_string TEXT,
  saved_at TIMESTAMPTZ NOT NULL DEFAULT now()
)`;

async function loadAll(): Promise<void> {
  const db = pool();
  await db.query(CREATE_TABLE);
  const { rows } = await db.query<{ key: string; password: string | null; connection_string: string | null }>(
    `SELECT key, password, connection_string FROM local_secrets`
  );
  const entries = new Map<string, LocalEntry>();
  for (const row of rows) {
    entries.set(row.key, { password: row.password, connectionString: row.connection_string });
  }
  replaceLocalSecrets(entries);
}

/**
 * Read this machine's local passwords into memory, once per process.
 *
 * A failure is not kept for good: the next call after RETRY_AFTER_MS tries
 * again, so a local database that was still starting heals on its own. It
 * never throws; a copy whose local store is down still serves every cloud
 * connection.
 */
export async function ensureLocalSecrets(): Promise<void> {
  if (!localStoreConfigured()) return;
  const current = state();
  if (current.loading) return current.loading;
  if (current.failedAt && Date.now() - current.failedAt < RETRY_AFTER_MS) return;

  const attempt = loadAll().then(
    () => {
      current.failedAt = 0;
    },
    (error) => {
      current.loading = null;
      current.failedAt = Date.now();
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Local password store: could not be read (${message}).`);
    }
  );
  current.loading = attempt;
  return attempt;
}

/**
 * Save one connection's secrets on this machine. Values are encrypted here, so
 * callers pass what the person typed (or values that are already encrypted,
 * which are kept as they are). Throws when the store cannot be written: the
 * caller must not then save the marker, or the connection would point at
 * nothing.
 */
export async function saveLocalSecret(key: string, entry: LocalEntry): Promise<void> {
  if (!localStoreConfigured()) throw new Error("LOCAL_DATABASE_URL is not set on this machine.");
  const sealed: LocalEntry = {
    password: encryptSecret(entry.password) ?? null,
    connectionString: encryptSecret(entry.connectionString) || null,
  };
  const db = pool();
  await db.query(CREATE_TABLE);
  await db.query(
    `INSERT INTO local_secrets (key, password, connection_string, saved_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (key) DO UPDATE
       SET password = EXCLUDED.password,
           connection_string = EXCLUDED.connection_string,
           saved_at = now()`,
    [key, sealed.password, sealed.connectionString]
  );
  rememberLocalSecret(key, sealed);
}

/** Remove one connection's secrets from this machine. Never throws. */
export async function deleteLocalSecret(key: string): Promise<void> {
  forgetLocalSecret(key);
  if (!localStoreConfigured()) return;
  try {
    await pool().query(`DELETE FROM local_secrets WHERE key = $1`, [key]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Local password store: could not remove an entry (${message}).`);
  }
}
