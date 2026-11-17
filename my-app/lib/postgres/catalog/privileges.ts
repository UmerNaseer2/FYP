/**
 * Ownership and grants: the catalog query (one row per object, grantee and
 * privilege), and the step that groups the rows into one PrivilegeSnapshot
 * per object.
 */
import type { PoolClient } from "pg";
import { COMPARE_IGNORED_TABLES, quoteRole } from "../helpers";
import { normalizeDefinition, stripSchemaFromExpr } from "../normalize";
import type { PrivilegeGrant, PrivilegeObjectKind, PrivilegeSnapshot } from "../types";

/** One row per (object, grantee, privilege). Grouped into grants below. */
export type PrivilegeRow = {
  object_kind: PrivilegeObjectKind;
  object_name: string;
  /** A routine's argument types; NULL for every other kind. */
  identity_arguments: string | null;
  owner: string;
  /** NULL when the object's ACL is empty — the LEFT JOIN keeps the owner row. */
  grantee: string | null;
  privilege_type: string | null;
  is_grantable: boolean | null;
};

/**
 * The order GRANT lists privileges in, which is the order PostgreSQL's own
 * documentation lists them in.
 *
 * A fixed order rather than alphabetical, so `SELECT, INSERT, UPDATE` reads the
 * way somebody would type it — and so the same set of privileges always renders
 * to the same string, which is what the comparison actually compares.
 */
const PRIVILEGE_ORDER = [
  "SELECT",
  "INSERT",
  "UPDATE",
  "DELETE",
  "TRUNCATE",
  "REFERENCES",
  "TRIGGER",
  "MAINTAIN",
  "USAGE",
  "CREATE",
  "EXECUTE",
  "CONNECT",
  "TEMPORARY",
  "SET",
  "ALTER SYSTEM",
];

function sortPrivileges(privileges: string[]): string[] {
  return [...privileges].sort((a, b) => {
    const ai = PRIVILEGE_ORDER.indexOf(a);
    const bi = PRIVILEGE_ORDER.indexOf(b);
    // A privilege a future PostgreSQL adds is unknown to the list above; it
    // sorts to the end rather than to the front, where it would silently
    // reorder every existing rendering.
    if (ai === -1 && bi === -1) return a.localeCompare(b);
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });
}

/**
 * The one-line rendering the comparison diffs, e.g.
 * `owned by "app" — "api": SELECT, INSERT; PUBLIC: SELECT (SELECT grantable)`.
 */
function buildPrivilegeDefinition(
  owner: string,
  grants: PrivilegeGrant[]
): string {
  const head = `owned by ${quoteRole(owner)}`;
  if (grants.length === 0) return `${head} — no grants to anybody else`;
  const parts = grants.map((grant) => {
    const passOn =
      grant.grantable.length > 0
        ? ` (may pass on ${grant.grantable.join(", ")})`
        : "";
    return `${quoteRole(grant.grantee)}: ${grant.privileges.join(", ")}${passOn}`;
  });
  return `${head} — ${parts.join("; ")}`;
}

export async function readPrivileges(client: PoolClient, schemaName: string): Promise<PrivilegeRow[]> {
  // One row per (object, grantee, privilege), for every kind of object GRANT
  // has a word for, plus the schema itself.
  //
  // aclexplode turns the aclitem array into rows with the privilege spelled
  // out — SELECT rather than the letter r — so nothing here has to decode
  // PostgreSQL's ACL shorthand or know which letters a table has and a
  // sequence does not. acldefault fills in the implicit ACL an untouched
  // object has: relacl is NULL until somebody grants something, and reading
  // that NULL as "nobody has anything" would report a plain table as having
  // lost every privilege its owner holds.
  //
  // LEFT JOIN LATERAL rather than a plain join, so an object whose ACL
  // really is empty still produces its one row and its owner is recorded.
  //
  // Sequences are included whether or not a column owns them — see the note
  // on PrivilegeSnapshot. Indexes and constraints are not: they have no ACL
  // of their own and take their access from the table.
  const result = await client.query<PrivilegeRow>(
      `WITH objects AS (
         SELECT
           CASE c.relkind
             WHEN 'v' THEN 'VIEW'
             WHEN 'm' THEN 'MATERIALIZED VIEW'
             WHEN 'S' THEN 'SEQUENCE'
             ELSE 'TABLE'
           END AS object_kind,
           c.relname::text AS object_name,
           NULL::text AS identity_arguments,
           pg_get_userbyid(c.relowner) AS owner,
           c.relowner AS owner_oid,
           COALESCE(
             c.relacl,
             -- The cast is needed: a CASE returns text, and acldefault takes
             -- the one-byte "char" the catalogs use for object kinds.
             acldefault(
               (CASE WHEN c.relkind = 'S' THEN 's' ELSE 'r' END)::"char",
               c.relowner
             )
           ) AS acl
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = $1
           AND c.relkind IN ('r', 'p', 'v', 'm', 'S')
           AND c.relname <> ALL($2)
           -- And the sequences those hidden tables own — see the note in the
           -- sequence query above.
           AND NOT EXISTS (
             SELECT 1 FROM pg_depend owned
              JOIN pg_class owner ON owner.oid = owned.refobjid
             WHERE owned.objid = c.oid
               AND owned.classid = 'pg_class'::regclass
               AND owned.deptype IN ('a', 'i')
               AND owner.relname = ANY($2)
           )
         UNION ALL
         SELECT
           CASE p.prokind WHEN 'p' THEN 'PROCEDURE' ELSE 'FUNCTION' END,
           p.proname::text,
           -- Kept apart from the name because the generator quotes the name and
           -- must not quote these. proargtypes holds the IN arguments only,
           -- which is exactly what identifies an overload.
           (SELECT COALESCE(string_agg(format_type(u.t, NULL), ', ' ORDER BY u.ord), '')
              FROM unnest(p.proargtypes) WITH ORDINALITY AS u(t, ord)),
           pg_get_userbyid(p.proowner),
           p.proowner,
           COALESCE(p.proacl, acldefault('f', p.proowner))
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = $1
           AND p.prokind IN ('f', 'p')
           AND NOT EXISTS (
             SELECT 1 FROM pg_depend dep
              WHERE dep.objid = p.oid
                AND dep.classid = 'pg_proc'::regclass
                AND dep.deptype IN ('e', 'i')
           )
         UNION ALL
         SELECT
           'SCHEMA', n.nspname::text, NULL::text,
           pg_get_userbyid(n.nspowner), n.nspowner,
           COALESCE(n.nspacl, acldefault('n', n.nspowner))
         FROM pg_namespace n
         WHERE n.nspname = $1
       )
       SELECT
         o.object_kind,
         o.object_name,
         o.identity_arguments,
         o.owner,
         CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END
           AS grantee,
         a.privilege_type,
         a.is_grantable
       FROM objects o
       LEFT JOIN LATERAL aclexplode(o.acl) a
         -- The owner's own entry is dropped here rather than in JS, so the
         -- rows that travel back are only the ones the comparison looks at.
         ON a.grantee <> o.owner_oid
       ORDER BY o.object_kind, o.object_name, o.identity_arguments,
                grantee, a.privilege_type`,
      [schemaName, COMPARE_IGNORED_TABLES]
  );
  return result.rows;
}

export function buildPrivileges(rows: PrivilegeRow[], schemaName: string): PrivilegeSnapshot[] {
  // The query hands back one row per (object, grantee, privilege); this puts
  // them back together into one entry per object.
  const privilegesByKey = new Map<string, PrivilegeSnapshot>();
  const grantsByKey = new Map<string, Map<string, PrivilegeGrant>>();
  for (const row of rows) {
    // format_type() qualifies an argument whose type lives in this schema, so
    // an untouched `f(order_status)` arrives as `f(dev.order_status)`. Left
    // alone that is wrong twice over: the same function in two schemas would
    // never match, and the generated GRANT would name a type in the schema
    // being copied FROM. Same treatment the routine signatures get.
    const identityArguments =
      stripSchemaFromExpr(row.identity_arguments, schemaName);
    // The arguments are part of the key: two overloads of one function are
    // two objects with two ACLs, and keying on the name alone would fold
    // them together and report one's grants as the other's.
    const key =
      `${row.object_kind}\u0000${row.object_name}` +
      `\u0000${identityArguments ?? ""}`;
    let entry = privilegesByKey.get(key);
    if (!entry) {
      entry = {
        objectKind: row.object_kind,
        objectName: row.object_name,
        ...(identityArguments === null ? {} : { identityArguments }),
        owner: row.owner,
        grants: [],
        definition: "",
        normalizedDefinition: "",
      };
      privilegesByKey.set(key, entry);
      grantsByKey.set(key, new Map());
    }
    // Null on the row the LEFT JOIN produced for an object nobody else has
    // any access to. The object still belongs in the list — its owner is the
    // point — so the row is kept and only the grant is skipped.
    if (row.grantee === null || row.privilege_type === null) continue;
    const byGrantee = grantsByKey.get(key)!;
    let grant = byGrantee.get(row.grantee);
    if (!grant) {
      grant = { grantee: row.grantee, privileges: [], grantable: [] };
      byGrantee.set(row.grantee, grant);
      entry.grants.push(grant);
    }
    grant.privileges.push(row.privilege_type);
    if (row.is_grantable) grant.grantable.push(row.privilege_type);
  }

  const privileges: PrivilegeSnapshot[] = Array.from(privilegesByKey.values());
  for (const entry of privileges) {
    entry.grants.sort((a, b) => a.grantee.localeCompare(b.grantee));
    for (const grant of entry.grants) {
      grant.privileges = sortPrivileges(grant.privileges);
      grant.grantable = sortPrivileges(grant.grantable);
    }
    entry.definition = buildPrivilegeDefinition(entry.owner, entry.grants);
    entry.normalizedDefinition = normalizeDefinition(entry.definition);
  }
  return privileges;
}
