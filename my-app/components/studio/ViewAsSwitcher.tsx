"use client";

import { useEffect, useId, useState } from "react";
import { useUser } from "@/hooks/useUser";
import { ADMIN_ROLE } from "@/lib/permissions";
import { apiFetch } from "@/lib/api-fetch";

type RoleOption = { name: string; label: string };

const LOAD_FAILED = "Could not load the roles. Try again in a moment.";
const SAVE_FAILED = "Could not switch roles. Try again in a moment.";

/**
 * Fired on the window by the Roles tab once it has made or deleted a role, so
 * the picker loads its list again.
 *
 * The picker sits on the rail, and the rail stays on screen from one page to
 * the next, so without this it would keep the list it loaded when the app
 * opened. A role made a minute ago on the Admin page is usually the very one
 * someone wants to view the app as next, and it would not be offered until
 * the page was reloaded.
 */
export const ROLES_CHANGED_EVENT = "studio:roles-changed";

/** Tell the View as picker that a role was made or deleted. */
export function announceRolesChanged() {
  window.dispatchEvent(new Event(ROLES_CHANGED_EVENT));
}

function isRoleOption(value: unknown): value is RoleOption {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as RoleOption).name === "string" &&
    typeof (value as RoleOption).label === "string"
  );
}

/**
 * "View as", on the studio rail while authentication is off.
 *
 * With the bypass on nobody signs in, so there is no way to sign in as a
 * viewer and see what a viewer sees, which is how anyone checks that a role's
 * boxes on the Admin screen do what they say. This picker is that check. It
 * asks POST /api/me/view-as to leave a cookie naming the role, and from then on
 * the server answers every request as that role (bypassPrincipal in
 * lib/auth-guard.ts) and every screen shows what that role may use.
 * "Admin (everything)" clears the cookie and puts the bypass back to the full
 * admin it normally is.
 *
 * The page reloads after a switch, because every screen read what the role may
 * do when it loaded, and half a page drawn for the old role is worse than a
 * reload. The routes answer 404 unless the bypass is on, so with real sign-in
 * there is nothing to switch even if this were drawn.
 *
 * The list of roles is loaded when the picker first appears, and again each
 * time the Roles tab makes or deletes one (ROLES_CHANGED_EVENT above).
 */
export function ViewAsSwitcher() {
  const id = useId();
  const { viewingAs, roleLabel, loading } = useUser();
  const [roles, setRoles] = useState<RoleOption[] | null>(null);
  // Kept apart, so loading the list again can clear a problem with the list
  // without hiding why a switch just failed.
  const [listProblem, setListProblem] = useState<string | null>(null);
  const [switchProblem, setSwitchProblem] = useState<string | null>(null);
  // The role asked for while the switch is on its way, so the picker shows it
  // and cannot be changed again until the page reloads.
  const [picked, setPicked] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    // Only the newest answer counts. Two loads can be on their way at once,
    // and an older answer arriving last would put back the list from before
    // the change.
    let newest = 0;
    async function load() {
      const ticket = ++newest;
      try {
        const response = await apiFetch("/api/me/view-as", { cache: "no-store" });
        const body = await response.json().catch(() => null);
        if (cancelled || ticket !== newest) return;
        if (response.ok && body && Array.isArray(body.roles)) {
          setRoles(body.roles.filter(isRoleOption));
          setListProblem(null);
        } else {
          setListProblem(typeof body?.error === "string" ? body.error : LOAD_FAILED);
        }
      } catch {
        if (!cancelled && ticket === newest) setListProblem(LOAD_FAILED);
      }
    }
    const reload = () => void load();
    reload();
    window.addEventListener(ROLES_CHANGED_EVENT, reload);
    return () => {
      cancelled = true;
      window.removeEventListener(ROLES_CHANGED_EVENT, reload);
    };
  }, []);

  async function choose(role: string) {
    setPicked(role);
    setSwitchProblem(null);
    try {
      const response = await apiFetch("/api/me/view-as", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role }),
      });
      if (response.ok) {
        window.location.reload();
        return;
      }
      const body = await response.json().catch(() => null);
      setSwitchProblem(typeof body?.error === "string" ? body.error : SAVE_FAILED);
    } catch {
      setSwitchProblem(SAVE_FAILED);
    }
    setPicked(null);
  }

  // Admin is always offered first, whatever the list says, so a list that
  // fails to load can never leave someone stuck viewing the app as a role.
  const listed = (roles ?? []).filter((role) => role.name !== ADMIN_ROLE);
  // The role being viewed stays in the list even when the list did not load,
  // so the picker can still say which one it is.
  const options =
    viewingAs && !listed.some((role) => role.name === viewingAs)
      ? [...listed, { name: viewingAs, label: roleLabel }]
      : listed;

  // A failed switch is the newer news, so it is the one said.
  const problem = switchProblem ?? listProblem;

  return (
    <div className="flex flex-col gap-1">
      <label className="section-title" htmlFor={id}>
        View as
      </label>
      <select
        id={id}
        className="input"
        style={{ padding: "4px 8px", fontSize: 12 }}
        title="For testing: shows the app the way this role sees it. Only there while authentication is off."
        value={loading ? "" : (picked ?? viewingAs ?? ADMIN_ROLE)}
        disabled={loading || picked !== null}
        onChange={(event) => void choose(event.target.value)}
      >
        {loading ? (
          // Until the role in the cookie has been looked up, saying "Admin"
          // here would be a guess, and so would anything else.
          <option value="">Checking…</option>
        ) : (
          <>
            <option value={ADMIN_ROLE}>Admin (everything)</option>
            {options.map((role) => (
              <option key={role.name} value={role.name}>
                {role.label}
              </option>
            ))}
          </>
        )}
      </select>
      {problem && (
        <div className="text-[11px]" role="status" style={{ color: "var(--text-3)" }}>
          {problem}
        </div>
      )}
    </div>
  );
}
