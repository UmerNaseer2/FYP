// Performance advice: the rules that read a schema's structure.
//
// Holds analyzeSchemaPerformance, one long function with a rule per problem
// a snapshot can show. It needs no live database.

import type { SchemaSnapshot } from "../../postgres";
import { createIndexSql, qualifiedName, quoteIdent } from "../sql";
import { type PerfAdvice, sortAdvice } from "./types";
import { baseType, comment, indexDefinitionSql, serialSequence } from "./pg-text";
import {
  broughtBackByReindex,
  indexPrefixes,
  isCoveredBy,
  listInWords,
  relationNames,
} from "./table-facts";
import { primaryKeyFix } from "./primary-key-fix";
import {
  duplicateFix,
  duplicateGroups,
  keptCopy,
  type PlainIndex,
  usableIndexes,
  widerPlainIndex,
} from "./duplicate-indexes";
import { INTEGER_TYPES, sequenceBelongsTo, serialFix, zonedType } from "./serial-fix";

/**
 * Every schema-structure rule, run over one snapshot.
 *
 * The rules are inline rather than a registry of rule objects: there are a
 * dozen of them, each needs different parts of the table, and a table of
 * predicates would make every one of them harder to read than it is here.
 *
 * `invalidIndexes` names the indexes PostgreSQL has marked invalid, which the
 * snapshot does not record; the route takes them from the statistics pass,
 * and passes none when that pass could not run.
 */
export function analyzeSchemaPerformance(
  snapshot: SchemaSnapshot,
  invalidIndexes: ReadonlySet<string> = new Set()
): PerfAdvice[] {
  const advice: PerfAdvice[] = [];
  const schema = snapshot.schema;
  // Grows as indexes are suggested, so no two suggestions share a name.
  const relations = relationNames(snapshot);

  for (const table of snapshot.tables) {
    const object = table.name;
    const target = qualifiedName(schema, table.name);
    const isPartition = Boolean(table.partitioning?.partitionOf);
    const prefixes = indexPrefixes(table, invalidIndexes);
    const columnTypes = new Map(
      table.columns.map((c) => [c.name.toLowerCase(), baseType(c.typeDisplay)])
    );
    // Worked out once, so the rules that keep, take over or compare indexes
    // agree on which index each group keeps.
    const parsedIndexes = usableIndexes(table, invalidIndexes);
    const groups = duplicateGroups(table, parsedIndexes);

    // ── No primary key ───────────────────────────────────────────────────
    // A partition inherits its parent's key, so a missing one there is the
    // parent's problem and reporting it on every partition would bury the one
    // row that matters.
    if (!table.primaryKey && !isPartition) {
      advice.push({
        id: "no-primary-key",
        severity: "high",
        title: "Table has no primary key",
        object,
        detail:
          "Without a primary key there is no cheap way to address a single row: " +
          "every UPDATE and DELETE by identity has to be written against some " +
          "other column and may match more rows than intended. Logical " +
          "replication also refuses to publish updates to a table with no " +
          "replica identity.",
        ...primaryKeyFix(
          schema,
          table,
          relations,
          groups.map(keptCopy).flatMap((copy) => (copy.parsed ? [copy.parsed] : []))
        ),
      });
    }

    // ── Foreign key with nothing to look it up by ────────────────────────
    // Skipped entirely when the snapshot has no index record, because "no
    // index" and "no record of indexes" are not the same claim.
    if (prefixes) {
      for (const fk of table.foreignKeys) {
        if (isCoveredBy(fk.columns, prefixes)) continue;
        const cascades = fk.onDelete.toUpperCase().includes("CASCADE");
        const cost =
          `PostgreSQL indexes the side a foreign key POINTS AT, never the side ` +
          `that holds it. So a join through ${fk.name} scans ${table.name} in ` +
          `full, and so does every delete or key update on ` +
          `${fk.referencedTable ?? "the parent table"} — the server has to prove no ` +
          `child row still references the row being removed.` +
          (cascades
            ? " This key is ON DELETE CASCADE, so that full scan happens on every parent delete."
            : "");
        // The index that WOULD have served this key, if it were not invalid.
        // The list is only ever non-empty when the statistics pass ran, and
        // that pass is what raises the invalid-index finding, so naming it
        // here is a pointer at a finding the same screen is already showing.
        const broken = broughtBackByReindex(table, fk.columns, invalidIndexes);
        if (broken) {
          // Deliberately a decision and not a change: rebuilding the index
          // that is already there is cheaper than a second one on the same
          // columns, and the invalid-index finding carries that REINDEX. A
          // change here would put both statements in the fix script, and a
          // user who ticked the lot would end up with two identical indexes.
          advice.push({
            id: "foreign-key-not-indexed",
            severity: cascades ? "high" : "medium",
            title: "Foreign key's only index is invalid",
            object: `${table.name}.${fk.columns.join(", ")}`,
            detail:
              `${cost} The index that would cover it, ${quoteIdent(broken)}, is one PostgreSQL has ` +
              `marked invalid, and the planner never uses one of those — so this key is ` +
              `unindexed in practice. Its own suggestion on this screen rebuilds it.`,
            fix:
              comment`-- Nothing to run here. Rebuilding ${quoteIdent(broken)} is what fixes\n` +
              `-- this, and the suggestion about that index has the statement for it.\n` +
              `-- Adding a second index on the same columns would work too, and would\n` +
              `-- leave you with two once the rebuild finishes.`,
            fixKind: "decision",
            table: table.name,
          });
          continue;
        }
        const index = createIndexSql(schema, table.name, fk.columns, relations, {
          partitioned: Boolean(table.partitioning?.strategy),
        });
        relations.add(index.name);
        advice.push({
          id: "foreign-key-not-indexed",
          severity: cascades ? "high" : "medium",
          title: "Foreign key has no index on this side",
          object: `${table.name}.${fk.columns.join(", ")}`,
          detail: cost,
          fix: index.sql,
          fixKind: "change",
          undo: index.undo,
          table: table.name,
        });
      }
    }

    if (table.indexes) {
      // The ones a wider index can cover: the redundant-index rule compares
      // them, and the duplicate-index fix checks the copy it keeps against them.
      const plain = parsedIndexes.filter((p): p is PlainIndex => !p.unique && p.keys !== null);

      // ── Indexes that do the same job ───────────────────────────────────
      // The groups come from duplicateGroups, worked out before the
      // primary-key rule so that rule takes over only a copy kept here.
      for (const copies of groups) {
        if (copies.length < 2) continue;
        advice.push({
          id: "duplicate-index",
          severity: "medium",
          title:
            copies.length === 2
              ? "Two indexes with the same definition"
              : `${copies.length} indexes with the same definition`,
          object: `${table.name} (${copies.map((c) => c.name).join(", ")})`,
          detail:
            "Identical indexes cost the disk and the write work of every copy — " +
            "each INSERT, UPDATE and DELETE maintains all of them — and the " +
            "planner can only ever use one.",
          ...duplicateFix(schema, table, copies, plain),
        });
      }

      // ── An index whose columns are the front of another index ──────────
      // Only plain columns on both sides, compared exactly (widerPlainIndex):
      // an index with an operator class or a collation serves different
      // lookups than one without, even over the same column.
      for (const [i, narrow] of plain.entries()) {
        const sameAsNarrow = (o: PlainIndex) => o.method === narrow.method && o.tail === narrow.tail;
        // A second copy of an identical index is already dropped by the
        // duplicate finding above; two findings dropping one index is one too many.
        if (plain.slice(0, i).some(sameAsNarrow)) continue;
        const wider = widerPlainIndex(narrow, plain);
        if (!wider) continue;
        // Its identical copies, which the duplicate finding drops while it
        // keeps this one. Named here so the two findings read as two halves
        // of one clean-up, not as a disagreement.
        const copies = plain.filter((o) => o !== narrow && sameAsNarrow(o)).map((o) => o.name);
        advice.push({
          id: "redundant-index",
          severity: "low",
          title: "Index is already covered by a wider one",
          object: `${table.name}.${narrow.name}`,
          detail:
            `Any lookup ${narrow.name} can serve, ${wider.name} can serve too — ` +
            `an index on (${wider.keys.join(", ")}) is usable for a query that ` +
            `only constrains (${narrow.keys.join(", ")}). Keeping both pays the ` +
            `write cost twice for one capability.` +
            (copies.length === 0
              ? ""
              : copies.length === 1
                ? ` ${copies[0]} is an identical copy of ${narrow.name}; the suggestion for identical indexes drops it.`
                : ` ${listInWords(copies)} are identical copies of ${narrow.name}; the suggestion for identical indexes drops them.`),
          fix: `DROP INDEX ${qualifiedName(schema, narrow.name)};`,
          fixKind: "change",
          keeps: qualifiedName(schema, wider.name),
          undo: indexDefinitionSql(narrow, schema, table.name, true),
        });
      }

      // ── An index over a single boolean ─────────────────────────────────
      for (const index of table.indexes) {
        if (index.columns.length !== 1 || index.predicate || index.isUnique) continue;
        if (columnTypes.get(index.columns[0].toLowerCase()) !== "boolean") continue;
        const flag = quoteIdent(index.columns[0]);
        // The example key: a column the rare rows might be fetched or sorted
        // by. Not the primary key if anything else will do — that already
        // has an index, so it makes the example look pointless.
        const pk = new Set(table.primaryKey?.columns ?? []);
        const nonFlag = table.columns.filter((c) => baseType(c.typeDisplay) !== "boolean");
        const example =
          nonFlag.find((c) => !pk.has(c.name))?.name ?? table.primaryKey?.columns[0];
        advice.push({
          id: "boolean-index",
          severity: "low",
          title: "Index over a single boolean column",
          object: `${table.name}.${index.name}`,
          detail:
            "A boolean splits the table roughly in half, and the planner will " +
            "read the table directly rather than use an index that eliminates so " +
            "little. The index is maintained on every write and rarely chosen.",
          fixKind: "decision",
          fix:
            `-- Worth keeping only if one of the two values is rare. Then index just the\n` +
            `-- rare rows: the column the query fetches or sorts them by as the key, and\n` +
            `-- the boolean in the WHERE.` +
            (example
              ? comment` For example, if they are fetched by ${example}:\n` +
                comment`-- CREATE INDEX ON ${target} (${quoteIdent(example)}) WHERE ${flag};\n`
              : `\n`) +
            comment`-- Use WHERE NOT ${flag} instead if false is the rare value.\n` +
            `-- If neither value is rare, the index is not worth keeping:\n` +
            comment`-- DROP INDEX ${qualifiedName(schema, index.name)};`,
        });
      }

      // ── Enough indexes that writes are paying for them ─────────────────
      const indexCount =
        table.indexes.length + table.uniqueConstraints.length + (table.primaryKey ? 1 : 0);
      if (indexCount > 6) {
        advice.push({
          id: "many-indexes",
          severity: "low",
          title: `${indexCount} indexes on one table`,
          object,
          detail:
            "Every index is maintained inside every INSERT, UPDATE and DELETE on " +
            "this table, so writes slow down roughly in proportion to the count. " +
            "Past about half a dozen it is worth checking which ones the planner " +
            "actually chooses.",
          fixKind: "decision",
          // The unused-index rule cannot help on a partitioned table: the
          // server keeps its counters per partition, under each partition's
          // own index names, and not for the table's index as a whole.
          fix: table.partitioning?.strategy
            ? "-- The server counts index use per partition, not for this table as a whole,\n" +
              "-- so look this table's partitions up in pg_stat_user_indexes: an index whose\n" +
              "-- idx_scan is 0 on every partition has not been used by any query. Keep\n" +
              "-- unique indexes and the ones behind a primary key or unique constraint:\n" +
              "-- they enforce a rule even when no query reads them."
            : "-- Each index no query has used gets its own \"Index has not been used since\n" +
              "-- the counters started\" suggestion on this screen, when the server's usage\n" +
              "-- statistics could be read. Unique indexes and the ones behind a primary key\n" +
              "-- or unique constraint are left out of those: they enforce a rule even when\n" +
              "-- no query reads them.",
        });
      }
    }

    // ── Column-level rules ───────────────────────────────────────────────
    // Not on a partition: its columns are the parent's, PostgreSQL refuses to
    // change their type or make them identity columns on one partition alone,
    // and the parent's own finding already covers them.
    if (!isPartition) {
      for (const column of table.columns) {
        const type = baseType(column.typeDisplay);
        const col = quoteIdent(column.name);

        if (type === "timestamp without time zone" || type === "timestamp") {
          advice.push({
            id: "timestamp-without-timezone",
            severity: "medium",
            title: "Timestamp column carries no time zone",
            object: `${table.name}.${column.name}`,
            detail:
              "`timestamp without time zone` stores a wall clock and throws the " +
              "offset away, so the same value means different instants depending on " +
              "who reads it. Comparisons across zones, and any index used to serve " +
              "them, are then answering the wrong question.",
            // A decision, not a change: which zone the stored values were
            // written in is something only the people who wrote them know.
            fixKind: "decision",
            fix:
              // ALTER COLUMN ... TYPE writes the whole table out again under
              // ACCESS EXCLUSIVE (checked on PostgreSQL 17), so reads wait too.
              `-- Converting rewrites the whole table, and the table is blocked, reads included,\n` +
              `-- until that finishes. Each stored value has to be read as a time in some zone;\n` +
              `-- replace 'UTC' below with the zone the values were written in:\n` +
              comment`-- ALTER TABLE ${target} ALTER COLUMN ${col} TYPE ${zonedType(column.typeDisplay)} ` +
              comment`USING ${col} AT TIME ZONE 'UTC';\n` +
              `-- If a view reads this column, the ALTER stops with an error naming it.`,
          });
        }

        if (type === "character" || type === "bpchar") {
          advice.push({
            id: "blank-padded-char",
            severity: "low",
            title: "Column is character(n)",
            object: `${table.name}.${column.name}`,
            detail:
              "character(n) pads every value out to n with spaces and strips them " +
              "again on the way out, which costs storage on short values and makes " +
              "comparisons subtly different from text. PostgreSQL's own " +
              "documentation recommends against it; there is no performance " +
              "advantage over text.",
            fixKind: "change",
            fix:
              // Checked on PostgreSQL 17: the table is written out again under
              // ACCESS EXCLUSIVE, and 'ab' stored in character(10) comes out
              // as text of length 2.
              `-- This rewrites the table, and the table is blocked, reads included, until that\n` +
              `-- finishes. Trailing spaces are dropped from the stored values, which is how\n` +
              `-- they already compare.\n` +
              `-- If a view reads this column, the ALTER stops with an error naming it; nothing changes.\n` +
              `ALTER TABLE ${target} ALTER COLUMN ${col} TYPE text;`,
            undo: `ALTER TABLE ${target} ALTER COLUMN ${col} TYPE ${column.typeDisplay};`,
          });
        }

        // A `serial` column is an integer with a nextval default. Only an
        // integer one: a nextval default on a text column (a formatted code,
        // say) is not a serial, and an identity column has to be an integer.
        if (
          INTEGER_TYPES.has(type) &&
          column.columnDefault?.toLowerCase().startsWith("nextval(")
        ) {
          const sequence = serialSequence(column.columnDefault, schema);
          const base = {
            id: "serial-not-identity",
            severity: "low" as const,
            title: "Column uses serial rather than an identity",
            object: `${table.name}.${column.name}`,
            detail:
              "A serial column's sequence is a separate object with its own " +
              "permissions and its own way of being left behind by a dump, and " +
              "nothing stops a client writing straight past it. GENERATED AS " +
              "IDENTITY is the standard spelling and ties the sequence to the column.",
          };
          if (sequence === null) {
            advice.push({
              ...base,
              fixKind: "decision",
              fix:
                "-- This default does not name its sequence the usual way, so the steps are\n" +
                "-- set out here rather than written out:\n" +
                "--   1. make the column NOT NULL, if it is not already;\n" +
                "--   2. drop its default;\n" +
                "--   3. detach the old sequence from it with ALTER SEQUENCE and OWNED BY NONE;\n" +
                "--   4. add GENERATED BY DEFAULT AS IDENTITY to the column;\n" +
                "--   5. with setval, start the identity's new sequence where the old one would\n" +
                "--      go next, or above the column's highest value if that is higher.",
            });
          } else if (
            // A sequence in another schema, or one this column does not own,
            // may be shared: moving this column off it is fine, but advice to
            // drop it could break whatever else draws numbers from it.
            sequence.schema === schema &&
            sequenceBelongsTo(snapshot, sequence.name, table.name, column.name)
          ) {
            advice.push({ ...base, ...serialFix(schema, table.name, column, sequence.name) });
          }
        }
      }
    }

    // ── A wide, variable-length primary key ──────────────────────────────
    if (table.primaryKey) {
      const wide = table.primaryKey.columns.filter((c) => {
        const type = columnTypes.get(c.toLowerCase());
        return type === "text" || type === "character varying" || type === "varchar";
      });
      if (wide.length > 0) {
        advice.push({
          id: "text-primary-key",
          severity: "low",
          title: "Primary key is a text column",
          object: `${table.name}.${wide.join(", ")}`,
          detail:
            "Every foreign key pointing at this table stores a full copy of the " +
            "key, and so does every index entry on both sides. A long text key " +
            "makes all of them larger, which means fewer entries per page and more " +
            "pages read per lookup.",
          fixKind: "decision",
          fix:
            "-- If the text is genuinely the identity, leave it. If it is a code that\n" +
            "-- happens to be unique, consider an identity column as the key and a\n" +
            "-- UNIQUE constraint on the code.",
        });
      }
    }
  }

  return sortAdvice(advice);
}
