#!/usr/bin/env node
/**
 * Copies one organization's saved connections from a copy's own database into
 * the shared database (Supabase), once, when that copy starts using the shared
 * one. deploy/SUPABASE-VERCEL.md, section 6, has the steps.
 *
 *   - The organization must already exist in the shared database (made on the
 *     website). Only its connections are copied: history, tracked schemas and
 *     compare runs stay in the old database, which is not changed at all.
 *   - A connection the shared database already has (same host, port, database
 *     and user) is skipped, so running it twice adds nothing.
 *   - A connection to `localhost` or a private address becomes a local one, the
 *     same way the app saves one: the shared database gets its name and details
 *     with a marker instead of the password, and the password goes to this
 *     machine's own store (the `local_secrets` table behind LOCAL_DATABASE_URL).
 *   - Every other connection is cloud: its password is locked again with the
 *     shared key, so every copy that uses the shared database can open it.
 *
 * Without --apply it does everything inside transactions and then rolls them
 * back, so a trial meets every problem a real run would.
 *
 *   node scripts/move-connections.cjs --org <slug>                 trial
 *   node scripts/move-connections.cjs --org <slug> --apply
 *   node scripts/move-connections.cjs --org <slug> --into <slug>   another address in the shared database
 *
 * Secrets come from the environment only, never from flags:
 *   MOVE_FROM_URL       this copy's own database
 *   MOVE_FROM_KEY or MOVE_FROM_NEXTAUTH_SECRET   what locks its passwords
 *   MOVE_TO_URL         the shared database
 *   MOVE_TO_KEY or MOVE_TO_NEXTAUTH_SECRET       the shared key (the website's APP_ENCRYPTION_KEY)
 *   MOVE_LOCAL_URL      where local passwords go; the same database as
 *                       LOCAL_DATABASE_URL. Defaults to MOVE_FROM_URL.
 *   MOVE_MACHINE_NAME   this machine's name; the same as LOCAL_MACHINE_NAME
 *
 * It prints counts and never a host, password or key.
 */
const crypto = require("node:crypto");
const { parse: parseConnectionString } = require("pg-connection-string");
const {
  MoveError,
  columnsOf,
  connect,
  isOrgSlug,
  isPrivateHost,
  keyFrom,
  openSecret,
  safeMessage,
  sealSecret,
} = require("./move-data.cjs");

// ---------------------------------------------------------------------------
// Local connections. A copy of lib/local-secrets.ts and lib/local-store.ts,
// because this script runs without the app's TypeScript. The test pins the two
// together.
// ---------------------------------------------------------------------------

const LOCAL_MARKER_PREFIX = "local:v1:";
const MACHINE_NAME_MAX = 60;

function cleanMachineName(raw) {
  return (raw ?? "").replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, MACHINE_NAME_MAX).trim();
}

function makeLocalMarker(key, machine) {
  return `${LOCAL_MARKER_PREFIX}${key}:${cleanMachineName(machine) || "the server"}`;
}

/** The key in a marker, or null when the value is not one. */
function keyOfMarker(value) {
  if (typeof value !== "string" || !value.startsWith(LOCAL_MARKER_PREFIX)) return null;
  const rest = value.slice(LOCAL_MARKER_PREFIX.length);
  const colon = rest.indexOf(":");
  return colon > 0 ? rest.slice(0, colon) : null;
}

const CREATE_LOCAL_TABLE = `CREATE TABLE IF NOT EXISTS local_secrets (
  key TEXT PRIMARY KEY,
  password TEXT,
  connection_string TEXT,
  saved_at TIMESTAMPTZ NOT NULL DEFAULT now()
)`;

// ---------------------------------------------------------------------------
// Which connections are the same
// ---------------------------------------------------------------------------

/** Read every value as PostgreSQL's own text, and write it back as text. */
const AS_TEXT = { getTypeParser: () => (value) => value };

/**
 * Columns never copied: the row's number and organization belong to the old
 * database, a desktop's note of a website row means nothing here, and the
 * secrets are written on their own.
 */
const NOT_COPIED = new Set(["id", "org_id", "site_id", "site_version", "version", "updated_at", "password", "connection_string"]);

/** Where a connection points, as one string, or null when that cannot be told. */
function placeOf(row, connectionString) {
  let host = row.host ?? "";
  let port = row.port ?? "";
  let database = row.database_name ?? "";
  let user = row.username ?? "";
  if (!host.trim() && connectionString) {
    try {
      const parsed = parseConnectionString(connectionString);
      host = parsed.host ?? "";
      port = parsed.port ?? "";
      database = parsed.database ?? "";
      user = parsed.user ?? "";
    } catch {
      return null;
    }
  }
  if (!host.trim()) return null;
  return [host.trim().toLowerCase(), String(port).trim(), String(database).trim(), String(user).trim()].join("\u0000");
}

/** The hosts a connection dials: its host field and the one in its connection string. */
function hostsOf(row, connectionString) {
  const hosts = [];
  if (row.host) hosts.push(row.host);
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
// The move
// ---------------------------------------------------------------------------

/**
 * Copies the connections. `options`:
 *   source, target, local   connected clients (local may be the source's database)
 *   slug, intoSlug          the organization in each database
 *   fromKey, toKey          Buffers
 *   machine                 this machine's name
 *   apply                   false to roll back at the end
 *   lookup                  optional DNS lookup, for tests
 * Gives back a report holding counts only.
 */
async function moveConnections(options) {
  const { source, target, local, slug, fromKey, toKey, apply, lookup } = options;
  const intoSlug = options.intoSlug ?? slug;
  const machine = cleanMachineName(options.machine);

  if (!isOrgSlug(slug) || !isOrgSlug(intoSlug)) throw new MoveError("--org and --into need an organization's address.");
  if (!fromKey) throw new MoveError("Set MOVE_FROM_KEY or MOVE_FROM_NEXTAUTH_SECRET to the old copy's key.");
  if (!toKey) throw new MoveError("Set MOVE_TO_KEY or MOVE_TO_NEXTAUTH_SECRET to the shared key.");
  if (!machine) throw new MoveError("Set MOVE_MACHINE_NAME to this machine's name, the same as LOCAL_MACHINE_NAME.");

  // Read the old rows in a read-only transaction, and open every password now,
  // so a wrong key stops the run before anything is written.
  await source.query("BEGIN READ ONLY");
  let fromRows;
  try {
    const org = await source.query(`SELECT id FROM organizations WHERE slug = $1`, [slug]);
    if (org.rows.length === 0) throw new MoveError("The old database has no organization with that address.");
    fromRows = (
      await source.query({
        text: `SELECT * FROM public.connections WHERE org_id = $1 ORDER BY id`,
        values: [org.rows[0].id],
        types: AS_TEXT,
      })
    ).rows;
  } finally {
    await source.query("COMMIT").catch(() => {});
  }
  const opened = fromRows.map((row) => {
    const marker = typeof row.password === "string" && row.password.startsWith(LOCAL_MARKER_PREFIX);
    return {
      row,
      marker,
      password: marker ? "" : openSecret(row.password ?? null, fromKey) ?? "",
      connectionString: marker ? null : openSecret(row.connection_string ?? null, fromKey) || null,
    };
  });

  const report = { applied: false, cloud: 0, local: 0, alreadyThere: 0, alreadyLocal: 0, machine };
  const targetColumns = new Set((await columnsOf(target, "connections")).map((column) => column.name));

  await local.query("BEGIN");
  await target.query("BEGIN");
  try {
    const into = await target.query(`SELECT id FROM organizations WHERE slug = $1`, [intoSlug]);
    if (into.rows.length === 0) {
      throw new MoveError(
        "The shared database has no organization with that address. Make it on the website first, or name another with --into."
      );
    }
    const orgId = into.rows[0].id;

    // This machine's own store, so a local connection already copied here can be
    // placed by its connection string, which the shared database does not hold.
    await local.query(CREATE_LOCAL_TABLE);
    const held = new Map(
      (await local.query(`SELECT key, connection_string FROM local_secrets`)).rows.map((row) => [row.key, row.connection_string])
    );

    // What the shared database already has, by where each connection points.
    const there = await target.query(
      `SELECT name, host, port::text AS port, database_name, username, password, connection_string
         FROM connections WHERE org_id = $1`,
      [orgId]
    );
    const places = new Set();
    const unplacedNames = new Set();
    for (const row of there.rows) {
      let connectionString = null;
      try {
        const markerKey = keyOfMarker(row.password);
        if (markerKey === null) {
          // Opening the password too checks the key on rows that have no connection string.
          openSecret(row.password ?? null, toKey);
          connectionString = openSecret(row.connection_string ?? null, toKey);
        } else {
          connectionString = openSecret(held.get(markerKey) ?? null, toKey);
        }
      } catch {
        throw new MoveError(
          "The shared key does not open the shared database's saved passwords. MOVE_TO_KEY must be the website's APP_ENCRYPTION_KEY."
        );
      }
      const place = placeOf(row, connectionString);
      if (place === null) unplacedNames.add((row.name ?? "").trim().toLowerCase());
      else places.add(place);
    }

    for (const item of opened) {
      if (item.marker) {
        report.alreadyLocal += 1;
        continue;
      }
      const place = placeOf(item.row, item.connectionString);
      const seen = place === null ? unplacedNames.has((item.row.name ?? "").trim().toLowerCase()) : places.has(place);
      if (seen) {
        report.alreadyThere += 1;
        continue;
      }

      let isLocal = false;
      for (const host of hostsOf(item.row, item.connectionString)) {
        if (await isPrivateHost(host, lookup)) isLocal = true;
      }

      let password;
      let connectionString;
      if (isLocal) {
        const key = crypto.randomUUID();
        await local.query(
          `INSERT INTO local_secrets (key, password, connection_string, saved_at) VALUES ($1, $2, $3, now())`,
          [key, sealSecret(item.password, toKey) ?? null, sealSecret(item.connectionString, toKey) || null]
        );
        password = makeLocalMarker(key, machine);
        connectionString = null;
        report.local += 1;
      } else {
        password = sealSecret(item.password, toKey) ?? "";
        connectionString = sealSecret(item.connectionString, toKey) || null;
        report.cloud += 1;
      }

      const columns = Object.keys(item.row).filter((name) => !NOT_COPIED.has(name) && targetColumns.has(name));
      const values = columns.map((name) => item.row[name]);
      columns.push("org_id", "password", "connection_string");
      values.push(String(orgId), password, connectionString);
      if (targetColumns.has("version")) {
        columns.push("version");
        values.push("1");
      }
      if (targetColumns.has("updated_at")) {
        columns.push("updated_at");
        values.push(new Date().toISOString());
      }
      await target.query(
        `INSERT INTO public.connections (${columns.map((name) => `"${name.replace(/"/g, '""')}"`).join(", ")})
         VALUES (${columns.map((_, index) => `$${index + 1}`).join(", ")})`,
        values
      );
      if (place !== null) places.add(place);
      else unplacedNames.add((item.row.name ?? "").trim().toLowerCase());
    }

    // The local passwords first: a marker that points at nothing is worse than
    // a stored password nothing points at.
    if (apply) {
      await local.query("COMMIT");
      await target.query("COMMIT");
    } else {
      await local.query("ROLLBACK");
      await target.query("ROLLBACK");
    }
    report.applied = apply;
    return report;
  } catch (error) {
    await target.query("ROLLBACK").catch(() => {});
    await local.query("ROLLBACK").catch(() => {});
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Running it
// ---------------------------------------------------------------------------

function parseArguments(argv) {
  const options = { org: undefined, into: undefined, apply: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--apply") options.apply = true;
    else if (argument === "--org" || argument === "--into") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) throw new MoveError(`${argument} needs a value.`);
      options[argument.slice(2)] = value;
      index += 1;
    } else throw new MoveError(`Unknown option ${argument.startsWith("--") ? argument : "(not shown)"}.`);
  }
  if (options.org === undefined) throw new MoveError("Say which organization with --org <address>.");
  return options;
}

function plural(count, one, many) {
  return `${count} ${count === 1 ? one : many}`;
}

function formatReport(report) {
  const lines = [report.applied ? "Copied." : "Trial run: everything was rolled back. Add --apply to copy for real."];
  lines.push(`${plural(report.cloud, "cloud connection", "cloud connections")} copied, with passwords locked by the shared key.`);
  lines.push(`${plural(report.local, "local connection", "local connections")} copied by name, with passwords kept on ${report.machine}.`);
  if (report.alreadyThere > 0) {
    lines.push(`${plural(report.alreadyThere, "connection was", "connections were")} already in the shared database, so skipped.`);
  }
  if (report.alreadyLocal > 0) {
    lines.push(`${plural(report.alreadyLocal, "connection was", "connections were")} already local somewhere else, so skipped.`);
  }
  lines.push("History, tracked schemas and compare runs stay in the old database.");
  return lines.join("\n");
}

async function main(argv, env, print) {
  const options = parseArguments(argv);
  for (const name of ["MOVE_FROM_URL", "MOVE_TO_URL"]) {
    if (!env[name]?.trim()) throw new MoveError(`Set ${name}.`);
  }
  const localUrl = env.MOVE_LOCAL_URL?.trim() || env.MOVE_FROM_URL.trim();
  if (!env.MOVE_LOCAL_URL?.trim()) print("MOVE_LOCAL_URL is not set, so local passwords go to the old database (MOVE_FROM_URL).");
  const clients = [];
  try {
    const source = await connect(env.MOVE_FROM_URL.trim());
    clients.push(source);
    const target = await connect(env.MOVE_TO_URL.trim());
    clients.push(target);
    const local = await connect(localUrl);
    clients.push(local);
    const report = await moveConnections({
      source,
      target,
      local,
      slug: options.org,
      intoSlug: options.into,
      fromKey: keyFrom(env.MOVE_FROM_KEY, env.MOVE_FROM_NEXTAUTH_SECRET),
      toKey: keyFrom(env.MOVE_TO_KEY, env.MOVE_TO_NEXTAUTH_SECRET),
      machine: env.MOVE_MACHINE_NAME,
      apply: options.apply,
    });
    print(formatReport(report));
    return report;
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
  CREATE_LOCAL_TABLE,
  LOCAL_MARKER_PREFIX,
  cleanMachineName,
  formatReport,
  main,
  makeLocalMarker,
  moveConnections,
  parseArguments,
  placeOf,
};
