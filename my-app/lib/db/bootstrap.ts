import { sequelize, metadataPool, type MetadataClient } from "./sequelize";
// Importing the models also registers every one of them with `sequelize`,
// which is what sync() below creates.
import { Organization } from "./models";
import { ENVIRONMENTS, DEFAULT_ENVIRONMENT } from "../environments";
import { DEFAULT_DRIFT_INTERVAL_MINUTES } from "../drift-schedule";
import { DRIFT_SOURCE_VALUES, DEFAULT_DRIFT_SOURCE } from "../drift-source";
import { THRESHOLD_KEYS } from "../perf-thresholds";
import { DEFAULT_EXECUTE_ROLE } from "../connection-access";
import { ORG_SLUG_PATTERN } from "../org-slug";
import {
  ADMIN_ROLE,
  BUILT_IN_ROLES,
  BUILT_IN_ROLE_INFO,
  DEFAULT_ROLE,
  ROLE_CHANGE_KINDS,
  presetFor,
  type BuiltInRole,
} from "../permissions";

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
 * `sync()` creates every one of them in dependency order, so a caller cannot ask
 * for half a database. The count is deliberately not written here: it was "six"
 * and then "ten" in this comment while the models file said otherwise.
 *
 * What sync() cannot express, which is why there is anything below it:
 *
 *   • CHECK constraints. Sequelize's `validate` runs in JavaScript, and a rule
 *     that only holds when it happens to be routed through the ORM is not a
 *     rule. These are the real ones, in the database.
 *   • Functional indexes — `lower(email)`, `lower(name)`. Sequelize v6 indexes
 *     are over plain columns.
 *   • Columns added to a table that already exists. `sync()` is
 *     CREATE TABLE IF NOT EXISTS, so it leaves an out-of-date table alone; the
 *     ALTERs bring one forward without asking anybody to run a migration.
 *   • Keys. sync() writes a foreign key only while it creates a table, never one
 *     that spans two columns, and it never changes a primary key. So every
 *     `org_id` key to `organizations`, the keys on `memberships`, and the
 *     primary keys `roles` and `role_permissions` gained when organizations
 *     arrived are added here, the same way on a new database and an old one
 *     (moveToOrganizations).
 *   • Rows the app cannot work without: the default organization, and in every
 *     organization the built-in roles and the permissions they start with
 *     (ensureDefaultOrganization, setUpRoles).
 *
 * Everything here is idempotent and runs once per process, under a lock in the
 * database (createEverything). The first request after a boot pays a few
 * milliseconds and the rest pay nothing, and two servers starting against the
 * same database take turns instead of racing each other through a migration.
 */

/**
 * The environment list as a SQL literal, generated from the TypeScript union in
 * lib/environments so a new environment can never be valid in one and rejected
 * by the other. Only ever built from our own constants — no user input.
 */
const ENVIRONMENT_SQL_LIST = ENVIRONMENTS.map((e) => `'${e}'`).join(", ");

/** The drift-source list as a SQL literal, generated the same way. */
const DRIFT_SOURCE_SQL_LIST = DRIFT_SOURCE_VALUES.map((s) => `'${s}'`).join(", ");

/** The threshold keys as a SQL literal, generated the same way. */
const THRESHOLD_KEY_SQL_LIST = THRESHOLD_KEYS.map((k) => `'${k}'`).join(", ");

/** The role change kinds as a SQL literal, generated the same way. */
const ROLE_CHANGE_KIND_SQL_LIST = ROLE_CHANGE_KINDS.map((k) => `'${k}'`).join(", ");

/**
 * Every table that holds one organization's data, by its `org_id` column.
 *
 * memberships is not here: its `org_id` is part of its primary key, and its
 * keys are added with the others in addOrganizationKeys.
 */
const ORG_TABLES = [
  "connections",
  "roles",
  "role_permissions",
  "role_changes",
  "tracked_schemas",
  "snapshots",
  "lineage_migrations",
  "drift_events",
  "schema_metrics",
  "query_history",
  "perf_thresholds",
  "comparison_sets",
  "comparison_set_targets",
  "comparison_runs",
  "deploy_approvals",
  "deploy_attempts",
] as const;

/**
 * The key of the database lock createEverything holds while it works.
 *
 * lib/lineage-db.ts and app/api/lineage/rebaseline/route.ts take a one-key
 * pg_advisory_xact_lock keyed by a tracked schema's id, and every one-key lock
 * shares a single space. Those ids are 32-bit integers, so a key above
 * 2^31 - 1 can never be one of them. (lib/family-lock.ts and
 * lib/drift-scheduler.ts use the two-key form, which is a separate space.)
 */
const BOOTSTRAP_LOCK_KEY = 7_365_786_101;

/** The desktop app starts this server with SCHEMA_STUDIO_DESKTOP=1 (see auth.config.ts). */
function onDesktop(): boolean {
  return process.env.SCHEMA_STUDIO_DESKTOP === "1";
}

/**
 * The organization every install starts with, and the one everything made
 * before organizations existed belongs to. On the desktop it is the one
 * person's own, private space.
 */
function defaultOrganization(): { slug: string; name: string; personal: boolean } {
  return onDesktop()
    ? { slug: "personal", name: "Personal", personal: true }
    : { slug: "swinburne-fyp", name: "Swinburne FYP", personal: false };
}

/**
 * What seedBuiltInRoles grants a built-in role and records in preset_applied.
 * Admin gets none: it holds every permission by definition, so it has no rows
 * to seed and nothing to record.
 */
function seededPreset(role: BuiltInRole): readonly string[] {
  return role === ADMIN_ROLE ? [] : presetFor(role) ?? [];
}

/** Quote a PostgreSQL identifier. The same rule the deploy routes use. */
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

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
  // A role key is what memberships.role holds and what the Admin screen sends
  // back, so it stays plain: lowercase letters, digits and dashes, starting
  // with a letter or digit. roleKeyFrom in lib/permissions.ts only makes keys
  // of that shape; this is the rule for anything that does not go through it.
  await addCheckConstraint(
    "roles",
    "roles_name_check",
    "name ~ '^[a-z0-9][a-z0-9-]{0,31}$'"
  );
  // The change log is read by people, so every row has to be one of the
  // kinds the Admin screen knows how to describe.
  await addCheckConstraint(
    "role_changes",
    "role_changes_kind_check",
    `kind IN (${ROLE_CHANGE_KIND_SQL_LIST})`
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
  // An audit trail is only worth reading if its verdicts mean one thing each,
  // and this table is written from a catch block — the one place a typo is
  // least likely to be noticed, because the row is never read back by the code
  // that wrote it.
  await addCheckConstraint(
    "deploy_attempts",
    "deploy_attempts_outcome_check",
    "outcome IN ('applied', 'failed', 'refused', 'unknown')"
  );
  // Only the two routes that spend approvals: the apply route ('deploy') and
  // the revert route ('revert').
  await addCheckConstraint(
    "deploy_approvals",
    "deploy_approvals_action_check",
    "action IN ('deploy', 'revert')"
  );
  // The score band, so a row can never say "excellent" — a word no part of the
  // app knows how to draw. bandFor() in lib/query-score.ts is the only thing
  // that produces this value and it can only produce these three.
  await addCheckConstraint(
    "query_history",
    "query_history_band_check",
    "band IN ('good', 'fair', 'poor')"
  );
  // A score outside 0–100 is arithmetic that went wrong upstream, and it would
  // be drawn as a bar off the end of its track.
  await addCheckConstraint(
    "query_history",
    "query_history_score_check",
    "score >= 0 AND score <= 100"
  );
  // An estimate has no timing and no row count; a measured run has both. This
  // is that rule in the database, so a row cannot claim to be measured while
  // carrying nothing measured, which is the shape that would quietly average
  // into every trend as a zero.
  await addCheckConstraint(
    "query_history",
    "query_history_measured_check",
    "measured OR (exec_time_ms IS NULL AND rows_returned IS NULL)"
  );
  // Only keys the app knows how to evaluate. A row with an unknown key is a
  // rule that can never fire, which is worse than no rule: it looks set.
  await addCheckConstraint(
    "perf_thresholds",
    "perf_thresholds_key_check",
    `threshold_key IN (${THRESHOLD_KEY_SQL_LIST})`
  );
  // An organization's slug is part of every address inside it, so only the
  // plain shape lib/org-slug.ts describes can be stored.
  await addCheckConstraint(
    "organizations",
    "organizations_slug_check",
    `slug ~ '${ORG_SLUG_PATTERN}'`
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
  // in one organization would be indistinguishable in the picker, while
  // another organization's "Nightly" is a different set. This index is also
  // what the save upsert conflicts on. The index it replaces made a name
  // unique across every organization, so that one goes once this one exists.
  await metadataPool.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS comparison_sets_org_name_key
       ON comparison_sets (org_id, lower(name))`
  );
  await metadataPool.query(`DROP INDEX IF EXISTS comparison_sets_name_key`);
  // Same reason for roles: two roles called "QA" and "qa" in one organization
  // would be two rows in the role picker that nobody could tell apart.
  await metadataPool.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS roles_org_label_key
       ON roles (org_id, lower(label))`
  );
  await metadataPool.query(`DROP INDEX IF EXISTS roles_label_key`);
}

/**
 * The built-in roles in every organization, and the permissions they start
 * with.
 *
 * Each organization has its own viewer, editor and admin rows, so what an
 * admin changes about a built-in role in one organization stays in that
 * organization. This finds the organizations that are missing a built-in role,
 * or whose built-in roles have not yet been given a preset permission added to
 * the catalogue since, and seeds each of them in its own transaction
 * (seedBuiltInRoles). On a database that is up to date, the search finds
 * nothing and no connection is borrowed.
 *
 * The CHECK that once held profiles.role to the three built-in words goes
 * too, on a database old enough to have it: a role an admin creates is none
 * of them.
 *
 * Exported for the tests. The app reaches it through syncMetadataTables, which
 * runs it once per process.
 */
export async function setUpRoles(): Promise<void> {
  await metadataPool.query(
    `ALTER TABLE profiles DROP CONSTRAINT IF EXISTS profiles_role_check`
  );

  // Each built-in role, with the preset it should have been given by now. An
  // organization is due if one of its built-in roles is missing, or has not
  // yet recorded every permission in its preset as applied. A role with an
  // empty preset (Admin) only has to exist: seedBuiltInRoles never writes its
  // preset_applied, so a hand-edited value there must not make the
  // organization due on every boot.
  const presets = Object.fromEntries(
    BUILT_IN_ROLES.map((role) => [role, seededPreset(role)])
  );
  const due = await metadataPool.query<{ id: number }>(
    `SELECT o.id FROM organizations o
      WHERE EXISTS (
        SELECT 1 FROM jsonb_each($1::jsonb) AS b(name, preset)
         WHERE NOT EXISTS (
           SELECT 1 FROM roles r
            WHERE r.org_id = o.id AND r.name = b.name
              AND (b.preset = '[]'::jsonb OR r.preset_applied @> b.preset)))
      ORDER BY o.id`,
    [JSON.stringify(presets)]
  );
  if (due.rows.length === 0) return;

  const client = await metadataPool.connect();
  try {
    for (const { id } of due.rows) {
      try {
        await client.query("BEGIN");
        await seedBuiltInRoles(client, id);
        await client.query("COMMIT");
      } catch (error) {
        // The ROLLBACK can fail too (the connection may be what broke), and the
        // error worth reporting is the first one.
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      }
    }
  } finally {
    client.release();
  }
}

/**
 * Write the built-in roles into one organization, and give each the preset
 * permissions (presetFor in lib/permissions.ts) it has not been given yet.
 *
 * This must not undo an admin's work: if they untick "Connections: Delete" for
 * editors, the next boot cannot tick it again. But a permission added to the
 * catalogue later still has to reach the built-in roles, or a new feature would
 * be invisible to everyone but admins. `preset_applied` remembers which preset
 * permissions each role has already been given, so each one is granted once,
 * ever, and after that the admin owns it.
 *
 * It opens no transaction of its own, because the caller's has to hold it:
 * that is what stops two callers seeding the same organization at once from
 * both deciding a permission is new and granting it twice, and what leaves
 * nothing half done after a crash. The row lock below is what makes the second
 * one wait.
 *
 * Exported for the tests.
 */
export async function seedBuiltInRoles(client: MetadataClient, orgId: number): Promise<void> {
  await client.query(
    `INSERT INTO roles (org_id, name, label, description, built_in)
     SELECT $1, name, label, description, true
       FROM unnest($2::text[], $3::text[], $4::text[]) AS r(name, label, description)
     ON CONFLICT (org_id, name) DO NOTHING`,
    [
      orgId,
      [...BUILT_IN_ROLES],
      BUILT_IN_ROLES.map((role) => BUILT_IN_ROLE_INFO[role].label),
      BUILT_IN_ROLES.map((role) => BUILT_IN_ROLE_INFO[role].description),
    ]
  );

  for (const role of BUILT_IN_ROLES) {
    const preset = seededPreset(role);
    // Admin: it holds every permission by definition and has no rows to seed.
    if (preset.length === 0) continue;

    const found = await client.query<{ preset_applied: unknown }>(
      `SELECT preset_applied FROM roles WHERE org_id = $1 AND name = $2 FOR UPDATE`,
      [orgId, role]
    );
    const stored = found.rows[0]?.preset_applied;
    const applied = new Set(
      Array.isArray(stored) ? stored.filter((key) => typeof key === "string") : []
    );
    const fresh = preset.filter((key) => !applied.has(key));
    if (fresh.length === 0) continue;

    await client.query(
      `INSERT INTO role_permissions (org_id, role, feature, action)
       SELECT $1, $2, feature, action
         FROM unnest($3::text[], $4::text[]) AS p(feature, action)
       ON CONFLICT DO NOTHING`,
      [
        orgId,
        role,
        fresh.map((key) => key.split(":")[0]),
        fresh.map((key) => key.split(":")[1]),
      ]
    );
    await client.query(
      `UPDATE roles SET preset_applied = $3::jsonb WHERE org_id = $1 AND name = $2`,
      [orgId, role, JSON.stringify([...applied, ...fresh])]
    );
  }
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
    `-- every organization: an upgrade of the old column, the same for every row
     UPDATE connections SET ssl_mode = 'require' WHERE ssl IS TRUE AND ssl_mode = 'disable'`
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

  // WHICH differences this check found, as one short hash. The scheduler skips
  // writing an event when nothing has changed since the last one, and it used
  // to decide that on the status alone — so a schema that was already "drifted"
  // and then drifted further recorded nothing at all. Nullable on purpose:
  // rows written before this existed, and the deploy and re-baseline rows that
  // have no comparison behind them, leave it NULL, which reads as "not the same
  // as anything" and errs towards recording.
  await metadataPool.query(
    `ALTER TABLE drift_events ADD COLUMN IF NOT EXISTS fingerprint TEXT`
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

  // What an approval authorises: a deploy or a rollback. Every row written
  // before rollbacks needed approval was a deploy, so that is the default.
  // Added here, before addConstraints puts a CHECK on it.
  await metadataPool.query(
    `ALTER TABLE deploy_approvals
       ADD COLUMN IF NOT EXISTS action TEXT NOT NULL DEFAULT 'deploy'`
  );

  // Which columns of which tables an analysed query searched on, read off its
  // plan. Nullable and with no default on purpose: a row stored before this
  // existed genuinely does not know, and an empty array would tell the
  // composite-index rule that the query searched on nothing at all.
  await metadataPool.query(
    `ALTER TABLE query_history ADD COLUMN IF NOT EXISTS searched_columns JSONB`
  );

  // Which table on a target database names the applications it hosts, for the
  // per-application script restriction (lib/application-targeting.ts).
  // Nullable with no default on purpose: a default would be this app guessing
  // a table name on somebody's database, and a wrong guess there reads as
  // "this target hosts nothing" and blocks every restricted script.
  await metadataPool.query(
    `ALTER TABLE connections ADD COLUMN IF NOT EXISTS application_table TEXT`
  );

  // Which tables a saved comparison set limits its row compare to. Nullable
  // with no default, because there are two different states here and a default
  // would flatten them: a set saved since this column existed and chosen to
  // cover every table stores [], while a set saved before it stores NULL
  // because nobody was ever asked. Both run every table — the difference only
  // matters if we ever want to tell the user which of the two happened.
  await metadataPool.query(
    `ALTER TABLE comparison_sets ADD COLUMN IF NOT EXISTS data_tables JSONB`
  );

  // Which role may run a migration against this connection. Defaulted rather
  // than nullable, and defaulted to the setting every existing row already had
  // in practice: before this column, any editor could deploy to any saved
  // connection. Backfilling 'none' would have been the safe-looking choice and
  // the wrong one — it would stop every deployment in an existing install with
  // no message anybody could act on. See lib/connection-access.ts.
  await metadataPool.query(
    `ALTER TABLE connections
       ADD COLUMN IF NOT EXISTS execute_role TEXT NOT NULL DEFAULT '${DEFAULT_EXECUTE_ROLE}'`
  );

  // When an approval stops authorising its run. No default and no NOT NULL:
  // every row decided before the column existed keeps a NULL here and never
  // expires, which is the only honest reading of a decision made when nobody
  // had been told there was a deadline. New approvals get theirs from the
  // decision itself — see APPROVAL_VALID_HOURS in lib/approvals-db.
  await metadataPool.query(
    `ALTER TABLE deploy_approvals
       ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ`
  );

  // A copy of the SQL each approval request covers, so a paired phone can show
  // the approver what they are deciding. Nullable with no default on purpose:
  // a request made before this column existed never had its SQL kept, and the
  // phone says so instead of showing an empty run.
  await metadataPool.query(
    `ALTER TABLE deploy_approvals ADD COLUMN IF NOT EXISTS scripts JSONB`
  );

  // The organization each person last opened (see the Profile model). Empty
  // for everyone at first, which sends them to the default organization, the
  // only one an older install has. Its key comes with the other keys to
  // `organizations`, in addOrganizationKeys.
  await metadataPool.query(
    `ALTER TABLE profiles ADD COLUMN IF NOT EXISTS last_org_id INTEGER`
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

/**
 * Make sure the default organization exists, and return its id.
 *
 * This runs before sync() creates anything else, because addOrgIdToOlderTables
 * needs this id as the new `org_id` of every row that already exists. So
 * `organizations` is the one table created here, on its own.
 */
async function ensureDefaultOrganization(): Promise<number> {
  await Organization.sync();
  const found = await metadataPool.query<{ id: number }>(
    `SELECT id FROM organizations WHERE is_default`
  );
  if (found.rows[0]) return found.rows[0].id;

  const { slug, name, personal } = defaultOrganization();
  // No conflict target, so this covers every unique index, the slug's
  // included: if another organization already holds this address, the insert
  // does nothing and the check below says why.
  await metadataPool.query(
    `INSERT INTO organizations (slug, name, personal, is_default)
     VALUES ($1, $2, $3, true)
     ON CONFLICT DO NOTHING`,
    [slug, name, personal]
  );
  const created = await metadataPool.query<{ id: number }>(
    `SELECT id FROM organizations WHERE is_default`
  );
  const id = created.rows[0]?.id;
  if (!Number.isInteger(id)) {
    throw new Error(
      `The default organization is missing, and its address "${slug}" belongs to another organization. Mark the organization that should be the default with: UPDATE organizations SET is_default = true WHERE slug = '<its address>'`
    );
  }
  return id as number;
}

/**
 * Give every older table its `org_id` column, holding the default
 * organization's id for the rows already there.
 *
 * It has to run before sync(), because sync() adds `<table>_org_id_idx` to
 * tables that already exist, and that index needs the column. A constant
 * default makes the ALTER instant on Postgres 11 and later, whatever the table
 * holds; settleOrgIdDefaults then decides whether the default stays.
 */
async function addOrgIdToOlderTables(defaultId: number): Promise<void> {
  const missing = await metadataPool.query<{ table_name: string }>(
    `SELECT t.table_name FROM information_schema.tables t
      WHERE t.table_schema = current_schema()
        AND t.table_name = ANY($1::text[])
        AND NOT EXISTS (
          SELECT 1 FROM information_schema.columns c
           WHERE c.table_schema = t.table_schema
             AND c.table_name = t.table_name
             AND c.column_name = 'org_id')`,
    [[...ORG_TABLES]]
  );
  for (const { table_name } of missing.rows) {
    // The name comes from the catalog, filtered by our own list above.
    await metadataPool.query(
      `ALTER TABLE ${table_name} ADD COLUMN IF NOT EXISTS org_id INTEGER NOT NULL DEFAULT ${defaultId}`
    );
  }
}

/**
 * Decide whether `org_id` keeps a default.
 *
 * On the web it does not: a query that forgets to say which organization a row
 * belongs to should fail loudly, not quietly file the row under the default
 * one. The desktop keeps the default organization as the default, because a
 * backup made before organizations existed has no `org_id` column, and
 * desktop/src/main/backup.ts accepts a missing column only when it has a
 * default.
 */
async function settleOrgIdDefaults(client: MetadataClient, defaultId: number): Promise<void> {
  const columns = await client.query<{ table_name: string; column_default: string | null }>(
    `SELECT table_name, column_default FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND column_name = 'org_id'
        AND table_name = ANY($1::text[])`,
    [[...ORG_TABLES]]
  );
  for (const { table_name, column_default } of columns.rows) {
    if (onDesktop()) {
      if (column_default === String(defaultId)) continue;
      await client.query(
        `ALTER TABLE ${table_name} ALTER COLUMN org_id SET DEFAULT ${defaultId}`
      );
    } else if (column_default !== null) {
      await client.query(`ALTER TABLE ${table_name} ALTER COLUMN org_id DROP DEFAULT`);
    }
  }
}

/**
 * Give `table` the primary key `columns`, if it has a different one.
 *
 * Postgres cannot change a primary key in place, and will not drop one that a
 * foreign key depends on, so those keys go first. On a database from before
 * organizations that means role_permissions_role_fkey and profiles_role_fkey,
 * which tied rows to a role by its name alone; a name is only unique inside
 * one organization now. addOrganizationKeys puts back what still makes sense.
 */
async function rekey(
  client: MetadataClient,
  table: string,
  columns: readonly string[]
): Promise<void> {
  const current = await client.query<{ conname: string; columns: string[] }>(
    `SELECT c.conname, array_agg(a.attname::text ORDER BY k.ord) AS columns
       FROM pg_constraint c
       CROSS JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
       JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
      WHERE c.conrelid = $1::regclass AND c.contype = 'p'
      GROUP BY c.conname`,
    [table]
  );
  const key = current.rows[0];
  if (key && key.columns.join(",") === columns.join(",")) return;

  const dependents = await client.query<{ conname: string; table_name: string }>(
    `SELECT conname, conrelid::regclass::text AS table_name
       FROM pg_constraint WHERE contype = 'f' AND confrelid = $1::regclass`,
    [table]
  );
  for (const fk of dependents.rows) {
    await client.query(`ALTER TABLE ${fk.table_name} DROP CONSTRAINT ${quoteIdent(fk.conname)}`);
  }
  if (key) {
    await client.query(`ALTER TABLE ${table} DROP CONSTRAINT ${quoteIdent(key.conname)}`);
  }
  await client.query(
    `ALTER TABLE ${table} ADD CONSTRAINT ${table}_pkey PRIMARY KEY (${columns.join(", ")})`
  );
}

/**
 * The foreign keys that hold organizations together.
 *
 * Deleting an organization deletes everything in it, and empties the
 * last_org_id of anyone who last opened it. The two keys to `roles` point at
 * (org_id, name), so a role is only ever found in its own organization: a
 * role somebody holds cannot be deleted (RESTRICT), while a role's
 * permissions go with it (CASCADE).
 *
 * The keys already there are read from the catalog rather than tried and
 * caught: these run inside moveToOrganizations' transaction, where an error
 * would abort it, and adding a key checks every row in the table.
 */
async function addOrganizationKeys(client: MetadataClient): Promise<void> {
  const keys: Array<[table: string, name: string, definition: string]> = [
    ...ORG_TABLES.map((table): [string, string, string] => [
      table,
      `${table}_org_id_fkey`,
      "FOREIGN KEY (org_id) REFERENCES organizations (id) ON DELETE CASCADE",
    ]),
    [
      "role_permissions",
      "role_permissions_org_id_role_fkey",
      "FOREIGN KEY (org_id, role) REFERENCES roles (org_id, name) ON UPDATE CASCADE ON DELETE CASCADE",
    ],
    [
      "memberships",
      "memberships_org_id_fkey",
      "FOREIGN KEY (org_id) REFERENCES organizations (id) ON DELETE CASCADE",
    ],
    [
      "memberships",
      "memberships_profile_id_fkey",
      "FOREIGN KEY (profile_id) REFERENCES profiles (id) ON DELETE CASCADE",
    ],
    [
      "memberships",
      "memberships_org_id_role_fkey",
      "FOREIGN KEY (org_id, role) REFERENCES roles (org_id, name) ON UPDATE CASCADE ON DELETE RESTRICT",
    ],
    [
      "profiles",
      "profiles_last_org_id_fkey",
      "FOREIGN KEY (last_org_id) REFERENCES organizations (id) ON DELETE SET NULL",
    ],
  ];
  const existing = await client.query<{ table_name: string; conname: string }>(
    `SELECT conrelid::regclass::text AS table_name, conname
       FROM pg_constraint WHERE contype = 'f' AND conrelid = ANY($1::regclass[])`,
    [[...ORG_TABLES, "memberships", "profiles"]]
  );
  const have = new Set(existing.rows.map((row) => `${row.table_name}.${row.conname}`));
  for (const [table, name, definition] of keys) {
    if (have.has(`${table}.${name}`)) continue;
    await client.query(`ALTER TABLE ${table} ADD CONSTRAINT ${name} ${definition}`);
  }
}

/**
 * Loosen profiles.role, which no longer decides anything.
 *
 * Roles live on memberships now. The column stays so a database from before
 * organizations, or a pre-organization backup restored on the desktop, still
 * carries it for backfillMemberships to read once. Its default has to go, or
 * it would hand every new person a role in the default organization the next
 * time the server starts.
 */
async function loosenProfileRole(client: MetadataClient): Promise<void> {
  const found = await client.query<{ is_nullable: string; column_default: string | null }>(
    `SELECT is_nullable, column_default FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = 'profiles' AND column_name = 'role'`
  );
  const column = found.rows[0];
  if (!column) return;
  if (column.is_nullable === "NO") {
    await client.query(`ALTER TABLE profiles ALTER COLUMN role DROP NOT NULL`);
  }
  if (column.column_default !== null) {
    await client.query(`ALTER TABLE profiles ALTER COLUMN role DROP DEFAULT`);
  }
}

/**
 * Move a database onto organizations: the `org_id` defaults, the new primary
 * keys of `roles` and `role_permissions`, every key to `organizations`, and
 * the loosened profiles.role.
 *
 * One transaction, so a crash cannot leave `roles` without a primary key. On a
 * database that has already moved, it is five catalog reads and nothing else.
 * It runs on the connection that holds createEverything's lock, because a
 * transaction belongs to one connection and the pool hands out a different one
 * for every statement.
 */
async function moveToOrganizations(client: MetadataClient, defaultId: number): Promise<void> {
  try {
    await client.query("BEGIN");
    await settleOrgIdDefaults(client, defaultId);
    await rekey(client, "roles", ["org_id", "name"]);
    await rekey(client, "role_permissions", ["org_id", "role", "feature", "action"]);
    await addOrganizationKeys(client);
    await loosenProfileRole(client);
    await client.query("COMMIT");
  } catch (error) {
    // The ROLLBACK can fail too (the connection may be what broke), and the
    // error worth reporting is the first one.
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  }
}

/**
 * Give everyone who still has a role on their profile a membership instead.
 *
 * A role there only exists on an install that has just moved onto
 * organizations, or on a desktop that has just restored a backup from before
 * them. That person joins the default organization in that role (Viewer if the
 * role is gone), and the old value is cleared in the same statement, so it is
 * read once and can never give access back.
 */
async function backfillMemberships(defaultId: number): Promise<void> {
  await metadataPool.query(
    `WITH legacy AS (
       SELECT p.id, COALESCE(r.name, $2) AS role
         FROM profiles p
         LEFT JOIN roles r ON r.org_id = $1 AND r.name = p.role
        WHERE p.role IS NOT NULL
     ), joined AS (
       INSERT INTO memberships (org_id, profile_id, role)
       SELECT $1, id, role FROM legacy
       ON CONFLICT DO NOTHING
     )
     UPDATE profiles SET role = NULL WHERE id IN (SELECT id FROM legacy)`,
    [defaultId, DEFAULT_ROLE]
  );
}

/**
 * Everything above, in order, under a lock in the database.
 *
 * The lock is for two servers starting against the same database at once: the
 * second waits, then finds everything already done. It is a session lock, not
 * pg_advisory_xact_lock, on purpose. An xact lock would hold
 * moveToOrganizations' ACCESS EXCLUSIVE locks until one final COMMIT, while the
 * later steps borrow other connections from the pool, so the bootstrap would
 * wait on itself.
 */
async function createEverything(): Promise<void> {
  const lock = await metadataPool.connect();
  try {
    await lock.query("SELECT pg_advisory_lock($1::bigint)", [BOOTSTRAP_LOCK_KEY]);
    try {
      await ensureMetadataSchema();
      const defaultId = await ensureDefaultOrganization();
      await addOrgIdToOlderTables(defaultId);
      // No `alter` and no `force`: this is CREATE TABLE IF NOT EXISTS plus the
      // missing indexes. It never rewrites a table that already holds data, which
      // is the only behaviour that is safe to run on someone's live metadata store
      // at the top of a request.
      await sequelize.sync();
      await backfillOlderTables();
      await moveToOrganizations(lock, defaultId);
      // Before setUpRoles: the old roles_label_key is unique across every
      // organization, so seeding "Viewer" into a second one would fail on it.
      await addFunctionalIndexes();
      // Before backfillMemberships and before the first profile is written:
      // both give people a role, and upsertProfile waits for this whole
      // function.
      await setUpRoles();
      await backfillMemberships(defaultId);
      await addConstraints();
    } finally {
      // A failed unlock in practice means a broken connection, and the server
      // drops a session's advisory locks when the session ends.
      await lock
        .query("SELECT pg_advisory_unlock($1::bigint)", [BOOTSTRAP_LOCK_KEY])
        .catch(() => {});
    }
  } finally {
    lock.release();
  }
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
