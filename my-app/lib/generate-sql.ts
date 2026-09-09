import type {
  ChangeSeverity,
  CompareReport,
  ConstraintDiff,
  TableMatch,
} from "./compare-types";
import type {
  ColumnSnapshot,
  ConstraintSnapshot,
  ForeignKeySnapshot,
  IndexSnapshot,
  RoutineSnapshot,
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
  constraintChangeSeverity,
  extractBaseType,
  generatedChangeSeverity,
  isNarrowingType,
  nullabilityChangeSeverity,
  typeChangeSeverity,
} from "./compare";
import { normalizeSimilarityText } from "./compare-utils";

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
  | "CREATE_VIEW"
  | "DROP_VIEW"
  | "CREATE_SEQUENCE"
  | "DROP_SEQUENCE"
  | "ALTER_SEQUENCE"
  | "CREATE_TYPE"
  | "DROP_TYPE"
  | "ALTER_TYPE"
  | "CREATE_ROUTINE"
  | "DROP_ROUTINE"
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
function buildColumnDef(col: ColumnSnapshot): string {
  // An IDENTITY column in the source stays an IDENTITY column.
  if (col.identity) {
    const notNull = col.nullable ? "" : " NOT NULL";
    return `${q(col.name)} ${col.typeDisplay} GENERATED ${col.identity} AS IDENTITY${notNull}`;
  }

  // A serial column stays serial. `serial` is shorthand for the integer type
  // plus a sequence named <table>_<column>_seq that the column owns, which is
  // exactly the shape the source has — so this round-trips where a hand-written
  // DEFAULT nextval(...) would fail on a sequence the target does not have.
  const serialType = isNextvalDefault(col.columnDefault)
    ? serialTypeFor(col.typeDisplay)
    : null;
  if (serialType) {
    return `${q(col.name)} ${serialType}${col.nullable ? "" : " NOT NULL"}`;
  }

  let def = `${q(col.name)} ${col.typeDisplay}`;
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

function buildCreateTable(table: TableSnapshot): string {
  const lines: string[] = table.columns.map((col) => `  ${buildColumnDef(col)}`);

  for (const { constraint } of nonFkConstraints(table)) {
    lines.push(`  CONSTRAINT ${q(constraint.name)} ${constraint.definition}`);
  }

  return (
    `CREATE TABLE IF NOT EXISTS ${q(table.name)} (\n` +
    lines.join(",\n") +
    `\n);`
  );
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
}): SqlStatement {
  return {
    sql: fields.sql,
    description: fields.description,
    kind: fields.kind,
    severity: fields.severity ?? "info",
    tableName: fields.tableName,
    destructive: fields.destructive === true,
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

function createIndexStatement(
  index: IndexSnapshot,
  tableName: string,
  idempotent: boolean
): SqlStatement {
  return objectStatement({
    sql: indexCreateSql(index, idempotent),
    description: `Create index "${index.name}" on "${tableName}"`,
    kind: "CREATE_INDEX",
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
function createTriggerStatements(trigger: TriggerSnapshot, tableName: string): SqlStatement[] {
  const stmts: SqlStatement[] = [
    objectStatement({
      sql: `DROP TRIGGER IF EXISTS ${q(trigger.name)} ON ${q(tableName)};`,
      description: `Replace trigger "${trigger.name}" on "${tableName}"`,
      kind: "DROP_TRIGGER",
      tableName,
    }),
    objectStatement({
      sql: `${trigger.definition.trim()};`,
      description: `Create trigger "${trigger.name}" on "${tableName}"`,
      kind: "CREATE_TRIGGER",
      tableName,
    }),
  ];
  // A trigger is created enabled. Recreating a disabled one without this would
  // silently turn its behaviour back on in the target.
  if (!trigger.enabled) {
    stmts.push(
      objectStatement({
        sql: `ALTER TABLE ${q(tableName)} DISABLE TRIGGER ${q(trigger.name)};`,
        description: `Disable trigger "${trigger.name}" on "${tableName}" (it is disabled in the source)`,
        kind: "CREATE_TRIGGER",
        tableName,
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

// ── Views ──────────────────────────────────────────────────────────────────

function createViewStatement(view: ViewSnapshot): SqlStatement {
  // pg_get_viewdef already ends in a semicolon and starts with whitespace.
  const body = view.definition.trim();
  // Both forms are no-ops when the view is already there and already correct.
  // That matters because this same statement is used to put back a view a
  // CASCADE *may* have taken: if it survived, running this changes nothing.
  const sql = view.materialized
    ? `CREATE MATERIALIZED VIEW IF NOT EXISTS ${q(view.name)} AS\n${body}`
    : `CREATE OR REPLACE VIEW ${q(view.name)} AS\n${body}`;
  return objectStatement({
    sql: sql.endsWith(";") ? sql : `${sql};`,
    description: `Create ${view.materialized ? "materialized view" : "view"} "${view.name}"`,
    kind: "CREATE_VIEW",
    tableName: view.name,
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

// Only STANDALONE sequences reach here: the comparator drops the ones owned by
// a serial or identity column, because those are created by the column itself
// and a CREATE SEQUENCE for them would collide.
function sequenceClauses(sequence: SequenceSnapshot): string[] {
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

// ── Types: enums, domains, composites, ranges ──────────────────────────────

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
  // A range type needs its subtype's operator class, collation and canonical
  // function to round-trip, and the snapshot records only the subtype. Guessing
  // the rest would produce a type that looks right and sorts wrong.
  return null;
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
    // Same labels, different order. Postgres compares enum values by their
    // stored order, so this changes how the data sorts.
    if (added.length === 0 && removed.length === 0) {
      stmts.push(
        manualNote(
          `enum "${left.name}" has the same values in a different order. Postgres sorts by ` +
            `that order, so this changes comparison results. Reordering needs the type to be ` +
            `recreated.`,
          `Enum "${left.name}" values are in a different order`,
          left.name
        )
      );
    }
    return stmts;
  }

  // A domain can be altered in place as long as its base type is unchanged:
  // NOT NULL is a direct ALTER, and checks are dropped and added by name. The
  // base type is the one thing ALTER DOMAIN cannot change, so that still falls
  // through to the manual note below.
  if (left.kind === "DOMAIN" && left.baseType === right.baseType) {
    if (left.notNull !== right.notNull) {
      stmts.push(
        objectStatement({
          sql: left.notNull
            ? `ALTER DOMAIN ${q(left.name)} SET NOT NULL;`
            : `ALTER DOMAIN ${q(left.name)} DROP NOT NULL;`,
          description: left.notNull
            ? `Make domain "${left.name}" NOT NULL — WARNING: fails if any column using it holds a null`
            : `Allow nulls in domain "${left.name}"`,
          kind: "ALTER_TYPE",
          severity: left.notNull ? "breaking" : "safe",
          tableName: left.name,
        })
      );
    }

    // Match checks by name. A check whose name is the same but whose expression
    // changed has to be dropped and re-added: ALTER DOMAIN has no "replace".
    const leftChecks = new Map(left.checks.map((check) => [check.name, check]));
    const rightChecks = new Map(right.checks.map((check) => [check.name, check]));

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

    for (const check of left.checks) {
      const target = rightChecks.get(check.name);
      if (target && target.expression === check.expression) continue;
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

  return [
    manualNote(
      `"${left.name}" differs. Source: ${left.definition}. Target: ${right.definition}. ` +
        `Altering it in place needs the columns that use it handled first.`,
      `"${left.name}" changed and needs manual work`,
      left.name
    ),
  ];
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

function dropRoutineStatement(routine: RoutineSnapshot): SqlStatement {
  return objectStatement({
    sql:
      `DROP ${routine.kind} IF EXISTS ${q(routine.name)}` +
      `(${routine.identityArguments});`,
    description: `Drop ${routine.kind.toLowerCase()} "${routine.signature}" — WARNING: anything calling it breaks`,
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
  /** Types and standalone sequences — before CREATE TABLE. */
  beforeTables: SqlStatement[];
  /** Functions and procedures — after tables exist, before triggers need them. */
  routines: SqlStatement[];
  /** Indexes — after every ADD COLUMN has run. */
  indexes: SqlStatement[];
  /** Triggers — after their functions and after the columns they read. */
  triggers: SqlStatement[];
  /** Views — after foreign keys, so every table is complete. */
  views: SqlStatement[];
  /** View drops — before DROP TABLE, so CASCADE has less to reach. */
  viewDrops: SqlStatement[];
  /** Routine, type and sequence drops — after the tables that used them are gone. */
  afterTables: SqlStatement[];
  warnings: string[];
};

function findByName<T extends { name: string }>(items: T[] | undefined, name: string): T | null {
  return items?.find((item) => item.name === name) ?? null;
}

/**
 * Build every object statement the migration needs, in dependency order.
 *
 * Reads the object differences the comparator produced, plus the objects that
 * hang off tables being created outright — a brand-new table has no match, so
 * its indexes and triggers appear in no diff and would otherwise be dropped on
 * the floor exactly the way its foreign keys once were.
 */
function objectPhases(report: CompareReport, idempotent: boolean): ObjectPhases {
  const phases: ObjectPhases = {
    beforeTables: [],
    routines: [],
    indexes: [],
    triggers: [],
    views: [],
    viewDrops: [],
    afterTables: [],
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
  }

  // ── Schema-scoped objects ─────────────────────────────────────────────────
  const viewsToCreate: ViewSnapshot[] = [];
  /** Views the script drops by name, so a CASCADE taking them is no surprise. */
  const viewsBeingDropped = new Set<string>();

  for (const diff of report.objectDiffs) {
    if (diff.kind === "VIEW" || diff.kind === "MATERIALIZED VIEW") {
      if (diff.status !== "onlyA") {
        const target = findByName(rightViews, diff.name);
        // A view whose definition changed is dropped and rebuilt rather than
        // replaced: CREATE OR REPLACE VIEW refuses any change to the column
        // list, which is exactly the kind of change worth migrating.
        if (target) {
          phases.viewDrops.push(
            dropViewStatement(
              target,
              diff.status === "onlyB" ? "" : " so it can be rebuilt from the source"
            )
          );
          viewsBeingDropped.add(target.name);
        }
      }
      if (diff.status !== "onlyB") {
        const source = findByName(leftViews, diff.name);
        if (source) viewsToCreate.push(source);
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

    if (diff.kind === "FUNCTION" || diff.kind === "PROCEDURE") {
      // Routines are keyed by signature, so look them up by that.
      const source = report.left.routines?.find((r) => r.signature === diff.name) ?? null;
      const target = report.right.routines?.find((r) => r.signature === diff.name) ?? null;
      if (diff.status === "onlyB") {
        if (target) phases.afterTables.push(dropRoutineStatement(target));
      } else if (source) {
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
        phases.beforeTables.push(
          manualNote(
            `range type "${sourceType.name}" (${sourceType.definition}) has to be created by ` +
              `hand — a range needs its subtype's operator class and canonical function, and ` +
              `the snapshot records only the subtype.`,
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
    phases.views.push(createViewStatement(view));
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
  sourceSequences: SequenceSnapshot[] | undefined
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
    const risky = !col.nullable && col.columnDefault === null;
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
  }

  // ── c. Type, nullability and default changes on matched columns ──────────
  for (const colMatch of match.columnMatches) {
    // After the rename step above, this column is now called colMatch.left.name in B.
    const colName = colMatch.left.name;
    const leftNorm = normalizeType(colMatch.left.typeDisplay);
    const rightNorm = normalizeType(colMatch.right.typeDisplay);

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

      stmts.push({
        sql: `ALTER TABLE ${q(tName)} ALTER COLUMN ${q(colName)} TYPE ${colMatch.left.typeDisplay}${usingSuffix};`,
        description,
        kind: "ALTER_COLUMN_TYPE",
        severity,
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
            `ADD GENERATED ${leftIdentity} AS IDENTITY;`,
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
  const objects = objectPhases(report, options.addColumnIfNotExists === true);
  const rightViews = report.right.views ?? [];

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

  for (const table of report.tablesOnlyInA) {
    statements.push({
      sql: buildCreateTable(table),
      description: `Create table "${table.name}"`,
      kind: "CREATE_TABLE",
      severity: "info",
      tableName: table.name,
      destructive: false,
    });

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
    );
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

  // ── Create views ──────────────────────────────────────────────────────────
  // Last of the additive work. Every table a view reads is now in its final
  // shape, and every table that was going to be dropped is already gone, so
  // nothing here can be cascaded away by a later statement.
  statements.push(...objects.views);

  // ── Routines, types and sequences that are no longer used ─────────────────
  // Last of all: a type cannot be dropped while a column still has it, and that
  // column only went away with the table drops above.
  statements.push(...objects.afterTables);

  warnings.push(...objects.warnings);

  const destructiveCount = statements.filter((s) => s.destructive).length;
  if (destructiveCount > 0 && !allowDataLoss) {
    warnings.push(
      `${destructiveCount} destructive statement${destructiveCount === 1 ? " is" : "s are"} ` +
        `commented out. Enable "allow data loss" to include ${destructiveCount === 1 ? "it" : "them"}.`,
    );
  }

  return {
    statements,
    warnings,
    sourceSchema: `${report.left.database}.${report.left.schema}`,
    targetSchema: `${report.right.database}.${report.right.schema}`,
    allowDataLoss,
    destructiveCount,
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
// When script.allowDataLoss is false, statements flagged destructive are
// rendered commented out. This is the single point where a generated script
// becomes able to destroy data, so the decision is made here and nowhere else.
export function renderMigrationScript(script: MigrationScript): string {
  const breaking = script.statements.filter((s) => s.severity === "breaking").length;
  const safe = script.statements.filter((s) => s.severity === "safe").length;
  const info = script.statements.filter((s) => s.severity === "info").length;
  const held = script.allowDataLoss ? 0 : script.destructiveCount;

  const header = [
    `-- ================================================================`,
    `-- Migration: ${script.sourceSchema}  →  ${script.targetSchema}`,
    `-- Direction: modifies the RIGHT/TARGET schema to match the LEFT/SOURCE schema`,
    `-- Statements: ${script.statements.length}  (${breaking} breaking · ${safe} safe · ${info} info)`,
  ];

  if (held > 0) {
    header.push(
      `--`,
      `-- SAFE MODE IS ON. ${held} destructive statement${held === 1 ? "" : "s"} ` +
        `(DROP TABLE / DROP COLUMN) ${held === 1 ? "is" : "are"} commented out below`,
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
      const muted = stmt.destructive && !script.allowDataLoss;
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
   * Tables the rollback DROPS because the forward migration created them. Any
   * row written into one of these since the migration ran is lost.
   */
  dropsCreated: string[];
  /** True when the rollback restores the target exactly, data included. */
  lossless: boolean;
  /** Whether the forward migration this undoes had its drops armed. */
  forwardAllowedDataLoss: boolean;
};

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
  const dropsCreated = report.tablesOnlyInA.map((t) => t.name);

  const restoredCount = emptyTables.length + emptyColumns.length;
  const lossless = restoredCount === 0 && dropsCreated.length === 0;

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
  if (dropsCreated.length > 0) {
    warnings.push(
      `The rollback drops ${dropsCreated.length} table${dropsCreated.length === 1 ? "" : "s"} ` +
        `the migration created. Rows written into ${dropsCreated.length === 1 ? "it" : "them"} since are lost.`,
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
    `--`,
  ];

  if (script.statements.length === 0) {
    header.push(
      `-- The migration changed nothing, so there is nothing to undo.`,
      `-- ================================================================`,
    );
    return header.join("\n");
  }

  if (script.lossless) {
    header.push(
      `-- This rollback is complete. The migration dropped nothing and created`,
      `-- nothing, so running this restores the target exactly as it was.`,
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

  if (script.dropsCreated.length > 0) {
    header.push(
      `--`,
      `-- DROPPED — created by the migration, so any row written into them since`,
      `-- the migration ran is lost:`,
      ...commentList(script.dropsCreated, "--     "),
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
