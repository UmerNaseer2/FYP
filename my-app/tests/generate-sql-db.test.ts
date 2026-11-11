// generate-sql-db: the generated SQL, run on a real PostgreSQL.
//
// Every other generate-sql suite checks the text of the script. Only
// PostgreSQL can say whether it accepts that text in that order, and whether
// the schema reader sees a real catalog the way the tests' hand-made
// snapshots describe one. So each case here builds a source and a target
// schema in two real databases and goes the whole way round:
//
//   read both -> compare -> write the script -> run it on the target
//   -> read the target again -> the two schemas must now be level
//   -> run the rollback -> the target must be back where it started
//
// It needs a Postgres it may create and drop databases in, so it runs only when
// TEST_DATABASE_URL is set (CI sets it, and fails rather than skip without it:
// see tests/helpers/test-database.ts), and only against a database whose name
// contains "test". tests/invites-db.test.ts shows how to start one locally.
import { Client, type ClientConfig } from "pg";
import { compareSchemas } from "@/lib/compare";
import {
  generateMigration,
  generateRollback,
  renderMigrationScript,
  renderRollbackScript,
  statementsThatRun,
} from "@/lib/generate-sql";
import { fetchSchemaSnapshot, getPoolForConfig, type SchemaSnapshot } from "@/lib/postgres";
import { testDatabaseUrl } from "./helpers/test-database";

const testUrl = testDatabaseUrl();
const describeWithDatabase = testUrl ? describe : describe.skip;

const SLOW = 60_000;
const SETUP = 120_000;
const SCHEMA = "shop";

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

describeWithDatabase("the generated SQL on a real PostgreSQL", () => {
  let server: Client;
  let source: Client;
  let target: Client;
  let sourceConfig: ClientConfig;
  let targetConfig: ClientConfig;
  const databases: string[] = [];

  /** The connection settings for one database on the test server. */
  function configFor(database: string): ClientConfig {
    const url = new URL(testUrl);
    return {
      host: url.hostname,
      port: Number(url.port || 5432),
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      database,
    };
  }

  /** Empties the schema in one database and builds it again from `ddl`. */
  async function build(db: Client, ddl: string): Promise<void> {
    await db.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA};`);
    await db.query(`BEGIN; SET LOCAL search_path TO ${SCHEMA}; ${ddl}; COMMIT;`);
  }

  async function read(config: ClientConfig): Promise<SchemaSnapshot> {
    const answer = await fetchSchemaSnapshot(config, SCHEMA);
    if (!answer.ok) throw new Error(`Could not read the schema: ${answer.error}`);
    return answer.data;
  }

  /** Runs a script on the target the way Deploy does: one transaction, in the schema. */
  async function runOnTarget(script: string): Promise<void> {
    try {
      await target.query(`BEGIN; SET LOCAL search_path TO ${SCHEMA};`);
      await target.query(script);
      await target.query("COMMIT");
    } catch (error) {
      await target.query("ROLLBACK");
      throw new Error(
        `PostgreSQL refused the script: ${error instanceof Error ? error.message : error}\n\n${script}`
      );
    }
  }

  /** The labels of one enum type, in order, as the schema reader saw them. */
  function enumLabels(snapshot: SchemaSnapshot, name: string): string[] | undefined {
    return snapshot.types?.find((type) => type.kind === "ENUM" && type.name === name)?.labels;
  }

  /** What a script would still have to run to make `to` look like `from`. */
  function stillToDo(from: SchemaSnapshot, to: SchemaSnapshot): string[] {
    const script = generateMigration(compareSchemas(from, to), { allowDataLoss: true });
    return statementsThatRun(script).map((statement) => statement.sql);
  }

  /**
   * The whole way round for one pair of schemas. Returns the script that was
   * run, so a case can also check what is in it.
   */
  async function roundTrip(sourceDdl: string, targetDdl: string): Promise<string> {
    await build(source, sourceDdl);
    await build(target, targetDdl);
    const wanted = await read(sourceConfig);
    const before = await read(targetConfig);
    const report = compareSchemas(wanted, before);
    const options = { allowDataLoss: true };

    const script = renderMigrationScript(generateMigration(report, options));
    await runOnTarget(script);
    expect(stillToDo(wanted, await read(targetConfig))).toEqual([]);

    await runOnTarget(renderRollbackScript(generateRollback(report, options)));
    expect(stillToDo(before, await read(targetConfig))).toEqual([]);
    return script;
  }

  beforeAll(async () => {
    const baseName = decodeURIComponent(new URL(testUrl).pathname.slice(1));
    if (!/test/i.test(baseName)) {
      throw new Error(
        `TEST_DATABASE_URL names "${baseName}". These tests create and drop databases, ` +
          `so they only run against one whose name contains "test".`
      );
    }
    server = new Client({ connectionString: testUrl });
    await server.connect();
    for (const side of ["source", "target"]) {
      const name = `${baseName}_gensql_${side}`;
      await server.query(`DROP DATABASE IF EXISTS ${quoteIdent(name)} WITH (FORCE)`);
      await server.query(`CREATE DATABASE ${quoteIdent(name)}`);
      databases.push(name);
    }
    sourceConfig = configFor(databases[0]);
    targetConfig = configFor(databases[1]);
    source = new Client(sourceConfig);
    target = new Client(targetConfig);
    await source.connect();
    await target.connect();
  }, SETUP);

  afterAll(async () => {
    await getPoolForConfig(sourceConfig).end();
    await getPoolForConfig(targetConfig).end();
    await source?.end();
    await target?.end();
    for (const name of databases) {
      await server.query(`DROP DATABASE IF EXISTS ${quoteIdent(name)} WITH (FORCE)`);
    }
    await server?.end();
  }, SETUP);

  it(
    "brings a target level with new tables, columns, types, indexes and a view, and back",
    async () => {
      const script = await roundTrip(
        `CREATE TYPE order_status AS ENUM ('new', 'paid', 'sent');
         CREATE TABLE customers (
           id serial PRIMARY KEY,
           email text NOT NULL UNIQUE,
           name varchar(120) NOT NULL,
           joined_on date NOT NULL DEFAULT CURRENT_DATE
         );
         CREATE TABLE orders (
           id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
           customer_id integer NOT NULL REFERENCES customers (id),
           status order_status NOT NULL DEFAULT 'new',
           total numeric(10, 2) NOT NULL CHECK (total >= 0)
         );
         CREATE INDEX orders_customer_idx ON orders (customer_id);
         CREATE INDEX customers_lower_email_idx ON customers (lower(email));
         CREATE VIEW paid_orders AS SELECT id, customer_id, total FROM orders WHERE status = 'paid'`,
        `CREATE TABLE customers (
           id serial PRIMARY KEY,
           email text,
           name varchar(60) NOT NULL
         )`
      );
      expect(script).toContain("CREATE TABLE");
    },
    SLOW
  );

  it(
    "drops what only the target has, and puts it back",
    async () => {
      await roundTrip(
        `CREATE TABLE books (id serial PRIMARY KEY, title text NOT NULL)`,
        `CREATE TABLE books (
           id serial PRIMARY KEY,
           title text NOT NULL,
           old_code varchar(10) DEFAULT 'none'
         );
         CREATE TABLE old_stock (id serial PRIMARY KEY, book_id integer REFERENCES books (id), amount integer NOT NULL);
         CREATE INDEX books_old_code_idx ON books (old_code)`
      );
    },
    SLOW
  );

  it.each([
    ["a serial key", "id serial PRIMARY KEY"],
    ["an identity key", "id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY"],
  ])(
    "renames a table that has %s",
    async (_label, key) => {
      const script = await roundTrip(
        `CREATE TABLE customers (${key}, name text NOT NULL, email text)`,
        `CREATE TABLE customer (${key}, name text NOT NULL, email text)`
      );
      expect(script).toContain(`ALTER TABLE IF EXISTS "customer" RENAME TO "customers"`);
    },
    SLOW
  );

  it(
    "changes a column type that a view reads",
    async () => {
      await roundTrip(
        `CREATE TABLE items (id serial PRIMARY KEY, price numeric(12, 2) NOT NULL, label text);
         CREATE VIEW dear_items AS SELECT id, price FROM items WHERE price > 100`,
        `CREATE TABLE items (id serial PRIMARY KEY, price integer NOT NULL, label text);
         CREATE VIEW dear_items AS SELECT id, price FROM items WHERE price > 100`
      );
    },
    SLOW
  );

  // A nextval default makes a column a serial only when the column OWNS the
  // sequence. The cases below are defaults on standalone sequences, which are
  // plain defaults: set like any other, and the sequence is left alone.

  it(
    "moves a default from one standalone sequence to another before dropping the old one",
    async () => {
      const script = await roundTrip(
        `CREATE SEQUENCE other_seq;
         CREATE TABLE o (id integer NOT NULL DEFAULT nextval('other_seq'))`,
        `CREATE SEQUENCE plain_seq;
         CREATE TABLE o (id integer NOT NULL DEFAULT nextval('plain_seq'))`
      );
      const setDefault = script.indexOf(`SET DEFAULT nextval('other_seq'`);
      const dropOld = script.indexOf(`DROP SEQUENCE IF EXISTS "plain_seq"`);
      expect(setDefault).toBeGreaterThan(-1);
      expect(dropOld).toBeGreaterThan(setDefault);
    },
    SLOW
  );

  it(
    "sees a default that reads a different standalone sequence, with both on both sides",
    async () => {
      const sequences = `CREATE SEQUENCE seq_a; CREATE SEQUENCE seq_b;`;
      const script = await roundTrip(
        `${sequences} CREATE TABLE t (id integer NOT NULL DEFAULT nextval('seq_a'))`,
        `${sequences} CREATE TABLE t (id integer NOT NULL DEFAULT nextval('seq_b'))`
      );
      expect(script).toContain(`SET DEFAULT nextval('seq_a'`);
    },
    SLOW
  );

  it(
    "gives a column a default on a shared sequence without taking the sequence over",
    async () => {
      const script = await roundTrip(
        `CREATE SEQUENCE shared_seq;
         CREATE TABLE a (id integer NOT NULL DEFAULT nextval('shared_seq'));
         CREATE TABLE b (id integer NOT NULL DEFAULT nextval('shared_seq'))`,
        `CREATE SEQUENCE shared_seq;
         CREATE TABLE a (id integer NOT NULL);
         CREATE TABLE b (id integer NOT NULL DEFAULT nextval('shared_seq'));
         INSERT INTO a VALUES (500);
         SELECT setval('shared_seq', 7)`
      );
      expect(script).toContain(`SET DEFAULT nextval('shared_seq'`);
      expect(script).not.toContain("OWNED BY");
      expect(script).not.toContain("setval");
      expect(script).not.toContain("CREATE SEQUENCE");

      // The sequence still belongs to no column and its value was not moved.
      const owned = await target.query(
        `SELECT 1 FROM pg_depend d JOIN pg_class c ON c.oid = d.objid
          WHERE c.relname = 'shared_seq' AND c.relkind = 'S' AND d.deptype = 'a'`
      );
      expect(owned.rowCount).toBe(0);
      const value = await target.query(`SELECT last_value FROM ${SCHEMA}.shared_seq`);
      expect(String(value.rows[0].last_value)).toBe("7");
    },
    SLOW
  );

  it(
    "turns a default on a standalone sequence into a serial that owns it, and back",
    async () => {
      const script = await roundTrip(
        `CREATE TABLE t (id serial PRIMARY KEY, label text)`,
        `CREATE SEQUENCE t_id_seq;
         CREATE TABLE t (id integer PRIMARY KEY DEFAULT nextval('t_id_seq'), label text)`
      );
      expect(script).toContain(`OWNED BY "t"."id"`);
      expect(script).not.toContain("DROP SEQUENCE");
    },
    SLOW
  );

  it(
    "drops a serial's own sequence when the source reads a standalone sequence instead",
    async () => {
      const script = await roundTrip(
        `CREATE SEQUENCE ticket_numbers;
         CREATE TABLE t (id integer PRIMARY KEY DEFAULT nextval('ticket_numbers'), label text)`,
        `CREATE SEQUENCE ticket_numbers;
         CREATE TABLE t (id serial PRIMARY KEY, label text)`
      );
      expect(script).toContain(`SET DEFAULT nextval('ticket_numbers'`);
      expect(script).toContain(`DROP SEQUENCE IF EXISTS "t_id_seq"`);
    },
    SLOW
  );

  it(
    "unties a serial's sequence, keeping it, when the source has it as a standalone one",
    async () => {
      const script = await roundTrip(
        `CREATE SEQUENCE t_id_seq AS integer;
         CREATE SEQUENCE ticket_numbers;
         CREATE TABLE t (id integer PRIMARY KEY DEFAULT nextval('ticket_numbers'), label text)`,
        `CREATE SEQUENCE ticket_numbers;
         CREATE TABLE t (id serial PRIMARY KEY, label text)`
      );
      expect(script).toContain(`ALTER SEQUENCE IF EXISTS "t_id_seq" OWNED BY NONE`);
      expect(script).not.toContain("DROP SEQUENCE");
    },
    SLOW
  );

  // A plain unique index and a UNIQUE constraint share one set of names, so
  // the old index has to go before a constraint of the same name can be added.

  it(
    "swaps a plain unique index for a UNIQUE constraint of the same name",
    async () => {
      await roundTrip(
        `CREATE TABLE users (id integer PRIMARY KEY, email text, CONSTRAINT users_email_key UNIQUE (email))`,
        `CREATE TABLE users (id integer PRIMARY KEY, email text);
         CREATE UNIQUE INDEX users_email_key ON users (email)`
      );
    },
    SLOW
  );

  // PostgreSQL refuses DROP NOT NULL on a column that is still in a primary
  // key, so the old key has to be dropped first.

  it.each([
    [
      "a key that loses a column",
      `CREATE TABLE t (a integer, b integer, PRIMARY KEY (a))`,
      `CREATE TABLE t (a integer, b integer, PRIMARY KEY (a, b))`,
    ],
    [
      "a key that gains a column",
      `CREATE TABLE t (a integer, b integer, PRIMARY KEY (a, b))`,
      `CREATE TABLE t (a integer, b integer, PRIMARY KEY (a))`,
    ],
    [
      "a key that goes away",
      `CREATE TABLE t (a integer, b integer)`,
      `CREATE TABLE t (a integer, b integer, PRIMARY KEY (a))`,
    ],
  ])(
    "lets a column be empty again after %s",
    async (_label, sourceDdl, targetDdl) => {
      await roundTrip(sourceDdl, targetDdl);
    },
    SLOW
  );

  it(
    "reads enum labels that hold a comma, a double quote or a backslash",
    async () => {
      const labels = ["a, b", 'say "hi"', "back\\slash", "c"];
      await build(source, `CREATE TYPE e AS ENUM ('a, b', 'say "hi"', E'back\\\\slash', 'c')`);
      const snapshot = await read(sourceConfig);
      expect(enumLabels(snapshot, "e")).toEqual(labels);

      await roundTrip(
        `CREATE TYPE e AS ENUM ('a, b', 'say "hi"', E'back\\\\slash', 'c');
         CREATE TABLE t (id integer PRIMARY KEY, kind e NOT NULL DEFAULT 'a, b')`,
        `CREATE TABLE t (id integer PRIMARY KEY)`
      );
    },
    SLOW
  );

  it(
    "adds enum labels that hold a comma to a type the target already has",
    async () => {
      await build(source, `CREATE TYPE e AS ENUM ('a, b', 'c')`);
      await build(target, `CREATE TYPE e AS ENUM ('c')`);
      const wanted = await read(sourceConfig);
      const script = renderMigrationScript(
        generateMigration(compareSchemas(wanted, await read(targetConfig)), { allowDataLoss: true })
      );
      await runOnTarget(script);
      const after = await read(targetConfig);
      expect(enumLabels(after, "e")).toEqual(["a, b", "c"]);
      expect(stillToDo(wanted, after)).toEqual([]);
    },
    SLOW
  );

  // A foreign key is written from PostgreSQL's own text for it, so the parts
  // the snapshot does not hold one by one still arrive.

  it(
    "keeps the column list of ON DELETE SET NULL (columns) on a foreign key",
    async () => {
      const users = `CREATE TABLE users (tenant_id integer NOT NULL, id integer NOT NULL, PRIMARY KEY (tenant_id, id));`;
      const script = await roundTrip(
        `${users}
         CREATE TABLE posts (
           id integer PRIMARY KEY, tenant_id integer NOT NULL, author_id integer,
           CONSTRAINT posts_author_fk FOREIGN KEY (tenant_id, author_id)
             REFERENCES users (tenant_id, id) ON DELETE SET NULL (author_id)
         )`,
        `${users}
         CREATE TABLE posts (id integer PRIMARY KEY, tenant_id integer NOT NULL, author_id integer)`
      );
      expect(script).toContain("ON DELETE SET NULL (author_id)");
    },
    SLOW
  );

  it.each([
    ["has the column without a default", `CREATE TABLE t (id integer PRIMARY KEY, n integer)`],
    ["has no such table", `CREATE TABLE u (x integer)`],
    ["has the column as a plain serial", `CREATE TABLE t (id serial PRIMARY KEY, n integer)`],
  ])(
    "follows a default that reads another sequence than the one the column owns, when the target %s",
    async (_label, targetDdl) => {
      // A serial whose default was later pointed at another sequence: the
      // column still owns t_id_seq but reads other_seq.
      const sourceDdl = `CREATE TABLE t (id serial PRIMARY KEY, n integer);
         CREATE SEQUENCE other_seq;
         ALTER TABLE t ALTER COLUMN id SET DEFAULT nextval('other_seq')`;
      const script = await roundTrip(sourceDdl, targetDdl);
      expect(script).toContain(`nextval('other_seq'::regclass)`);
      expect(script).not.toContain(`"other_seq" OWNED BY`);
    },
    SLOW
  );

  it(
    "keeps PERIOD on a foreign key to a WITHOUT OVERLAPS key (PostgreSQL 18)",
    async () => {
      // Temporal keys arrived in PostgreSQL 18. An older server has nothing to check.
      const version = await server.query<{ num: string }>(
        "SELECT current_setting('server_version_num') AS num"
      );
      if (Number(version.rows[0].num) < 180000) return;

      const rooms = `CREATE TABLE rooms (
        room int4range, valid_at daterange,
        CONSTRAINT rooms_pk PRIMARY KEY (room, valid_at WITHOUT OVERLAPS)
      );`;
      const bookings = `CREATE TABLE bookings (id integer PRIMARY KEY, room int4range, valid_at daterange`;
      const script = await roundTrip(
        `${rooms}
         ${bookings},
           CONSTRAINT bookings_room_fk FOREIGN KEY (room, PERIOD valid_at)
             REFERENCES rooms (room, PERIOD valid_at)
         )`,
        `${rooms}
         ${bookings})`
      );
      expect(script).toContain("PERIOD valid_at");
    },
    SLOW
  );

  it(
    "keeps the column order of a foreign key whose columns are not in table order",
    async () => {
      const parent = `CREATE TABLE parent (x integer NOT NULL, y integer NOT NULL, UNIQUE (y, x));`;
      await roundTrip(
        `${parent}
         CREATE TABLE child (
           id integer PRIMARY KEY, p integer, q integer,
           CONSTRAINT child_parent_fk FOREIGN KEY (q, p) REFERENCES parent (y, x)
             ON UPDATE CASCADE ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
         );
         CREATE TABLE brand_new (
           id integer PRIMARY KEY, p integer, q integer,
           CONSTRAINT brand_new_parent_fk FOREIGN KEY (q, p) REFERENCES parent (y, x) MATCH FULL
         )`,
        `${parent}
         CREATE TABLE child (id integer PRIMARY KEY, p integer, q integer)`
      );
    },
    SLOW
  );
});
