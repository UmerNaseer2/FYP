/**
 * User-defined types (enums, domains, composites, ranges): the catalog query,
 * and the step that builds the TypeSnapshot list.
 */
import type { PoolClient } from "pg";
import { coerceJsonArray, coerceTextArray } from "../helpers";
import { normalizeDefinition, stripSchemaFromExpr } from "../normalize";
import type { DomainCheck, RangeDetails, TypeSnapshot } from "../types";

export type TypeRow = {
  name: string;
  kind: "enum" | "domain" | "composite" | "range";
  enum_labels: string[] | null;
  base_type: string | null;
  range_subtype: string | null;
  range_opclass: string | null;
  range_opclass_is_default: boolean | null;
  range_collation: string | null;
  range_canonical: string | null;
  range_subtype_diff: string | null;
  range_subtype_diff_schema: string | null;
  range_multirange: string | null;
  domain_not_null: boolean | null;
  domain_default: string | null;
  domain_checks: DomainCheck[] | string | null;
  composite_fields: string[] | null;
};

/**
 * An enum's labels, exactly as PostgreSQL holds them.
 *
 * The query casts each label to text, so node-postgres hands back a real array
 * and a label is never cut up: 'a, b' stays one label, and a double quote or a
 * backslash stays as typed. Nothing is trimmed either, because ' a' and 'a'
 * are two different labels. Text (PGlite) still goes through coerceTextArray.
 */
function enumLabels(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((label) => String(label));
  return coerceTextArray(value);
}

export async function readTypes(client: PoolClient, schemaName: string): Promise<TypeRow[]> {
  // Every table has a row in pg_type for its own row type; the typrelid check
  // removes those. The pg_depend check removes types owned by an extension
  // (pgcrypto, postgis), which are installed, not authored, and would
  // otherwise diff against any schema without that extension. The extension
  // is captured on its own (catalog/extensions.ts), so skipping them here no
  // longer means the difference goes unnoticed — CREATE EXTENSION brings all
  // of them back.
  const result = await client.query<TypeRow>(
      `SELECT
         t.typname AS name,
         CASE t.typtype
           WHEN 'e' THEN 'enum'
           WHEN 'd' THEN 'domain'
           WHEN 'c' THEN 'composite'
           ELSE 'range'
         END AS kind,
         CASE WHEN t.typtype = 'e' THEN (
           SELECT array_agg(e.enumlabel::text ORDER BY e.enumsortorder)
             FROM pg_enum e WHERE e.enumtypid = t.oid
         ) END AS enum_labels,
         CASE WHEN t.typtype = 'd'
           THEN format_type(t.typbasetype, t.typtypmod) END AS base_type,
         CASE WHEN t.typtype = 'r' THEN (
           SELECT format_type(r.rngsubtype, NULL)
             FROM pg_range r WHERE r.rngtypid = t.oid
         ) END AS range_subtype,
         opc.opcname AS range_opclass,
         opc.opcdefault AS range_opclass_is_default,
         rco.collname AS range_collation,
         canp.proname AS range_canonical,
         diffp.proname AS range_subtype_diff,
         diffn.nspname AS range_subtype_diff_schema,
         -- rngmultitypid arrived in PostgreSQL 14, so it is read out of the
         -- row as JSON rather than named in a join: on an older server the key
         -- is simply absent, where naming the column would fail the query.
         (SELECT mt.typname FROM pg_type mt
           WHERE mt.oid::text = (to_jsonb(rng) ->> 'rngmultitypid')
         ) AS range_multirange,
         CASE WHEN t.typtype = 'd' THEN t.typnotnull END AS domain_not_null,
         -- The domain's DEFAULT, as an expression. typdefaultbin is the parsed
         -- form and typdefault the text someone typed; the parsed one is read
         -- first so the text comes back the same way on both sides.
         CASE WHEN t.typtype = 'd'
           THEN COALESCE(pg_get_expr(t.typdefaultbin, 0), t.typdefault) END AS domain_default,
         CASE WHEN t.typtype = 'd' THEN (
           SELECT json_agg(json_build_object(
                    'name', con.conname,
                    'expression', pg_get_constraintdef(con.oid)
                  ) ORDER BY con.conname)
             -- contype 'c' only. PostgreSQL 17 records a domain's NOT NULL in
             -- pg_constraint as well as in typnotnull, and picking it up here
             -- made the generator emit both SET NOT NULL and an
             -- ADD CONSTRAINT ... NOT NULL for the same domain — the second of
             -- which is not valid syntax before 17.
             FROM pg_constraint con
            WHERE con.contypid = t.oid AND con.contype = 'c'
         ) END AS domain_checks,
         CASE WHEN t.typtype = 'c' THEN (
           SELECT array_agg(quote_ident(a.attname) || ' ' ||
                            format_type(a.atttypid, a.atttypmod)
                            ORDER BY a.attnum)
             FROM pg_attribute a
            WHERE a.attrelid = t.typrelid
              AND a.attnum > 0
              AND NOT a.attisdropped
         ) END AS composite_fields
       FROM pg_type t
       JOIN pg_namespace n ON n.oid = t.typnamespace
       -- All five outer joins are for range types and stay NULL for the rest.
       LEFT JOIN pg_range rng ON rng.rngtypid = t.oid
       LEFT JOIN pg_opclass opc ON opc.oid = rng.rngsubopc
       LEFT JOIN pg_collation rco ON rco.oid = rng.rngcollation
       LEFT JOIN pg_proc canp ON canp.oid = rng.rngcanonical
       LEFT JOIN pg_proc diffp ON diffp.oid = rng.rngsubdiff
       LEFT JOIN pg_namespace diffn ON diffn.oid = diffp.pronamespace
       WHERE n.nspname = $1
         AND t.typtype IN ('e', 'd', 'c', 'r')
         AND NOT EXISTS (
           SELECT 1 FROM pg_class c
            WHERE c.oid = t.typrelid AND c.relkind <> 'c'
         )
         AND NOT EXISTS (
           SELECT 1 FROM pg_depend dep
            WHERE dep.objid = t.oid AND dep.deptype = 'e'
         )
       ORDER BY t.typname`,
      [schemaName]
  );
  return result.rows;
}

/** One TypeSnapshot per user-defined type. */
export function buildTypes(rows: TypeRow[], schemaName: string): TypeSnapshot[] {
  return rows.map((row) => {
    const labels = enumLabels(row.enum_labels);
    const checks = coerceJsonArray<DomainCheck>(row.domain_checks).map((check) => ({
      name: check.name,
      expression: stripSchemaFromExpr(check.expression, schemaName) ?? check.expression,
    }));
    const attributes = coerceTextArray(row.composite_fields).map(
      (attr) => stripSchemaFromExpr(attr, schemaName) ?? attr
    );
    const baseTypeRaw = row.base_type ?? row.range_subtype;
    const baseType = stripSchemaFromExpr(baseTypeRaw, schemaName);
    const notNull = row.domain_not_null === true;
    // Only a domain can have one. Null means "no default".
    const domainDefault =
      row.kind === "domain"
        ? (stripSchemaFromExpr(row.domain_default ?? null, schemaName) ?? null)
        : undefined;

    // Only a range type has any of this, and only the options someone
    // actually chose are kept: the default operator class is what CREATE
    // TYPE picks anyway, so recording it would add a phrase to the
    // definition of every range type already stored.
    let rangeDetails: RangeDetails | undefined;
    if (row.kind === "range") {
      const diffSchema = row.range_subtype_diff_schema;
      rangeDetails = {
        subtypeOpclass: row.range_opclass_is_default ? null : row.range_opclass,
        collation: row.range_collation,
        canonical: row.range_canonical,
        // Left bare when it is a built-in or lives in this schema, and
        // qualified when it does not — the same rule the rest of the reader
        // applies to expressions, so the text reads the way it would be
        // written back out.
        subtypeDiff:
          row.range_subtype_diff === null
            ? null
            : diffSchema === schemaName || diffSchema === "pg_catalog"
              ? row.range_subtype_diff
              : `${diffSchema}.${row.range_subtype_diff}`,
        multirangeName:
          row.range_multirange !== null &&
          row.range_multirange !== `${row.name}_multirange`
            ? row.range_multirange
            : null,
        needsManualCreate:
          row.range_canonical !== null || diffSchema === schemaName,
      };
    }

    // One readable line per type, because that is what the comparator diffs
    // and what the report shows. An enum's labels are ordered: Postgres
    // compares enum values by that order, so reordering them is a real change.
    let definition: string;
    if (row.kind === "enum") {
      definition = `ENUM (${labels.join(", ")})`;
    } else if (row.kind === "domain") {
      const parts = [`DOMAIN ${baseType ?? "?"}`];
      if (notNull) parts.push("NOT NULL");
      // Written only when there is one, so a domain without a default reads
      // the way it did before defaults were recorded.
      if (domainDefault) parts.push(`DEFAULT ${domainDefault}`);
      parts.push(...checks.map((check) => check.expression));
      definition = parts.join(" ");
    } else if (row.kind === "composite") {
      definition = `COMPOSITE (${attributes.join(", ")})`;
    } else {
      // The subtype alone when nothing else was chosen, which is what this
      // line said before any of the rest was captured — so a stored snapshot
      // still matches a fresh one rather than reporting drift.
      const parts = [baseType ?? "?"];
      if (rangeDetails?.subtypeOpclass) {
        parts.push(`subtype_opclass = ${rangeDetails.subtypeOpclass}`);
      }
      if (rangeDetails?.collation) {
        parts.push(`collation = "${rangeDetails.collation}"`);
      }
      if (rangeDetails?.canonical) {
        parts.push(`canonical = ${rangeDetails.canonical}`);
      }
      if (rangeDetails?.subtypeDiff) {
        parts.push(`subtype_diff = ${rangeDetails.subtypeDiff}`);
      }
      if (rangeDetails?.multirangeName) {
        parts.push(`multirange_type_name = ${rangeDetails.multirangeName}`);
      }
      definition = `RANGE (${parts.join(", ")})`;
    }

    return {
      name: row.name,
      kind:
        row.kind === "enum"
          ? "ENUM"
          : row.kind === "domain"
            ? "DOMAIN"
            : row.kind === "composite"
              ? "COMPOSITE"
              : "RANGE",
      labels,
      baseType,
      notNull,
      ...(domainDefault !== undefined ? { domainDefault } : {}),
      checks,
      attributes,
      rangeDetails,
      definition,
      normalizedDefinition: normalizeDefinition(definition),
    } satisfies TypeSnapshot;
  });
}
