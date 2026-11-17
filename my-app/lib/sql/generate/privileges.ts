// Ownership and grants: OWNER TO, GRANT and REVOKE statements.

import type { PrivilegeObjectKind, PrivilegeSnapshot } from "../../postgres";
import { q } from "./basics";
import { objectStatement } from "./statement-helpers";
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

/** "table orders", "function f(integer)" — the same words the report uses. */
function privilegeLabel(privilege: PrivilegeSnapshot): string {
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

function ownerStatement(
  privilege: PrivilegeSnapshot,
  targetSchema: string,
  previousOwner: string | null
): SqlStatement {
  const label = privilegeLabel(privilege);
  const moved =
    previousOwner === null ? "" : ` (was ${quoteRoleText(previousOwner)})`;
  return objectStatement({
    sql:
      `ALTER ${ALTER_OBJECT_WORD[privilege.objectKind]} ` +
      `${privilegeObjectSql(privilege, targetSchema)} ` +
      `OWNER TO ${q(privilege.owner)};`,
    description: `Set owner of ${label} to ${quoteRoleText(privilege.owner)}${moved}`,
    kind: "ALTER_OWNER",
    // Breaking only when it is taken off somebody. On an object the script has
    // just created there is no previous owner to lose anything.
    severity: previousOwner === null ? "info" : "breaking",
    tableName: privilege.objectName,
  });
}

function grantStatement(
  privilege: PrivilegeSnapshot,
  targetSchema: string,
  role: string,
  privileges: string[],
  withGrantOption: boolean
): SqlStatement {
  const label = privilegeLabel(privilege);
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
  });
}

function revokeStatement(
  privilege: PrivilegeSnapshot,
  targetSchema: string,
  role: string,
  privileges: string[],
  optionOnly: boolean
): SqlStatement {
  const label = privilegeLabel(privilege);
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
 */
export function privilegeStatements(
  source: PrivilegeSnapshot,
  target: PrivilegeSnapshot | null,
  targetSchema: string,
  heldBack: boolean
): SqlStatement[] {
  const statements: SqlStatement[] = [];

  if (target === null || source.owner !== target.owner) {
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
