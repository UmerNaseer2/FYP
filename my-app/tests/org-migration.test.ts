// org-migration: what lib/db/bootstrap.ts does to real databases, new and old,
// and how the sign-in and role code that runs on them behaves there.
//
// tests/roles-bootstrap.test.ts checks what the bootstrap says to a fake
// database. This file boots it against real Postgres databases and reads back
// what they hold afterwards:
//
//   - A new database and one made before organizations end up the same shape:
//     the same columns, keys, checks and indexes.
//   - Everything a database held before organizations moves into the default
//     organization.
//   - Each old profile's role becomes a membership in it. A role that no longer
//     exists becomes Viewer, and profiles.role is emptied.
//   - Roles an admin tuned keep their permissions, and a box they unticked
//     stays unticked.
//   - The keys hold: a role somebody holds cannot be deleted, renaming a role
//     carries its members and permissions along, and names only have to be
//     unique inside one organization.
//   - A later boot gives an organization the built-in roles it lacks, and
//     leaves every other organization alone.
//   - A second boot changes nothing, and two servers booting at once end up
//     where one would have.
//   - A check that lists the values a column may hold takes the values this
//     app has added since it was made, and keeps any it does not know.
//   - Deleting an organization deletes exactly its rows.
//   - On the desktop the default organization is the personal one, and the
//     tables on the bootstrap's list fill in org_id with it by default.
//
// It also runs the code that signs people in and looks up their roles
// (lib/accounts-db.ts, lib/orgs-db.ts, lib/roles-db.ts) on a booted database:
//
//   - Signing in finds a person by the account they signed in with, never by
//     the address it reports. A person from before accounts were recorded is
//     linked to their home-tenant Microsoft account on its first sign-in; any
//     other account reporting an address somebody here already has is turned
//     away, and nobody new gets an account for an address no provider vouches
//     for.
//   - On the web, the first person from the home tenant to sign in to a new
//     deployment becomes its admin, and nobody else joins anything by signing
//     in. On the desktop the first person becomes the admin and everyone after
//     them a viewer. Either way once each, even when several sign in at the
//     same moment, and someone who already belongs to another organization is
//     left out of the default one.
//   - The lookups the gates make on every request, and the changes the Roles
//     tab makes, only ever see and touch the organization they are asked about.
//
// tests/fixtures/pre-org-schema.sql is the schema of a database from before
// organizations, with no rows in it; seedLegacyRows below fills it.
//
// It needs a Postgres it may create and drop databases in, so it runs only when
// TEST_DATABASE_URL is set (CI sets it, and fails rather than skip without it:
// see tests/helpers/test-database.ts), and only against a database whose name
// contains "test". The databases it makes are named after that one, replaced if
// they exist, and dropped at the end. It connects as a superuser, because
// seedLegacyRows switches the keys off for one row, and only a superuser may.
//
// To run it locally, start a throwaway Postgres (never the app's own database)
// and point the variable at it:
//
//   docker run -d --name ss-migration-test -p 127.0.0.1:55432:5432 \
//     -e POSTGRES_HOST_AUTH_METHOD=trust -e POSTGRES_DB=schema_studio_test \
//     postgres:17-alpine
//   TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55432/schema_studio_test \
//     npx jest tests/org-migration.test.ts
import fs from "fs";
import path from "path";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import {
  ADMIN_ROLE,
  BUILT_IN_ROLES,
  BUILT_IN_ROLE_INFO,
  ROLE_CHANGE_KINDS,
  presetFor,
  readKeyOf,
  type BuiltInRole,
} from "@/lib/permissions";
import type { Resolved, SignInIdentity } from "@/lib/accounts-db";
import { testDatabaseUrl } from "./helpers/test-database";

const testUrl = testDatabaseUrl();
const describeWithDatabase = testUrl ? describe : describe.skip;

const PRE_ORG_SCHEMA = fs.readFileSync(
  path.join(__dirname, "fixtures", "pre-org-schema.sql"),
  "utf8"
);

// Made up on every run. The connections these tests write are never opened.
const FAKE_PASSWORD = randomUUID();

// A boot creates or checks every table, so these take seconds, not
// milliseconds. BASELINES is for the first beforeAll, which boots four
// databases.
const SLOW = 60_000;
const BASELINES = 120_000;

// The tables that hold an organization's rows, in the order the bootstrap
// lists them. A copy on purpose: if a table drops off the bootstrap's list,
// this one still expects it to be moved.
const ORG_TABLES = [
  "connections",
  "roles",
  "role_permissions",
  "role_changes",
  "tracked_schemas",
  "snapshots",
  "lineage_migrations",
  "drift_events",
  "schema_metrics",
  "query_history",
  "perf_thresholds",
  "comparison_sets",
  "comparison_set_targets",
  "comparison_runs",
  "deploy_approvals",
  "deploy_attempts",
  "invites",
];
// Memberships belong to an organization too, but they came with
// organizations, so they are not on the bootstrap's list of older tables to
// move.
const ORG_SCOPED = [...ORG_TABLES, "memberships"];
// A person, and the accounts they sign in with, belong to no organization:
// one person can be in several.
const NOT_ORG_SCOPED = ["organizations", "profiles", "identities"];

const VIEWER_PRESET = presetFor("viewer") ?? [];
const EDITOR_PRESET = presetFor("editor") ?? [];
// A permission editors start with and viewers do not: the box the legacy
// database's admin unticked for editors.
const UNTICKED =
  EDITOR_PRESET.find((key) => !VIEWER_PRESET.includes(key)) ?? "";

// What the bootstrap seeds a built-in role with: its preset, except Admin,
// which holds every permission without rows of its own.
function seeded(role: BuiltInRole): readonly string[] {
  return role === ADMIN_ROLE ? [] : presetFor(role) ?? [];
}

// Who belongs to the default organization once a legacy database has booted,
// and as what. ghost@ held a role that had since been deleted, and default@
// was left on the old column's default.
const LEGACY_MEMBERSHIPS: Record<string, string> = {
  "admin@example.invalid": "admin",
  "auditor@example.invalid": "auditor",
  "default@example.invalid": "viewer",
  "editor@example.invalid": "editor",
  "ghost@example.invalid": "viewer",
  "viewer@example.invalid": "viewer",
};

// The default organization, as a web server makes it and as the desktop app
// makes it.
const SWINBURNE = {
  id: expect.any(Number),
  slug: "swinburne-fyp",
  name: "Swinburne FYP",
  personal: false,
  is_default: true,
  two_person_rule: true,
};
const PERSONAL = {
  ...SWINBURNE,
  slug: "personal",
  name: "Personal",
  personal: true,
};

// The roles, and the permissions they hold, in an organization the bootstrap
// seeded from nothing.
const EXPECTED_BUILT_IN_ROLES = [...BUILT_IN_ROLES].sort().map((role) => ({
  name: role,
  label: BUILT_IN_ROLE_INFO[role].label,
  description: BUILT_IN_ROLE_INFO[role].description,
  built_in: true,
  preset_applied: [...seeded(role)],
}));
const EXPECTED_BUILT_IN_PERMISSIONS = Object.fromEntries(
  BUILT_IN_ROLES.map((role) => [role, [...seeded(role)].sort()])
);

type Counts = Record<string, { mine: number; others: number }>;

type App = {
  syncMetadataTables: () => Promise<void>;
  metadataPool: typeof import("@/lib/db/sequelize").metadataPool;
  close: () => Promise<void>;
};

// A connection to the database TEST_DATABASE_URL names, for creating and
// dropping the others.
let server: Client;
let baseName = "";
const made: string[] = [];
const savedEnv: Record<string, string | undefined> = {};

// Booted once in the first beforeAll, and only read after that.
let legacy = "";
let fresh = "";
let desktopLegacy = "";
let desktopFresh = "";

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function urlFor(name: string): string {
  const url = new URL(testUrl);
  url.pathname = "/" + encodeURIComponent(name);
  return url.toString();
}

async function connectTo(url: string): Promise<Client> {
  const client = new Client({ connectionString: url });
  await client.connect();
  return client;
}

async function withClient<T>(
  url: string,
  work: (client: Client) => Promise<T>
): Promise<T> {
  const client = await connectTo(url);
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

// An empty database named after the one TEST_DATABASE_URL names, made fresh
// even if an earlier run left one behind.
async function freshDatabase(suffix: string): Promise<string> {
  const name = `${baseName}_${suffix}`;
  await server.query(`DROP DATABASE IF EXISTS ${quoteIdent(name)} WITH (FORCE)`);
  await server.query(`CREATE DATABASE ${quoteIdent(name)}`);
  if (!made.includes(name)) made.push(name);
  return urlFor(name);
}

// A database as the last build before organizations would have left it.
async function legacyDatabase(suffix: string): Promise<string> {
  const url = await freshDatabase(suffix);
  await withClient(url, async (client) => {
    await client.query(PRE_ORG_SCHEMA);
    await seedLegacyRows(client);
  });
  return url;
}

// The app's database modules read DATABASE_URL_A when they load, and keep
// their pool on globalThis so that it outlives a reload. So each boot forgets
// that pool, points the variable at the database it is for, and loads fresh
// copies of the modules.
async function load(url: string, { desktop = false } = {}): Promise<App> {
  jest.resetModules();
  globalThis.__metadataSequelize = undefined;
  process.env.DATABASE_URL_A = url;
  if (desktop) process.env.SCHEMA_STUDIO_DESKTOP = "1";
  else delete process.env.SCHEMA_STUDIO_DESKTOP;
  const { syncMetadataTables } = await import("@/lib/db/bootstrap");
  const { sequelize, metadataPool } = await import("@/lib/db/sequelize");
  return { syncMetadataTables, metadataPool, close: () => sequelize.close() };
}

// One server starting up against the database at url.
async function boot(
  url: string,
  options?: { desktop?: boolean }
): Promise<void> {
  const app = await load(url, options);
  try {
    await app.syncMetadataTables();
  } finally {
    await app.close();
  }
}

// Boots like boot(), and says how many clients the bootstrap took from the
// pool for itself. Every boot takes one to hold its lock; a second means it
// found an organization due for its built-in roles.
async function bootCountingClients(url: string): Promise<number> {
  const app = await load(url);
  const connect = jest.spyOn(app.metadataPool, "connect");
  try {
    await app.syncMetadataTables();
    return connect.mock.calls.length;
  } finally {
    connect.mockRestore();
    await app.close();
  }
}

// The app as a request uses it: the bootstrap, plus the modules that sign
// people in, find their membership and say what their role may do. Loaded
// after load() has reset the modules, so they all share its pool.
type RequestApp = App & {
  resolveIdentity: typeof import("@/lib/accounts-db").resolveIdentity;
  orgs: typeof import("@/lib/orgs-db");
  roles: typeof import("@/lib/roles-db");
};

async function loadRequestApp(
  url: string,
  options?: { desktop?: boolean }
): Promise<RequestApp> {
  const app = await load(url, options);
  const { resolveIdentity } = await import("@/lib/accounts-db");
  const orgs = await import("@/lib/orgs-db");
  const roles = await import("@/lib/roles-db");
  return { ...app, resolveIdentity, orgs, roles };
}

// The client's Microsoft tenant, and somebody else's. resolveIdentity is
// handed what identityFrom made of a sign-in (tests/accounts-identity.test.ts
// covers that half), so here a tenant is only ever part of an account's ID.
const HOME_TENANT = "11111111-2222-3333-4444-555555555555";
const OTHER_TENANT = "99999999-8888-7777-6666-555555555555";

// A Microsoft sign-in from the home tenant, which is trusted with its
// address. `oid` stands in for the account's object ID.
function microsoft(
  email: string,
  oid: string,
  name: string | null = null
): SignInIdentity {
  return {
    provider: "microsoft",
    subject: `${HOME_TENANT}:${oid}`,
    email,
    emailVerified: true,
    name,
    homeTenant: true,
  };
}

// A Microsoft sign-in from another organization's tenant, whose address is
// trusted only when Microsoft says its domain is verified.
function guest(
  email: string,
  oid: string,
  emailVerified: boolean
): SignInIdentity {
  return {
    provider: "microsoft",
    subject: `${OTHER_TENANT}:${oid}`,
    email,
    emailVerified,
    name: null,
    homeTenant: false,
  };
}

function github(
  id: number,
  email: string,
  emailVerified = true
): SignInIdentity {
  return {
    provider: "github",
    subject: String(id),
    email,
    emailVerified,
    name: null,
    homeTenant: false,
  };
}

// Signs `who` in and returns the profile ID they were given, failing the test
// if they were turned away.
async function signedIn(app: RequestApp, who: SignInIdentity): Promise<number> {
  const result = await app.resolveIdentity(who);
  if (result.kind !== "ok") {
    throw new Error(`Signing in ${who.email} was refused: ${result.kind}.`);
  }
  return result.profileId;
}

// The accounts linked to a person, oldest first.
async function identitiesOf(client: Client, profileId: number) {
  const { rows } = await client.query(
    `SELECT provider, subject, email, email_verified
       FROM identities WHERE profile_id = $1 ORDER BY id`,
    [profileId]
  );
  return rows;
}

// Waits until `count` sign-ins in the watcher's database are waiting for a
// lock, and fails after 10 seconds. pg_stat_activity is read once per
// transaction and kept until it ends, so the watcher has to be a client of its
// own that asks one statement (and so one transaction) at a time, and never
// the one holding the lock.
async function waitForLockWaits(watcher: Client, count: number): Promise<void> {
  let waiting = 0;
  for (let tries = 0; tries < 400 && waiting < count; tries++) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    const { rows } = await watcher.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'`
    );
    waiting = rows[0].n;
  }
  if (waiting < count) {
    throw new Error(
      `Only ${waiting} of the ${count} sign-ins were waiting after 10 seconds.`
    );
  }
}

// Five new people from the home tenant signing in to a new install at the
// same moment, and the roles they end up with in its default organization,
// sorted.
//
// A lock on memberships lines them all up at the membership. The first takes
// the default organization's row and then waits for the table; the other four
// wait for that row. Without the row lock all five would wait for the table,
// find nobody there once it was free, and each become an admin. Five, because
// the pool hands out at most five connections, so a sixth would wait for a
// connection rather than a lock.
async function rolesAfterFiveSignIns(options: {
  desktop: boolean;
}): Promise<string[]> {
  const url = await freshDatabase(
    options.desktop ? "signin_race_desktop" : "signin_race"
  );
  const race = await loadRequestApp(url, options);
  await race.syncMetadataTables();
  const holder = await connectTo(url);
  const watcher = await connectTo(url);
  let signIns: Promise<number>[] = [];
  try {
    await holder.query("BEGIN");
    await holder.query("LOCK TABLE memberships IN SHARE MODE");
    signIns = ["a", "b", "c", "d", "e"].map((name) =>
      signedIn(race, microsoft(`${name}@example.invalid`, `oid-${name}`))
    );
    await waitForLockWaits(watcher, 5);
    await holder.query("COMMIT");
    await Promise.all(signIns);
    const roles = await membershipsOf(watcher, await defaultOrgId(watcher));
    return Object.values(roles).sort();
  } finally {
    await holder.end();
    await Promise.allSettled(signIns);
    await watcher.end();
    await race.close();
  }
}

// Runs work in a transaction that is always rolled back, so a check can break
// a rule without leaving anything behind for the next one. A statement that
// fails aborts the transaction, so the failure a check expects has to be the
// last thing it does inside one.
async function rolledBack(
  client: Client,
  work: () => Promise<void>
): Promise<void> {
  await client.query("BEGIN");
  try {
    await work();
  } finally {
    await client.query("ROLLBACK");
  }
}

async function insertId(
  client: Client,
  text: string,
  values: unknown[] = []
): Promise<number> {
  const { rows } = await client.query<{ id: number }>(text, values);
  return rows[0].id;
}

async function organizationsIn(client: Client) {
  const { rows } = await client.query(
    `SELECT id, slug, name, personal, is_default, two_person_rule
       FROM organizations ORDER BY id`
  );
  return rows;
}

async function defaultOrgId(client: Client): Promise<number> {
  const { rows } = await client.query<{ id: number }>(
    `SELECT id FROM organizations WHERE is_default`
  );
  return rows[0].id;
}

// Who belongs to an organization, and as what, by email.
async function membershipsOf(
  client: Client,
  orgId: number
): Promise<Record<string, string>> {
  const { rows } = await client.query<{ email: string; role: string }>(
    `SELECT p.email, m.role
       FROM memberships m JOIN profiles p ON p.id = m.profile_id
      WHERE m.org_id = $1`,
    [orgId]
  );
  return Object.fromEntries(rows.map((row) => [row.email, row.role]));
}

// The permissions one role holds in one organization, as sorted keys.
async function permissionsOf(
  client: Client,
  orgId: number,
  role: string
): Promise<string[]> {
  const { rows } = await client.query<{ key: string }>(
    `SELECT feature || ':' || action AS key
       FROM role_permissions WHERE org_id = $1 AND role = $2`,
    [orgId, role]
  );
  return rows.map((row) => row.key).sort();
}

async function builtInPermissionsOf(
  client: Client,
  orgId: number
): Promise<Record<string, string[]>> {
  const permissions: Record<string, string[]> = {};
  for (const role of BUILT_IN_ROLES) {
    permissions[role] = await permissionsOf(client, orgId, role);
  }
  return permissions;
}

// Every role in an organization, as the bootstrap writes them.
async function rolesOf(client: Client, orgId: number) {
  const { rows } = await client.query(
    `SELECT name, label, description, built_in, preset_applied
       FROM roles WHERE org_id = $1 ORDER BY name`,
    [orgId]
  );
  return rows;
}

// An organization's roles and permissions, whole rows, sorted: to show that
// work on one organization left another alone.
async function orgRoleRows(client: Client, orgId: number): Promise<string[]> {
  const { rows } = await client.query<{ line: string }>(
    `SELECT 'roles ' || to_jsonb(r)::text AS line
       FROM roles r WHERE r.org_id = $1
     UNION ALL
     SELECT 'role_permissions ' || to_jsonb(p)::text
       FROM role_permissions p WHERE p.org_id = $1`,
    [orgId]
  );
  return rows.map((row) => row.line).sort();
}

// How many rows of each table belong to one organization, and how many to any
// other.
async function rowsPerTable(client: Client, orgId: number): Promise<Counts> {
  const counts: Counts = {};
  for (const table of ORG_SCOPED) {
    const { rows } = await client.query<{ mine: number; others: number }>(
      `SELECT (count(*) FILTER (WHERE org_id = $1))::int AS mine,
              (count(*) FILTER (WHERE org_id <> $1))::int AS others
         FROM ${quoteIdent(table)}`,
      [orgId]
    );
    counts[table] = rows[0];
  }
  return counts;
}

// What rowsPerTable says about the default organization of a legacy database
// once it has booted: each row seedLegacyRows wrote, now in the default
// organization, and none anywhere else.
function expectedLegacyRows(): Counts {
  const mine: Record<string, number> = {
    connections: 1,
    tracked_schemas: 1,
    comparison_sets: 1,
    role_changes: 1,
    roles: BUILT_IN_ROLES.length + 1,
    // Editors are one short of their preset, and the auditor's one makes up
    // for it.
    role_permissions: VIEWER_PRESET.length + EDITOR_PRESET.length,
    memberships: Object.keys(LEGACY_MEMBERSHIPS).length,
  };
  return Object.fromEntries(
    ORG_SCOPED.map((table) => [table, { mine: mine[table] ?? 0, others: 0 }])
  );
}

// Everything about a database's tables except their rows, as sorted lines:
// columns with their types, nullability and defaults, constraints, and
// indexes. NOT NULL constraints are left out of the constraint lines, because
// Postgres 18 lists them there and older versions do not; the column lines
// already say which columns allow nulls.
async function shapeOf(client: Client): Promise<string[]> {
  const { rows } = await client.query<{ line: string }>(
    `SELECT 'column ' || c.table_name || '.' || c.column_name || ' '
            || c.data_type || ' ' || c.is_nullable || ' '
            || coalesce(c.column_default, '-') AS line
       FROM information_schema.columns c
      WHERE c.table_schema = 'public'
     UNION ALL
     SELECT 'constraint ' || conrelid::regclass::text || '.' || conname || ' '
            || pg_get_constraintdef(oid)
       FROM pg_constraint
      WHERE connamespace = 'public'::regnamespace AND contype <> 'n'
     UNION ALL
     SELECT 'index ' || indexname || ' ' || indexdef
       FROM pg_indexes
      WHERE schemaname = 'public'`
  );
  return rows.map((row) => row.line).sort();
}

// Every row of every table as sorted lines of JSON. With times: false,
// timestamp columns are left out, for comparing databases made at different
// moments.
async function everyRow(
  client: Client,
  { times = true } = {}
): Promise<string[]> {
  const tables = await client.query<{ name: string; timestamps: string[] }>(
    `SELECT t.table_name AS name,
            coalesce(array_agg(c.column_name::text)
                       FILTER (WHERE c.data_type LIKE 'timestamp%'), '{}')
              AS timestamps
       FROM information_schema.tables t
       JOIN information_schema.columns c
         ON c.table_schema = t.table_schema AND c.table_name = t.table_name
      WHERE t.table_schema = 'public' AND t.table_type = 'BASE TABLE'
      GROUP BY t.table_name`
  );
  const lines: string[] = [];
  for (const { name, timestamps } of tables.rows) {
    const { rows } = await client.query<{ line: string }>(
      `SELECT (to_jsonb(t) - $1::text[])::text AS line FROM ${quoteIdent(name)} t`,
      [times ? [] : timestamps]
    );
    for (const row of rows) lines.push(`${name} ${row.line}`);
  }
  return lines.sort();
}

// Rows a database from before organizations could hold:
//
//   - The built-in roles as the last build seeded them, and a role an admin
//     made, "auditor", with one permission.
//   - Editors without UNTICKED, which an admin took away, and the audit row
//     that says so.
//   - A profile for each role, one left on the old column's default, and one
//     whose role was deleted later.
//   - A connection, a schema tracked on it, and a saved comparison set.
async function seedLegacyRows(client: Client): Promise<void> {
  await client.query(
    `INSERT INTO roles (name, label, description, built_in, preset_applied)
     SELECT name, label, description, true, preset::jsonb
       FROM unnest($1::text[], $2::text[], $3::text[], $4::text[])
         AS r(name, label, description, preset)`,
    [
      [...BUILT_IN_ROLES],
      BUILT_IN_ROLES.map((role) => BUILT_IN_ROLE_INFO[role].label),
      BUILT_IN_ROLES.map((role) => BUILT_IN_ROLE_INFO[role].description),
      BUILT_IN_ROLES.map((role) => JSON.stringify(seeded(role))),
    ]
  );
  await client.query(
    `INSERT INTO roles (name, label) VALUES ('auditor', 'Auditor')`
  );

  const grants = [
    ...VIEWER_PRESET.map((key) => ["viewer", key]),
    ...EDITOR_PRESET.filter((key) => key !== UNTICKED).map((key) => [
      "editor",
      key,
    ]),
    ["auditor", readKeyOf("drift")],
  ];
  await client.query(
    `INSERT INTO role_permissions (role, feature, action)
     SELECT role_name, split_part(permission, ':', 1),
            split_part(permission, ':', 2)
       FROM unnest($1::text[], $2::text[]) AS g(role_name, permission)`,
    [grants.map(([role]) => role), grants.map(([, key]) => key)]
  );

  await client.query(
    `INSERT INTO profiles (email, role)
     SELECT role_name || '@example.invalid', role_name
       FROM unnest($1::text[]) AS r(role_name)`,
    [[...BUILT_IN_ROLES, "auditor"]]
  );
  await client.query(
    `INSERT INTO profiles (email) VALUES ('default@example.invalid')`
  );
  // The old key would refuse this row, so it goes in with the keys switched
  // off. The backfill still has to give this person a membership, as a
  // Viewer.
  await client.query("BEGIN");
  await client.query("SET LOCAL session_replication_role = replica");
  await client.query(
    `INSERT INTO profiles (email, role)
     VALUES ('ghost@example.invalid', 'retired')`
  );
  await client.query("COMMIT");

  const connectionId = await insertId(
    client,
    `INSERT INTO connections (name, host, username, password)
     VALUES ('legacy', 'probe.invalid', 'probe', $1) RETURNING id`,
    [FAKE_PASSWORD]
  );
  await client.query(
    `INSERT INTO tracked_schemas (connection_id, schema_name)
     VALUES ($1, 'public')`,
    [connectionId]
  );
  await client.query(
    `INSERT INTO comparison_sets (name, source_connection_id, source_schema)
     VALUES ('Nightly', $1, 'public')`,
    [connectionId]
  );
  await client.query(
    `INSERT INTO role_changes (role, kind, feature, action, actor)
     VALUES ('editor', 'revoke', split_part($1, ':', 1),
             split_part($1, ':', 2), 'admin@example.invalid')`,
    [UNTICKED]
  );
}

// One row in every table that belongs to an organization, written straight to
// a database that already has organizations, so deleting the organization has
// something everywhere to delete. Each organization gets its own connection,
// set and tracked schema, so no two organizations' rows collide on the indexes
// that are unique across all of them. Returns the member's profile.
async function fillOrganization(
  client: Client,
  orgId: number
): Promise<number> {
  await client.query(
    `INSERT INTO roles (org_id, name, label)
     SELECT $1, name, label FROM unnest($2::text[], $3::text[]) AS r(name, label)
     ON CONFLICT DO NOTHING`,
    [
      orgId,
      [...BUILT_IN_ROLES],
      BUILT_IN_ROLES.map((role) => BUILT_IN_ROLE_INFO[role].label),
    ]
  );
  await client.query(
    `INSERT INTO role_permissions (org_id, role, feature, action)
     VALUES ($1, 'editor', 'connections', 'read') ON CONFLICT DO NOTHING`,
    [orgId]
  );
  const profileId = await insertId(
    client,
    `INSERT INTO profiles (email) VALUES ($1) RETURNING id`,
    [`member-${orgId}@example.invalid`]
  );
  await client.query(
    `INSERT INTO memberships (org_id, profile_id, role)
     VALUES ($1, $2, 'editor')`,
    [orgId, profileId]
  );

  const connectionId = await insertId(
    client,
    `INSERT INTO connections (org_id, name, host, username, password)
     VALUES ($1, 'probe', 'probe.invalid', 'probe', $2) RETURNING id`,
    [orgId, FAKE_PASSWORD]
  );
  const trackedId = await insertId(
    client,
    `INSERT INTO tracked_schemas (org_id, connection_id, schema_name)
     VALUES ($1, $2, 'probe_schema') RETURNING id`,
    [orgId, connectionId]
  );
  const snapshotId = await insertId(
    client,
    `INSERT INTO snapshots (org_id, tracked_schema_id, snapshot)
     VALUES ($1, $2, '{}') RETURNING id`,
    [orgId, trackedId]
  );
  await client.query(
    `INSERT INTO lineage_migrations
       (org_id, tracked_schema_id, seq, name, change_level, version,
        snapshot_id)
     VALUES ($1, $2, 1, 'probe', 'additive', '1.1.0', $3)`,
    [orgId, trackedId, snapshotId]
  );
  await client.query(
    `INSERT INTO drift_events
       (org_id, tracked_schema_id, status, baseline_snapshot_id)
     VALUES ($1, $2, 'in_sync', $3)`,
    [orgId, trackedId, snapshotId]
  );
  await client.query(
    `INSERT INTO schema_metrics (org_id, tracked_schema_id) VALUES ($1, $2)`,
    [orgId, trackedId]
  );
  await client.query(
    `INSERT INTO query_history
       (org_id, connection_id, schema_name, query_text, fingerprint,
        captured_by)
     VALUES ($1, $2, 'probe_schema', 'SELECT 1', 'probe',
             'probe@example.invalid')`,
    [orgId, connectionId]
  );
  await client.query(
    `INSERT INTO perf_thresholds
       (org_id, connection_id, schema_name, threshold_key, threshold_value,
        updated_by)
     VALUES ($1, $2, 'probe_schema', 'query_score', 50,
             'probe@example.invalid')`,
    [orgId, connectionId]
  );

  const setId = await insertId(
    client,
    `INSERT INTO comparison_sets
       (org_id, name, source_connection_id, source_schema)
     VALUES ($1, 'probe-set', $2, 'probe_schema') RETURNING id`,
    [orgId, connectionId]
  );
  await client.query(
    `INSERT INTO comparison_set_targets
       (org_id, set_id, "position", connection_id, schema_name)
     VALUES ($1, $2, 0, $3, 'probe_schema')`,
    [orgId, setId, connectionId]
  );
  await client.query(
    `INSERT INTO comparison_runs
       (org_id, set_id, source_connection_id, source_schema,
        target_connection_id, target_schema, ran_by, total_changes,
        breaking_changes, safe_changes, info_changes, fingerprint, findings)
     VALUES ($1, $2, $3, 'probe_schema', $3, 'probe_schema',
             'probe@example.invalid', 0, 0, 0, 0, 'probe', '[]')`,
    [orgId, setId, connectionId]
  );

  await client.query(
    `INSERT INTO deploy_approvals
       (org_id, connection_id, schema_name, script_name, target_version,
        run_fingerprint, migration_count, requested_by)
     VALUES ($1, $2, 'probe_schema', 'probe.sql', '1.1.0', 'probe', 1,
             'probe@example.invalid')`,
    [orgId, connectionId]
  );
  await client.query(
    `INSERT INTO deploy_attempts
       (org_id, connection_id, schema_name, outcome, http_status)
     VALUES ($1, $2, 'probe_schema', 'applied', 200)`,
    [orgId, connectionId]
  );
  // token_hash is unique across every organization, so each one's is its own.
  await client.query(
    `INSERT INTO invites
       (org_id, token_hash, kind, email, role, invited_by, expires_at)
     VALUES ($1, $2, 'email', $3, 'editor', $4, now() + interval '7 days')`,
    [orgId, `probe-${orgId}`, `invitee-${orgId}@example.invalid`, profileId]
  );
  await client.query(
    `INSERT INTO role_changes (org_id, role, kind, actor)
     VALUES ($1, 'editor', 'grant', 'probe@example.invalid')`,
    [orgId]
  );
  return profileId;
}

describeWithDatabase("org-migration", () => {
  beforeAll(async () => {
    savedEnv.DATABASE_URL_A = process.env.DATABASE_URL_A;
    savedEnv.SCHEMA_STUDIO_DESKTOP = process.env.SCHEMA_STUDIO_DESKTOP;

    baseName = decodeURIComponent(new URL(testUrl).pathname.slice(1));
    if (!/test/i.test(baseName)) {
      throw new Error(
        `TEST_DATABASE_URL names the database "${baseName}". ` +
          "This file creates and drops databases named after it, so it only runs " +
          `against a database whose name contains "test".`
      );
    }
    if (!UNTICKED) {
      throw new Error(
        "Editors' preset has no permission that viewers' lacks, so the legacy database " +
          "has no box to untick. Pick another permission for UNTICKED."
      );
    }

    server = await connectTo(testUrl);
    legacy = await legacyDatabase("legacy");
    await boot(legacy);
    fresh = await freshDatabase("fresh");
    await boot(fresh);
    desktopLegacy = await legacyDatabase("desktop_legacy");
    await boot(desktopLegacy, { desktop: true });
    desktopFresh = await freshDatabase("desktop_fresh");
    await boot(desktopFresh, { desktop: true });
  }, BASELINES);

  afterAll(async () => {
    for (const [name, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    if (!server) return;
    for (const name of made) {
      await server.query(
        `DROP DATABASE IF EXISTS ${quoteIdent(name)} WITH (FORCE)`
      );
    }
    await server.end();
  }, SLOW);

  describe("a database from before organizations", () => {
    let client: Client;
    let defaultId = 0;

    beforeAll(async () => {
      client = await connectTo(legacy);
      defaultId = await defaultOrgId(client);
    }, SLOW);

    afterAll(async () => {
      await client?.end();
    }, SLOW);

    test("gets one organization, the default, holding everything it had", async () => {
      expect(await organizationsIn(client)).toEqual([SWINBURNE]);
      expect(await rowsPerTable(client, defaultId)).toEqual(
        expectedLegacyRows()
      );
    }, SLOW);

    test("turns each profile's role into a membership", async () => {
      expect(await membershipsOf(client, defaultId)).toEqual(
        LEGACY_MEMBERSHIPS
      );
      const { rows: stillSet } = await client.query(
        `SELECT count(*)::int AS n FROM profiles WHERE role IS NOT NULL`
      );
      expect(stillSet).toEqual([{ n: 0 }]);
      const { rows: column } = await client.query(
        `SELECT is_nullable, column_default FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'profiles'
            AND column_name = 'role'`
      );
      expect(column).toEqual([{ is_nullable: "YES", column_default: null }]);
    }, SLOW);

    test("keeps every role's permissions as an admin left them", async () => {
      expect(await permissionsOf(client, defaultId, "viewer")).toEqual(
        [...VIEWER_PRESET].sort()
      );
      expect(await permissionsOf(client, defaultId, "editor")).toEqual(
        EDITOR_PRESET.filter((key) => key !== UNTICKED).sort()
      );
      expect(await permissionsOf(client, defaultId, "auditor")).toEqual([
        readKeyOf("drift"),
      ]);
      expect(await permissionsOf(client, defaultId, ADMIN_ROLE)).toEqual([]);
      // Still recorded as given once, so no later boot gives it back.
      const { rows } = await client.query(
        `SELECT preset_applied FROM roles WHERE org_id = $1 AND name = 'editor'`,
        [defaultId]
      );
      expect(rows[0].preset_applied).toContain(UNTICKED);
    }, SLOW);

    test("ends up the same shape as a new database, without the old keys", async () => {
      const shape = await shapeOf(client);
      expect(shape).toEqual(await withClient(fresh, shapeOf));
      const oldKeys = [
        "profiles_role_fkey",
        "role_permissions_role_fkey",
        "comparison_sets_name_key",
        "roles_label_key",
      ];
      expect(
        shape.filter((line) => oldKeys.some((key) => line.includes(key)))
      ).toEqual([]);
    }, SLOW);

    test("takes the kinds of change added since, which its old check left out", async () => {
      // Its check on role_changes.kind was made by an app that knew six kinds.
      // A boot that only adds the checks a database lacks would have left it
      // at those six, and every invitation and join would fail to be logged.
      // The shape test above says the same of the whole list; this one says it
      // of a row.
      const { rows } = await client.query<{ definition: string }>(
        `SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
          WHERE conname = 'role_changes_kind_check'`
      );
      for (const kind of ROLE_CHANGE_KINDS) {
        expect(rows[0].definition).toContain(`'${kind}'`);
      }
      await client.query("BEGIN");
      try {
        await client.query(
          `INSERT INTO role_changes (org_id, role, kind, actor)
           VALUES ($1, 'viewer', 'join', 'probe@example.invalid')`,
          [defaultId]
        );
      } finally {
        await client.query("ROLLBACK");
      }
    }, SLOW);

    // Last in this block, because it boots the database again.
    test("is left exactly as it was by a second boot", async () => {
      const before = [await shapeOf(client), await everyRow(client)];
      await boot(legacy);
      expect([await shapeOf(client), await everyRow(client)]).toEqual(before);
    }, SLOW);
  });

  describe("a new database", () => {
    test("gets the default organization with its built-in roles, and no members", async () => {
      await withClient(fresh, async (client) => {
        expect(await organizationsIn(client)).toEqual([SWINBURNE]);
        const defaultId = await defaultOrgId(client);
        expect(await rolesOf(client, defaultId)).toEqual(
          EXPECTED_BUILT_IN_ROLES
        );
        expect(await builtInPermissionsOf(client, defaultId)).toEqual(
          EXPECTED_BUILT_IN_PERMISSIONS
        );
        const { rows } = await client.query(
          `SELECT (SELECT count(*) FROM profiles)::int AS profiles,
                  (SELECT count(*) FROM memberships)::int AS memberships`
        );
        expect(rows).toEqual([{ profiles: 0, memberships: 0 }]);
      });
    }, SLOW);
  });

  describe("on the desktop", () => {
    test("makes the personal organization the default, and moves everything into it", async () => {
      await withClient(desktopFresh, async (client) => {
        expect(await organizationsIn(client)).toEqual([PERSONAL]);
      });
      await withClient(desktopLegacy, async (client) => {
        expect(await organizationsIn(client)).toEqual([PERSONAL]);
        const personalId = await defaultOrgId(client);
        expect(await rowsPerTable(client, personalId)).toEqual(
          expectedLegacyRows()
        );
        expect(await membershipsOf(client, personalId)).toEqual(
          LEGACY_MEMBERSHIPS
        );
      });
    }, SLOW);

    test("fills in org_id with it by default, and otherwise matches the web", async () => {
      const personalId = await withClient(desktopFresh, defaultOrgId);
      const desktop = await withClient(desktopFresh, shapeOf);
      expect(await withClient(desktopLegacy, shapeOf)).toEqual(desktop);
      const web = await withClient(fresh, shapeOf);
      expect(web.filter((line) => !desktop.includes(line))).toEqual(
        ORG_TABLES.map((table) => `column ${table}.org_id integer NO -`).sort()
      );
      expect(desktop.filter((line) => !web.includes(line))).toEqual(
        ORG_TABLES.map(
          (table) => `column ${table}.org_id integer NO ${personalId}`
        ).sort()
      );
    }, SLOW);
  });

  describe("organizations", () => {
    let client: Client;
    let defaultId = 0;
    let defaultProfile = 0;
    let probeId = 0;
    let probeProfile = 0;

    beforeAll(async () => {
      const url = await freshDatabase("orgs");
      await boot(url);
      client = await connectTo(url);
      defaultId = await defaultOrgId(client);
      defaultProfile = await fillOrganization(client, defaultId);
      probeId = await insertId(
        client,
        `INSERT INTO organizations (slug, name)
         VALUES ('probe-org', 'Probe Org') RETURNING id`
      );
      probeProfile = await fillOrganization(client, probeId);
    }, SLOW);

    afterAll(async () => {
      await client?.end();
    }, SLOW);

    test("own a column and a key on every table that holds their rows", async () => {
      const { rows: tables } = await client.query<{ name: string }>(
        `SELECT table_name::text AS name FROM information_schema.tables
          WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`
      );
      expect(tables.map((row) => row.name).sort()).toEqual(
        [...ORG_SCOPED, ...NOT_ORG_SCOPED].sort()
      );

      const { rows: columns } = await client.query<{ line: string }>(
        `SELECT table_name || ' ' || is_nullable AS line
           FROM information_schema.columns
          WHERE table_schema = 'public' AND column_name = 'org_id'`
      );
      expect(columns.map((row) => row.line).sort()).toEqual(
        ORG_SCOPED.map((table) => `${table} NO`).sort()
      );

      const { rows: keys } = await client.query<{
        name: string;
        keys: string[];
      }>(
        `SELECT conrelid::regclass::text AS name,
                array_agg(pg_get_constraintdef(oid) ORDER BY conname) AS keys
           FROM pg_constraint
          WHERE contype = 'f' AND confrelid = 'organizations'::regclass
          GROUP BY conrelid`
      );
      expect(Object.fromEntries(keys.map((row) => [row.name, row.keys]))).toEqual({
        ...Object.fromEntries(
          ORG_SCOPED.map((table) => [
            table,
            ["FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE"],
          ])
        ),
        // The organization each person used last, for the old addresses that
        // name none. Forgotten, not followed, when the organization goes.
        profiles: ["FOREIGN KEY (last_org_id) REFERENCES organizations(id) ON DELETE SET NULL"],
      });
    }, SLOW);

    test("refuse to delete a role somebody holds", async () => {
      await rolledBack(client, async () => {
        await expect(
          client.query(
            `DELETE FROM roles WHERE org_id = $1 AND name = 'editor'`,
            [probeId]
          )
        ).rejects.toMatchObject({
          code: "23503",
          constraint: "memberships_org_id_role_fkey",
        });
      });
    }, SLOW);

    test("delete a role nobody holds, and its permissions with it", async () => {
      await rolledBack(client, async () => {
        await client.query(
          `INSERT INTO roles (org_id, name, label)
           VALUES ($1, 'probe-role', 'Probe Role')`,
          [probeId]
        );
        await client.query(
          `INSERT INTO role_permissions (org_id, role, feature, action)
           VALUES ($1, 'probe-role', 'drift', 'read')`,
          [probeId]
        );
        expect(await permissionsOf(client, probeId, "probe-role")).toEqual([
          "drift:read",
        ]);
        await client.query(
          `DELETE FROM roles WHERE org_id = $1 AND name = 'probe-role'`,
          [probeId]
        );
        expect(await permissionsOf(client, probeId, "probe-role")).toEqual([]);
      });
    }, SLOW);

    test("carry a renamed role's members and permissions along, in its org alone", async () => {
      const defaults = await orgRoleRows(client, defaultId);
      await rolledBack(client, async () => {
        await client.query(
          `UPDATE roles SET name = 'editor-two'
            WHERE org_id = $1 AND name = 'editor'`,
          [probeId]
        );
        const { rows } = await client.query(
          `SELECT role FROM memberships WHERE org_id = $1`,
          [probeId]
        );
        expect(rows).toEqual([{ role: "editor-two" }]);
        expect(await permissionsOf(client, probeId, "editor-two")).toEqual([
          "connections:read",
        ]);
        expect(await orgRoleRows(client, defaultId)).toEqual(defaults);
      });
    }, SLOW);

    test("lose a member whose profile is deleted, and nothing else", async () => {
      const before = await rowsPerTable(client, probeId);
      await rolledBack(client, async () => {
        await client.query(`DELETE FROM profiles WHERE id = $1`, [
          probeProfile,
        ]);
        expect(await rowsPerTable(client, probeId)).toEqual({
          ...before,
          memberships: {
            ...before.memberships,
            mine: before.memberships.mine - 1,
          },
        });
      });
    }, SLOW);

    test("keep role names and labels unique inside each one, not across them", async () => {
      await rolledBack(client, async () => {
        await client.query(
          `INSERT INTO roles (org_id, name, label)
           VALUES ($1, 'qa', 'QA'), ($2, 'qa', 'QA')`,
          [defaultId, probeId]
        );
        await expect(
          client.query(
            `INSERT INTO roles (org_id, name, label)
             VALUES ($1, 'qa', 'Quality')`,
            [probeId]
          )
        ).rejects.toMatchObject({ code: "23505", constraint: "roles_pkey" });
      });
      await rolledBack(client, async () => {
        await client.query(
          `INSERT INTO roles (org_id, name, label) VALUES ($1, 'qa', 'QA')`,
          [probeId]
        );
        await expect(
          client.query(
            `INSERT INTO roles (org_id, name, label)
             VALUES ($1, 'qa-two', 'qa')`,
            [probeId]
          )
        ).rejects.toMatchObject({
          code: "23505",
          constraint: "roles_org_label_key",
        });
      });
    }, SLOW);

    test("keep saved set names unique inside each one, not across them", async () => {
      const { rows } = await client.query(
        `SELECT count(*)::int AS n FROM comparison_sets WHERE name = 'probe-set'`
      );
      expect(rows).toEqual([{ n: 2 }]);
      await rolledBack(client, async () => {
        await expect(
          client.query(
            `INSERT INTO comparison_sets (org_id, name, source_schema)
             VALUES ($1, 'PROBE-SET', 'probe_schema')`,
            [probeId]
          )
        ).rejects.toMatchObject({
          code: "23505",
          constraint: "comparison_sets_org_name_key",
        });
      });
    }, SLOW);

    test("only let a member hold a role from the same organization", async () => {
      await rolledBack(client, async () => {
        await client.query(
          `INSERT INTO roles (org_id, name, label)
           VALUES ($1, 'only-here', 'Only Here')`,
          [defaultId]
        );
        await expect(
          client.query(
            `INSERT INTO memberships (org_id, profile_id, role)
             VALUES ($1, $2, 'only-here')`,
            [probeId, defaultProfile]
          )
        ).rejects.toMatchObject({
          code: "23503",
          constraint: "memberships_org_id_role_fkey",
        });
      });
    }, SLOW);

    test("need an address-safe slug of their own, and one default at most", async () => {
      await rolledBack(client, async () => {
        await expect(
          client.query(
            `INSERT INTO organizations (slug, name) VALUES ('Bad Slug', 'Bad')`
          )
        ).rejects.toMatchObject({
          code: "23514",
          constraint: "organizations_slug_check",
        });
      });
      await rolledBack(client, async () => {
        await expect(
          client.query(
            `INSERT INTO organizations (slug, name)
             VALUES ('probe-org', 'Probe Again')`
          )
        ).rejects.toMatchObject({
          code: "23505",
          constraint: "organizations_slug_key",
        });
      });
      await rolledBack(client, async () => {
        await expect(
          client.query(
            `INSERT INTO organizations (slug, name, is_default)
             VALUES ('second-default', 'Second', true)`
          )
        ).rejects.toMatchObject({
          code: "23505",
          constraint: "organizations_one_default_idx",
        });
      });
    }, SLOW);

    // Last in this block, because it is not rolled back.
    test("take exactly their own rows with them when deleted", async () => {
      const before = await rowsPerTable(client, probeId);
      // Every table needs rows on both sides, or this proves nothing about it.
      expect(
        Object.entries(before).filter(
          ([, count]) => count.mine === 0 || count.others === 0
        )
      ).toEqual([]);

      await client.query(`DELETE FROM organizations WHERE id = $1`, [probeId]);
      expect(await rowsPerTable(client, probeId)).toEqual(
        Object.fromEntries(
          Object.entries(before).map(([table, { others }]) => [
            table,
            { mine: 0, others },
          ])
        )
      );
      // People are not an organization's to delete: a member keeps their
      // profile, and only loses the membership.
      const { rows } = await client.query(
        `SELECT count(*)::int AS n FROM profiles WHERE id = $1`,
        [probeProfile]
      );
      expect(rows).toEqual([{ n: 1 }]);
    }, SLOW);
  });

  // The tests in this block run in order, each starting from where the last
  // one left the database.
  describe("built-in roles on later boots", () => {
    let url = "";
    let client: Client;
    let defaultId = 0;
    let secondId = 0;

    beforeAll(async () => {
      url = await freshDatabase("due");
      await boot(url);
      client = await connectTo(url);
      defaultId = await defaultOrgId(client);
    }, SLOW);

    afterAll(async () => {
      await client?.end();
    }, SLOW);

    test("reach an organization that has none, and leave the rest alone", async () => {
      const defaults = await orgRoleRows(client, defaultId);
      secondId = await insertId(
        client,
        `INSERT INTO organizations (slug, name)
         VALUES ('second-org', 'Second Org') RETURNING id`
      );
      expect(await bootCountingClients(url)).toBe(2);
      expect(await rolesOf(client, secondId)).toEqual(EXPECTED_BUILT_IN_ROLES);
      expect(await builtInPermissionsOf(client, secondId)).toEqual(
        EXPECTED_BUILT_IN_PERMISSIONS
      );
      expect(await orgRoleRows(client, defaultId)).toEqual(defaults);
    }, SLOW);

    test("give a role its preset's new permission once, leaving unticked boxes alone", async () => {
      // The default organization as an older build would have left it, before
      // the catalogue gained the viewers' first permission: no row for it, and
      // not recorded as given. Its editors are missing a box too, but one that
      // was given and then unticked.
      const added = VIEWER_PRESET[0];
      await client.query(
        `UPDATE roles SET preset_applied = preset_applied - $2::text
          WHERE org_id = $1 AND name = 'viewer'`,
        [defaultId, added]
      );
      const viewerRow = await client.query(
        `DELETE FROM role_permissions
          WHERE org_id = $1 AND role = 'viewer'
            AND feature || ':' || action = $2`,
        [defaultId, added]
      );
      expect(viewerRow.rowCount).toBe(1);
      const editorRow = await client.query(
        `DELETE FROM role_permissions
          WHERE org_id = $1 AND role = 'editor'
            AND feature || ':' || action = $2`,
        [defaultId, UNTICKED]
      );
      expect(editorRow.rowCount).toBe(1);
      const second = await orgRoleRows(client, secondId);
      expect(second).not.toEqual([]);

      expect(await bootCountingClients(url)).toBe(2);
      expect(await permissionsOf(client, defaultId, "viewer")).toEqual(
        [...VIEWER_PRESET].sort()
      );
      expect(await permissionsOf(client, defaultId, "editor")).toEqual(
        EDITOR_PRESET.filter((key) => key !== UNTICKED).sort()
      );
      const { rows } = await client.query(
        `SELECT preset_applied FROM roles WHERE org_id = $1 AND name = 'viewer'`,
        [defaultId]
      );
      expect([...rows[0].preset_applied].sort()).toEqual(
        [...VIEWER_PRESET].sort()
      );
      expect(await orgRoleRows(client, secondId)).toEqual(second);

      // Given once: the next boot finds nothing due.
      expect(await bootCountingClients(url)).toBe(1);
      expect(await permissionsOf(client, defaultId, "viewer")).toEqual(
        [...VIEWER_PRESET].sort()
      );
    }, SLOW);

    test("are not made due by whatever Admin's preset_applied holds", async () => {
      // Admin has no preset, so nothing ever writes its preset_applied. A value
      // somebody wrote there by hand must not make every boot find the
      // organization due.
      for (const value of ["{}", '"x"', "null"]) {
        await client.query(
          `UPDATE roles SET preset_applied = $2::jsonb
            WHERE org_id = $1 AND name = $3`,
          [defaultId, value, ADMIN_ROLE]
        );
        const rows = await everyRow(client);
        expect([value, await bootCountingClients(url)]).toEqual([value, 1]);
        expect(await everyRow(client)).toEqual(rows);
      }
    }, SLOW);
  });

  describe("booting", () => {
    // A database's shape and rows, leaving out the times they were written.
    function contents(url: string): Promise<string[][]> {
      return withClient(url, async (client) => [
        await shapeOf(client),
        await everyRow(client, { times: false }),
      ]);
    }

    test("twice at once ends up where booting once does", async () => {
      const once = await legacyDatabase("race_once");
      await boot(once);

      const twice = await legacyDatabase("race_twice");
      const first = await load(twice);
      const second = await load(twice);
      try {
        await Promise.all([
          first.syncMetadataTables(),
          second.syncMetadataTables(),
        ]);
      } finally {
        await Promise.all([first.close(), second.close()]);
      }
      expect(await contents(twice)).toEqual(await contents(once));
    }, SLOW);

    test("widens a list check to what the app knows, and never narrows it", async () => {
      const url = await freshDatabase("lists");
      await boot(url);
      const definition = () =>
        withClient(url, async (client) => {
          const { rows } = await client.query<{ definition: string }>(
            `SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
              WHERE conname = 'role_changes_kind_check'`
          );
          return rows[0].definition;
        });
      const allow = (kinds: readonly string[]) =>
        withClient(url, (client) =>
          client.query(
            `ALTER TABLE role_changes
               DROP CONSTRAINT role_changes_kind_check,
               ADD CONSTRAINT role_changes_kind_check
                 CHECK (kind IN (${kinds.map((kind) => `'${kind}'`).join(", ")}))`
          )
        );

      // As a newer build would leave it: everything this one knows, and a kind
      // it has never heard of. There is nothing to add, so the check is left
      // exactly as it was, and the newer build's rows still fit.
      await allow([...ROLE_CHANGE_KINDS, "from-a-newer-build"]);
      const newer = await definition();
      await boot(url);
      expect(await definition()).toBe(newer);

      // As an older build would leave it after a newer one had been at it: the
      // kinds added since are missing. They are added, and the unknown one
      // stays.
      await allow([...ROLE_CHANGE_KINDS.slice(0, 6), "from-a-newer-build"]);
      await boot(url);
      const widened = await definition();
      for (const kind of [...ROLE_CHANGE_KINDS, "from-a-newer-build"]) {
        expect(widened).toContain(`'${kind}'`);
      }
    }, SLOW);

    test("stops, saying how to fix it, when another org holds the default's address", async () => {
      const taken = await freshDatabase("taken");
      await boot(taken);
      await withClient(taken, (client) =>
        client.query(`UPDATE organizations SET is_default = false`)
      );

      await expect(boot(taken)).rejects.toThrow(
        /belongs to another organization/
      );
      await withClient(taken, async (client) => {
        const { rows } = await client.query(`SELECT slug FROM organizations`);
        expect(rows).toEqual([{ slug: "swinburne-fyp" }]);
        // What the error says to do.
        await client.query(
          `UPDATE organizations SET is_default = true
            WHERE slug = 'swinburne-fyp'`
        );
      });
      await expect(boot(taken)).resolves.toBeUndefined();
    }, SLOW);
  });

  // Signing in is how people get an account. resolveIdentity, which auth.ts
  // calls when someone signs in, finds the person by the account they signed
  // in with, and findMembership is how every request after that finds them
  // again, by their profile ID, in the organization the request names. On the
  // web nobody joins an organization just by signing in, except the first
  // person from the home tenant on a new deployment. The tests in this block
  // run in order, each starting from where the last one left the database.
  describe("signing in", () => {
    let url = "";
    let app: RequestApp;
    let client: Client;
    let defaultId = 0;
    let firstId = 0;
    let secondId = 0;
    let octoId = 0;
    let guestId = 0;

    beforeAll(async () => {
      url = await freshDatabase("signin");
      app = await loadRequestApp(url);
      await app.syncMetadataTables();
      client = await connectTo(url);
      defaultId = await defaultOrgId(client);
    }, SLOW);

    afterAll(async () => {
      await client?.end();
      await app?.close();
    }, SLOW);

    // Every profile row for an address, whatever its case.
    async function profilesFor(email: string) {
      const { rows } = await client.query<{
        id: number;
        name: string | null;
        last_seen_at: Date | null;
      }>(
        `SELECT id, name, last_seen_at FROM profiles WHERE lower(email) = lower($1)`,
        [email]
      );
      return rows;
    }

    // A membership in the default organization, as the lookups return it.
    function inDefault(role: string) {
      return {
        orgId: defaultId,
        slug: "swinburne-fyp",
        name: "Swinburne FYP",
        isDefault: true,
        twoPersonRule: true,
        role,
      };
    }

    test("gives a new deployment to the first person from the home tenant, and to nobody from anywhere else", async () => {
      // Anyone at all can sign in with GitHub or a Microsoft account from
      // another organization, so neither is handed the default organization,
      // even while it has nobody in it.
      octoId = await signedIn(app, github(583231, "octo@example.invalid"));
      guestId = await signedIn(app, guest("guest@other.invalid", "oid-guest", true));
      expect(await membershipsOf(client, defaultId)).toEqual({});

      const first = await app.resolveIdentity(
        microsoft("First@Example.invalid", "oid-first", "First Person")
      );
      expect(first).toEqual({
        kind: "ok",
        profileId: expect.any(Number),
        email: "first@example.invalid",
      });
      firstId = first.kind === "ok" ? first.profileId : 0;
      expect(await identitiesOf(client, firstId)).toEqual([
        {
          provider: "microsoft",
          subject: `${HOME_TENANT}:oid-first`,
          email: "first@example.invalid",
          email_verified: true,
        },
      ]);
      expect(await membershipsOf(client, defaultId)).toEqual({
        "first@example.invalid": "admin",
      });
      // The lookup every request makes, and the one the desktop makes for a
      // request that names no organization.
      const member = {
        ...inDefault("admin"),
        email: "first@example.invalid",
        personName: "First Person",
      };
      expect(await app.orgs.findMembership(firstId, "swinburne-fyp")).toEqual(member);
      expect(await app.orgs.findDefaultMembership(firstId)).toEqual(member);
      expect(await app.orgs.listMemberships(firstId)).toEqual([inDefault("admin")]);
    }, SLOW);

    test("lets nobody else in just by signing in", async () => {
      secondId = await signedIn(app, microsoft("second@example.invalid", "oid-second"));
      expect(await signedIn(app, github(583231, "octo@example.invalid"))).toBe(octoId);
      expect(await membershipsOf(client, defaultId)).toEqual({
        "first@example.invalid": "admin",
      });
      // They are signed in and belong nowhere, which is what sends them to
      // /onboarding to make an organization or open an invitation.
      for (const profileId of [secondId, octoId, guestId]) {
        expect(await app.orgs.listMemberships(profileId)).toEqual([]);
        expect(await app.orgs.findLastOrganization(profileId)).toBeNull();
        expect(await app.orgs.findDefaultMembership(profileId)).toBeNull();
      }
      expect(await identitiesOf(client, octoId)).toEqual([
        {
          provider: "github",
          subject: "583231",
          email: "octo@example.invalid",
          email_verified: true,
        },
      ]);
    }, SLOW);

    test("finds a returning account by its ID, whatever address it reports today", async () => {
      await client.query(
        `UPDATE profiles SET last_seen_at = '2000-01-01T00:00:00Z' WHERE id = $1`,
        [firstId]
      );
      // A new address and no name. The person keeps the address the app knows
      // them by, and a provider that leaves the name out must not wipe the one
      // already stored.
      expect(
        await app.resolveIdentity(microsoft("first.renamed@example.invalid", "oid-first"))
      ).toEqual({ kind: "ok", profileId: firstId, email: "first@example.invalid" });
      const [after] = await profilesFor("first@example.invalid");
      expect(after).toMatchObject({ id: firstId, name: "First Person" });
      expect(after.last_seen_at?.getTime()).toBeGreaterThan(
        Date.parse("2000-01-02T00:00:00Z")
      );
      expect(await profilesFor("first.renamed@example.invalid")).toEqual([]);
      // The account's own row does follow the address, for whoever reads it.
      expect(await identitiesOf(client, firstId)).toMatchObject([
        { email: "first.renamed@example.invalid" },
      ]);

      // A name it does send replaces the stored one.
      await signedIn(app, microsoft("first@example.invalid", "oid-first", "First P. Person"));
      expect((await profilesFor("first@example.invalid"))[0].name).toBe("First P. Person");

      // An account seen before is that person even when its provider no longer
      // vouches for the address it reports: the account is what was checked,
      // when it was first linked.
      expect(await app.resolveIdentity(github(583231, "octo@new.invalid", false))).toEqual({
        kind: "ok",
        profileId: octoId,
        email: "octo@example.invalid",
      });
      expect(await membershipsOf(client, defaultId)).toEqual({
        "first@example.invalid": "admin",
      });
    }, SLOW);

    test("keeps the role somebody was given since, whoever signs in", async () => {
      // As an invitation will.
      await client.query(
        `INSERT INTO memberships (org_id, profile_id, role) VALUES ($1, $2, 'editor')`,
        [defaultId, secondId]
      );
      await signedIn(app, microsoft("second@example.invalid", "oid-second"));
      await signedIn(app, microsoft("first@example.invalid", "oid-first"));
      expect(await membershipsOf(client, defaultId)).toEqual({
        "first@example.invalid": "admin",
        "second@example.invalid": "editor",
      });
    }, SLOW);

    test("links a person from before accounts to their home-tenant account, and to no other", async () => {
      // As a database from before accounts were recorded holds them: a person
      // and their role, signed in by address, with no account linked, and an
      // address in whatever case it was written.
      const legacyId = await insertId(
        client,
        `INSERT INTO profiles (email) VALUES ('Legacy.Person@Example.invalid') RETURNING id`
      );
      await client.query(
        `INSERT INTO memberships (org_id, profile_id, role) VALUES ($1, $2, 'viewer')`,
        [defaultId, legacyId]
      );

      expect(
        await app.resolveIdentity(
          microsoft("legacy.person@example.invalid", "oid-legacy", "Legacy Person")
        )
      ).toEqual({ kind: "ok", profileId: legacyId, email: "Legacy.Person@Example.invalid" });
      expect(await identitiesOf(client, legacyId)).toEqual([
        {
          provider: "microsoft",
          subject: `${HOME_TENANT}:oid-legacy`,
          email: "legacy.person@example.invalid",
          email_verified: true,
        },
      ]);
      expect(await app.orgs.findMembership(legacyId, "swinburne-fyp")).toEqual({
        ...inDefault("viewer"),
        email: "Legacy.Person@Example.invalid",
        personName: "Legacy Person",
      });

      // Once linked, nothing else gets in on that address: not a second
      // account in the home tenant, and not an account elsewhere.
      expect(
        await app.resolveIdentity(microsoft("LEGACY.person@example.invalid", "oid-impostor"))
      ).toEqual({ kind: "taken" });
      expect(
        await app.resolveIdentity(github(1, "legacy.person@example.invalid"))
      ).toEqual({ kind: "taken" });
      expect(await identitiesOf(client, legacyId)).toHaveLength(1);
    }, SLOW);

    test("turns away any other account that reports an address somebody here has", async () => {
      const count = async () => {
        const { rows } = await client.query(
          `SELECT (SELECT count(*)::int FROM profiles) AS profiles,
                  (SELECT count(*)::int FROM identities) AS identities`
        );
        return rows[0];
      };
      const before = await count();
      // Each would be someone signing in as first@ or octo@ because they put
      // that address on an account of their own: a GitHub account, an account
      // in another organization's tenant whose admin vouches for it, and a
      // second account in the home tenant for somebody who already has one.
      for (const who of [
        github(2, "first@example.invalid"),
        guest("first@example.invalid", "oid-guest-2", true),
        microsoft("octo@example.invalid", "oid-octo"),
      ]) {
        expect(await app.resolveIdentity(who)).toEqual({ kind: "taken" });
      }
      expect(await count()).toEqual(before);
    }, SLOW);

    test("makes no account for an address nobody vouches for, taken or not", async () => {
      // The same answer whether or not the address is somebody's here, so
      // trying addresses never shows which ones are.
      for (const who of [
        github(4, "unchecked@example.invalid", false),
        guest("unchecked@example.invalid", "oid-unchecked", false),
        github(5, "first@example.invalid", false),
      ]) {
        expect(await app.resolveIdentity(who)).toEqual({ kind: "unverified" });
      }
      expect(await profilesFor("unchecked@example.invalid")).toEqual([]);
      const { rows } = await client.query(
        `SELECT subject FROM identities WHERE subject IN ('4', '5', $1)`,
        [`${OTHER_TENANT}:oid-unchecked`]
      );
      expect(rows).toEqual([]);
    }, SLOW);

    test("finds people only in the organizations they belong to", async () => {
      const elsewhere = await insertId(
        client,
        `INSERT INTO organizations (slug, name) VALUES ('elsewhere', 'Elsewhere') RETURNING id`
      );
      // No boot runs after this to give the new organization its built-in
      // roles, and a membership has to name one of its roles.
      await client.query(
        `INSERT INTO roles (org_id, name, label) VALUES ($1, 'viewer', 'Viewer')`,
        [elsewhere]
      );
      await client.query(
        `INSERT INTO memberships (org_id, profile_id, role) VALUES ($1, $2, 'viewer')`,
        [elsewhere, octoId]
      );
      const inElsewhere = {
        orgId: elsewhere,
        slug: "elsewhere",
        name: "Elsewhere",
        isDefault: false,
        twoPersonRule: true,
        role: "viewer",
      };

      // The gates find them in their own organization, and in no other.
      expect(await app.orgs.findMembership(octoId, "elsewhere")).toEqual({
        ...inElsewhere,
        email: "octo@example.invalid",
        personName: null,
      });
      expect(await app.orgs.findMembership(octoId, "swinburne-fyp")).toBeNull();
      expect(await app.orgs.findDefaultMembership(octoId)).toBeNull();
      expect(await app.orgs.listMemberships(octoId)).toEqual([inElsewhere]);
      // Nor does anyone else turn up there.
      expect(await app.orgs.findMembership(firstId, "elsewhere")).toBeNull();

      // Someone in two is listed in both, by name, for the switcher.
      await client.query(
        `INSERT INTO memberships (org_id, profile_id, role) VALUES ($1, $2, 'viewer')`,
        [elsewhere, firstId]
      );
      try {
        expect(await app.orgs.listMemberships(firstId)).toEqual([
          inElsewhere,
          inDefault("admin"),
        ]);
      } finally {
        await client.query(
          `DELETE FROM memberships WHERE org_id = $1 AND profile_id = $2`,
          [elsewhere, firstId]
        );
      }
    }, SLOW);

    test("finds an organization by its slug, and nothing for a slug no organization could have", async () => {
      expect(await app.orgs.findOrganization("swinburne-fyp")).toEqual({
        id: defaultId,
        slug: "swinburne-fyp",
        name: "Swinburne FYP",
        isDefault: true,
        twoPersonRule: true,
      });
      expect(await app.orgs.findOrganization("elsewhere")).toMatchObject({
        slug: "elsewhere",
        isDefault: false,
      });
      expect(await app.orgs.findOrganization("nobody-has-this")).toBeNull();
      // Answered without asking the database, but the same answer it would give.
      for (const slug of ["Swinburne-FYP", "x", "studio", "swinburne-fyp/", ""]) {
        expect(await app.orgs.findOrganization(slug)).toBeNull();
        expect(await app.orgs.findMembership(firstId, slug)).toBeNull();
      }
    }, SLOW);

    test("remembers the organization someone used last, for addresses that name none", async () => {
      const elsewhere = (await app.orgs.findOrganization("elsewhere"))?.id ?? 0;
      // Nothing remembered yet: the default organization when they are in it,
      // or else the one they joined first.
      expect(await app.orgs.findLastOrganization(firstId)).toBe("swinburne-fyp");
      expect(await app.orgs.findLastOrganization(octoId)).toBe("elsewhere");
      // Someone in no organization has nowhere to go.
      expect(await app.orgs.findLastOrganization(guestId)).toBeNull();

      await client.query(
        `INSERT INTO memberships (org_id, profile_id, role) VALUES ($1, $2, 'viewer')`,
        [elsewhere, firstId]
      );
      try {
        // Joining another organization does not move them out of the default.
        expect(await app.orgs.findLastOrganization(firstId)).toBe("swinburne-fyp");
        await app.orgs.rememberLastOrganization(firstId, elsewhere);
        expect(await app.orgs.findLastOrganization(firstId)).toBe("elsewhere");

        // Remembered, but no longer a member: back to the default, never into
        // an organization they have left.
        await client.query(
          `DELETE FROM memberships WHERE org_id = $1 AND profile_id = $2`,
          [elsewhere, firstId]
        );
        expect(await app.orgs.findLastOrganization(firstId)).toBe("swinburne-fyp");
      } finally {
        await client.query(
          `DELETE FROM memberships WHERE org_id = $1 AND profile_id = $2`,
          [elsewhere, firstId]
        );
        await client.query(`UPDATE profiles SET last_org_id = NULL WHERE id = $1`, [firstId]);
      }

      // An organization that goes takes the memory of it with it.
      await rolledBack(client, async () => {
        await client.query(`UPDATE profiles SET last_org_id = $1 WHERE id = $2`, [elsewhere, firstId]);
        await client.query(`DELETE FROM organizations WHERE id = $1`, [elsewhere]);
        const { rows } = await client.query(`SELECT last_org_id FROM profiles WHERE id = $1`, [firstId]);
        expect(rows).toEqual([{ last_org_id: null }]);
      });
    }, SLOW);

    test("settles two sign-ins of one new account at the same moment as one person", async () => {
      // The lock lines the two up where they meet. The first makes the person
      // and then waits for the table to link its account; the second waits on
      // the first's person, since it has the same address. Once the lock goes
      // the first finishes, and the second finds the person it made and starts
      // over, finding the account this time.
      const holder = await connectTo(url);
      let signIns: Promise<Resolved>[] = [];
      try {
        await holder.query("BEGIN");
        await holder.query("LOCK TABLE identities IN SHARE MODE");
        signIns = [1, 2].map(() => app.resolveIdentity(github(777, "twin@example.invalid")));
        await waitForLockWaits(client, 2);
        await holder.query("COMMIT");
        const [one, two] = await Promise.all(signIns);
        expect(one).toEqual({
          kind: "ok",
          profileId: expect.any(Number),
          email: "twin@example.invalid",
        });
        expect(two).toEqual(one);
      } finally {
        await holder.end();
        await Promise.allSettled(signIns);
      }
      expect(await profilesFor("twin@example.invalid")).toHaveLength(1);
      const { rows } = await client.query(
        `SELECT count(*)::int AS n FROM identities WHERE provider = 'github' AND subject = '777'`
      );
      expect(rows).toEqual([{ n: 1 }]);
    }, SLOW);

    test("links only one of two accounts that claim one person at the same moment", async () => {
      // Two home-tenant accounts with one person's address, as two accounts
      // for one person, or one made to look like them, would have. The first
      // holds the person and waits for the table to link its account; the
      // second waits for the person, and finds them taken once it has them.
      const contestedId = await insertId(
        client,
        `INSERT INTO profiles (email) VALUES ('contested@example.invalid') RETURNING id`
      );
      const holder = await connectTo(url);
      let signIns: Promise<Resolved>[] = [];
      try {
        await holder.query("BEGIN");
        await holder.query("LOCK TABLE identities IN SHARE MODE");
        signIns = ["oid-claim-a", "oid-claim-b"].map((oid) =>
          app.resolveIdentity(microsoft("contested@example.invalid", oid))
        );
        await waitForLockWaits(client, 2);
        await holder.query("COMMIT");
        const results = await Promise.all(signIns);
        expect(results.map((result) => result.kind).sort()).toEqual(["ok", "taken"]);
        expect(results).toContainEqual({
          kind: "ok",
          profileId: contestedId,
          email: "contested@example.invalid",
        });
      } finally {
        await holder.end();
        await Promise.allSettled(signIns);
      }
      expect(await identitiesOf(client, contestedId)).toHaveLength(1);
    }, SLOW);

    test("makes exactly one admin when five people from the home tenant sign in to a new deployment at once", async () => {
      expect(await rolesAfterFiveSignIns({ desktop: false })).toEqual(["admin"]);
    }, SLOW);
  });

  // The desktop app signs in only accounts from the home tenant, and its
  // default organization is the one person's own (the personal one). The
  // first to sign in becomes its admin, and anyone after them a viewer: a
  // restored backup already has its admin. The tests in this block run in
  // order, each starting from where the last one left the database.
  describe("signing in on the desktop", () => {
    let app: RequestApp;
    let client: Client;
    let defaultId = 0;
    let ownerId = 0;

    beforeAll(async () => {
      const url = await freshDatabase("signin_desktop");
      app = await loadRequestApp(url, { desktop: true });
      await app.syncMetadataTables();
      client = await connectTo(url);
      defaultId = await defaultOrgId(client);
    }, SLOW);

    afterAll(async () => {
      await client?.end();
      await app?.close();
      // load() set it, and accounts-db reads it on every sign-in, so it must
      // not outlive this block.
      delete process.env.SCHEMA_STUDIO_DESKTOP;
    }, SLOW);

    test("makes the first person the admin and the next a viewer, and keeps a role given since", async () => {
      ownerId = await signedIn(app, microsoft("owner@example.invalid", "oid-owner"));
      const helperId = await signedIn(app, microsoft("helper@example.invalid", "oid-helper"));
      expect(await membershipsOf(client, defaultId)).toEqual({
        "owner@example.invalid": "admin",
        "helper@example.invalid": "viewer",
      });
      expect(await app.orgs.findDefaultMembership(ownerId)).toMatchObject({
        slug: PERSONAL.slug,
        isDefault: true,
        role: "admin",
      });

      await client.query(
        `UPDATE memberships SET role = 'editor' WHERE org_id = $1 AND profile_id = $2`,
        [defaultId, helperId]
      );
      await signedIn(app, microsoft("helper@example.invalid", "oid-helper"));
      await signedIn(app, microsoft("owner@example.invalid", "oid-owner"));
      expect(await membershipsOf(client, defaultId)).toEqual({
        "owner@example.invalid": "admin",
        "helper@example.invalid": "editor",
      });
    }, SLOW);

    test("leaves someone who belongs to another organization where they are", async () => {
      const elsewhere = await insertId(
        client,
        `INSERT INTO organizations (slug, name) VALUES ('elsewhere', 'Elsewhere') RETURNING id`
      );
      await client.query(
        `INSERT INTO roles (org_id, name, label) VALUES ($1, 'viewer', 'Viewer')`,
        [elsewhere]
      );
      const profileId = await insertId(
        client,
        `INSERT INTO profiles (email) VALUES ('elsewhere@example.invalid') RETURNING id`
      );
      await client.query(
        `INSERT INTO memberships (org_id, profile_id, role) VALUES ($1, $2, 'viewer')`,
        [elsewhere, profileId]
      );

      expect(await signedIn(app, microsoft("elsewhere@example.invalid", "oid-elsewhere"))).toBe(
        profileId
      );
      expect(await app.orgs.listMemberships(profileId)).toEqual([
        {
          orgId: elsewhere,
          slug: "elsewhere",
          name: "Elsewhere",
          isDefault: false,
          twoPersonRule: true,
          role: "viewer",
        },
      ]);
    }, SLOW);

    test("signs someone in when there is no default, and adds them once there is", async () => {
      // As if somebody cleared the flag by hand. This app booted already and
      // remembers it, so it does not boot again; a server starting now would
      // stop instead, as the "booting" tests show.
      await client.query(`UPDATE organizations SET is_default = false WHERE id = $1`, [defaultId]);
      let orphanId = 0;
      try {
        expect(await app.orgs.findDefaultOrganization()).toBeNull();
        orphanId = await signedIn(app, microsoft("orphan@example.invalid", "oid-orphan"));
        expect(await app.orgs.listMemberships(orphanId)).toEqual([]);
        // The desktop, which asks for the default, finds nobody either.
        expect(await app.orgs.findDefaultMembership(ownerId)).toBeNull();
      } finally {
        await client.query(`UPDATE organizations SET is_default = true WHERE id = $1`, [defaultId]);
      }

      // Once the default is back, signing in again adds them like anyone else.
      expect(await signedIn(app, microsoft("orphan@example.invalid", "oid-orphan"))).toBe(orphanId);
      expect(await membershipsOf(client, defaultId)).toMatchObject({
        "orphan@example.invalid": "viewer",
      });
    }, SLOW);

    test("makes exactly one admin when five people sign in to a new install at once", async () => {
      expect(await rolesAfterFiveSignIns({ desktop: true })).toEqual([
        "admin",
        "viewer",
        "viewer",
        "viewer",
        "viewer",
      ]);
    }, SLOW);
  });

  // Every organization has roles of its own: the same three built in, and
  // whatever its admins add. Two organizations holding the same built-in
  // roles, and a custom role made in both under one name, mean a query that
  // forgets its org_id shows up as a wrong count, a missing row or a change
  // made in the wrong place. The tests in this block run in order, each
  // starting from where the last one left the database.
  describe("roles in each organization", () => {
    const actor = "admin@example.invalid";
    // A box editors have that is not a Read. Unticking a Read is undone while
    // the role holds anything else in that feature (see effectivePermissions
    // in lib/permissions.ts), so a Read would not stay dropped.
    const DROPPED = EDITOR_PRESET.find((key) => !key.endsWith(":read")) ?? "";
    let url = "";
    let app: RequestApp;
    let client: Client;
    let defaultId = 0;
    let secondId = 0;

    beforeAll(async () => {
      url = await freshDatabase("roles");
      await boot(url);
      client = await connectTo(url);
      defaultId = await defaultOrgId(client);
      secondId = await insertId(
        client,
        `INSERT INTO organizations (slug, name)
         VALUES ('second-org', 'Second Org') RETURNING id`
      );
      // This boot gives the second organization its built-in roles.
      app = await loadRequestApp(url);
      await app.syncMetadataTables();
    }, SLOW);

    afterAll(async () => {
      await client?.end();
      await app?.close();
    }, SLOW);

    async function addMember(orgId: number, email: string, role: string): Promise<void> {
      // DO UPDATE rather than DO NOTHING, so that RETURNING gives the id of
      // someone who is already there.
      const profileId = await insertId(
        client,
        `INSERT INTO profiles (email) VALUES ($1)
         ON CONFLICT ((lower(email))) DO UPDATE SET email = EXCLUDED.email
         RETURNING id`,
        [email]
      );
      await client.query(
        `INSERT INTO memberships (org_id, profile_id, role) VALUES ($1, $2, $3)`,
        [orgId, profileId, role]
      );
    }

    function userCounts(roles: { name: string; userCount: number }[]) {
      return Object.fromEntries(roles.map((role) => [role.name, role.userCount]));
    }

    test("hold the permissions their own organization ticked, and no other's", async () => {
      expect(
        await app.roles.setRolePermissions(secondId, "viewer", [...VIEWER_PRESET, UNTICKED], actor)
      ).toMatchObject({ ok: true });
      expect((await app.roles.getRoleAccess(secondId, "viewer"))?.permissions).toContain(UNTICKED);
      const viewers = await app.roles.getRoleAccess(defaultId, "viewer");
      expect([...(viewers?.permissions ?? [])].sort()).toEqual([...VIEWER_PRESET].sort());
    }, SLOW);

    test("count and list each organization's own members and permissions", async () => {
      await addMember(defaultId, "ann@example.invalid", "viewer");
      await addMember(defaultId, "bob@example.invalid", "viewer");
      // The same person, with another role in another organization.
      await addMember(secondId, "ann@example.invalid", "editor");
      await addMember(secondId, "cat@example.invalid", "viewer");

      const inDefault = await app.roles.listRoles(defaultId);
      const inSecond = await app.roles.listRoles(secondId);
      expect(userCounts(inDefault)).toEqual({ viewer: 2, editor: 0, admin: 0 });
      expect(userCounts(inSecond)).toEqual({ viewer: 1, editor: 1, admin: 0 });
      const viewerIn = (roles: typeof inDefault) =>
        roles.find((role) => role.name === "viewer")?.permissions ?? [];
      expect(viewerIn(inDefault)).not.toContain(UNTICKED);
      expect(viewerIn(inSecond)).toContain(UNTICKED);
    }, SLOW);

    test("can share a name with another organization's role", async () => {
      const qaLead = { label: "QA Lead", description: "", copyFrom: "viewer" };
      const created = { ok: true, role: { name: "qa-lead", label: "QA Lead" } };
      expect(await app.roles.createRole(defaultId, qaLead, actor)).toMatchObject(created);
      expect(await app.roles.createRole(secondId, qaLead, actor)).toMatchObject(created);
      // Each copied its own organization's Viewer.
      expect(await permissionsOf(client, defaultId, "qa-lead")).not.toContain(UNTICKED);
      expect(await permissionsOf(client, secondId, "qa-lead")).toContain(UNTICKED);
      // Inside one organization the name is still taken, whatever its case.
      expect(
        await app.roles.createRole(secondId, { ...qaLead, label: "qa lead" }, actor)
      ).toEqual({
        ok: false,
        status: 409,
        error: 'There is already a role called "QA Lead". Pick a different name.',
      });

      // A role made in one organization is nowhere to be seen in the other.
      const releaseManager = { label: "Release Manager", description: "", copyFrom: null };
      expect(await app.roles.createRole(secondId, releaseManager, actor)).toMatchObject({
        ok: true,
      });
      const names = (await app.roles.listRoles(defaultId)).map((role) => role.name);
      expect(names).not.toContain("release-manager");
      expect(await app.roles.getRoleAccess(defaultId, "release-manager")).toBeNull();
      expect(
        await app.roles.setRolePermissions(defaultId, "release-manager", [VIEWER_PRESET[0]], actor)
      ).toEqual({
        ok: false,
        status: 404,
        error: "That role no longer exists. Refresh the page.",
      });
      expect(await app.roles.getRoleAccess(secondId, "release-manager")).toEqual({
        role: "release-manager",
        roleLabel: "Release Manager",
        permissions: [],
      });
    }, SLOW);

    test("change and reset only in their own organization, and are logged only there", async () => {
      const defaultRows = await orgRoleRows(client, defaultId);
      const defaultLog = await app.roles.listRoleChanges(defaultId);
      const kept = EDITOR_PRESET.filter((key) => key !== DROPPED);

      expect(await app.roles.setRolePermissions(secondId, "editor", kept, actor)).toMatchObject({
        ok: true,
      });
      expect(await permissionsOf(client, secondId, "editor")).toEqual([...kept].sort());
      expect(await app.roles.resetRolePermissions(secondId, "editor", actor)).toMatchObject({
        ok: true,
      });
      expect(await permissionsOf(client, secondId, "editor")).toEqual([...EDITOR_PRESET].sort());

      expect(await orgRoleRows(client, defaultId)).toEqual(defaultRows);
      expect(await app.roles.listRoleChanges(defaultId)).toEqual(defaultLog);
      // Newest first: the reset, the box it gave back, and the box unticked.
      const [feature, action] = DROPPED.split(":");
      const changes = (await app.roles.listRoleChanges(secondId, 3)).map((change) => [
        change.kind,
        change.role,
        change.feature,
        change.action,
      ]);
      expect(changes).toEqual([
        ["reset", "editor", null, null],
        ["grant", "editor", feature, action],
        ["revoke", "editor", feature, action],
      ]);
    }, SLOW);

    test("are deleted only in their own organization, never while someone holds one", async () => {
      await addMember(defaultId, "dee@example.invalid", "qa-lead");
      expect(await app.roles.deleteRole(secondId, "qa-lead", actor)).toEqual({ ok: true });
      expect((await rolesOf(client, secondId)).map((role) => role.name)).not.toContain("qa-lead");
      expect((await rolesOf(client, defaultId)).map((role) => role.name)).toContain("qa-lead");

      expect(await app.roles.deleteRole(defaultId, "qa-lead", actor)).toEqual({
        ok: false,
        status: 409,
        error: "1 person has this role. Give them another role on the Users tab first.",
      });
      expect(await app.roles.deleteRole(secondId, "qa-lead", actor)).toEqual({
        ok: false,
        status: 404,
        error: "That role no longer exists. Refresh the page.",
      });
    }, SLOW);
  });

  describe("making an organization", () => {
    let app: RequestApp;
    let client: Client;
    let edId = 0;
    let fayId = 0;
    let acmeId = 0;

    beforeAll(async () => {
      const url = await freshDatabase("making");
      app = await loadRequestApp(url);
      await app.syncMetadataTables();
      client = await connectTo(url);
      // Two people from GitHub, which nobody is handed an organization for,
      // so both start in none, the way someone who has just signed up does.
      edId = await signedIn(app, github(101, "ed@example.invalid"));
      fayId = await signedIn(app, github(102, "fay@example.invalid"));
    }, SLOW);

    afterAll(async () => {
      await client?.end();
      await app?.close();
    }, SLOW);

    // Every row that making an organization writes, counted, to show that a
    // refusal wrote none of them.
    async function counts() {
      const { rows } = await client.query(
        `SELECT (SELECT count(*) FROM organizations)::int AS organizations,
                (SELECT count(*) FROM roles)::int AS roles,
                (SELECT count(*) FROM role_permissions)::int AS role_permissions,
                (SELECT count(*) FROM memberships)::int AS memberships`
      );
      return rows[0];
    }

    async function lastOrgIdOf(profileId: number): Promise<number | null> {
      const { rows } = await client.query<{ last_org_id: number | null }>(
        `SELECT last_org_id FROM profiles WHERE id = $1`,
        [profileId]
      );
      return rows[0].last_org_id;
    }

    test("gives it the built-in roles every organization gets, with its maker as its Admin", async () => {
      expect(await app.orgs.listMemberships(edId)).toEqual([]);

      const created = await app.orgs.createOrganization(edId, {
        slug: "acme-data",
        name: "Acme Data",
      });
      expect(created).toEqual({
        kind: "ok",
        organization: {
          id: expect.any(Number),
          slug: "acme-data",
          name: "Acme Data",
          isDefault: false,
          // On by default: a new organization asks for a second person before production.
          twoPersonRule: true,
        },
      });
      acmeId = created.kind === "ok" ? created.organization.id : 0;

      expect(await rolesOf(client, acmeId)).toEqual(EXPECTED_BUILT_IN_ROLES);
      expect(await builtInPermissionsOf(client, acmeId)).toEqual(EXPECTED_BUILT_IN_PERMISSIONS);
      expect(await membershipsOf(client, acmeId)).toEqual({ "ed@example.invalid": "admin" });
      const row = (await organizationsIn(client)).find((org) => org.id === acmeId);
      expect(row).toMatchObject({ personal: false, is_default: false });
    }, SLOW);

    test("takes its maker there next time an address names no organization", async () => {
      expect(await lastOrgIdOf(edId)).toBe(acmeId);
      expect(await app.orgs.findLastOrganization(edId)).toBe("acme-data");
      expect((await app.orgs.listMemberships(edId)).map((m) => [m.slug, m.role])).toEqual([
        ["acme-data", "admin"],
      ]);
    }, SLOW);

    test("turns down a taken address, the default organization's too, and writes nothing", async () => {
      const before = await counts();
      for (const slug of ["acme-data", "swinburne-fyp"]) {
        expect(await app.orgs.createOrganization(fayId, { slug, name: "Fay's" })).toEqual({
          kind: "taken",
        });
      }
      expect(await counts()).toEqual(before);
      expect(await lastOrgIdOf(fayId)).toBeNull();
      expect(await app.orgs.listMemberships(fayId)).toEqual([]);
      expect(await membershipsOf(client, acmeId)).toEqual({ "ed@example.invalid": "admin" });
    }, SLOW);

    test("settles two people asking for one address at the same moment: one gets it", async () => {
      const results = await Promise.all([
        app.orgs.createOrganization(edId, { slug: "race-org", name: "Ed's race" }),
        app.orgs.createOrganization(fayId, { slug: "race-org", name: "Fay's race" }),
      ]);
      expect(results.map((result) => result.kind).sort()).toEqual(["ok", "taken"]);
      const winner = results[0].kind === "ok" ? "ed@example.invalid" : "fay@example.invalid";
      const raceId = await insertId(client, `SELECT id FROM organizations WHERE slug = 'race-org'`);
      expect(await membershipsOf(client, raceId)).toEqual({ [winner]: "admin" });
      expect(await rolesOf(client, raceId)).toEqual(EXPECTED_BUILT_IN_ROLES);
    }, SLOW);

    test("makes one organization from a double click, not two half ones", async () => {
      const before = await counts();
      const results = await Promise.all([
        app.orgs.createOrganization(fayId, { slug: "fay-team", name: "Fay's team" }),
        app.orgs.createOrganization(fayId, { slug: "fay-team", name: "Fay's team" }),
      ]);
      expect(results.map((result) => result.kind).sort()).toEqual(["ok", "taken"]);
      const after = await counts();
      expect(after.organizations).toBe(before.organizations + 1);
      expect(after.memberships).toBe(before.memberships + 1);
    }, SLOW);

    test("answers no-profile for someone deleted since they signed in, and writes nothing", async () => {
      const goneId = await insertId(
        client,
        `INSERT INTO profiles (email) VALUES ('gone@example.invalid') RETURNING id`
      );
      await client.query(`DELETE FROM profiles WHERE id = $1`, [goneId]);
      const before = await counts();
      expect(
        await app.orgs.createOrganization(goneId, { slug: "gone-org", name: "Gone" })
      ).toEqual({ kind: "no-profile" });
      expect(await counts()).toEqual(before);
    }, SLOW);

    test.each([
      ["a word the app uses itself", "onboarding"],
      ["a malformed address", "Not An Address"],
    ])("throws for %s rather than storing it", async (_, slug) => {
      const before = await counts();
      await expect(app.orgs.createOrganization(edId, { slug, name: "Nope" })).rejects.toThrow(
        `"${slug}" is not an address an organization may have.`
      );
      expect(await counts()).toEqual(before);
    }, SLOW);

    test("lists every organization by name, whatever its case, for the bypass", async () => {
      // "aardvark labs" comes first only when case is ignored: by character
      // code, every capital comes before every lowercase letter.
      await app.orgs.createOrganization(edId, { slug: "aardvark", name: "aardvark labs" });
      const names = (await app.orgs.listOrganizations()).map((org) => org.name);
      expect(names[0]).toBe("aardvark labs");
      expect(names).toEqual(
        [...names].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
      );
      expect(names).toContain("Swinburne FYP");
      expect((await app.orgs.listMemberships(edId)).map((m) => m.name)[0]).toBe("aardvark labs");
    }, SLOW);
  });

  describe("changing and deleting an organization", () => {
    let app: RequestApp;
    let client: Client;
    let edId = 0;

    beforeAll(async () => {
      const url = await freshDatabase("changing");
      app = await loadRequestApp(url);
      await app.syncMetadataTables();
      client = await connectTo(url);
      edId = await signedIn(app, github(201, "ed@example.invalid"));
    }, SLOW);

    afterAll(async () => {
      await client?.end();
      await app?.close();
    }, SLOW);

    /** A new organization of Ed's, with the given slug, and its id. */
    async function made(slug: string, name = "Ed's"): Promise<number> {
      const created = await app.orgs.createOrganization(edId, { slug, name });
      if (created.kind !== "ok") throw new Error(`Could not make ${slug}: ${created.kind}`);
      return created.organization.id;
    }

    async function logOf(orgId: number) {
      const { rows } = await client.query(
        `SELECT role, kind, subject, detail, actor FROM role_changes
          WHERE org_id = $1 AND kind IN ('rename-organization', 'two-person-rule') ORDER BY id`,
        [orgId]
      );
      return rows;
    }

    test("renames it and switches its rule, keeps the address, and logs only what changed", async () => {
      const id = await made("change-me", "Before");

      const both = await app.orgs.updateOrganization(id, { name: "After", twoPersonRule: false }, "ed@example.invalid");
      expect(both).toEqual({
        kind: "ok",
        organization: expect.objectContaining({ id, slug: "change-me", name: "After", twoPersonRule: false }),
      });
      // The same values again change nothing, so they log nothing.
      await app.orgs.updateOrganization(id, { name: "After", twoPersonRule: false }, "ed@example.invalid");
      await app.orgs.updateOrganization(id, { twoPersonRule: true }, "ed@example.invalid");

      expect(await logOf(id)).toEqual([
        { role: ADMIN_ROLE, kind: "rename-organization", subject: "After", detail: "Before", actor: "ed@example.invalid" },
        { role: ADMIN_ROLE, kind: "two-person-rule", subject: null, detail: "off", actor: "ed@example.invalid" },
        { role: ADMIN_ROLE, kind: "two-person-rule", subject: null, detail: "on", actor: "ed@example.invalid" },
      ]);
      expect((await app.orgs.findOrganization("change-me"))?.name).toBe("After");
    }, SLOW);

    test("answers not-found for an organization that is gone", async () => {
      expect(await app.orgs.updateOrganization(999_999, { name: "Ghost" }, "ed@example.invalid")).toEqual({
        kind: "not-found",
      });
    }, SLOW);

    test("deletes only on the exact name, takes everything it owns, and keeps the people", async () => {
      const id = await made("delete-me", "Delete Me");
      const owned = async () => {
        const { rows } = await client.query(
          `SELECT (SELECT count(*) FROM roles WHERE org_id = $1)::int AS roles,
                  (SELECT count(*) FROM memberships WHERE org_id = $1)::int AS memberships,
                  (SELECT count(*) FROM role_changes WHERE org_id = $1)::int AS log`,
          [id]
        );
        return rows[0];
      };
      const before = await owned();
      expect(before.roles).toBeGreaterThan(0);
      expect(before.memberships).toBe(1);

      expect(await app.orgs.deleteOrganization(id, "delete me")).toEqual({ kind: "mismatch" });
      expect(await app.orgs.deleteOrganization(id, " Delete Me")).toEqual({ kind: "mismatch" });
      expect(await owned()).toEqual(before);

      expect(await app.orgs.deleteOrganization(id, "Delete Me")).toEqual({ kind: "deleted" });
      expect(await owned()).toEqual({ roles: 0, memberships: 0, log: 0 });
      expect(await app.orgs.findOrganization("delete-me")).toBeNull();
      const { rows } = await client.query(`SELECT count(*)::int AS n FROM profiles WHERE id = $1`, [edId]);
      expect(rows[0].n).toBe(1);
      expect(await app.orgs.deleteOrganization(id, "Delete Me")).toEqual({ kind: "not-found" });
    }, SLOW);

    test("never deletes the default organization, even with its name typed", async () => {
      const fallback = await app.orgs.findDefaultOrganization();
      if (!fallback) throw new Error("No default organization.");
      expect(await app.orgs.deleteOrganization(fallback.id, fallback.name)).toEqual({ kind: "default" });
      expect(await app.orgs.findDefaultOrganization()).toEqual(fallback);
    }, SLOW);
  });
});
