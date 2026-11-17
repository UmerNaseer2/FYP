// Extension and collation statements.

import type { CollationSnapshot, ExtensionSnapshot } from "../../postgres";
import { q } from "./basics";
import { literal, objectStatement } from "./statement-helpers";
import type { SqlStatement } from "./types";

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
export function createExtensionStatement(extension: ExtensionSnapshot): SqlStatement {
  return objectStatement({
    sql:
      `CREATE EXTENSION IF NOT EXISTS ${q(extension.name)} ` +
      `VERSION ${literal(extension.version)};`,
    description: `Install extension "${extension.name}" ${extension.definition}`,
    kind: "CREATE_EXTENSION",
    tableName: extension.name,
  });
}

export function dropExtensionStatement(extension: ExtensionSnapshot): SqlStatement {
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
export function createCollationStatement(collation: CollationSnapshot): SqlStatement | null {
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

  return objectStatement({
    sql: `CREATE COLLATION IF NOT EXISTS ${q(collation.name)} (${options.join(", ")});`,
    description: `Create collation "${collation.name}"`,
    kind: "CREATE_COLLATION",
    tableName: collation.name,
  });
}

export function dropCollationStatement(collation: CollationSnapshot): SqlStatement {
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
