// generate-sql-db-realistic: staging-ahead-of-production releases, run on a
// real PostgreSQL the way a person uses Compare & Alter and then Deploy.
//
// tests/generate-sql-db.test.ts goes the whole way round for small pairs with
// "allow data loss" ticked. This suite does the same for pairs shaped like a
// real release (source = staging, target = production with rows in it), and
// goes round TWICE per pair:
//
//   [allow data loss]  generateMigration(report, { allowDataLoss: true })
//   [page defaults]    generateMigration(report, { allowDataLoss: false }),
//                      which is what the Compare page sends until the person
//                      ticks the box (lib/compare/run.ts, compareOneTarget)
//
// After the deploy the target is read again and compared again with the same
// options. Nothing that RUNS may be left: a statement safe mode holds back is
// commented out and announced, so it does not count, but a live statement
// left over is the "3 changes left after the first deploy" a tester reported.
//
// The script is run the way app/api/scripts/apply runs it: the ledger table is
// created first, then one transaction with the deploy's search_path and
// check_function_bodies off.
//
// Needs TEST_DATABASE_URL, like the other real-database suites. It creates the
// cluster roles app_owner, app_rw, app_ro and rt_deployer and drops them again.
//
// Set RT_LOG_DIR to a folder to get each case's script, warnings and leftovers
// written there, and a sorted pg_dump of both sides when RT_PG_DUMP names the
// pg_dump binary.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client, type ClientConfig, type PoolClient } from "pg";
import { compareSchemas } from "@/lib/compare/diff";
import {
  generateMigration,
  generateRollback,
  renderMigrationScript,
  renderRollbackScript,
  statementsThatRun,
  type SqlStatement,
} from "@/lib/sql/generate";
import { fetchSchemaSnapshot, getPoolForConfig, type SchemaSnapshot } from "@/lib/postgres";
import { runSearchPath } from "@/lib/deploy/run-settings";
import { compareHelp } from "@/lib/help/compare";
import { enumAddValueTypeName, extractEnumAddValues } from "@/lib/sql/guard";
import { testDatabaseUrl } from "./helpers/test-database";

const testUrl = testDatabaseUrl();
const describeWithDatabase = testUrl ? describe : describe.skip;

const SLOW = 60_000;
const SETUP = 120_000;
const SCHEMA = "shop";
const DEPLOYER = "rt_deployer";
const logDir = process.env.RT_LOG_DIR ?? "";
const pgDump = process.env.RT_PG_DUMP ?? "";

type Mode = "armed" | "page";
const MODES: [string, Mode][] = [
  ["allow data loss", "armed"],
  ["page defaults", "page"],
];

type Release = {
  /** The schema both sides are built in. "public" is rebuilt, see PublicState. */
  schema?: string;
  source: string;
  target: string;
  /** Run on both databases as the superuser, before the schema is built. */
  setup?: string;
  sourceSetup?: string;
  targetSetup?: string;
  /** The role that owns the schema and everything the DDL creates. */
  sourceRole?: string;
  targetRole?: string;
  /** For schema "public": as PostgreSQL ships it, or dropped and created again. */
  sourcePublic?: PublicState;
  targetPublic?: PublicState;
  /** Deploy (and read the target) as the non-superuser login instead. */
  deployAsDeployer?: boolean;
  /** Leftover statements this case accepts, because the script said so. */
  mayBeLeft?: (statement: SqlStatement) => boolean;
  /** Skip the rollback half (a case that only looks at the deploy). */
  noRollback?: boolean;
};

type PublicState = "pristine" | "recreated";

type Outcome = {
  script: string;
  warnings: string[];
  statements: SqlStatement[];
  left: SqlStatement[];
};

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function slug(text: string): string {
  return text.replace(/[^a-z0-9]+/gi, "-").slice(0, 70);
}

describeWithDatabase("realistic releases on a real PostgreSQL", () => {
  let server: Client;
  let source: Client;
  let target: Client;
  let deployer: Client;
  let sourceConfig: ClientConfig;
  let targetConfig: ClientConfig;
  let deployerConfig: ClientConfig;
  const databases: string[] = [];

  function configFor(database: string, user?: string): ClientConfig {
    const url = new URL(testUrl);
    return {
      host: url.hostname,
      port: Number(url.port || 5432),
      user: user ?? decodeURIComponent(url.username),
      password: user ? "" : decodeURIComponent(url.password),
      database,
    };
  }

  /** Empties the schema in one database and builds it again from `ddl`. */
  async function build(
    db: Client,
    schema: string,
    ddl: string,
    options: { role?: string; setup?: string; publicState?: PublicState } = {}
  ): Promise<void> {
    const s = quoteIdent(schema);
    await db.query(`DROP SCHEMA IF EXISTS ${s} CASCADE`);
    if (options.setup) await db.query(options.setup);
    const owner = options.role ? ` AUTHORIZATION ${quoteIdent(options.role)}` : "";
    await db.query(`CREATE SCHEMA ${s}${owner}`);
    if (schema === "public" && (options.publicState ?? "pristine") === "pristine") {
      await db.query(
        `ALTER SCHEMA public OWNER TO pg_database_owner; GRANT USAGE ON SCHEMA public TO PUBLIC;`
      );
    }
    const role = options.role ? `SET LOCAL ROLE ${quoteIdent(options.role)};` : "";
    try {
      await db.query(`BEGIN; ${role} SET LOCAL search_path TO ${s}; ${ddl}; COMMIT;`);
    } catch (error) {
      await db.query("ROLLBACK");
      throw new Error(`The test's own DDL is wrong: ${error instanceof Error ? error.message : error}\n${ddl}`);
    }
  }

  async function read(config: ClientConfig, schema: string): Promise<SchemaSnapshot> {
    const answer = await fetchSchemaSnapshot(config, schema);
    if (!answer.ok) throw new Error(`Could not read the schema: ${answer.error}`);
    return answer.data;
  }

  /** What app/api/scripts/apply creates in the target schema before its transaction. */
  async function ensureLedger(db: Client, schema: string): Promise<void> {
    const s = quoteIdent(schema);
    await db.query(`
      CREATE TABLE IF NOT EXISTS ${s}.script_patch (
        id SERIAL PRIMARY KEY,
        script_name VARCHAR(150) NOT NULL DEFAULT 'unknown',
        version VARCHAR(20) NOT NULL,
        title VARCHAR(150),
        description TEXT,
        change_type VARCHAR(20) NOT NULL
          CHECK (change_type IN ('breaking', 'additive', 'patch', 'unknown')),
        source_ref TEXT, sql_content TEXT, down_sql TEXT,
        applied_by VARCHAR(320),
        applied_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      )`);
    await db.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS script_patch_name_version_idx ON ${s}.script_patch (script_name, version)`
    );
  }

  /** Runs a script the way Deploy does: one transaction, the deploy's settings. */
  async function runScript(db: Client, schema: string, script: string): Promise<void> {
    // Deploy adds enum values before its transaction opens, for a type that is
    // already there (addEnumValuesOutsideTransaction in the apply route).
    await db.query(`SET search_path TO ${quoteIdent(schema)}`);
    try {
      for (const statement of extractEnumAddValues(script)) {
        const type = enumAddValueTypeName(statement);
        if (!type) continue;
        const there = await db.query("SELECT to_regtype($1) IS NOT NULL AS present", [type]);
        if (there.rows[0].present) await db.query(statement);
      }
    } finally {
      await db.query("RESET search_path");
    }
    try {
      await db.query("BEGIN");
      const path = await runSearchPath(db as unknown as PoolClient, schema);
      await db.query(`SET LOCAL search_path TO ${path}`);
      await db.query("SET LOCAL check_function_bodies = off");
      await db.query(script);
      await db.query("COMMIT");
    } catch (error) {
      await db.query("ROLLBACK");
      const at = Number((error as { position?: string }).position);
      const near = Number.isFinite(at) && at > 0 ? `\n\nNEAR:\n${script.slice(Math.max(0, at - 300), at + 300)}` : "";
      const where = (error as { where?: string }).where;
      throw new Error(
        `PostgreSQL refused the script: ${error instanceof Error ? error.message : error}` +
          `${where ? `\nWHERE: ${where}` : ""}${near}`
      );
    }
  }

  function leftover(from: SchemaSnapshot, to: SchemaSnapshot, allowDataLoss: boolean): SqlStatement[] {
    return statementsThatRun(generateMigration(compareSchemas(from, to), { allowDataLoss }));
  }

  function note(label: string, mode: Mode, parts: Record<string, unknown>): void {
    if (!logDir) return;
    mkdirSync(logDir, { recursive: true });
    const text = Object.entries(parts)
      .map(([key, value]) => `==== ${key} ====\n${typeof value === "string" ? value : JSON.stringify(value, null, 2)}`)
      .join("\n\n");
    writeFileSync(join(logDir, `${slug(label)}.${mode}.txt`), text);
  }

  function dump(label: string, mode: Mode, schema: string): void {
    if (!logDir || !pgDump) return;
    for (const [side, config] of [["source", sourceConfig], ["target", targetConfig]] as const) {
      try {
        const out = execFileSync(
          pgDump,
          ["-s", "-h", String(config.host), "-p", String(config.port), "-U", String(config.user), "-n", schema, String(config.database)],
          { encoding: "utf8" }
        );
        const lines = out.split("\n").filter((l) => l.trim() && !l.startsWith("--") && !l.startsWith("\\")).sort();
        writeFileSync(join(logDir, `${slug(label)}.${mode}.dump-${side}.txt`), lines.join("\n"));
      } catch {
        // The dump is only a second opinion for whoever is reading the log.
      }
    }
  }

  let current = "";

  /** The whole way round for one release, in one mode. */
  async function roundTrip(release: Release, mode: Mode): Promise<Outcome> {
    const label = current;
    const schema = release.schema ?? SCHEMA;
    const allowDataLoss = mode === "armed";
    await build(source, schema, release.source, {
      role: release.sourceRole,
      setup: release.sourceSetup ?? release.setup,
      publicState: release.sourcePublic,
    });
    await build(target, schema, release.target, {
      role: release.deployAsDeployer ? DEPLOYER : release.targetRole,
      setup: release.targetSetup ?? release.setup,
      publicState: release.targetPublic,
    });
    const runner = release.deployAsDeployer ? deployer : target;
    const readTarget = release.deployAsDeployer ? deployerConfig : targetConfig;
    const accepted = release.mayBeLeft ?? (() => false);

    const wanted = await read(sourceConfig, schema);
    const before = await read(readTarget, schema);
    const report = compareSchemas(wanted, before);
    const migration = generateMigration(report, { allowDataLoss });
    const script = renderMigrationScript(migration);
    const rollback = generateRollback(report, { allowDataLoss });
    note(label, mode, { warnings: migration.warnings, script, rollbackWarnings: rollback.warnings, rollback: renderRollbackScript(rollback) });

    await ensureLedger(runner, schema);
    await runScript(runner, schema, script);
    const left = leftover(wanted, await read(readTarget, schema), allowDataLoss);
    note(label, mode, {
      warnings: migration.warnings,
      script,
      leftAfterDeploy: left.map((s) => `[${s.kind}] ${s.description}\n${s.sql}`).join("\n\n"),
      rollbackWarnings: rollback.warnings,
      rollback: renderRollbackScript(rollback),
    });
    dump(label, mode, schema);
    expect(left.filter((s) => !accepted(s)).map((s) => s.sql)).toEqual([]);

    if (!release.noRollback) {
      await runScript(runner, schema, renderRollbackScript(rollback));
      const leftBack = leftover(before, await read(readTarget, schema), allowDataLoss);
      expect(leftBack.filter((s) => !accepted(s)).map((s) => `ROLLBACK LEFT: ${s.sql}`)).toEqual([]);
    }
    return { script, warnings: migration.warnings, statements: migration.statements, left };
  }

  /** One release, registered once per mode. */
  function release(name: string, def: Release, check?: (outcome: Outcome, mode: Mode) => Promise<void> | void): void {
    it.each(MODES)(
      `${name} [%s]`,
      async (_label, mode) => {
        current = name;
        const outcome = await roundTrip(def, mode);
        if (check) await check(outcome, mode);
      },
      SLOW
    );
  }

  /** Deploy only, armed, then hand the case the target to look at directly. */
  async function deployOnly(name: string, def: Release, mode: Mode = "armed"): Promise<Outcome> {
    current = name;
    return roundTrip({ ...def, noRollback: true }, mode);
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
      const name = `${baseName}_realistic_${side}`;
      await server.query(`DROP DATABASE IF EXISTS ${quoteIdent(name)} WITH (FORCE)`);
      await server.query(`CREATE DATABASE ${quoteIdent(name)}`);
      databases.push(name);
    }
    for (const role of ["app_owner", "app_rw", "app_ro", DEPLOYER]) {
      await server.query(`DROP ROLE IF EXISTS ${quoteIdent(role)}`);
      await server.query(`CREATE ROLE ${quoteIdent(role)} ${role === DEPLOYER ? "LOGIN" : "NOLOGIN"}`);
      for (const name of databases) {
        await server.query(`GRANT CONNECT, CREATE ON DATABASE ${quoteIdent(name)} TO ${quoteIdent(role)}`);
      }
    }
    sourceConfig = configFor(databases[0]);
    targetConfig = configFor(databases[1]);
    deployerConfig = configFor(databases[1], DEPLOYER);
    source = new Client(sourceConfig);
    target = new Client(targetConfig);
    deployer = new Client(deployerConfig);
    await source.connect();
    await target.connect();
    await deployer.connect();
  }, SETUP);

  afterAll(async () => {
    for (const config of [sourceConfig, targetConfig, deployerConfig]) {
      if (config) await getPoolForConfig(config).end();
    }
    await source?.end();
    await target?.end();
    await deployer?.end();
    for (const name of databases) {
      await server.query(`DROP DATABASE IF EXISTS ${quoteIdent(name)} WITH (FORCE)`);
    }
    for (const role of ["app_owner", "app_rw", "app_ro", DEPLOYER]) {
      await server.query(`DROP ROLE IF EXISTS ${quoteIdent(role)}`);
    }
    await server?.end();
  }, SETUP);

  // ── Enums ────────────────────────────────────────────────────────────────

  release("01 an enum gains values at the end and in the middle, nothing uses them yet", {
    source: `CREATE TYPE order_status AS ENUM ('new', 'pending', 'paid', 'shipped', 'refunded');
             CREATE TABLE orders (id serial PRIMARY KEY, status order_status NOT NULL DEFAULT 'new', note text)`,
    target: `CREATE TYPE order_status AS ENUM ('new', 'paid', 'shipped');
             CREATE TABLE orders (id serial PRIMARY KEY, status order_status NOT NULL DEFAULT 'new', note text);
             INSERT INTO orders (status) VALUES ('new'), ('paid')`,
  });

  release("02 an enum gains a value and a column default uses it in the same release", {
    source: `CREATE TYPE order_status AS ENUM ('new', 'pending', 'paid', 'shipped', 'refunded');
             CREATE TABLE orders (
               id serial PRIMARY KEY,
               status order_status NOT NULL DEFAULT 'pending',
               prev_status order_status DEFAULT 'refunded',
               note text
             )`,
    target: `CREATE TYPE order_status AS ENUM ('new', 'paid', 'shipped');
             CREATE TABLE orders (id serial PRIMARY KEY, status order_status NOT NULL DEFAULT 'new', note text);
             INSERT INTO orders (status) VALUES ('new'), ('paid')`,
  });

  release("03 an enum gains a value and a partial index, a CHECK and a view name it", {
    source: `CREATE TYPE order_status AS ENUM ('new', 'paid', 'shipped', 'refunded');
             CREATE TABLE orders (
               id serial PRIMARY KEY, status order_status NOT NULL DEFAULT 'new', refund_reason text,
               CONSTRAINT orders_refund_ck CHECK (status <> 'refunded' OR refund_reason IS NOT NULL)
             );
             CREATE INDEX orders_refunded_idx ON orders (id) WHERE status = 'refunded';
             CREATE VIEW refunded_orders AS SELECT id, refund_reason FROM orders WHERE status = 'refunded'`,
    target: `CREATE TYPE order_status AS ENUM ('new', 'paid', 'shipped');
             CREATE TABLE orders (id serial PRIMARY KEY, status order_status NOT NULL DEFAULT 'new', refund_reason text);
             INSERT INTO orders (status) VALUES ('new'), ('paid')`,
  });

  // ── Domains ──────────────────────────────────────────────────────────────

  release("04 a domain's CHECK changes, a new domain arrives, and columns sit on both", {
    source: `CREATE DOMAIN email_address AS text CHECK (VALUE ~ '^[^@]+@[^@]+[.][^@]+$');
             CREATE DOMAIN positive_amount AS numeric(10, 2) CHECK (VALUE > 0);
             CREATE TABLE customers (
               id serial PRIMARY KEY, email email_address NOT NULL,
               backup_email email_address, credit positive_amount
             )`,
    target: `CREATE DOMAIN email_address AS text CHECK (VALUE ~ '@');
             CREATE TABLE customers (id serial PRIMARY KEY, email email_address NOT NULL);
             INSERT INTO customers (email) VALUES ('a@b.com'), ('c@d.org')`,
  });

  release("04b a new domain with NOT NULL and a DEFAULT, on a new column of a table that has rows", {
    source: `CREATE DOMAIN positive_amount AS numeric(10, 2) NOT NULL DEFAULT 1 CHECK (VALUE > 0);
             CREATE TABLE customers (id serial PRIMARY KEY, credit positive_amount)`,
    target: `CREATE TABLE customers (id serial PRIMARY KEY);
             INSERT INTO customers DEFAULT VALUES`,
  });

  it(
    "04c a domain's DEFAULT reaches production",
    async () => {
      await deployOnly("04c domain default", {
        source: `CREATE DOMAIN country_code AS char(2) DEFAULT 'MY'; CREATE TABLE places (id serial PRIMARY KEY, country country_code)`,
        target: `CREATE TABLE places (id serial PRIMARY KEY)`,
      });
      const answer = await target.query(
        `SELECT t.typdefault FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
          WHERE n.nspname = '${SCHEMA}' AND t.typname = 'country_code'`
      );
      expect(answer.rows[0]?.typdefault).toMatch(/MY/);
    },
    SLOW
  );

  // ── Sequences, serial, identity ──────────────────────────────────────────

  release("05 serial, identity, a tuned standalone sequence and a sequence OWNED BY a column", {
    source: `CREATE SEQUENCE invoice_no_seq START 1000 INCREMENT 5 MINVALUE 1000 CACHE 10;
             CREATE TABLE invoices (
               id bigserial PRIMARY KEY,
               invoice_no integer NOT NULL DEFAULT nextval('invoice_no_seq'),
               amount numeric(10, 2)
             );
             CREATE TABLE payments (
               id integer GENERATED ALWAYS AS IDENTITY (START WITH 100 INCREMENT BY 10) PRIMARY KEY,
               invoice_id bigint REFERENCES invoices (id),
               paid_at timestamptz DEFAULT now()
             );
             CREATE TABLE audit_log (id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, what text);
             CREATE TABLE tickets (id integer PRIMARY KEY, code integer NOT NULL);
             CREATE SEQUENCE tickets_code_counter OWNED BY tickets.code;
             ALTER TABLE tickets ALTER COLUMN code SET DEFAULT nextval('tickets_code_counter')`,
    target: `CREATE TABLE invoices (id serial PRIMARY KEY, amount numeric(10, 2));
             CREATE TABLE audit_log (id bigint PRIMARY KEY, what text);
             CREATE TABLE tickets (id integer PRIMARY KEY, code integer NOT NULL);
             INSERT INTO invoices (amount) VALUES (1), (2), (3);
             INSERT INTO audit_log VALUES (1, 'a'), (2, 'b');
             INSERT INTO tickets VALUES (1, 7)`,
  });

  it(
    "06 a column with rows that becomes an identity can still take an insert afterwards",
    async () => {
      await deployOnly("06 identity over rows", {
        source: `CREATE TABLE audit_log (id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, what text);
                 CREATE TABLE notes (id serial PRIMARY KEY, body text)`,
        target: `CREATE TABLE audit_log (id bigint PRIMARY KEY, what text);
                 CREATE TABLE notes (id integer PRIMARY KEY, body text);
                 INSERT INTO audit_log VALUES (1, 'a'), (2, 'b');
                 INSERT INTO notes VALUES (1, 'a'), (2, 'b')`,
      });
      // The production rows hold ids 1 and 2. A new sequence that starts at 1
      // hands out 1 again and the first insert after the release fails.
      await expect(target.query(`INSERT INTO ${SCHEMA}.audit_log (what) VALUES ('after release')`)).resolves.toBeDefined();
      await expect(target.query(`INSERT INTO ${SCHEMA}.notes (body) VALUES ('after release')`)).resolves.toBeDefined();
    },
    SLOW
  );

  // ── Owners ───────────────────────────────────────────────────────────────

  const ownedRelease = `
    CREATE TYPE mood AS ENUM ('ok', 'bad');
    CREATE TABLE accounts (id serial PRIMARY KEY, name text NOT NULL, feeling mood DEFAULT 'ok');
    CREATE TABLE ledger (
      id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      account_id integer REFERENCES accounts (id), amount numeric(12, 2) NOT NULL DEFAULT 0
    );
    CREATE TABLE transfers (
      id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      from_id integer REFERENCES accounts (id), to_id integer REFERENCES accounts (id)
    );
    CREATE SEQUENCE ref_seq;
    CREATE VIEW account_names AS SELECT id, name FROM accounts;
    CREATE MATERIALIZED VIEW account_totals AS SELECT account_id, sum(amount) AS total FROM ledger GROUP BY account_id;
    CREATE FUNCTION account_count() RETURNS bigint LANGUAGE sql STABLE AS 'SELECT count(*) FROM accounts';
    GRANT USAGE ON SCHEMA shop TO app_rw, app_ro;
    GRANT SELECT, INSERT, UPDATE, DELETE ON accounts, ledger, transfers TO app_rw;
    GRANT USAGE ON SEQUENCE accounts_id_seq, ref_seq TO app_rw;
    GRANT SELECT ON accounts, ledger, account_names, account_totals TO app_ro`;
  const ownedProduction = `
    CREATE TABLE accounts (id serial PRIMARY KEY, name text NOT NULL);
    CREATE TABLE ledger (id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY, account_id integer REFERENCES accounts (id));
    CREATE VIEW account_names AS SELECT id, name FROM accounts;
    INSERT INTO accounts (name) VALUES ('a'), ('b');
    INSERT INTO ledger (account_id) VALUES (1), (2)`;

  release("07 staging is owned by app_owner, production by the superuser, a superuser deploys", {
    source: ownedRelease,
    target: ownedProduction,
    sourceRole: "app_owner",
  });

  release("08 both sides are owned by app_owner already, a superuser deploys new objects", {
    source: ownedRelease,
    target: ownedProduction,
    sourceRole: "app_owner",
    targetRole: "app_owner",
  });

  release(
    "09 a login that is not a superuser and not in app_owner deploys what app_owner owns on staging",
    {
      source: ownedRelease,
      target: ownedProduction,
      sourceRole: "app_owner",
      deployAsDeployer: true,
      // The script says it up front: an owner change this login may not make is
      // skipped with a warning and shows as a difference on the next comparison.
      mayBeLeft: (statement) => statement.kind === "ALTER_OWNER",
    },
    (outcome) => {
      expect(outcome.warnings.join("\n")).toMatch(/owner/i);
    }
  );

  // ── Grants ───────────────────────────────────────────────────────────────

  const grantTables = `
    CREATE TABLE customers (id serial PRIMARY KEY, email text, secret text);
    CREATE TABLE products (id serial PRIMARY KEY, name text);
    CREATE VIEW customer_emails AS SELECT id, email FROM customers;
    CREATE FUNCTION price_of(integer) RETURNS numeric LANGUAGE sql AS 'SELECT 1.0';
    CREATE PROCEDURE reprice(integer) LANGUAGE sql AS 'SELECT 1';`;

  release("10 grants: TRUNCATE, REFERENCES, TRIGGER, PUBLIC, WITH GRANT OPTION, sequence, routine, revokes", {
    source: `${grantTables}
             GRANT USAGE ON SCHEMA shop TO app_rw, app_ro;
             GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON customers TO app_rw;
             GRANT SELECT ON products TO PUBLIC;
             GRANT SELECT ON customers TO app_ro WITH GRANT OPTION;
             GRANT SELECT ON customer_emails TO app_ro;
             GRANT USAGE, SELECT ON SEQUENCE customers_id_seq TO app_rw;
             REVOKE EXECUTE ON FUNCTION price_of(integer) FROM PUBLIC;
             GRANT EXECUTE ON FUNCTION price_of(integer) TO app_rw;
             GRANT EXECUTE ON PROCEDURE reprice(integer) TO app_rw WITH GRANT OPTION`,
    target: `${grantTables}
             GRANT USAGE ON SCHEMA shop TO app_ro;
             GRANT CREATE ON SCHEMA shop TO app_rw;
             GRANT ALL ON products TO app_rw;
             GRANT SELECT, UPDATE ON customers TO app_ro;
             GRANT ALL ON SEQUENCE products_id_seq TO PUBLIC;
             INSERT INTO customers (email) VALUES ('a@b.com')`,
  });

  it(
    "11 a column-level grant on staging reaches production",
    async () => {
      const tables = `CREATE TABLE customers (id serial PRIMARY KEY, email text, secret text);`;
      await deployOnly("11 column grant", {
        source: `${tables} GRANT USAGE ON SCHEMA shop TO app_ro; GRANT SELECT (id, email), UPDATE (email) ON customers TO app_ro`,
        target: `${tables} GRANT USAGE ON SCHEMA shop TO app_ro`,
      });
      const answer = await target.query(
        `SELECT has_column_privilege('app_ro', '${SCHEMA}.customers', 'email', 'SELECT') AS can_read`
      );
      expect(answer.rows[0].can_read).toBe(true);
    },
    SLOW
  );

  release("11b column grants: one added, one taken away, one on a column that is dropped", {
    source: `CREATE TABLE customers (id serial PRIMARY KEY, email text, phone text);
             GRANT USAGE ON SCHEMA shop TO app_ro;
             GRANT SELECT (id, email) ON customers TO app_ro`,
    target: `CREATE TABLE customers (id serial PRIMARY KEY, email text, phone text, secret text);
             GRANT USAGE ON SCHEMA shop TO app_ro;
             GRANT SELECT (id, phone), UPDATE (secret) ON customers TO app_ro;
             INSERT INTO customers (email) VALUES ('a@b.com')`,
  });

  it(
    "12 default privileges are NOT carried, and the help page says so",
    async () => {
      // ALTER DEFAULT PRIVILEGES is a rule about objects made LATER, kept per
      // role, not part of any one object. The comparison does not read it.
      // This case pins that down, so the day it is carried this test fails
      // and the help text gets updated with it.
      const tables = `CREATE TABLE customers (id serial PRIMARY KEY, email text);`;
      const outcome = await deployOnly("12 default privileges", {
        source: `${tables} ALTER DEFAULT PRIVILEGES IN SCHEMA shop GRANT SELECT ON TABLES TO app_ro`,
        target: tables,
      });
      expect(outcome.script).not.toMatch(/DEFAULT PRIVILEGES/i);
      const answer = await target.query(
        `SELECT count(*)::int AS n FROM pg_default_acl d JOIN pg_namespace n ON n.oid = d.defaclnamespace WHERE n.nspname = $1`,
        [SCHEMA]
      );
      expect(answer.rows[0].n).toBe(0);
      expect(JSON.stringify(compareHelp)).toMatch(/ALTER DEFAULT PRIVILEGES/);
    },
    SLOW
  );

  // ── Row security ─────────────────────────────────────────────────────────

  release("13 row security: enabled and forced, a new policy, a changed one, a dropped one, RLS switched off", {
    source: `CREATE TABLE docs (
               id serial PRIMARY KEY, owner_name text NOT NULL DEFAULT current_user,
               tenant_id integer NOT NULL DEFAULT 0, body text
             );
             ALTER TABLE docs ENABLE ROW LEVEL SECURITY;
             ALTER TABLE docs FORCE ROW LEVEL SECURITY;
             CREATE POLICY docs_owner ON docs USING (owner_name = current_user) WITH CHECK (owner_name = current_user);
             CREATE POLICY docs_tenant ON docs AS RESTRICTIVE FOR SELECT TO app_ro, app_rw
               USING (tenant_id = current_setting('app.tenant', true)::integer);
             CREATE TABLE notes (id serial PRIMARY KEY, body text)`,
    target: `CREATE TABLE docs (id serial PRIMARY KEY, owner_name text NOT NULL DEFAULT current_user, body text);
             ALTER TABLE docs ENABLE ROW LEVEL SECURITY;
             CREATE POLICY docs_owner ON docs USING (owner_name = current_user);
             CREATE POLICY docs_old ON docs FOR DELETE USING (false);
             CREATE TABLE notes (id serial PRIMARY KEY, body text);
             ALTER TABLE notes ENABLE ROW LEVEL SECURITY;
             CREATE POLICY notes_all ON notes USING (true);
             INSERT INTO docs (body) VALUES ('x')`,
  });

  // ── Views ────────────────────────────────────────────────────────────────

  release("14 views: a wider varchar under a view on a view, a changed view, a materialized view with an index", {
    source: `CREATE TABLE products (id serial PRIMARY KEY, name varchar(200) NOT NULL, price numeric(10, 2) NOT NULL, category text);
             CREATE VIEW product_names AS SELECT id, name, category FROM products;
             CREATE VIEW product_labels AS SELECT id, upper(name::text) AS label FROM product_names;
             CREATE VIEW pricey AS SELECT id, name, price FROM products WHERE price > 50;
             CREATE MATERIALIZED VIEW category_totals AS
               SELECT category, count(*) AS n, sum(price) AS total FROM products GROUP BY category;
             CREATE UNIQUE INDEX category_totals_cat_idx ON category_totals (category);
             GRANT SELECT ON product_names, product_labels, category_totals TO app_ro`,
    target: `CREATE TABLE products (id serial PRIMARY KEY, name varchar(100) NOT NULL, price numeric(10, 2) NOT NULL, category text);
             CREATE VIEW product_names AS SELECT id, name, category FROM products;
             CREATE VIEW product_labels AS SELECT id, upper(name::text) AS label FROM product_names;
             CREATE VIEW pricey AS SELECT id, name, price FROM products WHERE price > 100;
             CREATE MATERIALIZED VIEW category_totals AS SELECT category, count(*) AS n FROM products GROUP BY category;
             CREATE INDEX category_totals_cat_idx ON category_totals (category);
             GRANT SELECT ON product_names, product_labels, category_totals TO app_ro;
             INSERT INTO products (name, price, category) VALUES ('a', 10, 'x'), ('b', 200, 'y');
             REFRESH MATERIALIZED VIEW category_totals`,
  });

  it(
    "15 a view option (security_invoker, or security_barrier before PostgreSQL 15) and a WITH CHECK OPTION on staging reach production",
    async () => {
      const table = `CREATE TABLE orders (id serial PRIMARY KEY, open boolean NOT NULL DEFAULT true);`;
      // security_invoker arrived in PostgreSQL 15. On 13 and 14 the case uses
      // security_barrier, an older option that travels the same way.
      const version = await target.query<{ num: string }>(
        "SELECT current_setting('server_version_num') AS num"
      );
      const option = Number(version.rows[0].num) >= 150000 ? "security_invoker" : "security_barrier";
      await deployOnly("15 view options", {
        source: `${table}
                 CREATE VIEW open_orders WITH (${option} = true) AS SELECT id, open FROM orders WHERE open
                   WITH LOCAL CHECK OPTION`,
        target: `${table} CREATE VIEW open_orders AS SELECT id, open FROM orders WHERE open`,
      });
      const answer = await target.query(
        `SELECT c.reloptions FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = $1 AND c.relname = 'open_orders'`,
        [SCHEMA]
      );
      expect((answer.rows[0].reloptions ?? []).sort()).toEqual(["check_option=local", `${option}=true`]);
    },
    SLOW
  );

  // ── Functions and triggers ───────────────────────────────────────────────

  release("16 functions: changed body, changed return type and arguments, a procedure, triggers, one on a new column", {
    source: `CREATE TABLE items (
               id serial PRIMARY KEY, name text NOT NULL, qty integer NOT NULL DEFAULT 0,
               updated_at timestamptz, updated_by text
             );
             CREATE TABLE qty_log (item_id integer, old_qty integer, new_qty integer, at timestamptz DEFAULT now());
             CREATE FUNCTION touch_updated() RETURNS trigger LANGUAGE plpgsql AS $$
               BEGIN NEW.updated_at := now(); NEW.updated_by := current_user; RETURN NEW; END $$;
             CREATE TRIGGER items_touch BEFORE INSERT OR UPDATE ON items FOR EACH ROW EXECUTE FUNCTION touch_updated();
             CREATE FUNCTION log_qty() RETURNS trigger LANGUAGE plpgsql AS $$
               BEGIN INSERT INTO qty_log (item_id, old_qty, new_qty) VALUES (NEW.id, OLD.qty, NEW.qty); RETURN NULL; END $$;
             CREATE TRIGGER items_qty_change AFTER UPDATE OF qty ON items FOR EACH ROW
               WHEN (OLD.qty IS DISTINCT FROM NEW.qty) EXECUTE FUNCTION log_qty();
             CREATE TRIGGER items_by_change BEFORE UPDATE OF updated_by ON items FOR EACH ROW EXECUTE FUNCTION touch_updated();
             CREATE FUNCTION item_total(p_min integer DEFAULT 0) RETURNS bigint LANGUAGE sql STABLE AS $$
               SELECT coalesce(sum(qty), 0) FROM items WHERE qty >= p_min $$;
             CREATE FUNCTION item_label(i items) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT i.name || ' x' || i.qty $$;
             CREATE PROCEDURE restock(p_id integer, p_n integer) LANGUAGE plpgsql AS $$
               BEGIN UPDATE items SET qty = qty + p_n WHERE id = p_id; END $$;
             CREATE FUNCTION slugify(t text) RETURNS text LANGUAGE sql IMMUTABLE STRICT SECURITY DEFINER
               SET search_path = pg_catalog AS $$ SELECT lower(regexp_replace(t, '[^a-zA-Z0-9]+', '-', 'g')) $$`,
    target: `CREATE TABLE items (id serial PRIMARY KEY, name text NOT NULL, qty integer NOT NULL DEFAULT 0, updated_at timestamptz);
             CREATE FUNCTION touch_updated() RETURNS trigger LANGUAGE plpgsql AS $$
               BEGIN NEW.updated_at := now(); RETURN NEW; END $$;
             CREATE TRIGGER items_touch BEFORE UPDATE ON items FOR EACH ROW EXECUTE FUNCTION touch_updated();
             CREATE FUNCTION item_total() RETURNS integer LANGUAGE sql STABLE AS $$ SELECT coalesce(sum(qty), 0)::integer FROM items $$;
             CREATE PROCEDURE restock(p_id integer) LANGUAGE plpgsql AS $$
               BEGIN UPDATE items SET qty = qty + 1 WHERE id = p_id; END $$;
             CREATE FUNCTION slugify(t text) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT lower(t) $$;
             CREATE FUNCTION old_helper() RETURNS integer LANGUAGE sql AS 'SELECT 1';
             INSERT INTO items (name, qty) VALUES ('a', 1), ('b', 2)`,
  });

  release("17 a function's return type changes while a view and a column default call it", {
    source: `CREATE FUNCTION next_code() RETURNS text LANGUAGE sql AS $$ SELECT 'C' || floor(random() * 1000)::text $$;
             CREATE FUNCTION vat(amount numeric) RETURNS numeric LANGUAGE sql IMMUTABLE AS $$ SELECT round(amount * 0.1, 2) $$;
             CREATE TABLE sales (id serial PRIMARY KEY, code text NOT NULL DEFAULT next_code(), amount numeric(10, 2) NOT NULL,
               CONSTRAINT sales_vat_ck CHECK (vat(amount) >= 0));
             CREATE VIEW sales_vat AS SELECT id, amount, vat(amount) AS vat FROM sales`,
    target: `CREATE FUNCTION next_code() RETURNS varchar LANGUAGE sql AS $$ SELECT 'C1'::varchar $$;
             CREATE FUNCTION vat(amount numeric) RETURNS integer LANGUAGE sql IMMUTABLE AS $$ SELECT (amount * 0.1)::integer $$;
             CREATE TABLE sales (id serial PRIMARY KEY, code text NOT NULL DEFAULT next_code(), amount numeric(10, 2) NOT NULL,
               CONSTRAINT sales_vat_ck CHECK (vat(amount) >= 0));
             CREATE VIEW sales_vat AS SELECT id, amount, vat(amount) AS vat FROM sales;
             INSERT INTO sales (amount) VALUES (10), (20)`,
    // A function in use cannot change its return type in place; the script says
    // so and leaves it to a person, so it and what hangs off it stay different.
    mayBeLeft: () => true,
    noRollback: true,
  }, (outcome) => {
    expect(outcome.warnings.join("\n")).toMatch(/next_code|vat/);
  });

  // ── Constraints ──────────────────────────────────────────────────────────

  release("18 constraints: changed CHECK, named UNIQUE, FK with CASCADE and DEFERRABLE, FK to a new table, changed FK action", {
    source: `CREATE TABLE customers (
               id serial PRIMARY KEY, email text NOT NULL, country char(2) NOT NULL DEFAULT 'AU', age integer,
               CONSTRAINT customers_email_uq UNIQUE (email),
               CONSTRAINT customers_age_ck CHECK (age IS NULL OR age >= 18),
               CONSTRAINT customers_country_ck CHECK (country = upper(country))
             );
             CREATE TABLE addresses (
               id serial PRIMARY KEY, customer_id integer NOT NULL, line1 text,
               CONSTRAINT addresses_customer_fk FOREIGN KEY (customer_id) REFERENCES customers (id)
                 ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
             );
             CREATE TABLE regions (code char(2) PRIMARY KEY, name text);
             CREATE TABLE orders (
               id serial PRIMARY KEY, customer_id integer NOT NULL, region char(2), total numeric(10, 2) NOT NULL,
               CONSTRAINT orders_customer_fk FOREIGN KEY (customer_id) REFERENCES customers (id) ON DELETE CASCADE,
               CONSTRAINT orders_region_fk FOREIGN KEY (region) REFERENCES regions (code) ON UPDATE CASCADE ON DELETE SET NULL,
               CONSTRAINT orders_total_ck CHECK (total >= 0)
             )`,
    target: `CREATE TABLE customers (
               id serial PRIMARY KEY, email text NOT NULL, country char(2) NOT NULL DEFAULT 'AU', age integer,
               CONSTRAINT customers_age_ck CHECK (age >= 0)
             );
             CREATE TABLE addresses (
               id serial PRIMARY KEY, customer_id integer NOT NULL, line1 text,
               CONSTRAINT addresses_customer_fk FOREIGN KEY (customer_id) REFERENCES customers (id)
             );
             CREATE TABLE orders (
               id serial PRIMARY KEY, customer_id integer NOT NULL, region char(2), total numeric(10, 2) NOT NULL,
               CONSTRAINT orders_customer_fk FOREIGN KEY (customer_id) REFERENCES customers (id) ON DELETE RESTRICT
             );
             INSERT INTO customers (email, age) VALUES ('a@b.com', 30), ('c@d.com', NULL);
             INSERT INTO addresses (customer_id, line1) VALUES (1, 'x');
             INSERT INTO orders (customer_id, total) VALUES (1, 5)`,
  });

  // ── Indexes ──────────────────────────────────────────────────────────────

  release("19 indexes: partial, expression, unique, INCLUDE, DESC NULLS LAST, gin, opclass, a changed one, a dropped one", {
    source: `CREATE TABLE users (
               id serial PRIMARY KEY, email text NOT NULL, full_name text,
               created_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz, tags text[], meta jsonb
             );
             CREATE UNIQUE INDEX users_email_lower_uq ON users (lower(email)) WHERE deleted_at IS NULL;
             CREATE INDEX users_created_idx ON users (created_at DESC NULLS LAST) INCLUDE (email);
             CREATE INDEX users_tags_gin ON users USING gin (tags);
             CREATE INDEX users_meta_idx ON users USING gin (meta jsonb_path_ops);
             CREATE INDEX users_name_idx ON users (full_name text_pattern_ops);
             CREATE INDEX users_active_idx ON users (id) WHERE deleted_at IS NULL`,
    target: `CREATE TABLE users (
               id serial PRIMARY KEY, email text NOT NULL, full_name text,
               created_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz, tags text[], meta jsonb
             );
             CREATE UNIQUE INDEX users_email_lower_uq ON users (lower(email));
             CREATE INDEX users_name_idx ON users (full_name);
             CREATE INDEX users_old_idx ON users (created_at);
             INSERT INTO users (email, full_name) VALUES ('A@b.com', 'Ann'), ('c@d.com', 'Cy')`,
  });

  // ── Renames ──────────────────────────────────────────────────────────────

  release("20 a renamed column (with an index on it) and a renamed table, with rows", {
    source: `CREATE TABLE customers (id serial PRIMARY KEY, full_name text NOT NULL, email text, phone text);
             CREATE INDEX customers_name_idx ON customers (full_name);
             CREATE TABLE purchase_orders (
               id serial PRIMARY KEY, customer_id integer REFERENCES customers (id),
               total numeric(10, 2), placed_at timestamptz
             )`,
    target: `CREATE TABLE customers (id serial PRIMARY KEY, fullname text NOT NULL, email text, phone text);
             CREATE INDEX customers_name_idx ON customers (fullname);
             CREATE TABLE orders (
               id serial PRIMARY KEY, customer_id integer REFERENCES customers (id),
               total numeric(10, 2), placed_at timestamptz
             );
             INSERT INTO customers (fullname, email) VALUES ('Ann', 'a@b.com'), ('Cy', 'c@d.com');
             INSERT INTO orders (customer_id, total) VALUES (1, 5)`,
  });

  it(
    "21 a renamed column keeps its rows' values when the script is run with data loss allowed",
    async () => {
      await deployOnly("21 rename keeps data", {
        source: `CREATE TABLE customers (id serial PRIMARY KEY, full_name text NOT NULL, email text, phone text)`,
        target: `CREATE TABLE customers (id serial PRIMARY KEY, fullname text NOT NULL, email text, phone text);
                 INSERT INTO customers (fullname, email) VALUES ('Ann', 'a@b.com'), ('Cy', 'c@d.com')`,
      });
      const rows = await target.query(`SELECT full_name FROM ${SCHEMA}.customers ORDER BY id`);
      expect(rows.rows.map((r) => r.full_name)).toEqual(["Ann", "Cy"]);
    },
    SLOW
  );

  // ── NOT NULL over rows ───────────────────────────────────────────────────

  it(
    "22 NOT NULL added to a column whose production rows hold NULLs is refused by PostgreSQL, not papered over",
    async () => {
      await expect(
        deployOnly("22 not null over nulls", {
          source: `CREATE TABLE members (id serial PRIMARY KEY, email text NOT NULL, nickname text NOT NULL DEFAULT 'anon')`,
          target: `CREATE TABLE members (id serial PRIMARY KEY, email text, nickname text);
                   INSERT INTO members (email, nickname) VALUES ('a@b.com', 'a'), (NULL, NULL)`,
        })
      ).rejects.toThrow(/contains null values/);
    },
    SLOW
  );

  release("23 a new NOT NULL column with no default on a table that has rows", {
    source: `CREATE TABLE members (id serial PRIMARY KEY, email text NOT NULL, joined_on date NOT NULL)`,
    target: `CREATE TABLE members (id serial PRIMARY KEY, email text NOT NULL);
             INSERT INTO members (email) VALUES ('a@b.com')`,
    // There is no value for the row that is already there, so the column is
    // added nullable and NOT NULL is left for a person. That is one difference
    // left on purpose, and the warning has to say so before the deploy.
    mayBeLeft: (statement) => /joined_on/.test(statement.sql) && /NOT NULL/.test(statement.sql),
  }, (outcome) => {
    expect(outcome.warnings.join("\n")).toMatch(/"joined_on" is NOT NULL in the source and has no default/);
    expect(outcome.left.length).toBe(1);
  });

  // ── Defaults, generated columns, collations, type changes ────────────────

  release("24 a changed default, a generated column added and one changed, a collation change", {
    source: `CREATE TABLE lines (
               id serial PRIMARY KEY, qty integer NOT NULL DEFAULT 1, unit_price numeric(10, 2) NOT NULL DEFAULT 0,
               total numeric(12, 2) GENERATED ALWAYS AS (qty * unit_price) STORED,
               gross numeric(12, 2) GENERATED ALWAYS AS (qty * unit_price * 1.1) STORED,
               code text COLLATE "POSIX" NOT NULL DEFAULT 'x',
               created timestamptz NOT NULL DEFAULT now(), status text DEFAULT 'open', flags text[] DEFAULT '{}'
             );
             CREATE INDEX lines_code_idx ON lines (code)`,
    target: `CREATE TABLE lines (
               id serial PRIMARY KEY, qty integer NOT NULL DEFAULT 0, unit_price numeric(10, 2) NOT NULL DEFAULT 0,
               gross numeric(12, 2) GENERATED ALWAYS AS (qty * unit_price) STORED,
               code text COLLATE "C" NOT NULL DEFAULT 'x',
               created timestamptz NOT NULL DEFAULT '2020-01-01', status text, flags text[]
             );
             CREATE INDEX lines_code_idx ON lines (code);
             INSERT INTO lines (qty, unit_price) VALUES (2, 3.5), (1, 10)`,
  });

  release("25 column types widen: integer key and its foreign key to bigint, varchar to text, numeric, timestamp to timestamptz", {
    source: `CREATE TABLE customers (id bigint PRIMARY KEY, name text NOT NULL, balance numeric(14, 4) NOT NULL DEFAULT 0, seen timestamptz);
             CREATE TABLE orders (id bigserial PRIMARY KEY, customer_id bigint NOT NULL REFERENCES customers (id), ref varchar(40));
             CREATE VIEW order_customers AS SELECT o.id, c.name FROM orders o JOIN customers c ON c.id = o.customer_id`,
    target: `CREATE TABLE customers (id integer PRIMARY KEY, name varchar(50) NOT NULL, balance numeric(10, 2) NOT NULL DEFAULT 0, seen timestamp);
             CREATE TABLE orders (id serial PRIMARY KEY, customer_id integer NOT NULL REFERENCES customers (id), ref varchar(20));
             CREATE VIEW order_customers AS SELECT o.id, c.name FROM orders o JOIN customers c ON c.id = o.customer_id;
             INSERT INTO customers VALUES (1, 'Ann', 5, now());
             INSERT INTO orders (customer_id, ref) VALUES (1, 'r1')`,
  });

  release("26 a text column holding numbers becomes integer, and a text flag becomes boolean", {
    source: `CREATE TABLE stock (id serial PRIMARY KEY, qty integer NOT NULL DEFAULT 0, active boolean NOT NULL DEFAULT true)`,
    target: `CREATE TABLE stock (id serial PRIMARY KEY, qty text NOT NULL DEFAULT '0', active text NOT NULL DEFAULT 'true');
             INSERT INTO stock (qty, active) VALUES ('5', 'true'), ('7', 'false')`,
  });

  // ── Comments ─────────────────────────────────────────────────────────────

  it(
    "27 comments (COMMENT ON) are NOT carried, and the help page says so",
    async () => {
      // Comments are not read by the comparison. Pinned down here for the
      // same reason as case 12.
      const ddl = `CREATE TABLE customers (id serial PRIMARY KEY, email text);
                   CREATE FUNCTION one() RETURNS integer LANGUAGE sql AS 'SELECT 1';`;
      const outcome = await deployOnly("27 comments", {
        source: `${ddl}
                 COMMENT ON TABLE customers IS 'People who buy';
                 COMMENT ON COLUMN customers.email IS 'Login address';
                 COMMENT ON FUNCTION one() IS 'Always one'`,
        target: ddl,
      });
      const answer = await target.query(
        `SELECT obj_description('${SCHEMA}.customers'::regclass) AS on_table,
                col_description('${SCHEMA}.customers'::regclass, 2) AS on_column,
                obj_description('${SCHEMA}.one()'::regprocedure) AS on_function`
      );
      expect(outcome.script).not.toMatch(/COMMENT ON/i);
      expect(answer.rows[0]).toEqual({ on_table: null, on_column: null, on_function: null });
      expect(JSON.stringify(compareHelp)).toMatch(/COMMENT ON/);
    },
    SLOW
  );

  // ── Drops ────────────────────────────────────────────────────────────────

  release("28 staging dropped a table, a column, their enum, index, views, a function and a sequence", {
    source: `CREATE TABLE books (id serial PRIMARY KEY, title text NOT NULL);
             CREATE TABLE loans (id serial PRIMARY KEY, book_id integer REFERENCES books (id))`,
    target: `CREATE TYPE legacy_kind AS ENUM ('a', 'b');
             CREATE SEQUENCE legacy_seq;
             CREATE TABLE books (id serial PRIMARY KEY, title text NOT NULL, isbn varchar(13), kind legacy_kind DEFAULT 'a');
             CREATE INDEX books_isbn_idx ON books (isbn);
             CREATE TABLE legacy_members (id serial PRIMARY KEY, name text, no integer DEFAULT nextval('legacy_seq'));
             CREATE TABLE loans (
               id serial PRIMARY KEY, book_id integer REFERENCES books (id),
               member_id integer REFERENCES legacy_members (id)
             );
             CREATE VIEW member_loans AS SELECT m.name, l.book_id FROM legacy_members m JOIN loans l ON l.member_id = m.id;
             CREATE VIEW isbn_list AS SELECT isbn FROM books;
             CREATE FUNCTION legacy_count() RETURNS bigint LANGUAGE sql AS 'SELECT count(*) FROM legacy_members';
             GRANT SELECT ON legacy_members, member_loans TO app_ro;
             INSERT INTO books (title, isbn) VALUES ('t', '123');
             INSERT INTO legacy_members (name) VALUES ('m');
             INSERT INTO loans (book_id, member_id) VALUES (1, 1)`,
  });

  // ── Extensions ───────────────────────────────────────────────────────────

  release("29 extensions in the compared schema: citext for a column type, pgcrypto for a default", {
    source: `CREATE EXTENSION IF NOT EXISTS citext;
             CREATE EXTENSION IF NOT EXISTS pgcrypto;
             CREATE TABLE users (
               id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email citext NOT NULL UNIQUE,
               token text NOT NULL DEFAULT encode(gen_random_bytes(16), 'hex')
             )`,
    target: `CREATE TABLE users (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text NOT NULL);
             INSERT INTO users (email) VALUES ('a@b.com')`,
  });

  release("30 an extension that lives in public on staging and is missing on production, used from the compared schema", {
    sourceSetup: `CREATE EXTENSION IF NOT EXISTS citext SCHEMA public`,
    targetSetup: `DROP EXTENSION IF EXISTS citext CASCADE`,
    source: `CREATE TABLE users (id serial PRIMARY KEY, email public.citext NOT NULL)`,
    target: `CREATE TABLE users (id serial PRIMARY KEY);`,
  });

  // ── Partitions and inheritance ───────────────────────────────────────────

  release("31 a partitioned table that already has a partition gains a column", {
    source: `CREATE TABLE events (
               id bigint GENERATED ALWAYS AS IDENTITY, happened_on date NOT NULL, kind text NOT NULL, payload jsonb,
               PRIMARY KEY (id, happened_on)
             ) PARTITION BY RANGE (happened_on);
             CREATE TABLE events_2025 PARTITION OF events FOR VALUES FROM ('2025-01-01') TO ('2026-01-01')`,
    target: `CREATE TABLE events (
               id bigint GENERATED ALWAYS AS IDENTITY, happened_on date NOT NULL, kind text NOT NULL,
               PRIMARY KEY (id, happened_on)
             ) PARTITION BY RANGE (happened_on);
             CREATE TABLE events_2025 PARTITION OF events FOR VALUES FROM ('2025-01-01') TO ('2026-01-01');
             INSERT INTO events (happened_on, kind) VALUES ('2025-05-05', 'x')`,
  });

  const partitionedEvents = `CREATE TABLE events (
               id bigint GENERATED ALWAYS AS IDENTITY, happened_on date NOT NULL, kind text NOT NULL,
               PRIMARY KEY (id, happened_on)
             ) PARTITION BY RANGE (happened_on);
             CREATE TABLE events_2025 PARTITION OF events FOR VALUES FROM ('2025-01-01') TO ('2026-01-01');`;

  release("31b a partitioned table gains two partitions", {
    source: `${partitionedEvents}
             CREATE TABLE events_2026 PARTITION OF events FOR VALUES FROM ('2026-01-01') TO ('2027-01-01');
             CREATE TABLE events_default PARTITION OF events DEFAULT`,
    target: `${partitionedEvents} INSERT INTO events (happened_on, kind) VALUES ('2025-05-05', 'x')`,
  });

  it(
    "31c a new index on a partitioned table is usable on production: valid, and present on the partition",
    async () => {
      await deployOnly("31c partitioned index", {
        source: `${partitionedEvents} CREATE INDEX events_kind_idx ON events (kind)`,
        target: `${partitionedEvents} INSERT INTO events (happened_on, kind) VALUES ('2025-05-05', 'x')`,
      });
      const answer = await target.query(
        `SELECT x.indisvalid,
                (SELECT count(*)::int FROM pg_index px WHERE px.indrelid = '${SCHEMA}.events_2025'::regclass AND NOT px.indisprimary) AS on_partition
           FROM pg_index x WHERE x.indexrelid = '${SCHEMA}.events_kind_idx'::regclass`
      );
      expect(answer.rows[0]).toEqual({ indisvalid: true, on_partition: 1 });
    },
    SLOW
  );

  release("32 a new partitioned table (list and hash) and a new inheritance child", {
    source: `CREATE TABLE base_entity (id serial PRIMARY KEY, created_at timestamptz DEFAULT now());
             CREATE TABLE person (name text NOT NULL) INHERITS (base_entity);
             CREATE TABLE sales (id bigserial, region text NOT NULL, amount numeric(10, 2), PRIMARY KEY (id, region))
               PARTITION BY LIST (region);
             CREATE TABLE sales_au PARTITION OF sales FOR VALUES IN ('AU', 'NZ');
             CREATE TABLE sales_other PARTITION OF sales DEFAULT;
             CREATE TABLE hits (id bigint NOT NULL, at timestamptz) PARTITION BY HASH (id);
             CREATE TABLE hits_0 PARTITION OF hits FOR VALUES WITH (MODULUS 2, REMAINDER 0);
             CREATE TABLE hits_1 PARTITION OF hits FOR VALUES WITH (MODULUS 2, REMAINDER 1)`,
    target: `CREATE TABLE base_entity (id serial PRIMARY KEY, created_at timestamptz DEFAULT now());
             INSERT INTO base_entity DEFAULT VALUES`,
  });

  // ── Two schemas ──────────────────────────────────────────────────────────

  release("33 objects in a second schema (table, enum, function) used from the compared one", {
    setup: `DROP SCHEMA IF EXISTS audit CASCADE;
            CREATE SCHEMA audit;
            CREATE TABLE audit.actors (id integer PRIMARY KEY, name text);
            CREATE TYPE audit.level AS ENUM ('low', 'high');
            CREATE FUNCTION audit.stamp() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
            CREATE FUNCTION audit.rank(l audit.level) RETURNS integer LANGUAGE sql IMMUTABLE AS $$ SELECT 1 $$;`,
    source: `CREATE TABLE changes (
               id serial PRIMARY KEY, actor_id integer REFERENCES audit.actors (id) ON DELETE SET NULL,
               lvl audit.level NOT NULL DEFAULT 'low', what text,
               CONSTRAINT changes_rank_ck CHECK (audit.rank(lvl) > 0)
             );
             CREATE VIEW change_names AS
               SELECT c.id, a.name, c.what FROM changes c LEFT JOIN audit.actors a ON a.id = c.actor_id;
             CREATE TRIGGER changes_stamp BEFORE INSERT ON changes FOR EACH ROW EXECUTE FUNCTION audit.stamp()`,
    target: `CREATE TABLE changes (id serial PRIMARY KEY, what text);
             INSERT INTO changes (what) VALUES ('x')`,
  });

  // ── The public schema ────────────────────────────────────────────────────

  const publicRelease = {
    source: `CREATE TABLE customers (id serial PRIMARY KEY, email text NOT NULL, name text);
             CREATE TABLE orders (id serial PRIMARY KEY, customer_id integer REFERENCES customers (id));
             CREATE VIEW customer_orders AS SELECT c.email, o.id FROM customers c JOIN orders o ON o.customer_id = c.id`,
    target: `CREATE TABLE customers (id serial PRIMARY KEY, email text NOT NULL);
             INSERT INTO customers (email) VALUES ('a@b.com')`,
  };

  release("34 schema public, both as PostgreSQL ships it", { schema: "public", ...publicRelease });

  release("35 schema public, staging's was dropped and created again (owner and PUBLIC grant differ)", {
    schema: "public",
    ...publicRelease,
    sourcePublic: "recreated",
  });

  release("36 schema public, production's was dropped and created again", {
    schema: "public",
    ...publicRelease,
    targetPublic: "recreated",
  });

  release("37 schema public, staging owned by app_owner, production deployed by a login that is not a superuser", {
    schema: "public",
    ...publicRelease,
    sourceRole: "app_owner",
    sourcePublic: "recreated",
    targetPublic: "recreated",
    deployAsDeployer: true,
    mayBeLeft: (statement) => statement.kind === "ALTER_OWNER",
  });

  // ── A whole release ──────────────────────────────────────────────────────

  const wholeSource = `
    CREATE EXTENSION IF NOT EXISTS citext;
    CREATE TYPE order_status AS ENUM ('new', 'pending', 'paid', 'shipped', 'cancelled');
    CREATE DOMAIN money_amount AS numeric(12, 2) CHECK (VALUE >= 0);
    CREATE TABLE customers (
      id integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, email citext NOT NULL,
      full_name varchar(200) NOT NULL, phone text, created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT customers_email_uq UNIQUE (email)
    );
    CREATE TABLE products (
      id serial PRIMARY KEY, sku text NOT NULL, name varchar(200) NOT NULL, price money_amount NOT NULL,
      active boolean NOT NULL DEFAULT true,
      search text GENERATED ALWAYS AS (lower(name::text || ' ' || sku)) STORED
    );
    CREATE UNIQUE INDEX products_sku_uq ON products (lower(sku));
    CREATE INDEX products_active_idx ON products (id) WHERE active;
    CREATE TABLE orders (
      id bigserial PRIMARY KEY, customer_id integer NOT NULL REFERENCES customers (id) ON DELETE CASCADE,
      status order_status NOT NULL DEFAULT 'new', total money_amount NOT NULL DEFAULT 0,
      placed_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz
    );
    CREATE TABLE order_items (
      order_id bigint NOT NULL, product_id integer NOT NULL, qty integer NOT NULL DEFAULT 1 CHECK (qty > 0),
      PRIMARY KEY (order_id, product_id),
      CONSTRAINT order_items_order_fk FOREIGN KEY (order_id) REFERENCES orders (id)
        ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
      CONSTRAINT order_items_product_fk FOREIGN KEY (product_id) REFERENCES products (id)
    );
    CREATE INDEX orders_customer_idx ON orders (customer_id, placed_at DESC);
    CREATE FUNCTION touch_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN NEW.updated_at := now(); RETURN NEW; END $$;
    CREATE TRIGGER orders_touch BEFORE UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
    CREATE FUNCTION order_total(p_order bigint) RETURNS numeric LANGUAGE sql STABLE AS $$
      SELECT coalesce(sum(i.qty * p.price), 0) FROM order_items i JOIN products p ON p.id = i.product_id
       WHERE i.order_id = p_order $$;
    CREATE VIEW open_orders AS
      SELECT o.id, c.email, o.status, o.total FROM orders o JOIN customers c ON c.id = o.customer_id
       WHERE o.status IN ('new', 'paid');
    CREATE VIEW open_order_count AS SELECT email, count(*) AS n FROM open_orders GROUP BY email;
    CREATE MATERIALIZED VIEW sales_by_status AS SELECT status, count(*) AS n, sum(total) AS total FROM orders GROUP BY status;
    CREATE UNIQUE INDEX sales_by_status_idx ON sales_by_status (status);
    ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
    CREATE POLICY orders_rw ON orders TO app_rw USING (true) WITH CHECK (true);
    CREATE POLICY orders_ro ON orders FOR SELECT TO app_ro USING (status <> 'shipped');
    GRANT USAGE ON SCHEMA shop TO app_rw, app_ro;
    GRANT SELECT, INSERT, UPDATE, DELETE ON customers, products, orders, order_items TO app_rw;
    GRANT USAGE ON SEQUENCE products_id_seq, orders_id_seq TO app_rw;
    GRANT SELECT ON customers, products, orders, order_items, open_orders, sales_by_status TO app_ro;
    GRANT EXECUTE ON FUNCTION order_total(bigint) TO app_ro`;
  const wholeTarget = `
    CREATE TYPE order_status AS ENUM ('new', 'paid', 'shipped');
    CREATE TABLE customers (
      id integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, email text NOT NULL,
      full_name varchar(100) NOT NULL, fax text, created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE products (id serial PRIMARY KEY, sku text NOT NULL, name varchar(100) NOT NULL, price numeric(10, 2) NOT NULL);
    CREATE INDEX products_sku_uq ON products (sku);
    CREATE TABLE orders (
      id serial PRIMARY KEY, customer_id integer NOT NULL REFERENCES customers (id),
      status order_status NOT NULL DEFAULT 'new', total numeric(10, 2) NOT NULL DEFAULT 0,
      placed_at timestamp NOT NULL DEFAULT now()
    );
    CREATE TABLE legacy_coupons (id serial PRIMARY KEY, code text);
    CREATE INDEX orders_customer_idx ON orders (customer_id);
    CREATE VIEW open_orders AS
      SELECT o.id, c.email, o.status FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.status = 'new';
    CREATE FUNCTION order_total(p_order integer) RETURNS numeric LANGUAGE sql AS 'SELECT 0::numeric';
    GRANT USAGE ON SCHEMA shop TO app_ro;
    GRANT SELECT ON customers, orders, open_orders TO app_ro;
    GRANT ALL ON legacy_coupons TO app_rw;
    INSERT INTO customers (email, full_name) VALUES ('a@b.com', 'Ann'), ('c@d.com', 'Cy');
    INSERT INTO products (sku, name, price) VALUES ('S1', 'Pen', 2.5), ('S2', 'Ink', 9);
    INSERT INTO orders (customer_id, status, total) VALUES (1, 'new', 5), (2, 'paid', 9);
    INSERT INTO legacy_coupons (code) VALUES ('X')`;

  release("38 a whole release at once, both sides owned by the superuser", {
    source: wholeSource,
    target: wholeTarget,
  });

  release("39 a whole release at once, staging owned by app_owner, a superuser deploys", {
    source: wholeSource,
    target: wholeTarget,
    sourceRole: "app_owner",
  });

  release("40 a whole release at once, staging owned by app_owner, a login that is not a superuser deploys", {
    source: wholeSource,
    target: wholeTarget,
    sourceRole: "app_owner",
    deployAsDeployer: true,
    mayBeLeft: (statement) => statement.kind === "ALTER_OWNER",
  });
  // ── A dropped column under a view that stays ─────────────────────────────

  const viewOverDroppedColumn = `CREATE VIEW customer_names AS SELECT id, name FROM customers;
             GRANT USAGE ON SCHEMA shop TO app_ro, app_rw;`;

  release("41 staging dropped a column and took a grant away from a view that never read it", {
    source: `CREATE TABLE customers (id serial PRIMARY KEY, name text);
             ${viewOverDroppedColumn}
             GRANT SELECT ON customer_names TO app_rw`,
    target: `CREATE TABLE customers (id serial PRIMARY KEY, name text, fax text);
             ${viewOverDroppedColumn}
             GRANT SELECT ON customer_names TO app_rw, app_ro;
             INSERT INTO customers (name, fax) VALUES ('a', '1')`,
  });

  release("42 staging widened a column and took a grant away from a view that reads it", {
    source: `CREATE TABLE customers (id serial PRIMARY KEY, name varchar(200));
             ${viewOverDroppedColumn}
             GRANT SELECT ON customer_names TO app_rw`,
    target: `CREATE TABLE customers (id serial PRIMARY KEY, name varchar(50));
             ${viewOverDroppedColumn}
             GRANT SELECT ON customer_names TO app_rw, app_ro;
             INSERT INTO customers (name) VALUES ('a')`,
  });
});
