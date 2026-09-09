import type {
  ChangeSeverity,
  CompareReport,
  ConstraintDiff,
  ObjectDiff,
  TableMatch,
} from "./compare-types";
import type {
  CollationSnapshot,
  ColumnSnapshot,
  ConstraintSnapshot,
  ExtensionSnapshot,
  ForeignKeySnapshot,
  IndexSnapshot,
  PolicySnapshot,
  PrivilegeObjectKind,
  PrivilegeSnapshot,
  RoutineSnapshot,
  RowSecuritySnapshot,
  SequenceOptions,
  SequenceSnapshot,
  TableSnapshot,
  TriggerSnapshot,
  TypeSnapshot,
  ViewSnapshot,
} from "./postgres";
// Severity is NOT decided here. These four helpers live in the compare engine
// and are the single rule for how dangerous each kind of change is, so the
// warning on a statement and the pill in the report are one decision instead of
// two implementations that have to be kept in step by hand.
import {
  compareSchemas,
  computedChangeSeverity,
  constraintChangeSeverity,
  describeComputed,
  domainAddedChecks,
  typeChangeIsAllManual,
  domainNotNullTightens,
  extractBaseType,
  collationChangeSeverity,
  generatedChangeSeverity,
  isNarrowingType,
  nullabilityChangeSeverity,
  extensionUpdateIsForward,
  sequenceBoundsComparable,
  sequenceOptionsChangeSeverity,
  typeChangeSeverity,
  typeSizeParams,
  viewOptionsClause,
} from "./compare";
import { normalizeSimilarityText } from "./compare-utils";
import { changeTypeHeaderLine } from "./change-type";
import type { ChangeLevel } from "./version-detection";
// The compare engine asks this same question when it decides whether to tell
// the reader a range type has to be created by hand.
import { rangeTypeIsCreatable } from "./postgres";

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
};

export type MigrationOptions = {
  /**
   * When false (the default) every destructive statement is still generated and
   * shown, but rendered COMMENTED OUT, so running the script cannot drop a
   * table or a column. The user opts in explicitly to arm them.
   */
  allowDataLoss?: boolean;
  /**
   * Write the restoring statements idempotently: `ADD COLUMN IF NOT EXISTS`
   * instead of a bare `ADD COLUMN`, and the same for `CREATE INDEX` and
   * `CREATE SEQUENCE`.
   *
   * Off for a forward migration: if the column is unexpectedly already there,
   * failing loudly is the right outcome. On for a rollback (generateRollback),
   * which has to run whether or not the forward script's drops were armed — in
   * safe mode nothing was dropped, so the restoring statements must be no-ops
   * rather than errors.
   */
  addColumnIfNotExists?: boolean;
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

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

// Safely double-quote a PostgreSQL identifier, escaping any embedded quotes.
function q(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

function normalizeType(t: string): string {
  return normalizeSimilarityText(t);
}

function isNextvalDefault(defaultValue: string | null): boolean {
  return defaultValue !== null && /^\s*nextval\s*\(/i.test(defaultValue);
}

/** The `serial` spelling for each integer width, or null for other types. */
function serialTypeFor(typeDisplay: string): string | null {
  const baseType = extractBaseType(typeDisplay);
  if (baseType === "smallint") return "smallserial";
  if (baseType === "integer") return "serial";
  if (baseType === "bigint") return "bigserial";
  return null;
}

// Build the column definition fragment used in both CREATE TABLE and ADD COLUMN.
// e.g.  "email" character varying(255) NOT NULL DEFAULT 'anon'
//
// A generated column is reproduced AS IT IS in the source, never converted from
// one flavour to the other. Emitting IDENTITY for a serial column used to look
// harmless — both hand out numbers — but an identity column has no row in
// pg_attrdef, so the table this built compared as "default removed" against the
// very source it was copied from, forever, and no migration could settle it.
/**
 * ` COLLATE "x"` for a column that carries one, or "" for a column on its type
 * default — and also for a snapshot taken before collation was recorded, where
 * the field is undefined and there is nothing honest to write.
 *
 * It goes immediately after the type everywhere it appears, which is the only
 * position the grammar allows in both CREATE TABLE and ALTER COLUMN ... TYPE.
 */
function collateSuffix(col: ColumnSnapshot): string {
  return col.collation ? ` COLLATE ${col.collation}` : "";
}

function buildColumnDef(col: ColumnSnapshot): string {
  // An IDENTITY column in the source stays an IDENTITY column. Identity is
  // restricted to integer types, which have no collation, so none is written.
  if (col.identity) {
    const notNull = col.nullable ? "" : " NOT NULL";
    return (
      `${q(col.name)} ${col.typeDisplay} ` +
      `GENERATED ${col.identity} AS IDENTITY${identityOptionsSuffix(col)}${notNull}`
    );
  }

  // A serial column stays serial. `serial` is shorthand for the integer type
  // plus a sequence named <table>_<column>_seq that the column owns, which is
  // exactly the shape the source has — so this round-trips where a hand-written
  // DEFAULT nextval(...) would fail on a sequence the target does not have.
  //
  // Unless the sequence was tuned: the shorthand has no room for START WITH or
  // INCREMENT BY, so such a column falls through to the plain type below and
  // keeps its nextval default, with the sequence built around it by the caller
  // (see tunedSerialSequence).
  const serialType =
    isNextvalDefault(col.columnDefault) && tunedSerialSequence(col) === null
      ? serialTypeFor(col.typeDisplay)
      : null;
  if (serialType) {
    return `${q(col.name)} ${serialType}${col.nullable ? "" : " NOT NULL"}`;
  }

  let def = `${q(col.name)} ${col.typeDisplay}${collateSuffix(col)}`;
  // A computed column carries its expression instead of a default, never as
  // well as one — writing DEFAULT (price * qty) is what PostgreSQL refuses with
  // "cannot use column reference in DEFAULT expression".
  if (col.generated) {
    def += ` GENERATED ALWAYS AS (${col.generated.expression}) ${col.generated.storage}`;
    if (!col.nullable) def += " NOT NULL";
    return def;
  }
  if (!col.nullable) def += " NOT NULL";
  if (col.columnDefault !== null) def += ` DEFAULT ${col.columnDefault}`;
  return def;
}

// Build a full CREATE TABLE statement for a table that is missing from B.
// FK constraints are intentionally omitted — they are emitted as separate
// ALTER TABLE ADD CONSTRAINT statements later so that the order in which
// tables appear in the script doesn't cause "referenced table doesn't exist yet"
// errors.
//
// The table name is written UNQUALIFIED (no schema prefix). The apply route runs
// `SET LOCAL search_path TO <targetSchema>` (target-only) before executing, so an
// unqualified name always resolves to the schema being applied to — at the
// original apply AND when the stored script is later replayed onto a different
// schema by Version Sync. A hard-coded schema qualifier would ignore search_path
// and silently hit the original schema on replay.
/**
 * Every non-FK constraint on a table, paired with the kind it is reported as.
 *
 * buildCreateTable and lookupConstraintDef both used to walk the four buckets
 * by hand, so adding a fifth kind of constraint meant remembering two separate
 * places. Forgetting either one fails SILENTLY: the constraint is simply never
 * emitted and the migration produces a table that does not match the source.
 * One list, read by both, means a new bucket is added once.
 */
function nonFkConstraints(
  table: TableSnapshot
): { kind: ConstraintDiff["kind"]; constraint: ConstraintSnapshot }[] {
  const all: { kind: ConstraintDiff["kind"]; constraint: ConstraintSnapshot }[] = [];
  if (table.primaryKey) all.push({ kind: "PRIMARY KEY", constraint: table.primaryKey });
  for (const c of table.uniqueConstraints) all.push({ kind: "UNIQUE", constraint: c });
  for (const c of table.checkConstraints) all.push({ kind: "CHECK", constraint: c });
  for (const c of table.excludeConstraints) all.push({ kind: "EXCLUDE", constraint: c });
  return all;
}

/**
 * The CREATE TABLE for a table the target does not have.
 *
 * Partitioning changes the SHAPE of the statement rather than adding a clause
 * to the end of it. A partition takes its columns from its parent and must not
 * repeat them, so it is written `PARTITION OF parent FOR VALUES ...`, while a
 * partitioned parent keeps the ordinary column list and gains `PARTITION BY`.
 * This used to emit three plain CREATE TABLEs for a parent and its two
 * partitions. That runs without error, which is the problem: you get three
 * unrelated tables, and rows inserted into the parent stay in the parent.
 */
function buildCreateTable(table: TableSnapshot): string {
  const constraints = nonFkConstraints(table).map(
    ({ constraint }) => `  CONSTRAINT ${q(constraint.name)} ${constraint.definition}`
  );
  const part = table.partitioning;

  if (part?.partitionOf) {
    // A partition's OWN constraints are legal inside the parens. The ones it
    // inherited are not captured at all (the snapshot filters constraints whose
    // conparentid is set), so nothing here can collide with the parent's.
    const body = constraints.length > 0 ? ` (\n${constraints.join(",\n")}\n)` : "";
    // `bounds` is what pg_get_expr printed — "FOR VALUES ..." or "DEFAULT".
    const bounds = part.bounds ?? "DEFAULT";
    return (
      `CREATE TABLE IF NOT EXISTS ${q(table.name)} ` +
      `PARTITION OF ${q(part.partitionOf)}${body} ${bounds};`
    );
  }

  const lines = table.columns
    .map((col) => `  ${buildColumnDef(col)}`)
    .concat(constraints);

  // INHERITS goes before PARTITION BY; that is the order the grammar wants.
  // A partition never reaches here — its parent is in `partitionOf`, and a
  // table cannot be PARTITION OF and INHERITS at the same time.
  let tail = "";
  if (part && part.inherits.length > 0) {
    tail += `\nINHERITS (${part.inherits.map(q).join(", ")})`;
  }
  if (part?.key) tail += `\nPARTITION BY ${part.key}`;

  return (
    `CREATE TABLE IF NOT EXISTS ${q(table.name)} (\n` +
    lines.join(",\n") +
    `\n)${tail};`
  );
}

/**
 * How the CREATE TABLE line describes itself.
 *
 * A partition and its parent both read "Create table X" otherwise, which hides
 * the one thing about the statement worth noticing.
 */
function describeNewTable(table: TableSnapshot): string {
  const part = table.partitioning;
  if (part?.partitionOf) {
    return `partition "${table.name}" of "${part.partitionOf}"`;
  }
  if (part?.key) {
    return `table "${table.name}", partitioned by ${part.key}`;
  }
  if (part && part.inherits.length > 0) {
    return `table "${table.name}", inheriting from ${part.inherits.join(", ")}`;
  }
  return `table "${table.name}"`;
}

/**
 * Tables ordered so a parent comes before anything hanging off it.
 *
 * PARTITION OF and INHERITS both name a table that has to exist already. The
 * comparator hands tables over in name order, which puts `events_2025` before
 * `events` and makes the script fail on its second statement.
 */
function orderTablesForCreate(tables: TableSnapshot[]): TableSnapshot[] {
  const byName = new Map(tables.map((t) => [t.name, t]));
  const ordered: TableSnapshot[] = [];
  const placed = new Set<string>();
  const visiting = new Set<string>();

  function place(table: TableSnapshot) {
    if (placed.has(table.name)) return;
    // A real schema cannot contain an inheritance cycle, but a hand-edited
    // snapshot could, and that must not hang the generator.
    if (visiting.has(table.name)) return;
    visiting.add(table.name);

    const part = table.partitioning;
    if (part) {
      const parents = part.partitionOf ? [part.partitionOf] : part.inherits;
      for (const name of parents) {
        const parent = byName.get(name);
        if (parent) place(parent);
      }
    }

    visiting.delete(table.name);
    placed.add(table.name);
    ordered.push(table);
  }

  for (const table of tables) place(table);
  return ordered;
}

// Build a FK definition from structured snapshot fields instead of using the
// raw pg_get_constraintdef string.
function buildFkDef(fk: ForeignKeySnapshot, sourceSchema: string): string {
  const localCols = fk.columns.map(q).join(", ");
  const refTable = fk.referencedTable ?? "";
  const refCols = fk.referencedColumns.map(q).join(", ");

  // A SELF-schema reference (points at the source schema, or unknown) is written
  // UNQUALIFIED so search_path scopes it to whatever schema the script is applied
  // to — including a later Version Sync replay onto a different schema (see
  // buildCreateTable). A GENUINE cross-schema reference — any other named schema,
  // even one that happens to share the target schema's name — KEEPS its explicit
  // qualifier so it stays pinned to that schema on replay.
  const refPrefix =
    fk.referencedSchema === sourceSchema || fk.referencedSchema == null
      ? ""
      : `${q(fk.referencedSchema)}.`;
  let def = `FOREIGN KEY (${localCols}) REFERENCES ${refPrefix}${q(refTable)} (${refCols})`;
  // MATCH goes before the referential actions; that is the order the grammar
  // wants and the order pg_get_constraintdef prints.
  if (fk.matchType && fk.matchType !== "SIMPLE") def += ` MATCH ${fk.matchType}`;
  if (fk.onDelete !== "NO ACTION") def += ` ON DELETE ${fk.onDelete}`;
  if (fk.onUpdate !== "NO ACTION") def += ` ON UPDATE ${fk.onUpdate}`;
  // Deferrability and NOT VALID used to be dropped here. The comparator diffs
  // pg_get_constraintdef output, which spells both out, so a key that differed
  // only in one of them was reported, migrated with a statement that did not
  // carry the clause, and then reported again by the next comparison — the diff
  // never converged. Every caller of this is ALTER TABLE ... ADD CONSTRAINT,
  // which is the only place NOT VALID is legal.
  if (fk.deferrable) {
    def += " DEFERRABLE";
    if (fk.initiallyDeferred) def += " INITIALLY DEFERRED";
  }
  // `validated === undefined` is a snapshot taken before this app read the
  // flag: say nothing rather than assert the key was valid.
  if (fk.validated === false) def += " NOT VALID";
  return def;
}

// Look up a non-FK constraint definition from a table snapshot by kind + name.
// FK constraints are handled separately via buildFkDef.
function lookupConstraintDef(
  table: TableSnapshot,
  kind: ConstraintDiff["kind"],
  name: string
): { name: string; definition: string } | null {
  const found = nonFkConstraints(table).find(
    (entry) => entry.kind === kind && entry.constraint.name === name
  );
  return found
    ? { name: found.constraint.name, definition: found.constraint.definition }
    : null;
}

// ---------------------------------------------------------------------------
// Schema object DDL — indexes, triggers, views, sequences, types and routines
//
// Everything generated here runs inside the apply route's single transaction.
// That rules out CONCURRENTLY outright: PostgreSQL rejects both CREATE INDEX
// CONCURRENTLY and DROP INDEX CONCURRENTLY with "cannot run inside a
// transaction block", so indexes are built with a plain CREATE INDEX and the
// table lock that implies. A script that half-applied would be far worse than
// one that holds a lock.
// ---------------------------------------------------------------------------

/** Fill in the fields every object statement shares; call sites carry the rest. */
function objectStatement(fields: {
  sql: string;
  description: string;
  kind: SqlStatementKind;
  severity?: SqlStatement["severity"];
  /** The table for an index/trigger; the object's own name otherwise. */
  tableName: string;
  destructive?: boolean;
  needsArmedDrop?: boolean;
}): SqlStatement {
  return {
    sql: fields.sql,
    description: fields.description,
    kind: fields.kind,
    severity: fields.severity ?? "info",
    tableName: fields.tableName,
    destructive: fields.destructive === true,
    needsArmedDrop: fields.needsArmedDrop === true,
  };
}

/** A SQL string literal — for enum labels, which are values and not identifiers. */
function literal(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** A `-- MANUAL:` line: inert when run, but still visible in the script. */
function manualNote(text: string, description: string, tableName: string): SqlStatement {
  return objectStatement({
    sql: `-- MANUAL: ${text}`,
    description,
    kind: "MANUAL",
    severity: "info",
    tableName,
  });
}

// ── Indexes ────────────────────────────────────────────────────────────────

// pg_get_indexdef returns a complete CREATE INDEX with the schema qualifier
// already stripped at snapshot time, so it replays under search_path as-is.
function indexCreateSql(index: IndexSnapshot, idempotent: boolean): string {
  const definition = index.definition.trim();
  if (!idempotent) return `${definition};`;
  return `${definition.replace(/^(CREATE\s+(?:UNIQUE\s+)?INDEX)\s+/i, "$1 IF NOT EXISTS ")};`;
}

/**
 * @param afterHeldBackDrop set for an index on a view whose drop safe mode
 * comments out. The old view is then still sitting there with this index
 * already on it, and a plain CREATE INDEX fails on the duplicate name — inside
 * the one transaction the apply route uses, which takes the whole migration
 * down with it. Held back beside the view instead.
 */
function createIndexStatement(
  index: IndexSnapshot,
  tableName: string,
  idempotent: boolean,
  afterHeldBackDrop = false
): SqlStatement {
  return objectStatement({
    sql: indexCreateSql(index, idempotent),
    needsArmedDrop: afterHeldBackDrop,
    // A unique index is built against the rows already in the table and refused
    // if two of them collide, so it can abort the migration on real data — the
    // same reason every ADD CONSTRAINT is breaking. A plain index cannot fail
    // that way, so it stays informational.
    description: index.isUnique
      ? `Create unique index "${index.name}" on "${tableName}" — WARNING: fails if any two rows already collide`
      : `Create index "${index.name}" on "${tableName}"`,
    kind: "CREATE_INDEX",
    severity: index.isUnique ? "breaking" : "info",
    tableName,
  });
}

function dropIndexStatement(index: IndexSnapshot, tableName: string): SqlStatement {
  return objectStatement({
    sql: `DROP INDEX IF EXISTS ${q(index.name)};`,
    // A unique index is the only kind whose removal changes what the data is
    // allowed to be, rather than only how fast it is read.
    description: index.isUnique
      ? `Drop unique index "${index.name}" from "${tableName}" — WARNING: stops enforcing uniqueness`
      : `Drop index "${index.name}" from "${tableName}"`,
    kind: "DROP_INDEX",
    severity: index.isUnique ? "breaking" : "safe",
    tableName,
  });
}

// ── Triggers ───────────────────────────────────────────────────────────────

// CREATE TRIGGER has no IF NOT EXISTS, so a preceding DROP is the only way to
// make it idempotent. That is also what makes a changed trigger replaceable.
function createTriggerStatements(
  trigger: TriggerSnapshot,
  tableName: string,
  opts: {
    /**
     * Set for a trigger on a view whose drop safe mode comments out — see
     * createIndexStatement. The DROP/CREATE pair itself would succeed against
     * the old view, but it would be putting the source's trigger onto the
     * target's view, which is not a state either side asked for.
     */
    afterHeldBackDrop?: boolean;
    /**
     * Set when `tableName` names a view rather than a table.
     *
     * PostgreSQL has no way to disable a trigger on a view: ALTER TABLE is the
     * only syntax that carries DISABLE TRIGGER, and it answers "ALTER action
     * DISABLE TRIGGER cannot be performed on relation" for a view. So a view
     * trigger is always enabled and the disable line below is skipped — which
     * matters, because the apply route runs the migration in one transaction
     * and that one rejected statement would take every other one down with it.
     */
    onView?: boolean;
  } = {}
): SqlStatement[] {
  const afterHeldBackDrop = opts.afterHeldBackDrop ?? false;
  const stmts: SqlStatement[] = [
    objectStatement({
      sql: `DROP TRIGGER IF EXISTS ${q(trigger.name)} ON ${q(tableName)};`,
      description: `Replace trigger "${trigger.name}" on "${tableName}"`,
      kind: "DROP_TRIGGER",
      tableName,
      needsArmedDrop: afterHeldBackDrop,
    }),
    objectStatement({
      sql: `${trigger.definition.trim()};`,
      description: `Create trigger "${trigger.name}" on "${tableName}"`,
      kind: "CREATE_TRIGGER",
      tableName,
      needsArmedDrop: afterHeldBackDrop,
    }),
  ];
  // A trigger is created enabled. Recreating a disabled one without this would
  // silently turn its behaviour back on in the target.
  if (!trigger.enabled && !opts.onView) {
    stmts.push(
      objectStatement({
        sql: `ALTER TABLE ${q(tableName)} DISABLE TRIGGER ${q(trigger.name)};`,
        description: `Disable trigger "${trigger.name}" on "${tableName}" (it is disabled in the source)`,
        kind: "CREATE_TRIGGER",
        tableName,
        needsArmedDrop: afterHeldBackDrop,
      })
    );
  }
  return stmts;
}

function dropTriggerStatement(triggerName: string, tableName: string): SqlStatement {
  return objectStatement({
    sql: `DROP TRIGGER IF EXISTS ${q(triggerName)} ON ${q(tableName)};`,
    description: `Drop trigger "${triggerName}" from "${tableName}" — WARNING: the behaviour it enforced stops`,
    kind: "DROP_TRIGGER",
    severity: "breaking",
    tableName,
  });
}

// ── Row-level security ─────────────────────────────────────────────────────

/**
 * Bring one table's row-security switches to the source's setting.
 *
 * Two switches, not one: ENABLE decides whether policies are enforced at all,
 * FORCE decides whether they are enforced against the table's own owner too.
 * Only the ones that actually differ are written, so a migration that changed a
 * policy does not also carry a no-op ENABLE line.
 */
function rowSecurityStatements(
  source: RowSecuritySnapshot,
  target: RowSecuritySnapshot,
  tableName: string
): SqlStatement[] {
  const stmts: SqlStatement[] = [];

  if (source.enabled !== target.enabled) {
    stmts.push(
      objectStatement({
        sql: `ALTER TABLE ${q(tableName)} ${source.enabled ? "ENABLE" : "DISABLE"} ROW LEVEL SECURITY;`,
        description: source.enabled
          ? `Enable row level security on "${tableName}" — WARNING: every query now returns ` +
            "only the rows a policy allows, and a table with no policy returns none"
          : `Disable row level security on "${tableName}" — WARNING: its policies stop being ` +
            "enforced and every row becomes visible to anyone who can read the table",
        kind: "ALTER_ROW_SECURITY",
        // Breaking in both directions, and for opposite reasons. See
        // objectChangeSeverity in lib/compare.ts.
        severity: "breaking",
        tableName,
      })
    );
  }

  if (source.forced !== target.forced) {
    stmts.push(
      objectStatement({
        sql: `ALTER TABLE ${q(tableName)} ${source.forced ? "FORCE" : "NO FORCE"} ROW LEVEL SECURITY;`,
        description: source.forced
          ? `Apply row level security to the owner of "${tableName}" as well`
          : `Stop applying row level security to the owner of "${tableName}"`,
        kind: "ALTER_ROW_SECURITY",
        severity: "breaking",
        tableName,
      })
    );
  }

  return stmts;
}

function createPolicyStatement(policy: PolicySnapshot, tableName: string): SqlStatement {
  return objectStatement({
    sql: `CREATE POLICY ${q(policy.name)} ON ${q(tableName)} ${policy.definition};`,
    description: `Create policy "${policy.name}" on "${tableName}" — check who this lets in`,
    kind: "CREATE_POLICY",
    severity: "breaking",
    tableName,
  });
}

function dropPolicyStatement(policyName: string, tableName: string, why: string): SqlStatement {
  return objectStatement({
    sql: `DROP POLICY IF EXISTS ${q(policyName)} ON ${q(tableName)};`,
    description: `Drop policy "${policyName}" from "${tableName}"${why}`,
    kind: "DROP_POLICY",
    severity: "breaking",
    tableName,
  });
}

// ── Views ──────────────────────────────────────────────────────────────────

/**
 * @param afterHeldBackDrop whether this script drops a view of this name with a
 * statement safe mode comments out, so this one is putting back something that
 * in safe mode was never taken away.
 */
function createViewStatement(view: ViewSnapshot, afterHeldBackDrop: boolean): SqlStatement {
  // pg_get_viewdef already ends in a semicolon and starts with whitespace.
  const body = view.definition.trim();
  // security_invoker, check_option, security_barrier and a matview's storage
  // settings live here and nowhere in the body. Writing them out is not just
  // for completeness: CREATE OR REPLACE VIEW REPLACES the option list, so an
  // omitted WITH clause silently strips security_invoker off a view this
  // statement was only meant to put back after a CASCADE took it.
  const options = viewOptionsClause(view);
  const head = options ? `${q(view.name)} ${options}` : q(view.name);
  // Neither form fails when the view is already there. That matters because
  // this same statement is used to put back a view a CASCADE *may* have taken:
  // if it survived, running this is harmless.
  //
  // The two forms are not equally harmless, though. CREATE OR REPLACE rewrites
  // whatever it finds; IF NOT EXISTS finds the old matview and does NOTHING.
  const sql = view.materialized
    ? `CREATE MATERIALIZED VIEW IF NOT EXISTS ${head} AS\n${body}`
    : `CREATE OR REPLACE VIEW ${head} AS\n${body}`;
  const note = options ? ` ${options}` : "";
  return objectStatement({
    sql: sql.endsWith(";") ? sql : `${sql};`,
    description: `Create ${view.materialized ? "materialized view" : "view"} "${view.name}"${note}`,
    kind: "CREATE_VIEW",
    tableName: view.name,
    // ...which is why a rebuild is held back with a drop safe mode comments
    // out. The old materialized view is then still sitting there, and this
    // statement either does nothing (IF NOT EXISTS) or fails outright
    // ("x is not a view", when the source made it a plain view). Either way
    // the script must not run it and report success.
    needsArmedDrop: afterHeldBackDrop,
  });
}

function dropViewStatement(view: ViewSnapshot, reason: string): SqlStatement {
  return objectStatement({
    sql: view.materialized
      ? `DROP MATERIALIZED VIEW IF EXISTS ${q(view.name)} CASCADE;`
      : `DROP VIEW IF EXISTS ${q(view.name)} CASCADE;`,
    description: `Drop ${view.materialized ? "materialized view" : "view"} "${view.name}"${reason}`,
    kind: "DROP_VIEW",
    severity: "breaking",
    tableName: view.name,
    // A plain view is a stored query and holds nothing. A materialized view
    // holds its own copy of the rows, and dropping it throws them away.
    destructive: view.materialized,
  });
}

/**
 * Order views so each one comes after everything it reads.
 *
 * A view built on another view fails to create if its source is not there yet,
 * and fails to drop cleanly in the other direction. `dependsOn` comes from
 * pg_depend, so this is the real dependency graph and not a guess parsed out of
 * the SELECT text. `visiting` only guards the recursion — PostgreSQL does not
 * allow a cycle between views in the first place.
 */
function sortViewsByDependency(views: ViewSnapshot[]): ViewSnapshot[] {
  const byName = new Map(views.map((view) => [view.name, view]));
  const ordered: ViewSnapshot[] = [];
  const placed = new Set<string>();
  const visiting = new Set<string>();

  function place(view: ViewSnapshot): void {
    if (placed.has(view.name) || visiting.has(view.name)) return;
    visiting.add(view.name);
    for (const dependency of view.dependsOn) {
      const source = byName.get(dependency);
      if (source) place(source);
    }
    visiting.delete(view.name);
    placed.add(view.name);
    ordered.push(view);
  }

  for (const view of views) place(view);
  return ordered;
}

/**
 * Every view that a `DROP ... CASCADE` on one of `doomedRelations` will take
 * with it, including views built on those views.
 *
 * This is the whole reason ViewSnapshot records dependsOn. CASCADE is silent:
 * it destroys dependents without naming them, and a report that never mentioned
 * them cannot put them back. Knowing the list up front means the script can say
 * what it is about to remove, and can recreate the ones that should survive.
 */
function viewsCascadedBy(views: ViewSnapshot[], doomedRelations: Set<string>): ViewSnapshot[] {
  const doomed = new Set(doomedRelations);
  let grew = true;
  while (grew) {
    grew = false;
    for (const view of views) {
      if (doomed.has(view.name)) continue;
      if (view.dependsOn.some((dependency) => doomed.has(dependency))) {
        doomed.add(view.name);
        grew = true;
      }
    }
  }
  return views.filter((view) => doomed.has(view.name));
}

// ── Sequences ──────────────────────────────────────────────────────────────

/**
 * The MAXVALUE a sequence takes when nobody set one, per underlying type.
 *
 * Used to tell a sequence that was configured from one that was merely created:
 * an unknown type is deliberately absent so it reads as "configured" and the
 * options get written out rather than silently dropped.
 */
const SEQUENCE_TYPE_MAX: Record<string, string> = {
  smallint: "32767",
  integer: "2147483647",
  bigint: "9223372036854775807",
};

/**
 * Whether these are the settings a sequence gets when nobody chose any.
 *
 * The point is to keep the common case looking exactly as it always has. A
 * plain `serial` or a plain `GENERATED ALWAYS AS IDENTITY` still generates as
 * `serial` and as a bare IDENTITY, and only a column somebody actually tuned
 * grows a clause. Same reasoning as the range types, which are left out of a
 * CREATE TYPE unless a subtype option was really chosen.
 *
 * A descending sequence (INCREMENT BY -1) fails this on its bounds, which is
 * correct — its settings were chosen and have to be written down.
 */
function sequenceOptionsAreDefault(options: SequenceOptions): boolean {
  const typeMax = SEQUENCE_TYPE_MAX[options.dataType];
  if (typeMax === undefined) return false;
  return (
    options.startValue === "1" &&
    options.increment === "1" &&
    options.minValue === "1" &&
    options.maxValue === typeMax &&
    options.cacheSize === "1" &&
    !options.cycles
  );
}

/**
 * The sequence options as one line, for the parenthesised list that follows
 * `AS IDENTITY`.
 *
 * No `AS <type>` in this one: inside an identity clause the type comes from the
 * column, and writing it there is a syntax error.
 */
function sequenceOptionsInline(options: SequenceOptions): string {
  return [
    `START WITH ${options.startValue}`,
    `INCREMENT BY ${options.increment}`,
    `MINVALUE ${options.minValue}`,
    `MAXVALUE ${options.maxValue}`,
    `CACHE ${options.cacheSize}`,
    options.cycles ? "CYCLE" : "NO CYCLE",
  ].join(" ");
}

/**
 * ` (START WITH … )` for a column whose sequence was tuned, or "" for one on
 * the defaults — and also for a snapshot taken before the settings were read,
 * where the field is undefined and there is nothing honest to write.
 */
function identityOptionsSuffix(col: ColumnSnapshot): string {
  const options = col.sequenceOptions;
  if (!options || sequenceOptionsAreDefault(options)) return "";
  return ` (${sequenceOptionsInline(options)})`;
}

/**
 * The sequence behind a `serial` column whose settings the `serial` shorthand
 * cannot carry, or null when the shorthand is fine.
 *
 * `serial` expands to a sequence on every default, so a column whose sequence
 * starts at 10 and steps by 4 comes out starting at 1 and stepping by 1 — two
 * shards that were handing out interleaved ids quietly start handing out the
 * same ones. Such a column gives up the shorthand and is written the long way
 * instead: CREATE SEQUENCE, the plain type with its nextval default, then
 * ALTER SEQUENCE … OWNED BY, which is byte-for-byte the catalog state `serial`
 * would have produced.
 *
 * The name comes out of the column's own default rather than the schema's
 * sequence list, because an owned sequence is never in the object diffs — it
 * belongs to its column, not to the schema.
 */
function tunedSerialSequence(
  col: ColumnSnapshot
): { name: string; options: SequenceOptions } | null {
  if (col.identity) return null;
  const options = col.sequenceOptions;
  if (!options || sequenceOptionsAreDefault(options)) return null;
  if (serialTypeFor(col.typeDisplay) === null) return null;
  const name = nextvalSequenceName(col.columnDefault);
  return name === null ? null : { name, options };
}

// Only STANDALONE sequences reach here: the comparator drops the ones owned by
// a serial or identity column, because those are created by the column itself
// and a CREATE SEQUENCE for them would collide.
function sequenceClauses(sequence: SequenceOptions): string[] {
  return [
    `  AS ${sequence.dataType}`,
    `  INCREMENT BY ${sequence.increment}`,
    `  MINVALUE ${sequence.minValue}`,
    `  MAXVALUE ${sequence.maxValue}`,
    `  START WITH ${sequence.startValue}`,
    `  CACHE ${sequence.cacheSize}`,
    sequence.cycles ? "  CYCLE" : "  NO CYCLE",
  ];
}

function createSequenceStatement(
  sequence: SequenceSnapshot,
  idempotent: boolean
): SqlStatement {
  const head = `CREATE SEQUENCE${idempotent ? " IF NOT EXISTS" : ""} ${q(sequence.name)}`;
  return objectStatement({
    sql: `${[head, ...sequenceClauses(sequence)].join("\n")};`,
    description: `Create sequence "${sequence.name}"`,
    kind: "CREATE_SEQUENCE",
    tableName: sequence.name,
  });
}

function alterSequenceStatement(sequence: SequenceSnapshot): SqlStatement {
  return objectStatement({
    sql: `${[`ALTER SEQUENCE ${q(sequence.name)}`, ...sequenceClauses(sequence)].join("\n")};`,
    // START WITH changes where a future RESTART begins, not the value the
    // sequence is currently sitting on. Saying so stops the script from looking
    // like it rewinds a live counter.
    description: `Update sequence "${sequence.name}" bounds (does not move its current value)`,
    kind: "ALTER_SEQUENCE",
    tableName: sequence.name,
  });
}

/**
 * One clause of a sequence reconfiguration.
 *
 * `set` says whether the ALTER TABLE spelling wants SET in front of it: every
 * clause here takes it except RESTART, where `ALTER COLUMN id SET RESTART` is a
 * syntax error and `ALTER COLUMN id RESTART WITH 5000` is the form. The
 * ALTER SEQUENCE spelling takes all of them bare.
 */
type SequenceStep = { clause: string; set: boolean; description: string };

/**
 * The settings that have to be changed to move a sequence from `target` to
 * `source`, in an order that never leaves it in a state PostgreSQL rejects.
 *
 * The order is widen, then move START, then RESTART, then narrow, and it is the
 * whole reason this is a list rather than one statement. PostgreSQL rechecks
 * the sequence after every step, and all three of these are real answers it
 * gave to the obvious orderings:
 *
 * - "MINVALUE (5000) must be less than MAXVALUE (1000)" — raising the minimum
 *   before widening the maximum.
 * - "START value (1) cannot be less than MINVALUE (10)" — narrowing the
 *   minimum before moving START up to meet it.
 * - "RESTART value (800) cannot be greater than MAXVALUE (500)" — narrowing a
 *   bound past the number the sequence is currently sitting on.
 *
 * That last one is why a narrowing carries a RESTART. There is no way to give a
 * sequence a bound its counter is already outside of, so the counter moves to
 * the source's own START, which is by definition inside the new range. It is
 * the reason narrowing a bound is graded breaking: on a table with rows the
 * counter can move BACKWARDS, and the ids it then hands out are ones the table
 * already has.
 */
function sequenceOptionSteps(
  source: SequenceOptions,
  target: SequenceOptions
): SequenceStep[] {
  // A bound past what a JavaScript number holds exactly is normal here —
  // MAXVALUE on a bigint sequence is 9223372036854775807 — so the comparison
  // is done in BigInt. A value that will not parse is treated as a widening,
  // which only affects where its clause lands in the list.
  const widens = (from: string, to: string, looser: (a: bigint, b: bigint) => boolean) => {
    try {
      return looser(BigInt(to.trim()), BigInt(from.trim()));
    } catch {
      return true;
    }
  };
  // Bounds are left alone once the underlying type differs: they moved because
  // the column's type did, and ALTER COLUMN ... TYPE has already carried them.
  // Same rule the report reads — see sequenceBoundsComparable.
  const bounds = sequenceBoundsComparable(source, target);
  const minMoved = bounds && source.minValue !== target.minValue;
  const maxMoved = bounds && source.maxValue !== target.maxValue;
  const minWidens = minMoved && widens(target.minValue, source.minValue, (a, b) => a < b);
  const maxWidens = maxMoved && widens(target.maxValue, source.maxValue, (a, b) => a > b);

  const step = (clause: string): SequenceStep => ({
    clause,
    set: true,
    description: `Set ${clause}`,
  });

  const steps: SequenceStep[] = [];
  if (maxWidens) steps.push(step(`MAXVALUE ${source.maxValue}`));
  if (minWidens) steps.push(step(`MINVALUE ${source.minValue}`));
  if (source.startValue !== target.startValue) {
    steps.push(step(`START WITH ${source.startValue}`));
  }
  if ((minMoved && !minWidens) || (maxMoved && !maxWidens)) {
    steps.push({
      clause: `RESTART WITH ${source.startValue}`,
      set: false,
      description:
        `Move the counter to ${source.startValue} — WARNING: the narrower ` +
        "bounds below cannot be set while it sits outside them, and on a table " +
        "with rows a counter that moves backwards hands out ids the table has",
    });
  }
  if (minMoved && !minWidens) steps.push(step(`MINVALUE ${source.minValue}`));
  if (maxMoved && !maxWidens) steps.push(step(`MAXVALUE ${source.maxValue}`));
  if (source.increment !== target.increment) {
    steps.push(step(`INCREMENT BY ${source.increment}`));
  }
  if (source.cacheSize !== target.cacheSize) steps.push(step(`CACHE ${source.cacheSize}`));
  if (source.cycles !== target.cycles) {
    steps.push(step(source.cycles ? "CYCLE" : "NO CYCLE"));
  }
  return steps;
}

/**
 * The CREATE SEQUENCE that has to run before a tuned serial column exists, and
 * the ALTER SEQUENCE … OWNED BY that has to run after it.
 *
 * Ownership is not decoration: it is what ties the sequence's lifetime to the
 * column's, so dropping the table takes the sequence with it exactly as a plain
 * `serial` would. Without it the schema is left with a loose sequence that no
 * later comparison expects to find.
 *
 * Both lists are empty for every column the `serial` shorthand still covers.
 */
function tunedSerialStatements(
  col: ColumnSnapshot,
  tableName: string
): { before: SqlStatement[]; after: SqlStatement[] } {
  const tuned = tunedSerialSequence(col);
  if (tuned === null) return { before: [], after: [] };
  const head = `CREATE SEQUENCE IF NOT EXISTS ${q(tuned.name)}`;
  return {
    before: [
      objectStatement({
        sql: `${[head, ...sequenceClauses(tuned.options)].join("\n")};`,
        description: `Create sequence "${tuned.name}" for "${col.name}" on "${tableName}"`,
        kind: "CREATE_SEQUENCE",
        tableName: tuned.name,
      }),
    ],
    after: [
      {
        sql: `ALTER SEQUENCE ${q(tuned.name)} OWNED BY ${q(tableName)}.${q(col.name)};`,
        description: `Tie sequence "${tuned.name}" to "${col.name}" on "${tableName}"`,
        kind: "ALTER_SEQUENCE",
        severity: "safe",
        tableName,
        destructive: false,
      },
    ],
  };
}

// ── Types: enums, domains, composites, ranges ──────────────────────────────

/**
 * CREATE EXTENSION for an extension the target does not have.
 *
 * The version is pinned. Leaving it off installs whatever version the target
 * server happens to ship, which would apply cleanly and leave the two schemas
 * still different — the same silent divergence this whole comparison exists to
 * find. Pinning turns that into "extension X has no installation script for
 * version Y" on the line that caused it, which is a thing somebody can read
 * and decide about.
 *
 * No `WITH SCHEMA`, for the same reason nothing else here carries a schema
 * qualifier: the apply route runs `SET LOCAL search_path TO <targetSchema>`
 * first, so the extension lands in the schema being applied to — including on
 * a later replay onto a different schema, which a hard-coded name would miss.
 */
function createExtensionStatement(
  extension: ExtensionSnapshot,
  idempotent: boolean
): SqlStatement {
  const exists = idempotent ? " IF NOT EXISTS" : "";
  return objectStatement({
    sql:
      `CREATE EXTENSION${exists} ${q(extension.name)} ` +
      `VERSION ${literal(extension.version)};`,
    description: `Install extension "${extension.name}" ${extension.definition}`,
    kind: "CREATE_EXTENSION",
    tableName: extension.name,
  });
}

function dropExtensionStatement(extension: ExtensionSnapshot): SqlStatement {
  return objectStatement({
    sql: `DROP EXTENSION IF EXISTS ${q(extension.name)};`,
    description:
      `Drop extension "${extension.name}" — WARNING: takes its types, ` +
      "operators and functions with it, and fails while anything still uses one",
    kind: "DROP_EXTENSION",
    severity: "breaking",
    tableName: extension.name,
  });
}

/**
 * CREATE COLLATION, written from the snapshot's fields rather than its one-line
 * definition, so the sentence in the report and the SQL can be worded
 * independently of each other.
 *
 * A collation whose provider is the database default is skipped: there is no
 * option list to write, and `CREATE COLLATION x (provider = default)` is not
 * something PostgreSQL accepts.
 */
function createCollationStatement(
  collation: CollationSnapshot,
  idempotent: boolean
): SqlStatement | null {
  const options: string[] = [];
  if (collation.provider !== "default") options.push(`PROVIDER = ${collation.provider}`);
  if (collation.locale !== null) options.push(`LOCALE = ${literal(collation.locale)}`);
  if (collation.lcCollate !== null) {
    options.push(`LC_COLLATE = ${literal(collation.lcCollate)}`);
  }
  if (collation.lcCtype !== null) options.push(`LC_CTYPE = ${literal(collation.lcCtype)}`);
  if (collation.rules !== null) options.push(`RULES = ${literal(collation.rules)}`);
  // Only written when false. The default is true, so spelling it out adds
  // nothing, and the option does not exist before PostgreSQL 12.
  if (!collation.deterministic) options.push("DETERMINISTIC = false");
  if (options.length === 0) return null;

  const exists = idempotent ? " IF NOT EXISTS" : "";
  return objectStatement({
    sql: `CREATE COLLATION${exists} ${q(collation.name)} (${options.join(", ")});`,
    description: `Create collation "${collation.name}"`,
    kind: "CREATE_COLLATION",
    tableName: collation.name,
  });
}

function dropCollationStatement(collation: CollationSnapshot): SqlStatement {
  return objectStatement({
    sql: `DROP COLLATION IF EXISTS ${q(collation.name)};`,
    description:
      `Drop collation "${collation.name}" — WARNING: fails while any column, ` +
      "index or domain still uses it",
    kind: "DROP_COLLATION",
    severity: "breaking",
    tableName: collation.name,
  });
}

function createTypeStatement(type: TypeSnapshot): SqlStatement | null {
  if (type.kind === "ENUM") {
    const labels = type.labels.map((label) => `  ${literal(label)}`).join(",\n");
    return objectStatement({
      sql: `CREATE TYPE ${q(type.name)} AS ENUM (\n${labels}\n);`,
      description: `Create enum "${type.name}"`,
      kind: "CREATE_TYPE",
      tableName: type.name,
    });
  }
  if (type.kind === "DOMAIN") {
    const parts = [`CREATE DOMAIN ${q(type.name)} AS ${type.baseType ?? "text"}`];
    if (type.notNull) parts.push("  NOT NULL");
    for (const check of type.checks) {
      parts.push(`  CONSTRAINT ${q(check.name)} ${check.expression}`);
    }
    return objectStatement({
      sql: `${parts.join("\n")};`,
      description: `Create domain "${type.name}"`,
      kind: "CREATE_TYPE",
      tableName: type.name,
    });
  }
  if (type.kind === "COMPOSITE") {
    const fields = type.attributes.map((attribute) => `  ${attribute}`).join(",\n");
    return objectStatement({
      sql: `CREATE TYPE ${q(type.name)} AS (\n${fields}\n);`,
      description: `Create composite type "${type.name}"`,
      kind: "CREATE_TYPE",
      tableName: type.name,
    });
  }
  // Everything left is a range type. It is written out only when the snapshot
  // recorded enough of it — see rangeTypeIsCreatable, which the compare engine
  // asks the same question of so the report and this agree. When it did not,
  // the caller writes a note instead.
  if (!rangeTypeIsCreatable(type)) return null;
  const range = type.rangeDetails;
  if (!range) return null;
  const options = [`subtype = ${type.baseType ?? "text"}`];
  // Only the options that are not the default were recorded, so each one here
  // is something someone chose. Anything missing is PostgreSQL's own choice,
  // which it will make again.
  if (range.subtypeOpclass !== null) {
    options.push(`subtype_opclass = ${q(range.subtypeOpclass)}`);
  }
  if (range.collation !== null) options.push(`collation = ${q(range.collation)}`);
  if (range.subtypeDiff !== null) options.push(`subtype_diff = ${range.subtypeDiff}`);
  if (range.multirangeName !== null) {
    options.push(`multirange_type_name = ${q(range.multirangeName)}`);
  }
  return objectStatement({
    sql: `CREATE TYPE ${q(type.name)} AS RANGE (${options.join(", ")});`,
    description: `Create range type "${type.name}"`,
    kind: "CREATE_TYPE",
    tableName: type.name,
  });
}

function dropTypeStatement(type: TypeSnapshot): SqlStatement {
  const isDomain = type.kind === "DOMAIN";
  return objectStatement({
    sql: `DROP ${isDomain ? "DOMAIN" : "TYPE"} IF EXISTS ${q(type.name)};`,
    description: `Drop ${isDomain ? "domain" : "type"} "${type.name}" — WARNING: fails while any column still uses it`,
    kind: "DROP_TYPE",
    severity: "breaking",
    tableName: type.name,
  });
}

/**
 * Bring an existing type in line with the source.
 *
 * Enums are the case worth handling properly, because adding a value is both
 * common and genuinely supported. Everything else PostgreSQL cannot express as
 * an in-place ALTER is written out as a MANUAL note rather than guessed at.
 */
function alterTypeStatements(left: TypeSnapshot, right: TypeSnapshot): SqlStatement[] {
  const stmts: SqlStatement[] = [];

  // Whether any of this can be run at all is the compare engine's call, and the
  // report card reads the same answer off the diff — so "has to be replaced by
  // hand" on screen and a script that runs nothing are one decision. Everything
  // below the gate writes the statements for the cases it calls scriptable; the
  // notes are what the gate itself hands back.
  if (typeChangeIsAllManual(left, right)) {
    if (left.kind !== right.kind) {
      return [
        manualNote(
          `"${left.name}" is a ${left.kind.toLowerCase()} in the source and a ` +
            `${right.kind.toLowerCase()} in the target. Changing one into the other means ` +
            `dropping it, which fails while any column still uses it. Migrate the columns first.`,
          `"${left.name}" changed type category — needs manual work`,
          left.name
        ),
      ];
    }

    if (left.kind === "ENUM") {
      const leftLabels = new Set(left.labels);
      const removed = right.labels.filter((label) => !leftLabels.has(label));
      if (removed.length > 0) {
        return [
          manualNote(
            `enum "${left.name}" has ${removed.length} value${removed.length === 1 ? "" : "s"} ` +
              `the source does not (${removed.map(literal).join(", ")}). PostgreSQL cannot drop ` +
              `an enum value — recreate the type and repoint every column that uses it, or leave ` +
              `the extra value${removed.length === 1 ? "" : "s"} in place.`,
            `Enum "${left.name}" has values that cannot be dropped`,
            left.name
          ),
        ];
      }
      // Same labels, different order. Postgres compares enum values by their
      // stored order, so this changes how the data sorts.
      return [
        manualNote(
          `enum "${left.name}" has the same values in a different order. Postgres sorts by ` +
            `that order, so this changes comparison results. Reordering needs the type to be ` +
            `recreated.`,
          `Enum "${left.name}" values are in a different order`,
          left.name
        ),
      ];
    }

    return [
      manualNote(
        `"${left.name}" differs. Source: ${left.definition}. Target: ${right.definition}. ` +
          `Altering it in place needs the columns that use it handled first.`,
        `"${left.name}" changed and needs manual work`,
        left.name
      ),
    ];
  }

  // Past the gate the kinds match and there is something to run, so only the
  // scriptable halves of each kind are written from here down.
  if (left.kind === "ENUM") {
    const rightLabels = new Set(right.labels);
    const added = left.labels.filter((label) => !rightLabels.has(label));
    const leftLabels = new Set(left.labels);
    const removed = right.labels.filter((label) => !leftLabels.has(label));

    for (const label of added) {
      stmts.push(
        objectStatement({
          sql: `ALTER TYPE ${q(left.name)} ADD VALUE IF NOT EXISTS ${literal(label)};`,
          description: `Add value ${literal(label)} to enum "${left.name}"`,
          kind: "ALTER_TYPE",
          tableName: left.name,
        })
      );
    }
    if (removed.length > 0) {
      stmts.push(
        manualNote(
          `enum "${left.name}" has ${removed.length} value${removed.length === 1 ? "" : "s"} ` +
            `the source does not (${removed.map(literal).join(", ")}). PostgreSQL cannot drop ` +
            `an enum value — recreate the type and repoint every column that uses it, or leave ` +
            `the extra value${removed.length === 1 ? "" : "s"} in place.`,
          `Enum "${left.name}" has values that cannot be dropped`,
          left.name
        )
      );
    }
    // A reorder — same labels, different order — never reaches here: ADD VALUE
    // is the only enum ALTER, so it has nothing to run and the gate above
    // returned its note.
    return stmts;
  }

  // A domain can be altered in place as long as its base type is unchanged:
  // NOT NULL is a direct ALTER, and checks are dropped and added by name. The
  // base type is the one thing ALTER DOMAIN cannot change, so that still falls
  // through to the manual note below.
  if (left.kind === "DOMAIN" && left.baseType === right.baseType) {
    // The two tests below are the compare engine's, not a second copy of them:
    // domainChangeSeverity grades a changed domain "breaking" out of exactly
    // these, so the pill on the report and the warning on the statement cannot
    // drift. (They used to: the report graded every changed type "info" while
    // the script marked the SET NOT NULL below breaking.)
    if (left.notNull !== right.notNull) {
      const tightens = domainNotNullTightens(left, right);
      stmts.push(
        objectStatement({
          sql: tightens
            ? `ALTER DOMAIN ${q(left.name)} SET NOT NULL;`
            : `ALTER DOMAIN ${q(left.name)} DROP NOT NULL;`,
          description: tightens
            ? `Make domain "${left.name}" NOT NULL — WARNING: fails if any column using it holds a null`
            : `Allow nulls in domain "${left.name}"`,
          kind: "ALTER_TYPE",
          severity: tightens ? "breaking" : "safe",
          tableName: left.name,
        })
      );
    }

    // Match checks by name. A check whose name is the same but whose expression
    // changed has to be dropped and re-added: ALTER DOMAIN has no "replace".
    const leftChecks = new Map(left.checks.map((check) => [check.name, check]));

    for (const check of right.checks) {
      const source = leftChecks.get(check.name);
      if (source && source.expression === check.expression) continue;
      stmts.push(
        objectStatement({
          sql: `ALTER DOMAIN ${q(left.name)} DROP CONSTRAINT IF EXISTS ${q(check.name)};`,
          description: `Remove check "${check.name}" from domain "${left.name}"`,
          kind: "ALTER_TYPE",
          severity: "safe",
          tableName: left.name,
        })
      );
    }

    for (const check of domainAddedChecks(left, right)) {
      stmts.push(
        objectStatement({
          sql: `ALTER DOMAIN ${q(left.name)} ADD CONSTRAINT ${q(check.name)} ${check.expression};`,
          description:
            `Add check "${check.name}" to domain "${left.name}" — WARNING: fails if any ` +
            `existing value breaks it`,
          kind: "ALTER_TYPE",
          severity: "breaking",
          tableName: left.name,
        })
      );
    }

    if (stmts.length > 0) return stmts;
  }

  // Unreachable while this function and typeChangeIsAllManual agree: every case
  // that gets here is one the gate calls all-manual. Kept as the safety net,
  // because the failure it catches is the worst one this file can produce — a
  // changed type that generates NOTHING, on a report that says it changed.
  return [
    manualNote(
      `"${left.name}" differs. Source: ${left.definition}. Target: ${right.definition}. ` +
        `Altering it in place needs the columns that use it handled first.`,
      `"${left.name}" changed and needs manual work`,
      left.name
    ),
  ];
}

// ---------------------------------------------------------------------------
// Ownership and grants
// ---------------------------------------------------------------------------

/**
 * How GRANT names each kind of object, which is not always how CREATE names it.
 *
 * The one that catches people: GRANT has no VIEW. A view and a materialized
 * view are both granted `ON TABLE`, and writing `ON VIEW` is a syntax error.
 */
const GRANT_OBJECT_WORD: Record<PrivilegeObjectKind, string> = {
  TABLE: "TABLE",
  VIEW: "TABLE",
  "MATERIALIZED VIEW": "TABLE",
  SEQUENCE: "SEQUENCE",
  FUNCTION: "FUNCTION",
  PROCEDURE: "PROCEDURE",
  SCHEMA: "SCHEMA",
};

/** How ALTER names each kind, which for a view is not how GRANT names it. */
const ALTER_OBJECT_WORD: Record<PrivilegeObjectKind, string> = {
  TABLE: "TABLE",
  VIEW: "VIEW",
  "MATERIALIZED VIEW": "MATERIALIZED VIEW",
  SEQUENCE: "SEQUENCE",
  FUNCTION: "FUNCTION",
  PROCEDURE: "PROCEDURE",
  SCHEMA: "SCHEMA",
};

/**
 * The object as GRANT and ALTER have to spell it: quoted name, and for a
 * routine the argument list after it, unquoted.
 *
 * `targetSchema` is used for, and only for, the SCHEMA entry. Everything else
 * in this file is written unqualified because the apply route sets search_path
 * to the target schema first — but there is no unqualified way to name a
 * schema, and the name the snapshot carries is the SOURCE's. Writing that one
 * would grant on whichever schema the source happened to be called, which on a
 * two-schema comparison inside one database is a live and silent mis-grant.
 */
function privilegeObjectSql(
  privilege: PrivilegeSnapshot,
  targetSchema: string
): string {
  if (privilege.objectKind === "SCHEMA") return q(targetSchema);
  const args =
    privilege.identityArguments === undefined
      ? ""
      : `(${privilege.identityArguments})`;
  return `${q(privilege.objectName)}${args}`;
}

/** "table orders", "function f(integer)" — the same words the report uses. */
function privilegeLabel(privilege: PrivilegeSnapshot): string {
  const args =
    privilege.identityArguments === undefined
      ? ""
      : `(${privilege.identityArguments})`;
  return `${privilege.objectKind.toLowerCase()} ${privilege.objectName}${args}`;
}

/**
 * PUBLIC is a keyword in GRANT, not a role name, so quoting it turns a grant to
 * everybody into a grant to a role called "public" that does not exist.
 */
function grantee(name: string): string {
  return name.toUpperCase() === "PUBLIC" ? "PUBLIC" : q(name);
}

/** The same distinction for prose, where the quotes are only decoration. */
function quoteRoleText(name: string): string {
  return name.toUpperCase() === "PUBLIC" ? "PUBLIC" : `"${name}"`;
}

function ownerStatement(
  privilege: PrivilegeSnapshot,
  targetSchema: string,
  previousOwner: string | null
): SqlStatement {
  const label = privilegeLabel(privilege);
  const moved =
    previousOwner === null ? "" : ` (was ${quoteRoleText(previousOwner)})`;
  return objectStatement({
    sql:
      `ALTER ${ALTER_OBJECT_WORD[privilege.objectKind]} ` +
      `${privilegeObjectSql(privilege, targetSchema)} ` +
      `OWNER TO ${q(privilege.owner)};`,
    description: `Set owner of ${label} to ${quoteRoleText(privilege.owner)}${moved}`,
    kind: "ALTER_OWNER",
    // Breaking only when it is taken off somebody. On an object the script has
    // just created there is no previous owner to lose anything.
    severity: previousOwner === null ? "info" : "breaking",
    tableName: privilege.objectName,
  });
}

function grantStatement(
  privilege: PrivilegeSnapshot,
  targetSchema: string,
  role: string,
  privileges: string[],
  withGrantOption: boolean
): SqlStatement {
  const label = privilegeLabel(privilege);
  const option = withGrantOption ? " WITH GRANT OPTION" : "";
  return objectStatement({
    sql:
      `GRANT ${privileges.join(", ")} ON ` +
      `${GRANT_OBJECT_WORD[privilege.objectKind]} ` +
      `${privilegeObjectSql(privilege, targetSchema)} ` +
      `TO ${grantee(role)}${option};`,
    description:
      `Grant ${privileges.join(", ")} on ${label} to ${quoteRoleText(role)}` +
      (withGrantOption ? ", who may pass it on" : ""),
    kind: "GRANT",
    // A GRANT cannot fail on the rows already there and takes nothing from
    // anybody, which is the definition of safe in this file.
    severity: "safe",
    tableName: privilege.objectName,
  });
}

function revokeStatement(
  privilege: PrivilegeSnapshot,
  targetSchema: string,
  role: string,
  privileges: string[],
  optionOnly: boolean
): SqlStatement {
  const label = privilegeLabel(privilege);
  const what = optionOnly ? "GRANT OPTION FOR " : "";
  return objectStatement({
    sql:
      `REVOKE ${what}${privileges.join(", ")} ON ` +
      `${GRANT_OBJECT_WORD[privilege.objectKind]} ` +
      `${privilegeObjectSql(privilege, targetSchema)} ` +
      `FROM ${grantee(role)};`,
    description: optionOnly
      ? `Stop ${quoteRoleText(role)} passing on ${privileges.join(", ")} ` +
        `on ${label} — WARNING: anything they granted onwards goes with it`
      : `Revoke ${privileges.join(", ")} on ${label} from ${quoteRoleText(role)}` +
        " — WARNING: queries running under that role stop working",
    kind: "REVOKE",
    severity: "breaking",
    tableName: privilege.objectName,
    // Not `destructive`. Nothing is deleted, so "allow data loss" is the wrong
    // gate for it — but it is the change most likely to take an application
    // down, which is what the breaking grade above is for.
  });
}

/**
 * The statements that move one object's access from what the target has to what
 * the source has.
 *
 * `target` is null for an object the script is creating, where there is nothing
 * to compare against and every grant in the source is new.
 */
function privilegeStatements(
  source: PrivilegeSnapshot,
  target: PrivilegeSnapshot | null,
  targetSchema: string,
  heldBack: boolean
): SqlStatement[] {
  const statements: SqlStatement[] = [];

  if (target === null || source.owner !== target.owner) {
    statements.push(ownerStatement(source, targetSchema, target?.owner ?? null));
  }

  const held = new Map((target?.grants ?? []).map((g) => [g.grantee, g]));
  const wanted = new Map(source.grants.map((g) => [g.grantee, g]));

  for (const grant of source.grants) {
    const has = held.get(grant.grantee);
    // Split by grant option rather than emitting one statement per privilege:
    // GRANT takes a list, and two statements read better than seven.
    const plain = grant.privileges.filter(
      (p) => !grant.grantable.includes(p) && !(has?.privileges ?? []).includes(p)
    );
    // Re-granting WITH GRANT OPTION is how the option is added to a privilege
    // the role already holds — there is no ALTER for it.
    const grantable = grant.grantable.filter(
      (p) => !(has?.grantable ?? []).includes(p)
    );
    if (plain.length > 0) {
      statements.push(
        grantStatement(source, targetSchema, grant.grantee, plain, false)
      );
    }
    if (grantable.length > 0) {
      statements.push(
        grantStatement(source, targetSchema, grant.grantee, grantable, true)
      );
    }
  }

  for (const grant of held.values()) {
    const keep = wanted.get(grant.grantee);
    const lose = grant.privileges.filter(
      (p) => !(keep?.privileges ?? []).includes(p)
    );
    if (lose.length > 0) {
      statements.push(
        revokeStatement(source, targetSchema, grant.grantee, lose, false)
      );
    }
    // A privilege they keep but may no longer hand on. REVOKE GRANT OPTION FOR
    // is the only statement that takes the option without taking the privilege.
    const loseOption = grant.grantable.filter(
      (p) => (keep?.privileges ?? []).includes(p) && !(keep?.grantable ?? []).includes(p)
    );
    if (loseOption.length > 0) {
      statements.push(
        revokeStatement(source, targetSchema, grant.grantee, loseOption, true)
      );
    }
  }

  // Every statement here assumes the object is in the state the source
  // describes. When safe mode holds back the drop that would have rebuilt it,
  // it is not: `ALTER VIEW "recent" OWNER TO ...` over a materialized view that
  // is still sitting there fails outright with "recent is not a view", and the
  // apply route runs the whole script in one transaction, so that one failure
  // rolls the entire migration back. Held back beside the drop instead.
  return heldBack
    ? statements.map((statement) => ({ ...statement, needsArmedDrop: true }))
    : statements;
}

// ── Functions and procedures ───────────────────────────────────────────────

// pg_get_functiondef returns a complete CREATE OR REPLACE statement, so the
// same text covers both "missing" and "changed".
function createRoutineStatement(routine: RoutineSnapshot): SqlStatement {
  return objectStatement({
    sql: `${routine.definition.trim()};`,
    description: `Create ${routine.kind.toLowerCase()} "${routine.signature}"`,
    kind: "CREATE_ROUTINE",
    tableName: routine.name,
  });
}

function dropRoutineStatement(routine: RoutineSnapshot, reason = ""): SqlStatement {
  return objectStatement({
    sql:
      `DROP ${routine.kind} IF EXISTS ${q(routine.name)}` +
      `(${routine.identityArguments});`,
    description:
      `Drop ${routine.kind.toLowerCase()} "${routine.signature}"${reason}` +
      ` — WARNING: anything calling it breaks`,
    kind: "DROP_ROUTINE",
    severity: "breaking",
    tableName: routine.name,
  });
}

// ---------------------------------------------------------------------------
// Turning object differences into ordered phases
// ---------------------------------------------------------------------------

/**
 * Object statements bucketed by when they have to run.
 *
 * Ordering is not cosmetic here. A type has to exist before a column uses it, a
 * function before the trigger that calls it, a column before the index over it,
 * and every table before a view that selects from them.
 */
type ObjectPhases = {
  /**
   * Extensions — before everything, including the collations below.
   *
   * An extension installs types, operators, functions and sometimes collations
   * of its own, and the snapshot deliberately records none of them (they are
   * installed, not authored). So the extension is the only thing that puts them
   * there, and nothing that might name one can be written until it exists.
   */
  extensions: SqlStatement[];
  /**
   * Collations — before everything else, including the types below.
   *
   * A column, a domain and an index can all name a collation, so nothing that
   * might name one can be written until it exists.
   */
  collations: SqlStatement[];
  /**
   * Types and standalone sequences — before CREATE TABLE.
   *
   * Also the `-- MANUAL:` notes for work the generator cannot express, so the
   * reader meets them before the statements that assume the work was done.
   */
  beforeTables: SqlStatement[];
  /** Functions and procedures — after tables exist, before triggers need them. */
  routines: SqlStatement[];
  /** Indexes — after every ADD COLUMN has run. */
  indexes: SqlStatement[];
  /** Triggers — after their functions and after the columns they read. */
  triggers: SqlStatement[];
  /**
   * Policies and the row-security switches — last of the table-scoped work.
   *
   * A policy expression reads the table's own columns and can call a function,
   * so it needs every ADD COLUMN and every CREATE FUNCTION above it to have
   * run. Nothing else depends on a policy, so nothing has to come after.
   */
  policies: SqlStatement[];
  /** Views — after foreign keys, so every table is complete. */
  views: SqlStatement[];
  /**
   * Indexes and triggers that hang off a VIEW — after the views above.
   *
   * They cannot ride in `indexes` and `triggers`, which run long before any
   * view exists: a CREATE INDEX on a materialized view the script has not
   * built yet fails on a relation that is not there. So they get a bucket of
   * their own, emitted immediately after the view they belong to is created.
   */
  afterViews: SqlStatement[];
  /** View drops — before DROP TABLE, so CASCADE has less to reach. */
  viewDrops: SqlStatement[];
  /**
   * Routine drops — after the tables, before the type drops below.
   *
   * Their own bucket rather than the back of afterTables: object diffs arrive
   * sorted alphabetically by kind, so "ENUM" came before "FUNCTION" and a
   * rollback that removed an enum and a function taking that enum emitted the
   * DROP TYPE first. DROP TYPE carries no CASCADE on purpose, so it failed and
   * took the whole transaction with it.
   */
  routineDrops: SqlStatement[];
  /** Type and sequence drops — after the tables and routines that used them. */
  afterTables: SqlStatement[];
  /**
   * Collation drops — the very last thing.
   *
   * DROP COLLATION carries no CASCADE here and fails while any column, domain
   * or index still uses it, so it has to come after every one of those has
   * gone: after the table drops, and after the type drops above.
   */
  collationDrops: SqlStatement[];
  /**
   * Extension drops — after even the collation drops.
   *
   * DROP EXTENSION carries no CASCADE here, and an extension holds everything
   * it installed: a column on one of its types, an index on one of its
   * operator classes, a collation it shipped. All of those have to be gone
   * first, and the collation drops above are the last of them.
   */
  extensionDrops: SqlStatement[];
  /**
   * Ownership and grants — after everything the script creates, and before
   * anything it drops.
   *
   * After the creations because there is nothing to grant on until the object
   * is there; before the drops because a REVOKE on an object that has just been
   * dropped fails, and because leaving them to the very end would put a GRANT
   * after a DROP TYPE that a safe-mode run has commented out.
   */
  privileges: SqlStatement[];
  /**
   * Tables whose ALTER COLUMN ... TYPE cannot run while safe mode holds a
   * materialized view's drop back, keyed by the table's name in the SOURCE and
   * listing the views in the way.
   *
   * The generator marks those ALTERs `needsArmedDrop` so the renderer comments
   * them out with the drop rather than leaving them to fail mid-transaction.
   */
  retypeBlockedBy: Map<string, string[]>;
  warnings: string[];
};

function findByName<T extends { name: string }>(items: T[] | undefined, name: string): T | null {
  return items?.find((item) => item.name === name) ?? null;
}

/**
 * Find a privilege entry by the display name the compare engine gave it —
 * "table orders", "function f(integer)".
 *
 * Rebuilt here rather than carried on the diff because ObjectDiff has one name
 * field and every other kind puts its own name in it. Both sides must spell it
 * the same way; the compare engine's privilegeObjects is the other half.
 */
function findPrivilege(
  items: PrivilegeSnapshot[] | undefined,
  name: string
): PrivilegeSnapshot | null {
  return (
    items?.find((item) => {
      const args =
        item.identityArguments === undefined ? "" : `(${item.identityArguments})`;
      return `${item.objectKind.toLowerCase()} ${item.objectName}${args}` === name;
    }) ?? null
  );
}

/**
 * Build every object statement the migration needs, in dependency order.
 *
 * Reads the object differences the comparator produced, plus the objects that
 * hang off tables being created outright — a brand-new table has no match, so
 * its indexes and triggers appear in no diff and would otherwise be dropped on
 * the floor exactly the way its foreign keys once were.
 */
function objectPhases(
  report: CompareReport,
  idempotent: boolean,
  appliesToSchema: string
): ObjectPhases {
  const phases: ObjectPhases = {
    extensions: [],
    collations: [],
    beforeTables: [],
    routines: [],
    indexes: [],
    triggers: [],
    policies: [],
    views: [],
    afterViews: [],
    viewDrops: [],
    routineDrops: [],
    afterTables: [],
    collationDrops: [],
    extensionDrops: [],
    privileges: [],
    retypeBlockedBy: new Map(),
    warnings: [],
  };

  const leftViews = report.left.views ?? [];
  const rightViews = report.right.views ?? [];

  // ── Table-scoped objects on MATCHED tables ────────────────────────────────
  for (const match of report.matchedTables) {
    // After the rename step the table carries the source's name, so every statement
    // below must use that and not the name the diff was recorded under.
    const tableName = match.left.name;

    for (const diff of match.objectDiffs) {
      if (diff.kind === "INDEX") {
        if (diff.status !== "onlyA") {
          const target = findByName(match.right.indexes, diff.name);
          if (target) phases.indexes.push(dropIndexStatement(target, tableName));
        }
        if (diff.status !== "onlyB") {
          const source = findByName(match.left.indexes, diff.name);
          if (source) phases.indexes.push(createIndexStatement(source, tableName, idempotent));
        }
      } else if (diff.kind === "TRIGGER") {
        if (diff.status === "onlyB") {
          phases.triggers.push(dropTriggerStatement(diff.name, tableName));
        } else {
          const source = findByName(match.left.triggers, diff.name);
          if (source) phases.triggers.push(...createTriggerStatements(source, tableName));
        }
      } else if (diff.kind === "ROW SECURITY") {
        // The diff only ever says "these two states differ"; which switches
        // moved is read off the snapshots, which are both still here.
        if (match.left.rowSecurity && match.right.rowSecurity) {
          phases.policies.push(
            ...rowSecurityStatements(match.left.rowSecurity, match.right.rowSecurity, tableName)
          );
        }
      } else if (diff.kind === "PARTITIONING") {
        // There is no ALTER that turns a plain table into a partitioned one,
        // moves a partition to a different parent, or changes a partition key.
        // The only route is a rebuild. Saying nothing here is what let the
        // report claim the script handled a change it could not express.
        const note =
          `Table "${tableName}" is ${diff.leftDefinition ?? "unknown"} in the source and ` +
          `${diff.rightDefinition ?? "unknown"} in the target. PostgreSQL has no ALTER for ` +
          `this — build the table in its new shape, copy the rows across, then swap the names.`;
        phases.beforeTables.push(
          manualNote(note, `Partitioning of "${tableName}" needs a rebuild`, tableName)
        );
        phases.warnings.push(note);
      } else if (diff.kind === "POLICY") {
        // Dropped and recreated rather than altered: ALTER POLICY can change
        // the roles and the expressions but not the command it applies to, so
        // one rewrite would apply and another would fail on the same shape.
        if (diff.status !== "onlyA") {
          phases.policies.push(
            dropPolicyStatement(
              diff.name,
              tableName,
              diff.status === "onlyB"
                ? " — WARNING: the access rule it enforced stops applying"
                : " so it can be recreated with its new definition"
            )
          );
        }
        if (diff.status !== "onlyB") {
          const source = findByName(match.left.rowSecurity?.policies, diff.name);
          if (source) phases.policies.push(createPolicyStatement(source, tableName));
        }
      }
    }
  }

  // ── Table-scoped objects on tables being CREATED ──────────────────────────
  for (const table of report.tablesOnlyInA) {
    for (const index of table.indexes ?? []) {
      phases.indexes.push(createIndexStatement(index, table.name, idempotent));
    }
    for (const trigger of table.triggers ?? []) {
      phases.triggers.push(...createTriggerStatements(trigger, table.name));
    }
    // A brand-new table is created with row security OFF whatever the source
    // says, so the switch has to be written out explicitly. Skipping it is how
    // a table that is locked down in the source arrives world-readable in the
    // target — the exact failure this whole slice exists to stop.
    if (table.rowSecurity) {
      phases.policies.push(
        ...rowSecurityStatements(
          table.rowSecurity,
          { enabled: false, forced: false, policies: [] },
          table.name
        )
      );
      for (const policy of table.rowSecurity.policies) {
        phases.policies.push(createPolicyStatement(policy, table.name));
      }
    }
  }

  // ── Schema-scoped objects ─────────────────────────────────────────────────
  const viewsToCreate: ViewSnapshot[] = [];
  /** Views the script drops by name, so a CASCADE taking them is no surprise. */
  const viewsBeingDropped = new Set<string>();
  /**
   * ...of which these are dropped DESTRUCTIVELY, meaning safe mode comments the
   * drop out. Anything written to put those views back has to be held back with
   * them: a plain CREATE OR REPLACE VIEW over a surviving materialized view
   * fails outright ("recent is not a view"), and CREATE MATERIALIZED VIEW IF
   * NOT EXISTS finds the old one and quietly does nothing.
   */
  const heldBackViewDrops = new Set<string>();
  /**
   * INDEX and TRIGGER diffs from the schema-scoped list, which is where the ones
   * belonging to a VIEW arrive. Held aside rather than handled in the loop
   * below, because what to write for them depends on whether the view they hang
   * off is about to be rebuilt — and that is not known until the CASCADE walk
   * further down has finished. See the pass after the views are created.
   */
  const viewObjectDiffs: ObjectDiff[] = [];
  /** Ownership and grant diffs, held aside for the same reason. */
  const privilegeDiffs: ObjectDiff[] = [];

  /** Queue a drop and record it in both sets — the only place that does. */
  function queueViewDrop(view: ViewSnapshot, reason: string) {
    const statement = dropViewStatement(view, reason);
    phases.viewDrops.push(statement);
    viewsBeingDropped.add(view.name);
    if (statement.destructive) heldBackViewDrops.add(view.name);
  }

  for (const diff of report.objectDiffs) {
    if (diff.kind === "INDEX" || diff.kind === "TRIGGER") {
      // Only a view puts these in the schema-scoped list; a table's ride on its
      // own match, which the loop above has already dealt with.
      viewObjectDiffs.push(diff);
      continue;
    }

    if (diff.kind === "VIEW" || diff.kind === "MATERIALIZED VIEW") {
      const sourceView = findByName(leftViews, diff.name);
      const targetView = findByName(rightViews, diff.name);
      // A plain view whose SELECT is identical and whose WITH (...) settings
      // are not needs no drop at all: CREATE OR REPLACE replaces the option
      // list in place, and skipping the drop means its CASCADE cannot reach
      // the views built on top of it. A materialized view still has to go —
      // CREATE MATERIALIZED VIEW IF NOT EXISTS would find it there and do
      // nothing, leaving the old settings and the old rows.
      //
      // The compare engine decided that (viewReplaceNeedsDrop) and the report
      // reads the same flag, so the SQL below and the sentence printed next to
      // it on screen cannot disagree about what this migration does.
      const onlyOptionsMoved =
        diff.status === "changedDefinition" && diff.replaceNeedsDrop === false;

      if (diff.status !== "onlyA" && !onlyOptionsMoved && targetView) {
        queueViewDrop(
          targetView,
          diff.status === "onlyB" ? "" : " so it can be rebuilt from the source"
        );
      }
      if (diff.status !== "onlyB") {
        if (sourceView) viewsToCreate.push(sourceView);
      }
      continue;
    }

    if (diff.kind === "SEQUENCE") {
      if (diff.status === "onlyA") {
        const source = findByName(report.left.sequences, diff.name);
        if (source) phases.beforeTables.push(createSequenceStatement(source, idempotent));
      } else if (diff.status === "onlyB") {
        phases.afterTables.push(
          objectStatement({
            sql: `DROP SEQUENCE IF EXISTS ${q(diff.name)};`,
            description: `Drop sequence "${diff.name}" — WARNING: anything using it for new ids stops working`,
            kind: "DROP_SEQUENCE",
            severity: "breaking",
            tableName: diff.name,
          })
        );
      } else {
        const source = findByName(report.left.sequences, diff.name);
        if (source) phases.beforeTables.push(alterSequenceStatement(source));
      }
      continue;
    }

    if (diff.kind === "EXTENSION") {
      const source = findByName(report.left.extensions, diff.name);
      const target = findByName(report.right.extensions, diff.name);
      if (diff.status === "onlyA") {
        if (source) phases.extensions.push(createExtensionStatement(source, idempotent));
      } else if (diff.status === "onlyB") {
        if (target) phases.extensionDrops.push(dropExtensionStatement(target));
      } else if (source && target) {
        // ALTER EXTENSION ... UPDATE runs the little upgrade scripts the
        // extension's author shipped, and almost nobody ships the ones that go
        // back down. extensionUpdateIsForward is the single answer to whether
        // there is a path — the report reads the same one off the diff, so the
        // card and the script cannot say different things.
        if (extensionUpdateIsForward(source.version, target.version)) {
          phases.extensions.push(
            objectStatement({
              sql: `ALTER EXTENSION ${q(source.name)} UPDATE TO ${literal(source.version)};`,
              description:
                `Update extension "${source.name}" from ${target.definition} ` +
                `to ${source.definition}`,
              kind: "ALTER_EXTENSION",
              tableName: source.name,
            })
          );
        } else {
          phases.extensions.push(
            manualNote(
              `extension "${source.name}" is ${target.definition} in the target and ` +
                `${source.definition} in the source, and ALTER EXTENSION ... UPDATE ` +
                "only goes forwards. Moving back a version means dropping the " +
                "extension and installing the older one, which takes every type, " +
                "operator and function it owns with it — so everything using one " +
                "has to come off first.",
              `Extension "${source.name}" needs moving by hand`,
              source.name
            )
          );
        }
      }
      continue;
    }

    if (diff.kind === "PRIVILEGES") {
      // Held aside for the same reason the view indexes and triggers are:
      // whether the object these grants sit on is really going to be rebuilt is
      // not known until the CASCADE walk below has finished adding to
      // heldBackViewDrops. See the pass after the views are created.
      privilegeDiffs.push(diff);
      continue;
    }

    if (diff.kind === "COLLATION") {
      const source = findByName(report.left.collations, diff.name);
      const target = findByName(report.right.collations, diff.name);
      if (diff.status === "onlyA") {
        // A collation with nothing to write is one on the database default,
        // which every schema already has; there is nothing to create.
        const create = source ? createCollationStatement(source, idempotent) : null;
        if (create) phases.collations.push(create);
      } else if (diff.status === "onlyB") {
        if (target) phases.collationDrops.push(dropCollationStatement(target));
      } else {
        // No ALTER COLLATION changes how one sorts — the grammar has RENAME,
        // OWNER and REFRESH VERSION and nothing else. Replacing it means
        // dropping it, which fails while a single column still uses it, so
        // every column has to be moved off it first. That is a plan, not a
        // statement, and the generator writes plans as MANUAL notes.
        phases.collations.push(
          manualNote(
            `collation "${diff.name}" has to be replaced by hand: it is ` +
              `(${diff.rightDefinition ?? "?"}) in the target and ` +
              `(${diff.leftDefinition ?? "?"}) in the source, and PostgreSQL has no ` +
              "ALTER that changes either. Move every column off it, drop it, " +
              "create it again, then put the columns back.",
            `Collation "${diff.name}" needs replacing by hand`,
            diff.name
          )
        );
      }
      continue;
    }

    if (diff.kind === "FUNCTION" || diff.kind === "PROCEDURE") {
      // Routines are keyed by signature, so look them up by that.
      const source = report.left.routines?.find((r) => r.signature === diff.name) ?? null;
      const target = report.right.routines?.find((r) => r.signature === diff.name) ?? null;
      if (diff.status === "onlyB") {
        if (target) phases.routineDrops.push(dropRoutineStatement(target));
      } else if (source) {
        // pg_get_functiondef() hands back a CREATE OR REPLACE, which normally
        // covers "changed" as well as "missing". It does not when the return
        // type moved or an argument was renamed: PostgreSQL refuses the replace
        // outright and the migration stops on a line the report had called a
        // harmless swap. compareSchemas works that out — see
        // routineReplaceNeedsDrop — and says so on the diff.
        if (target && diff.replaceNeedsDrop === true) {
          phases.routines.push(
            dropRoutineStatement(target, " so it can be recreated with its new signature")
          );
        }
        phases.routines.push(createRoutineStatement(source));
      }
      continue;
    }

    // Everything left is a type: enum, domain, composite or range.
    const sourceType = findByName(report.left.types, diff.name);
    const targetType = findByName(report.right.types, diff.name);
    if (diff.status === "onlyA") {
      if (!sourceType) continue;
      const create = createTypeStatement(sourceType);
      if (create) {
        phases.beforeTables.push(create);
      } else {
        // Only a range type gets here: every other kind of type is written
        // out above. Which of the three reasons applies decides the sentence,
        // because "create it by hand" without saying why is not much help.
        const range = sourceType.rangeDetails;
        const why =
          range === undefined
            ? "this snapshot was captured before ranges were recorded in that much " +
              "detail — re-capture the source schema and the statement will be written"
            : range.canonical !== null
              ? `it has a canonical function (${range.canonical}), which takes and ` +
                "returns the range type itself: create a shell type, create the " +
                "function against it, then define the range"
              : `its subtype_diff function (${range.subtypeDiff ?? "?"}) belongs to this ` +
                "schema, and this script creates functions after the tables — create " +
                "that function first, then the type";
        phases.beforeTables.push(
          manualNote(
            `range type "${sourceType.name}" (${sourceType.definition}) has to be created ` +
              `by hand: ${why}.`,
            `Range type "${sourceType.name}" needs creating by hand`,
            sourceType.name
          )
        );
      }
    } else if (diff.status === "onlyB") {
      if (targetType) phases.afterTables.push(dropTypeStatement(targetType));
    } else if (sourceType && targetType) {
      phases.beforeTables.push(...alterTypeStatements(sourceType, targetType));
    }
  }

  // ── Views a CASCADE would take silently ───────────────────────────────────
  // Dropping a table or a column with CASCADE removes every view built on it
  // without naming any of them. Anything the source still has is put back.
  const cascadingRelations = new Set<string>();
  for (const table of report.tablesOnlyInB) cascadingRelations.add(table.name);
  for (const match of report.matchedTables) {
    if (match.columnsOnlyInB.length > 0) cascadingRelations.add(match.right.name);
    // A changed GENERATED ALWAYS AS (...) expression is another DROP COLUMN
    // CASCADE, even though the column comes straight back: PostgreSQL cannot
    // change a generated column in place, so the only portable answer is to
    // rebuild it. The CASCADE is just as wide as any other, and this table was
    // in none of the sets above — it is matched, it lost no column, and it is
    // not a view — so the walk below never saw the victims and nothing put them
    // back. Same test as the branch that emits the statement.
    const rebuildsComputed = match.columnMatches.some((col) => {
      const before = describeComputed(col.right);
      const after = describeComputed(col.left);
      return before !== null && after !== null && before !== after;
    });
    if (rebuildsComputed) cascadingRelations.add(match.right.name);
  }
  // A view the script drops by name cascades as well. A second view built on
  // that one is usually byte-identical in both schemas, so the comparator says
  // nothing about it and it was in neither list: the CASCADE took it and
  // nothing put it back — in the migration, and again in the rollback, which
  // still called itself complete. Seeding the set with the views being dropped
  // makes the walk below find those dependents and queue them for rebuild.
  for (const name of viewsBeingDropped) cascadingRelations.add(name);

  // ── Views standing in the way of a column type change ─────────────────────
  // PostgreSQL refuses ALTER TABLE ... ALTER COLUMN ... TYPE while any view
  // selects that column, and a view identical on both sides is in no diff, so
  // nothing dropped it. The migration died on a statement the report had shown
  // as clean, and the rollback died on the mirror image of it. Drop them up
  // front and let the CASCADE walk above queue the rebuild.
  // Keyed by the table's name in the SOURCE, because that is the name the
  // ALTER statements use: the rename step above has already run by then.
  const retypedTables = new Map<string, string>();
  for (const match of report.matchedTables) {
    const retyped = match.columnMatches.some(
      (col) =>
        normalizeType(col.left.typeDisplay) !== normalizeType(col.right.typeDisplay) ||
        // A collation change is written as ALTER COLUMN ... TYPE too — there is
        // no SET COLLATE, so the only way to change one is to re-state the type
        // beside the new collation. The server does not care that the type is
        // unchanged: the statement is still a retype and it is still refused
        // while a view reads the column. Same condition as the branch that
        // emits it, so the two cannot drift apart.
        (col.left.collation !== undefined &&
          col.right.collation !== undefined &&
          col.left.collation !== col.right.collation)
    );
    if (retyped) retypedTables.set(match.right.name, match.left.name);
  }
  // One table at a time rather than one call over the whole set, so each view
  // found is attributable to the table whose column change needs it gone. The
  // union is the same either way; what the per-table walk buys is the map
  // below, which safe mode needs to hold the ALTER back beside the drop.
  for (const [targetName, sourceName] of retypedTables) {
    for (const view of viewsCascadedBy(rightViews, new Set([targetName]))) {
      if (!viewsBeingDropped.has(view.name)) {
        // Only drop what can be put back. A view the source does not have would
        // already be a diff and already be in the set above, so reaching here
        // with no source copy means views were never recorded on that side —
        // and dropping a view this script cannot recreate is worse than the
        // ALTER failing loudly.
        if (!findByName(leftViews, view.name)) continue;
        queueViewDrop(view, " so a column it reads can change type");
        cascadingRelations.add(view.name);
      }
      // A materialized view is dropped destructively — it holds its own rows —
      // so safe mode comments the drop out. The ALTER is not destructive and
      // would stay live, hit a matview that is still sitting there, and fail
      // with "cannot alter type of a column used by a view or rule". The apply
      // route runs the whole script in one transaction, so that failure rolls
      // the entire migration back: the safest mode produced the one script that
      // cannot finish. Held back beside the drop instead.
      if (heldBackViewDrops.has(view.name)) {
        const blocked = phases.retypeBlockedBy.get(sourceName) ?? [];
        if (!blocked.includes(view.name)) blocked.push(view.name);
        phases.retypeBlockedBy.set(sourceName, blocked);
      }
    }
  }

  const cascaded = viewsCascadedBy(rightViews, cascadingRelations);
  const alreadyQueued = new Set(viewsToCreate.map((view) => view.name));
  const unrecoverable: string[] = [];

  for (const victim of cascaded) {
    const survivor = findByName(leftViews, victim.name);
    if (!survivor) {
      // The source has no such view, so it is meant to go. Warn only when the
      // script does not already drop it by name: a view the migration removes
      // deliberately is not a silent casualty, and warning about it made the
      // report cry wolf on ordinary "this view was deleted" migrations.
      if (!viewsBeingDropped.has(victim.name)) unrecoverable.push(victim.name);
      continue;
    }
    if (!alreadyQueued.has(survivor.name)) {
      viewsToCreate.push(survivor);
      alreadyQueued.add(survivor.name);
    }
  }

  if (unrecoverable.length > 0) {
    phases.warnings.push(
      `CASCADE also removes ${unrecoverable.length} view${unrecoverable.length === 1 ? "" : "s"} ` +
        `that the source does not have, so ${unrecoverable.length === 1 ? "it is" : "they are"} ` +
        `not recreated: ${unrecoverable.join(", ")}.`
    );
  }

  // A view built on another view has to be created after it.
  for (const view of sortViewsByDependency(viewsToCreate)) {
    const held = heldBackViewDrops.has(view.name);
    phases.views.push(createViewStatement(view, held));
    // Every index and trigger the source's copy carries, unconditionally.
    //
    // A view in this list was dropped first — CREATE OR REPLACE without a drop
    // only happens when nothing but the WITH (...) settings moved, and those
    // views are not queued here — so its indexes and its INSTEAD OF triggers
    // went with it whether or not they appear in any diff. An index identical
    // on both sides produces no diff at all, which is exactly how a rebuilt
    // materialized view came back with none: including the one UNIQUE index
    // REFRESH ... CONCURRENTLY cannot work without.
    for (const index of view.indexes ?? []) {
      phases.afterViews.push(createIndexStatement(index, view.name, idempotent, held));
    }
    for (const trigger of view.triggers ?? []) {
      phases.afterViews.push(
        ...createTriggerStatements(trigger, view.name, {
          afterHeldBackDrop: held,
          onView: true,
        })
      );
    }
  }

  // The views the loop above rebuilt from scratch, by name.
  const rebuiltViews = new Set(viewsToCreate.map((view) => view.name));

  // Indexes and triggers on views the script does NOT rebuild — a materialized
  // view whose SELECT is unchanged but whose indexes moved, or a plain view
  // that gained an INSTEAD OF trigger. Nothing dropped these, so each change
  // has to be written out on its own. Views that WERE rebuilt are skipped: the
  // loop above already wrote every index and trigger they need, and writing the
  // diffs again would emit a DROP INDEX for one that no longer exists and a
  // second CREATE for one that was just made.
  for (const diff of viewObjectDiffs) {
    const viewName = diff.table;
    if (viewName === undefined || rebuiltViews.has(viewName)) continue;

    if (diff.kind === "INDEX") {
      if (diff.status !== "onlyA") {
        const target = findByName(findByName(rightViews, viewName)?.indexes, diff.name);
        if (target) phases.afterViews.push(dropIndexStatement(target, viewName));
      }
      if (diff.status !== "onlyB") {
        const source = findByName(findByName(leftViews, viewName)?.indexes, diff.name);
        if (source) {
          phases.afterViews.push(createIndexStatement(source, viewName, idempotent));
        }
      }
      continue;
    }

    if (diff.status === "onlyB") {
      phases.afterViews.push(dropTriggerStatement(diff.name, viewName));
      continue;
    }
    const source = findByName(findByName(leftViews, viewName)?.triggers, diff.name);
    if (source) {
      phases.afterViews.push(
        ...createTriggerStatements(source, viewName, { onView: true })
      );
    }
  }

  // ── Ownership and grants ──────────────────────────────────────────────────
  // Last, because it is the first pass that can tell whether the object each
  // entry describes is really going to exist in the shape the source recorded.
  for (const diff of privilegeDiffs) {
    // Privilege entries are keyed by kind and name together, and the diff
    // carries them already joined, so look them up by the same joined string
    // the compare engine wrote — see privilegeObjects there.
    const source = findPrivilege(report.left.privileges, diff.name);
    // "onlyB" never arrives: the compare engine leaves out an entry the target
    // has and the source does not, because the object it belongs to is one this
    // script is already dropping.
    if (!source) continue;
    const target = findPrivilege(report.right.privileges, diff.name);
    phases.privileges.push(
      ...privilegeStatements(
        source,
        diff.status === "onlyA" ? null : target,
        appliesToSchema,
        // Only a view or a materialized view is ever dropped and put back, so
        // only those two can be sitting there in the old shape.
        (source.objectKind === "VIEW" ||
          source.objectKind === "MATERIALIZED VIEW") &&
          heldBackViewDrops.has(source.objectName)
      )
    );
  }

  // ...and dropped before it, which is the same order reversed.
  phases.viewDrops.reverse();

  // Adding an enum value and using it in the same transaction is rejected by
  // PostgreSQL ("unsafe use of new value"). Apply from this app handles it —
  // the route runs these statements before it opens the transaction — but a
  // script pasted straight into psql inside BEGIN/COMMIT still hits the error,
  // so it is worth saying which is which.
  const addsEnumValue = phases.beforeTables.some(
    (stmt) => stmt.kind === "ALTER_TYPE" && stmt.sql.includes("ADD VALUE")
  );
  if (addsEnumValue) {
    phases.warnings.push(
      `This script adds enum values. Applying it from this app is fine — the new values ` +
        `are added before the migration transaction starts. If you run the script by hand ` +
        `inside a single BEGIN/COMMIT, PostgreSQL will reject any later statement that USES ` +
        `one of the new values, so run the ALTER TYPE lines on their own first.`
    );
  }

  return phases;
}

// ---------------------------------------------------------------------------
// Per-table ALTER statements
// ---------------------------------------------------------------------------

/**
 * The sequence a `nextval('name'::regclass)` default reads from, or null.
 *
 * Defaults are schema-stripped at snapshot time, so the name that comes back is
 * already relative to the target schema.
 */
function nextvalSequenceName(columnDefault: string | null): string | null {
  if (columnDefault === null) return null;
  const match = /^\s*nextval\s*\(\s*'([^']+)'/i.exec(columnDefault);
  if (!match) return null;
  // pg renders the name quoted only when it needs quoting; strip either form.
  return match[1].replace(/^"(.*)"$/, "$1");
}

function alterStatementsForMatch(
  match: TableMatch,
  sourceSchema: string,
  addColumnIfNotExists: boolean,
  sourceSequences: SequenceSnapshot[] | undefined,
  // The target's views, only so a DROP ... CASCADE below can name what it takes
  // with it. `undefined` means the snapshot never recorded views, in which case
  // the statement says nothing rather than claiming there are none.
  targetViews: ViewSnapshot[] | undefined
): { stmts: SqlStatement[]; fkStmts: SqlStatement[] } {
  const stmts: SqlStatement[] = [];
  // New FK ADD CONSTRAINTs are collected here and returned separately so the
  // caller can defer them — they run AFTER every table's columns exist. An FK
  // added inline could reference a column that a later-processed table hasn't
  // gained yet, aborting the migration (issue #23).
  const fkStmts: SqlStatement[] = [];
  // After the renames, the table in B carries A's name. Use that for all
  // subsequent ALTER TABLE statements so they reference the correct name.
  // Table names are UNQUALIFIED — search_path scopes them (see buildCreateTable).
  const tName = match.left.name;

  // ── a. Column renames ────────────────────────────────────────────────────
  // Must come before the add/alter steps so they reference the post-rename name.
  for (const colMatch of match.columnMatches) {
    if (!colMatch.exact) {
      stmts.push({
        sql: `ALTER TABLE ${q(tName)} RENAME COLUMN ${q(colMatch.right.name)} TO ${q(colMatch.left.name)};`,
        description: `Rename column "${colMatch.right.name}" → "${colMatch.left.name}" in "${tName}" (${colMatch.score}% match — verify this is a rename before running)`,
        kind: "RENAME_COLUMN",
        severity: "breaking",
        tableName: tName,
        destructive: false,
      });
    }
  }

  // ── b. Add columns that exist in A but are absent from B ─────────────────
  for (const col of match.columnsOnlyInA) {
    // NOT NULL + no default will fail on a non-empty table because PostgreSQL
    // can't fill existing rows. Flag it so the user knows to add a DEFAULT or
    // run on an empty table.
    // A computed column fills its own rows from the expression, so NOT NULL with
    // no default — which is what every generated column looks like — is fine.
    const risky = !col.nullable && col.columnDefault === null && !col.generated;
    // Same sequence-first, ownership-after shape a new table uses for a tuned
    // serial column — see tunedSerialStatements.
    const tunedSerial = tunedSerialStatements(col, tName);
    stmts.push(...tunedSerial.before);
    stmts.push({
      sql:
        `ALTER TABLE ${q(tName)} ADD COLUMN ` +
        (addColumnIfNotExists ? "IF NOT EXISTS " : "") +
        `${buildColumnDef(col)};`,
      description:
        `Add column "${col.name}" (${col.typeDisplay}) to "${tName}"` +
        (risky ? " — WARNING: NOT NULL with no default, will fail on a non-empty table" : ""),
      kind: "ADD_COLUMN",
      severity: risky ? "breaking" : "safe",
      tableName: tName,
      destructive: false,
    });
    stmts.push(...tunedSerial.after);
  }

  // ── c. Type, nullability and default changes on matched columns ──────────
  for (const colMatch of match.columnMatches) {
    // After the rename step above, this column is now called colMatch.left.name in B.
    const colName = colMatch.left.name;
    const leftNorm = normalizeType(colMatch.left.typeDisplay);
    const rightNorm = normalizeType(colMatch.right.typeDisplay);

    // ── A GENERATED ALWAYS AS (…) clause appearing, going, or changing ──────
    // There is no ALTER for this. PostgreSQL cannot turn a stored column into a
    // computed one or back, and SET EXPRESSION only exists from version 17, so
    // the portable answer for all three directions is to rebuild the column.
    // It runs before everything else this loop emits and then skips the rest:
    // a SET DEFAULT or a SET NOT NULL aimed at a column that is about to be
    // dropped is at best wasted and at worst rejected.
    const leftComputed = describeComputed(colMatch.left);
    const rightComputed = describeComputed(colMatch.right);
    if (leftComputed !== null && rightComputed !== null && leftComputed !== rightComputed) {
      // Name them. "CASCADE takes any view built on it" tells the reader a rule;
      // this tells them which of their views it is about to remove, and the
      // caller has already queued the source's copy of each for rebuild.
      const alsoDropped = targetViews
        ? viewsCascadedBy(targetViews, new Set([match.right.name])).map((v) => v.name)
        : [];
      const cascadeNote =
        alsoDropped.length > 0 ? `; CASCADE also drops ${alsoDropped.join(", ")}` : "";
      stmts.push({
        sql: `ALTER TABLE ${q(tName)} DROP COLUMN IF EXISTS ${q(colName)} CASCADE;`,
        description:
          `Drop column "${colName}" from "${tName}" so it can be rebuilt — ` +
          "WARNING: PostgreSQL cannot change a generated column in place, and " +
          `CASCADE takes any index or view built on it${cascadeNote}`,
        kind: "DROP_COLUMN",
        severity: computedChangeSeverity(),
        tableName: tName,
        // Not armed behind "allow data loss": every value in a generated column
        // is recomputed from the other columns the moment it comes back, so
        // nothing a user typed is lost. What CASCADE removes alongside it is
        // real, which is why the description says so and the grade is breaking.
        destructive: false,
      });
      stmts.push({
        sql:
          `ALTER TABLE ${q(tName)} ADD COLUMN ` +
          (addColumnIfNotExists ? "IF NOT EXISTS " : "") +
          `${buildColumnDef(colMatch.left)};`,
        description: colMatch.left.generated
          ? `Rebuild "${colName}" in "${tName}" as ${leftComputed}`
          : `Rebuild "${colName}" in "${tName}" as an ordinary column`,
        kind: "ADD_COLUMN",
        severity: computedChangeSeverity(),
        tableName: tName,
        destructive: false,
      });
      continue;
    }

    if (leftNorm !== rightNorm) {
      const baseChanged =
        extractBaseType(colMatch.left.typeDisplay) !== extractBaseType(colMatch.right.typeDisplay);
      // Same base type but a SMALLER size/precision (e.g. varchar(200) →
      // varchar(100), numeric(10,2) → numeric(6,2)). This is NOT a safe widen:
      // PostgreSQL rejects the change if any existing value exceeds the new
      // size, so it is a breaking change that must be flagged.
      const narrowing =
        !baseChanged &&
        isNarrowingType(colMatch.right.typeDisplay, colMatch.left.typeDisplay);
      // USING is needed when PostgreSQL can't cast automatically (cross-type changes).
      // Same-family widenings (e.g. varchar(100) → varchar(200)) don't need it.
      const usingSuffix = baseChanged
        ? ` USING ${q(colName)}::${colMatch.left.typeDisplay}`
        : "";

      let description: string;
      if (baseChanged) {
        description = `Change type of "${colName}" in "${tName}": ${colMatch.right.typeDisplay} → ${colMatch.left.typeDisplay} (may require data conversion)`;
      } else if (narrowing) {
        description = `Narrow "${colName}" in "${tName}": ${colMatch.right.typeDisplay} → ${colMatch.left.typeDisplay} — WARNING: will fail if any existing value exceeds the new size`;
      } else {
        description = `Widen "${colName}" in "${tName}": ${colMatch.right.typeDisplay} → ${colMatch.left.typeDisplay}`;
      }
      const severity = typeChangeSeverity(
        colMatch.left.typeDisplay,
        colMatch.right.typeDisplay
      );

      // ALTER COLUMN ... TYPE resets the column to the new type's DEFAULT
      // collation whenever COLLATE is omitted, so an ordinary widening used to
      // silently strip a collation the target already had. Restating the
      // source's is what makes the column match the source it is being synced
      // to. The grammar is TYPE <type> [COLLATE ...] [USING ...], in that order.
      stmts.push({
        sql:
          `ALTER TABLE ${q(tName)} ALTER COLUMN ${q(colName)} TYPE ` +
          `${colMatch.left.typeDisplay}${collateSuffix(colMatch.left)}${usingSuffix};`,
        description,
        kind: "ALTER_COLUMN_TYPE",
        severity,
        tableName: tName,
        destructive: false,
      });
    } else if (
      // Same type, different collation. There is no SET COLLATE in PostgreSQL:
      // the only way to change one is to re-state the type it already has and
      // name the collation beside it. Skipped when either side never recorded
      // one, where `undefined` means "unknown" and not "the type default".
      colMatch.left.collation !== undefined &&
      colMatch.right.collation !== undefined &&
      colMatch.left.collation !== colMatch.right.collation
    ) {
      // Going BACK to the type default still has to be written out — omitting
      // COLLATE on a column that has one leaves that column exactly as it is.
      // pg_catalog is qualified here because "default" is also a perfectly
      // legal name for a collation somebody created in the target schema.
      const clause = colMatch.left.collation
        ? ` COLLATE ${colMatch.left.collation}`
        : ` COLLATE pg_catalog."default"`;
      stmts.push({
        sql:
          `ALTER TABLE ${q(tName)} ALTER COLUMN ${q(colName)} TYPE ` +
          `${colMatch.left.typeDisplay}${clause};`,
        description:
          `Change collation of "${colName}" in "${tName}": ` +
          `${colMatch.right.collation ?? "type default"} → ` +
          `${colMatch.left.collation ?? "type default"} — WARNING: rewrites the ` +
          "table and rebuilds every index on this column, and changes how its " +
          "values sort and compare",
        kind: "ALTER_COLUMN_TYPE",
        severity: collationChangeSeverity(),
        tableName: tName,
        destructive: false,
      });
    }

    if (colMatch.left.nullable !== colMatch.right.nullable) {
      if (!colMatch.left.nullable) {
        stmts.push({
          sql: `ALTER TABLE ${q(tName)} ALTER COLUMN ${q(colName)} SET NOT NULL;`,
          description: `Enforce NOT NULL on "${colName}" in "${tName}" — WARNING: will fail if existing rows contain NULLs; backfill first`,
          kind: "ALTER_COLUMN_NULLABILITY",
          severity: nullabilityChangeSeverity(colMatch.left.nullable),
          tableName: tName,
          destructive: false,
        });
      } else {
        stmts.push({
          sql: `ALTER TABLE ${q(tName)} ALTER COLUMN ${q(colName)} DROP NOT NULL;`,
          description: `Allow nulls on "${colName}" in "${tName}"`,
          kind: "ALTER_COLUMN_NULLABILITY",
          severity: nullabilityChangeSeverity(colMatch.left.nullable),
          tableName: tName,
          destructive: false,
        });
      }
    }

    // ── How the column generates its own values ─────────────────────────────
    // A serial (a nextval default) and an IDENTITY column do the same job with
    // completely different catalog entries, so they are handled together:
    // moving from one to the other means removing what is there before adding
    // what is wanted, and neither statement is right on its own.
    //
    // `identity: undefined` means the snapshot predates the field. That cannot
    // be read as "not an identity column", so such a column emits no identity
    // statement at all and falls through to the plain default handling.
    const identityRecorded =
      colMatch.left.identity !== undefined && colMatch.right.identity !== undefined;
    const leftIdentity = identityRecorded ? (colMatch.left.identity ?? null) : null;
    const rightIdentity = identityRecorded ? (colMatch.right.identity ?? null) : null;
    const leftSerial = isNextvalDefault(colMatch.left.columnDefault);
    const rightSerial = isNextvalDefault(colMatch.right.columnDefault);
    const leftDefault = colMatch.left.columnDefault?.trim() || null;
    const rightDefault = colMatch.right.columnDefault?.trim() || null;

    if (identityRecorded && leftIdentity !== rightIdentity) {
      if (leftIdentity !== null && rightIdentity !== null) {
        // Both are identity columns, only the flavour differs.
        stmts.push({
          sql: `ALTER TABLE ${q(tName)} ALTER COLUMN ${q(colName)} SET GENERATED ${leftIdentity};`,
          description: `Change "${colName}" in "${tName}" to GENERATED ${leftIdentity} AS IDENTITY`,
          kind: "ALTER_COLUMN_DEFAULT",
          severity: generatedChangeSeverity(colMatch.left, colMatch.right),
          tableName: tName,
          destructive: false,
        });
      } else if (leftIdentity !== null) {
        // ADD GENERATED is refused while the column still has a default, so a
        // serial target has to give that up first.
        if (rightSerial) {
          stmts.push({
            sql: `ALTER TABLE ${q(tName)} ALTER COLUMN ${q(colName)} DROP DEFAULT;`,
            description: `Drop the sequence default on "${colName}" in "${tName}" before it becomes an identity column`,
            kind: "ALTER_COLUMN_DEFAULT",
            severity: "safe",
            tableName: tName,
            destructive: false,
          });
        }
        stmts.push({
          sql:
            `ALTER TABLE ${q(tName)} ALTER COLUMN ${q(colName)} ` +
            `ADD GENERATED ${leftIdentity} AS IDENTITY` +
            `${identityOptionsSuffix(colMatch.left)};`,
          description: `Make "${colName}" in "${tName}" an identity column — WARNING: fails unless the column is NOT NULL`,
          kind: "ALTER_COLUMN_DEFAULT",
          severity: generatedChangeSeverity(colMatch.left, colMatch.right),
          tableName: tName,
          destructive: false,
        });
      } else {
        stmts.push({
          sql: `ALTER TABLE ${q(tName)} ALTER COLUMN ${q(colName)} DROP IDENTITY IF EXISTS;`,
          description: leftSerial
            ? `Remove the identity on "${colName}" in "${tName}" so a sequence default can replace it`
            : `Stop "${colName}" in "${tName}" generating its own values`,
          kind: "ALTER_COLUMN_DEFAULT",
          severity: generatedChangeSeverity(colMatch.left, colMatch.right),
          tableName: tName,
          destructive: false,
        });
      }
    }

    // ── The settings of the sequence behind the column ──────────────────────
    // Only for a column that generates its values the SAME way on both sides.
    // Every other case is a rebuild — the branch above adds the identity clause
    // with its options attached, and the serial branch below creates the
    // sequence from the source's own settings — so emitting these as well would
    // be setting twice what one statement already set.
    //
    // `undefined` on either side is a snapshot taken before the settings were
    // read, and says nothing about what the sequence is configured as, so
    // nothing is emitted for it.
    const leftSequenceOptions = colMatch.left.sequenceOptions;
    const rightSequenceOptions = colMatch.right.sequenceOptions;
    const sameGenerator =
      (leftIdentity !== null && rightIdentity !== null) ||
      (leftIdentity === null && rightIdentity === null && leftSerial && rightSerial);
    if (leftSequenceOptions && rightSequenceOptions && sameGenerator) {
      // An identity column is altered through the table, because that is the
      // only handle the script has on it: its sequence has a generated name
      // that nothing in the snapshot ties back to the column. A serial's
      // sequence is named right there in the target's own default, so it is
      // altered directly.
      const identityForm = leftIdentity !== null;
      const targetSequence = identityForm ? null : nextvalSequenceName(rightDefault);
      const prefix = identityForm
        ? `ALTER TABLE ${q(tName)} ALTER COLUMN ${q(colName)} `
        : targetSequence !== null
          ? `ALTER SEQUENCE ${q(targetSequence)} `
          : null;
      const severity = sequenceOptionsChangeSeverity(
        leftSequenceOptions,
        rightSequenceOptions
      );
      for (const step of sequenceOptionSteps(leftSequenceOptions, rightSequenceOptions)) {
        stmts.push(
          prefix === null
            ? {
                sql: `-- MANUAL: set ${step.clause} on the sequence behind "${colName}" in "${tName}" by hand; its name could not be read from the default ${rightDefault}.`,
                description: `"${colName}" needs ${step.clause} set on its sequence by hand`,
                kind: "ALTER_SEQUENCE",
                severity: "info",
                tableName: tName,
                destructive: false,
              }
            : {
                sql: `${prefix}${step.set && identityForm ? "SET " : ""}${step.clause};`,
                description: `${step.description} on the sequence behind "${colName}" in "${tName}"`,
                kind: "ALTER_SEQUENCE",
                severity,
                tableName: tName,
                destructive: false,
              }
        );
      }
    }

    // ── Default value change ────────────────────────────────────────────────
    // Defaults are schema-relative here (own-schema qualifier stripped at
    // snapshot time), so SET DEFAULT resolves against the target via search_path.
    if (leftIdentity !== null) {
      // The identity clause IS how this column gets its values; it never also
      // carries a default, so there is nothing further to set.
    } else if (leftSerial && rightSerial) {
      // Both serial — the sequence NAME differs between two schemas and nothing
      // else does, so there is no real change here to emit.
    } else if (leftSerial) {
      // Source is serial, target is not. `serial` is not a real type — it is a
      // sequence, a default that reads it, and an ownership link — so all three
      // are rebuilt here. The sequence is created rather than assumed present:
      // an owned sequence never appears in the object diffs (it belongs to its
      // column, not to the schema), so nothing else in the script makes it.
      const sequenceName = nextvalSequenceName(leftDefault);
      if (sequenceName === null) {
        stmts.push({
          sql: `-- MANUAL: "${colName}" in "${tName}" has the default ${leftDefault}, which could not be read as a sequence; set it by hand.`,
          description: `"${colName}" needs its default set manually`,
          kind: "ALTER_COLUMN_DEFAULT",
          severity: "info",
          tableName: tName,
          destructive: false,
        });
      } else {
        const sourceSequence = sourceSequences?.find((seq) => seq.name === sequenceName);
        stmts.push(
          sourceSequence
            ? createSequenceStatement(sourceSequence, true)
            : objectStatement({
                sql: `CREATE SEQUENCE IF NOT EXISTS ${q(sequenceName)};`,
                description: `Create sequence "${sequenceName}" for "${colName}" in "${tName}"`,
                kind: "CREATE_SEQUENCE",
                tableName: sequenceName,
              })
        );
        stmts.push({
          sql: `ALTER TABLE ${q(tName)} ALTER COLUMN ${q(colName)} SET DEFAULT nextval('${sequenceName.replace(/'/g, "''")}'::regclass);`,
          description: `Make "${colName}" in "${tName}" take its values from sequence "${sequenceName}"`,
          kind: "ALTER_COLUMN_DEFAULT",
          severity: "safe",
          tableName: tName,
          destructive: false,
        });
        // Ownership is what makes it a serial rather than a table plus a loose
        // sequence: it ties the sequence's lifetime to the column's.
        stmts.push({
          sql: `ALTER SEQUENCE ${q(sequenceName)} OWNED BY ${q(tName)}.${q(colName)};`,
          description: `Tie sequence "${sequenceName}" to "${colName}" in "${tName}"`,
          kind: "ALTER_SEQUENCE",
          severity: "safe",
          tableName: tName,
          destructive: false,
        });
      }
    } else if (leftDefault !== rightDefault) {
      if (leftDefault === null) {
        stmts.push({
          sql: `ALTER TABLE ${q(tName)} ALTER COLUMN ${q(colName)} DROP DEFAULT;`,
          description: `Drop default on "${colName}" in "${tName}"`,
          kind: "ALTER_COLUMN_DEFAULT",
          severity: "safe",
          tableName: tName,
          destructive: false,
        });
      } else {
        stmts.push({
          sql: `ALTER TABLE ${q(tName)} ALTER COLUMN ${q(colName)} SET DEFAULT ${leftDefault};`,
          description: `Set default on "${colName}" in "${tName}" to ${leftDefault}`,
          kind: "ALTER_COLUMN_DEFAULT",
          severity: "safe",
          tableName: tName,
          destructive: false,
        });
      }
    }
  }

  // ── d. Constraint diffs ──────────────────────────────────────────────────
  // Drop order: FKs first so we remove the dependency before anything else.
  const toDrop = match.constraintDiffs.filter(
    (d) => d.status === "onlyB" || d.status === "changedDefinition"
  );
  const dropFksFirst = toDrop.filter((d) => d.kind === "FOREIGN KEY");
  const dropRest = toDrop.filter((d) => d.kind !== "FOREIGN KEY");

  for (const diff of [...dropFksFirst, ...dropRest]) {
    const constraintName = diff.rightName ?? "";
    if (!constraintName) continue;
    stmts.push({
      sql: `ALTER TABLE ${q(tName)} DROP CONSTRAINT IF EXISTS ${q(constraintName)};`,
      description: `Drop ${diff.kind} "${constraintName}" from "${tName}"`,
      kind: "DROP_CONSTRAINT",
      severity: constraintChangeSeverity(diff.kind, "drop"),
      tableName: tName,
      destructive: false,
    });
  }

  // Add order: non-FKs here; FK ADDs are deferred into fkStmts so they
  // run after every table's ADD COLUMN across ALL matched/created tables.
  const toAdd = match.constraintDiffs.filter(
    (d) => d.status === "onlyA" || d.status === "changedDefinition"
  );
  const addNonFks = toAdd.filter((d) => d.kind !== "FOREIGN KEY");
  const addFks = toAdd.filter((d) => d.kind === "FOREIGN KEY");

  for (const diff of addNonFks) {
    const cName = diff.leftName ?? "";
    if (!cName) continue;
    const found = lookupConstraintDef(match.left, diff.kind, cName);
    if (!found) continue;
    stmts.push({
      sql: `ALTER TABLE ${q(tName)} ADD CONSTRAINT ${q(found.name)} ${found.definition};`,
      description: `Add ${diff.kind} "${found.name}" to "${tName}"`,
      kind: "ADD_CONSTRAINT",
      severity: constraintChangeSeverity(diff.kind, "add"),
      tableName: tName,
      destructive: false,
    });
  }

  for (const diff of addFks) {
    const fkName = diff.leftName ?? "";
    const fk = match.left.foreignKeys.find((f) => f.name === fkName);
    if (!fk) continue;
    fkStmts.push({
      sql: `ALTER TABLE ${q(tName)} ADD CONSTRAINT ${q(fk.name)} ${buildFkDef(fk, sourceSchema)};`,
      description: `Add FK "${fk.name}" to "${tName}"`,
      kind: "ADD_CONSTRAINT",
      severity: constraintChangeSeverity("FOREIGN KEY", "add"),
      tableName: tName,
      destructive: false,
    });
  }

  // ── e. Drop columns that exist in B but not in A ─────────────────────────
  // Destructive: removes the column and its data. Emitted last (after the
  // constraint drops above) and with CASCADE + IF EXISTS so it never trips over
  // a dependent index/constraint and stays idempotent on re-run.
  for (const col of match.columnsOnlyInB) {
    stmts.push({
      sql: `ALTER TABLE ${q(tName)} DROP COLUMN IF EXISTS ${q(col.name)} CASCADE;`,
      description: `Drop column "${col.name}" from "${tName}" — WARNING: removes the column and all its data`,
      kind: "DROP_COLUMN",
      severity: "breaking",
      tableName: tName,
      destructive: true,
    });
  }

  return { stmts, fkStmts };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate a migration script that brings B (right/target) in sync with A (left/source).
 * The returned statements are ordered so they can be run top-to-bottom without
 * manual reordering:
 *
 *    1. Types and standalone sequences — a column may use one
 *    2. Drop views — they read the tables everything below is about to change
 *    3. Rename tables in B to match A's names
 *    4. CREATE TABLE for tables only in A (its FK constraints are queued)
 *    5. Functions and procedures — a trigger or a CHECK may call one
 *    6. ALTER matched tables (renames → adds → type/null → constraints → DROP COLUMN)
 *    7. Drop tables that are only in B
 *    8. Indexes, now that every column exists
 *    9. FK constraints, now that every table and column exists
 *   10. Triggers
 *   11. Create views, last of the additive work: every table they read is final
 *   12. Drop the routines, types and sequences nothing uses any more
 *
 * The steps are named rather than numbered in the code below, so that inserting
 * one does not silently make every cross-reference wrong.
 *
 * Views are dropped near the top and rebuilt near the bottom on purpose. A view
 * pins the columns it reads: ALTER TABLE cannot change a column's type while a
 * view selects it, and rebuilding a view before the tables are final just
 * rebuilds it against the old shape. Dropping tables BEFORE the views are
 * rebuilt matters for the same reason — a DROP TABLE ... CASCADE would
 * otherwise take a freshly recreated view straight back out again.
 *
 * This is a COMPLETE sync: it always GENERATES the destructive statements
 * (DROP TABLE / DROP COLUMN) needed to fully match A, so the report can show
 * the user exactly what a full sync would remove. Whether those statements are
 * ARMED in the rendered SQL is a separate decision:
 *
 *   allowDataLoss: false  (default)  destructive statements are rendered
 *                                    commented out — running the script cannot
 *                                    drop a table or a column
 *   allowDataLoss: true              they are rendered live
 *
 * Nothing is silently skipped in either mode: renderMigrationScript states how
 * many statements were held back and how to arm them.
 */
export function generateMigration(
  report: CompareReport,
  options: MigrationOptions = {},
): MigrationScript {
  const allowDataLoss = options.allowDataLoss === true;
  const sourceSchema = report.left.schema;
  const statements: SqlStatement[] = [];
  const warnings: string[] = [];
  const objects = objectPhases(
    report,
    options.addColumnIfNotExists === true,
    options.appliesToSchema ?? report.right.schema
  );
  const rightViews = report.right.views ?? [];

  // ── Extensions ────────────────────────────────────────────────────────────
  // Ahead of everything. An extension brings its own types, operators,
  // functions and sometimes collations, none of which the snapshot records on
  // their own — so a column, a domain or an index that names one of them has
  // nothing to name until the extension is installed.
  statements.push(...objects.extensions);

  // ── Collations ────────────────────────────────────────────────────────────
  // Ahead of the types below as well as the tables: a domain can be declared
  // COLLATE "x" exactly the way a column can.
  statements.push(...objects.collations);

  // ── Types and standalone sequences ────────────────────────────────────────
  // A CREATE TABLE below can name an enum or a domain, and a column
  // default can call nextval on a standalone sequence, so both have to exist
  // before any table is built.
  statements.push(...objects.beforeTables);

  // ── Drop views ────────────────────────────────────────────────────────────
  // First, not last. A view holds its source columns in place: ALTER TABLE
  // refuses to change the type of a column a view selects, and a view that has
  // to be rebuilt has to be gone before the rebuild. Anything the source still
  // has is recreated further down, once the tables are final.
  statements.push(...objects.viewDrops);

  // ── Rename tables ─────────────────────────────────────────────────────────
  // Similarity-matched tables have different names in A and B.
  // We rename B's table to A's name so subsequent ALTER TABLE statements work.
  for (const match of report.matchedTables) {
    if (!match.exact) {
      statements.push({
        sql: `ALTER TABLE ${q(match.right.name)} RENAME TO ${q(match.left.name)};`,
        description: `Rename table "${match.right.name}" → "${match.left.name}" (${match.score}% similarity — verify this is a rename and not two unrelated tables)`,
        kind: "RENAME_TABLE",
        severity: "breaking",
        tableName: match.right.name,
        destructive: false,
      });
    }
  }

  // ── CREATE TABLE for tables only in A ─────────────────────────────────────
  // FK constraints are queued separately (fkStatements) and appended later
  // so the ordering of CREATE TABLE statements doesn't matter.
  const fkStatements: SqlStatement[] = [];

  for (const table of orderTablesForCreate(report.tablesOnlyInA)) {
    // A serial column whose sequence was tuned needs that sequence built before
    // the table's DEFAULT nextval(...) can name it, and tied to the column
    // afterwards — see tunedSerialStatements.
    const tunedSerials = table.columns.map((col) => tunedSerialStatements(col, table.name));
    for (const pair of tunedSerials) statements.push(...pair.before);

    statements.push({
      sql: buildCreateTable(table),
      description: `Create ${describeNewTable(table)}`,
      kind: "CREATE_TABLE",
      severity: "info",
      tableName: table.name,
      destructive: false,
    });

    for (const pair of tunedSerials) statements.push(...pair.after);

    for (const fk of table.foreignKeys) {
      fkStatements.push({
        sql: `ALTER TABLE ${q(table.name)} ADD CONSTRAINT ${q(fk.name)} ${buildFkDef(fk, sourceSchema)};`,
        description: `Add FK "${fk.name}" to "${table.name}"`,
        kind: "ADD_CONSTRAINT",
        severity: "info",
        tableName: table.name,
        destructive: false,
      });
    }
  }

  // ── Functions and procedures ──────────────────────────────────────────────
  // Before the alters below, because a CHECK constraint or a column default
  // added there may call one. They come after CREATE TABLE so a function whose body
  // reads a new table finds it.
  statements.push(...objects.routines);

  // ── Alter matched tables ──────────────────────────────────────────────────
  // Each match yields immediate ALTERs plus any new-FK ADDs, which are deferred
  // into the FK bucket so they run after every table's columns exist.
  for (const match of report.matchedTables) {
    const { stmts, fkStmts } = alterStatementsForMatch(
      match,
      sourceSchema,
      options.addColumnIfNotExists === true,
      report.left.sequences,
      report.right.views,
    );
    // Safe mode comments a materialized view's drop out, and the retype it was
    // dropped for has to be held back with it — see ObjectPhases.retypeBlockedBy.
    // Marked rather than skipped, so the reader still sees the statement and the
    // "N held back" count still includes it.
    const blockers = objects.retypeBlockedBy.get(match.left.name);
    if (blockers && blockers.length > 0 && !allowDataLoss) {
      for (const stmt of stmts) {
        if (stmt.kind === "ALTER_COLUMN_TYPE") stmt.needsArmedDrop = true;
      }
      warnings.push(
        `The column type change${stmts.filter((s) => s.kind === "ALTER_COLUMN_TYPE").length === 1 ? "" : "s"} ` +
          `on "${match.left.name}" ${blockers.length === 1 ? "needs" : "need"} ` +
          `${blockers.join(", ")} out of the way, and dropping a materialized view ` +
          `throws its rows away, so both are held back. Enable "allow data loss" to ` +
          `run them.`,
      );
    }
    statements.push(...stmts);
    fkStatements.push(...fkStmts);
  }

  // ── Drop tables that exist in B but not in A ──────────────────────────────
  // Destructive: removes the table and all its data. After the alter work, so
  // nothing above trips over a missing table — and BEFORE the views are
  // rebuilt, because CASCADE here would otherwise take a view that was just
  // recreated straight back out again.
  for (const table of report.tablesOnlyInB) {
    // Name the dependents CASCADE is about to take. Without this the script
    // reads as if it removes one table, while silently removing every view
    // built on it — and a report that never mentioned them cannot restore them.
    const alsoDropped = viewsCascadedBy(rightViews, new Set([table.name])).map((v) => v.name);
    const cascadeNote =
      alsoDropped.length > 0
        ? `; CASCADE also drops ${alsoDropped.join(", ")}`
        : "";
    statements.push({
      sql: `DROP TABLE IF EXISTS ${q(table.name)} CASCADE;`,
      description: `Drop table "${table.name}" — WARNING: removes the table and all its data${cascadeNote}`,
      kind: "DROP_TABLE",
      severity: "breaking",
      tableName: table.name,
      destructive: true,
    });
  }

  // ── Indexes ───────────────────────────────────────────────────────────────
  // After every ADD COLUMN, so an index over a new column has something to
  // index. Plain CREATE INDEX, never CONCURRENTLY — see the note above
  // indexCreateSql: the apply route runs this inside one transaction.
  statements.push(...objects.indexes);

  // ── FK constraints (new tables + matched tables) ──────────────────────────
  // All tables exist and all columns have been added, so every FK is safe now.
  statements.push(...fkStatements);

  // ── Triggers ──────────────────────────────────────────────────────────────
  // Triggers need both their function and the columns they read.
  statements.push(...objects.triggers);

  // ── Row security ──────────────────────────────────────────────────────────
  // After the triggers, because a policy can call a function the same way a
  // trigger does, and after every column, because a policy expression reads
  // them. Nothing later in the script depends on a policy existing.
  statements.push(...objects.policies);

  // ── Create views ──────────────────────────────────────────────────────────
  // Last of the additive work. Every table a view reads is now in its final
  // shape, and every table that was going to be dropped is already gone, so
  // nothing here can be cascaded away by a later statement.
  statements.push(...objects.views);

  // ── Indexes and triggers on those views ───────────────────────────────────
  // Immediately after, and not with the table-scoped ones far above: a
  // materialized view's indexes and a view's INSTEAD OF triggers need the view
  // itself to exist, and it has only just been made.
  statements.push(...objects.afterViews);

  // ── Ownership and grants ──────────────────────────────────────────────────
  // Everything the script builds now exists, so there is something to grant on
  // — and nothing has been dropped yet, so nothing is granted on a name that
  // has already gone.
  statements.push(...objects.privileges);

  // ── Routines that are no longer used ──────────────────────────────────────
  // Before the types below: a function whose argument or return type is an enum
  // holds that enum in place, and DROP TYPE deliberately carries no CASCADE.
  statements.push(...objects.routineDrops);

  // ── Types and sequences that are no longer used ───────────────────────────
  // Last of all: a type cannot be dropped while a column still has it, and that
  // column only went away with the table drops above.
  statements.push(...objects.afterTables);

  // ── Collations that are no longer used ────────────────────────────────────
  // After the type drops, not with them: a domain can carry a collation, so
  // the collation outlives the domain by exactly one statement.
  statements.push(...objects.collationDrops);

  // ── Extensions that are no longer used ────────────────────────────────────
  // The very last thing. DROP EXTENSION carries no CASCADE and an extension
  // holds everything it installed — a column on one of its types, an index on
  // one of its operator classes, a collation it shipped. The drops above are
  // what clear the way.
  statements.push(...objects.extensionDrops);

  warnings.push(...objects.warnings);

  // Roles are cluster-wide, and the snapshot records one schema. So the script
  // can name a role the target server has never heard of, and GRANT fails on a
  // role that does not exist rather than creating one. Said once here, because
  // saying it on every GRANT would bury the statements themselves.
  const namedRoles = new Set<string>();
  for (const statement of objects.privileges) {
    const match = /(?:TO|FROM) (?:PUBLIC|"((?:[^"]|"")+)")/.exec(statement.sql);
    if (match?.[1]) namedRoles.add(match[1].replace(/""/g, '"'));
  }
  if (namedRoles.size > 0) {
    const listed = [...namedRoles].sort().map((r) => `"${r}"`).join(", ");
    warnings.push(
      `This script grants to ${listed}. Roles belong to the whole server, not ` +
        "to a schema, so a snapshot cannot tell whether the target has them — " +
        "CREATE ROLE any that are missing before running it, or the GRANT fails.",
    );
  }
  if (objects.privileges.length > 0) {
    warnings.push(
      "Everything this script creates is owned by whoever runs it until the " +
        "ALTER ... OWNER TO statements near the end move it. Running it as a " +
        "role that cannot reassign ownership leaves the objects owned by that " +
        "role, which is a difference the next comparison will report.",
    );
  }

  const destructiveCount = statements.filter((s) => s.destructive).length;
  const heldBackCount = statements.filter(
    (s) => s.destructive || s.needsArmedDrop === true,
  ).length;
  if (destructiveCount > 0 && !allowDataLoss) {
    warnings.push(
      `${destructiveCount} destructive statement${destructiveCount === 1 ? " is" : "s are"} ` +
        `commented out. Enable "allow data loss" to include ${destructiveCount === 1 ? "it" : "them"}.`,
    );
  }
  // A rebuild that is inert without its drop is held back too, and silently
  // skipping it is what let a safe-mode run report success over a materialized
  // view that still had the old definition and the old rows.
  const inertCount = heldBackCount - destructiveCount;
  if (inertCount > 0 && !allowDataLoss) {
    warnings.push(
      `${inertCount} view rebuild${inertCount === 1 ? " is" : "s are"} also commented ` +
        `out: a rebuild cannot run while the materialized view it replaces is still ` +
        `there, so ${inertCount === 1 ? "that view keeps" : "those views keep"} the ` +
        `target's definition and rows until data loss is enabled.`,
    );
  }

  return {
    statements,
    warnings,
    sourceSchema: `${report.left.database}.${report.left.schema}`,
    targetSchema: `${report.right.database}.${report.right.schema}`,
    allowDataLoss,
    destructiveCount,
    heldBackCount,
  };
}

// Prefix every line of a statement with "-- " so it is inert when executed.
function commentOut(sql: string): string {
  return sql
    .split("\n")
    .map((line) => `-- ${line}`)
    .join("\n");
}

// Render the migration script as a plain SQL text string with inline comments.
// Each statement is preceded by a comment showing its severity and description.
//
/**
 * How many of these "statements" are notes rather than SQL.
 *
 * A MANUAL statement is a comment describing work no statement can do — a
 * collation that has to be dropped and rebuilt with its columns moved off it,
 * a range type whose canonical function needs a shell type first. It is in the
 * list because the reader has to see it, and it is graded like anything else,
 * so "8 statements" counted it as work the script performs. It performs none.
 *
 * Exported so the two rendered headers and the count under the editor all
 * arrive at the same number from the same rule.
 */
export function manualNoteCount(statements: SqlStatement[]): number {
  return statements.filter((s) => s.kind === "MANUAL").length;
}

// When script.allowDataLoss is false, statements flagged destructive are
// rendered commented out. This is the single point where a generated script
// becomes able to destroy data, so the decision is made here and nowhere else.
/**
 * How severe this migration is, decided from the statements the generator
 * wrote rather than from the text it renders.
 *
 * Only statements that will RUN count. Safe mode comments its destructive
 * statements out, so a migration whose only breaking change is a held-back DROP
 * does not actually break anything when applied, and grading it "breaking"
 * would force a major version bump for a script that just adds a column.
 *
 * A MANUAL note runs nothing either — it is a description of work no statement
 * can do — so it cannot raise the level on its own.
 */
export function migrationChangeLevel(script: MigrationScript): ChangeLevel {
  const willRun = script.statements.filter((stmt) => {
    if (stmt.kind === "MANUAL") return false;
    const muted = (stmt.destructive || stmt.needsArmedDrop === true) && !script.allowDataLoss;
    return !muted;
  });

  if (willRun.length === 0) return "patch";
  if (willRun.some((stmt) => stmt.severity === "breaking")) return "breaking";
  if (willRun.some((stmt) => stmt.kind.startsWith("CREATE_") || stmt.kind.startsWith("ADD_"))) {
    return "additive";
  }
  return "patch";
}

export function renderMigrationScript(script: MigrationScript): string {
  const breaking = script.statements.filter((s) => s.severity === "breaking").length;
  const safe = script.statements.filter((s) => s.severity === "safe").length;
  const info = script.statements.filter((s) => s.severity === "info").length;
  const held = script.allowDataLoss ? 0 : script.heldBackCount;
  // The held-back set is not all destructive: a rebuilt matview is in there
  // because it does nothing until its drop runs, not because it deletes.
  const heldDestructive = script.allowDataLoss ? 0 : script.destructiveCount;

  const header = [
    `-- ================================================================`,
    `-- Migration: ${script.sourceSchema}  →  ${script.targetSchema}`,
    `-- Direction: modifies the RIGHT/TARGET schema to match the LEFT/SOURCE schema`,
    `-- Statements: ${script.statements.length}  (${breaking} breaking · ${safe} safe · ${info} info)`,
    // Machine-readable, and the only accurate grading of this script that
    // exists: everything downstream sees the file as text and would otherwise
    // have to guess by searching it. See lib/change-type.ts.
    changeTypeHeaderLine(migrationChangeLevel(script)),
  ];

  const notes = manualNoteCount(script.statements);
  if (notes > 0) {
    header.push(
      `-- ${notes} of ${notes === 1 ? "those is a MANUAL note" : "those are MANUAL notes"}: ` +
        `${notes === 1 ? "it describes" : "they describe"} work no statement can do, and ` +
        `${notes === 1 ? "runs" : "run"} nothing.`,
    );
  }

  if (held > 0) {
    header.push(
      `--`,
      `-- SAFE MODE IS ON. ${held} statement${held === 1 ? "" : "s"} ` +
        `(${heldDestructive} destructive` +
        `${held > heldDestructive ? `, ${held - heldDestructive} inert without ${heldDestructive === 1 ? "it" : "them"}` : ""}) ` +
        `${held === 1 ? "is" : "are"} commented out below`,
      `-- and will NOT run. Each one is marked [NOT EXECUTED]. To apply them,`,
      `-- re-run the comparison with "allow data loss" enabled, or uncomment them`,
      `-- by hand in the script editor after checking the data is expendable.`,
    );
  } else if (script.destructiveCount > 0) {
    header.push(
      `--`,
      `-- DATA LOSS IS ARMED. ${script.destructiveCount} statement` +
        `${script.destructiveCount === 1 ? "" : "s"} below will permanently remove`,
      `-- tables or columns and every row in them. Review each one before running.`,
    );
  }

  header.push(`-- ================================================================`);
  const headerText = header.join("\n");

  if (script.statements.length === 0) {
    return `${headerText}\n\n-- No changes needed.`;
  }

  const body = script.statements
    .map((stmt) => {
      const muted = (stmt.destructive || stmt.needsArmedDrop === true) && !script.allowDataLoss;
      const tag = muted ? "NOT EXECUTED — " : "";
      return (
        `-- [${tag}${stmt.severity.toUpperCase()}] ${stmt.description}\n` +
        (muted ? commentOut(stmt.sql) : stmt.sql)
      );
    })
    .join("\n\n");

  return `${headerText}\n\n${body}`;
}

// ---------------------------------------------------------------------------
// Rollback / down scripts
// ---------------------------------------------------------------------------

export type RollbackScript = {
  /** The statements that undo the forward migration, in runnable order. */
  statements: SqlStatement[];
  warnings: string[];
  /** Label of the schema the rollback runs against — the same target as the migration. */
  targetSchema: string;
  /** Label of the schema the migration synced from, for the header only. */
  sourceSchema: string;
  /**
   * Structure the rollback puts back but cannot refill. Tables are bare names;
   * columns are written "table.column". These are exactly the things the
   * forward migration's DROP statements removed.
   */
  emptyOnRestore: { tables: string[]; columns: string[] };
  /**
   * What the rollback DROPS because the forward migration created it.
   *
   * Tables and columns are kept apart from the rest because only they can hold
   * rows written since the migration ran — a column is written "table.column".
   * `objects` (views, sequences, types, routines, indexes, triggers, policies)
   * are dropped too, but they carry no rows of their own, so removing them puts
   * the target back exactly as it was.
   *
   * Created columns used to be counted nowhere at all, which is how an add-only
   * migration produced a down script promising it "restores the target exactly
   * as it was" two lines above an armed DROP COLUMN ... CASCADE.
   */
  dropsCreated: { tables: string[]; columns: string[]; objects: string[] };
  /**
   * Columns whose type the migration changed in a way no cast can undo, written
   * "table.column: old → new". The down script still restores the type; these
   * are the columns where it cannot restore the value.
   */
  truncatingTypeChanges: string[];
  /** True when the rollback restores the target exactly, data included. */
  lossless: boolean;
  /** Whether the forward migration this undoes had its drops armed. */
  forwardAllowedDataLoss: boolean;
};

/**
 * Everything besides tables and columns that the forward migration creates, and
 * the rollback therefore drops, labelled the way the report names it.
 *
 * "onlyA" means the object exists in the source and not in the target, so the
 * forward migration is what brings it into being.
 */
function createdObjectLabels(report: CompareReport): string[] {
  const labels: string[] = [];

  function add(diff: ObjectDiff) {
    if (diff.status !== "onlyA") return;
    const kind = diff.kind.toLowerCase();
    labels.push(
      diff.table ? `${kind} ${diff.name} on ${diff.table}` : `${kind} ${diff.name}`,
    );
  }

  for (const diff of report.objectDiffs) add(diff);
  for (const match of report.matchedTables) {
    // Indexes and triggers on a brand-new table are not listed separately —
    // they go away with the table, which is already named in dropsCreated.
    for (const diff of match.objectDiffs) add(diff);
  }
  return labels;
}

/**
 * Type changes that a cast can walk in one direction without losing anything.
 *
 * Each chain reads narrow-to-wide: every value of an earlier entry is
 * representable in every later one, so casting forward along a chain keeps the
 * value and casting back returns it unchanged. Chains only, no cross-links —
 * anything not listed here is treated as lossy, which is the safe answer for a
 * header that makes an absolute claim.
 */
const WIDENING_TYPE_CHAINS: string[][] = [
  ["smallint", "integer", "bigint", "numeric"],
  ["real", "double precision"],
  // A date is midnight, so it survives the trip into a timestamp and back. The
  // reverse is the defect this whole check exists for.
  ["date", "timestamp without time zone"],
  ["date", "timestamp with time zone"],
  // bpchar pads with spaces, varchar and text keep them; casting back re-pads
  // to the same stored value.
  ["character", "character varying", "text"],
];

/**
 * True when the FORWARD migration's change of a column's type keeps every value
 * the target already held, so the rollback's cast back returns the original.
 *
 * The rollback undoes an ALTER COLUMN TYPE by casting the other way. That
 * restores the type; it cannot restore the value, because the forward cast has
 * already run and kept only what the new type could hold. timestamp → date is
 * the plain case: the time of day is gone before the down script exists, and
 * casting back to timestamp yields midnight. numeric(10,4) → numeric(10,2) is
 * the quiet one — it rounds, and nothing errors.
 *
 * So this answers "is the forward cast widening", and anything it cannot prove
 * is widening counts as lossy. A false negative costs a warning nobody needed;
 * a false positive is the header telling the reader their data came back.
 */
function typeChangePreservesValues(fromType: string, toType: string): boolean {
  const from = extractBaseType(fromType);
  const to = extractBaseType(toType);

  // Same base type: the only question left is the size/precision, which the
  // compare engine already knows how to read.
  if (from === to) return !isNarrowingType(fromType, toType);

  // Different base types: widening only, and only along one chain. Losing the
  // size parameters is deliberate — smallint → numeric(4,0) is not something
  // this can prove, and it says so by returning false.
  return WIDENING_TYPE_CHAINS.some((chain) => {
    const fromIndex = chain.indexOf(from);
    const toIndex = chain.indexOf(to);
    return (
      fromIndex !== -1 &&
      toIndex > fromIndex &&
      typeSizeParams(toType) === null
    );
  });
}

/**
 * Every matched column whose type the forward migration changed in a way the
 * rollback cannot undo, written "table.column: old → new".
 *
 * Read off the ORIGINAL report, so `right` is the target as it stood before the
 * migration and `left` is what the migration changed it to.
 */
function truncatingTypeChangeLabels(report: CompareReport): string[] {
  const labels: string[] = [];
  for (const match of report.matchedTables) {
    for (const column of match.columnMatches) {
      const changedType = column.changes.some(
        (change) => change.kind === "type" || change.kind === "size",
      );
      if (!changedType) continue;
      const before = column.right.typeDisplay;
      const after = column.left.typeDisplay;
      if (typeChangePreservesValues(before, after)) continue;
      labels.push(`${match.left.name}.${column.left.name}: ${before} → ${after}`);
    }
  }
  return labels;
}

/**
 * Build the down script for the migration generateMigration() produces from the
 * same report.
 *
 * Undoing "make the target look like the source" is the same problem as the
 * migration itself with the two sides swapped, so this runs the comparison
 * backwards and reuses the whole forward generator on the result instead of
 * hand-writing an inverse for each of the sixteen statement shapes. A dropped
 * column comes back as an ADD COLUMN, a created table becomes a DROP TABLE, a
 * widened type narrows again, a rename renames back.
 *
 * Two things a down script genuinely cannot do, both stated in the rendered
 * header rather than hidden:
 *
 *   - It restores structure, never data. A table the migration dropped comes
 *     back empty; a column comes back full of nulls or its default.
 *   - Dropping a table the migration created destroys anything written into it
 *     since. Those drops are armed, because a rollback that leaves half the
 *     migration in place is not a rollback.
 *
 * Pass the same allowDataLoss the forward migration used. It does not change
 * which statements are emitted — the restoring ones are written idempotently so
 * they are inert when the forward script never dropped anything — it only
 * changes what the header claims was lost.
 */
export function generateRollback(
  report: CompareReport,
  options: MigrationOptions = {},
): RollbackScript {
  const forwardAllowedDataLoss = options.allowDataLoss === true;

  // The comparison, backwards: the target's ORIGINAL state becomes the source
  // to restore, and the post-migration state (which matches the source) becomes
  // the thing to change.
  const reverseReport = compareSchemas(report.right, report.left);
  const inverse = generateMigration(reverseReport, {
    allowDataLoss: true,
    addColumnIfNotExists: true,
    // The reversed report has the SOURCE on its right, and this script runs
    // against the target — see the note on the option.
    appliesToSchema: report.right.schema,
  });

  // What the forward migration destroyed, read off the ORIGINAL report so the
  // header describes the migration the user actually ran.
  const emptyTables = report.tablesOnlyInB.map((t) => t.name);
  const emptyColumns: string[] = [];
  for (const match of report.matchedTables) {
    for (const col of match.columnsOnlyInB) {
      emptyColumns.push(`${match.left.name}.${col.name}`);
    }
  }
  // What the forward migration CREATED, and the rollback therefore drops. Named
  // by the post-migration name (match.left) because that is what the target is
  // called by the time this script runs.
  const droppedTables = report.tablesOnlyInA.map((t) => t.name);
  const droppedColumns: string[] = [];
  for (const match of report.matchedTables) {
    for (const col of match.columnsOnlyInA) {
      droppedColumns.push(`${match.left.name}.${col.name}`);
    }
  }
  const droppedObjects = createdObjectLabels(report);
  const dropsCreated = {
    tables: droppedTables,
    columns: droppedColumns,
    objects: droppedObjects,
  };

  const restoredCount = emptyTables.length + emptyColumns.length;
  // Only tables and columns count against losslessness. Dropping a view or an
  // index the migration created restores the target exactly; dropping a table
  // or a column it created destroys whatever was written into it since.
  const destroyedCount = droppedTables.length + droppedColumns.length;
  // A migration made purely of ALTER COLUMN TYPE drops nothing and creates
  // nothing, so both counts above are zero and the header used to promise the
  // target came back exactly as it was. It does not: the down script restores
  // the type, never the values a truncating cast already threw away.
  const truncatingTypeChanges = truncatingTypeChangeLabels(report);
  const lossless =
    restoredCount === 0 &&
    destroyedCount === 0 &&
    truncatingTypeChanges.length === 0;

  const warnings: string[] = [];
  if (restoredCount > 0 && forwardAllowedDataLoss) {
    warnings.push(
      `The rollback recreates ${restoredCount} dropped object${restoredCount === 1 ? "" : "s"} ` +
        `but cannot restore the rows they held.`,
    );
  }
  if (restoredCount > 0 && !forwardAllowedDataLoss) {
    warnings.push(
      `The migration ran in safe mode, so nothing was dropped and the ` +
        `${restoredCount} restoring statement${restoredCount === 1 ? "" : "s"} ` +
        `will do nothing.`,
    );
  }
  if (destroyedCount > 0) {
    const parts: string[] = [];
    if (droppedTables.length > 0) {
      parts.push(`${droppedTables.length} table${droppedTables.length === 1 ? "" : "s"}`);
    }
    if (droppedColumns.length > 0) {
      parts.push(`${droppedColumns.length} column${droppedColumns.length === 1 ? "" : "s"}`);
    }
    warnings.push(
      `The rollback drops ${parts.join(" and ")} the migration created. Rows ` +
        `written into ${destroyedCount === 1 ? "it" : "them"} since are lost.`,
    );
  }
  if (truncatingTypeChanges.length > 0) {
    const n = truncatingTypeChanges.length;
    warnings.push(
      `The rollback puts back the original type of ${n} column${n === 1 ? "" : "s"} ` +
        `but not the values: the forward migration's cast could not be undone. ` +
        `Restore ${n === 1 ? "it" : "them"} from a backup if the old values matter.`,
    );
  }

  const unconfirmed = reverseReport.possibleTableMatches.length;
  if (unconfirmed > 0) {
    warnings.push(
      `The reverse comparison could not confirm ${unconfirmed} table ` +
        `rename${unconfirmed === 1 ? "" : "s"}. Where it was unsure it emitted a ` +
        `CREATE plus a DROP instead of a RENAME, so the rollback recreates the ` +
        `table empty rather than renaming it back. Read those statements before running.`,
    );
  }

  return {
    statements: inverse.statements,
    warnings,
    targetSchema: `${report.right.database}.${report.right.schema}`,
    sourceSchema: `${report.left.database}.${report.left.schema}`,
    emptyOnRestore: { tables: emptyTables, columns: emptyColumns },
    dropsCreated,
    truncatingTypeChanges,
    lossless,
    forwardAllowedDataLoss,
  };
}

// Wrap a comma-joined list so a header comment line stays readable.
function commentList(items: string[], indent: string): string[] {
  const lines: string[] = [];
  let current = "";
  for (const item of items) {
    const next = current ? `${current}, ${item}` : item;
    if (next.length > 64 && current) {
      lines.push(`${indent}${current}`);
      current = item;
    } else {
      current = next;
    }
  }
  if (current) lines.push(`${indent}${current}`);
  return lines;
}

/**
 * Render a rollback as plain SQL.
 *
 * Nothing here is ever commented out. A rollback whose statements do not run is
 * not a rollback, so the honesty lives in the header instead: it says what the
 * script restores, what it cannot restore, and what it destroys.
 */
export function renderRollbackScript(script: RollbackScript): string {
  const breaking = script.statements.filter((s) => s.severity === "breaking").length;
  const safe = script.statements.filter((s) => s.severity === "safe").length;
  const info = script.statements.filter((s) => s.severity === "info").length;

  const header = [
    `-- ================================================================`,
    `-- ROLLBACK (down script)`,
    `-- Undoes the migration ${script.sourceSchema}  →  ${script.targetSchema}`,
    `-- Runs against: ${script.targetSchema}`,
    `-- Statements: ${script.statements.length}  (${breaking} breaking · ${safe} safe · ${info} info)`,
  ];

  const notes = manualNoteCount(script.statements);
  if (notes > 0) {
    header.push(
      `-- ${notes} of ${notes === 1 ? "those is a MANUAL note" : "those are MANUAL notes"}: ` +
        `${notes === 1 ? "it describes" : "they describe"} work no statement can do, and ` +
        `${notes === 1 ? "runs" : "run"} nothing.`,
    );
  }
  header.push(`--`);

  if (script.statements.length === 0) {
    header.push(
      `-- The migration changed nothing, so there is nothing to undo.`,
      `-- ================================================================`,
    );
    return header.join("\n");
  }

  if (script.lossless) {
    header.push(
      `-- This rollback is complete. Nothing it recreates comes back empty, and`,
      `-- nothing it removes can hold rows written since the migration ran, so`,
      `-- running it restores the target exactly as it was.`,
    );
  } else {
    header.push(`-- THIS RESTORES STRUCTURE, NOT DATA.`);
  }

  const { tables, columns } = script.emptyOnRestore;
  if (tables.length > 0 || columns.length > 0) {
    if (script.forwardAllowedDataLoss) {
      header.push(`--`, `-- Recreated EMPTY — the rows they held are gone:`);
    } else {
      header.push(
        `--`,
        `-- The migration ran in SAFE MODE, so it dropped none of the following.`,
        `-- These statements are written idempotently and will do nothing unless`,
        `-- the drops were armed or run by hand:`,
      );
    }
    if (tables.length > 0) {
      header.push(`--   tables:`, ...commentList(tables, "--     "));
    }
    if (columns.length > 0) {
      header.push(`--   columns:`, ...commentList(columns, "--     "));
    }
  }

  const created = script.dropsCreated;
  if (created.tables.length > 0 || created.columns.length > 0) {
    header.push(
      `--`,
      `-- DROPPED — created by the migration, so any row written into them since`,
      `-- the migration ran is lost:`,
    );
    if (created.tables.length > 0) {
      header.push(`--   tables:`, ...commentList(created.tables, "--     "));
    }
    if (created.columns.length > 0) {
      header.push(`--   columns:`, ...commentList(created.columns, "--     "));
    }
  }

  if (script.truncatingTypeChanges.length > 0) {
    header.push(
      `--`,
      `-- TYPE RESTORED, VALUES NOT. The migration's cast on these columns could`,
      `-- not be undone — the down script gives each column its old type back,`,
      `-- holding whatever the cast left behind:`,
      ...script.truncatingTypeChanges.map((label) => `--     ${label}`),
    );
  }

  if (created.objects.length > 0) {
    header.push(
      `--`,
      `-- Also dropped — created by the migration and holding no rows of their`,
      `-- own, so removing them puts the target back as it was:`,
      ...commentList(created.objects, "--     "),
    );
  }

  header.push(
    `--`,
    `-- Run this only if the migration was applied in full. Applying it to a`,
    `-- target the migration never touched will fail or do nothing.`,
    `-- ================================================================`,
  );

  const body = script.statements
    .map((stmt) => `-- [${stmt.severity.toUpperCase()}] ${stmt.description}\n${stmt.sql}`)
    .join("\n\n");

  return `${header.join("\n")}\n\n${body}`;
}
