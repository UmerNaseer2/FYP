import {
  DataTypes,
  Model,
  literal,
  type InferAttributes,
  type InferCreationAttributes,
  type CreationOptional,
} from "sequelize";
import { sequelize } from "./sequelize";
import { ENVIRONMENTS, DEFAULT_ENVIRONMENT } from "../environments";
import { DEFAULT_DRIFT_INTERVAL_MINUTES } from "../drift-schedule";
import { DRIFT_SOURCE_VALUES, DEFAULT_DRIFT_SOURCE } from "../drift-source";

/**
 * The app's own tables, as Sequelize models.
 *
 * This file is the schema. Every column the metadata database has is declared
 * here, and `syncMetadataTables()` in lib/db/bootstrap.ts is what creates them
 * on a database that has never seen this app before.
 *
 * Two conventions keep this honest, and both are deliberate:
 *
 *   • Attribute names ARE the column names — `schema_name`, not `schemaName`.
 *     Some metadata reads are still SQL (a recursive lineage walk is not an ORM
 *     query), and a row should look the same whichever way it was fetched.
 *
 *   • No `createdAt`/`updatedAt` magic. The tables that stamp a time do it with
 *     a column that says what the time means — `captured_at`, `detected_at`,
 *     `requested_at` — and the database supplies the default.
 */

/** The environment labels, as Sequelize's ENUM-by-validation sees them. */
const ENVIRONMENT_VALUES = [...ENVIRONMENTS];

/**
 * "The time this row was written", written into the table as a real default.
 *
 * NOT `DataTypes.NOW`, which looks like it does this and does not: Sequelize
 * fills that value in from JavaScript on its own INSERTs and leaves the column
 * with no default at all. Half the writes in this app are hand-written SQL that
 * never names the timestamp column, so a JavaScript-side default would put NULL
 * in a NOT NULL column and fail the insert.
 *
 * There are two spellings because the tables were written at different times
 * and Postgres records the spelling it was given. `now()` and
 * `CURRENT_TIMESTAMP` are the same function, but an app whose entire job is
 * reporting that two schemas differ should not report a difference between a
 * fresh install of itself and an old one.
 */
const NOW = literal("CURRENT_TIMESTAMP");
const NOW_TZ = literal("now()");

/**
 * Every timestamp column below is `DataTypes.DATE`, which Sequelize emits as
 * TIMESTAMP WITH TIME ZONE on Postgres.
 *
 * Six of them used to be plain TIMESTAMP, and a no-zone timestamp is not a
 * point in time — it is a wall clock with the offset thrown away. Writing one
 * discards the zone the server happened to be in; reading it back, node-postgres
 * re-reads that wall clock as LOCAL time in the Node process. With the database
 * on UTC and Node on UTC+5 every stored time came back five hours early, and
 * two screens then labelled that wrong instant "UTC". Nothing in the value says
 * it happened, which is why it survived: on a host where both sides are UTC the
 * two errors cancel.
 *
 * A fresh database and an existing one must not disagree about the same table,
 * so `alterTimestampColumns` in lib/db/bootstrap.ts converts the older columns
 * in place. Changing the types here alone would have fixed new installs only.
 */

// ---------------------------------------------------------------------------
// Saved database connections.
// ---------------------------------------------------------------------------

export class Connection extends Model<
  InferAttributes<Connection>,
  InferCreationAttributes<Connection>
> {
  declare id: CreationOptional<number>;
  declare name: string;
  declare host: string;
  declare port: CreationOptional<number>;
  declare database_name: CreationOptional<string>;
  declare type: CreationOptional<string>;
  declare username: string;
  /** Encrypted at rest by lib/secret-store — never a plaintext password. */
  declare password: string;
  declare connection_string: CreationOptional<string | null>;
  /** Superseded by ssl_mode; kept in step so an older build still reads right. */
  declare ssl: CreationOptional<boolean>;
  declare ssl_mode: CreationOptional<string>;
  declare environment: CreationOptional<string>;
  declare created_at: CreationOptional<Date>;
  /**
   * The outcome of the last "Test" run against this connection.
   *
   * Stored rather than kept in the page's memory because the Connections table
   * has a "Last tested" column and a "Healthy" tile: with the result living
   * only in React state, both reset to "Never" and 0 on every reload, so the
   * screen claimed the connection had never been reached seconds after it was.
   * Null on every row until it is tested for the first time.
   */
  declare last_tested_at: CreationOptional<Date | null>;
  declare last_test_ok: CreationOptional<boolean | null>;
  /** "PostgreSQL 16.2" on success; null on a failure, which reports no version. */
  declare last_test_version: CreationOptional<string | null>;
  declare last_test_latency_ms: CreationOptional<number | null>;
  /** Why the last test failed, so the row can say more than "failed". */
  declare last_test_error: CreationOptional<string | null>;
}

Connection.init(
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    name: { type: DataTypes.TEXT, allowNull: false },
    host: { type: DataTypes.TEXT, allowNull: false },
    port: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 5432 },
    database_name: { type: DataTypes.TEXT, allowNull: false, defaultValue: "postgres" },
    type: { type: DataTypes.TEXT, allowNull: false, defaultValue: "PostgreSQL" },
    username: { type: DataTypes.TEXT, allowNull: false },
    password: { type: DataTypes.TEXT, allowNull: false },
    connection_string: { type: DataTypes.TEXT, allowNull: true },
    ssl: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    ssl_mode: {
      type: DataTypes.TEXT,
      allowNull: false,
      defaultValue: "disable",
      validate: { isIn: [["disable", "require", "verify-full"]] },
    },
    environment: {
      type: DataTypes.TEXT,
      allowNull: false,
      defaultValue: DEFAULT_ENVIRONMENT,
      validate: { isIn: [ENVIRONMENT_VALUES] },
    },
    created_at: { type: DataTypes.DATE, defaultValue: NOW },
    last_tested_at: { type: DataTypes.DATE, allowNull: true },
    last_test_ok: { type: DataTypes.BOOLEAN, allowNull: true },
    last_test_version: { type: DataTypes.TEXT, allowNull: true },
    last_test_latency_ms: { type: DataTypes.INTEGER, allowNull: true },
    last_test_error: { type: DataTypes.TEXT, allowNull: true },
  },
  { sequelize, tableName: "connections" }
);

// ---------------------------------------------------------------------------
// Who may use the app, and as what.
// ---------------------------------------------------------------------------

export class Profile extends Model<
  InferAttributes<Profile>,
  InferCreationAttributes<Profile>
> {
  declare id: CreationOptional<number>;
  declare email: string;
  declare name: CreationOptional<string | null>;
  declare role: CreationOptional<string>;
  declare created_at: CreationOptional<Date>;
  declare last_seen_at: CreationOptional<Date | null>;
}

Profile.init(
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    email: { type: DataTypes.TEXT, allowNull: false, unique: true },
    name: { type: DataTypes.TEXT, allowNull: true },
    role: {
      type: DataTypes.TEXT,
      allowNull: false,
      defaultValue: "viewer",
      validate: { isIn: [["viewer", "editor", "admin"]] },
    },
    created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: NOW_TZ },
    last_seen_at: { type: DataTypes.DATE, allowNull: true },
  },
  { sequelize, tableName: "profiles" }
);

// ---------------------------------------------------------------------------
// Version control: what is tracked, what it looked like, how it got there.
// ---------------------------------------------------------------------------

export class TrackedSchema extends Model<
  InferAttributes<TrackedSchema>,
  InferCreationAttributes<TrackedSchema>
> {
  declare id: CreationOptional<number>;
  declare connection_id: number;
  declare schema_name: string;
  declare label: CreationOptional<string | null>;
  declare environment: CreationOptional<string>;
  /**
   * How often the scheduler re-checks this schema for drift, in minutes.
   * 0 means never — the schema is checked only when somebody presses the
   * button. See lib/drift-schedule.ts for the cadences the UI offers.
   */
  declare drift_check_interval_minutes: CreationOptional<number>;
  /**
   * When a drift check last ran for this schema, from any source.
   *
   * Separate from the newest drift_events row on purpose: "we looked at 14:32
   * and nothing had changed" is worth showing and not worth keeping forever, so
   * the scheduler updates this every time but only writes an event row when the
   * answer actually changed. Null means no check has ever run, which is what
   * makes a freshly tracked schema due immediately.
   */
  declare last_drift_check_at: CreationOptional<Date | null>;
  declare created_at: CreationOptional<Date>;
}

TrackedSchema.init(
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    connection_id: { type: DataTypes.INTEGER, allowNull: false },
    schema_name: { type: DataTypes.TEXT, allowNull: false },
    label: { type: DataTypes.TEXT, allowNull: true },
    environment: {
      type: DataTypes.TEXT,
      allowNull: false,
      defaultValue: DEFAULT_ENVIRONMENT,
      validate: { isIn: [ENVIRONMENT_VALUES] },
    },
    drift_check_interval_minutes: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: DEFAULT_DRIFT_INTERVAL_MINUTES,
    },
    last_drift_check_at: { type: DataTypes.DATE, allowNull: true },
    created_at: { type: DataTypes.DATE, defaultValue: NOW },
  },
  {
    sequelize,
    tableName: "tracked_schemas",
    // One tracking row per schema — tracking the same one twice would give it
    // two lineages that each think they are the truth. Named for the index the
    // original `UNIQUE (...)` constraint created, so sync() recognises it on a
    // database this app has already been run against.
    indexes: [
      {
        name: "tracked_schemas_connection_id_schema_name_key",
        unique: true,
        fields: ["connection_id", "schema_name"],
      },
    ],
  }
);

export class Snapshot extends Model<
  InferAttributes<Snapshot>,
  InferCreationAttributes<Snapshot>
> {
  declare id: CreationOptional<number>;
  declare tracked_schema_id: number;
  /** The whole structural snapshot, as lib/postgres captured it. */
  declare snapshot: unknown;
  declare table_count: CreationOptional<number>;
  declare label: CreationOptional<string | null>;
  declare captured_at: CreationOptional<Date>;
}

Snapshot.init(
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    tracked_schema_id: { type: DataTypes.INTEGER, allowNull: false },
    snapshot: { type: DataTypes.JSONB, allowNull: false },
    table_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    label: { type: DataTypes.TEXT, allowNull: true },
    captured_at: { type: DataTypes.DATE, defaultValue: NOW },
  },
  {
    sequelize,
    tableName: "snapshots",
    // Two jobs, one index. Every read is "the newest snapshot for this tracked
    // schema" (lib/lineage-db), and deleting a tracked schema cascades to every
    // row here — without a leading tracked_schema_id, that delete has to read
    // the whole table, and this is the table that holds a JSON document per row.
    //
    // Ascending is enough for a DESC read: the leading column is fixed by an
    // equality, so Postgres walks the rest of the index backwards for free.
    indexes: [
      {
        name: "snapshots_tracked_schema_id_captured_at_idx",
        fields: ["tracked_schema_id", "captured_at"],
      },
    ],
  }
);

export class LineageMigration extends Model<
  InferAttributes<LineageMigration>,
  InferCreationAttributes<LineageMigration>
> {
  declare id: CreationOptional<number>;
  declare tracked_schema_id: number;
  /** Position in this schema's lineage, 1 upwards. */
  declare seq: number;
  declare name: string;
  declare change_level: string;
  declare version: string;
  declare sql_ref: CreationOptional<string | null>;
  declare snapshot_id: CreationOptional<number | null>;
  declare created_at: CreationOptional<Date>;
}

LineageMigration.init(
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    tracked_schema_id: { type: DataTypes.INTEGER, allowNull: false },
    seq: { type: DataTypes.INTEGER, allowNull: false },
    name: { type: DataTypes.TEXT, allowNull: false },
    change_level: { type: DataTypes.TEXT, allowNull: false },
    version: { type: DataTypes.TEXT, allowNull: false },
    sql_ref: { type: DataTypes.TEXT, allowNull: true },
    snapshot_id: { type: DataTypes.INTEGER, allowNull: true },
    created_at: { type: DataTypes.DATE, defaultValue: NOW },
  },
  {
    sequelize,
    tableName: "lineage_migrations",
    indexes: [
      // Two migrations at the same position would make "what is HEAD"
      // ambiguous. Doubles as the tracked_schema_id cascade index.
      {
        name: "lineage_migrations_tracked_schema_id_seq_key",
        unique: true,
        fields: ["tracked_schema_id", "seq"],
      },
      // For the snapshot prune: a removed snapshot nulls this column on every
      // migration that produced it, and lineage rows are never deleted, so this
      // table only ever gets longer to scan.
      {
        name: "lineage_migrations_snapshot_id_idx",
        fields: ["snapshot_id"],
      },
    ],
  }
);

export class DriftEvent extends Model<
  InferAttributes<DriftEvent>,
  InferCreationAttributes<DriftEvent>
> {
  declare id: CreationOptional<number>;
  declare tracked_schema_id: number;
  declare status: string;
  declare summary: CreationOptional<string | null>;
  declare detail: CreationOptional<unknown>;
  declare baseline_snapshot_id: CreationOptional<number | null>;
  declare detected_at: CreationOptional<Date>;
  /** Set when someone has looked at this drift and decided it is expected. */
  declare acknowledged_at: CreationOptional<Date | null>;
  /**
   * What ran this check — see DRIFT_SOURCES in lib/drift-source.ts.
   *
   * Without it the audit feed cannot tell an automatic check from somebody
   * pressing the button, which is exactly the question a user asks when the app
   * claims to be watching a schema for them.
   */
  declare source: CreationOptional<string>;
}

DriftEvent.init(
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    tracked_schema_id: { type: DataTypes.INTEGER, allowNull: false },
    status: { type: DataTypes.TEXT, allowNull: false },
    summary: { type: DataTypes.TEXT, allowNull: true },
    detail: { type: DataTypes.JSONB, allowNull: true },
    baseline_snapshot_id: { type: DataTypes.INTEGER, allowNull: true },
    detected_at: { type: DataTypes.DATE, defaultValue: NOW },
    acknowledged_at: { type: DataTypes.DATE, allowNull: true },
    source: {
      type: DataTypes.TEXT,
      allowNull: false,
      defaultValue: DEFAULT_DRIFT_SOURCE,
      validate: { isIn: [DRIFT_SOURCE_VALUES] },
    },
  },
  {
    sequelize,
    tableName: "drift_events",
    indexes: [
      // "The newest event for this schema" is asked five separate ways across
      // lib/lineage-db and lib/drift-runner, always as
      // `WHERE tracked_schema_id = $1 ORDER BY detected_at DESC, id DESC`. This
      // is that query, and it is also what stops a tracked schema's delete from
      // scanning the longest table in the app.
      {
        name: "drift_events_tracked_schema_id_detected_at_idx",
        fields: ["tracked_schema_id", "detected_at"],
      },
      // Nothing reads by baseline; this is for the write. Pruning one snapshot
      // has to null every event that pointed at it, and without this that is a
      // full scan of the event feed per snapshot removed.
      {
        name: "drift_events_baseline_snapshot_id_idx",
        fields: ["baseline_snapshot_id"],
      },
    ],
  }
);

/**
 * One reading of a schema's size and shape, taken when a drift check ran.
 *
 * Spec feature 10. This is the only table in the app that grows on a timer
 * rather than because somebody did something, which is why two things about it
 * are unlike every other table here:
 *
 *   • Every column that comes from the server's own statistics is nullable.
 *     Reading `pg_total_relation_size` needs a privilege that reading the
 *     structure does not, so a role that can introspect but not measure gets a
 *     row with real counts and null sizes — which the chart draws as a gap.
 *     Writing 0 there would say the schema was empty.
 *   • Rows are pruned. lib/schema-metrics keeps a bounded window; without that
 *     a quarter-hourly cadence writes about ten thousand rows per schema per
 *     season, and a table nobody ever deletes from is a table that eventually
 *     costs more than the thing it measures.
 */
export class SchemaMetric extends Model<
  InferAttributes<SchemaMetric>,
  InferCreationAttributes<SchemaMetric>
> {
  declare id: CreationOptional<number>;
  declare tracked_schema_id: number;
  /** Counted from the snapshot the drift check had already fetched. */
  declare tables: number;
  declare columns: number;
  declare indexes: number;
  declare foreign_keys: number;
  declare views: number;
  declare routines: number;
  /** Heap + indexes + TOAST. Null when the sizes could not be read. */
  declare total_bytes: CreationOptional<string | null>;
  /** The index share of total_bytes. Null under the same conditions. */
  declare index_bytes: CreationOptional<string | null>;
  /** The planner's row estimate, summed. Null under the same conditions. */
  declare estimated_rows: CreationOptional<string | null>;
  /** Whether the check that took this reading found drift. */
  declare drifted: CreationOptional<boolean>;
  declare sampled_at: CreationOptional<Date>;
}

SchemaMetric.init(
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    tracked_schema_id: { type: DataTypes.INTEGER, allowNull: false },
    tables: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    columns: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    indexes: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    foreign_keys: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    views: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    routines: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    // BIGINT, and therefore a string on the way back out — node-postgres hands
    // every bigint over as text rather than quietly losing precision above
    // 2^53. A schema can genuinely exceed four gigabytes, so INTEGER is not an
    // option and pretending the result is a number is how that becomes a bug.
    total_bytes: { type: DataTypes.BIGINT, allowNull: true },
    index_bytes: { type: DataTypes.BIGINT, allowNull: true },
    estimated_rows: { type: DataTypes.BIGINT, allowNull: true },
    drifted: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    sampled_at: { type: DataTypes.DATE, defaultValue: NOW },
  },
  {
    sequelize,
    tableName: "schema_metrics",
    // Every read is "this schema, newest first, within a window", and every
    // prune is "anything older than a date". One index serves both.
    indexes: [
      {
        name: "schema_metrics_tracked_schema_id_sampled_at_idx",
        fields: ["tracked_schema_id", "sampled_at"],
      },
    ],
  }
);

// ---------------------------------------------------------------------------
// Compare & Author: the selections worth keeping.
// ---------------------------------------------------------------------------

export class ComparisonSet extends Model<
  InferAttributes<ComparisonSet>,
  InferCreationAttributes<ComparisonSet>
> {
  declare id: CreationOptional<number>;
  declare name: string;
  declare source_connection_id: CreationOptional<number | null>;
  /** The connection's name as it was when the set was saved, so a deleted
   *  connection still reads as something a person recognises. */
  declare source_connection_label: CreationOptional<string>;
  declare source_schema: string;
  declare allow_data_loss: CreationOptional<boolean>;
  declare created_at: CreationOptional<Date>;
  declare updated_at: CreationOptional<Date>;
  declare last_run_at: CreationOptional<Date | null>;
}

ComparisonSet.init(
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    name: { type: DataTypes.TEXT, allowNull: false },
    source_connection_id: { type: DataTypes.INTEGER, allowNull: true },
    source_connection_label: { type: DataTypes.TEXT, allowNull: false, defaultValue: "" },
    source_schema: { type: DataTypes.TEXT, allowNull: false },
    allow_data_loss: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: NOW_TZ },
    updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: NOW_TZ },
    last_run_at: { type: DataTypes.DATE, allowNull: true },
  },
  {
    sequelize,
    tableName: "comparison_sets",
    // Deleting a connection nulls this column rather than taking the saved sets
    // with it, and that update has to find the rows first.
    indexes: [
      {
        name: "comparison_sets_source_connection_id_idx",
        fields: ["source_connection_id"],
      },
    ],
  }
);

export class ComparisonSetTarget extends Model<
  InferAttributes<ComparisonSetTarget>,
  InferCreationAttributes<ComparisonSetTarget>
> {
  declare id: CreationOptional<number>;
  declare set_id: number;
  /** Which slot on the Compare screen this target belongs in. */
  declare position: number;
  declare connection_id: CreationOptional<number | null>;
  declare connection_label: CreationOptional<string>;
  declare schema_name: string;
}

ComparisonSetTarget.init(
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    set_id: { type: DataTypes.INTEGER, allowNull: false },
    position: { type: DataTypes.INTEGER, allowNull: false },
    connection_id: { type: DataTypes.INTEGER, allowNull: true },
    connection_label: { type: DataTypes.TEXT, allowNull: false, defaultValue: "" },
    schema_name: { type: DataTypes.TEXT, allowNull: false },
  },
  {
    sequelize,
    tableName: "comparison_set_targets",
    indexes: [
      // Order is part of the data: target 1 and target 2 keep the columns they
      // had when the set was saved, so re-opening a set looks the same every
      // time. Doubles as the set_id cascade index.
      {
        name: "comparison_set_targets_position_key",
        unique: true,
        fields: ["set_id", "position"],
      },
      // The other half of a connection delete — see comparison_sets above.
      {
        name: "comparison_set_targets_connection_id_idx",
        fields: ["connection_id"],
      },
    ],
  }
);

// ---------------------------------------------------------------------------
// The production gate.
// ---------------------------------------------------------------------------

export class DeployApproval extends Model<
  InferAttributes<DeployApproval>,
  InferCreationAttributes<DeployApproval>
> {
  declare id: CreationOptional<number>;
  declare connection_id: number;
  declare schema_name: string;
  declare script_name: string;
  declare target_version: string;
  /** Identifies the exact run this approval covers — see lib/approval-fingerprint. */
  declare run_fingerprint: string;
  declare migration_count: number;
  declare breaking_count: CreationOptional<number>;
  declare requested_by: string;
  declare requested_at: CreationOptional<Date>;
  declare status: CreationOptional<string>;
  declare decided_by: CreationOptional<string | null>;
  declare decided_at: CreationOptional<Date | null>;
  /** Set only while the auth bypass is on, when the two-person rule cannot be met. */
  declare self_approved: CreationOptional<boolean>;
  declare note: CreationOptional<string | null>;
  declare used_at: CreationOptional<Date | null>;
}

DeployApproval.init(
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    connection_id: { type: DataTypes.INTEGER, allowNull: false },
    schema_name: { type: DataTypes.TEXT, allowNull: false },
    script_name: { type: DataTypes.TEXT, allowNull: false },
    target_version: { type: DataTypes.TEXT, allowNull: false },
    run_fingerprint: { type: DataTypes.TEXT, allowNull: false },
    migration_count: { type: DataTypes.INTEGER, allowNull: false },
    breaking_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    requested_by: { type: DataTypes.TEXT, allowNull: false },
    requested_at: { type: DataTypes.DATE, allowNull: false, defaultValue: NOW_TZ },
    status: {
      type: DataTypes.TEXT,
      allowNull: false,
      defaultValue: "pending",
      validate: { isIn: [["pending", "approved", "rejected", "used"]] },
    },
    decided_by: { type: DataTypes.TEXT, allowNull: true },
    decided_at: { type: DataTypes.DATE, allowNull: true },
    self_approved: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    note: { type: DataTypes.TEXT, allowNull: true },
    used_at: { type: DataTypes.DATE, allowNull: true },
  },
  {
    sequelize,
    tableName: "deploy_approvals",
    // Finding the approval that covers a run is the hot path — the apply route
    // does it on every production deploy.
    indexes: [
      {
        name: "deploy_approvals_target_idx",
        fields: ["connection_id", "schema_name", "script_name", "status"],
      },
    ],
  }
);

// ---------------------------------------------------------------------------
// Relationships.
//
// These mirror the foreign keys the tables already have — no more. Two columns
// that look like foreign keys deliberately are not: `tracked_schemas.
// connection_id` and `deploy_approvals.connection_id`. Both record which
// connection something was done through, and deleting that connection must not
// take the schema's whole lineage or its approval history with it.
// ---------------------------------------------------------------------------

TrackedSchema.hasMany(Snapshot, { foreignKey: "tracked_schema_id", onDelete: "CASCADE" });
Snapshot.belongsTo(TrackedSchema, { foreignKey: "tracked_schema_id" });

TrackedSchema.hasMany(LineageMigration, {
  foreignKey: "tracked_schema_id",
  onDelete: "CASCADE",
});
LineageMigration.belongsTo(TrackedSchema, { foreignKey: "tracked_schema_id" });

// A migration keeps its row when the snapshot it produced is pruned — the
// history of what ran is worth more than the structure it left behind.
LineageMigration.belongsTo(Snapshot, { foreignKey: "snapshot_id", onDelete: "SET NULL" });

TrackedSchema.hasMany(DriftEvent, { foreignKey: "tracked_schema_id", onDelete: "CASCADE" });
DriftEvent.belongsTo(TrackedSchema, { foreignKey: "tracked_schema_id" });
DriftEvent.belongsTo(Snapshot, {
  foreignKey: "baseline_snapshot_id",
  onDelete: "SET NULL",
});

// Readings are about a tracked schema and mean nothing without it, so they go
// when it does — unlike drift_events, which are also cascaded, the history here
// is a measurement rather than an audit record.
TrackedSchema.hasMany(SchemaMetric, {
  foreignKey: "tracked_schema_id",
  onDelete: "CASCADE",
});
SchemaMetric.belongsTo(TrackedSchema, { foreignKey: "tracked_schema_id" });

ComparisonSet.hasMany(ComparisonSetTarget, {
  foreignKey: "set_id",
  as: "targets",
  onDelete: "CASCADE",
});
ComparisonSetTarget.belongsTo(ComparisonSet, { foreignKey: "set_id" });

// A saved set outlives the connection it was built against: the label columns
// keep it readable, and the screen asks for a new connection when you run it.
ComparisonSet.belongsTo(Connection, {
  foreignKey: "source_connection_id",
  onDelete: "SET NULL",
});
ComparisonSetTarget.belongsTo(Connection, {
  foreignKey: "connection_id",
  onDelete: "SET NULL",
});
