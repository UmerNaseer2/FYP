/**
 * Collations the schema owns: the catalog query, and the step that builds the
 * CollationSnapshot list.
 */
import type { PoolClient } from "pg";
import { quoteLiteral, textOrNull } from "../helpers";
import { normalizeDefinition } from "../normalize";
import type { CollationProvider, CollationSnapshot } from "../types";

export type CollationRow = {
  name: string;
  provider: string;
  deterministic: boolean;
  lc_collate: string | null;
  lc_ctype: string | null;
  /**
   * The whole catalog row as JSON.
   *
   * The locale and the tailoring rules moved columns twice — `colliculocale`
   * arrived in 15, was renamed `colllocale` in 17, and `collicurules` arrived
   * in 16 — so naming any of them in the SELECT list makes the query fail
   * outright on a server that does not have that column. Nothing in the reader
   * gates on server version, so they are read out of the row as JSON instead,
   * where a missing key is simply undefined.
   */
  raw: Record<string, unknown>;
};

/**
 * pg_collation.collprovider, spelled the way CREATE COLLATION spells it.
 *
 * 'b' (builtin) only exists from PostgreSQL 17, and an unknown letter from a
 * newer server is reported as the database default rather than guessed at.
 */
function collationProvider(code: string): CollationProvider {
  if (code === "i") return "icu";
  if (code === "c") return "libc";
  if (code === "b") return "builtin";
  return "default";
}

export async function readCollations(client: PoolClient, schemaName: string): Promise<CollationRow[]> {
  // Only the columns that have been in pg_collation since 12 are named here.
  // The locale and the ICU rules are read from to_jsonb(co) below, because
  // the columns holding them differ by server version and naming one the
  // server does not have makes the whole query fail.
  const result = await client.query<CollationRow>(
      `SELECT
         co.collname AS name,
         co.collprovider AS provider,
         co.collisdeterministic AS deterministic,
         co.collcollate AS lc_collate,
         co.collctype AS lc_ctype,
         to_jsonb(co) AS raw
       FROM pg_collation co
       JOIN pg_namespace n ON n.oid = co.collnamespace
       WHERE n.nspname = $1
         AND NOT EXISTS (
           SELECT 1 FROM pg_depend dep
            WHERE dep.objid = co.oid AND dep.deptype = 'e'
         )
       ORDER BY co.collname`,
      [schemaName]
  );
  return result.rows;
}

/** One CollationSnapshot per collation. */
export function buildCollations(rows: CollationRow[]): CollationSnapshot[] {
  return rows.map((row) => {
    const provider = collationProvider(row.provider);
    // colllocale is 17+, colliculocale is 15-16, and before 15 an ICU
    // collation kept its locale in collcollate — the same column libc uses.
    const rawLocale =
      textOrNull(row.raw.colllocale) ??
      textOrNull(row.raw.colliculocale) ??
      (provider === "libc" ? null : row.lc_collate);
    const isLibc = provider === "libc" || provider === "default";
    const locale = isLibc ? null : rawLocale;
    const lcCollate = isLibc ? row.lc_collate : null;
    const lcCtype = isLibc ? row.lc_ctype : null;
    const rules = textOrNull(row.raw.collicurules);

    // Written as the CREATE COLLATION option list, so the diff on screen
    // reads the way the statement that would fix it does.
    const parts = [`provider = ${provider}`];
    if (locale !== null) parts.push(`locale = ${quoteLiteral(locale)}`);
    if (lcCollate !== null) parts.push(`lc_collate = ${quoteLiteral(lcCollate)}`);
    if (lcCtype !== null) parts.push(`lc_ctype = ${quoteLiteral(lcCtype)}`);
    if (rules !== null) parts.push(`rules = ${quoteLiteral(rules)}`);
    // Only ever written when it is false: "deterministic = true" on every
    // ordinary collation is noise on a line the report shows in full.
    if (!row.deterministic) parts.push("deterministic = false");
    const definition = parts.join(", ");

    return {
      name: row.name,
      provider,
      deterministic: row.deterministic,
      locale,
      lcCollate,
      lcCtype,
      rules,
      definition,
      normalizedDefinition: normalizeDefinition(definition),
    } satisfies CollationSnapshot;
  });
}
