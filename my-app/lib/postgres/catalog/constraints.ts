/**
 * Constraints (primary key, unique, foreign key, check, exclude): the catalog
 * query, and the step that files each one under its table and marks the
 * columns it covers.
 */
import type { PoolClient } from "pg";
import { COMPARE_IGNORED_TABLES, coerceTextArray } from "../helpers";
import { normalizeDefinition, stripSchemaFromExpr } from "../normalize";
import type { ConstraintSnapshot, ForeignKeySnapshot, TableSnapshot } from "../types";

export type ConstraintRow = {
  table_name: string;
  constraint_name: string;
  contype: "p" | "u" | "f" | "c" | "x";
  definition: string;
  columns: string[] | null;
  referenced_schema: string | null;
  referenced_table: string | null;
  referenced_columns: string[] | null;
  confupdtype: string | null;
  confdeltype: string | null;
  confmatchtype: string | null;
  condeferrable: boolean | null;
  condeferred: boolean | null;
  convalidated: boolean | null;
};

function formatAction(code: string | null): string {
  switch (code) {
    case "a":
      return "NO ACTION";
    case "r":
      return "RESTRICT";
    case "c":
      return "CASCADE";
    case "n":
      return "SET NULL";
    case "d":
      return "SET DEFAULT";
    default:
      return "UNKNOWN";
  }
}

/**
 * pg_constraint.confmatchtype as SQL writes it. Anything unrecognised falls
 * back to SIMPLE, which is what the parser assumes when no MATCH is written,
 * so an unknown code produces a key Postgres accepts rather than a syntax
 * error.
 */
function formatMatchType(code: string | null): "SIMPLE" | "FULL" | "PARTIAL" {
  if (code === "f") return "FULL";
  if (code === "p") return "PARTIAL";
  return "SIMPLE";
}

export async function readConstraints(client: PoolClient, schemaName: string): Promise<ConstraintRow[]> {
  // conparentid = 0 and conislocal skip the constraints a parent owns: a
  // primary key on a partitioned table is cloned onto every partition, and an
  // INHERITS child inherits its parent's CHECKs. Recording those made the
  // report show one constraint several times over, and the generated script
  // tried to add a constraint PostgreSQL creates by itself.
  const result = await client.query<ConstraintRow>(
        `SELECT
           tbl.relname AS table_name,
           con.conname AS constraint_name,
           con.contype,
           pg_get_constraintdef(con.oid, true) AS definition,
           COALESCE(
             array_agg(att.attname ORDER BY key_cols.ordinality)
             FILTER (WHERE att.attname IS NOT NULL),
             ARRAY[]::text[]
           ) AS columns,
           ref_ns.nspname AS referenced_schema,
           ref_tbl.relname AS referenced_table,
           COALESCE(
             array_agg(ref_att.attname ORDER BY ref_cols.ordinality)
             FILTER (WHERE ref_att.attname IS NOT NULL),
             ARRAY[]::text[]
           ) AS referenced_columns,
           con.confupdtype,
           con.confdeltype,
           con.confmatchtype,
           con.condeferrable,
           con.condeferred,
           con.convalidated
         FROM pg_constraint con
         JOIN pg_class tbl
           ON tbl.oid = con.conrelid
         JOIN pg_namespace ns
           ON ns.oid = tbl.relnamespace
         LEFT JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS key_cols(attnum, ordinality)
           ON true
         LEFT JOIN pg_attribute att
           ON att.attrelid = tbl.oid
          AND att.attnum = key_cols.attnum
         LEFT JOIN pg_class ref_tbl
           ON ref_tbl.oid = con.confrelid
         LEFT JOIN pg_namespace ref_ns
           ON ref_ns.oid = ref_tbl.relnamespace
         LEFT JOIN LATERAL unnest(con.confkey) WITH ORDINALITY AS ref_cols(attnum, ordinality)
           ON ref_cols.ordinality = key_cols.ordinality
         LEFT JOIN pg_attribute ref_att
           ON ref_att.attrelid = ref_tbl.oid
          AND ref_att.attnum = ref_cols.attnum
         WHERE ns.nspname = $1
           AND con.contype IN ('p', 'u', 'f', 'c', 'x')
           AND con.conparentid = 0
           AND con.conislocal
           AND tbl.relname <> ALL($2)
         GROUP BY
           tbl.relname,
           con.conname,
           con.contype,
           con.oid,
           ref_ns.nspname,
           ref_tbl.relname,
           con.confupdtype,
           con.confdeltype,
           con.confmatchtype,
           con.condeferrable,
           con.condeferred,
           con.convalidated
         ORDER BY tbl.relname, con.contype, con.conname`,
      [schemaName, COMPARE_IGNORED_TABLES]
  );
  return result.rows;
}

/** Files each constraint under its table. Needs the columns to be there already. */
export function addConstraints(
  tablesByName: Map<string, TableSnapshot>,
  rows: ConstraintRow[],
  schemaName: string
): void {
  for (const row of rows) {
    const table = tablesByName.get(row.table_name);
    if (!table) {
      continue;
    }

    const columns = coerceTextArray(row.columns);
    // pg_get_constraintdef schema-qualifies user types/functions and the FK's
    // referenced table. Strip the own-schema qualifier so a CHECK/EXCLUDE/FK is
    // compared and EMITTED schema-relative (else it falsely differs across two
    // schemas and pins the constraint to the source schema on apply/replay).
    const definition = stripSchemaFromExpr(row.definition, schemaName) ?? row.definition;
    const normalizedDefinition = normalizeDefinition(definition);

    if (row.contype === "p") {
      table.primaryKey = {
        name: row.constraint_name,
        kind: "PRIMARY KEY",
        columns,
        definition,
        normalizedDefinition,
      };

      for (const name of columns) {
        const column = table.columns.find((entry) => entry.name === name);
        if (column) {
          column.isPrimaryKey = true;
        }
      }
      continue;
    }

    if (row.contype === "u") {
      table.uniqueConstraints.push({
        name: row.constraint_name,
        kind: "UNIQUE",
        columns,
        definition,
        normalizedDefinition,
      });

      for (const name of columns) {
        const column = table.columns.find((entry) => entry.name === name);
        if (column) {
          column.uniqueConstraintNames.push(row.constraint_name);
        }
      }
      continue;
    }

    if (row.contype === "f") {
      const foreignKey: ForeignKeySnapshot = {
        name: row.constraint_name,
        kind: "FOREIGN KEY",
        columns,
        definition,
        normalizedDefinition,
        referencedSchema: row.referenced_schema,
        referencedTable: row.referenced_table,
        referencedColumns: coerceTextArray(row.referenced_columns),
        onUpdate: formatAction(row.confupdtype),
        onDelete: formatAction(row.confdeltype),
        matchType: formatMatchType(row.confmatchtype),
        deferrable: row.condeferrable === true,
        initiallyDeferred: row.condeferred === true,
        validated: row.convalidated !== false,
      };
      table.foreignKeys.push(foreignKey);

      for (const name of columns) {
        const column = table.columns.find((entry) => entry.name === name);
        if (column) {
          column.foreignKeyConstraintNames.push(row.constraint_name);
        }
      }
      continue;
    }

    const constraint: ConstraintSnapshot = {
      name: row.constraint_name,
      kind: row.contype === "c" ? "CHECK" : "EXCLUDE",
      columns,
      definition,
      normalizedDefinition,
    };

    if (row.contype === "c") {
      table.checkConstraints.push(constraint);
    } else {
      table.excludeConstraints.push(constraint);
    }
  }
}
