// move-connections-db: scripts/move-connections.cjs copying one organization's
// connections from a Docker copy's own database into a shared one, with the
// passwords of local connections kept in the machine's own store.
//
// Only real databases show that a copied row opens with the shared key, that a
// local password lands in local_secrets and never in the shared database, and
// that a trial or a refusal changes nothing. Every value here is made up; no
// password in this file opens anything.
//
// It needs a Postgres it may create and drop databases in, so it runs only when
// TEST_DATABASE_URL is set (see tests/helpers/test-database.ts), and only
// against a database whose name contains "test".
import { Client } from "pg";
import { testDatabaseUrl } from "./helpers/test-database";

type Report = {
  applied: boolean;
  cloud: number;
  local: number;
  alreadyThere: number;
  alreadyLocal: number;
  machine: string;
};
type MoveOptions = {
  source: Client;
  target: Client;
  local: Client;
  slug: string;
  intoSlug?: string;
  fromKey: Buffer | null;
  toKey: Buffer | null;
  machine: string;
  apply: boolean;
  lookup: (host: string) => Promise<string[]>;
};
type MoveTool = {
  LOCAL_MARKER_PREFIX: string;
  cleanMachineName(raw: string | null | undefined): string;
  makeLocalMarker(key: string, machine: string): string;
  moveConnections(options: MoveOptions): Promise<Report>;
  parseArguments(argv: string[]): { org?: string; into?: string; apply: boolean };
  placeOf(row: Record<string, unknown>, connectionString: string | null): string | null;
  formatReport(report: Report): string;
  main(argv: string[], env: Record<string, string>, print: (line: string) => void): Promise<Report>;
};
type DataTool = {
  keyFrom(appKey: string, nextAuthSecret: string): Buffer | null;
  sealSecret(plain: string | null, key: Buffer | null): string | null;
};
type SecretStore = typeof import("@/lib/secret-store");
type LocalSecrets = typeof import("@/lib/local-secrets");

const tool = require("../scripts/move-connections.cjs") as MoveTool;
const data = require("../scripts/move-data.cjs") as DataTool;

const testUrl = testDatabaseUrl();
const describeWithDatabase = testUrl ? describe : describe.skip;

const SETUP = 120_000;
const SLOW = 60_000;

const OLD_KEY_HEX = "a".repeat(64);
const SHARED_KEY_HEX = "b".repeat(64);
const OLD_KEY = data.keyFrom(OLD_KEY_HEX, "");
const SHARED_KEY = data.keyFrom(SHARED_KEY_HEX, "");
const WRONG_KEY = data.keyFrom("c".repeat(64), "");
const MACHINE = "Swinburne server";

/** Stands in for DNS: the example.com names lead to a public test address, nothing else resolves. */
async function fakeLookup(host: string): Promise<string[]> {
  return host.endsWith(".example.com") ? ["203.0.113.7"] : [];
}

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

/** The site's own secret store and local-secrets cache, under the shared key. */
function withSharedKey<T>(run: (store: SecretStore, local: LocalSecrets) => T): T {
  const saved = { key: process.env.APP_ENCRYPTION_KEY, url: process.env.LOCAL_DATABASE_URL, name: process.env.LOCAL_MACHINE_NAME };
  process.env.APP_ENCRYPTION_KEY = SHARED_KEY_HEX;
  process.env.LOCAL_DATABASE_URL = "postgres://made-up@localhost/unused";
  process.env.LOCAL_MACHINE_NAME = MACHINE;
  try {
    let result: T | undefined;
    jest.isolateModules(() => {
      result = run(require("../lib/secret-store") as SecretStore, require("../lib/local-secrets") as LocalSecrets);
    });
    return result as T;
  } finally {
    for (const [name, value] of [
      ["APP_ENCRYPTION_KEY", saved.key],
      ["LOCAL_DATABASE_URL", saved.url],
      ["LOCAL_MACHINE_NAME", saved.name],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

describe("the move tool's own rules", () => {
  it("writes markers and machine names exactly the way the site does", () => {
    withSharedKey((_store, local) => {
      const key = "0b8f7c1e-2d3a-4b5c-8d9e-0f1a2b3c4d5e";
      for (const machine of ["Swinburne server", "  Bea's\n Mac  ", "", "x".repeat(80)]) {
        expect(tool.makeLocalMarker(key, machine)).toBe(local.makeLocalMarker(key, machine));
        expect(tool.cleanMachineName(machine)).toBe(local.cleanMachineName(machine));
      }
      expect(tool.LOCAL_MARKER_PREFIX).toBe(local.LOCAL_MARKER_PREFIX);
    });
  });

  it("matches connections by where they point, however the address is written", () => {
    const place = tool.placeOf({ host: "DB.Example.com ", port: "5432", database_name: "shop", username: "app" }, null);
    expect(tool.placeOf({ host: "db.example.com", port: 5432, database_name: "shop", username: "app" }, null)).toBe(place);
    expect(tool.placeOf({ host: "", port: "", database_name: "", username: "" }, "postgres://app:made-up@db.example.com:5432/shop")).toBe(
      place
    );
    expect(tool.placeOf({ host: "db.example.com", port: "5433", database_name: "shop", username: "app" }, null)).not.toBe(place);
    expect(tool.placeOf({ host: "", port: "", database_name: "", username: "" }, null)).toBeNull();
  });

  it("reads its options, and never repeats an unknown one's value", () => {
    expect(tool.parseArguments(["--org", "acme-data"])).toEqual({ org: "acme-data", into: undefined, apply: false });
    expect(tool.parseArguments(["--org", "acme-data", "--into", "acme", "--apply"])).toEqual({
      org: "acme-data",
      into: "acme",
      apply: true,
    });
    expect(() => tool.parseArguments([])).toThrow("--org");
    expect(() => tool.parseArguments(["--org"])).toThrow("needs a value");
    expect(() => tool.parseArguments(["--org", "acme-data", "made-up-secret"])).toThrow("(not shown)");
  });
});

describeWithDatabase("copying connections into a shared database", () => {
  const savedUrl = process.env.DATABASE_URL_A;
  const savedDesktop = process.env.SCHEMA_STUDIO_DESKTOP;
  const savedKey = process.env.APP_ENCRYPTION_KEY;
  let server: Client;
  let source: Client;
  let target: Client;
  let local: Client;
  let names: { template: string; from: string; to: string; local: string };

  async function id(db: Client, text: string, values: unknown[] = []): Promise<string> {
    const { rows } = await db.query(`${text} RETURNING id::text AS id`, values);
    return rows[0].id;
  }

  function move(options: Partial<MoveOptions> = {}): Promise<Report> {
    return tool.moveConnections({
      source,
      target,
      local,
      slug: "acme-data",
      fromKey: OLD_KEY,
      toKey: SHARED_KEY,
      machine: MACHINE,
      apply: false,
      lookup: fakeLookup,
      ...options,
    });
  }

  async function sharedRows(slug = "acme-data") {
    const { rows } = await target.query(
      `SELECT c.name, c.host, c.password, c.connection_string, c.version, c.last_test_ok
         FROM connections c JOIN organizations o ON o.id = c.org_id
        WHERE o.slug = $1 ORDER BY c.name`,
      [slug]
    );
    return rows;
  }

  async function localRows(): Promise<{ key: string; password: string | null; connection_string: string | null }[]> {
    const table = await local.query(`SELECT to_regclass('public.local_secrets') AS t`);
    if (table.rows[0].t === null) return [];
    return (await local.query(`SELECT key, password, connection_string FROM local_secrets ORDER BY key`)).rows;
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
      template: `${baseName}_mvc_tpl`,
      from: `${baseName}_mvc_from`,
      to: `${baseName}_mvc_to`,
      local: `${baseName}_mvc_local`,
    };
    server = await connectTo(testUrl);
    for (const name of Object.values(names)) {
      await server.query(`DROP DATABASE IF EXISTS ${quoteIdent(name)} WITH (FORCE)`);
    }
    await server.query(`CREATE DATABASE ${quoteIdent(names.template)}`);
    await server.query(`CREATE DATABASE ${quoteIdent(names.local)}`);

    jest.resetModules();
    globalThis.__metadataSequelize = undefined;
    process.env.DATABASE_URL_A = urlFor(names.template);
    process.env.APP_ENCRYPTION_KEY = OLD_KEY_HEX;
    delete process.env.SCHEMA_STUDIO_DESKTOP;
    const bootstrap = await import("@/lib/db/bootstrap");
    await bootstrap.syncMetadataTables();
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
    local = await connectTo(urlFor(names.local));

    // The server's own database: the organization's connections, sealed with the server's old key.
    const old = (plain: string) => data.sealSecret(plain, OLD_KEY);
    const acme = await id(source, `INSERT INTO organizations (slug, name) VALUES ('acme-data', 'Acme Data')`);
    const rival = await id(source, `INSERT INTO organizations (slug, name) VALUES ('rival-co', 'Rival Co')`);
    const add = (db: Client, org: string, name: string, host: string, password: string, string: string | null, extra = "") =>
      db.query(
        `INSERT INTO connections (org_id, name, host, port, database_name, username, password, connection_string, last_test_ok)
         VALUES ($1, $2, $3, 5432, 'shop', 'app_user', $4, $5, ${extra || "NULL"})`,
        [org, name, host, password, string]
      );
    await add(source, acme, "Shop", "db.example.com", old("made-up-1")!, old("postgres://app_user:made-up-1@db.example.com:5432/shop"), "true");
    await add(source, acme, "Server PG", "localhost", old("made-up-2")!, null);
    await add(source, acme, "Shared already", "shared.example.com", old("made-up-3")!, null);
    await add(source, acme, "Hidden", "", old("made-up-5")!, old("postgres://app_user:made-up-5@10.0.0.5:5432/inner"));
    await add(source, acme, "Bea's laptop DB", "192.168.1.9", "local:v1:0b8f7c1e-2d3a-4b5c-8d9e-0f1a2b3c4d5e:Bea's Mac", null);
    await add(source, rival, "Rival", "rival.example.com", old("made-up-6")!, null);

    // The shared database already holds the organization, one of its connections
    // under an address written another way, and an organization with another address.
    const shared = await id(target, `INSERT INTO organizations (slug, name) VALUES ('acme-data', 'Acme Data')`);
    await id(target, `INSERT INTO organizations (slug, name) VALUES ('acme', 'Acme')`);
    await add(target, shared, "Shared, from the website", "SHARED.example.com", data.sealSecret("made-up-3", SHARED_KEY)!, null);
  }, SETUP);

  afterAll(async () => {
    await source?.end();
    await target?.end();
    await local?.end();
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

  it("does a whole trial run, reports it in counts, and changes nothing", async () => {
    const before = await sharedRows();
    const report = await move();
    expect(report).toEqual({ applied: false, cloud: 1, local: 2, alreadyThere: 1, alreadyLocal: 1, machine: MACHINE });
    expect(await sharedRows()).toEqual(before);
    expect(await localRows()).toEqual([]);
    const printed = tool.formatReport(report);
    expect(printed).toContain("Trial run");
    expect(printed).not.toMatch(/made-up|example\.com|localhost|10\.0\.0\.5/);
  }, SLOW);

  it("stops before writing anything when a key or an address is wrong", async () => {
    const before = await sharedRows();
    await expect(move({ fromKey: WRONG_KEY, apply: true })).rejects.toThrow();
    await expect(move({ toKey: WRONG_KEY, apply: true })).rejects.toThrow("MOVE_TO_KEY must be the website's APP_ENCRYPTION_KEY");
    await expect(move({ intoSlug: "no-such-org", apply: true })).rejects.toThrow("Make it on the website first");
    await expect(move({ slug: "no-such-org", apply: true })).rejects.toThrow("The old database has no organization");
    await expect(move({ machine: "  ", apply: true })).rejects.toThrow("MOVE_MACHINE_NAME");
    expect(await sharedRows()).toEqual(before);
    expect(await localRows()).toEqual([]);
  }, SLOW);

  it("copies cloud connections with the shared key and keeps local passwords on the machine", async () => {
    const report = await move({ apply: true });
    expect(report).toEqual({ applied: true, cloud: 1, local: 2, alreadyThere: 1, alreadyLocal: 1, machine: MACHINE });

    const rows = await sharedRows();
    expect(rows.map((row) => row.name)).toEqual(["Hidden", "Server PG", "Shared, from the website", "Shop"]);
    // No password reaches the shared database as typed.
    const everything = JSON.stringify(rows);
    expect(everything).not.toContain("made-up-2");
    expect(everything).not.toContain("made-up-5");

    const stored = await localRows();
    expect(stored).toHaveLength(2);
    withSharedKey((store, cache) => {
      const shop = rows.find((row) => row.name === "Shop")!;
      expect(store.decryptSecret(shop.password)).toBe("made-up-1");
      expect(store.decryptSecret(shop.connection_string)).toBe("postgres://app_user:made-up-1@db.example.com:5432/shop");
      expect(shop).toMatchObject({ version: 1, last_test_ok: true });

      // The site reads the local store and resolves each marker to the password typed on the server.
      cache.replaceLocalSecrets(
        new Map(stored.map((row) => [row.key, { password: row.password, connectionString: row.connection_string }]))
      );
      for (const [name, password, string] of [
        ["Server PG", "made-up-2", null],
        ["Hidden", "made-up-5", "postgres://app_user:made-up-5@10.0.0.5:5432/inner"],
      ] as const) {
        const row = rows.find((candidate) => candidate.name === name)!;
        expect(row.password).toMatch(/^local:v1:[0-9a-f-]+:Swinburne server$/);
        expect(row.connection_string).toBeNull();
        const entry = cache.resolveLocalMarker(row.password)!;
        expect(store.decryptSecret(entry.password)).toBe(password);
        expect(store.decryptSecret(entry.connectionString)).toBe(string);
      }
    });
    expect(await sharedRows("acme")).toEqual([]);
  }, SLOW);

  it("adds nothing the second time", async () => {
    const before = await sharedRows();
    const report = await move({ apply: true });
    expect(report).toEqual({ applied: true, cloud: 0, local: 0, alreadyThere: 4, alreadyLocal: 1, machine: MACHINE });
    expect(await sharedRows()).toEqual(before);
    expect(await localRows()).toHaveLength(2);
  }, SLOW);

  it("runs from the command line into another address, printing counts and nothing secret", async () => {
    const lines: string[] = [];
    const report = await tool.main(
      ["--org", "acme-data", "--into", "acme", "--apply"],
      {
        MOVE_FROM_URL: urlFor(names.from),
        MOVE_FROM_KEY: OLD_KEY_HEX,
        MOVE_TO_URL: urlFor(names.to),
        MOVE_TO_KEY: SHARED_KEY_HEX,
        MOVE_LOCAL_URL: urlFor(names.local),
        MOVE_MACHINE_NAME: MACHINE,
      },
      (line) => lines.push(line)
    );
    // Real DNS decides which are local here, so only the totals are pinned.
    expect(report.cloud + report.local).toBe(4);
    expect(report).toMatchObject({ alreadyThere: 0, alreadyLocal: 1 });
    expect((await sharedRows("acme")).map((row) => row.name)).toEqual(["Hidden", "Server PG", "Shared already", "Shop"]);
    const printed = lines.join("\n");
    expect(printed).toContain("Copied.");
    expect(printed).not.toMatch(/made-up|example\.com|localhost|10\.0\.0\.5|postgres:\/\/|a{64}|b{64}/);
  }, SLOW);
});
