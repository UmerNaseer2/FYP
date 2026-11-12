// Setting up the metadata tables, against a real Postgres.
//
// Every cold start of the app runs this, and on Supabase and Vercel cold starts are
// frequent and can arrive together. So it has to hold up in four ways:
//
//  - The lock that makes copies take turns ends with a transaction. A session lock
//    leaves the pooler's server connection locked with nobody able to unlock it:
//    the second cold start then waits for ever. tests/pooler-safety.test.ts is the
//    scan that keeps session locks out, and this file checks the lock still works.
//  - A deployment that has already done the job skips it, which is what takes a
//    cold start from about 130 statements to a few.
//  - Anyone holding the public key to Supabase's Data API cannot read these tables,
//    however the project was set up. Passwords and sign-in records live here.
//  - An index on a table of the same name in another schema does not stand in for
//    the app's own, which is what Sequelize's sync() takes it for. A project can
//    hold such a table: Supabase keeps auth.identities, and an old copy may be
//    moved aside.
//
// Needs a Postgres it may create and drop databases in, runs only when
// TEST_DATABASE_URL is set (CI sets it, and fails rather than skip without it: see
// tests/helpers/test-database.ts), and only against a database whose name contains
// "test". tests/invites-db.test.ts shows how to start one locally.
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { testDatabaseUrl } from "./helpers/test-database";

const testUrl = testDatabaseUrl();
const describeWithDatabase = testUrl ? describe : describe.skip;
const SLOW = 60_000;
const SETUP = 120_000;

// The role Supabase's Data API reads as. Plain Postgres has no such role, and that
// is how the app tells which of the two it is on.
const ANON = "anon";
const INDEX_THE_BOOT_MAKES = "profiles_email_key_idx";

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

async function until(what: string, condition: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Still waiting for ${what}.`);
}

type Instance = {
  bootstrap: typeof import("@/lib/db/bootstrap");
  sequelize: typeof import("@/lib/db/sequelize").sequelize;
  metadataPool: typeof import("@/lib/db/sequelize").metadataPool;
};

describeWithDatabase("setting up the metadata tables on a real database", () => {
  const savedUrl = process.env.DATABASE_URL_A;
  const savedDesktop = process.env.SCHEMA_STUDIO_DESKTOP;
  const savedStamp = process.env.VERCEL_DEPLOYMENT_ID;
  let baseName = "";
  let server: Client;
  let anonExisted = false;
  let numbered = 0;
  let databaseName = "";
  let db: Client;
  let instances: Instance[] = [];
  let holders: Client[] = [];

  /** A new copy of the app, which is what a cold start is as far as this code can tell. */
  async function newInstance(url = urlFor(databaseName)): Promise<Instance> {
    jest.resetModules();
    globalThis.__metadataSequelize = undefined;
    process.env.DATABASE_URL_A = url;
    const bootstrap = await import("@/lib/db/bootstrap");
    const { sequelize, metadataPool } = await import("@/lib/db/sequelize");
    const instance = { bootstrap, sequelize, metadataPool };
    instances.push(instance);
    return instance;
  }

  function setStamp(stamp: string | null): void {
    if (stamp === null) delete process.env.VERCEL_DEPLOYMENT_ID;
    else process.env.VERCEL_DEPLOYMENT_ID = stamp;
  }

  /** One cold start, all the way through. `stamp` is the deployment it belongs to. */
  async function coldStart(stamp: string | null = null): Promise<Instance> {
    setStamp(stamp);
    const instance = await newInstance();
    await instance.bootstrap.syncMetadataTables();
    return instance;
  }

  async function closeInstance({ sequelize }: Instance): Promise<void> {
    const pool = (sequelize.connectionManager as unknown as {
      pool: { using: number; waiting: number };
    }).pool;
    await until("the metadata pool to go idle", () => pool.using === 0 && pool.waiting === 0);
    await sequelize.close();
  }

  async function stamps(): Promise<string[]> {
    const { rows } = await db.query(`SELECT stamp FROM metadata_boot_stamps ORDER BY stamp`);
    return rows.map((row: { stamp: string }) => row.stamp);
  }

  async function indexExists(): Promise<boolean> {
    const { rows } = await db.query(`SELECT to_regclass($1) AS found`, [INDEX_THE_BOOT_MAKES]);
    return rows[0].found !== null;
  }

  async function dropIndex(on: Client = db): Promise<void> {
    await on.query(`DROP INDEX ${quoteIdent(INDEX_THE_BOOT_MAKES)}`);
  }

  /** Another copy in the middle of its own boot: holds the lock until told not to. */
  async function holdTheLock(key: number): Promise<Client> {
    const holder = await connectTo(urlFor(databaseName));
    holders.push(holder);
    await holder.query("BEGIN");
    await holder.query("SELECT pg_advisory_xact_lock($1::bigint)", [key]);
    return holder;
  }

  async function someoneIsWaitingForTheLock(): Promise<boolean> {
    const { rows } = await db.query(
      `SELECT 1
         FROM pg_locks l
         JOIN pg_database d ON d.oid = l.database
        WHERE l.locktype = 'advisory' AND NOT l.granted AND d.datname = $1`,
      [databaseName]
    );
    return rows.length > 0;
  }

  /** The app's own tables that a Data API request could otherwise reach. */
  async function tablesWithoutRowSecurity(on: Client = db): Promise<string[]> {
    const { rows } = await on.query(
      `SELECT c.relname
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity
        ORDER BY c.relname`
    );
    return rows.map((row: { relname: string }) => row.relname);
  }

  function statementsSentBy(spy: jest.SpyInstance, pattern: RegExp): number {
    return spy.mock.calls.filter(([text]) => pattern.test(String(text))).length;
  }

  beforeAll(async () => {
    baseName = decodeURIComponent(new URL(testUrl).pathname.slice(1));
    if (!/test/i.test(baseName)) {
      throw new Error(
        `TEST_DATABASE_URL names "${baseName}". These tests create and drop databases, ` +
          `so they only run against one whose name contains "test".`
      );
    }
    server = await connectTo(testUrl);
    const { rows } = await server.query(`SELECT 1 FROM pg_roles WHERE rolname = $1`, [ANON]);
    anonExisted = rows.length > 0;
    delete process.env.SCHEMA_STUDIO_DESKTOP;
  }, SETUP);

  // A database of its own for each test, under a new name. Each boot here changes
  // the tables, and these tests are all about what state a boot finds.
  beforeEach(async () => {
    numbered += 1;
    databaseName = `${baseName}_boot_${numbered}`;
    await server.query(`DROP DATABASE IF EXISTS ${quoteIdent(databaseName)} WITH (FORCE)`);
    await server.query(`CREATE DATABASE ${quoteIdent(databaseName)}`);
    db = await connectTo(urlFor(databaseName));
    instances = [];
    holders = [];
    setStamp(null);
  }, SETUP);

  afterEach(async () => {
    await Promise.all(holders.map((holder) => holder.end().catch(() => {})));
    await Promise.all(instances.map((instance) => closeInstance(instance)));
    await db.end();
    await server.query(`DROP DATABASE IF EXISTS ${quoteIdent(databaseName)} WITH (FORCE)`);
  }, SETUP);

  afterAll(async () => {
    globalThis.__metadataSequelize = undefined;
    const restore = (name: string, value: string | undefined) => {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    };
    restore("DATABASE_URL_A", savedUrl);
    restore("SCHEMA_STUDIO_DESKTOP", savedDesktop);
    restore("VERCEL_DEPLOYMENT_ID", savedStamp);
    await server?.end();
  }, SETUP);

  describe("the lock that makes copies take turns", () => {
    it("ends with its transaction and leaves nothing behind", async () => {
      await coldStart();
      const { rows } = await db.query(
        `SELECT 1
           FROM pg_locks l
           JOIN pg_database d ON d.oid = l.database
          WHERE l.locktype = 'advisory' AND d.datname = $1`,
        [databaseName]
      );
      expect(rows).toEqual([]);
    }, SLOW);

    it("is taken inside a transaction, after a limit on how long to wait for it", async () => {
      const instance = await newInstance();
      const realConnect = instance.metadataPool.connect.bind(instance.metadataPool);
      const sent: string[][] = [];
      const connect = jest.spyOn(instance.metadataPool, "connect").mockImplementation(async () => {
        const client = await realConnect();
        const log: string[] = [];
        sent.push(log);
        return {
          ...client,
          query: ((text: string, values?: unknown[]) => {
            log.push(text);
            return client.query(text, values);
          }) as typeof client.query,
        };
      });

      await instance.bootstrap.syncMetadataTables();
      connect.mockRestore();

      expect(sent[0][0]).toBe("BEGIN");
      expect(sent[0][1]).toMatch(/SET LOCAL lock_timeout/);
      expect(sent[0][1]).toMatch(/SET LOCAL idle_in_transaction_session_timeout/);
      expect(sent[0][2]).toMatch(/pg_advisory_xact_lock/);
      expect(sent[0][sent[0].length - 1]).toBe("COMMIT");
      expect(sent.flat().filter((text) => /pg_advisory_lock\b/.test(text))).toEqual([]);
    }, SLOW);

    it("makes a second copy wait, then lets it finish", async () => {
      const first = await coldStart();
      const holder = await holdTheLock(first.bootstrap.BOOTSTRAP_LOCK_KEY);
      await dropIndex();

      const second = await newInstance();
      let finished = false;
      const boot = second.bootstrap.syncMetadataTables().then(() => {
        finished = true;
      });
      await until("the second copy to reach the lock", someoneIsWaitingForTheLock);
      expect(finished).toBe(false);
      expect(await indexExists()).toBe(false);

      await holder.query("COMMIT");
      await boot;
      expect(await indexExists()).toBe(true);
    }, SLOW);

    it("gives up with an error instead of waiting for ever, and the next try works", async () => {
      const first = await coldStart();
      const holder = await holdTheLock(first.bootstrap.BOOTSTRAP_LOCK_KEY);

      // The real limit is two minutes. Only the number is changed: this still goes
      // through the app's own statements and its own way of failing.
      const second = await newInstance();
      const realConnect = second.metadataPool.connect.bind(second.metadataPool);
      const connect = jest.spyOn(second.metadataPool, "connect").mockImplementation(async () => {
        const client = await realConnect();
        return {
          ...client,
          query: ((text: string, values?: unknown[]) =>
            client.query(text.replace("lock_timeout = '120s'", "lock_timeout = '200ms'"), values)
          ) as typeof client.query,
        };
      });

      await expect(second.bootstrap.syncMetadataTables()).rejects.toMatchObject({ code: "55P03" });

      await holder.query("COMMIT");
      await expect(second.bootstrap.syncMetadataTables()).resolves.toBeUndefined();
      connect.mockRestore();
    }, SLOW);
  });

  describe("skipping the job once a deployment has done it", () => {
    it("writes the deployment down at the end of its first boot", async () => {
      await coldStart("dpl_one");
      expect(await stamps()).toEqual(["dpl_one"]);
    }, SLOW);

    it("skips the work on the next cold start of that deployment", async () => {
      await coldStart("dpl_one");
      await dropIndex();

      const next = await newInstance();
      const connect = jest.spyOn(next.metadataPool, "connect");
      const sent = jest.spyOn(next.metadataPool, "query");
      await next.bootstrap.syncMetadataTables();

      // No lock, no transaction: one read, and on with the request.
      expect(connect).not.toHaveBeenCalled();
      expect(sent).toHaveBeenCalledTimes(1);
      expect(await indexExists()).toBe(false);
      connect.mockRestore();
      sent.mockRestore();
    }, SLOW);

    it("does the work again for a new deployment, which may have new tables to make", async () => {
      await coldStart("dpl_one");
      await dropIndex();

      await coldStart("dpl_two");

      expect(await indexExists()).toBe(true);
      expect(await stamps()).toEqual(["dpl_one", "dpl_two"]);
    }, SLOW);

    it("skips the work when another copy finished it during the wait for the lock", async () => {
      const first = await coldStart();
      const holder = await holdTheLock(first.bootstrap.BOOTSTRAP_LOCK_KEY);

      setStamp("dpl_one");
      const second = await newInstance();
      const boot = second.bootstrap.syncMetadataTables();
      await until("the second copy to reach the lock", someoneIsWaitingForTheLock);

      await holder.query(`INSERT INTO metadata_boot_stamps (stamp) VALUES ('dpl_one')`);
      await dropIndex(holder);
      await holder.query("COMMIT");
      await boot;

      expect(await indexExists()).toBe(false);
    }, SLOW);

    it("writes nothing when the boot fails, so the next try does the whole job", async () => {
      await coldStart();
      await dropIndex();

      setStamp("dpl_one");
      const next = await newInstance();
      const sync = jest.spyOn(next.sequelize, "sync").mockRejectedValueOnce(new Error("boom"));

      await expect(next.bootstrap.syncMetadataTables()).rejects.toThrow("boom");
      expect(await stamps()).toEqual([]);
      expect(await indexExists()).toBe(false);

      await next.bootstrap.syncMetadataTables();
      sync.mockRestore();
      expect(await stamps()).toEqual(["dpl_one"]);
      expect(await indexExists()).toBe(true);
    }, SLOW);

    it("does the whole job when the table of stamps has gone", async () => {
      await coldStart("dpl_one");
      await dropIndex();
      await db.query(`DROP TABLE metadata_boot_stamps`);

      await coldStart("dpl_one");

      expect(await indexExists()).toBe(true);
      expect(await stamps()).toEqual(["dpl_one"]);
    }, SLOW);

    it("changes nothing on a server with no deployment id, such as the Docker copy", async () => {
      await coldStart();
      expect(await stamps()).toEqual([]);
      await dropIndex();

      await coldStart();

      expect(await indexExists()).toBe(true);
      expect(await stamps()).toEqual([]);
    }, SLOW);

    it("does not trust a blank deployment id", async () => {
      await coldStart("   ");
      expect(await stamps()).toEqual([]);
    }, SLOW);
  });

  describe("closing the tables to Supabase's Data API", () => {
    // `anon` belongs to the whole server, so these tests make it, and remove it
    // only if they were the ones to make it. Other test files running at the same
    // moment connect as a superuser, which row security does not affect.
    async function withAnon<T>(run: () => Promise<T>): Promise<T> {
      if (!anonExisted) await server.query(`CREATE ROLE ${ANON} NOLOGIN`);
      try {
        return await run();
      } finally {
        await db.query(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${ANON}`).catch(() => {});
        // The role cannot go while a database it had rights in is still there.
        await server.query(`DROP OWNED BY ${ANON}`).catch(() => {});
        if (!anonExisted) await server.query(`DROP ROLE IF EXISTS ${ANON}`).catch(() => {});
      }
    }

    it("leaves a plain Postgres as it was", async () => {
      // Row security is a Supabase matter here. The Docker copy's tables, and every
      // other test's view of them, stay as they have always been.
      if (anonExisted) return;
      await coldStart();
      const tables = await tablesWithoutRowSecurity();
      expect(tables).toContain("connections");
      expect(tables).toContain("profiles");
      const { rows } = await db.query(
        `SELECT count(*)::int AS closed
           FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity`
      );
      expect(rows[0].closed).toBe(0);
    }, SLOW);

    it("closes every table the app has, so none can be forgotten", async () => {
      await withAnon(async () => {
        await coldStart();
        expect(await tablesWithoutRowSecurity()).toEqual([]);
      });
    }, SLOW);

    it("stops the public role reading a table even when it has been granted", async () => {
      await withAnon(async () => {
        await coldStart();
        // What Supabase did by default to every new table until this year.
        await db.query(`GRANT SELECT ON organizations TO ${ANON}`);

        await db.query("BEGIN");
        await db.query(`SET LOCAL ROLE ${ANON}`);
        const asAnon = await db.query(`SELECT id FROM organizations`);
        await db.query("ROLLBACK");
        expect(asAnon.rows).toEqual([]);

        const asApp = await db.query(`SELECT id FROM organizations`);
        expect(asApp.rows.length).toBeGreaterThan(0);
      });
    }, SLOW);

    it("leaves a table that is not the app's alone", async () => {
      await withAnon(async () => {
        await db.query(`CREATE TABLE someone_elses_table (id int)`);
        await coldStart();
        expect(await tablesWithoutRowSecurity()).toEqual(["someone_elses_table"]);
      });
    }, SLOW);

    it("sends nothing on later boots when it is already closed", async () => {
      await withAnon(async () => {
        await coldStart();

        const next = await newInstance();
        const sent = jest.spyOn(next.metadataPool, "query");
        await next.bootstrap.syncMetadataTables();

        expect(statementsSentBy(sent, /ENABLE ROW LEVEL SECURITY/)).toBe(0);
        sent.mockRestore();
      });
    }, SLOW);

    it("closes a table that was opened again, and only that one", async () => {
      await withAnon(async () => {
        await coldStart();
        await db.query(`ALTER TABLE connections DISABLE ROW LEVEL SECURITY`);

        const next = await newInstance();
        const sent = jest.spyOn(next.metadataPool, "query");
        await next.bootstrap.syncMetadataTables();

        expect(statementsSentBy(sent, /ENABLE ROW LEVEL SECURITY/)).toBe(1);
        expect(await tablesWithoutRowSecurity()).toEqual([]);
        sent.mockRestore();
      });
    }, SLOW);

    it("still works as a login that owns the database but is no superuser, as on Supabase", async () => {
      // A superuser ignores row security, so only this shows the app can still read
      // its own tables with it on. Being the tables' owner is what lets it through.
      const owner = `boot_owner_${numbered}`;
      const ownedName = `${baseName}_boot_owned_${numbered}`;
      await withAnon(async () => {
        await server.query(`CREATE ROLE ${owner} LOGIN PASSWORD '${randomUUID()}'`);
        await server.query(`DROP DATABASE IF EXISTS ${quoteIdent(ownedName)} WITH (FORCE)`);
        await server.query(`CREATE DATABASE ${quoteIdent(ownedName)} OWNER ${owner}`);
        const url = new URL(urlFor(ownedName));
        url.username = owner;
        const superuserView = await connectTo(urlFor(ownedName));
        let instance: Instance | undefined;
        try {
          instance = await newInstance(url.toString());
          await instance.bootstrap.syncMetadataTables();

          expect(await tablesWithoutRowSecurity(superuserView)).toEqual([]);
          const { rows } = await instance.metadataPool.query(`SELECT id FROM organizations`);
          expect(rows.length).toBeGreaterThan(0);
          const who = await instance.metadataPool.query(
            `SELECT rolsuper FROM pg_roles WHERE rolname = current_user`
          );
          expect(who.rows[0].rolsuper).toBe(false);
        } finally {
          instances = instances.filter((item) => item !== instance);
          if (instance) await closeInstance(instance);
          await superuserView.end();
          await server.query(`DROP DATABASE IF EXISTS ${quoteIdent(ownedName)} WITH (FORCE)`);
          await server.query(`DROP ROLE IF EXISTS ${owner}`);
        }
      });
    }, SLOW);
  });

  describe("an index of the same name on a table in another schema", () => {
    const TRACKING_KEY = "tracked_schemas_connection_id_schema_name_key";

    async function indexesIn(schema: string): Promise<string[]> {
      const { rows } = await db.query(
        `SELECT tablename || '.' || indexname AS name
           FROM pg_indexes WHERE schemaname = $1 ORDER BY 1`,
        [schema]
      );
      return rows.map((row: { name: string }) => row.name);
    }

    // Tracking a schema relies on this key. Postgres looks for it when planning the
    // statement, so asking with no rows at all is enough to find it missing. This
    // is the statement that came back as a 500 on a real Supabase project.
    async function tryTrackingStatement(): Promise<void> {
      await db.query(
        `INSERT INTO tracked_schemas (org_id, connection_id, schema_name, label)
         SELECT org_id, id, 'shop', 'shop' FROM connections WHERE false
         ON CONFLICT (connection_id, schema_name) DO NOTHING`
      );
    }

    it("still makes the app's own, and leaves the other table's alone", async () => {
      await db.query(`CREATE SCHEMA old_copy`);
      await db.query(
        `CREATE TABLE old_copy.tracked_schemas (connection_id integer, schema_name text)`
      );
      await db.query(
        `CREATE UNIQUE INDEX ${TRACKING_KEY} ON old_copy.tracked_schemas (connection_id, schema_name)`
      );

      await coldStart();

      expect(await indexesIn("public")).toContain(`tracked_schemas.${TRACKING_KEY}`);
      await expect(tryTrackingStatement()).resolves.toBeUndefined();
      expect(await indexesIn("old_copy")).toEqual([`tracked_schemas.${TRACKING_KEY}`]);
    }, SLOW);

    it("builds the whole set again after every table has been moved aside", async () => {
      await coldStart();
      const built = await indexesIn("public");
      expect(built.length).toBeGreaterThan(0);

      // Moved, not copied, so every index keeps its name. Starting over this way
      // loses nothing, and a boot has to treat the result as an empty database.
      const { rows } = await db.query(`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`);
      await db.query(`CREATE SCHEMA moved_aside`);
      for (const { tablename } of rows as { tablename: string }[]) {
        await db.query(`ALTER TABLE ${quoteIdent(tablename)} SET SCHEMA moved_aside`);
      }
      expect(await indexesIn("public")).toEqual([]);

      await coldStart();

      expect(await indexesIn("public")).toEqual(built);
      expect(await indexesIn("moved_aside")).toEqual(built);
      await expect(tryTrackingStatement()).resolves.toBeUndefined();
    }, SLOW);

    it("has nothing to do on a later boot", async () => {
      // addIndex has no IF NOT EXISTS, so making one twice would fail the boot.
      await coldStart();
      const built = await indexesIn("public");
      await coldStart();
      expect(await indexesIn("public")).toEqual(built);
    }, SLOW);
  });
});
