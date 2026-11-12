// The shared trial organization: what it is called, who is in it, and what
// nobody in it may do.
//
// The trial is one organization, "trial", with three fixed accounts in it:
// Trial Admin, Trial Editor and Trial Viewer. The landing page signs a
// visitor in as one of them with a single click, with no Microsoft or GitHub
// account, so the app can be shown to people and handed to testers. Everyone
// who picks the same account is the same person, in the same organization, so
// what one tester does the others see.
//
// It is switched on with TRIAL_SANDBOX=on, on the website only. The desktop
// app never offers it.
//
// Anyone on the internet can be these three people, so the organization is
// locked down: nothing in it can reach a database other than its own three
// demo ones, change who is in it or what a role may do, take a GitHub token
// or an AI key, or be deleted. lib/trial-sandbox.ts builds it, and puts it
// back to how it started every night.
//
// Pure: no database. auth-guard, the routes and the landing page import it.

import type { PermissionKey } from "./permissions";

/** The trial organization's address, "/trial". */
export const TRIAL_ORG_SLUG = "trial";

/** Its name, as the organization switcher shows it. */
export const TRIAL_ORG_NAME = "Schema Studio Trial";

/**
 * The domain of the three trial accounts' addresses. ".invalid" is set aside
 * for names that can never exist (RFC 2606), so no real person can sign in
 * with Microsoft or GitHub under one, and no invitation sent to one can arrive.
 */
export const TRIAL_EMAIL_DOMAIN = "trial.schema-studio.invalid";

/** The three accounts, one for each built-in role, in the order the landing page shows them. */
export const TRIAL_ROLES = ["admin", "editor", "viewer"] as const;
export type TrialRole = (typeof TRIAL_ROLES)[number];

export const TRIAL_PEOPLE: Record<TrialRole, { email: string; name: string }> = {
  admin: { email: `admin@${TRIAL_EMAIL_DOMAIN}`, name: "Trial Admin" },
  editor: { email: `editor@${TRIAL_EMAIL_DOMAIN}`, name: "Trial Editor" },
  viewer: { email: `viewer@${TRIAL_EMAIL_DOMAIN}`, name: "Trial Viewer" },
};

/** A role the landing page may ask for, or null for anything else. */
export function toTrialRole(value: unknown): TrialRole | null {
  return (TRIAL_ROLES as readonly unknown[]).includes(value) ? (value as TrialRole) : null;
}

/** True when this server offers the trial: TRIAL_SANDBOX=on, and never in the desktop app. */
export function trialEnabled(): boolean {
  return process.env.TRIAL_SANDBOX === "on" && process.env.SCHEMA_STUDIO_DESKTOP !== "1";
}

/**
 * True for the trial organization on a server that offers the trial. On a
 * server without the trial, an organization that happens to be called "trial"
 * is just an organization.
 */
export function isTrialOrg(slug: string | null | undefined): boolean {
  return slug === TRIAL_ORG_SLUG && trialEnabled();
}

/** True for one of the three trial accounts' addresses. */
export function isTrialEmail(email: string | null | undefined): boolean {
  return typeof email === "string" && email.toLowerCase().endsWith(`@${TRIAL_EMAIL_DOMAIN}`);
}

/**
 * What nobody in the trial may do, whatever their role says.
 *
 * Connections: the three demo databases are the only ones, so nobody can
 * point the app at a database of their choosing (or see one somebody else
 * typed in). People and roles: the three accounts are fixed, and an Admin
 * rearranging what a role may do would change the trial for everyone after.
 * The organization's settings, its GitHub token and its deletion: shared by
 * everyone, so nobody gets to change them.
 */
export const TRIAL_BLOCKED_PERMISSIONS: ReadonlySet<PermissionKey> = new Set<PermissionKey>([
  "connections:create",
  "connections:update",
  "connections:delete",
  "users:create",
  "users:update",
  "users:delete",
  "roles:create",
  "roles:update",
  "roles:delete",
  "organization:update",
  "organization:delete",
  "github:update",
]);

/** A role's permissions with the trial's blocked ones taken out. */
export function trialPermissions(permissions: readonly PermissionKey[]): PermissionKey[] {
  return permissions.filter((key) => !TRIAL_BLOCKED_PERMISSIONS.has(key));
}

/** The refusal for something the trial switches off, for every role in it. */
export const TRIAL_REFUSAL =
  "This is the shared trial organization, so that is switched off here. Sign in with your own account to do it in an organization of your own.";
