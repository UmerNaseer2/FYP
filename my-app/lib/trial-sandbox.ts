// SERVER-ONLY: builds the shared trial organization, and puts it back when asked.
//
// lib/trial-rules.ts says what the trial is. This file makes it real, in the
// app's own database:
//
//   - the organization "trial", with the built-in roles;
//   - the three accounts (Trial Admin, Trial Editor, Trial Viewer) and their
//     memberships;
//   - three saved connections, to the trial's own demo databases, when
//     TRIAL_DATABASE_URL names them (see trialDatabases below).
//
// It is built the first time somebody signs in to the trial, and then left
// alone: nothing resets it on a timer. The Trial Admin's "Reset trial" button
// (app/api/trial/reset/route.ts) deletes the organization, with everything in
// it, rebuilds the demo databases, and makes it again. Its GitHub repository
// and token and its AI settings are carried over, so a token saved once stays.
// The three accounts' profiles stay too, so every open session still works, in
// the fresh organization.

import { Client } from "pg";
import pool, { syncMetadataTables } from "./version-db";
import { seedBuiltInRoles } from "./db/bootstrap";
import type { MetadataClient } from "./db/sequelize";
import { buildPgConfig } from "./connection-config";
import { encryptSecret } from "./secret-store";
import { DEFAULT_EXECUTE_ROLE } from "./connection-access";
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
import { TRIAL_STAGES, trialSeedSql, type TrialStage } from "./trial-seed";

/** Held while the trial is checked or rebuilt, so two sign-ins never build it twice. */
const TRIAL_LOCK = 0x7472_6961; // "tria"

/**
 * A reset asked for within this long of the last one is not done again: the
 * trial is already fresh, and a button pressed over and over by many visitors
 * would keep rebuilding the demo databases under everyone.
 */
export const TRIAL_RESET_COOLDOWN_MS = 30_000;

/**
 * The tables an organization keeps its own settings in that a reset carries
 * over, from the old organization to the new one: the GitHub repository and
 * token, and the AI switch and key.
 */
const KEPT_ON_RESET = ["organization_github", "organization_ai"] as const;

/** The trial's demo databases' names, one for each stage, on the server TRIAL_DATABASE_URL names. */
export const TRIAL_DATABASE_NAMES: Record<TrialStage, string> = {
  prod: "trial_prod",
  staging: "trial_staging",
  dev: "trial_dev",
};

/** What each one is called in the trial's connection list. */
// Every one runs for whoever's role may run migrations, the same as any new
// connection: the role decides, not the connection.
const TRIAL_CONNECTIONS: Record<TrialStage, { name: string; environment: string; executeRole: string }> = {
  prod: { name: "Bookshop (production)", environment: "prod", executeRole: DEFAULT_EXECUTE_ROLE },
  staging: { name: "Bookshop (staging)", environment: "staging", executeRole: DEFAULT_EXECUTE_ROLE },
  dev: { name: "Bookshop (development)", environment: "dev", executeRole: DEFAULT_EXECUTE_ROLE },
};

export type TrialDatabase = {
  stage: TrialStage;
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  sslMode: "disable" | "require";
};

/**
 * The three demo databases, read from TRIAL_DATABASE_URL, or null when it is
 * not set (the trial then has no connections, and says nothing is wrong).
 *
 * The URL names the server and a role that owns trial_prod, trial_staging and
 * trial_dev there. Whichever database the URL itself names is ignored. The
 * role must not be a superuser (rebuildTrialDatabase refuses one): every
 * reset drops everything it owns, and anyone on the internet can run SQL
 * as it, through Deploy.
 */
export function trialDatabases(url = process.env.TRIAL_DATABASE_URL): TrialDatabase[] | null {
  if (!url) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    console.error("TRIAL_DATABASE_URL is not a URL, so the trial has no databases.");
    return null;
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    console.error("TRIAL_DATABASE_URL is not a postgres:// URL, so the trial has no databases.");
    return null;
  }
  const sslMode = parsed.searchParams.get("sslmode") === "disable" ? "disable" : "require";
  return TRIAL_STAGES.map((stage) => ({
    stage,
    host: parsed.hostname,
    port: Number(parsed.port) || 5432,
    database: TRIAL_DATABASE_NAMES[stage],
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    sslMode,
  }));
}

/**
 * Put one demo database back to its starting bookshop: drop everything the
 * trial role owns there (whatever a tester deployed, schemas and all), and
 * build the stage's tables and rows again, all in one transaction.
 */
export async function rebuildTrialDatabase(db: TrialDatabase): Promise<void> {
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
    statement_timeout: 20_000,
  });
  await client.connect();
  try {
    const role = await client.query<{ rolsuper: boolean }>(
      `SELECT rolsuper FROM pg_roles WHERE rolname = current_user`
    );
    if (role.rows[0]?.rolsuper !== false) {
      throw new Error("TRIAL_DATABASE_URL names a superuser. The trial needs a role of its own that is not one.");
    }
    await client.query("BEGIN");
    await client.query("DROP OWNED BY CURRENT_USER CASCADE");
    await client.query("CREATE SCHEMA IF NOT EXISTS public");
    await client.query(trialSeedSql(db.stage));
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    await client.end().catch(() => {});
  }
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
 * Throws when the database cannot be read, and when an organization called
 * "trial" has somebody in it who is not one of the three trial accounts:
 * that organization is somebody's real one, and a reset would delete it.
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
      await rebuildTrialDatabases();
      const made = await client.query<{ id: number }>(
        `INSERT INTO organizations (slug, name) VALUES ($1, $2) RETURNING id`,
        [TRIAL_ORG_SLUG, TRIAL_ORG_NAME]
      );
      orgId = made.rows[0].id;
      await seedBuiltInRoles(client, orgId);
      await addTrialConnections(client, orgId);
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
 * Rebuild every demo database. A database that cannot be rebuilt is logged
 * and left as it is: the trial still opens, with yesterday's data there.
 */
async function rebuildTrialDatabases(): Promise<void> {
  const databases = trialDatabases();
  if (!databases) return;
  await Promise.all(
    databases.map(async (db) => {
      try {
        await rebuildTrialDatabase(db);
      } catch (error) {
        console.error(
          `Could not rebuild the trial's ${db.stage} database:`,
          error instanceof Error ? error.message : "unknown error"
        );
      }
    })
  );
}

async function addTrialConnections(client: MetadataClient, orgId: number): Promise<void> {
  const databases = trialDatabases();
  if (!databases) return;
  for (const db of databases) {
    const shown = TRIAL_CONNECTIONS[db.stage];
    await client.query(
      `INSERT INTO connections
         (name, host, port, database_name, type, username, password, connection_string,
          ssl, ssl_mode, environment, execute_role, org_id, version, updated_at, updated_by)
       VALUES ($1, $2, $3, $4, 'PostgreSQL', $5, $6, NULL, $7, $8, $9, $10, $11, 1, now(), $12)`,
      [
        shown.name,
        db.host,
        db.port,
        db.database,
        db.user,
        encryptSecret(db.password) ?? "",
        db.sslMode !== "disable",
        db.sslMode,
        shown.environment,
        shown.executeRole,
        orgId,
        "the trial",
      ]
    );
  }
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
 * demo databases and all, keeping its GitHub and AI settings. Throws when it
 * cannot be done.
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
