"use client";

import { useCallback, useEffect, useState } from "react";
import { useUser } from "@/hooks/useUser";
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
  LockIcon,
  RefreshIcon,
  TrashIcon,
  AlertTriangleIcon,
  AlertCircleIcon,
} from "@/components/ui/icons";

// Mirrors GET /api/admin/users.
type Profile = {
  id: number;
  email: string;
  role: string;
};

const ROLE_OPTIONS = [
  { value: "viewer", label: "Viewer" },
  { value: "admin", label: "Admin" },
];

function roleTone(role: string): PillTone {
  return role === "admin" ? "brand" : "neutral";
}

function initialsOf(email: string): string {
  return email.slice(0, 2).toUpperCase();
}

export default function AdminPage() {
  const { isAdmin, loading: roleLoading, user: currentUser } = useUser();

  const [users, setUsers] = useState<Profile[]>([]);
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [updating, setUpdating] = useState<number | null>(null);
  const [deleting, setDeleting] = useState<number | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [removeTarget, setRemoveTarget] = useState<Profile | null>(null);

  const fetchUsers = useCallback(async () => {
    setPhase("loading");
    setActionError(null);
    try {
      const res = await fetch("/api/admin/users", { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) {
        setActionError(data.error ?? "Could not load users.");
        setPhase("error");
        return;
      }
      setUsers(Array.isArray(data.users) ? data.users : []);
      setPhase("ready");
    } catch {
      setActionError("Network error while loading users.");
      setPhase("error");
    }
  }, []);

  useEffect(() => {
    if (isAdmin) void fetchUsers();
  }, [isAdmin, fetchUsers]);

  async function updateRole(userId: number, newRole: string) {
    const prev = users;
    setUpdating(userId);
    setActionError(null);
    // Optimistic: reflect the change immediately, roll back on failure.
    setUsers((list) => list.map((u) => (u.id === userId ? { ...u, role: newRole } : u)));
    try {
      const res = await fetch("/api/admin/users", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId, role: newRole }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setUsers(prev);
        setActionError(data.error ?? "Could not update the role.");
      }
    } catch {
      setUsers(prev);
      setActionError("Network error while updating the role.");
    } finally {
      setUpdating(null);
    }
  }

  async function confirmRemove() {
    if (!removeTarget) return;
    const target = removeTarget;
    setDeleting(target.id);
    setActionError(null);
    try {
      const res = await fetch("/api/admin/users", {
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
      setDeleting(null);
      setRemoveTarget(null);
    }
  }

  // ── Gate states ────────────────────────────────────────────────────────────
  if (roleLoading) {
    return (
      <div className="max-w-[820px] mx-auto px-5 sm:px-8 py-8 sm:py-10">
        <Skeleton width={140} height={14} />
        <Skeleton width={220} height={28} className="mt-3" />
        <div className="space-y-3 mt-8">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} width="100%" height={68} radius={14} />
          ))}
        </div>
      </div>
    );
  }

  if (!isAdmin) {
    return (
      <div className="max-w-[820px] mx-auto px-5 sm:px-8 py-8 sm:py-10">
        <AdminHeader onRefresh={null} refreshing={false} count={null} admins={null} />
        <Card className="p-0 overflow-hidden mt-6">
          <div style={{ minHeight: 280 }}>
            <EmptyState
              icon={<LockIcon size={22} />}
              title="Admins only"
              description="You need the admin role to manage users. Ask an existing admin to grant it, then reload."
            />
          </div>
        </Card>
      </div>
    );
  }

  const adminCount = users.filter((u) => u.role === "admin").length;

  return (
    <div className="max-w-[820px] mx-auto px-5 sm:px-8 py-8 sm:py-10">
      <AdminHeader
        onRefresh={() => void fetchUsers()}
        refreshing={phase === "loading"}
        count={phase === "ready" ? users.length : null}
        admins={phase === "ready" ? adminCount : null}
      />

      {actionError && (
        <div
          className="flex items-start gap-2 p-3 rounded-xl mt-5"
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

      <div className="mt-6 space-y-3">
        {phase === "loading" &&
          [0, 1, 2].map((i) => <Skeleton key={i} width="100%" height={68} radius={14} />)}

        {phase === "error" && (
          <Card className="p-0 overflow-hidden">
            <div style={{ minHeight: 240 }}>
              <EmptyState
                icon={<AlertCircleIcon size={22} />}
                title="Couldn't load users"
                description="The app database may be unreachable. Try again in a moment."
                actions={
                  <Button variant="secondary" size="sm" onClick={() => void fetchUsers()}>
                    <RefreshIcon size={14} /> Retry
                  </Button>
                }
              />
            </div>
          </Card>
        )}

        {phase === "ready" && users.length === 0 && (
          <Card className="p-0 overflow-hidden">
            <div style={{ minHeight: 240 }}>
              <EmptyState
                icon={<UsersIcon size={22} />}
                title="No users yet"
                description="People appear here after they sign in for the first time."
              />
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
                        {u.role}
                      </Pill>
                    </div>
                  </div>

                  {/* Controls — full row on mobile, inline on ≥sm. Your own row is
                      read-only so you can't demote or delete yourself into a lockout. */}
                  {isYou ? (
                    <span className="text-[12px] w-full sm:w-auto sm:text-right" style={{ color: "var(--text-3)" }}>
                      Your account
                    </span>
                  ) : (
                    <div className="flex items-center gap-2 w-full sm:w-auto">
                      <Select
                        variant="input"
                        ariaLabel={`Role for ${u.email}`}
                        value={u.role}
                        disabled={updating === u.id}
                        options={ROLE_OPTIONS}
                        onChange={(value) => void updateRole(u.id, value)}
                        className="flex-1 sm:flex-none sm:w-[128px]"
                      />
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={`Remove ${u.email}`}
                        title="Remove access"
                        disabled={deleting === u.id}
                        onClick={() => setRemoveTarget(u)}
                      >
                        <TrashIcon size={15} />
                      </Button>
                    </div>
                  )}
                </div>
              </Card>
            );
          })}
      </div>

      <ConfirmDialog
        open={removeTarget !== null}
        onClose={() => setRemoveTarget(null)}
        onConfirm={() => void confirmRemove()}
        destructive
        title={removeTarget ? `Remove ${removeTarget.email}?` : "Remove user?"}
        description="This deletes their profile and role in this app. It does NOT remove their Microsoft/SSO login, so they could sign in again unless you also remove them from your identity provider."
        confirmLabel={deleting !== null ? "Removing…" : "Remove access"}
      />
    </div>
  );
}

function AdminHeader({
  onRefresh,
  refreshing,
  count,
  admins,
}: {
  onRefresh: (() => void) | null;
  refreshing: boolean;
  count: number | null;
  admins: number | null;
}) {
  return (
    <header className="flex items-end justify-between gap-4 flex-wrap">
      <div>
        <div className="section-title">Admin</div>
        <h1 className="text-[26px] sm:text-[28px] font-semibold tracking-[-0.02em] mt-1">
          User management
        </h1>
        <p className="text-[13.5px] mt-1.5 max-w-[56ch]" style={{ color: "var(--text-2)" }}>
          Grant or revoke admin access and remove people from this app.
          {count !== null && (
            <>
              {" "}
              <span style={{ color: "var(--text-3)" }}>
                · {count} {count === 1 ? "user" : "users"}
                {admins !== null && `, ${admins} admin${admins === 1 ? "" : "s"}`}
              </span>
            </>
          )}
        </p>
      </div>
      {onRefresh && (
        <Button variant="ghost" onClick={onRefresh} disabled={refreshing} aria-label="Refresh">
          <RefreshIcon size={14} /> Refresh
        </Button>
      )}
    </header>
  );
}
