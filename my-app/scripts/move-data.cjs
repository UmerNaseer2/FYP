#!/usr/bin/env node
/**
 * Moves one organization from one Schema Studio database into another, for
 * example from a Docker server or a desktop app into the Supabase database
 * behind the web site. deploy/SUPABASE-VERCEL.md has the steps.
 *
 * It only ever writes to the new database, and the old one is read in a
 * read-only transaction, so the old copy keeps working afterwards.
 *
 * Without --apply it does the whole move inside a transaction and then rolls it
 * back, so a trial run hits every problem a real one would. The only trace it
 * leaves is some used-up id numbers, which nothing depends on.
 *
 *   node scripts/move-data.cjs                     lists the organizations
 *   node scripts/move-data.cjs --org acme-data     tries moving one
 *   node scripts/move-data.cjs --org acme-data --apply
 *
 * Other choices:
 *   --as <slug>                the address it gets in the new database
 *   --admin <email>            makes this person an admin of the moved one
 *   --backup <file>            reads a desktop backup instead of a database
 *   --keep-private-passwords   for a new database whose site can reach those hosts
 *   --same-directory           both sites sign in through one Microsoft directory
 *
 * Secrets come from the environment only, never from flags, because flags end
 * up in shell history and in the list of running processes:
 *   MOVE_FROM_URL, MOVE_TO_URL                the two databases
 *   MOVE_FROM_KEY or MOVE_FROM_NEXTAUTH_SECRET   what locks the old passwords
 *   MOVE_TO_KEY or MOVE_TO_NEXTAUTH_SECRET       what will lock the new ones
 *   MOVE_BACKUP_PASSPHRASE                    with --backup
 *
 * It prints counts and never a host, email address, password or key. Everything
 * being moved is held in memory, which is fine for something bound for a free
 * plan's 500 MB.
 */
const crypto = require("node:crypto");
const dns = require("node:dns");
const net = require("node:net");
const path = require("node:path");
const { Client } = require("pg");
const { parse: parseConnectionString } = require("pg-connection-string");

/** A problem described in words that are safe to print. */
class MoveError extends Error {}

// ---------------------------------------------------------------------------
// What moves, and in what order
// ---------------------------------------------------------------------------

/**
 * The tables that belong to an organization, parents before children. `links`
 * names the columns holding another moved table's id: those ids change, so each
 * link is pointed at the new row. Some links have no foreign key (a deleted
 * connection leaves them dangling), so one that points at nothing is cleared
 * when its column allows, and otherwise its row stays behind and gets counted.
 * The old number is never kept, since in the new database it could mean a
 * different row.
 *
 * organizations, profiles and identities need more care, so they have their own
 * code below.
 */
const ORG_TABLES = [
  { name: "roles", renumber: false, links: {} },
  { name: "role_permissions", renumber: false, links: {} },
  { name: "memberships", renumber: false, links: { profile_id: "profiles" } },
  { name: "role_changes", renumber: true, links: {} },
  { name: "access_requests", renumber: true, links: {} },
  { name: "connections", renumber: true, links: {} },
  { name: "tracked_schemas", renumber: true, links: { connection_id: "connections" } },
  { name: "snapshots", renumber: true, links: { tracked_schema_id: "tracked_schemas" } },
  {
    name: "lineage_migrations",
    renumber: true,
    links: { tracked_schema_id: "tracked_schemas", snapshot_id: "snapshots" },
  },
  {
    name: "drift_events",
    renumber: true,
    links: { tracked_schema_id: "tracked_schemas", baseline_snapshot_id: "snapshots" },
  },
  { name: "schema_metrics", renumber: true, links: { tracked_schema_id: "tracked_schemas" } },
  { name: "query_history", renumber: true, links: { connection_id: "connections" } },
  { name: "perf_thresholds", renumber: true, links: { connection_id: "connections" } },
  { name: "comparison_sets", renumber: true, links: { source_connection_id: "connections" } },
  {
    name: "comparison_set_targets",
    renumber: true,
    links: { set_id: "comparison_sets", connection_id: "connections" },
  },
  {
    name: "comparison_runs",
    renumber: true,
    links: {
      set_id: "comparison_sets",
      source_connection_id: "connections",
      target_connection_id: "connections",
    },
  },
  { name: "deploy_approvals", renumber: true, links: { connection_id: "connections" } },
  { name: "deploy_attempts", renumber: true, links: { connection_id: "connections" } },
];

const SPECIAL_TABLES = ["organizations", "profiles", "identities"];

/**
 * Tied to the database or the site they lived on, so they stay. Phones turn
 * alerts on again because push devices belong to that site's push key, computers
 * link again, and people are invited again.
 */
const LEFT_BEHIND_TABLES = [
  "metadata_boot_stamps",
  "drift_scheduler_state",
  "push_keys",
  "push_subscriptions",
  "agents",
  "agent_links",
  "agent_connections",
  "agent_jobs",
  "invites",
  // The GitHub access token is locked with the old site's key, so an Admin
  // adds the repository and token again on the new site.
  "organization_github",
];

/** A new person's columns. Their old `role` stays behind: the column's default is the safe start. */
const PERSON_COLUMNS = ["id", "email", "name", "created_at", "last_seen_at", "last_org_id"];

const LAST_TEST_COLUMNS = [
  "last_tested_at",
  "last_test_ok",
  "last_test_version",
  "last_test_latency_ms",
  "last_test_error",
];

// ---------------------------------------------------------------------------
// Addresses of organizations. A copy of lib/org-slug.ts, which this plain script
// cannot import. tests/move-data-db.test.ts fails if the two disagree.
// ---------------------------------------------------------------------------

const ORG_SLUG = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;

const RESERVED_SLUGS = new Set([
  "api", "login", "studio", "compare", "script-editor", "deploy", "versionsync", "drift",
  "performance", "visualizer", "connections", "admin", "schemas", "onboarding", "invite",
  "requests", "phone", "link-computer", "invites", "new", "settings", "orgs", "organizations",
  "account", "signup", "logout", "auth", "help", "docs", "about", "pricing", "static", "public",
  "assets", "www", "app", "robots", "sitemap", "manifest",
]);

function isOrgSlug(value) {
  return ORG_SLUG.test(value) && !RESERVED_SLUGS.has(value);
}

// ---------------------------------------------------------------------------
// Passwords. A copy of lib/secret-store.ts, for the same reason, and pinned the
// same way: the test opens this file's output with the app's code and the other
// way around.
// ---------------------------------------------------------------------------

const PREFIX = "enc:v1:";
const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const KEY_BYTES = 32;
const DERIVATION_SALT = "schema-studio/connection-secrets/v1";

const WRONG_KEY =
  "The key given for the old database does not open its saved passwords, so nothing was moved.";

function parseKeyMaterial(raw) {
  const value = raw.trim();
  if (!value) return null;
  if (/^[0-9a-fA-F]{64}$/.test(value)) return Buffer.from(value, "hex");
  const decoded = Buffer.from(value, "base64");
  return decoded.length === KEY_BYTES ? decoded : null;
}

/** The same order the app works it out in: a proper key first, then the sign-in secret. */
function keyFrom(appKey, nextAuthSecret) {
  const explicit = parseKeyMaterial(appKey ?? "");
  if (explicit) return explicit;
  const secret = (nextAuthSecret ?? "").trim();
  return secret ? crypto.scryptSync(secret, DERIVATION_SALT, KEY_BYTES) : null;
}

function sealSecret(plain, key) {
  if (plain === null || plain === "") return plain;
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [
    PREFIX.slice(0, -1),
    iv.toString("base64"),
    cipher.getAuthTag().toString("base64"),
    ciphertext.toString("base64"),
  ].join(":");
}

/** What was stored. A value without the envelope is an old row saved before encryption. */
function openSecret(stored, key) {
  if (stored === null || stored === "" || !stored.startsWith(PREFIX)) return stored;
  const parts = stored.split(":");
  if (parts.length !== 5) throw new MoveError(WRONG_KEY);
  try {
    const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(parts[2], "base64"));
    decipher.setAuthTag(Buffer.from(parts[3], "base64"));
    const opened = [decipher.update(Buffer.from(parts[4], "base64")), decipher.final()];
    return Buffer.concat(opened).toString("utf8");
  } catch {
    throw new MoveError(WRONG_KEY);
  }
}

// ---------------------------------------------------------------------------
// Which hosts count as private
// ---------------------------------------------------------------------------

/** True for a name or address that only means something on its own network. */
function privateByName(host) {
  const name = host.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/^::ffff:/, "");
  if (name === "" || name.startsWith("/") || name.startsWith("@")) return true;
  if (name === "localhost" || name.endsWith(".localhost")) return true;
  if (name.endsWith(".internal") || name.endsWith(".local")) return true;
  if (net.isIPv4(name)) {
    const [a, b] = name.split(".").map(Number);
    return (
      a === 0 || a === 10 || a === 127 ||
      (a === 169 && b === 254) ||
      (a === 192 && b === 168) ||
      (a === 172 && b >= 16 && b <= 31)
    );
  }
  if (net.isIPv6(name)) {
    return (
      name === "::" || name === "::1" ||
      name.startsWith("fe80:") || name.startsWith("fc") || name.startsWith("fd")
    );
  }
  // A single word such as `db` is a Docker service name or a nearby machine.
  return !name.includes(".");
}

const lookupAll = (host) =>
  dns.promises.lookup(host, { all: true }).then((found) => found.map((entry) => entry.address));

/**
 * Asks the DNS as well, because a public-looking name can lead somewhere
 * private. A name that does not resolve cannot be told apart, so it counts as
 * private and its password stays behind.
 */
async function isPrivateHost(host, lookup = lookupAll) {
  if (privateByName(host)) return true;
  if (net.isIP(host.trim().replace(/^\[|\]$/g, "")) !== 0) return false;
  try {
    const addresses = await lookup(host.trim());
    return addresses.length === 0 || addresses.some(privateByName);
  } catch {
    return true;
  }
}

/** The hosts a connection names, in its host column and its opened connection string. */
function hostsOf(connection, connectionString) {
  const hosts = [];
  if (connection.host) hosts.push(connection.host);
  if (connectionString) {
    try {
      hosts.push(parseConnectionString(connectionString).host ?? "");
    } catch {
      hosts.push("");
    }
  }
  return hosts.length > 0 ? hosts : [""];
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * Every value is read as PostgreSQL's own text and written back as text, which
 * the new database reads by its column's type. That keeps jsonb, arrays and
 * microsecond timestamps exactly as they were: a JavaScript Date would lose the
 * microseconds.
 */
const AS_TEXT = { getTypeParser: () => (value) => value };

function quoted(name) {
  return `"${name.replace(/"/g, '""')}"`;
}

/** The same answer as lib/db/metadata-ssl.ts: only a database on another machine uses SSL. */
function wantsSsl(url) {
  const { ssl, host } = parseConnectionString(url);
  if (ssl === false) return false;
  return !(!host || host === "localhost" || host === "127.0.0.1" || host === "::1");
}

async function connect(url) {
  let settings;
  try {
    settings = parseConnectionString(url);
  } catch {
    throw new MoveError("A database address could not be read.");
  }
  // The same as the app's own pool. Hosted poolers often present a certificate
  // Node has no root for, and an sslmode in the address would overrule this.
  const client = new Client({ ...settings, ssl: wantsSsl(url) ? { rejectUnauthorized: false } : false });
  await client.connect();
  return client;
}

async function columnsOf(client, table) {
  const { rows } = await client.query(
    `SELECT column_name AS name,
            is_nullable = 'YES' AS nullable,
            column_default IS NOT NULL OR is_identity = 'YES' AS "hasDefault"
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1 AND is_generated = 'NEVER'
      ORDER BY ordinal_position`,
    [table]
  );
  return rows;
}

/** A source reads rows the same way whether they sit in a database or in a backup. */
function databaseSource(client) {
  return {
    async columns(table) {
      const found = await columnsOf(client, table);
      return found.length > 0 ? found.map((column) => column.name) : null;
    },
    async rows(table, column, values) {
      const { rows } = await client.query({
        text:
          column === undefined
            ? `SELECT * FROM public.${quoted(table)}`
            : `SELECT * FROM public.${quoted(table)} WHERE ${quoted(column)}::text = ANY($1::text[])`,
        values: column === undefined ? [] : [values],
        types: AS_TEXT,
      });
      return rows;
    },
  };
}

/**
 * `tables` maps a table's name to { columns, rows }. The desktop turns every
 * column into text before it saves a row (desktop/src/main/backup.ts), so a
 * backup's values are already the text a database would give, like
 * databaseSource's, and need no turning back.
 */
function backupSource(tables) {
  return {
    async columns(table) {
      return tables.get(table)?.columns ?? null;
    },
    async rows(table, column, values) {
      const rows = tables.get(table)?.rows ?? [];
      if (column === undefined) return rows;
      const wanted = new Set(values);
      return rows.filter((row) => wanted.has(row[column]));
    },
  };
}

/** Everything that moves, read before the new database is touched, as text. */
async function readOrganization(source, org, memberIds) {
  const read = new Map();
  for (const { name } of ORG_TABLES) {
    read.set(name, (await source.columns(name)) ? await source.rows(name, "org_id", [org.id]) : []);
  }
  read.set("profiles", await source.rows("profiles", "id", memberIds));
  read.set(
    "identities",
    (await source.columns("identities")) ? await source.rows("identities", "profile_id", memberIds) : []
  );
  return read;
}

/** The new database must be able to hold everything the old one has. */
async function checkColumns(source, target) {
  const found = new Map();
  for (const table of [...SPECIAL_TABLES, ...ORG_TABLES.map((step) => step.name)]) {
    const here = await columnsOf(target, table);
    const there = await source.columns(table);
    if (here.length === 0) {
      throw new MoveError(
        "The new database does not have this app's tables yet. Open the new site once, then try again."
      );
    }
    if (there !== null) {
      const known = new Set(there);
      const missingHere = there.some((name) => !here.some((column) => column.name === name));
      const missingThere = here.some(
        (column) => !column.nullable && !column.hasDefault && !known.has(column.name)
      );
      if (missingHere || missingThere) {
        throw new MoveError(
          `The two databases are on different versions of the app (table ${table}). ` +
            "Update the older one, then try again."
        );
      }
    }
    found.set(table, { here, there: there ?? [] });
  }
  return found;
}

/**
 * Opens every saved password now, before the new database is touched, so a wrong
 * key stops the run with nothing written. A host that only means something on
 * the old network keeps its row, so history stays linked, but not its password:
 * the new site could not use it, and a password should not sit where nothing
 * needs it.
 */
async function openConnections(connections, fromKey, toKey, keepPrivate, lookup) {
  const opened = new Map();
  for (const connection of connections) {
    const password = openSecret(connection.password ?? null, fromKey);
    const connectionString = openSecret(connection.connection_string ?? null, fromKey);
    let isPrivate = false;
    if (!keepPrivate) {
      for (const host of hostsOf(connection, connectionString)) {
        if (await isPrivateHost(host, lookup)) isPrivate = true;
      }
    }
    opened.set(connection.id, {
      isPrivate,
      password: isPrivate ? "" : password ?? "",
      connectionString: isPrivate ? null : connectionString || null,
      toKey,
    });
  }
  return opened;
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/** PostgreSQL allows 65,535 values in one statement; a lower limit also keeps statements small. */
const MAX_VALUES = 20_000;
const MAX_BYTES = 8 * 1024 * 1024;

async function insertRows(client, table, columns, rows) {
  let batch = [];
  let values = [];
  let bytes = 0;
  const flush = async () => {
    if (batch.length === 0) return;
    await client.query({
      text:
        `INSERT INTO public.${quoted(table)} (${columns.map(quoted).join(", ")}) VALUES ` +
        batch.join(", "),
      values,
    });
    batch = [];
    values = [];
    bytes = 0;
  };
  for (const row of rows) {
    if (values.length + columns.length > MAX_VALUES) await flush();
    const marks = columns.map((column) => {
      const value = row[column] ?? null;
      values.push(value);
      bytes += value === null ? 0 : value.length;
      return `$${values.length}`;
    });
    batch.push(`(${marks.join(", ")})`);
    if (bytes > MAX_BYTES) await flush();
  }
  await flush();
}

/** New ids handed out in one go, so a distant pooler is not asked once per row. */
async function reserveIds(client, table, count) {
  if (count === 0) return [];
  const { rows } = await client.query(
    `SELECT nextval(pg_get_serial_sequence($1, 'id'))::text AS id FROM generate_series(1, $2::int)`,
    [`public.${quoted(table)}`, count]
  );
  return rows.map((row) => row.id);
}

/** Copies one table's rows, pointing each row's links at the new rows. */
async function moveTable(context, step) {
  const { read, ids, target, columns, newOrgId, report } = context;
  const { here, there } = columns.get(step.name);
  const nullable = new Set(here.filter((column) => column.nullable).map((column) => column.name));
  const kept = [];
  const oldIds = [];
  let dropped = 0;

  for (const original of read.get(step.name)) {
    const row = step.rewrite ? step.rewrite({ ...original }) : { ...original };
    row.org_id = newOrgId;
    let keep = true;
    for (const [column, table] of Object.entries(step.links)) {
      if (row[column] === null || row[column] === undefined) continue;
      const moved = ids.get(table)?.get(row[column]);
      if (moved !== undefined) row[column] = moved;
      else if (nullable.has(column)) row[column] = null;
      else keep = false;
    }
    if (!keep) {
      dropped += 1;
      continue;
    }
    kept.push(row);
    oldIds.push(original.id);
  }

  if (step.renumber) {
    const fresh = await reserveIds(target, step.name, kept.length);
    const map = new Map();
    kept.forEach((row, index) => {
      map.set(oldIds[index], fresh[index]);
      row.id = fresh[index];
    });
    ids.set(step.name, map);
  }

  await insertRows(target, step.name, there, kept);
  report.moved[step.name] = kept.length;
  if (dropped > 0) report.dropped[step.name] = dropped;
}

/** People are matched by address, so someone already on the new site stays one person. */
async function movePeople(context) {
  const { read, target, newOrgId, ids, report, columns } = context;
  const people = read.get("profiles");
  const { rows: existing } = await target.query(
    `SELECT id::text AS id, lower(email) AS email FROM profiles WHERE lower(email) = ANY($1::text[])`,
    [people.map((person) => person.email.toLowerCase())]
  );
  const known = new Map(existing.map((person) => [person.email, person.id]));
  const map = new Map();
  const fresh = people.filter((person) => {
    const id = known.get(person.email.toLowerCase());
    if (id !== undefined) map.set(person.id, id);
    return id === undefined;
  });
  const freshIds = await reserveIds(target, "profiles", fresh.length);
  const inserted = fresh.map((person, index) => {
    map.set(person.id, freshIds[index]);
    return { ...person, id: freshIds[index], last_org_id: newOrgId };
  });
  const usable = PERSON_COLUMNS.filter((column) => columns.get("profiles").there.includes(column));
  await insertRows(target, "profiles", usable, inserted);
  ids.set("profiles", map);
  report.moved.profiles = inserted.length;
  report.peopleAlreadyThere = people.length - inserted.length;
  return new Set(fresh.map((person) => person.id));
}

/**
 * Who can sign in afterwards, which follows from lib/accounts-db.ts. A known
 * (provider, subject) signs in. An address that already has a person links only
 * for a Microsoft sign-in from the site's own directory, and only while that
 * person has no linked accounts at all; anything else answers "taken".
 *
 * A Microsoft subject carries the directory's id, so one copied from a different
 * directory could never match, and would then block the sign-in that should
 * have worked. So those stay behind, unless both sites share a directory, and so
 * does a GitHub account of anyone who has both, or it too would block that
 * Microsoft sign-in. People already on the new site keep what they have there.
 */
async function moveIdentities(context, newPeople, sameDirectory) {
  const { read, target, ids, report, columns } = context;
  const rows = read.get("identities");
  const hasMicrosoft = new Set(
    rows.filter((row) => row.provider === "microsoft").map((row) => row.profile_id)
  );
  const wanted = rows.filter(
    (row) =>
      newPeople.has(row.profile_id) && (sameDirectory || !hasMicrosoft.has(row.profile_id))
  );
  const { rows: taken } = await target.query(
    `SELECT provider, subject FROM identities WHERE subject = ANY($1::text[])`,
    [wanted.map((row) => row.subject)]
  );
  const takenKeys = new Set(taken.map((row) => `${row.provider}\n${row.subject}`));
  const free = wanted.filter((row) => !takenKeys.has(`${row.provider}\n${row.subject}`));
  const freshIds = await reserveIds(target, "identities", free.length);
  const inserted = free.map((row, index) => ({
    ...row,
    id: freshIds[index],
    profile_id: ids.get("profiles").get(row.profile_id),
  }));
  await insertRows(target, "identities", columns.get("identities").there, inserted);
  report.moved.identities = inserted.length;
  // Someone already on the new site keeps the sign-ins they have there, so only
  // a newcomer's can be left behind.
  report.identitiesLeft = rows.filter((row) => newPeople.has(row.profile_id)).length - inserted.length;
}

/**
 * Lets someone into the moved organization. A source that ran with sign-in
 * switched off may hold nobody who can sign in. Someone new gets no linked
 * account, so their first sign-in from the site's own directory links by address.
 */
async function addAdmin(context, email) {
  const { target, newOrgId, read } = context;
  if (!read.get("roles").some((role) => role.name === "admin")) {
    throw new MoveError("This organization has no admin role, so --admin has nothing to give.");
  }
  const address = email.trim().toLowerCase();
  const { rows } = await target.query(
    `WITH found AS (SELECT id FROM profiles WHERE lower(email) = $1),
          made AS (
            INSERT INTO profiles (email, last_org_id)
            SELECT $1, $2::int WHERE NOT EXISTS (SELECT 1 FROM found)
            RETURNING id
          )
     SELECT id FROM found UNION ALL SELECT id FROM made`,
    [address, newOrgId]
  );
  await target.query(
    `INSERT INTO memberships (org_id, profile_id, role) VALUES ($1, $2, 'admin')
     ON CONFLICT (org_id, profile_id) DO UPDATE SET role = 'admin'`,
    [newOrgId, rows[0].id]
  );
}

/** Counts in the new database, and every password opened with the new key. */
async function verify(context, expectedSecrets, addedAdmin) {
  const { target, newOrgId, report } = context;
  const wrong = () =>
    new MoveError("The copy did not match what was read, so it was undone and nothing changed.");
  for (const { name } of ORG_TABLES) {
    const { rows } = await target.query(
      `SELECT count(*)::int AS count FROM public.${quoted(name)} WHERE org_id = $1`,
      [newOrgId]
    );
    // --admin may have added one membership over what was read.
    const extra = name === "memberships" ? addedAdmin : 0;
    const count = rows[0].count;
    if (count < report.moved[name] || count > report.moved[name] + extra) throw wrong();
  }
  const { rows } = await target.query(
    `SELECT id::text AS id, password, connection_string FROM connections WHERE org_id = $1`,
    [newOrgId]
  );
  for (const row of rows) {
    const expected = expectedSecrets.get(row.id);
    if (expected === undefined) throw wrong();
    if ((row.password && !row.password.startsWith(PREFIX)) || openSecret(row.password, context.toKey) !== expected.password) {
      throw wrong();
    }
    if (
      (row.connection_string && !row.connection_string.startsWith(PREFIX)) ||
      openSecret(row.connection_string, context.toKey) !== expected.connectionString
    ) {
      throw wrong();
    }
  }
}

// ---------------------------------------------------------------------------
// The move
// ---------------------------------------------------------------------------

/** Each organization's size, for choosing one. */
async function listOrganizations(source) {
  const organizations = await source.rows("organizations");
  const memberships = await source.rows("memberships");
  const connections = await source.rows("connections");
  const count = (rows, org) => rows.filter((row) => row.org_id === org.id).length;
  return organizations.map((org) => ({
    slug: org.slug,
    name: org.name,
    members: count(memberships, org),
    connections: count(connections, org),
  }));
}

/** How much of what stays behind this organization has, so the report can say. */
async function countLeftBehind(source, org, memberIds) {
  const count = async (table, column, values) =>
    (await source.columns(table)) ? (await source.rows(table, column, values)).length : 0;
  return {
    invites: await count("invites", "org_id", [org.id]),
    computers: await count("agents", "org_id", [org.id]),
    phones: await count("push_subscriptions", "profile_id", memberIds),
  };
}

/**
 * Moves one organization. `options`:
 *   source, target    a source from above, and a connected client
 *   slug, newSlug     which one, and what it is called afterwards
 *   fromKey, toKey    Buffers
 *   apply             false to roll back at the end
 *   admin             an address, or undefined
 *   keepPrivate, sameDirectory, lookup
 * Gives back a report holding counts only.
 */
async function moveOrganization(options) {
  const { source, target, slug, fromKey, toKey, apply, admin, keepPrivate, sameDirectory, lookup } =
    options;
  const newSlug = options.newSlug ?? slug;

  if (!isOrgSlug(newSlug)) {
    throw new MoveError(
      "That address cannot be used: it is not 3 to 40 lowercase letters, digits or hyphens, " +
        "or the site uses it for a page of its own. Choose another with --as."
    );
  }
  if (!toKey) throw new MoveError("Set MOVE_TO_KEY or MOVE_TO_NEXTAUTH_SECRET to the new site's key.");
  if (!fromKey) throw new MoveError("Set MOVE_FROM_KEY or MOVE_FROM_NEXTAUTH_SECRET to the old site's key.");
  if (admin !== undefined && !/^[^@\s]+@[^@\s]+$/.test(admin.trim())) {
    throw new MoveError("--admin needs an email address.");
  }

  if ((await source.columns("organizations")) === null) {
    throw new MoveError("The old database has no organizations. Update its app first, then try again.");
  }
  const [org] = await source.rows("organizations", "slug", [slug]);
  if (org === undefined) throw new MoveError("The old database has no organization with that address.");

  const columns = await checkColumns(source, target);
  const memberIds = (await source.rows("memberships", "org_id", [org.id])).map((row) => row.profile_id);
  const read = await readOrganization(source, org, memberIds);
  const opened = await openConnections(read.get("connections"), fromKey, toKey, keepPrivate, lookup);
  const privateConnections = new Set(
    [...opened].filter(([, value]) => value.isPrivate).map(([id]) => id)
  );

  const report = {
    applied: false,
    moved: {},
    dropped: {},
    peopleAlreadyThere: 0,
    identitiesLeft: 0,
    passwordsLeft: privateConnections.size,
    leftBehind: await countLeftBehind(source, org, memberIds),
  };

  // `id` and the two rewrites below work from the rows as they were read.
  const expectedByOldId = new Map();
  const steps = ORG_TABLES.map((step) => {
    if (step.name !== "connections") return step;
    return {
      ...step,
      rewrite(row) {
        const secrets = opened.get(row.id);
        expectedByOldId.set(row.id, secrets);
        row.password = sealSecret(secrets.password, toKey);
        row.connection_string = sealSecret(secrets.connectionString, toKey);
        if (secrets.isPrivate) {
          for (const column of LAST_TEST_COLUMNS) if (column in row) row[column] = null;
        }
        return row;
      },
    };
  });

  await target.query("BEGIN");
  try {
    const taken = await target.query(`SELECT 1 FROM organizations WHERE slug = $1`, [newSlug]);
    if (taken.rows.length > 0) {
      throw new MoveError(
        "The new database already has an organization with that address. Choose another with --as."
      );
    }

    const [newOrgId] = await reserveIds(target, "organizations", 1);
    // Never the default: the new database has one of those, and only one may exist.
    const newOrg = { ...org, id: newOrgId, slug: newSlug, is_default: "f" };
    await insertRows(target, "organizations", columns.get("organizations").there, [newOrg]);

    const context = { read, ids: new Map(), target, columns, newOrgId, report, toKey };
    const newPeople = await movePeople(context);
    for (const step of steps) {
      await moveTable(context, step);
      if (step.name === "memberships") await moveIdentities(context, newPeople, sameDirectory);
    }

    // Turned off so the new site's checker does not keep failing on them.
    const offIds = read
      .get("tracked_schemas")
      .filter((row) => privateConnections.has(row.connection_id))
      .map((row) => context.ids.get("tracked_schemas").get(row.id))
      .filter((id) => id !== undefined);
    if (offIds.length > 0) {
      await target.query(
        `UPDATE tracked_schemas SET drift_check_interval_minutes = 0 WHERE org_id = $1 AND id = ANY($2::int[])`,
        [newOrgId, offIds]
      );
    }
    report.checksOff = offIds.length;

    if (admin !== undefined) await addAdmin(context, admin);

    const expectedSecrets = new Map(
      [...expectedByOldId].map(([oldId, secrets]) => [context.ids.get("connections").get(oldId), secrets])
    );
    await verify(context, expectedSecrets, admin === undefined ? 0 : 1);

    report.moved.organizations = 1;
    await target.query(apply ? "COMMIT" : "ROLLBACK");
    report.applied = apply;
    return report;
  } catch (error) {
    await target.query("ROLLBACK").catch(() => {});
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Running it
// ---------------------------------------------------------------------------

function parseArguments(argv) {
  const options = {
    org: undefined,
    as: undefined,
    admin: undefined,
    backup: undefined,
    apply: false,
    keepPrivate: false,
    sameDirectory: false,
  };
  const withValue = { "--org": "org", "--as": "as", "--admin": "admin", "--backup": "backup" };
  const switches = {
    "--apply": "apply",
    "--keep-private-passwords": "keepPrivate",
    "--same-directory": "sameDirectory",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (withValue[argument] !== undefined) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new MoveError(`${argument} needs a value.`);
      }
      options[withValue[argument]] = value;
      index += 1;
    } else if (switches[argument] !== undefined) {
      options[switches[argument]] = true;
    } else {
      // The flag's name only: a mistyped command could have a secret in it.
      throw new MoveError("There is an argument here this tool does not know.");
    }
  }
  return options;
}

/** Reads a desktop backup through the desktop's own code, which has to be built first. */
async function openBackup(file, passphrase) {
  if (!passphrase) throw new MoveError("Set MOVE_BACKUP_PASSPHRASE to the backup's passphrase.");
  const desktop = path.join(__dirname, "..", "..", "desktop");
  let reader;
  try {
    reader = require(path.join(desktop, "out", "core", "backup-read.js"));
  } catch {
    throw new MoveError("Reading a backup needs the desktop code built: run `npm run build:ts` in desktop/.");
  }
  const version = require(path.join(desktop, "package.json")).version;
  const { manifest, rows } = await reader.readBackupFile(file, passphrase, version);
  const tables = new Map(
    manifest.tables.map((table) => [
      table.name,
      { columns: table.columns, rows: (rows.get(table.name) ?? []).map((row) => JSON.parse(row)) },
    ])
  );
  return { source: backupSource(tables), key: keyFrom(manifest.secrets.appEncryptionKey, "") };
}

/**
 * Whether the two connections lead to one database, however their addresses are
 * written. Hosted databases keep the server's own identifier from their users, so
 * this asks what any user may see: the database's name and number, and when its
 * server started, which two servers never share to the microsecond.
 */
async function sameDatabase(first, second) {
  const sql = `SELECT current_database() || ' ' || oid::text || ' ' || pg_postmaster_start_time()::text AS place
                 FROM pg_database WHERE datname = current_database()`;
  const [a, b] = await Promise.all([first.query(sql), second.query(sql)]);
  return a.rows[0].place === b.rows[0].place;
}

/** "1 phone" or "3 phones". */
function plural(count, one, many) {
  return `${count} ${count === 1 ? one : many}`;
}

function formatReport(report, slug) {
  const lines = [];
  lines.push(
    report.applied
      ? `Moved. Sign in on the new site and open /${slug} to see it.`
      : `This was a trial, so nothing changed. Add --apply to move it to /${slug}.`
  );
  const order = ["organizations", "profiles", "identities", ...ORG_TABLES.map((step) => step.name)];
  for (const table of order) {
    if (report.moved[table] > 0) lines.push(`  ${table}: ${report.moved[table]}`);
  }
  if (report.peopleAlreadyThere > 0) {
    lines.push(`${plural(report.peopleAlreadyThere, "person was", "people were")} already on the new site, so not added twice.`);
  }
  for (const [table, count] of Object.entries(report.dropped)) {
    lines.push(`${plural(count, "row", "rows")} of ${table} pointed at something deleted long ago and stayed behind.`);
  }
  if (report.passwordsLeft > 0) {
    lines.push(
      `${plural(report.passwordsLeft, "connection reaches", "connections reach")} a private address, so ` +
        `their passwords stay on the old copy. Drift checks turned off on them: ${report.checksOff}.`
    );
  }
  if (report.identitiesLeft > 0) {
    lines.push(
      `${plural(report.identitiesLeft, "linked account", "linked accounts")} stayed behind. Those people sign in again; ` +
        "someone from outside the new site's Microsoft directory needs an admin's help."
    );
  }
  const { invites, computers, phones } = report.leftBehind;
  if (invites > 0) lines.push(`${plural(invites, "open invite", "open invites")} stayed behind. Invite those people again.`);
  if (computers > 0) lines.push(`${plural(computers, "linked computer", "linked computers")} stayed behind. Link them again.`);
  if (phones > 0) lines.push(`${plural(phones, "phone", "phones")} had alerts on. Turn them on again in the phone app.`);
  return lines.join("\n");
}

/**
 * Words safe to print. A database's own message can quote the values it choked
 * on, so all that is kept of one is its code and the names of what it was doing.
 */
function safeMessage(error) {
  if (error instanceof MoveError) return error.message;
  if (error?.name === "BackupFileError") return error.message;
  if (typeof error?.code === "string") {
    const where = [error.table, error.constraint].filter(Boolean).join(", ");
    return `A database answered with code ${error.code}${where ? ` (${where})` : ""}.`;
  }
  return "Something went wrong. No detail is printed, because it could hold a value from the database.";
}

async function main(argv, env, print) {
  const options = parseArguments(argv);
  const clients = [];
  const open = async (url, name) => {
    if (!url) throw new MoveError(`Set ${name} to the database's address.`);
    const client = await connect(url);
    clients.push(client);
    return client;
  };

  try {
    let source;
    let fromKey = keyFrom(env.MOVE_FROM_KEY, env.MOVE_FROM_NEXTAUTH_SECRET);
    let sourceClient = null;
    if (options.backup !== undefined) {
      ({ source, key: fromKey } = await openBackup(options.backup, env.MOVE_BACKUP_PASSPHRASE));
    } else {
      sourceClient = await open(env.MOVE_FROM_URL, "MOVE_FROM_URL");
      await sourceClient.query("BEGIN TRANSACTION READ ONLY ISOLATION LEVEL REPEATABLE READ");
      source = databaseSource(sourceClient);
    }

    if (options.org === undefined) {
      const organizations = await listOrganizations(source);
      print(organizations.length === 0 ? "It holds no organizations." : "Organizations here:");
      for (const org of organizations) {
        print(`  ${org.slug}: ${plural(org.members, "member", "members")}, ${plural(org.connections, "connection", "connections")}`);
      }
      print("Choose one with --org.");
      return;
    }

    const target = await open(env.MOVE_TO_URL, "MOVE_TO_URL");
    if (sourceClient !== null && (await sameDatabase(sourceClient, target))) {
      throw new MoveError("Those two addresses lead to the same database.");
    }
    const report = await moveOrganization({
      source,
      target,
      slug: options.org,
      newSlug: options.as,
      fromKey,
      toKey: keyFrom(env.MOVE_TO_KEY, env.MOVE_TO_NEXTAUTH_SECRET),
      apply: options.apply,
      admin: options.admin,
      keepPrivate: options.keepPrivate,
      sameDirectory: options.sameDirectory,
    });
    print(formatReport(report, options.as ?? options.org));
  } finally {
    await Promise.all(clients.map((client) => client.end().catch(() => {})));
  }
}

if (require.main === module) {
  main(process.argv.slice(2), process.env, (line) => console.log(line)).catch((error) => {
    console.error(safeMessage(error));
    process.exitCode = 1;
  });
}

module.exports = {
  LEFT_BEHIND_TABLES,
  MoveError,
  ORG_SLUG,
  ORG_TABLES,
  RESERVED_SLUGS,
  SPECIAL_TABLES,
  backupSource,
  columnsOf,
  connect,
  databaseSource,
  formatReport,
  isOrgSlug,
  isPrivateHost,
  keyFrom,
  listOrganizations,
  main,
  moveOrganization,
  openSecret,
  parseArguments,
  privateByName,
  safeMessage,
  sameDatabase,
  sealSecret,
  wantsSsl,
};
