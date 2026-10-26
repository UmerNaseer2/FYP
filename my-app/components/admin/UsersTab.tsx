"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useUser } from "@/hooks/useUser";
import { BUILT_IN_ROLES, BUILT_IN_ROLE_INFO, isBuiltInRole } from "@/lib/permissions";
import {
  Button,
  Card,
  Pill,
  Skeleton,
  EmptyState,
  ConfirmDialog,
  type PillTone,
} from "@/components/ui";
import { Select } from "@/components/ui/Select";
import {
  UsersIcon,
  RefreshIcon,
  TrashIcon,
  AlertTriangleIcon,
  AlertCircleIcon,
  InfoIcon,
} from "@/components/ui/icons";
import { apiFetch } from "@/lib/api-fetch";

/**
 * The Users tab on the Admin screen: everyone who has signed in, the role each
 * one has, and a way to remove them.
 *
 * What each role may do is the Roles & permissions tab's business. This tab
 * only says who has which role.
 */

// Mirrors GET /api/admin/users.
type Profile = {
  id: number;
  email: string;
  role: string;
};

/** A role the picker on each row can offer: its key and the name people read. */
type RoleOption = { name: string; label: string };

function isRoleOption(value: unknown): value is RoleOption {
  if (typeof value !== "object" || value === null) return false;
  const option = value as Record<string, unknown>;
  return typeof option.name === "string" && typeof option.label === "string";
}

// The three roles every install has, for the moment before the server has
// said which roles exist. Custom roles come from the server with the list.
const BUILT_IN_OPTIONS: RoleOption[] = BUILT_IN_ROLES.map((name) => ({
  name,
  label: BUILT_IN_ROLE_INFO[name].label,
}));

function roleTone(role: string): PillTone {
  // The middle role gets its own colour, so it doesn't read as "not an admin".
  return role === "admin" ? "brand" : role === "editor" ? "sync" : "neutral";
}

function initialsOf(email: string): string {
  return email.slice(0, 2).toUpperCase();
}

export function UsersTab({ active }: { active: boolean }) {
  const { user: currentUser, can, bypass } = useUser();

  const [users, setUsers] = useState<Profile[]>([]);
  const [roles, setRoles] = useState<RoleOption[]>([]);
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [updating, setUpdating] = useState<number | null>(null);
  const [deleting, setDeleting] = useState<number | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [removeTarget, setRemoveTarget] = useState<Profile | null>(null);

  // Counts every load and every change. A list whose number is no longer the
  // latest when it arrives is thrown away: a newer load overtook it, or a
  // change was made after it was asked for, and showing it would put back
  // what that change just replaced.
  const latest = useRef(0);
  // True while a change is being saved. A list asked for in the middle of a
  // save may or may not have the change in it, so coming back to the tab then
  // does not reload it (the Refresh button is disabled for the same reason).
  const saving = useRef(false);
  // True once a list has been shown. After that a reload keeps it on screen
  // instead of going back to the loading skeleton.
  const loaded = useRef(false);

  // `quiet` keeps the current list on screen while the new one loads, and a
  // failure then only shows the message above it. A load that put the
  // skeleton up must take it down again, with the list or with the error.
  const fetchUsers = useCallback(async (quiet: boolean) => {
    const mine = ++latest.current;
    if (!quiet) setPhase("loading");
    setActionError(null);
    // The reason is said once: above the list a quiet reload kept on screen,
    // or in place of the list when there is none to keep.
    const fail = (text: string) => {
      if (quiet) {
        setActionError(text);
      } else {
        setLoadError(text);
        setPhase("error");
      }
    };
    try {
      const res = await apiFetch("/api/admin/users", { cache: "no-store" });
      // A reply that is not JSON (a proxy's error page) still gets its status
      // read below, rather than reading as a network error.
      const data = await res.json().catch(() => ({}));
      if (mine !== latest.current) return;
      if (!res.ok) {
        fail(data.error ?? "Could not load users.");
        return;
      }
      setUsers(Array.isArray(data.users) ? data.users : []);
      setRoles(Array.isArray(data.roles) ? data.roles.filter(isRoleOption) : []);
      setLoadError(null);
      loaded.current = true;
      setPhase("ready");
    } catch {
      if (mine !== latest.current) return;
      fail("Network error while loading users.");
    }
  }, []);

  // Loaded the first time the tab is opened, and again on every visit after
  // that, because a role made on the Roles tab in the meantime should be in
  // the picker. Not while the tab is hidden: nobody is looking at it then.
  // And not in the middle of a change (see `saving`).
  useEffect(() => {
    if (active && !saving.current) void fetchUsers(loaded.current);
  }, [active, fetchUsers]);

  async function updateRole(userId: number, newRole: string) {
    const oldRole = users.find((u) => u.id === userId)?.role;
    if (oldRole === undefined || oldRole === newRole) return;
    latest.current++;
    saving.current = true;
    setUpdating(userId);
    setActionError(null);
    // Optimistic: reflect the change immediately, roll back on failure. Only
    // this row goes back, so a removal that finished meanwhile stays done.
    const setRoleOf = (role: string) =>
      setUsers((list) => list.map((u) => (u.id === userId ? { ...u, role } : u)));
    setRoleOf(newRole);
    try {
      const res = await apiFetch("/api/admin/users", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId, role: newRole }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setRoleOf(oldRole);
        setActionError(data.error ?? "Could not update the role.");
      }
    } catch {
      setRoleOf(oldRole);
      setActionError("Network error while updating the role.");
    } finally {
      saving.current = false;
      setUpdating(null);
    }
  }

  async function confirmRemove() {
    if (!removeTarget) return;
    const target = removeTarget;
    latest.current++;
    saving.current = true;
    setDeleting(target.id);
    setActionError(null);
    try {
      const res = await apiFetch("/api/admin/users", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: target.id }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setActionError(data.error ?? "Could not remove the user.");
        return;
      }
      setUsers((list) => list.filter((u) => u.id !== target.id));
    } catch {
      setActionError("Network error while removing the user.");
    } finally {
      saving.current = false;
      setDeleting(null);
      setRemoveTarget(null);
    }
  }

  const options = (roles.length > 0 ? roles : BUILT_IN_OPTIONS).map((r) => ({
    value: r.name,
    label: r.label,
  }));
  function labelOf(role: string): string {
    return (
      roles.find((r) => r.name === role)?.label ??
      (isBuiltInRole(role) ? BUILT_IN_ROLE_INFO[role].label : role)
    );
  }

  // One change at a time. A change already running is the reason nobody may
  // start another: `updating` and `deleting` each hold a single id, so a
  // second change overwrote the first one's marker and the first one's
  // `finally` then cleared the second's, re-enabling a row whose request was
  // still in flight. Opening the dialog was enough to break it on its own:
  // the first removal finishing runs `setRemoveTarget(null)`, which closed a
  // confirm dialog the user had just opened for somebody else.
  const busy = updating !== null || deleting !== null;
  const canChangeRoles = can("users:update");
  const canRemove = can("users:delete");
  const adminCount = users.filter((u) => u.role === "admin").length;
  const empty = phase === "ready" && users.length === 0;

  return (
    <div>
      <div className="flex items-center justify-between gap-3 flex-wrap">
        {/*
          "· 0 users, 0 admins" sits directly above the empty state, so the
          first-run page would say the same nothing twice, the second time in
          the language of a populated list that has been emptied. The counts
          are worth reading once there is something to count.
        */}
        <p className="text-[13.5px]" style={{ color: "var(--text-2)" }}>
          Give people a role, or remove them from this app.
          {phase === "ready" && users.length > 0 && (
            <>
              {" "}
              <span style={{ color: "var(--text-3)" }}>
                · {users.length} {users.length === 1 ? "user" : "users"},{" "}
                {adminCount} admin{adminCount === 1 ? "" : "s"}
              </span>
            </>
          )}
        </p>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void fetchUsers(false)}
          disabled={phase === "loading" || busy}
          aria-label="Refresh users"
        >
          <RefreshIcon size={14} /> Refresh
        </Button>
      </div>

      {/* With sign-in off, the list cannot fill up on its own: everyone is
          the same stand-in admin, who has no row here. Said once above the
          list, or by the empty state when there is no list. */}
      {bypass && !empty && (
        <div className="role-note mt-4">
          <InfoIcon size={15} className="ico" />
          <div>
            <div className="title">Sign-in is off for testing</div>
            <div className="body">
              Everyone using the app right now is the same stand-in admin, so nobody new is
              added here. The people listed signed in before sign-in was turned off, and the
              roles you give them apply when it is back on. To see the app as another role
              now, use View as in the sidebar.
            </div>
          </div>
        </div>
      )}

      {actionError && (
        <div
          className="flex items-start gap-2 p-3 rounded-xl mt-4"
          role="alert"
          style={{
            background: "color-mix(in oklab, var(--break) 10%, transparent)",
            border: "1px solid color-mix(in oklab, var(--break) 30%, transparent)",
          }}
        >
          <AlertTriangleIcon size={15} style={{ color: "var(--break)", marginTop: 1, flex: "none" }} />
          <span className="text-[13px]" style={{ color: "var(--break)" }}>
            {actionError}
          </span>
        </div>
      )}

      <div className="mt-4 space-y-3">
        {phase === "loading" &&
          [0, 1, 2].map((i) => <Skeleton key={i} width="100%" height={68} radius={14} />)}

        {phase === "error" && (
          <Card className="p-0 overflow-hidden">
            <div style={{ minHeight: 240 }}>
              <EmptyState
                tone="break"
                icon={<AlertCircleIcon size={22} />}
                title="Couldn't load users"
                description={loadError ?? undefined}
                actions={
                  <Button variant="secondary" size="sm" onClick={() => void fetchUsers(false)}>
                    <RefreshIcon size={14} /> Retry
                  </Button>
                }
              />
            </div>
          </Card>
        )}

        {empty && (
          <Card className="p-0 overflow-hidden">
            <div style={{ minHeight: 240 }}>
              {bypass ? (
                <EmptyState
                  icon={<UsersIcon size={22} />}
                  title="Nobody has signed in yet"
                  description="Sign-in is off for testing, so everyone using the app is the same stand-in admin and nobody is added here. People appear here after they sign in once it is back on. To see the app as another role now, use View as in the sidebar."
                />
              ) : (
                <EmptyState
                  icon={<UsersIcon size={22} />}
                  title="No users yet"
                  description="People appear here after they sign in for the first time."
                />
              )}
            </div>
          </Card>
        )}

        {phase === "ready" &&
          users.map((u) => {
            const isYou = currentUser?.email === u.email;
            return (
              <Card key={u.id} className="p-4">
                <div className="flex items-center gap-3 flex-wrap">
                  {/* Identity */}
                  <div
                    className="w-9 h-9 rounded-full grid place-items-center flex-none text-white text-[12px] font-semibold"
                    style={{ background: "linear-gradient(135deg, var(--brand), #a78bfa)" }}
                    aria-hidden
                  >
                    {initialsOf(u.email)}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-[14px] font-medium truncate">{u.email}</span>
                      {isYou && (
                        <span
                          className="text-[10.5px] px-1.5 py-0.5 rounded-md flex-none"
                          style={{ background: "var(--surface-2)", color: "var(--text-3)" }}
                        >
                          You
                        </span>
                      )}
                    </div>
                    <div className="mt-1">
                      <Pill tone={roleTone(u.role)} dot={u.role === "admin"}>
                        {labelOf(u.role)}
                      </Pill>
                    </div>
                  </div>

                  {/* Controls: full row on mobile, inline on ≥sm. Your own row is
                      read-only so you can't demote or delete yourself into a lockout. */}
                  {isYou ? (
                    <span className="text-[12px] w-full sm:w-auto sm:text-right" style={{ color: "var(--text-3)" }}>
                      Your account
                    </span>
                  ) : (
                    (canChangeRoles || canRemove) && (
                      <div className="flex items-center gap-2 w-full sm:w-auto">
                        {canChangeRoles && (
                          <Select
                            variant="input"
                            ariaLabel={`Role for ${u.email}`}
                            value={u.role}
                            disabled={busy}
                            options={options}
                            onChange={(value) => void updateRole(u.id, value)}
                            className="flex-1 sm:flex-none sm:w-[150px]"
                          />
                        )}
                        {canRemove && (
                          <Button
                            variant="ghost"
                            size="sm"
                            aria-label={`Remove ${u.email}`}
                            title={busy ? "Waiting for the current change to finish" : "Remove access"}
                            disabled={busy}
                            onClick={() => setRemoveTarget(u)}
                          >
                            {/* The only place the wait is visible. The dialog closes the
                                instant it is confirmed, so its own button can never show
                                it. The row has to. */}
                            {deleting === u.id ? (
                              <span className="text-[12px]">Removing…</span>
                            ) : (
                              <TrashIcon size={15} />
                            )}
                          </Button>
                        )}
                      </div>
                    )
                  )}
                </div>
              </Card>
            );
          })}
      </div>

      {/* No "Removing…" confirmLabel: ConfirmDialog runs onConfirm and closes
          back to back, so a busy label on its own button could never be seen.
          The row's own button carries the wait instead. */}
      <ConfirmDialog
        open={removeTarget !== null}
        onClose={() => setRemoveTarget(null)}
        onConfirm={() => void confirmRemove()}
        destructive
        title={removeTarget ? `Remove ${removeTarget.email}?` : "Remove user?"}
        description="This deletes their profile and role in this app. It does NOT remove their Microsoft/SSO login, so they could sign in again unless you also remove them from your identity provider."
        confirmLabel="Remove access"
      />
    </div>
  );
}
