// move-data-db: scripts/move-data.cjs moving one organization between two real
// metadata databases.
//
// The tool gives every moved row a new id, so only real databases can show that
// each link still lands on the right row, that passwords open with the new
// site's key, and that a trial run or a refusal leaves the new database as it
// was. Every value here is made up; no password in this file opens anything.
//
// It needs a Postgres it may create and drop databases in, so it runs only when
// TEST_DATABASE_URL is set (CI sets it, and fails rather than skip without it:
// see tests/helpers/test-database.ts), and only against a database whose name
// contains "test". tests/invites-db.test.ts shows how to start one locally.
import { Client } from "pg";
import { metadataWantsSsl } from "@/lib/db/metadata-ssl";
import { ORG_SLUG_PATTERN, RESERVED_SLUGS, isOrgSlug } from "@/lib/org-slug";
import { testDatabaseUrl } from "./helpers/test-database";

type Row = Record<string, unknown>;
type Source = object;
type Step = { name: string; renumber: boolean; links: Record<string, string>; cleared?: string[] };
type Report = {
  applied: boolean;
  moved: Record<string, number>;
  dropped: Record<string, number>;
  peopleAlreadyThere: number;
  identitiesLeft: number;
  passwordsLeft: number;
  checksOff: number;
  leftBehind: { invites: number; computers: number; phones: number };
};
type MoveOptions = {
  source: Source;
  target: Client;
  slug: string;
  newSlug?: string;
  fromKey: Buffer | null;
  toKey: Buffer | null;
  apply: boolean;
  admin?: string;
  keepPrivate: boolean;
  sameDirectory: boolean;
  lookup: (host: string) => Promise<string[]>;
};
type MoveTool = {
  ORG_TABLES: Step[];
  SPECIAL_TABLES: string[];
  LEFT_BEHIND_TABLES: string[];
  ORG_SLUG: RegExp;
  RESERVED_SLUGS: Set<string>;
  MoveError: new (message: string) => Error;
  isOrgSlug(value: string): boolean;
  keyFrom(appKey: string, nextAuthSecret: string): Buffer | null;
  sealSecret(plain: string | null, key: Buffer | null): string | null;
  openSecret(stored: string | null, key: Buffer | null): string | null;
  privateByName(host: string): boolean;
  isPrivateHost(host: string, lookup: (host: string) => Promise<string[]>): Promise<boolean>;
  wantsSsl(url: string): boolean;
  databaseSource(client: Client): Source;
  backupSource(tables: Map<string, { columns: string[]; rows: Row[] }>): Source;
  moveOrganization(options: MoveOptions): Promise<Report>;
  main(argv: string[], env: Record<string, string>, print: (line: string) => void): Promise<void>;
  safeMessage(error: unknown): string;
  sameDatabase(first: Client, second: Client): Promise<boolean>;
};
type SecretStore = typeof import("@/lib/secret-store");

const tool = require("../scripts/move-data.cjs") as MoveTool;

const testUrl = testDatabaseUrl();
const describeWithDatabase = testUrl ? describe : describe.skip;

const SLOW = 60_000;
const SETUP = 120_000;

// The old site's key, and a sign-in secret the new site's key is worked out from.
const OLD_KEY_HEX = "a".repeat(64);
const NEW_SITE_SECRET = "made-up-sign-in-secret-for-tests";
const OLD_KEY = tool.keyFrom(OLD_KEY_HEX, "");
const NEW_KEY = tool.keyFrom("", NEW_SITE_SECRET);

const PUBLIC_STRING = "postgres://app_user:made-up-1@db.example.com:5432/shop";

/** Stands in for DNS: the example.com names lead to a public test address, nothing else resolves. */
async function fakeLookup(host: string): Promise<string[]> {
  return host.endsWith(".example.com") ? ["203.0.113.7"] : [];
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function urlFor(name: string, query = ""): string {
  const url = new URL(testUrl);
  url.pathname = "/" + encodeURIComponent(name);
  url.search = query;
  return url.toString();
}

async function connectTo(url: string): Promise<Client> {
  const client = new Client({ connectionString: url });
  await client.connect();
  return client;
}

async function tableNames(db: Client): Promise<string[]> {
  const { rows } = await db.query(`SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY 1`);
  return rows.map((row) => row.tablename as string);
}

/** Every table's row count, to show a run left a database exactly as it was. */
async function counts(db: Client): Promise<Record<string, number>> {
  const found: Record<string, number> = {};
  for (const table of await tableNames(db)) {
    const { rows } = await db.query(`SELECT count(*)::int AS n FROM ${quoteIdent(table)}`);
    found[table] = rows[0].n;
  }
  return found;
}

/**
 * The site's own secret store, loaded fresh under the given keys. It works its
 * key out once and keeps it, so each set of keys needs its own copy, and the
 * calls have to happen while those keys are set.
 */
function withSiteKeys<T>(keys: { APP_ENCRYPTION_KEY?: string; NEXTAUTH_SECRET?: string }, run: (store: SecretStore) => T): T {
  const saved = { APP_ENCRYPTION_KEY: process.env.APP_ENCRYPTION_KEY, NEXTAUTH_SECRET: process.env.NEXTAUTH_SECRET };
  const set = (values: typeof keys) => {
    for (const name of ["APP_ENCRYPTION_KEY", "NEXTAUTH_SECRET"] as const) {
      if (values[name] === undefined) delete process.env[name];
      else process.env[name] = values[name];
    }
  };
  set(keys);
  try {
    let result: T | undefined;
    jest.isolateModules(() => {
      result = run(require("../lib/secret-store") as SecretStore);
    });
    return result as T;
  } finally {
    set(saved);
  }
}

const oldSite = <T>(run: (store: SecretStore) => T) => withSiteKeys({ APP_ENCRYPTION_KEY: OLD_KEY_HEX }, run);
const newSite = <T>(run: (store: SecretStore) => T) => withSiteKeys({ NEXTAUTH_SECRET: NEW_SITE_SECRET }, run);

describeWithDatabase("moving an organization between two real metadata databases", () => {
  const savedUrl = process.env.DATABASE_URL_A;
  const savedDesktop = process.env.SCHEMA_STUDIO_DESKTOP;
  const savedKey = process.env.APP_ENCRYPTION_KEY;
  let server: Client;
  let source: Client;
  let target: Client;
  let names: { template: string; from: string; to: string; empty: string };
  let roleCount = 0;
  let permissionCount = 0;
  let targetBeaId = "";

  async function id(db: Client, text: string, values: unknown[] = []): Promise<string> {
    const { rows } = await db.query(`${text} RETURNING id::text AS id`, values);
    return rows[0].id;
  }

  function move(options: Partial<MoveOptions> = {}): Promise<Report> {
    return tool.moveOrganization({
      source: tool.databaseSource(source),
      target,
      slug: "acme-data",
      fromKey: OLD_KEY,
      toKey: NEW_KEY,
      apply: false,
      keepPrivate: false,
      sameDirectory: false,
      lookup: fakeLookup,
      ...options,
    });
  }

  async function orgId(slug: string): Promise<string> {
    const { rows } = await target.query(`SELECT id::text AS id FROM organizations WHERE slug = $1`, [slug]);
    return rows[0]?.id;
  }

  /** Copies the default organization's roles, which is what the site does for a new one. */
  async function copyRoles(db: Client, from: string, to: string): Promise<void> {
    for (const table of ["roles", "role_permissions"]) {
      const { rows } = await db.query(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = $1 AND is_generated = 'NEVER'`,
        [table]
      );
      const columns = rows.map((row) => row.column_name as string);
      const picked = columns.map((name) => (name === "org_id" ? "$1::int" : quoteIdent(name)));
      await db.query(
        `INSERT INTO ${table} (${columns.map(quoteIdent).join(", ")})
         SELECT ${picked.join(", ")} FROM ${table} WHERE org_id = $2 ON CONFLICT DO NOTHING`,
        [to, from]
      );
    }
  }

  async function seedSource(): Promise<void> {
    const sealed = (plain: string) => oldSite((store) => store.encryptSecret(plain));
    const db = source;
    const { rows } = await db.query(`SELECT id::text AS id FROM organizations WHERE is_default`);
    const acme = await id(db, `INSERT INTO organizations (slug, name) VALUES ('acme-data', 'Acme Data')`);
    const rival = await id(db, `INSERT INTO organizations (slug, name) VALUES ('rival-co', 'Rival Co')`);
    await copyRoles(db, rows[0].id, acme);
    await copyRoles(db, rows[0].id, rival);
    // A desktop keeps everything in its default organization, so that is the
    // one moved here. Two steps, since only one may be the default at a time.
    await db.query(`UPDATE organizations SET is_default = false`);
    await db.query(`UPDATE organizations SET is_default = true WHERE id = $1`, [acme]);
    const roles = await db.query(`SELECT name FROM roles WHERE org_id = $1`, [acme]);
    expect(roles.rows.map((row) => row.name)).toEqual(expect.arrayContaining(["admin", "viewer"]));
    roleCount = roles.rows.length;
    permissionCount = (await db.query(`SELECT 1 FROM role_permissions WHERE org_id = $1`, [acme])).rows.length;

    const person = (email: string) => id(db, `INSERT INTO profiles (email, name) VALUES ($1, $1)`, [email]);
    const ada = await person("ada@example.test");
    const bea = await person("Bea@Example.test");
    const cy = await person("cy@example.test");
    const di = await person("di@example.test");
    const eve = await person("eve@example.test");
    for (const [who, role] of [[ada, "admin"], [bea, "viewer"], [cy, "viewer"], [di, "viewer"]]) {
      await db.query(`INSERT INTO memberships (org_id, profile_id, role) VALUES ($1, $2, $3)`, [acme, who, role]);
    }
    await db.query(`INSERT INTO memberships (org_id, profile_id, role) VALUES ($1, $2, 'viewer')`, [rival, eve]);
    for (const [provider, subject, who, email] of [
      ["microsoft", "made-up-ms-cy", cy, "cy@example.test"],
      ["github", "made-up-gh-cy", cy, "cy@example.test"],
      ["github", "made-up-gh-di", di, "di@example.test"],
      ["github", "made-up-gh-bea", bea, "bea@example.test"],
    ]) {
      await db.query(`INSERT INTO identities (provider, subject, profile_id, email) VALUES ($1, $2, $3, $4)`, [
        provider,
        subject,
        who,
        email,
      ]);
    }

    const connection = (org: string, name: string, host: string, password: string, string: string | null) =>
      id(
        db,
        `INSERT INTO connections (org_id, name, host, username, password, connection_string)
         VALUES ($1, $2, $3, 'app_user', $4, $5)`,
        [org, name, host, sealed(password), string === null ? null : sealed(string)]
      );
    const pub = await connection(acme, "Public", "db.example.com", "made-up-1", PUBLIC_STRING);
    const docker = await connection(acme, "Docker", "db", "made-up-2", null);
    // A public name in the host column, but the saved address leads somewhere private.
    await connection(acme, "Sneaky", "pub.example.com", "made-up-3", "postgres://u:made-up-3@10.0.0.5:5432/x");
    await db.query(
      `UPDATE connections SET last_tested_at = now(), last_test_ok = true, last_test_version = '17',
              last_test_latency_ms = 5 WHERE id = $1`,
      [docker]
    );
    const rivalBox = await connection(rival, "Rival box", "203.0.113.9", "made-up-4", null);
    // As on a desktop linked to a website: a copy of the website's connection 31, and the person's website role.
    await db.query(`UPDATE connections SET site_id = 31, site_version = 4 WHERE id = $1`, [pub]);
    await db.query(`UPDATE organizations SET site_role = '{"role":"viewer","label":"Viewer","permissions":[]}' WHERE id = $1`, [
      acme,
    ]);

    const tracked = (org: string, conn: string) =>
      id(
        db,
        `INSERT INTO tracked_schemas (org_id, connection_id, schema_name, drift_check_interval_minutes)
         VALUES ($1, $2, 'public', 60)`,
        [org, conn]
      );
    const t1 = await tracked(acme, pub);
    const t2 = await tracked(acme, docker);
    await tracked(rival, rivalBox);
    const snapshot = (tracking: string) =>
      id(db, `INSERT INTO snapshots (org_id, tracked_schema_id, snapshot) VALUES ($1, $2, $3)`, [
        acme,
        tracking,
        JSON.stringify({ tables: ["books"] }),
      ]);
    const s1 = await snapshot(t1);
    await snapshot(t2);
    await db.query(
      `INSERT INTO lineage_migrations (org_id, tracked_schema_id, snapshot_id, seq, name, change_level, version)
       VALUES ($1, $2, $3, 1, 'init', 'safe', '1.0.0')`,
      [acme, t1, s1]
    );
    await db.query(
      `INSERT INTO drift_events (org_id, tracked_schema_id, baseline_snapshot_id, status, detail)
       VALUES ($1, $2, $3, 'open', $4)`,
      [acme, t1, s1, JSON.stringify("a JSON string, quotes and all")]
    );
    await db.query(`INSERT INTO schema_metrics (org_id, tracked_schema_id) VALUES ($1, $2)`, [acme, t1]);
    // The second points at a connection deleted long ago, so it cannot come along.
    for (const conn of [pub, "999999"]) {
      await db.query(
        `INSERT INTO query_history (org_id, connection_id, schema_name, query_text, fingerprint, captured_by)
         VALUES ($1, $2, 'public', 'SELECT 1', 'made-up-print', 'ada@example.test')`,
        [acme, conn]
      );
    }
    await db.query(
      `INSERT INTO perf_thresholds (org_id, connection_id, schema_name, threshold_key, threshold_value, updated_by)
       VALUES ($1, $2, 'public', 'query_exec_ms', 500, 'ada@example.test')`,
      [acme, pub]
    );
    const set = await id(
      db,
      `INSERT INTO comparison_sets (org_id, name, source_schema, source_connection_id, compare_data, data_tables)
       VALUES ($1, 'Nightly', 'public', $2, true, $3)`,
      [acme, pub, JSON.stringify(["books", "authors"])]
    );
    await db.query(
      `INSERT INTO comparison_set_targets (org_id, set_id, position, schema_name, connection_id)
       VALUES ($1, $2, 0, 'public', $3)`,
      [acme, set, docker]
    );
    await db.query(
      `INSERT INTO comparison_runs (org_id, set_id, source_connection_id, source_schema, target_connection_id,
              target_schema, ran_by, total_changes, breaking_changes, safe_changes, info_changes, fingerprint, findings)
       VALUES ($1, $2, $3, 'public', $4, 'public', 'ada@example.test', 1, 0, 1, 0, 'made-up-run', $5)`,
      [acme, set, pub, docker, JSON.stringify([{ kind: "table-added", name: "books" }])]
    );
    await db.query(
      `INSERT INTO deploy_approvals (org_id, connection_id, schema_name, script_name, target_version,
              run_fingerprint, migration_count, requested_by)
       VALUES ($1, $2, 'public', 'V2__add_books.sql', '2', 'made-up-run', 1, 'bea@example.test')`,
      [acme, pub]
    );
    // The second's connection is gone too, but this column may be empty, so it comes along without it.
    for (const [conn, outcome, status] of [[pub, "applied", 200], ["999999", "failed", 500]]) {
      await db.query(
        `INSERT INTO deploy_attempts (org_id, connection_id, outcome, http_status) VALUES ($1, $2, $3, $4)`,
        [acme, conn, outcome, status]
      );
    }
    await db.query(
      `INSERT INTO role_changes (org_id, role, kind, actor, subject)
       VALUES ($1, 'viewer', 'grant', 'ada@example.test', 'bea@example.test')`,
      [acme]
    );
    await db.query(`INSERT INTO role_changes (org_id, role, kind, actor) VALUES ($1, 'viewer', 'grant', 'x')`, [rival]);
    await db.query(`INSERT INTO access_requests (org_id, requested_by) VALUES ($1, 'bea@example.test')`, [acme]);

    // What stays behind: an invite, a linked computer and a phone's alerts.
    await db.query(
      `INSERT INTO invites (org_id, token_hash, kind, email, role, expires_at)
       VALUES ($1, 'made-up-hash', 'email', 'zed@example.test', 'viewer', now() + interval '1 day')`,
      [acme]
    );
    await db.query(
      `INSERT INTO agents (org_id, profile_id, name, token_hash) VALUES ($1, $2, 'Laptop', 'made-up-token-hash')`,
      [acme, ada]
    );
    await db.query(
      `INSERT INTO push_subscriptions (profile_id, endpoint, p256dh, auth)
       VALUES ($1, 'https://push.example.test/1', 'made-up-key', 'made-up-auth')`,
      [ada]
    );
  }

  beforeAll(async () => {
    const baseName = decodeURIComponent(new URL(testUrl).pathname.slice(1));
    if (!/test/i.test(baseName)) {
      throw new Error(
        `TEST_DATABASE_URL names "${baseName}". These tests create and drop databases, ` +
          `so they only run against one whose name contains "test".`
      );
    }
    names = {
      template: `${baseName}_move_tpl`,
      from: `${baseName}_move_from`,
      to: `${baseName}_move_to`,
      empty: `${baseName}_move_empty`,
    };
    server = await connectTo(testUrl);
    for (const name of Object.values(names)) {
      await server.query(`DROP DATABASE IF EXISTS ${quoteIdent(name)} WITH (FORCE)`);
    }
    await server.query(`CREATE DATABASE ${quoteIdent(names.template)}`);
    await server.query(`CREATE DATABASE ${quoteIdent(names.empty)}`);

    // The app builds its tables once, and both sides start as copies of them.
    jest.resetModules();
    globalThis.__metadataSequelize = undefined;
    process.env.DATABASE_URL_A = urlFor(names.template);
    process.env.APP_ENCRYPTION_KEY = OLD_KEY_HEX;
    delete process.env.SCHEMA_STUDIO_DESKTOP;
    const bootstrap = await import("@/lib/db/bootstrap");
    await bootstrap.syncMetadataTables();
    await bootstrap.setUpRoles();
    const { sequelize } = await import("@/lib/db/sequelize");
    await sequelize.close();
    globalThis.__metadataSequelize = undefined;
    await server.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [names.template]
    );
    await server.query(`CREATE DATABASE ${quoteIdent(names.from)} TEMPLATE ${quoteIdent(names.template)}`);
    await server.query(`CREATE DATABASE ${quoteIdent(names.to)} TEMPLATE ${quoteIdent(names.template)}`);

    source = await connectTo(urlFor(names.from));
    target = await connectTo(urlFor(names.to));
    await seedSource();
    // The new site already knows Bea, under their address written another way,
    // and its ids run far ahead, so a link that kept its old number would
    // point at nothing.
    targetBeaId = await id(target, `INSERT INTO profiles (email) VALUES ('BEA@example.test')`);
    await target.query(
      `SELECT setval(c.oid::regclass, 5000) FROM pg_class c
        WHERE c.relkind = 'S' AND c.relnamespace = 'public'::regnamespace`
    );
  }, SETUP);

  afterAll(async () => {
    await source?.end();
    await target?.end();
    if (savedUrl === undefined) delete process.env.DATABASE_URL_A;
    else process.env.DATABASE_URL_A = savedUrl;
    if (savedDesktop === undefined) delete process.env.SCHEMA_STUDIO_DESKTOP;
    else process.env.SCHEMA_STUDIO_DESKTOP = savedDesktop;
    if (savedKey === undefined) delete process.env.APP_ENCRYPTION_KEY;
    else process.env.APP_ENCRYPTION_KEY = savedKey;
    if (server) {
      for (const name of Object.values(names)) {
        await server.query(`DROP DATABASE IF EXISTS ${quoteIdent(name)} WITH (FORCE)`);
      }
      await server.end();
    }
  }, SETUP);

  const expectedTrial = (): Report => ({
    applied: false,
    moved: {
      organizations: 1,
      profiles: 3,
      identities: 1,
      roles: roleCount,
      role_permissions: permissionCount,
      memberships: 4,
      role_changes: 1,
      access_requests: 1,
      connections: 3,
      tracked_schemas: 2,
      snapshots: 2,
      lineage_migrations: 1,
      drift_events: 1,
      schema_metrics: 1,
      query_history: 1,
      perf_thresholds: 1,
      comparison_sets: 1,
      comparison_set_targets: 1,
      comparison_runs: 1,
      deploy_approvals: 1,
      deploy_attempts: 2,
    },
    dropped: { query_history: 1 },
    peopleAlreadyThere: 1,
    identitiesLeft: 2,
    passwordsLeft: 2,
    checksOff: 1,
    leftBehind: { invites: 1, computers: 1, phones: 1 },
  });

  it("knows every table, and follows every link between moved tables", async () => {
    const known = new Set([...tool.ORG_TABLES.map((step) => step.name), ...tool.SPECIAL_TABLES, ...tool.LEFT_BEHIND_TABLES]);
    expect((await tableNames(target)).filter((table) => !known.has(table))).toEqual([]);

    const steps = new Map(tool.ORG_TABLES.map((step) => [step.name, step]));
    const { rows: idColumns } = await target.query(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND data_type IN ('integer', 'bigint')
          AND column_name LIKE '%\\_id' AND column_name <> 'org_id'`
    );
    const unfollowed = idColumns
      .filter((row) => {
        const step = steps.get(row.table_name);
        return step !== undefined && !(row.column_name in step.links) && !(step.cleared ?? []).includes(row.column_name);
      })
      .map((row) => `${row.table_name}.${row.column_name}`);
    expect(unfollowed).toEqual([]);

    // A moved row may only lean on rows that move with it.
    const moving = new Set([...steps.keys(), ...tool.SPECIAL_TABLES]);
    const { rows: keys } = await target.query(
      `SELECT conrelid::regclass::text AS child, confrelid::regclass::text AS parent
         FROM pg_constraint WHERE contype = 'f' AND connamespace = 'public'::regnamespace`
    );
    expect(keys.filter((key) => moving.has(key.child) && !moving.has(key.parent))).toEqual([]);

    // Parents come first, so a link always has its new id ready.
    tool.ORG_TABLES.forEach((step, index) => {
      for (const table of Object.values(step.links)) {
        if (table !== "profiles") expect(tool.ORG_TABLES.findIndex((other) => other.name === table)).toBeLessThan(index);
      }
    });
  });

  it("uses the site's own rules for addresses and SSL", () => {
    expect([...tool.RESERVED_SLUGS].sort()).toEqual([...RESERVED_SLUGS].sort());
    expect(tool.ORG_SLUG.source).toBe(ORG_SLUG_PATTERN);
    for (const slug of ["acme-data", "ab", "abc", "-abc", "abc-", "Acme", "a".repeat(40), "a".repeat(41), "login"]) {
      expect([slug, tool.isOrgSlug(slug)]).toEqual([slug, isOrgSlug(slug)]);
    }
    for (const url of [
      "postgres://u@localhost/db",
      "postgres://u@127.0.0.1:5432/db",
      "postgres://u@db.example.com/db",
      "postgres://u@db.example.com/db?sslmode=disable",
      "postgres://u@db.example.com/db?sslmode=require",
      "postgres:///db?host=/var/run/postgresql",
    ]) {
      expect([url, tool.wantsSsl(url)]).toEqual([url, metadataWantsSsl(url)]);
    }
  });

  it("locks passwords exactly the way the site does, with either kind of key", () => {
    const fromTool = tool.sealSecret("made-up-1", OLD_KEY);
    expect(oldSite((store) => store.decryptSecret(fromTool))).toBe("made-up-1");
    expect(tool.openSecret(oldSite((store) => store.encryptSecret("made-up-2")), OLD_KEY)).toBe("made-up-2");

    const fromToolNew = tool.sealSecret("made-up-3", NEW_KEY);
    expect(newSite((store) => store.decryptSecret(fromToolNew))).toBe("made-up-3");
    expect(tool.openSecret(newSite((store) => store.encryptSecret("made-up-4")), NEW_KEY)).toBe("made-up-4");

    expect(() => tool.openSecret(fromTool, NEW_KEY)).toThrow("does not open its saved passwords");
    expect(tool.sealSecret("", NEW_KEY)).toBe("");
    expect(tool.sealSecret(null, NEW_KEY)).toBeNull();
  });

  it("treats only addresses that work from anywhere as public", async () => {
    for (const host of ["db", "localhost", "x.localhost", "10.1.2.3", "172.20.0.1", "192.168.1.1", "169.254.1.1",
      "::1", "[::1]", "fd00::1", "fe80::1", "host.docker.internal", "printer.local", "/var/run/postgresql", ""]) {
      expect([host, tool.privateByName(host)]).toEqual([host, true]);
    }
    for (const host of ["db.example.com", "203.0.113.7", "172.32.0.1", "2001:db8::1"]) {
      expect([host, tool.privateByName(host)]).toEqual([host, false]);
    }
    const asked: string[] = [];
    const lookup = async (host: string) => {
      asked.push(host);
      if (host === "broken.example.com") throw new Error("no answer");
      if (host === "nothing.example.com") return [];
      return host === "inside.example.com" ? ["10.0.0.1"] : ["203.0.113.7"];
    };
    expect(await tool.isPrivateHost("inside.example.com", lookup)).toBe(true);
    expect(await tool.isPrivateHost("broken.example.com", lookup)).toBe(true);
    expect(await tool.isPrivateHost("nothing.example.com", lookup)).toBe(true);
    expect(await tool.isPrivateHost("db.example.com", lookup)).toBe(false);
    expect(await tool.isPrivateHost("203.0.113.9", lookup)).toBe(false);
    expect(asked).toEqual(["inside.example.com", "broken.example.com", "nothing.example.com", "db.example.com"]);
  });

  it("does a whole trial run, reports it in counts, and changes nothing", async () => {
    const before = await counts(target);
    expect(await move()).toEqual(expectedTrial());
    expect(await counts(target)).toEqual(before);
  }, SLOW);

  it("brings every linked account along when both sites share one Microsoft directory", async () => {
    const report = await move({ sameDirectory: true });
    expect([report.moved.identities, report.identitiesLeft]).toEqual([3, 0]);
  }, SLOW);

  it("stops before writing anything when a key or the admin address is wrong", async () => {
    const before = await counts(target);
    await expect(move({ fromKey: tool.keyFrom("b".repeat(64), ""), apply: true })).rejects.toThrow(
      "does not open its saved passwords, so nothing was moved"
    );
    await expect(move({ toKey: null, apply: true })).rejects.toThrow("MOVE_TO_KEY");
    await expect(move({ admin: "not-an-address", apply: true })).rejects.toThrow("--admin needs an email address");
    expect(await counts(target)).toEqual(before);
  }, SLOW);

  it("undoes the whole move when what landed is not what was read", async () => {
    // A trigger spoils each password as it is written, which the last check
    // must notice before anything is kept.
    await target.query(
      `CREATE FUNCTION made_up_spoil() RETURNS trigger LANGUAGE plpgsql AS
         $$ BEGIN NEW.password := 'not-locked'; RETURN NEW; END $$`
    );
    await target.query(
      `CREATE TRIGGER made_up_spoil BEFORE INSERT ON connections FOR EACH ROW EXECUTE FUNCTION made_up_spoil()`
    );
    try {
      const before = await counts(target);
      await expect(move({ apply: true })).rejects.toThrow("did not match what was read, so it was undone");
      expect(await counts(target)).toEqual(before);
    } finally {
      await target.query(`DROP TRIGGER made_up_spoil ON connections`);
      await target.query(`DROP FUNCTION made_up_spoil()`);
    }
  }, SLOW);

  it("refuses an address that is taken, kept for a page, or malformed", async () => {
    const before = await counts(target);
    const { rows } = await target.query(`SELECT slug FROM organizations WHERE is_default`);
    await expect(move({ newSlug: rows[0].slug, apply: true })).rejects.toThrow("already has an organization with that address");
    await expect(move({ newSlug: [...RESERVED_SLUGS][0], apply: true })).rejects.toThrow("cannot be used");
    await expect(move({ newSlug: "Not OK!", apply: true })).rejects.toThrow("cannot be used");
    await expect(move({ slug: "nobody-here" })).rejects.toThrow("has no organization with that address");
    expect(await counts(target)).toEqual(before);
  }, SLOW);

  it("refuses two databases on different versions of the app", async () => {
    const empty = await connectTo(urlFor(names.empty));
    try {
      await expect(move({ target: empty })).rejects.toThrow("does not have this app's tables yet");
    } finally {
      await empty.end();
    }

    await target.query(`ALTER TABLE query_history ADD COLUMN made_up_flag integer NOT NULL DEFAULT 0`);
    await target.query(`ALTER TABLE query_history ALTER COLUMN made_up_flag DROP DEFAULT`);
    try {
      await expect(move()).rejects.toThrow("different versions of the app (table query_history)");
    } finally {
      await target.query(`ALTER TABLE query_history DROP COLUMN made_up_flag`);
    }

    await source.query(`ALTER TABLE snapshots ADD COLUMN made_up_note text`);
    try {
      await expect(move()).rejects.toThrow("different versions of the app (table snapshots)");
    } finally {
      await source.query(`ALTER TABLE snapshots DROP COLUMN made_up_note`);
    }
  }, SLOW);

  it("moves the organization, pointing every link at its new row", async () => {
    expect(await move({ apply: true })).toEqual({ ...expectedTrial(), applied: true });
    const org = await orgId("acme-data");
    const one = async (text: string) => (await target.query(text, [org])).rows;

    expect(await one(`SELECT name, is_default FROM organizations WHERE id = $1`)).toEqual([
      { name: "Acme Data", is_default: false },
    ]);
    for (const step of tool.ORG_TABLES) {
      for (const [column, table] of Object.entries(step.links)) {
        const sameOrg = table === "profiles" ? "" : "AND parent.org_id = $1";
        const [{ n }] = await one(
          `SELECT count(*)::int AS n FROM ${quoteIdent(step.name)} child
            WHERE child.org_id = $1 AND child.${quoteIdent(column)} IS NOT NULL
              AND NOT EXISTS (SELECT 1 FROM ${quoteIdent(table)} parent
                               WHERE parent.id = child.${quoteIdent(column)} ${sameOrg})`
        );
        expect([step.name, column, n]).toEqual([step.name, column, 0]);
      }
    }

    // People: Bea was already there and stays one person.
    expect(
      await one(
        `SELECT lower(p.email) AS email, m.role, p.id::text = '${targetBeaId}' AS was_there
           FROM memberships m JOIN profiles p ON p.id = m.profile_id WHERE m.org_id = $1 ORDER BY 1`
      )
    ).toEqual([
      { email: "ada@example.test", role: "admin", was_there: false },
      { email: "bea@example.test", role: "viewer", was_there: true },
      { email: "cy@example.test", role: "viewer", was_there: false },
      { email: "di@example.test", role: "viewer", was_there: false },
    ]);
    expect(await one(`SELECT count(*)::int AS n FROM profiles WHERE email = 'ada@example.test' AND last_org_id = $1`)).toEqual([
      { n: 1 },
    ]);
    // Cy signs in with Microsoft, which a different directory could not match.
    expect(
      await one(
        `SELECT p.email, i.provider FROM identities i JOIN profiles p ON p.id = i.profile_id
           JOIN memberships m ON m.profile_id = p.id AND m.org_id = $1`
      )
    ).toEqual([{ email: "di@example.test", provider: "github" }]);

    // Rows land on the right parents.
    expect(
      await one(
        `SELECT c.name, t.drift_check_interval_minutes AS every, count(s.id)::int AS snapshots
           FROM tracked_schemas t JOIN connections c ON c.id = t.connection_id
           LEFT JOIN snapshots s ON s.tracked_schema_id = t.id
          WHERE t.org_id = $1 GROUP BY 1, 2 ORDER BY 1`
      )
    ).toEqual([
      { name: "Docker", every: 0, snapshots: 1 },
      { name: "Public", every: 60, snapshots: 1 },
    ]);
    expect(
      await one(
        `SELECT c.name FROM deploy_attempts d LEFT JOIN connections c ON c.id = d.connection_id
          WHERE d.org_id = $1 ORDER BY 1 NULLS LAST`
      )
    ).toEqual([{ name: "Public" }, { name: null }]);
    expect(
      await one(
        `SELECT src.name AS source, dst.name AS target, r.findings, s.data_tables, d.detail
           FROM comparison_runs r
           JOIN comparison_sets s ON s.id = r.set_id
           JOIN connections src ON src.id = r.source_connection_id
           JOIN connections dst ON dst.id = r.target_connection_id
           JOIN drift_events d ON d.org_id = r.org_id
          WHERE r.org_id = $1`
      )
    ).toEqual([
      {
        source: "Public",
        target: "Docker",
        findings: [{ kind: "table-added", name: "books" }],
        data_tables: ["books", "authors"],
        detail: "a JSON string, quotes and all",
      },
    ]);
    const [{ lowest }] = await one(`SELECT min(id)::int AS lowest FROM connections WHERE org_id = $1`);
    expect(lowest).toBeGreaterThan(5000);

    // Passwords: locked with the new key, and none at all for private hosts.
    const connections = await one(
      `SELECT name, password, connection_string, last_tested_at, last_test_ok, site_id, site_version
         FROM connections WHERE org_id = $1 ORDER BY name`
    );
    const [docker, pub, sneaky] = connections;
    // A desktop's note of the website connection it copies, and its website role, mean nothing here.
    expect(connections.map((row) => [row.site_id, row.site_version])).toEqual([[null, null], [null, null], [null, null]]);
    expect((await one(`SELECT site_role FROM organizations WHERE id = $1`))[0].site_role).toBeNull();
    expect(pub.password.startsWith("enc:v1:")).toBe(true);
    expect(tool.openSecret(pub.password, NEW_KEY)).toBe("made-up-1");
    expect(newSite((store) => [store.decryptSecret(pub.password), store.decryptSecret(pub.connection_string)])).toEqual([
      "made-up-1",
      PUBLIC_STRING,
    ]);
    expect(() => tool.openSecret(pub.password, OLD_KEY)).toThrow();
    for (const blank of [docker, sneaky]) {
      expect([blank.name, blank.password, blank.connection_string, blank.last_tested_at, blank.last_test_ok]).toEqual([
        blank.name,
        "",
        null,
        null,
        null,
      ]);
    }

    // Nothing of the other organization, and nothing that stays behind.
    expect((await target.query(`SELECT 1 FROM organizations WHERE slug = 'rival-co'`)).rows).toEqual([]);
    expect((await target.query(`SELECT 1 FROM connections WHERE name = 'Rival box'`)).rows).toEqual([]);
    expect((await target.query(`SELECT 1 FROM profiles WHERE email = 'eve@example.test'`)).rows).toEqual([]);
    for (const table of ["invites", "agents", "push_subscriptions"]) {
      expect([table, (await target.query(`SELECT 1 FROM ${table}`)).rows.length]).toEqual([table, 0]);
    }

    // The same organization again is refused, since its address is now taken.
    await expect(move({ apply: true })).rejects.toThrow("already has an organization with that address");
  }, SLOW);

  it("keeps private passwords when asked, and makes an admin", async () => {
    const report = await move({ apply: true, newSlug: "acme-kept", keepPrivate: true, admin: " New.Admin@Example.test " });
    expect([report.passwordsLeft, report.checksOff, report.peopleAlreadyThere, report.moved.profiles]).toEqual([0, 0, 4, 0]);
    const org = await orgId("acme-kept");
    const { rows } = await target.query(
      `SELECT c.name, c.password, t.drift_check_interval_minutes AS every
         FROM connections c LEFT JOIN tracked_schemas t ON t.connection_id = c.id
        WHERE c.org_id = $1 AND c.name = 'Docker'`,
      [org]
    );
    expect([tool.openSecret(rows[0].password, NEW_KEY), rows[0].every]).toEqual(["made-up-2", 60]);
    const admins = await target.query(
      `SELECT p.email FROM memberships m JOIN profiles p ON p.id = m.profile_id
        WHERE m.org_id = $1 AND m.role = 'admin' ORDER BY 1`,
      [org]
    );
    expect(admins.rows.map((row) => row.email)).toEqual(["ada@example.test", "new.admin@example.test"]);
  }, SLOW);

  it("moves from a desktop backup's rows exactly as from the database", async () => {
    // Rows saved the way the desktop saves them (desktop/src/main/backup.ts):
    // every column turned into text, then the row into JSON.
    const tables = new Map<string, { columns: string[]; rows: Row[] }>();
    for (const table of await tableNames(source)) {
      const { rows: columns } = await source.query(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = $1 AND is_generated = 'NEVER' ORDER BY ordinal_position`,
        [table]
      );
      const list = columns.map((column) => `${quoteIdent(column.column_name)}::text AS ${quoteIdent(column.column_name)}`).join(", ");
      const { rows } = await source.query(`SELECT row_to_json(r.*)::text AS row FROM (SELECT ${list} FROM ${quoteIdent(table)}) r`);
      tables.set(table, { columns: columns.map((column) => column.column_name), rows: rows.map((row) => JSON.parse(row.row)) });
    }
    const fromBackup = tool.backupSource(tables);

    const trial = await move({ newSlug: "acme-copy" });
    expect(await move({ source: fromBackup, newSlug: "acme-copy" })).toEqual(trial);
    await move({ source: fromBackup, newSlug: "acme-copy", apply: true });

    // Row for row the same as the first move, apart from the new ids and the
    // freshly locked passwords.
    const [first, copy] = [await orgId("acme-data"), await orgId("acme-copy")];
    for (const step of tool.ORG_TABLES) {
      const { rows: columns } = await target.query(
        `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1`,
        [step.name]
      );
      const skip = new Set(["id", "org_id", "password", "connection_string", ...Object.keys(step.links)]);
      const list = columns.map((column) => column.column_name).filter((name) => !skip.has(name)).map(quoteIdent);
      const of = async (org: string) =>
        (await target.query(`SELECT row_to_json(r.*)::text AS row FROM (SELECT ${list.join(", ")} FROM ${quoteIdent(step.name)} WHERE org_id = $1) r`, [org]))
          .rows.map((row) => row.row)
          .sort();
      expect([step.name, await of(copy)]).toEqual([step.name, await of(first)]);
    }
  }, SLOW);

  it("runs from the command line, printing counts and nothing secret", async () => {
    const lines: string[] = [];
    const print = (line: string) => lines.push(line);
    const env = {
      MOVE_FROM_URL: urlFor(names.from),
      MOVE_TO_URL: urlFor(names.to),
      MOVE_FROM_KEY: OLD_KEY_HEX,
      MOVE_TO_NEXTAUTH_SECRET: NEW_SITE_SECRET,
    };

    await tool.main([], env, print);
    expect(lines).toContain("  acme-data: 4 members, 3 connections");
    expect(lines).toContain("  rival-co: 1 member, 1 connection");

    lines.length = 0;
    const before = await counts(target);
    await tool.main(["--org", "rival-co", "--as", "rival-moved"], env, print);
    expect(await counts(target)).toEqual(before);
    const printed = lines.join("\n");
    expect(printed).toContain("rival-moved");
    for (const secret of ["made-up", "example", "203.0.113", OLD_KEY_HEX.slice(0, 12), NEW_SITE_SECRET, "127.0.0.1", "Rival box"]) {
      expect([secret, printed.includes(secret)]).toEqual([secret, false]);
    }

    const sameAgain = { ...env, MOVE_TO_URL: urlFor(names.from, "?application_name=written-differently") };
    await expect(tool.main(["--org", "acme-data"], sameAgain, print)).rejects.toThrow("lead to the same database");
    await expect(tool.main(["--org"], env, print)).rejects.toThrow("--org needs a value.");
    await expect(tool.main(["--org", "acme-data", "--password=made-up"], env, print)).rejects.toThrow(
      "There is an argument here this tool does not know."
    );
    await expect(tool.main(["--org", "acme-data"], { ...env, MOVE_TO_URL: "" }, print)).rejects.toThrow("Set MOVE_TO_URL");
  }, SLOW);

  it("tells two databases apart however their addresses are written", async () => {
    expect(await tool.sameDatabase(source, target)).toBe(false);
    const again = await connectTo(urlFor(names.from, "?application_name=again"));
    try {
      expect(await tool.sameDatabase(source, again)).toBe(true);
    } finally {
      await again.end();
    }
  });

  it("describes failures without repeating what the database said", () => {
    const fromDatabase = Object.assign(new Error("Key (email)=(ada@example.test) already exists."), {
      code: "23505",
      table: "profiles",
      constraint: "profiles_email_key",
      detail: "Key (email)=(ada@example.test) already exists.",
    });
    expect(tool.safeMessage(fromDatabase)).toBe("A database answered with code 23505 (profiles, profiles_email_key).");
    expect(tool.safeMessage(new Error("postgres://u:made-up@db.example.com/x"))).not.toMatch(/made-up|example/);
    expect(tool.safeMessage(new tool.MoveError("Plain words."))).toBe("Plain words.");
  });
});
