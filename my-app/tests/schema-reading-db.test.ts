// schema-reading-db: fetchSchemaSnapshot on a real PostgreSQL, with one of
// every kind of object the app reads.
//
// The schema reader is raw SQL against PostgreSQL's own catalog (pg_class,
// pg_attribute, pg_constraint and the rest), and the catalog changes a little
// between major versions. So CI runs this file on every PostgreSQL from 13 to
// 18 (the "schema-reading" job in .github/workflows/ci.yml), and a query that
// names a column an older server does not have fails here, not on someone's
// database.
//
// Everything below works on PostgreSQL 13. Objects only newer servers have
// belong in their own case, skipped on older ones.
//
// Needs TEST_DATABASE_URL (see tests/helpers/test-database.ts), and skips
// without it. It makes one database of its own and drops it at the end.

import { Client, type ClientConfig } from "pg";
import { fetchSchemaSnapshot, getPoolForConfig, type SchemaSnapshot } from "@/lib/postgres";
import { testDatabaseUrl } from "./helpers/test-database";

const testUrl = testDatabaseUrl();
const describeWithDatabase = testUrl ? describe : describe.skip;

const SETUP = 120_000;
const SLOW = 60_000;
const SCHEMA = "shop";

const DDL = `
  CREATE TYPE mood AS ENUM ('sad', 'ok', 'happy');
  CREATE DOMAIN positive_int AS integer CHECK (VALUE > 0);
  CREATE TYPE address AS (street text, city text);
  CREATE TYPE float_range AS RANGE (subtype = float8);
  CREATE COLLATION shop_c FROM "C";
  CREATE SEQUENCE invoice_no START 1000 INCREMENT 5;

  CREATE TABLE customers (
    id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    email text NOT NULL,
    name text COLLATE shop_c,
    feeling mood DEFAULT 'ok',
    home address,
    CONSTRAINT customers_email_key UNIQUE (email),
    CONSTRAINT customers_email_check CHECK (email LIKE '%@%')
  );

  CREATE TABLE orders (
    id bigserial PRIMARY KEY,
    customer_id integer NOT NULL REFERENCES customers (id) ON DELETE CASCADE,
    qty positive_int NOT NULL,
    price numeric(10, 2) NOT NULL,
    total numeric GENERATED ALWAYS AS (qty * price) STORED,
    during tsrange,
    CONSTRAINT orders_no_overlap EXCLUDE USING gist (during WITH &&)
  );
  CREATE INDEX orders_big ON orders (price) WHERE price > 100;
  CREATE INDEX customers_lower_email ON customers (lower(email));

  CREATE TABLE events (id integer NOT NULL, at date NOT NULL) PARTITION BY RANGE (at);
  CREATE TABLE events_2026 PARTITION OF events FOR VALUES FROM ('2026-01-01') TO ('2027-01-01');

  CREATE VIEW big_orders AS SELECT id, price FROM orders WHERE price > 100;
  CREATE MATERIALIZED VIEW order_totals AS
    SELECT customer_id, sum(total) AS spent FROM orders GROUP BY customer_id;

  CREATE FUNCTION touch() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    RETURN NEW;
  END
  $$;
  CREATE PROCEDURE forget(days integer) LANGUAGE sql AS $$
    DELETE FROM orders WHERE id < 0
  $$;
  CREATE TRIGGER orders_touch BEFORE UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION touch();

  ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
  CREATE POLICY own_orders ON orders FOR SELECT USING (customer_id > 0);

  GRANT SELECT ON customers TO PUBLIC;
`;

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

describeWithDatabase("reading a schema on a real PostgreSQL", () => {
  let server: Client;
  let db: Client;
  let config: ClientConfig;
  let databaseName = "";
  let snapshot: SchemaSnapshot;

  async function read(): Promise<SchemaSnapshot> {
    const answer = await fetchSchemaSnapshot(config, SCHEMA);
    if (!answer.ok) throw new Error(`Could not read the schema: ${answer.error}`);
    return answer.data;
  }

  function table(name: string) {
    const found = snapshot.tables.find((t) => t.name === name);
    if (!found) throw new Error(`The snapshot has no table "${name}".`);
    return found;
  }

  beforeAll(async () => {
    const url = new URL(testUrl);
    const baseName = decodeURIComponent(url.pathname.slice(1));
    if (!/test/i.test(baseName)) {
      throw new Error(
        `TEST_DATABASE_URL names "${baseName}". These tests create and drop a database, ` +
          `so they only run against one whose name contains "test".`
      );
    }
    server = new Client({ connectionString: testUrl });
    await server.connect();
    const version = await server.query<{ v: string }>("SHOW server_version");
    // Says in the log which PostgreSQL this run read.
    console.log(`Reading a schema on PostgreSQL ${version.rows[0].v}`);

    databaseName = `${baseName}_schema_reading`;
    // Not DROP DATABASE ... WITH (FORCE): nothing else connects to this one.
    await server.query(`DROP DATABASE IF EXISTS ${quoteIdent(databaseName)}`);
    await server.query(`CREATE DATABASE ${quoteIdent(databaseName)}`);
    config = {
      host: url.hostname,
      port: Number(url.port || 5432),
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      database: databaseName,
    };
    db = new Client(config);
    await db.connect();
    await db.query(`CREATE SCHEMA ${SCHEMA}`);
    await db.query(`BEGIN; SET LOCAL search_path TO ${SCHEMA}; ${DDL}; COMMIT;`);
    snapshot = await read();
  }, SETUP);

  afterAll(async () => {
    if (config) await getPoolForConfig(config).end();
    await db?.end();
    if (databaseName) await server?.query(`DROP DATABASE IF EXISTS ${quoteIdent(databaseName)}`);
    await server?.end();
  }, SETUP);

  it("names the database and the schema it read", () => {
    expect(snapshot.database).toBe(databaseName);
    expect(snapshot.schema).toBe(SCHEMA);
  });

  it("finds every table, partitions included", () => {
    expect(snapshot.tables.map((t) => t.name).sort()).toEqual(
      ["customers", "events", "events_2026", "orders"].sort()
    );
    expect(table("events").partitioning?.strategy).toBe("RANGE");
    expect(table("events_2026").partitioning?.partitionOf).toBe("events");
  });

  it("reads columns: identity, generated, defaults, domains and composites", () => {
    const customers = table("customers");
    expect(customers.columns.map((c) => c.name)).toEqual(["id", "email", "name", "feeling", "home"]);
    expect(customers.columns[0].identity).toBe("ALWAYS");
    expect(customers.columns[1].nullable).toBe(false);
    expect(customers.columns[3].columnDefault).toContain("ok");

    const total = table("orders").columns.find((c) => c.name === "total");
    expect(total?.generated?.storage).toBe("STORED");
    expect(total?.generated?.expression).toMatch(/qty/);
  });

  it("reads keys and constraints of every kind", () => {
    const customers = table("customers");
    const orders = table("orders");
    expect(customers.primaryKey?.columns).toEqual(["id"]);
    expect(customers.uniqueConstraints.map((c) => c.name)).toContain("customers_email_key");
    expect(customers.checkConstraints.map((c) => c.name)).toContain("customers_email_check");
    expect(orders.excludeConstraints.map((c) => c.name)).toEqual(["orders_no_overlap"]);

    expect(orders.foreignKeys).toHaveLength(1);
    expect(orders.foreignKeys[0]).toMatchObject({
      columns: ["customer_id"],
      referencedTable: "customers",
      referencedColumns: ["id"],
      onDelete: "CASCADE",
    });
  });

  it("reads indexes, triggers and row security", () => {
    const orders = table("orders");
    const indexes = orders.indexes ?? [];
    expect(indexes.find((i) => i.name === "orders_big")?.predicate).toMatch(/price/);
    expect((table("customers").indexes ?? []).map((i) => i.name)).toContain("customers_lower_email");

    expect((orders.triggers ?? []).map((t) => t.name)).toEqual(["orders_touch"]);
    expect(orders.rowSecurity?.enabled).toBe(true);
    expect(orders.rowSecurity?.policies.map((p) => p.name)).toEqual(["own_orders"]);
  });

  it("reads views and materialized views", () => {
    const views = snapshot.views ?? [];
    expect(views.find((v) => v.name === "big_orders")?.materialized).toBe(false);
    expect(views.find((v) => v.name === "order_totals")?.materialized).toBe(true);
    expect(views.find((v) => v.name === "big_orders")?.columns).toEqual(["id", "price"]);
  });

  it("reads types, collations and sequences", () => {
    const types = snapshot.types ?? [];
    const kindOf = (name: string) => types.find((t) => t.name === name)?.kind;
    expect(kindOf("mood")).toBe("ENUM");
    expect(types.find((t) => t.name === "mood")?.labels).toEqual(["sad", "ok", "happy"]);
    expect(kindOf("positive_int")).toBe("DOMAIN");
    expect(types.find((t) => t.name === "positive_int")?.baseType).toBe("integer");
    expect(kindOf("address")).toBe("COMPOSITE");
    expect(kindOf("float_range")).toBe("RANGE");

    expect((snapshot.collations ?? []).map((c) => c.name)).toContain("shop_c");
    const invoice = (snapshot.sequences ?? []).find((s) => s.name === "invoice_no");
    expect(invoice).toBeDefined();
    expect(invoice?.ownedByTable).toBeNull();
  });

  it("reads functions and procedures", () => {
    const routines = snapshot.routines ?? [];
    expect(routines.find((r) => r.name === "touch")?.kind).toBe("FUNCTION");
    expect(routines.find((r) => r.name === "forget")?.kind).toBe("PROCEDURE");
  });

  it("reads who may do what", () => {
    const customers = (snapshot.privileges ?? []).find(
      (p) => p.objectKind === "TABLE" && p.objectName === "customers"
    );
    expect(customers?.grants).toEqual(
      expect.arrayContaining([expect.objectContaining({ grantee: "PUBLIC", privileges: ["SELECT"] })])
    );
  });

  it(
    "reads the same schema the same way twice",
    async () => {
      expect(await read()).toEqual(snapshot);
    },
    SLOW
  );
});
