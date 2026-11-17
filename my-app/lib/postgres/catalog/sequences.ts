/**
 * Sequences: the catalog query, the step that builds the SequenceSnapshot
 * list, and the step that hands an owned sequence's settings to its column.
 */
import type { PoolClient } from "pg";
import { COMPARE_IGNORED_TABLES } from "../helpers";
import { stripSchemaFromExpr } from "../normalize";
import { sequenceOwnerTable } from "../snapshot-facts";
import type { SequenceSnapshot, TableSnapshot } from "../types";

export type SequenceRow = {
  name: string;
  start_value: string;
  increment: string;
  min_value: string;
  max_value: string;
  cycles: boolean;
  cache_size: string;
  data_type: string;
  owned_by_table: string | null;
  owned_by_column: string | null;
};

/**
 * The sequence a `nextval('name'::regclass)` default reads, or null when the
 * default is not one. Defaults are already schema-stripped, and PostgreSQL
 * quotes the name only when it needs quotes, so either form is read.
 */
function sequenceReadByDefault(columnDefault: string | null): string | null {
  const match = /^\s*nextval\s*\(\s*'([^']+)'/i.exec(columnDefault ?? "");
  if (!match) return null;
  return match[1].replace(/^"(.*)"$/, "$1").replace(/""/g, '"');
}

export async function readSequences(client: PoolClient, schemaName: string): Promise<SequenceRow[]> {
  // deptype 'a' (auto) is a serial column's sequence, 'i' (internal) is an
  // IDENTITY column's. Both mean "this sequence is created by its column, do
  // not emit a CREATE SEQUENCE for it".
  const result = await client.query<SequenceRow>(
      `SELECT
         c.relname AS name,
         s.seqstart::text AS start_value,
         s.seqincrement::text AS increment,
         s.seqmin::text AS min_value,
         s.seqmax::text AS max_value,
         s.seqcycle AS cycles,
         s.seqcache::text AS cache_size,
         format_type(s.seqtypid, NULL) AS data_type,
         d.refobjid::regclass::text AS owned_by_table,
         (SELECT a.attname
            FROM pg_attribute a
           WHERE a.attrelid = d.refobjid
             AND a.attnum = d.refobjsubid) AS owned_by_column
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_sequence s ON s.seqrelid = c.oid
       LEFT JOIN pg_depend d
         ON d.objid = c.oid
        AND d.classid = 'pg_class'::regclass
        AND d.deptype IN ('a', 'i')
       WHERE n.nspname = $1
         -- A ledger table is hidden from the comparison, so the sequence its
         -- SERIAL id column owns has to be hidden with it. Otherwise the table
         -- disappears and script_patch_id_seq is still reported as a new
         -- object — the same false difference, one level down.
         AND NOT EXISTS (
           SELECT 1 FROM pg_depend owned
            JOIN pg_class owner ON owner.oid = owned.refobjid
           WHERE owned.objid = c.oid
             AND owned.classid = 'pg_class'::regclass
             AND owned.deptype IN ('a', 'i')
             AND owner.relname = ANY($2)
         )
       ORDER BY c.relname`,
      [schemaName, COMPARE_IGNORED_TABLES]
  );
  return result.rows;
}

/** One SequenceSnapshot per sequence, owned or free. */
export function buildSequences(rows: SequenceRow[], schemaName: string): SequenceSnapshot[] {
  return rows.map((row) => ({
    name: row.name,
    dataType: row.data_type,
    startValue: row.start_value,
    increment: row.increment,
    minValue: row.min_value,
    maxValue: row.max_value,
    cycles: row.cycles,
    cacheSize: row.cache_size,
    // regclass renders as "schema.table" because nothing is on the search_path.
    ownedByTable: stripSchemaFromExpr(row.owned_by_table, schemaName),
    ownedByColumn: row.owned_by_column,
  }));
}

export function attachSequenceOptions(
  sequences: SequenceSnapshot[],
  tablesByName: Map<string, TableSnapshot>,
  schemaName: string
): void {
  // Hand each owned sequence's settings to the column that owns it.
  //
  // Done here rather than in the column step (catalog/tables.ts) because the
  // sequences are only built now. A column owns at most one sequence, so
  // there is nothing to merge — the last writer would be the only writer
  // either way.
  for (const sequence of sequences) {
    // The owner comes back quoted when its name needs quotes ("AuditLog"),
    // while tablesByName holds bare names, so read it as a name first.
    const ownerName = sequenceOwnerTable(sequence, schemaName);
    if (ownerName === null || sequence.ownedByColumn === null) {
      continue;
    }
    const owner = tablesByName.get(ownerName);
    const column = owner?.columns.find((c) => c.name === sequence.ownedByColumn);
    if (!column) continue;
    // A column can own one sequence while its default reads another: a serial
    // whose default was later pointed at a different sequence. The owned one
    // is then not the column's counter. Treated as one, the column counted
    // as a serial, the comparison hid which sequence its default names, and
    // the script built the wrong sequence. So it is listed as a sequence of
    // its own and the column keeps an ordinary default.
    const read = sequenceReadByDefault(column.columnDefault);
    if (read !== null && read !== sequence.name) {
      sequence.ownedByTable = null;
      sequence.ownedByColumn = null;
      continue;
    }
    column.sequenceOptions = {
      dataType: sequence.dataType,
      startValue: sequence.startValue,
      increment: sequence.increment,
      minValue: sequence.minValue,
      maxValue: sequence.maxValue,
      cycles: sequence.cycles,
      cacheSize: sequence.cacheSize,
    };
  }
}
