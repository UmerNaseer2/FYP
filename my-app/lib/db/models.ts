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
 * A timestamp WITHOUT a time zone.
 *
 * `DataTypes.DATE` is timestamptz on Postgres, which is the better column type
 * and is what the newer tables use. The older ones were created as plain
 * TIMESTAMP, and they still hold data; changing the type here would only mean a
 * fresh database and an existing one disagreed about the shape of the same
 * table. So the models record what is actually there, and the split stays
 * visible instead of becoming a surprise.
 */
const TIMESTAMP = "TIMESTAMP";

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
    created_at: { type: TIMESTAMP, defaultValue: NOW },
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
    created_at: { type: TIMESTAMP, defaultValue: NOW },
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
    captured_at: { type: TIMESTAMP, defaultValue: NOW },
  },
  { sequelize, tableName: "snapshots" }
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
    created_at: { type: TIMESTAMP, defaultValue: NOW },
  },
  {
    sequelize,
    tableName: "lineage_migrations",
    // Two migrations at the same position would make "what is HEAD" ambiguous.
    indexes: [
      {
        name: "lineage_migrations_tracked_schema_id_seq_key",
        unique: true,
        fields: ["tracked_schema_id", "seq"],
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
}

DriftEvent.init(
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    tracked_schema_id: { type: DataTypes.INTEGER, allowNull: false },
    status: { type: DataTypes.TEXT, allowNull: false },
    summary: { type: DataTypes.TEXT, allowNull: true },
    detail: { type: DataTypes.JSONB, allowNull: true },
    baseline_snapshot_id: { type: DataTypes.INTEGER, allowNull: true },
    detected_at: { type: TIMESTAMP, defaultValue: NOW },
    acknowledged_at: { type: TIMESTAMP, allowNull: true },
  },
  { sequelize, tableName: "drift_events" }
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
  { sequelize, tableName: "comparison_sets" }
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
    // Order is part of the data: target 1 and target 2 keep the columns they
    // had when the set was saved, so re-opening a set looks the same every time.
    indexes: [
      {
        name: "comparison_set_targets_position_key",
        unique: true,
        fields: ["set_id", "position"],
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
