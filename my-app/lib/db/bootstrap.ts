import { sequelize, metadataPool } from "./sequelize";
import "./models";
import { ENVIRONMENTS, DEFAULT_ENVIRONMENT } from "../environments";
import { DEFAULT_DRIFT_INTERVAL_MINUTES } from "../drift-schedule";
import { DRIFT_SOURCE_VALUES, DEFAULT_DRIFT_SOURCE } from "../drift-source";

/**
 * Create the app's own tables, once per process.
 *
 * This project ships no .sql files and has no migration runner of its own — a
 * deliberate choice, since pointing it at an empty database and having it work
 * is most of what makes it demonstrable. So the tables are created on demand,
 * by the first request that needs them.
 *
 * What changed when Sequelize arrived: there used to be six of these functions
 * scattered across four modules, each holding a CREATE TABLE for the tables it
 * happened to own, and each route calling the two or three it thought it
 * needed. Getting that wrong was silent until a JOIN hit a table nobody had
 * asked for yet. Now the models ARE the schema (lib/db/models.ts) and one
 * `sync()` creates all ten tables in dependency order, so a caller cannot ask
 * for half a database.
 *
 * Three things sync() cannot express, which is why there is anything below it:
 *
 *   • CHECK constraints. Sequelize's `validate` runs in JavaScript, and a rule
 *     that only holds when it happens to be routed through the ORM is not a
 *     rule. These are the real ones, in the database.
 *   • Functional indexes — `lower(email)`, `lower(name)`. Sequelize v6 indexes
 *     are over plain columns.
 *   • Columns added to a table that already exists. `sync()` is
 *     CREATE TABLE IF NOT EXISTS, so it leaves an out-of-date table alone; the
 *     ALTERs bring one forward without asking anybody to run a migration.
 *
 * Everything here is idempotent and runs once per process, so the first request
 * after a boot pays a few milliseconds and the rest pay nothing.
 */

/**
 * The environment list as a SQL literal, generated from the TypeScript union in
 * lib/environments so a new environment can never be valid in one and rejected
 * by the other. Only ever built from our own constants — no user input.
 */
const ENVIRONMENT_SQL_LIST = ENVIRONMENTS.map((e) => `'${e}'`).join(", ");

/** The drift-source list as a SQL literal, generated the same way. */
const DRIFT_SOURCE_SQL_LIST = DRIFT_SOURCE_VALUES.map((s) => `'${s}'`).join(", ");

/**
 * Add a CHECK constraint, tolerating the (normal) case where it is already
 * there. There is no `ADD CONSTRAINT IF NOT EXISTS` in Postgres, so the
 * duplicate-object error is the check.
 */
async function addCheckConstraint(
  table: string,
  constraintName: string,
  check: string
): Promise<void> {
  try {
    await metadataPool.query(
      `ALTER TABLE ${table} ADD CONSTRAINT ${constraintName} CHECK (${check})`
    );
  } catch (error) {
    // 42710 duplicate_object: already added on an earlier boot.
    if ((error as { code?: string })?.code !== "42710") throw error;
  }
}

/**
 * Make sure the `public` schema exists before the metadata tables are created
 * in it.
 *
 * The tables are created unqualified, so they land in whatever the search_path
 * points at — normally `public`. Some databases have had `public` dropped (ones
 * set up with only custom comparison schemas); there, an unqualified
 * CREATE TABLE fails with "no schema has been selected to create in" (Postgres
 * 3F000). Re-creating it is idempotent and cheap.
 */
async function ensureMetadataSchema(): Promise<void> {
  await metadataPool.query("CREATE SCHEMA IF NOT EXISTS public");
}

/** The CHECK constraints, kept out of the models because they belong in the DB. */
async function addConstraints(): Promise<void> {
  await addCheckConstraint(
    "connections",
    "connections_ssl_mode_check",
    "ssl_mode IN ('disable', 'require', 'verify-full')"
  );
  await addCheckConstraint(
    "connections",
    "connections_environment_check",
    `environment IN (${ENVIRONMENT_SQL_LIST})`
  );
  await addCheckConstraint(
    "tracked_schemas",
    "tracked_schemas_environment_check",
    `environment IN (${ENVIRONMENT_SQL_LIST})`
  );
  await addCheckConstraint(
    "drift_events",
    "drift_events_source_check",
    `source IN (${DRIFT_SOURCE_SQL_LIST})`
  );
  // A cadence the scheduler cannot act on is a schema nobody is watching, so
  // the floor is enforced here rather than trusted to every writer.
  await addCheckConstraint(
    "tracked_schemas",
    "tracked_schemas_drift_interval_check",
    "drift_check_interval_minutes >= 0 AND drift_check_interval_minutes <= 10080"
  );
  await addCheckConstraint(
    "profiles",
    "profiles_role_check",
    "role IN ('viewer', 'editor', 'admin')"
  );
  await addCheckConstraint(
    "deploy_approvals",
    "deploy_approvals_status_check",
    "status IN ('pending', 'approved', 'rejected', 'used')"
  );
  // The two-person rule, in the database.
  //
  // A route that forgets to compare the two emails cannot create a
  // self-approved row by accident; it gets an error instead. The one exception
  // is flagged, not hidden: self_approved is set only while the auth bypass is
  // on, when the app has exactly one principal and the rule is unsatisfiable.
  // An audit can then tell the two apart by reading one column.
  await addCheckConstraint(
    "deploy_approvals",
    "deploy_approvals_two_person_check",
    "decided_by IS NULL OR self_approved OR lower(decided_by) <> lower(requested_by)"
  );
}

/** Indexes over an expression rather than a column — outside what sync() emits. */
async function addFunctionalIndexes(): Promise<void> {
  // Email lookups happen on every session read, and "Umer@x" and "umer@x" are
  // the same person.
  await metadataPool.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS profiles_email_key_idx ON profiles (lower(email))`
  );
  // Names are how a set is identified on screen, so two sets called "Nightly"
  // would be indistinguishable in the picker. This index is also what the save
  // upsert conflicts on.
  await metadataPool.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS comparison_sets_name_key
       ON comparison_sets (lower(name))`
  );
}

/**
 * Bring a table created by an older build up to date.
 *
 * Each of these is a column that arrived after its table did. They are written
 * as ADD COLUMN IF NOT EXISTS so they cost one cheap catalogue lookup on a
 * database that is already current, and no data on any database.
 */
async function backfillOlderTables(): Promise<void> {
  // `ssl_mode` replaces an older boolean with a three-way choice. The boolean
  // is kept in step on every write so a rollback to an older build still reads
  // the right thing; `ssl_mode` is what the driver uses.
  await metadataPool.query(
    `ALTER TABLE connections ADD COLUMN IF NOT EXISTS ssl BOOLEAN NOT NULL DEFAULT false`
  );
  await metadataPool.query(
    `ALTER TABLE connections ADD COLUMN IF NOT EXISTS ssl_mode TEXT NOT NULL DEFAULT 'disable'`
  );
  // ssl = true meant "encrypt but don't verify the certificate", which is
  // exactly `require`. Only touches rows still on the default.
  await metadataPool.query(
    `UPDATE connections SET ssl_mode = 'require' WHERE ssl IS TRUE AND ssl_mode = 'disable'`
  );

  // `environment` is the typed dev / staging / prod label. It is deliberately
  // NOT guessed from the row's name: the whole point is that the label is data
  // the app can trust, and a regex over "Prod — RDS" is not that. Rows created
  // before this column arrive as 'unset', and the UI asks for a label.
  await metadataPool.query(
    `ALTER TABLE connections ADD COLUMN IF NOT EXISTS environment TEXT NOT NULL DEFAULT '${DEFAULT_ENVIRONMENT}'`
  );
  await metadataPool.query(
    `ALTER TABLE tracked_schemas ADD COLUMN IF NOT EXISTS environment TEXT NOT NULL DEFAULT '${DEFAULT_ENVIRONMENT}'`
  );

  // How often the scheduler re-checks a tracked schema. Rows created before
  // the scheduler existed get the promised 15 minutes rather than 0: they were
  // tracked by a user who was told the app would watch them, and defaulting to
  // "manual only" would have quietly kept that promise unkept.
  await metadataPool.query(
    `ALTER TABLE tracked_schemas ADD COLUMN IF NOT EXISTS
       drift_check_interval_minutes INTEGER NOT NULL
       DEFAULT ${DEFAULT_DRIFT_INTERVAL_MINUTES}`
  );

  // When a check last ran, whatever it found. See the note on the model for
  // why this is not simply the newest drift_events row.
  await metadataPool.query(
    `ALTER TABLE tracked_schemas ADD COLUMN IF NOT EXISTS last_drift_check_at TIMESTAMPTZ`
  );

  // An "expected, I looked at it" marker on a drift event.
  await metadataPool.query(
    `ALTER TABLE drift_events ADD COLUMN IF NOT EXISTS acknowledged_at TIMESTAMPTZ`
  );

  // What ran the check. Rows written before the scheduler existed default to
  // 'manual', which is not a placeholder — back then a button press was the
  // only thing that could have written one.
  await metadataPool.query(
    `ALTER TABLE drift_events ADD COLUMN IF NOT EXISTS
       source TEXT NOT NULL DEFAULT '${DEFAULT_DRIFT_SOURCE}'`
  );

  // The last "Test" outcome, kept on the row instead of in the page's memory.
  // Every column is nullable and stays null until the connection is tested, so
  // an existing row is honestly "never tested" rather than falsely healthy.
  await metadataPool.query(
    `ALTER TABLE connections ADD COLUMN IF NOT EXISTS last_tested_at TIMESTAMPTZ`
  );
  await metadataPool.query(
    `ALTER TABLE connections ADD COLUMN IF NOT EXISTS last_test_ok BOOLEAN`
  );
  await metadataPool.query(
    `ALTER TABLE connections ADD COLUMN IF NOT EXISTS last_test_version TEXT`
  );
  await metadataPool.query(
    `ALTER TABLE connections ADD COLUMN IF NOT EXISTS last_test_latency_ms INTEGER`
  );
  await metadataPool.query(
    `ALTER TABLE connections ADD COLUMN IF NOT EXISTS last_test_error TEXT`
  );

  // A saved set remembers whether it compares row data as well as structure.
  // Sets saved before the option existed never compared rows, hence false.
  await metadataPool.query(
    `ALTER TABLE comparison_sets
       ADD COLUMN IF NOT EXISTS compare_data BOOLEAN NOT NULL DEFAULT false`
  );

  await alterTimestampColumns();
}

/**
 * Six columns that were created as plain TIMESTAMP, moved to TIMESTAMPTZ.
 *
 * See the note above the model definitions for why: a no-zone timestamp loses
 * the offset on the way in and is re-read as local time on the way out, so the
 * instant a row reports is wrong by whatever the two zones differ by. The models
 * now declare timestamptz, but `sync()` is CREATE TABLE IF NOT EXISTS and never
 * alters an existing table — without this, a database that already exists would
 * keep the old type forever and disagree with a fresh one.
 *
 * The conversion has no USING clause on purpose. Postgres reads the stored wall
 * clock in the session's TimeZone, which is the same interpretation that wrote
 * it: the values were produced by CURRENT_TIMESTAMP down-cast on this same
 * server. Naming a zone here would only be right if it happened to match, and
 * would silently shift every existing row if it did not.
 *
 * Guarded by the catalog rather than being blindly re-run: an ALTER TYPE
 * rewrites the table and takes an ACCESS EXCLUSIVE lock, which is not something
 * to do on every process boot once the work is done.
 */
async function alterTimestampColumns(): Promise<void> {
  const columns: Array<[table: string, column: string]> = [
    ["connections", "created_at"],
    ["tracked_schemas", "created_at"],
    ["snapshots", "captured_at"],
    ["lineage_migrations", "created_at"],
    ["drift_events", "detected_at"],
    ["drift_events", "acknowledged_at"],
  ];

  for (const [table, column] of columns) {
    const found = await metadataPool.query<{ data_type: string }>(
      `SELECT data_type FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = $1 AND column_name = $2`,
      [table, column]
    );
    if (found.rows[0]?.data_type !== "timestamp without time zone") continue;
    await metadataPool.query(
      `ALTER TABLE ${table} ALTER COLUMN ${column} TYPE TIMESTAMPTZ`
    );
  }
}

async function createEverything(): Promise<void> {
  await ensureMetadataSchema();
  // No `alter` and no `force`: this is CREATE TABLE IF NOT EXISTS plus the
  // missing indexes. It never rewrites a table that already holds data, which
  // is the only behaviour that is safe to run on someone's live metadata store
  // at the top of a request.
  await sequelize.sync();
  await backfillOlderTables();
  await addConstraints();
  await addFunctionalIndexes();
}

let inFlight: Promise<void> | null = null;

/**
 * Create the metadata tables if they are not there, at most once per process.
 *
 * A failure is deliberately NOT cached: the next caller retries, so a database
 * that was briefly unreachable heals itself instead of staying broken until the
 * server restarts.
 */
export function syncMetadataTables(): Promise<void> {
  if (!inFlight) {
    inFlight = createEverything().catch((error) => {
      inFlight = null;
      throw error;
    });
  }
  return inFlight;
}
