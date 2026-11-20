// The public types of the generator: one SQL statement, the options a caller
// passes in, and the finished migration script.

import type { ChangeSeverity } from "../../compare/types";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type SqlStatementKind =
  | "CREATE_TABLE"
  | "DROP_TABLE"
  | "ADD_COLUMN"
  | "DROP_COLUMN"
  | "ALTER_COLUMN_TYPE"
  | "ALTER_COLUMN_NULLABILITY"
  | "ALTER_COLUMN_DEFAULT"
  | "ADD_CONSTRAINT"
  | "DROP_CONSTRAINT"
  | "RENAME_TABLE"
  | "RENAME_COLUMN"
  /** An index, or the key an index backs, moved to another name: see name-clashes.ts. */
  | "RENAME_INDEX"
  | "CREATE_INDEX"
  | "DROP_INDEX"
  | "CREATE_TRIGGER"
  | "DROP_TRIGGER"
  | "ALTER_ROW_SECURITY"
  | "CREATE_POLICY"
  | "DROP_POLICY"
  | "CREATE_VIEW"
  | "DROP_VIEW"
  | "CREATE_SEQUENCE"
  | "DROP_SEQUENCE"
  | "ALTER_SEQUENCE"
  | "CREATE_TYPE"
  | "DROP_TYPE"
  | "ALTER_TYPE"
  | "CREATE_COLLATION"
  | "DROP_COLLATION"
  | "CREATE_EXTENSION"
  | "DROP_EXTENSION"
  | "ALTER_EXTENSION"
  | "CREATE_ROUTINE"
  | "DROP_ROUTINE"
  | "ALTER_OWNER"
  | "GRANT"
  | "REVOKE"
  /**
   * A change PostgreSQL cannot express as runnable DDL — dropping an enum
   * value, say. The `sql` is a `-- MANUAL:` comment describing the work, so it
   * is inert if the script is run as-is but still visible in the diff.
   */
  | "MANUAL";

export type SqlStatement = {
  sql: string;
  description: string;
  kind: SqlStatementKind;
  severity: ChangeSeverity;
  tableName: string;
  /**
   * True when running this statement destroys rows that exist only in the
   * target: DROP TABLE and DROP COLUMN. "breaking" is a wider category — a
   * rename or a narrowing type change is breaking but does not, on its own,
   * throw data away. Safe mode (see MigrationOptions) comments out exactly the
   * statements flagged here.
   */
  destructive: boolean;
  /**
   * True when this statement only does anything if a destructive DROP earlier
   * in the script actually ran, so safe mode has to hold it back too.
   *
   * The case is a rebuilt materialized view. Safe mode commented out the
   * `DROP MATERIALIZED VIEW` and left the paired
   * `CREATE MATERIALIZED VIEW IF NOT EXISTS` live — which found the old matview
   * still there and did nothing. The script reported success while the target
   * kept the old definition and the old rows.
   *
   * Deliberately not `destructive`: running this destroys nothing, and counting
   * it in the destructive tally would over-report what the script deletes.
   */
  needsArmedDrop?: boolean;
  /**
   * For GRANT, REVOKE and ALTER_OWNER: the role the statement names, as
   * written ("PUBLIC" for everybody). The role warning reads it here, because
   * an owner change sits inside a DO block and is no longer the last thing in
   * its SQL.
   */
  role?: string;
};

export type MigrationOptions = {
  /**
   * When false (the default) every destructive statement is still generated and
   * shown, but rendered COMMENTED OUT, so running the script cannot drop a
   * table or a column. The user opts in explicitly to arm them.
   */
  allowDataLoss?: boolean;
  /**
   * The name of the schema this script will be run against, for the one
   * statement that cannot be written without it: a GRANT or an ALTER OWNER on
   * the schema itself.
   *
   * Everything else here is unqualified, because the apply route sets
   * search_path to the target schema first — but there is no unqualified way to
   * name a schema. Defaults to `report.right.schema`, which is the target for a
   * forward migration and is right without anyone passing anything.
   *
   * generateRollback has to pass it. It builds its script from the comparison
   * run BACKWARDS, where `right` is the original SOURCE — so the default would
   * name the schema being copied from, and a rollback of a comparison between
   * two schemas of one database would silently grant on the wrong one.
   */
  appliesToSchema?: string;
};

export type MigrationScript = {
  statements: SqlStatement[];
  warnings: string[];
  sourceSchema: string;
  targetSchema: string;
  /** Whether destructive statements are armed in the rendered SQL. */
  allowDataLoss: boolean;
  /** How many statements would destroy data. */
  destructiveCount: number;
  /**
   * How many statements safe mode comments out. Always at least
   * `destructiveCount`, and larger when a statement is inert without one of
   * those drops — a rebuilt materialized view. Kept separate so the "N
   * destructive statements" wording never counts a statement that destroys
   * nothing.
   */
  heldBackCount: number;
};
