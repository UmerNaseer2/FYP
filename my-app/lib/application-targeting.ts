// Restricting a migration to particular applications.
//
// Spec feature 11: "Apply scripts only to target databases by reading
// application_name from ApplicationTable; some scripts may be restricted to
// specific applications."
//
// One database can host more than one application's tables, and the same
// script registry can serve several databases. A migration that belongs to
// the billing application has no business running against the database that
// only hosts reporting — it will either fail on tables that are not there or,
// worse, succeed against tables of the same name that belong to something
// else.
//
// The two halves of the check:
//
//   • the script says who it is for, in its header — the same stamped-comment
//     convention lib/change-type.ts uses, for the same reasons: it is inert
//     SQL wherever the file ends up, it travels with the file through GitHub,
//     and reading it never depends on the prose around it. Unlike Change-type
//     it is written by the author in the SQL and never stamped on push:
//     Change-type is stamped because the editor asks for the level in a field
//     of its own, and a header disagreeing with that field would decide the
//     run. There is no such field here, so there is nothing to disagree with
//     and this module only ever reads.
//   • the target says what it hosts, in a table the connection names. This
//     module does not read that table (it is pure); it is given what was read.
//
// Pure on purpose — no DB, no fetch, no React — because the same answer has to
// be reached in three places that cannot share a runtime: the deploy screen
// (to grey a script out before anybody presses anything), the apply route (to
// refuse it), and the editor (to show the author what they have written).

/**
 * The header line a script carries to say which applications it is for.
 *
 * Deliberately the same shape as "-- Change-type:", so an author reading one
 * header already knows how to read the other.
 */
export const APPLIES_TO_HEADER_KEY = "Applies-to";

const HEADER_PATTERN = new RegExp(`^\\s*--\\s*${APPLIES_TO_HEADER_KEY}\\s*:(.*)$`, "i");

/**
 * Match application names the way people actually type them: case and
 * surrounding spaces are not part of the name. Everything else is — a name
 * with an underscore is not the same application as one with a hyphen, and
 * guessing that it is would run a script against the wrong database.
 */
export function normalizeAppName(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * The applications a script is restricted to, or null when it carries no
 * restriction and may run anywhere.
 *
 * Null and [] are different answers and must stay that way. Null is "this
 * script says nothing about applications", which is every script written
 * before this existed and most scripts after it. [] is "this script says it
 * is for no applications", which is a header somebody got wrong — and is
 * reported as a restriction that nothing satisfies rather than quietly read as
 * "no restriction", because reading a broken restriction as permission is how
 * a script ends up running on every database at once.
 *
 * Only the header is read — the lines before the first statement — so a line
 * of the same shape further down the file cannot change the answer.
 */
export function readAppliesToHeader(sql: string): string[] | null {
  for (const line of (sql ?? "").split(/\r?\n/)) {
    const match = line.match(HEADER_PATTERN);
    if (match) {
      return match[1]
        .split(",")
        .map((name) => name.trim())
        .filter((name) => name.length > 0);
    }
    // Past the header: anything that is neither blank nor a comment is body.
    const trimmed = line.trim();
    if (trimmed.length > 0 && !trimmed.startsWith("--")) return null;
  }
  return null;
}

/** What the target reports about itself, as far as this check cares. */
export type TargetApplications = {
  /**
   * Was the application table found and read? False when the connection names
   * no table, or names one that is not there.
   */
  known: boolean;
  /** The application names read from it. Empty when the table has no rows. */
  names: string[];
  /** The table it was read from, for saying so on screen. Null when not read. */
  source: string | null;
};

export type ApplicationVerdict = {
  /** May this script run against this target? */
  allowed: boolean;
  /**
   * Why, in one sentence the reader can act on — including when allowed, so
   * the screen can say "restricted to billing, which this target hosts"
   * rather than just letting it through silently. Null only for the ordinary
   * case: an unrestricted script, where there is nothing to say.
   */
  reason: string | null;
};

/**
 * May this script run here?
 *
 * The rules, and why each one is the way round it is:
 *
 *   • No restriction → yes. Most scripts are not restricted, and requiring
 *     every script to name its application would mean the feature could not
 *     be turned on without rewriting the whole registry first.
 *   • Restricted, and the target hosts one of the named applications → yes.
 *     One match is enough: a database hosting billing and reporting is a
 *     billing database.
 *   • Restricted, and the target's applications are KNOWN not to include any
 *     of them → no. This is the case the feature exists for.
 *   • Restricted, and the target's applications are NOT known → no. This is
 *     the decision worth arguing about, and it goes this way because the
 *     alternative is running a script that says it is only for one
 *     application against a database nobody can confirm is that application.
 *     A restriction that stops applying the moment the lookup fails is not a
 *     restriction. Unrestricted scripts are unaffected, so a target with no
 *     application table deploys exactly as it did before.
 *   • Restricted to nothing at all (an empty header) → no, and the reason
 *     says the header is the problem rather than the target.
 */
export function checkApplications(
  restrictedTo: string[] | null,
  target: TargetApplications
): ApplicationVerdict {
  if (restrictedTo === null) return { allowed: true, reason: null };

  const listed = restrictedTo.join(", ");

  if (restrictedTo.length === 0) {
    return {
      allowed: false,
      reason:
        `This script's "${APPLIES_TO_HEADER_KEY}" header names no applications, so there is ` +
        `no target it can run against. Either list the applications it is for, or remove the ` +
        `header to let it run anywhere.`,
    };
  }

  if (!target.known) {
    return {
      allowed: false,
      reason:
        `This script is restricted to ${listed}, and this connection has no application table ` +
        `to check that against — so nothing here can confirm this database is one of them. ` +
        `Name the table on the connection, or remove the restriction from the script.`,
    };
  }

  const hosted = new Set(target.names.map(normalizeAppName));
  const match = restrictedTo.find((name) => hosted.has(normalizeAppName(name)));
  if (match !== undefined) {
    return {
      allowed: true,
      reason:
        `Restricted to ${listed}; ${target.source ?? "the application table"} says this ` +
        `database hosts ${match}.`,
    };
  }

  return {
    allowed: false,
    reason:
      `This script is restricted to ${listed}, and ` +
      (target.names.length === 0
        ? `${target.source ?? "the application table"} on this database is empty, so it does ` +
          `not name any of them.`
        : `${target.source ?? "the application table"} says this database hosts ` +
          `${target.names.join(", ")}.`),
  };
}

/**
 * The SQL that reads a target's application names.
 *
 * Kept here beside the check so the column this feature depends on is named
 * once. `table` must already be a quoted, schema-qualified identifier — this
 * function does no quoting, because it does not know the target's schema
 * rules and a half-quoting helper is worse than none.
 *
 * DISTINCT because an application table commonly has a row per deployment
 * rather than per application, and the check only cares which names appear.
 */
export function applicationNamesSql(quotedTable: string): string {
  return `SELECT DISTINCT application_name FROM ${quotedTable} WHERE application_name IS NOT NULL`;
}
