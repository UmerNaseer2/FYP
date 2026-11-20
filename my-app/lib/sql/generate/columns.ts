// Column definitions: serial shorthand, the plan for which sequences a new
// column owns, the text of one column inside CREATE TABLE or ADD COLUMN, and
// the statement that puts NOT NULL back.

import type { ColumnSnapshot, SchemaSnapshot } from "../../postgres";
import { extractBaseType } from "../../compare/diff";
import { sequenceOwnerTable } from "../../postgres/snapshot-facts";
import { q } from "./basics";
import { identityOptionsSuffix, nextvalSequenceName, sequenceOptionsAreDefault } from "./sequences";
import { dollarTagFor, literal } from "./statement-helpers";
import type { SqlStatement } from "./types";

export function isNextvalDefault(defaultValue: string | null): boolean {
  return defaultValue !== null && /^\s*nextval\s*\(/i.test(defaultValue);
}

/** The `serial` spelling for each integer width, or null for other types. */
export function serialTypeFor(typeDisplay: string): string | null {
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
export function collateSuffix(col: ColumnSnapshot): string {
  return col.collation ? ` COLLATE ${col.collation}` : "";
}

/**
 * What the generator has worked out about the source's sequences, once, so that
 * every place a column with a `nextval(...)` default is written asks the same
 * question and gets the same answer.
 */
export type SequencePlan = {
  /** For each table, the columns the `serial` shorthand describes truthfully. */
  shorthand: Map<string, Set<string>>;
  /**
   * Sequences that belong to no column at all. The object phase creates those
   * ahead of every table, so a column reading one has nothing to build.
   */
  standalone: Set<string>;
  /**
   * Identity columns whose sequence the source calls something other than
   * "<table>_<column>_seq", by table and then column. A table renamed after it
   * was made keeps its first sequence name, and the script gives the column the
   * same one. freeReusedNames takes a name back out while the target still has
   * something else under it.
   */
  identityNames: Map<string, Map<string, string>>;
};

/** An empty plan: nothing is a serial, nothing is standalone. */
export function emptySequencePlan(): SequencePlan {
  return { shorthand: new Map(), standalone: new Set(), identityNames: new Map() };
}

export function usesSerialShorthand(
  plan: SequencePlan,
  tableName: string,
  columnName: string
): boolean {
  return plan.shorthand.get(tableName)?.has(columnName) ?? false;
}

/** The name an identity column's sequence has in the source, when it is not the usual one. */
export function identitySequenceName(
  plan: SequencePlan,
  tableName: string,
  columnName: string
): string | undefined {
  return plan.identityNames.get(tableName)?.get(columnName);
}

/**
 * Work out which columns may be written as `serial`.
 *
 * `serial` is not a type. It is an instruction to CREATE a sequence called
 * <table>_<column>_seq and hand it to this one column — so writing it is only
 * honest when the source's sequence really is that sequence. Three shapes look
 * identical from the column alone and are not, and each of them fails quietly:
 *
 *   • SHARED — two columns drawing from one sequence. `serial` gives each of
 *     them a private sequence, so the single pool of numbers they were sharing
 *     silently becomes two pools handing out the same numbers.
 *   • STANDALONE — a sequence belonging to no column, created by the object
 *     phase before the tables. `serial` then finds the name taken and takes
 *     "<name>1" instead, without an error, and the column ends up reading a
 *     sequence the source has never heard of. (Verified on PostgreSQL 18.)
 *   • RENAMED — a table or column renamed after creation keeps the sequence it
 *     had. `serial` cannot produce that name, so it builds a second sequence and
 *     every later comparison reports a default that no migration can settle.
 *
 * Everything the shorthand does not cover is written out in full instead: the
 * plain type with its own DEFAULT nextval(...), and the sequence built beside it
 * — see columnSequenceStatements.
 */
export function sequencePlanFor(source: SchemaSnapshot): SequencePlan {
  const plan = emptySequencePlan();

  // How many columns in the whole schema read each sequence. Counted across all
  // tables because sharing is not a within-one-table affair.
  const readers = new Map<string, number>();
  for (const table of source.tables) {
    for (const col of table.columns) {
      const name = nextvalSequenceName(col.columnDefault);
      if (name !== null) readers.set(name, (readers.get(name) ?? 0) + 1);
    }
  }

  const sequences = source.sequences;
  for (const sequence of sequences ?? []) {
    if (sequence.ownedByTable === null) plan.standalone.add(sequence.name);
  }

  for (const table of source.tables) {
    for (const col of table.columns) {
      // An identity column carries its own sequence in its own syntax.
      if (col.identity) continue;
      if (serialTypeFor(col.typeDisplay) === null) continue;
      const name = nextvalSequenceName(col.columnDefault);
      if (name === null) continue;
      // The shorthand has no room for START WITH or INCREMENT BY.
      if (col.sequenceOptions && !sequenceOptionsAreDefault(col.sequenceOptions)) continue;
      // The RENAMED case: this is the only name `serial` knows how to make.
      if (name !== `${table.name}_${col.name}_seq`) continue;
      // The SHARED case.
      if ((readers.get(name) ?? 0) > 1) continue;
      if (sequences) {
        // The catalog's own answer, which also settles the STANDALONE case: the
        // sequence has to exist in this schema and belong to this very column.
        const record = sequences.find((entry) => entry.name === name);
        if (!record) continue;
        // Read as a name: a quoted owner ("AuditLog") is the same table.
        if (sequenceOwnerTable(record, source.schema) !== table.name) continue;
        if (record.ownedByColumn !== col.name) continue;
      }
      const columns = plan.shorthand.get(table.name);
      if (columns) columns.add(col.name);
      else plan.shorthand.set(table.name, new Set([col.name]));
    }
  }
  // An identity column calls its sequence "<table>_<column>_seq" unless told
  // otherwise, so any other name has to be written out.
  for (const table of source.tables) {
    for (const col of table.columns) {
      if (!col.identity) continue;
      const record = (sequences ?? []).find(
        (entry) => sequenceOwnerTable(entry, source.schema) === table.name && entry.ownedByColumn === col.name
      );
      if (!record || record.name === `${table.name}_${col.name}_seq`) continue;
      const names = plan.identityNames.get(table.name) ?? new Map<string, string>();
      names.set(col.name, record.name);
      plan.identityNames.set(table.name, names);
    }
  }
  return plan;
}

export function buildColumnDef(
  col: ColumnSnapshot,
  omitNotNull = false,
  // Whether the `serial` shorthand is the truth for this column — see
  // sequencePlanFor. The default is the honest answer for a caller that has not
  // worked it out: write the column in full and let its sequence be built.
  serialOk = false,
  // The identity sequence's name, when the source gives it one of its own.
  sequenceName?: string
): string {
  // An IDENTITY column in the source stays an IDENTITY column. Identity is
  // restricted to integer types, which have no collation, so none is written.
  if (col.identity) {
    const notNull = col.nullable || omitNotNull ? "" : " NOT NULL";
    return (
      `${q(col.name)} ${col.typeDisplay} ` +
      `GENERATED ${col.identity} AS IDENTITY${identityOptionsSuffix(col, sequenceName)}${notNull}`
    );
  }

  // A serial column stays serial. `serial` is shorthand for the integer type
  // plus a sequence named <table>_<column>_seq that the column owns, which is
  // exactly the shape the source has — so this round-trips where a hand-written
  // DEFAULT nextval(...) would fail on a sequence the target does not have.
  //
  // Unless the sequence is not this column's own to create — it was tuned, or
  // shared, or standalone, or carries a name serial cannot produce. Such a
  // column falls through to the plain type below and keeps its nextval default,
  // with the sequence built around it by the caller (see sequencePlanFor and
  // columnSequenceStatements).
  const serialType =
    serialOk && isNextvalDefault(col.columnDefault) ? serialTypeFor(col.typeDisplay) : null;
  if (serialType) {
    return `${q(col.name)} ${serialType}${col.nullable || omitNotNull ? "" : " NOT NULL"}`;
  }

  let def = `${q(col.name)} ${col.typeDisplay}${collateSuffix(col)}`;
  // A computed column carries its expression instead of a default, never as
  // well as one — writing DEFAULT (price * qty) is what PostgreSQL refuses with
  // "cannot use column reference in DEFAULT expression".
  if (col.generated) {
    def += ` GENERATED ALWAYS AS (${col.generated.expression}) ${col.generated.storage}`;
    if (!col.nullable && !omitNotNull) def += " NOT NULL";
    return def;
  }
  if (!col.nullable && !omitNotNull) def += " NOT NULL";
  if (col.columnDefault !== null) def += ` DEFAULT ${col.columnDefault}`;
  return def;
}

/**
 * Put NOT NULL back on a column that was just added without it.
 *
 * On an empty table this is the whole restore and it simply runs. On a table
 * with rows there is no value to give the new column, so no statement can put
 * the constraint back — and failing the script over it would mean the column
 * itself never came back either. The DO block takes the outcome that loses
 * least: the column is restored, the constraint is not, and PostgreSQL raises
 * a WARNING with exactly what to run once the rows have been backfilled.
 *
 * It is a WARNING, not a NOTICE, because Deploy and Quick run keep only the
 * warnings a script raises (lib/deploy/run-warnings.ts). As a NOTICE the
 * message reached nobody: the run looked like a full success, and every later
 * compare offered the same NOT NULL change again.
 *
 * The column itself is looked at first. The first run of a script often puts
 * NOT NULL on while the table is still empty, so on a second run it is already
 * there, and testing the rows then would raise a warning saying it is missing
 * when it is not. The same block serves the forward script (a new NOT NULL
 * column with no default) and the rollback, which is why the warning says the
 * column has been "left" without it rather than "restored" without it.
 */
export function restoreNotNullStatement(col: ColumnSnapshot, tableName: string): SqlStatement {
  const setNotNull = `ALTER TABLE ${q(tableName)} ALTER COLUMN ${q(col.name)} SET NOT NULL;`;
  const notice =
    `Column ${q(col.name)} on ${q(tableName)} has been left WITHOUT its NOT NULL: ` +
    `the table already holds rows and the column has no default. ` +
    `Backfill it, then run: ${setNotNull}`;
  // Finds a row when the column already carries NOT NULL. The table goes in as
  // a literal of its quoted name so it resolves through search_path, exactly
  // like the unqualified ALTER TABLE it guards.
  const alreadyNotNull =
    `SELECT 1 FROM pg_attribute WHERE attrelid = to_regclass(${literal(q(tableName))}) ` +
    `AND attname = ${literal(col.name)} AND attnotnull`;

  // RAISE's first argument is a FORMAT string, not a message: every `%`
  // in it wants a parameter after the comma, and a table or column named
  // "done_%" therefore aborted the whole block with "too few parameters
  // specified for RAISE". Passing '%' as the format and the text as the one
  // parameter means the text is printed exactly as written, whatever is in it.
  const raise = `RAISE WARNING '%', ${literal(notice)};`;
  // And the block's own tag has to be one nothing inside it contains. The
  // notice quotes both names back, so a column named `a$$b` closed the block on
  // its own name and left `b" on ...` sitting outside it as broken SQL.
  const tag = dollarTagFor(alreadyNotNull, raise, setNotNull, q(tableName));

  return {
    sql: [
      `DO ${tag}`,
      `BEGIN`,
      `  IF EXISTS (${alreadyNotNull}) THEN`,
      `    NULL;`,
      `  ELSIF EXISTS (SELECT 1 FROM ${q(tableName)} LIMIT 1) THEN`,
      `    ${raise}`,
      `  ELSE`,
      `    ${setNotNull}`,
      `  END IF;`,
      `END`,
      `${tag};`,
    ].join("\n"),
    description:
      `Apply NOT NULL on "${col.name}" in "${tableName}" — skipped when it is already ` +
      `there, and applied only if the table is empty, since there is no value for ` +
      `existing rows`,
    kind: "ALTER_COLUMN_NULLABILITY",
    severity: "breaking",
    tableName,
    destructive: false,
  };
}
