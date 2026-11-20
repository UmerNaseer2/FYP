// Whole-table statements: CREATE TABLE, the order new tables are created in,
// and the text of foreign key and other constraint definitions.

import type { ConstraintDiff } from "../../compare/types";
import type { ForeignKeySnapshot, TableSnapshot } from "../../postgres";
import { stripSchemaFromExpr } from "../../postgres";
import { q } from "./basics";
import { nonFkConstraints } from "./column-changes";
import type { SequencePlan } from "./columns";
import { buildColumnDef, identitySequenceName, usesSerialShorthand } from "./columns";

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
export function buildCreateTable(table: TableSnapshot, plan: SequencePlan): string {
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
    .map((col) => `  ${buildColumnDef(col, false, usesSerialShorthand(plan, table.name, col.name), identitySequenceName(plan, table.name, col.name))}`)
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
export function describeNewTable(table: TableSnapshot): string {
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
export function orderTablesForCreate(tables: TableSnapshot[]): TableSnapshot[] {
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

// Write a foreign key the way PostgreSQL itself describes it.
//
// `fk.definition` is the pg_get_constraintdef text with the own schema already
// taken off. It is used as it stands, because it is the only place that holds
// the whole key: the column list of ON DELETE SET NULL (author_id), PERIOD on a
// temporal key, NOT ENFORCED, and the columns in the key's own order. Building
// the key from the snapshot's separate fields lost those, so the script made a
// different key and the next compare asked for the same change again.
//
// `renamed` is for the one caller whose tables or columns carry new names by
// the time the key goes back. The text still has the old names, so that key is
// built from the fields, which the caller has already renamed. A snapshot with
// no text for the key is built from the fields too.
export function buildFkDef(fk: ForeignKeySnapshot, sourceSchema: string, renamed = false): string {
  const text = (fk.definition ?? "").trim();
  if (!renamed && /^FOREIGN KEY\b/i.test(text)) {
    return stripSchemaFromExpr(text, sourceSchema) ?? text;
  }
  return buildFkDefFromFields(fk, sourceSchema);
}

// The same key put together from the snapshot's separate fields. It cannot
// write a column list after SET NULL or SET DEFAULT, PERIOD or NOT ENFORCED:
// the snapshot has no field for them.
function buildFkDefFromFields(fk: ForeignKeySnapshot, sourceSchema: string): string {
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
export function lookupConstraintDef(
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
