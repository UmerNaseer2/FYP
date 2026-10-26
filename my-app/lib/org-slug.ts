/**
 * The shape of an organization's slug, the part of its address after the
 * domain: lowercase letters, digits and dashes, 3 to 40 characters, starting
 * and ending with a letter or digit.
 *
 * Written once so the CHECK constraint in lib/db/bootstrap.ts and anything in
 * the app that validates a slug agree, the same way ENVIRONMENT_SQL_LIST there
 * is built from lib/environments.
 */
export const ORG_SLUG_PATTERN = "^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$";
