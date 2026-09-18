// ---------------------------------------------------------------------------
// connection-access.ts
// Which role may RUN something against a particular database.
//
// Spec feature 02: "Role-based connection access — execution permission control
// (read-only, deployment roles)."
//
// The app already had roles (lib/auth-mode) and every route already checked
// one (lib/auth-guard). What neither could express is that the same person is
// trusted differently depending on WHICH database is on the other end. An
// editor who should be free to apply migrations to dev all day is the same
// editor the moment the target is production, because the role is a property of
// the person and the environment label is only a warning.
//
// So a connection carries the role required to execute against it, and
// "nobody" is one of the answers. That is the read-only case in the spec: a
// reference or model schema that this app may compare, introspect and generate
// scripts from, but must never write to — not for an editor, and not for an
// admin either, because a read-only database is a fact about the database
// rather than a rank to be outranked.
//
// Pure: no database, no React, no next-auth. The connections screen imports it
// to draw the picker, and the apply and revert routes import it to refuse.
// ---------------------------------------------------------------------------

import { ROLES, type Role } from "./auth-mode";

/**
 * The role that may execute against a connection, lowest privilege first.
 *
 * Deliberately NOT the Role union with an extra member. A Role is something a
 * person can be; these are requirements placed on a database, and "none" is a
 * requirement no person satisfies. Sharing the type would make
 * `roleAtLeast(someRole, "none")` compile, and it would answer true.
 */
export const EXECUTE_ROLES = ["none", "editor", "admin"] as const;
export type ExecuteRole = (typeof EXECUTE_ROLES)[number];

/**
 * What a connection gets when nobody has said otherwise.
 *
 * "editor" and not "none": every connection that existed before this column
 * did was one an editor could already deploy to, and a migration that silently
 * locked all of them would read as the app breaking rather than as a policy.
 * The stricter settings are opt-in, which is the direction that cannot lose
 * somebody work they had yesterday.
 */
export const DEFAULT_EXECUTE_ROLE: ExecuteRole = "editor";

/** Narrow an arbitrary string — a database value, a form field — to a setting. */
export function toExecuteRole(value: unknown): ExecuteRole {
  return (EXECUTE_ROLES as readonly string[]).includes(String(value))
    ? (String(value) as ExecuteRole)
    : DEFAULT_EXECUTE_ROLE;
}

/**
 * May somebody with this role run a migration against this connection?
 *
 * "none" is checked first and separately, rather than being ranked below
 * "editor", because ranking it would make it the weakest requirement — and the
 * weakest requirement is the one everybody meets. It is meant to be the one
 * nobody does.
 */
export function canExecute(actual: Role, required: ExecuteRole): boolean {
  if (required === "none") return false;
  return ROLES.indexOf(actual) >= ROLES.indexOf(required);
}

/** The setting as a phrase for a picker. */
export function describeExecuteRole(required: ExecuteRole): string {
  switch (required) {
    case "none":
      return "Read-only — nobody may run migrations here";
    case "admin":
      return "Admins only";
    default:
      return "Editors and admins";
  }
}

/** A short badge for a connection row. Null for the default, which needs none. */
export function executeRoleBadge(required: ExecuteRole): string | null {
  switch (required) {
    case "none":
      return "Read-only";
    case "admin":
      return "Admins only";
    default:
      return null;
  }
}

/**
 * Why a run was refused, addressed to the person who tried it.
 *
 * One function so the sentence is the same wherever it appears — the route that
 * refuses, and the button that greys itself out before anyone presses it. Two
 * wordings for the same rule is how a user ends up believing there are two
 * rules.
 *
 * It names the connection and the setting rather than just saying "denied",
 * because the reader can usually fix this: either they are on the wrong
 * connection, or somebody has to change the setting on the right one. Neither
 * is discoverable from "403".
 */
export function executeRefusal(
  connectionName: string,
  actual: Role,
  required: ExecuteRole,
): string {
  if (required === "none") {
    return (
      `"${connectionName}" is marked read-only, so this app will not run migrations ` +
      `against it. Comparing, generating scripts and exporting all still work. ` +
      `Change the setting on the connection if this database is meant to be deployed to.`
    );
  }
  return (
    `Running migrations against "${connectionName}" needs the "${required}" role. ` +
    `Yours is "${actual}". Ask an admin to change your role, or to lower the ` +
    `requirement on this connection.`
  );
}
