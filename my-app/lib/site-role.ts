/**
 * The website role a linked desktop works within (docs/two-way-sync-plan.md,
 * step 3).
 *
 * While a desktop is linked to a website, its person can do on the desktop
 * only what their role on the website lets them do, and never more than their
 * role on the desktop already does. The website sends the role with every
 * changed sync answer (lib/agent-sync.ts), the desktop's main process hands it
 * to this computer's own server (app/api/desktop/sync), and it is kept in the
 * default organization's row, so it holds while the website cannot be reached
 * and across restarts. Unlinking clears it, which gives the desktop's own role
 * back in full.
 *
 * Only the desktop reads it, in lib/auth-guard.ts. A website never stores one.
 */
import pool, { syncMetadataTables } from "@/lib/version-db";
import type { Principal } from "@/lib/auth-guard";
import { ADMIN_ROLE, isPermissionKey, type PermissionKey } from "@/lib/permissions";

/** A role as the website describes it to a linked desktop. */
export type SiteRole = { role: string; label: string; permissions: PermissionKey[] };

export const LONGEST_SITE_ROLE_KEY = 64;
export const LONGEST_SITE_ROLE_LABEL = 100;
/** Far more than there are permissions, so a website a few versions ahead still fits. */
export const MOST_SITE_ROLE_PERMISSIONS = 200;

/** The role a principal holds, the way the website sends it. */
export function siteRoleOf(principal: Principal): SiteRole {
  return { role: principal.role, label: principal.roleLabel, permissions: [...principal.permissions] };
}

/**
 * A role the website sent, or null when it cannot be read. Permissions this
 * version does not know are left out: a desktop never takes a key it cannot
 * check.
 */
export function readSiteRole(value: unknown): SiteRole | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const { role, label, permissions } = value as Record<string, unknown>;
  if (typeof role !== "string" || role.trim() === "" || role.length > LONGEST_SITE_ROLE_KEY) return null;
  if (typeof label !== "string" || label.length > LONGEST_SITE_ROLE_LABEL) return null;
  if (!Array.isArray(permissions) || permissions.length > MOST_SITE_ROLE_PERMISSIONS) return null;
  if (!permissions.every((key) => typeof key === "string" && key.length <= LONGEST_SITE_ROLE_KEY)) return null;
  return {
    role: role.trim(),
    label: label.trim() || role.trim(),
    permissions: [...new Set(permissions.filter(isPermissionKey))],
  };
}

/**
 * `principal`, held to what the website role allows.
 *
 * The permissions are the ones both roles have, so the website can take away
 * but never add. An Admin on the website is not held back at all: the
 * website has no say over what the desktop's own Admin may do, and a desktop
 * a version ahead knows keys the website cannot send yet.
 *
 * When the website role takes something away, the principal carries its name
 * too, so a refusal says why ("Your role (Viewer on the website) can't ...").
 * The role key is never the Admin's then, so nothing that checks for an Admin
 * by its key lets them through.
 */
export function applySiteRole(principal: Principal, site: SiteRole | null): Principal {
  if (site === null || site.role === ADMIN_ROLE) return principal;
  const allowed = new Set<string>(site.permissions);
  const permissions = principal.permissions.filter((key) => allowed.has(key));
  if (permissions.length === principal.permissions.length) return principal;
  return {
    ...principal,
    role: site.role,
    roleLabel: `${site.label} on the website`,
    permissions,
  };
}

/**
 * The website role kept for this organization, or null when there is none
 * (not linked, or a website from before roles were sent). Throws when the
 * row cannot be read, and when what it holds cannot: the caller answers 503
 * rather than guess, until the next sync writes it again or the person
 * unlinks in Settings.
 */
export async function loadSiteRole(orgId: number): Promise<SiteRole | null> {
  await syncMetadataTables();
  const { rows } = await pool.query<{ site_role: unknown }>(`SELECT site_role FROM organizations WHERE id = $1`, [orgId]);
  const stored = rows[0]?.site_role ?? null;
  if (stored === null) return null;
  const role = readSiteRole(stored);
  if (role === null) throw new Error("The website role kept for this computer could not be read.");
  return role;
}

/** Keeps the website role for this organization, or clears it with null. */
export async function saveSiteRole(orgId: number, role: SiteRole | null): Promise<void> {
  await syncMetadataTables();
  await pool.query(`UPDATE organizations SET site_role = $2::jsonb WHERE id = $1`, [
    orgId,
    role === null ? null : JSON.stringify(role),
  ]);
}
