// SERVER-ONLY: builds the shared trial organization, and puts it back when asked.
//
// lib/trial-rules.ts says what the trial is. This file makes it real, in the
// app's own database:
//
//   - the organization "trial", with the built-in roles;
//   - the three accounts (Trial Admin, Trial Editor, Trial Viewer) and their
//     memberships;
//   - one saved connection, to the trial's own demo database, when
//     TRIAL_DATABASE_URL names one (see trialDatabase below). It holds five
//     small schemas (lib/trial-seed.ts).
//
// It is built the first time somebody signs in to the trial, and then left
// alone: nothing resets it on a timer. The Trial Admin's "Reset trial" button
// (app/api/trial/reset/route.ts) deletes the organization, with everything in
// it, rebuilds the demo schemas, and makes it again. Its GitHub repository
// and token and its AI settings are carried over, so a token saved once stays.
// The three accounts' profiles stay too, so every open session still works, in
// the fresh organization.
//
// Every rebuild of the demo database also clears whatever a visitor's script
// managed to save on the trial's database user, such as a setting that makes
// every connection read only (rebuildTrialDatabase). When the demo database
// cannot be rebuilt, nothing changes: the organization is left as it was, and
// the reset throws a TrialRebuildError that says why, which the button shows.

import { Client } from "pg";
import pool, { syncMetadataTables } from "./version-db";
import { seedBuiltInRoles } from "./db/bootstrap";
import type { MetadataClient } from "./db/sequelize";
import { buildPgConfig } from "./connection-config";
import { encryptSecret } from "./secret-store";
import { DEFAULT_EXECUTE_ROLE } from "./connection-access";
import { quoteIdent } from "./perf-sql";
import {
  TRIAL_EMAIL_DOMAIN,
  TRIAL_ORG_NAME,
  TRIAL_ORG_SLUG,
  TRIAL_PEOPLE,
  TRIAL_ROLES,
  isTrialEmail,
  toTrialRole,
  trialEnabled,
  type TrialRole,
} from "./trial-rules";
import { trialSeedSql } from "./trial-seed";

/** Held while the trial is checked or rebuilt, so two sign-ins never build it twice. */
const TRIAL_LOCK = 0x7472_6961; // "tria"

/**
 * A reset asked for within this long of the last one is not done again: the
 * trial is already fresh, and a button pressed over and over by many visitors
 * would keep rebuilding the demo schemas under everyone.
 */
export const TRIAL_RESET_COOLDOWN_MS = 30_000;

/**
 * The tables an organization keeps its own settings in that a reset carries
 * over, from the old organization to the new one: the GitHub repository and
 * token, and the AI switch and key.
 */
const KEPT_ON_RESET = ["organization_github", "organization_ai"] as const;

/**
 * What the trial's one connection is called. It holds every stage at once,
 * one schema each, and runs for whoever's role may run migrations, the same
 * as any new connection.
 */
const TRIAL_CONNECTION = {
  name: "University demo",
  executeRole: DEFAULT_EXECUTE_ROLE,
} as const;

export type TrialDatabase = {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  sslMode: "disable" | "require";
};

/**
 * The demo database, read from TRIAL_DATABASE_URL, or null when it is not set
 * (the trial then has no connection, and says nothing is wrong).
 *
 * The URL names a role of the trial's own, which may create schemas in that
 * database (GRANT CREATE ON DATABASE) and owns nothing else anywhere. It must
 * not be a superuser, nor able to create roles (rebuildTrialDatabase refuses
 * both): every reset drops every schema it owns, and anyone on the internet can
 * run SQL as it, through Deploy. It must be reached directly, not through a
 * connection pooler, which would not pass on the settings a rebuild starts with.
 */
export function trialDatabase(url = process.env.TRIAL_DATABASE_URL): TrialDatabase | null {
  if (!url) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    console.error("TRIAL_DATABASE_URL is not a URL, so the trial has no database.");
    return null;
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    console.error("TRIAL_DATABASE_URL is not a postgres:// URL, so the trial has no database.");
    return null;
  }
  const user = decodeURIComponent(parsed.username);
  return {
    host: parsed.hostname,
    port: Number(parsed.port) || 5432,
    // Postgres's own default when a URL names no database: the user's name.
    database: decodeURIComponent(parsed.pathname.replace(/^\//, "")) || user,
    user,
    password: decodeURIComponent(parsed.password),
    sslMode: parsed.searchParams.get("sslmode") === "disable" ? "disable" : "require",
  };
}

/**
 * Why the demo database could not be rebuilt, in words the Trial Admin can
 * read (trialRebuildMessage), for the reset button to show. `underlying` is
 * what actually went wrong, for the server's log only: it can name the
 * database's host or user.
 */
export class TrialRebuildError extends Error {
  readonly underlying: unknown;

  constructor(message: string, underlying?: unknown) {
    super(message);
    this.name = "TrialRebuildError";
    this.underlying = underlying;
    // Keeps instanceof working however the class is compiled.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Ways a connection fails before it opens, or is cut while in use. */
const UNREACHABLE_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "ETIMEDOUT",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EAI_AGAIN",
  "57P01", // the server is shutting down
  "57P02", // the server crashed
  "57P03", // the server is starting up, as a sleeping Neon database does
]);

const UNREACHABLE_MESSAGE =
  "The trial's demo database could not be reached, so the trial was left as it was. Try again in a moment.";

const BUSY_MESSAGE =
  "The trial's demo database is busy, as a run is still using its tables, so the trial was left as it was. " +
  "Try again once the run has ended.";

/** What each PostgreSQL error code means for a rebuild. */
const MESSAGE_FOR_CODE = new Map<string, string>([
  [
    "28P01",
    "The trial's demo database refused the saved password, so the trial was left as it was. Whoever runs " +
      "this server needs to set the trial user's password back to the one in TRIAL_DATABASE_URL.",
  ],
  ["28000", "The trial's demo database would not let the trial's user sign in, so the trial was left as it was."],
  ["3D000", "The trial's demo database does not exist, so the trial was left as it was."],
  [
    "57014",
    "Rebuilding the trial's demo database took too long and was stopped, so the trial was left as it was. " +
      "Try again in a moment.",
  ],
  ["55P03", BUSY_MESSAGE],
  ["40P01", BUSY_MESSAGE],
  ["25006", "The trial's demo database is read only just now, so the trial was left as it was."],
  [
    "42501",
    "The trial's database user is missing a permission it needs, such as the right to create schemas, " +
      "so the trial was left as it was.",
  ],
  [
    "53300",
    "The trial's demo database has no free connections just now, so the trial was left as it was. " +
      "Try again in a moment.",
  ],
]);

const POOLER_MESSAGE =
  "TRIAL_DATABASE_URL points at a connection pooler, which a reset cannot use, so the trial was left as it " +
  "was. It needs to point at the database itself.";

const PLAIN_USER_MESSAGE =
  "TRIAL_DATABASE_URL names a superuser, or a user that may create roles, so the trial was left as it was. " +
  "The trial needs a plain user of its own.";

const OTHER_MESSAGE =
  "The trial's demo database could not be rebuilt, so the trial was left as it was. The server's log says why.";

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return typeof code === "string" ? code : "";
}

/**
 * What to tell the Trial Admin when the demo database could not be rebuilt:
 * what went wrong, and that the trial was left as it was. Never the error's
 * own words, which can name the database's host or user.
 */
export function trialRebuildMessage(error: unknown): string {
  if (error instanceof TrialRebuildError) return error.message;
  const code = errorCode(error);
  const text = error instanceof Error ? error.message : "";
  // pg's own words for a connection that timed out or was cut, which carry no code.
  if (UNREACHABLE_CODES.has(code) || /timeout expired|Connection terminated/i.test(text)) {
    return UNREACHABLE_MESSAGE;
  }
  // PgBouncer's answer to the settings a rebuild starts with.
  if (/unsupported startup parameter/i.test(text)) return POOLER_MESSAGE;
  return MESSAGE_FOR_CODE.get(code) ?? OTHER_MESSAGE;
}

type SessionSetting = { name: string; value: string; optional?: true };

/**
 * The settings every rebuild connection starts with. They are sent in the
 * startup packet's `options`, as `-c name=value`, because some hosts (Neon's
 * among them) drop pg's own statement_timeout and lock_timeout on the way,
 * and `options` arrives. A setting sent this way outranks one saved on the
 * user, so nothing a visitor saved there (ALTER ROLE ... SET) can make the
 * rebuild read only, load a library that is not there, find another schema's
 * functions first, or wait forever.
 *
 * The `optional` ones are newer than some servers (idle_session_timeout came
 * in PostgreSQL 14, transaction_timeout in 17) and are left out when a server
 * does not know them. Nobody can have saved one of those there either: the
 * server checks the name. session_preload_libraries is not here, since only a
 * superuser may set it, so only a superuser could have saved it.
 *
 * The values hold no spaces, which `options` would split on.
 */
const REBUILD_SESSION: readonly SessionSetting[] = [
  { name: "default_transaction_read_only", value: "off" },
  { name: "local_preload_libraries", value: "" },
  { name: "search_path", value: "pg_catalog" },
  { name: "default_tablespace", value: "" },
  { name: "standard_conforming_strings", value: "on" },
  { name: "client_encoding", value: "UTF8" },
  { name: "exit_on_error", value: "off" },
  { name: "statement_timeout", value: "20000" },
  // Under statement_timeout, so a run holding a table is reported as busy.
  { name: "lock_timeout", value: "15000" },
  { name: "idle_in_transaction_session_timeout", value: "60000" },
  { name: "idle_session_timeout", value: "0", optional: true },
  { name: "transaction_timeout", value: "0", optional: true },
  { name: "default_table_access_method", value: "heap", optional: true },
];

/**
 * The trial user's own saved settings, which every rebuild puts back after
 * clearing everything else saved on it. A connection the app opens as the
 * trial user starts with these unless it sets its own, as a run does.
 */
export const TRIAL_ROLE_DEFAULTS: readonly { name: string; value: string }[] = [
  { name: "statement_timeout", value: "20s" },
  { name: "idle_in_transaction_session_timeout", value: "60s" },
];

/** The setting a server refused a connection over, when that is why it refused. */
function unknownSetting(error: unknown): string | null {
  if (errorCode(error) !== "42704" || !(error instanceof Error)) return null;
  return /unrecognized configuration parameter "([^"]+)"/.exec(error.message)?.[1]?.toLowerCase() ?? null;
}

/**
 * The settings one rebuild's connections start with: REBUILD_SESSION, less any
 * optional one the server turned out not to know, so the rebuild's second
 * connection does not ask again.
 */
type RebuildSession = { settings: readonly SessionSetting[] };

/**
 * A connection to the demo database that starts with the session's settings.
 * A server that does not know an optional one refuses the connection, naming
 * it, and is asked again without it.
 */
async function connectForRebuild(db: TrialDatabase, session: RebuildSession): Promise<Client> {
  for (;;) {
    const client = new Client({
      ...buildPgConfig({
        host: db.host,
        port: db.port,
        database: db.database,
        user: db.user,
        password: db.password,
        sslMode: db.sslMode,
      }),
      // Shorter than a sign-in is willing to wait.
      connectionTimeoutMillis: 8_000,
      options: session.settings.map(({ name, value }) => `-c ${name}=${value}`).join(" "),
    });
    try {
      await client.connect();
      return client;
    } catch (error) {
      // pg closes a connection that failed to open by itself.
      const unknown = unknownSetting(error);
      const left = session.settings.filter((setting) => !(setting.optional && setting.name === unknown));
      if (left.length === session.settings.length) throw error;
      session.settings = left;
    }
  }
}

/**
 * Run `work` on a fresh rebuild connection, after SET ROLE NONE (a saved
 * `role` setting would start it as somebody else). Rolls back what `work`
 * left open when it throws, and closes the connection either way.
 */
async function onFreshConnection(
  db: TrialDatabase,
  session: RebuildSession,
  work: (client: Client) => Promise<void>
): Promise<void> {
  const client = await connectForRebuild(db, session);
  try {
    await client.query("SET ROLE NONE");
    await work(client);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    await client.end().catch(() => {});
  }
}

/** The trial user's oid, for the catalog queries below. */
const TRIAL_USER_OID = "(SELECT r.oid FROM pg_catalog.pg_roles r WHERE r.rolname = session_user)";

/**
 * Put the demo database back as it started, in two steps, each on a
 * connection of its own:
 *
 *   1. The trial user's saved settings. Every one is cleared (ALTER ROLE ...
 *      RESET ALL, for every database too), and TRIAL_ROLE_DEFAULTS are saved
 *      again. A setting a script saved there (ALTER ROLE CURRENT_USER SET
 *      default_transaction_read_only = on, say) reaches every later
 *      connection, the reset's own included. lib/trial-sql-guard.ts refuses
 *      such scripts; this puts the user right even if one got through.
 *   2. The schemas. Every schema the trial user owns there is dropped (the
 *      five demo ones, and any a tester made through Deploy), with its large
 *      objects and publications, and the five are built again, all in one
 *      transaction. On a new connection, so it starts with the settings step 1
 *      saved, not the ones it cleared.
 *
 * Schemas, not DROP OWNED: that would also take back the user's right to
 * create schemas in the database, and the next reset could not build them.
 *
 * Refuses, with a TrialRebuildError, a user that is a superuser or may create
 * roles: anyone on the internet runs SQL as this user. Anything else that goes
 * wrong is thrown as it is (rebuildTrialDemo puts it into words).
 */
export async function rebuildTrialDatabase(db: TrialDatabase): Promise<void> {
  const session: RebuildSession = { settings: REBUILD_SESSION };

  await onFreshConnection(db, session, async (client) => {
    const role = await client.query<{ rolsuper: boolean; rolcreaterole: boolean }>(
      `SELECT r.rolsuper, r.rolcreaterole FROM pg_catalog.pg_roles r WHERE r.rolname = session_user`
    );
    const found = role.rows[0];
    if (!found || found.rolsuper || found.rolcreaterole) throw new TrialRebuildError(PLAIN_USER_MESSAGE);

    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE");
    await client.query("ALTER ROLE SESSION_USER RESET ALL");
    const perDatabase = await client.query<{ datname: string }>(
      `SELECT d.datname
         FROM pg_catalog.pg_db_role_setting s
         JOIN pg_catalog.pg_database d ON d.oid = s.setdatabase
        WHERE s.setrole = ${TRIAL_USER_OID}`
    );
    for (const { datname } of perDatabase.rows) {
      await client.query(`ALTER ROLE SESSION_USER IN DATABASE ${quoteIdent(datname)} RESET ALL`);
    }
    for (const { name, value } of TRIAL_ROLE_DEFAULTS) {
      await client.query(`ALTER ROLE SESSION_USER SET ${name} = '${value}'`);
    }
    await client.query("COMMIT");
  });

  await onFreshConnection(db, session, async (client) => {
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE");
    const schemas = await client.query<{ nspname: string }>(
      `SELECT n.nspname FROM pg_catalog.pg_namespace n
        WHERE n.nspowner = ${TRIAL_USER_OID} AND n.nspname <> 'public'`
    );
    if (schemas.rows.length > 0) {
      // One statement, so a run holding a table is waited for once, not once a schema.
      await client.query(`DROP SCHEMA ${schemas.rows.map((row) => quoteIdent(row.nspname)).join(", ")} CASCADE`);
    }
    await client.query(
      `SELECT pg_catalog.lo_unlink(m.oid) FROM pg_catalog.pg_largeobject_metadata m
        WHERE m.lomowner = ${TRIAL_USER_OID}`
    );
    const publications = await client.query<{ pubname: string }>(
      `SELECT p.pubname FROM pg_catalog.pg_publication p WHERE p.pubowner = ${TRIAL_USER_OID}`
    );
    if (publications.rows.length > 0) {
      await client.query(`DROP PUBLICATION ${publications.rows.map((row) => quoteIdent(row.pubname)).join(", ")}`);
    }
    await client.query(trialSeedSql());
    await client.query("COMMIT");
  });
}

/** One of the three trial accounts, as a sign-in hands it to NextAuth. */
export type TrialPerson = { profileId: number; email: string; name: string };

export type TrialOrganization = {
  orgId: number;
  /** True when this call made the organization (the first time, or a reset). */
  rebuilt: boolean;
  people: Record<TrialRole, TrialPerson>;
};

/**
 * Make sure the trial organization is there: build it when it is missing, and
 * otherwise leave it as the testers have it. With `reset`, delete it and build
 * it again from nothing, carrying its GitHub and AI settings over
 * (KEPT_ON_RESET), unless it was made within TRIAL_RESET_COOLDOWN_MS.
 *
 * Throws when the database cannot be read; when the demo database cannot be
 * rebuilt (a TrialRebuildError), the first time as on a reset; and when an
 * organization called "trial" has somebody in it who is not one of the three
 * trial accounts: that organization is somebody's real one, and a reset would
 * delete it. Whatever it throws, it changes nothing in the app's database.
 */
export async function ensureTrialOrganization(
  { reset = false, now = new Date() }: { reset?: boolean; now?: Date } = {}
): Promise<TrialOrganization> {
  await syncMetadataTables();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT pg_advisory_xact_lock($1)`, [TRIAL_LOCK]);

    const found = await client.query<{ id: number; created_at: Date }>(
      `SELECT id, created_at FROM organizations WHERE slug = $1 FOR UPDATE`,
      [TRIAL_ORG_SLUG]
    );
    const existing = found.rows[0];
    if (existing) {
      const outsiders = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n
           FROM memberships m JOIN profiles p ON p.id = m.profile_id
          WHERE m.org_id = $1 AND lower(p.email) NOT LIKE $2`,
        [existing.id, `%@${TRIAL_EMAIL_DOMAIN}`]
      );
      if ((outsiders.rows[0]?.n ?? 0) > 0) {
        throw new Error(
          `The organization "${TRIAL_ORG_SLUG}" has members who are not trial accounts, so it is not the trial's. ` +
            "Rename it, or switch the trial off (TRIAL_SANDBOX)."
        );
      }
    }

    const justMade =
      !!existing && now.getTime() - new Date(existing.created_at).getTime() < TRIAL_RESET_COOLDOWN_MS;
    let orgId: number;
    let rebuilt = false;
    if (existing && (!reset || justMade)) {
      orgId = existing.id;
    } else {
      rebuilt = true;
      const kept = existing ? await readKeptSettings(client, existing.id) : [];
      if (existing) await client.query(`DELETE FROM organizations WHERE id = $1`, [existing.id]);
      await rebuildTrialDemo();
      const made = await client.query<{ id: number }>(
        `INSERT INTO organizations (slug, name) VALUES ($1, $2) RETURNING id`,
        [TRIAL_ORG_SLUG, TRIAL_ORG_NAME]
      );
      orgId = made.rows[0].id;
      await seedBuiltInRoles(client, orgId);
      await addTrialConnection(client, orgId);
      await restoreKeptSettings(client, orgId, kept);
    }

    const people = await settlePeople(client, orgId);
    await client.query("COMMIT");
    return { orgId, rebuilt, people };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

type KeptRow = { table: (typeof KEPT_ON_RESET)[number]; row: Record<string, unknown> };

/** The old organization's rows in KEPT_ON_RESET, read before it is deleted. */
async function readKeptSettings(client: MetadataClient, orgId: number): Promise<KeptRow[]> {
  const kept: KeptRow[] = [];
  for (const table of KEPT_ON_RESET) {
    const found = await client.query<Record<string, unknown>>(`SELECT * FROM ${table} WHERE org_id = $1`, [orgId]);
    for (const row of found.rows) kept.push({ table, row });
  }
  return kept;
}

/**
 * The same rows again, for the new organization (JSON columns go back as
 * JSON), then AI switched on: the trial always has it, whatever was saved.
 */
async function restoreKeptSettings(client: MetadataClient, orgId: number, kept: KeptRow[]): Promise<void> {
  for (const { table, row } of kept) {
    const columns = Object.keys(row);
    const values = columns.map((column) => {
      if (column === "org_id") return orgId;
      const value = row[column];
      return value !== null && typeof value === "object" && !(value instanceof Date) ? JSON.stringify(value) : value;
    });
    const quoted = columns.map((column) => `"${column.replace(/"/g, '""')}"`).join(", ");
    const params = columns.map((_, i) => `$${i + 1}`).join(", ");
    await client.query(`INSERT INTO ${table} (${quoted}) VALUES (${params})`, values);
  }
  await client.query(
    `INSERT INTO organization_ai (org_id, enabled, features, updated_by, updated_at)
     VALUES ($1, true, '{}'::jsonb, 'the trial', now())
     ON CONFLICT (org_id) DO UPDATE SET enabled = true`,
    [orgId]
  );
}

/**
 * Rebuild the demo database, or throw a TrialRebuildError that says why in
 * words the Trial Admin can read. The caller's transaction then rolls back, so
 * the organization stays as it was. What actually went wrong is logged here,
 * since the message leaves it out.
 */
async function rebuildTrialDemo(): Promise<void> {
  const db = trialDatabase();
  if (!db) return;
  try {
    await rebuildTrialDatabase(db);
  } catch (error) {
    const code = errorCode(error);
    console.error(
      "Could not rebuild the trial's demo database:",
      error instanceof Error ? error.message : "unknown error",
      code ? `(${code})` : ""
    );
    throw error instanceof TrialRebuildError ? error : new TrialRebuildError(trialRebuildMessage(error), error);
  }
}

async function addTrialConnection(client: MetadataClient, orgId: number): Promise<void> {
  const db = trialDatabase();
  if (!db) return;
  await client.query(
    `INSERT INTO connections
       (name, host, port, database_name, type, username, password, connection_string,
        ssl, ssl_mode, execute_role, org_id, version, updated_at, updated_by)
     VALUES ($1, $2, $3, $4, 'PostgreSQL', $5, $6, NULL, $7, $8, $9, $10, 1, now(), $11)`,
    [
      TRIAL_CONNECTION.name,
      db.host,
      db.port,
      db.database,
      db.user,
      encryptSecret(db.password) ?? "",
      db.sslMode !== "disable",
      db.sslMode,
      TRIAL_CONNECTION.executeRole,
      orgId,
      "the trial",
    ]
  );
}

/** The three accounts' profiles (made once, kept across resets) and their memberships. */
async function settlePeople(client: MetadataClient, orgId: number): Promise<Record<TrialRole, TrialPerson>> {
  const people = {} as Record<TrialRole, TrialPerson>;
  for (const role of TRIAL_ROLES) {
    const { email, name } = TRIAL_PEOPLE[role];
    const found = await client.query<{ id: number }>(`SELECT id FROM profiles WHERE lower(email) = $1`, [email]);
    let profileId = found.rows[0]?.id;
    if (profileId === undefined) {
      const made = await client.query<{ id: number }>(
        `INSERT INTO profiles (email, name) VALUES ($1, $2) RETURNING id`,
        [email, name]
      );
      profileId = made.rows[0].id;
    }
    await client.query(
      `INSERT INTO memberships (org_id, profile_id, role) VALUES ($1, $2, $3)
       ON CONFLICT (org_id, profile_id) DO UPDATE SET role = EXCLUDED.role`,
      [orgId, profileId, role]
    );
    await client.query(`UPDATE profiles SET name = $2, last_org_id = $3 WHERE id = $1`, [profileId, name, orgId]);
    people[role] = { profileId, email, name };
  }
  return people;
}

/**
 * The account the landing page's button signs in as, with the trial made
 * ready first, or null when the trial is off or the role is not one of the
 * three. NextAuth's authorize() for the "trial" provider (auth.config.ts).
 */
export async function trialSignIn(
  role: unknown
): Promise<{ id: string; email: string; name: string } | null> {
  if (!trialEnabled()) return null;
  const picked = toTrialRole(role);
  if (!picked) return null;
  const trial = await ensureTrialOrganization();
  const person = trial.people[picked];
  return { id: String(person.profileId), email: person.email, name: person.name };
}

/**
 * The Trial Admin's "Reset trial" button: the trial back to how it started,
 * demo schemas and all, keeping its GitHub and AI settings. Throws when it
 * cannot be done, leaving the trial as it was: a TrialRebuildError, whose
 * message is meant for the Trial Admin, when the demo database could not be
 * rebuilt.
 */
export async function resetTrial(): Promise<void> {
  if (!trialEnabled()) throw new Error("The trial is switched off on this server.");
  await ensureTrialOrganization({ reset: true });
}

/** True when the profile is one of the three trial accounts. Throws when the database cannot be read. */
export async function isTrialProfile(profileId: number): Promise<boolean> {
  if (!trialEnabled()) return false;
  const found = await pool.query<{ email: string }>(`SELECT email FROM profiles WHERE id = $1`, [profileId]);
  return isTrialEmail(found.rows[0]?.email);
}
