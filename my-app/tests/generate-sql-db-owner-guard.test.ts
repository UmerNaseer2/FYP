// generate-sql-db-owner-guard: owner changes the login running the script may
// not make, run on a real PostgreSQL.
//
// Only a superuser, or a login that may act as the new owner, can give an
// object to another role, and only when that role may create in the object's
// schema. A client tester deployed with the reader login the setup guide makes,
// and one refused ALTER ... OWNER TO undid the whole run. Each owner change now
// sits in a DO block that skips it with a warning when PostgreSQL refuses it
// (ownerStatement in lib/sql/generate/privileges.ts), and the schema's own
// grants run before any owner change (objectPhases).
//
// The source has one object of every kind a script gives away, all owned by
// guard_owner. The target has only the table, owned by guard_deployer, the
// login the scripts run as. Each case builds both again and runs the script
// twice, then the rollback:
//
//   guard_deployer may not act as guard_owner: each owner change is skipped
//   with one warning, the rest lands, and only the owner changes are left
//   -> a superuser runs it: every owner moves, no warnings
//   -> guard_deployer is a member of guard_owner: every owner moves, which
//      needs the schema's GRANT CREATE to run before the owner changes
//   -> a member, but guard_owner may not create in the schema: skipped again
//   -> a role that does not exist still stops the run, and nothing lands
//
// The warnings are read with the collector the apply route uses, so they are
// the lines Deploy shows. It needs a Postgres it may create and drop databases
// and roles in, so it runs only when TEST_DATABASE_URL is set, like
// tests/generate-sql-db.test.ts.
import { Client, type ClientConfig } from "pg";
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
import { warningCollector } from "@/lib/deploy/run-warnings";
import { testDatabaseUrl } from "./helpers/test-database";

const testUrl = testDatabaseUrl();
const describeWithDatabase = testUrl ? describe : describe.skip;

const SLOW = 60_000;
const SETUP = 120_000;
const SCHEMA = "shop";
const OWNER = "guard_owner";
const DEPLOYER = "guard_deployer";
const READER = "guard_reader";
const ROLES = [OWNER, DEPLOYER, READER];

/** guard_owner builds the source, so it needs CREATE on the schema there. */
const SOURCE_GRANTS = `GRANT USAGE, CREATE ON SCHEMA ${SCHEMA} TO ${OWNER}; GRANT USAGE ON SCHEMA ${SCHEMA} TO ${READER};`;

const SOURCE_DDL = [
  "CREATE TABLE orders (id serial PRIMARY KEY, total numeric(10,2))",
  "CREATE VIEW big_orders AS SELECT id, total FROM orders WHERE total > 100",
  "CREATE MATERIALIZED VIEW order_totals AS SELECT count(*) AS n FROM orders",
  "CREATE SEQUENCE invoice_numbers",
  "CREATE FUNCTION add_one(i integer) RETURNS integer LANGUAGE sql AS $$ SELECT i + 1 $$",
  "CREATE PROCEDURE tidy_up() LANGUAGE sql AS $$ SELECT 1 $$",
  `GRANT SELECT ON orders TO ${READER}`,
].join("; ");

const TARGET_DDL = "CREATE TABLE orders (id serial PRIMARY KEY)";

/**
 * Every object the script gives to guard_owner, as its warnings name them. The
 * sequence behind orders.id is not here: it follows its table.
 */
const GIVEN_AWAY = [
  "function add_one(integer)",
  "materialized view order_totals",
  "procedure tidy_up()",
  "sequence invoice_numbers",
  "table orders",
  "view big_orders",
];

/** The name an owner change reports when it is skipped, read out of its DO block. */
const REPORTED_NAME = /RAISE WARNING 'The owner of % was not changed: %', '((?:[^']|'')*)', SQLERRM;/;

/** The warning PostgreSQL sends for a skipped owner change. */
const SKIPPED = /^The owner of (.+) was not changed: (.+)$/;

function namesReported(statements: SqlStatement[]): string[] {
  return statements
    .filter((statement) => statement.kind === "ALTER_OWNER")
    .map((statement) => {
      const name = REPORTED_NAME.exec(statement.sql)?.[1];
      return name === undefined ? `(no warning in) ${statement.sql}` : name.replace(/''/g, "'");
    })
    .sort();
}

/** The objects named by the owner warnings, and the reasons PostgreSQL gave. */
function skipped(warnings: string[]): { names: string[]; reasons: string[] } {
  const found = warnings.map((warning) => SKIPPED.exec(warning));
  return {
    names: found.map((match, index) => match?.[1] ?? `(not an owner warning) ${warnings[index]}`).sort(),
    reasons: found.map((match) => match?.[2] ?? ""),
  };
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

describeWithDatabase("owner changes the login may not make, on a real PostgreSQL", () => {
  let server: Client;
  let source: Client;
  let target: Client;
  let sourceConfig: ClientConfig;
  let targetConfig: ClientConfig;
  const databases: string[] = [];

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

  /**
   * Empties the schema in one database and builds it again: guard_deployer
   * owns the schema, and `as` creates everything in `ddl`.
   */
  async function build(db: Client, ddl: string, as: string, grants = ""): Promise<void> {
    await db.query(
      `DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA} AUTHORIZATION ${DEPLOYER}; ${grants}`
    );
    await db.query(`BEGIN; SET LOCAL search_path TO ${SCHEMA}; SET LOCAL ROLE ${as}; ${ddl}; COMMIT;`);
  }

  async function read(config: ClientConfig): Promise<SchemaSnapshot> {
    const answer = await fetchSchemaSnapshot(config, SCHEMA);
    if (!answer.ok) throw new Error(`Could not read the schema: ${answer.error}`);
    return answer.data;
  }

  /** Builds both sides again and compares them. `sourceAfter` runs on the source last. */
  async function freshPair(sourceAfter = "") {
    await build(source, SOURCE_DDL, OWNER, SOURCE_GRANTS);
    if (sourceAfter) await source.query(sourceAfter);
    await build(target, TARGET_DDL, DEPLOYER);
    const wanted = await read(sourceConfig);
    const before = await read(targetConfig);
    const report = compareSchemas(wanted, before);
    return {
      wanted,
      before,
      migration: generateMigration(report, { allowDataLoss: true }),
      rollback: renderRollbackScript(generateRollback(report, { allowDataLoss: true })),
    };
  }

  /** What a script would still have to run to make `to` look like `from`. */
  function stillToDo(from: SchemaSnapshot, to: SchemaSnapshot): SqlStatement[] {
    return statementsThatRun(generateMigration(compareSchemas(from, to), { allowDataLoss: true }));
  }

  /**
   * Runs `scripts` one after another on the target in one transaction, the way
   * Deploy does, then commits. Gives back the warnings each script raised.
   */
  async function runOnTarget(scripts: string[], runAs: string | undefined): Promise<string[][]> {
    const heard: string[][] = [];
    const role = runAs ? `SET LOCAL ROLE ${runAs};` : "";
    await target.query(`BEGIN; SET LOCAL search_path TO ${SCHEMA}; ${role}`);
    for (const [index, script] of scripts.entries()) {
      const collector = warningCollector();
      target.on("notice", collector.listener);
      try {
        await target.query(script);
      } catch (error) {
        await target.query("ROLLBACK");
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`PostgreSQL refused part ${index + 1}: ${message}\n\n${script}`);
      } finally {
        target.off("notice", collector.listener);
      }
      heard.push(collector.result().warnings ?? []);
    }
    await target.query("COMMIT");
    return heard;
  }

  /** Every owner change skipped, everything else run, then the rollback. */
  async function expectOwnersSkipped(
    pair: Awaited<ReturnType<typeof freshPair>>,
    reason: RegExp
  ): Promise<void> {
    const armed = renderMigrationScript(pair.migration);
    const runs = await runOnTarget([armed, armed], DEPLOYER);

    // One warning per object on each run, naming it and why.
    expect(runs).toHaveLength(2);
    for (const warnings of runs) {
      const { names, reasons } = skipped(warnings);
      expect(names).toEqual(GIVEN_AWAY);
      for (const text of reasons) expect(text).toMatch(reason);
    }

    // The owner changes are all that is left, and they are the ones it warned about.
    const left = stillToDo(pair.wanted, await read(targetConfig));
    expect(left.map((statement) => statement.kind)).toEqual(GIVEN_AWAY.map(() => "ALTER_OWNER"));
    expect(namesReported(left)).toEqual(GIVEN_AWAY);

    // The rollback gives nothing away, so it warns about nothing.
    expect(await runOnTarget([pair.rollback], DEPLOYER)).toEqual([[]]);
    expect(stillToDo(pair.before, await read(targetConfig))).toEqual([]);
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
    for (const role of ROLES) {
      await server.query(
        `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') ` +
          `THEN CREATE ROLE ${role} NOLOGIN; END IF; END $$`
      );
    }
    for (const side of ["source", "target"]) {
      const name = `${baseName}_guard_${side}`;
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
    if (sourceConfig) await getPoolForConfig(sourceConfig).end();
    if (targetConfig) await getPoolForConfig(targetConfig).end();
    await source?.end();
    await target?.end();
    for (const name of databases) {
      await server.query(`DROP DATABASE IF EXISTS ${quoteIdent(name)} WITH (FORCE)`);
    }
    // The roles own nothing once both databases are gone.
    for (const role of ROLES) await server?.query(`DROP ROLE IF EXISTS ${role}`);
    await server?.end();
  }, SETUP);

  it("writes one guarded owner change for each object it gives away", async () => {
    const { migration } = await freshPair();

    expect(namesReported(migration.statements)).toEqual(GIVEN_AWAY);
  }, SLOW);

  it("skips each owner change a login may not make, with a warning, and runs the rest", async () => {
    // PostgreSQL 16 and later: must be able to SET ROLE. 13 to 15: must be member of role.
    await expectOwnersSkipped(await freshPair(), new RegExp(`"?${OWNER}"?`));
  }, SLOW);

  it("moves every owner, with no warnings, when a superuser runs it", async () => {
    const pair = await freshPair();
    const armed = renderMigrationScript(pair.migration);

    expect(await runOnTarget([armed, armed], undefined)).toEqual([[], []]);
    expect(stillToDo(pair.wanted, await read(targetConfig))).toEqual([]);
    expect(await runOnTarget([pair.rollback], undefined)).toEqual([[]]);
    expect(stillToDo(pair.before, await read(targetConfig))).toEqual([]);
  }, SLOW);

  it("moves every owner for a login that may act as the new owner", async () => {
    // guard_owner may create in the schema only once the script's own GRANT
    // CREATE has run, so this fails if any owner change comes before it.
    const pair = await freshPair();
    const armed = renderMigrationScript(pair.migration);
    await server.query(`GRANT ${OWNER} TO ${DEPLOYER}`);
    try {
      expect(await runOnTarget([armed, armed], DEPLOYER)).toEqual([[], []]);
      expect(stillToDo(pair.wanted, await read(targetConfig))).toEqual([]);
      expect(await runOnTarget([pair.rollback], DEPLOYER)).toEqual([[]]);
      expect(stillToDo(pair.before, await read(targetConfig))).toEqual([]);
    } finally {
      await server.query(`REVOKE ${OWNER} FROM ${DEPLOYER}`);
    }
  }, SLOW);

  it("skips them again when the new owner may not create in the schema", async () => {
    const pair = await freshPair(`REVOKE CREATE ON SCHEMA ${SCHEMA} FROM ${OWNER}`);
    await server.query(`GRANT ${OWNER} TO ${DEPLOYER}`);
    try {
      await expectOwnersSkipped(pair, new RegExp(`permission denied for schema ${SCHEMA}`));
    } finally {
      await server.query(`REVOKE ${OWNER} FROM ${DEPLOYER}`);
    }
  }, SLOW);

  it("still stops on a role that does not exist, and leaves the target as it was", async () => {
    const pair = await freshPair();
    const armed = renderMigrationScript(pair.migration);
    const broken = armed.split(`OWNER TO ${quoteIdent(OWNER)}`).join(`OWNER TO ${quoteIdent("guard_nobody")}`);

    expect(broken).not.toBe(armed);
    await expect(runOnTarget([broken], DEPLOYER)).rejects.toThrow(/role "guard_nobody" does not exist/);
    expect(stillToDo(pair.before, await read(targetConfig))).toEqual([]);
  }, SLOW);
});
