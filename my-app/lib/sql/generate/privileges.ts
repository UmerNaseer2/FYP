// Ownership and grants: OWNER TO, GRANT and REVOKE statements.

import type { PrivilegeObjectKind, PrivilegeSnapshot } from "../../postgres";
import { q } from "./basics";
import { dollarTagFor, literal, objectStatement } from "./statement-helpers";
import type { SqlStatement } from "./types";

// ---------------------------------------------------------------------------
// Ownership and grants
// ---------------------------------------------------------------------------

/**
 * How GRANT names each kind of object, which is not always how CREATE names it.
 *
 * The one that catches people: GRANT has no VIEW. A view and a materialized
 * view are both granted `ON TABLE`, and writing `ON VIEW` is a syntax error.
 */
const GRANT_OBJECT_WORD: Record<PrivilegeObjectKind, string> = {
  TABLE: "TABLE",
  VIEW: "TABLE",
  "MATERIALIZED VIEW": "TABLE",
  SEQUENCE: "SEQUENCE",
  FUNCTION: "FUNCTION",
  PROCEDURE: "PROCEDURE",
  SCHEMA: "SCHEMA",
};

/** How ALTER names each kind, which for a view is not how GRANT names it. */
const ALTER_OBJECT_WORD: Record<PrivilegeObjectKind, string> = {
  TABLE: "TABLE",
  VIEW: "VIEW",
  "MATERIALIZED VIEW": "MATERIALIZED VIEW",
  SEQUENCE: "SEQUENCE",
  FUNCTION: "FUNCTION",
  PROCEDURE: "PROCEDURE",
  SCHEMA: "SCHEMA",
};

/**
 * The object as GRANT and ALTER have to spell it: quoted name, and for a
 * routine the argument list after it, unquoted.
 *
 * `targetSchema` is used for, and only for, the SCHEMA entry. Everything else
 * in this generator is written unqualified because the apply route sets search_path
 * to the target schema first — but there is no unqualified way to name a
 * schema, and the name the snapshot carries is the SOURCE's. Writing that one
 * would grant on whichever schema the source happened to be called, which on a
 * two-schema comparison inside one database is a live and silent mis-grant.
 */
function privilegeObjectSql(
  privilege: PrivilegeSnapshot,
  targetSchema: string
): string {
  if (privilege.objectKind === "SCHEMA") return q(targetSchema);
  const args =
    privilege.identityArguments === undefined
      ? ""
      : `(${privilege.identityArguments})`;
  return `${q(privilege.objectName)}${args}`;
}

/**
 * "table orders", "function f(integer)": the same words the report uses.
 *
 * A schema goes by the target's name, for the reason privilegeObjectSql gives:
 * the snapshot carries the source's, so on a comparison between two schemas the
 * description and the owner warning named the schema being copied from.
 */
function privilegeLabel(privilege: PrivilegeSnapshot, targetSchema: string): string {
  if (privilege.objectKind === "SCHEMA") return `schema ${targetSchema}`;
  const args =
    privilege.identityArguments === undefined
      ? ""
      : `(${privilege.identityArguments})`;
  return `${privilege.objectKind.toLowerCase()} ${privilege.objectName}${args}`;
}

/**
 * PUBLIC is a keyword in GRANT, not a role name, so quoting it turns a grant to
 * everybody into a grant to a role called "public" that does not exist.
 */
function grantee(name: string): string {
  return name.toUpperCase() === "PUBLIC" ? "PUBLIC" : q(name);
}

/** The same distinction for prose, where the quotes are only decoration. */
function quoteRoleText(name: string): string {
  return name.toUpperCase() === "PUBLIC" ? "PUBLIC" : `"${name}"`;
}

/**
 * ALTER ... OWNER TO, written so that a login without the right to give the
 * object away skips this one change instead of stopping the whole deploy.
 *
 * Only a superuser, or a login that may act as the new owner (SET ROLE to it,
 * or on PostgreSQL 15 and older be a member of it), may hand an object to
 * another role. A plain login that owns the schema, like the reader login the
 * setup guide makes, can run everything else a script holds but not that. The
 * apply route runs a script in one transaction, so one refused OWNER TO used
 * to undo every change before it: a deploy as that login stopped on
 * 'must be able to SET ROLE "postgres"'.
 *
 * The EXCEPTION clause catches insufficient_privilege (42501) only, the code
 * PostgreSQL gives every "not allowed" answer here. The object keeps its
 * owner, PostgreSQL sends a warning that names it, the rest of the script
 * runs, and the next comparison shows the owner as a difference. Any other
 * error still stops the deploy, such as a role that does not exist (42704),
 * which the role warning in migration.ts tells people to create first.
 *
 * The ALTER is written out in the block, not run from a string, so the
 * deploy grade and the guard still read it.
 */
function ownerStatement(
  privilege: PrivilegeSnapshot,
  targetSchema: string,
  previousOwner: string | null
): SqlStatement {
  const label = privilegeLabel(privilege, targetSchema);
  const moved =
    previousOwner === null ? "" : ` (was ${quoteRoleText(previousOwner)})`;
  const alter =
    `ALTER ${ALTER_OBJECT_WORD[privilege.objectKind]} ` +
    `${privilegeObjectSql(privilege, targetSchema)} ` +
    `OWNER TO ${q(privilege.owner)};`;
  const body = [
    "BEGIN",
    `  ${alter}`,
    "EXCEPTION WHEN insufficient_privilege THEN",
    // RAISE takes a format string, so the label goes in as an argument: a name
    // holding a % would otherwise be read as a placeholder.
    `  RAISE WARNING 'The owner of % was not changed: %', ${literal(label)}, SQLERRM;`,
    "END",
  ].join("\n");
  const tag = dollarTagFor(body);
  return objectStatement({
    sql: `DO ${tag}\n${body}\n${tag};`,
    description: `Set owner of ${label} to ${quoteRoleText(privilege.owner)}${moved}`,
    kind: "ALTER_OWNER",
    // Breaking only when it is taken off somebody. On an object the script has
    // just created there is no previous owner to lose anything.
    severity: previousOwner === null ? "info" : "breaking",
    tableName: privilege.objectName,
    role: privilege.owner,
  });
}

function grantStatement(
  privilege: PrivilegeSnapshot,
  targetSchema: string,
  role: string,
  privileges: string[],
  withGrantOption: boolean
): SqlStatement {
  const label = privilegeLabel(privilege, targetSchema);
  const option = withGrantOption ? " WITH GRANT OPTION" : "";
  return objectStatement({
    sql:
      `GRANT ${privileges.join(", ")} ON ` +
      `${GRANT_OBJECT_WORD[privilege.objectKind]} ` +
      `${privilegeObjectSql(privilege, targetSchema)} ` +
      `TO ${grantee(role)}${option};`,
    description:
      `Grant ${privileges.join(", ")} on ${label} to ${quoteRoleText(role)}` +
      (withGrantOption ? ", who may pass it on" : ""),
    kind: "GRANT",
    // A GRANT cannot fail on the rows already there and takes nothing from
    // anybody, which is the definition of safe in this generator.
    severity: "safe",
    tableName: privilege.objectName,
    role,
  });
}

function revokeStatement(
  privilege: PrivilegeSnapshot,
  targetSchema: string,
  role: string,
  privileges: string[],
  optionOnly: boolean
): SqlStatement {
  const label = privilegeLabel(privilege, targetSchema);
  const what = optionOnly ? "GRANT OPTION FOR " : "";
  return objectStatement({
    sql:
      `REVOKE ${what}${privileges.join(", ")} ON ` +
      `${GRANT_OBJECT_WORD[privilege.objectKind]} ` +
      `${privilegeObjectSql(privilege, targetSchema)} ` +
      `FROM ${grantee(role)};`,
    description: optionOnly
      ? `Stop ${quoteRoleText(role)} passing on ${privileges.join(", ")} ` +
        `on ${label} — WARNING: anything they granted onwards goes with it`
      : `Revoke ${privileges.join(", ")} on ${label} from ${quoteRoleText(role)}` +
        " — WARNING: queries running under that role stop working",
    kind: "REVOKE",
    severity: "breaking",
    tableName: privilege.objectName,
    role,
    // Not `destructive`. Nothing is deleted, so "allow data loss" is the wrong
    // gate for it — but it is the change most likely to take an application
    // down, which is what the breaking grade above is for.
  });
}

/**
 * The statements that move one object's access from what the target has to what
 * the source has.
 *
 * `target` is null for an object the script is creating, where there is nothing
 * to compare against and every grant in the source is new.
 *
 * `ownerFollowsTable` is true for a sequence that a serial or identity column
 * owns. Such a sequence always has its table's owner: ALTER TABLE ... OWNER TO
 * moves it along, and PostgreSQL refuses to change its owner by itself
 * ("cannot change owner of sequence ... is linked to table ..."). Privilege
 * entries sort SEQUENCE before TABLE, so the sequence's own OWNER TO ran first
 * and stopped the whole deploy, which a client tester hit on a new table with
 * a serial id. Its grants are its own, so they are still written.
 */
export function privilegeStatements(
  source: PrivilegeSnapshot,
  target: PrivilegeSnapshot | null,
  targetSchema: string,
  heldBack: boolean,
  ownerFollowsTable = false
): SqlStatement[] {
  const statements: SqlStatement[] = [];

  if (!ownerFollowsTable && (target === null || source.owner !== target.owner)) {
    statements.push(ownerStatement(source, targetSchema, target?.owner ?? null));
  }

  const held = new Map((target?.grants ?? []).map((g) => [g.grantee, g]));
  const wanted = new Map(source.grants.map((g) => [g.grantee, g]));

  for (const grant of source.grants) {
    const has = held.get(grant.grantee);
    // Split by grant option rather than emitting one statement per privilege:
    // GRANT takes a list, and two statements read better than seven.
    const plain = grant.privileges.filter(
      (p) => !grant.grantable.includes(p) && !(has?.privileges ?? []).includes(p)
    );
    // Re-granting WITH GRANT OPTION is how the option is added to a privilege
    // the role already holds — there is no ALTER for it.
    const grantable = grant.grantable.filter(
      (p) => !(has?.grantable ?? []).includes(p)
    );
    if (plain.length > 0) {
      statements.push(
        grantStatement(source, targetSchema, grant.grantee, plain, false)
      );
    }
    if (grantable.length > 0) {
      statements.push(
        grantStatement(source, targetSchema, grant.grantee, grantable, true)
      );
    }
  }

  for (const grant of held.values()) {
    const keep = wanted.get(grant.grantee);
    const lose = grant.privileges.filter(
      (p) => !(keep?.privileges ?? []).includes(p)
    );
    if (lose.length > 0) {
      statements.push(
        revokeStatement(source, targetSchema, grant.grantee, lose, false)
      );
    }
    // A privilege they keep but may no longer hand on. REVOKE GRANT OPTION FOR
    // is the only statement that takes the option without taking the privilege.
    const loseOption = grant.grantable.filter(
      (p) => (keep?.privileges ?? []).includes(p) && !(keep?.grantable ?? []).includes(p)
    );
    if (loseOption.length > 0) {
      statements.push(
        revokeStatement(source, targetSchema, grant.grantee, loseOption, true)
      );
    }
  }

  // Every statement here assumes the object is in the state the source
  // describes. When safe mode holds back the drop that would have rebuilt it,
  // it is not: `ALTER VIEW "recent" OWNER TO ...` over a materialized view that
  // is still sitting there fails outright with "recent is not a view", and the
  // apply route runs the whole script in one transaction, so that one failure
  // rolls the entire migration back. Held back beside the drop instead.
  return heldBack
    ? statements.map((statement) => ({ ...statement, needsArmedDrop: true }))
    : statements;
}
