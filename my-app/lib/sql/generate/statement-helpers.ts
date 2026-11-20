// Helpers every statement writer shares: the common statement fields, SQL
// literals and dollar quoting, the "only if missing" guard and its catalog
// queries, and the manual note.

import { q } from "./basics";
import type { SqlStatement, SqlStatementKind } from "./types";

// ---------------------------------------------------------------------------
// Schema object DDL — indexes, triggers, views, sequences, types and routines
//
// Everything the object files build with these helpers runs inside the apply
// route's single transaction.
// That rules out CONCURRENTLY outright: PostgreSQL rejects both CREATE INDEX
// CONCURRENTLY and DROP INDEX CONCURRENTLY with "cannot run inside a
// transaction block", so indexes are built with a plain CREATE INDEX and the
// table lock that implies. A script that half-applied would be far worse than
// one that holds a lock.
// ---------------------------------------------------------------------------

/** Fill in the fields every object statement shares; call sites carry the rest. */
export function objectStatement(fields: {
  sql: string;
  description: string;
  kind: SqlStatementKind;
  severity?: SqlStatement["severity"];
  /** The table for an index/trigger; the object's own name otherwise. */
  tableName: string;
  destructive?: boolean;
  needsArmedDrop?: boolean;
  role?: string;
}): SqlStatement {
  return {
    sql: fields.sql,
    description: fields.description,
    kind: fields.kind,
    severity: fields.severity ?? "info",
    tableName: fields.tableName,
    destructive: fields.destructive === true,
    needsArmedDrop: fields.needsArmedDrop === true,
    // Only on the statements that name a role, so every other one keeps its shape.
    ...(fields.role === undefined ? {} : { role: fields.role }),
  };
}

/** A SQL string literal — for enum labels, which are values and not identifiers. */
export function literal(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * A dollar-quote tag that none of `parts` already contains.
 *
 * `$$` is the obvious tag and the wrong one: the text going inside a DO block
 * is schema text — a CHECK expression, an enum label, a column name — and any
 * of it may hold a `$$` of its own, which ends the block early and leaves the
 * rest of it as SQL that will not parse. `$guard$` is far less likely and still
 * not impossible, so the number climbs until the tag is genuinely absent.
 */
export function dollarTagFor(...parts: string[]): string {
  let tag = "$guard$";
  for (let n = 1; parts.some((part) => part.includes(tag)); n += 1) {
    tag = `$guard${n}$`;
  }
  return tag;
}

/**
 * Run `statement` only when `existsQuery` finds nothing.
 *
 * Every CREATE and ADD a generated script contains is written so the script can
 * be run twice. After a deploy that was cut off half way, or one that is simply
 * repeated, a second run skips what is already there instead of stopping on
 * "already exists", which inside the one transaction the apply route uses would
 * roll the whole run back. Most statements can say that themselves with IF NOT
 * EXISTS. PostgreSQL has no IF NOT EXISTS for these statements (ADD CONSTRAINT,
 * CREATE TYPE, CREATE DOMAIN, ALTER DOMAIN ... ADD CONSTRAINT, CREATE POLICY),
 * so for those the script asks the catalog first, from a DO block.
 *
 * Each lookup has to find exactly what the statement would. An ALTER names its
 * object the same unqualified way the lookup does, so both resolve through the
 * search_path the apply route sets. A CREATE is different: it puts the new
 * object in current_schema(), whatever the name would resolve to elsewhere, so
 * its lookup reads that one schema (see createTypeStatement).
 *
 * The tag is not $$ so a $$ inside a definition cannot end the block. It gains
 * a number in the rare case the text going inside already holds "$guard$" (a
 * CHECK or an enum label can hold any text at all), because that copy would end
 * the block early and leave the rest of it as broken SQL.
 */
export function onlyIfMissing(existsQuery: string, statement: string): string {
  const tag = dollarTagFor(existsQuery, statement);
  return [
    `DO ${tag}`,
    "BEGIN",
    `  IF NOT EXISTS (${existsQuery}) THEN`,
    `    ${statement}`,
    "  END IF;",
    "END",
    `${tag};`,
  ].join("\n");
}

/**
 * The other way round from onlyIfMissing: run `statement` only while the thing
 * `existsQuery` looks for is still there. For a rename that a second run of the
 * same script has to skip, because by then the name may belong to something
 * else.
 */
export function onlyIfPresent(existsQuery: string, statement: string): string {
  const tag = dollarTagFor(existsQuery, statement);
  return [
    `DO ${tag}`,
    "BEGIN",
    `  IF EXISTS (${existsQuery}) THEN`,
    `    ${statement}`,
    "  END IF;",
    "END",
    `${tag};`,
  ].join("\n");
}

/**
 * The lookup for a sequence tied to a column of `tableName`, by the given kinds
 * of link. With `columnName`, only to that column: on a second run of the same
 * script that column is gone, so nothing matches.
 */
export function ownedSequenceQuery(
  sequenceName: string,
  tableName: string,
  deptypes: string,
  columnName: string | null = null
): string {
  const column =
    columnName === null
      ? ""
      : ` AND refobjsubid = (SELECT a.attnum FROM pg_attribute a ` +
        `WHERE a.attrelid = to_regclass(${literal(q(tableName))}) ` +
        `AND a.attname = ${literal(columnName)} AND NOT a.attisdropped)`;
  return (
    `SELECT 1 FROM pg_depend WHERE classid = 'pg_class'::regclass ` +
    `AND objid = to_regclass(${literal(q(sequenceName))}) ` +
    `AND refclassid = 'pg_class'::regclass AND refobjid = to_regclass(${literal(q(tableName))}) ` +
    `AND deptype IN (${deptypes})` +
    column
  );
}

/** The onlyIfMissing lookup for a named constraint on a table. */
export function tableConstraintQuery(tableName: string, constraintName: string): string {
  return (
    `SELECT 1 FROM pg_constraint WHERE conrelid = to_regclass(${literal(q(tableName))}) ` +
    `AND conname = ${literal(constraintName)}`
  );
}

/** The onlyIfMissing lookup for a column on a table, by its exact name. */
export function tableColumnQuery(tableName: string, columnName: string): string {
  return (
    `SELECT 1 FROM pg_attribute WHERE attrelid = to_regclass(${literal(q(tableName))}) ` +
    `AND attname = ${literal(columnName)} AND attnum > 0 AND NOT attisdropped`
  );
}

/**
 * The onlyIfMissing lookup for an index of a given name on a table.
 *
 * indrelid pins it to this one table, so an index of the same name on any other
 * table (index names are unique per schema, not per table) does not count as
 * already present — see indexCreateSql for why that distinction matters.
 */
export function tableIndexQuery(tableName: string, indexName: string): string {
  return (
    `SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid ` +
    `WHERE i.indrelid = to_regclass(${literal(q(tableName))}) ` +
    `AND c.relname = ${literal(indexName)}`
  );
}

// Put text on one line before it goes into a `--` comment. PostgreSQL ends a
// `--` comment at a line break (\n or \r), and names come from the databases
// being compared: a table called `x<newline>DROP TABLE customers;` would
// otherwise start a new line that is not a comment, and that line would run.
// A quoted name, an enum label or a default can all hold a line break.
export function oneLine(text: string): string {
  return text.replace(/[\r\n]+/g, " ");
}

/** A `-- MANUAL:` line: inert when run, but still visible in the script. */
export function manualNote(text: string, description: string, tableName: string): SqlStatement {
  return objectStatement({
    sql: `-- MANUAL: ${oneLine(text)}`,
    description,
    kind: "MANUAL",
    severity: "info",
    tableName,
  });
}
