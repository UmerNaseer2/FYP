"use client";

import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
import { useUser } from "@/hooks/useUser";
import {
  ADMIN_ROLE,
  ROLE_DESCRIPTION_MAX,
  ROLE_LABEL_MAX,
  isPermissionKey,
  presetFor,
  withToggled,
  type PermissionKey,
} from "@/lib/permissions";
import type { RoleChange, RoleSummary } from "@/lib/roles-db";
import { Button, Card, ConfirmDialog, EmptyState, Input, Label, Skeleton } from "@/components/ui";
import { Select } from "@/components/ui/Select";
import {
  AlertCircleIcon,
  AlertTriangleIcon,
  CheckIcon,
  InfoIcon,
  PlusIcon,
  RefreshIcon,
  TrashIcon,
  XIcon,
} from "@/components/ui/icons";
import { announceRolesChanged } from "@/components/studio/ViewAsSwitcher";
import { PermissionGrid } from "./PermissionGrid";
import { RoleChangeLog } from "./RoleChangeLog";
import { apiFetch } from "@/lib/api-fetch";

/**
 * The Roles & permissions tab on the Admin screen: every role, what each one
 * can do, a way to change that, and a log of who changed what.
 *
 * Boxes are ticked on the screen first and saved together, so an admin can go
 * down a whole row and check it before anything takes effect. Each role keeps
 * its own unsaved boxes until they are saved or thrown away, so looking at
 * another role on the way loses nothing.
 *
 * Nothing here decides what a role may hold. Ticking a box also ticks Read
 * (withToggled in lib/permissions.ts), and the server applies the same rules
 * again whatever this screen sends (lib/roles-db.ts).
 */

/**
 * Unsaved boxes, per role: the whole set the role would have once saved.
 *
 * A Map rather than a plain object because the keys come from names an admin
 * types. A role called "Constructor" has the key "constructor", which every
 * plain object already has (Object.prototype.constructor), so looking it up
 * would find unsaved boxes nobody ticked.
 */
type Drafts = ReadonlyMap<string, PermissionKey[]>;

/** The change being saved. One at a time, as on the Users tab. */
type Busy = null | "save" | "reset" | "delete" | "create";

/** How the last change went, or why a reload failed. Shown under the grid. */
type Notice = { tone: "ok" | "error"; text: string } | null;

/** The change waiting for the person to confirm it. */
type ToConfirm = { kind: "reset" | "delete"; role: RoleSummary } | null;

// A new role starts as a copy of Viewer: it can open every screen and change
// nothing, which is the safest place to start ticking boxes from.
const EMPTY_FORM = { label: "", description: "", copyFrom: "viewer" };

const JSON_HEADERS = { "Content-Type": "application/json" };

function sameKeys(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const inA = new Set(a);
  return b.every((key) => inA.has(key));
}

/** How many boxes differ between two sets: ticked in one and not the other. */
function countDifferences(a: readonly string[], b: readonly string[]): number {
  const inA = new Set(a);
  const inB = new Set(b);
  return a.filter((key) => !inB.has(key)).length + b.filter((key) => !inA.has(key)).length;
}

/**
 * The unsaved boxes still worth keeping once a fresh list of roles arrives:
 * none for a role that has been deleted, and none that now match what is
 * saved (someone else saved the same change). The same Map comes back when
 * nothing was dropped, so React has nothing to redraw.
 */
function pruneDrafts(drafts: Drafts, roles: readonly RoleSummary[]): Drafts {
  const kept = new Map<string, PermissionKey[]>();
  for (const [name, draft] of drafts) {
    const role = roles.find((r) => r.name === name);
    if (role && !sameKeys(draft, role.permissions)) kept.set(name, draft);
  }
  return kept.size === drafts.size ? drafts : kept;
}

function withoutDraft(drafts: Drafts, name: string): Drafts {
  if (!drafts.has(name)) return drafts;
  const next = new Map(drafts);
  next.delete(name);
  return next;
}

function peopleText(count: number): string {
  return count === 1 ? "1 person" : `${count} people`;
}

function holdersText(count: number): string {
  if (count === 0) return "Nobody has this role yet.";
  return count === 1 ? "1 person has this role." : `${count} people have this role.`;
}

export function RolesTab({ active }: { active: boolean }) {
  const { can } = useUser();

  const [roles, setRoles] = useState<RoleSummary[]>([]);
  const [changes, setChanges] = useState<RoleChange[]>([]);
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [loadError, setLoadError] = useState<string | null>(null);
  // The role on screen, by key. Null, or a role that has since gone, shows the
  // first one (Viewer).
  const [selected, setSelected] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Drafts>(() => new Map());
  const [busy, setBusy] = useState<Busy>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [formError, setFormError] = useState<string | null>(null);
  const [toConfirm, setToConfirm] = useState<ToConfirm>(null);

  // The same three as on the Users tab, for the same reasons. `latest` throws
  // away a list that a newer load or a change overtook. `saving` stops a
  // visit to the tab from reloading in the middle of a change, when the list
  // may or may not have the change in it. `loaded` keeps the grid on screen
  // during a reload instead of going back to the skeleton.
  const latest = useRef(0);
  const saving = useRef(false);
  const loaded = useRef(false);

  const nameId = useId();
  const copyId = useId();
  const descriptionId = useId();

  // `quiet` keeps the grid on screen while the new list loads, and a failure
  // then only shows a message under it. A load that put the skeleton up must
  // take it down again, with the roles or with the error.
  const load = useCallback(async (quiet: boolean) => {
    const mine = ++latest.current;
    if (!quiet) {
      setPhase("loading");
      setNotice(null);
    }
    // A quiet reload follows every change. If it fails, the change still
    // happened, so a message saying how the change went stays where it is
    // rather than being replaced by this one.
    const fail = (text: string) => {
      if (quiet) {
        setNotice((shown) => shown ?? { tone: "error", text });
      } else {
        setLoadError(text);
        setPhase("error");
      }
    };
    try {
      const res = await apiFetch("/api/admin/roles", { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (mine !== latest.current) return;
      if (!res.ok) {
        fail(data.error ?? "Could not load the roles.");
        return;
      }
      const nextRoles: RoleSummary[] = Array.isArray(data.roles) ? data.roles : [];
      setRoles(nextRoles);
      setChanges(Array.isArray(data.changes) ? data.changes : []);
      setDrafts((all) => pruneDrafts(all, nextRoles));
      setLoadError(null);
      loaded.current = true;
      setPhase("ready");
    } catch {
      if (mine !== latest.current) return;
      fail("Network error while loading the roles.");
    }
  }, []);

  // Loaded the first time the tab is opened, and again on every visit after
  // that, so a role given to someone on the Users tab meanwhile shows in the
  // counts. Not while the tab is hidden: nobody is looking at it then. And
  // not in the middle of a change (see `saving`).
  useEffect(() => {
    if (active && !saving.current) void load(loaded.current);
  }, [active, load]);

  // Every change goes through these two. `latest` moves on so a list asked
  // for before the change can't land after it, and the list is reloaded once
  // the change is done, because the counts and the log change with it.
  function start(kind: Exclude<Busy, null>) {
    latest.current++;
    saving.current = true;
    setBusy(kind);
    setNotice(null);
  }

  function finish() {
    saving.current = false;
    setBusy(null);
    void load(true);
  }

  const current = roles.find((r) => r.name === selected) ?? roles[0] ?? null;
  const saved = current?.permissions ?? [];
  const draft = current ? drafts.get(current.name) : undefined;
  const shown = draft ?? saved;
  const changeCount = draft ? countDifferences(draft, saved) : 0;
  const dirty = changeCount > 0;
  const isAdminRole = current?.name === ADMIN_ROLE;
  // Only Viewer and Editor have defaults to go back to. Admin has one too
  // (everything), but it can never be anywhere else.
  const preset = current ? presetFor(current.name) : null;
  const atDefault = preset !== null && sameKeys(saved, preset);
  const canUpdate = can("roles:update");
  const showReset = preset !== null && !isAdminRole && canUpdate;
  const showDelete = current !== null && !current.builtIn && can("roles:delete");
  const copyOptions = [
    { value: "", label: "Nothing ticked" },
    ...roles.map((r) => ({ value: r.name, label: `A copy of ${r.label}` })),
  ];

  function unsavedCount(role: RoleSummary): number {
    const pending = drafts.get(role.name);
    return pending ? countDifferences(pending, role.permissions) : 0;
  }

  function selectRole(name: string) {
    if (name === current?.name) return;
    setSelected(name);
    setNotice(null);
  }

  function toggle(key: PermissionKey, on: boolean) {
    if (!current || isAdminRole || busy !== null) return;
    const role = current;
    setDrafts((all) => {
      const next = withToggled(all.get(role.name) ?? role.permissions, key, on);
      // Boxes put back the way they are saved leave nothing to save.
      return sameKeys(next, role.permissions)
        ? withoutDraft(all, role.name)
        : new Map(all).set(role.name, next);
    });
    setNotice(null);
  }

  function discard() {
    if (!current) return;
    const name = current.name;
    setDrafts((all) => withoutDraft(all, name));
    setNotice(null);
  }

  /** Show what the server stored for the role, and drop its unsaved boxes. */
  function applySaved(name: string, permissions: readonly unknown[]) {
    const stored = permissions.filter(isPermissionKey);
    setRoles((list) => list.map((r) => (r.name === name ? { ...r, permissions: stored } : r)));
    setDrafts((all) => withoutDraft(all, name));
  }

  async function save() {
    if (!current || busy !== null) return;
    const role = current;
    const pending = drafts.get(role.name);
    if (!pending) return;
    start("save");
    try {
      // The whole set, not the boxes that changed: see PUT /api/admin/roles.
      const res = await apiFetch("/api/admin/roles", {
        method: "PUT",
        headers: JSON_HEADERS,
        body: JSON.stringify({ role: role.name, permissions: pending }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setNotice({ tone: "error", text: data.error ?? "Could not save the permissions." });
        return;
      }
      applySaved(role.name, Array.isArray(data.permissions) ? data.permissions : pending);
      const changed =
        typeof data.changes === "number"
          ? data.changes
          : countDifferences(pending, role.permissions);
      setNotice({
        tone: "ok",
        text:
          changed === 0
            ? `${role.label} already had exactly these permissions.`
            : `Saved ${changed} ${changed === 1 ? "change" : "changes"} to ${role.label}. ` +
              "They apply straight away, and anyone with this role who has the app open " +
              "sees the new buttons once they reload the page.",
      });
    } catch {
      setNotice({
        tone: "error",
        text: "Network error while saving. Reload the page to see what was saved.",
      });
    } finally {
      finish();
    }
  }

  async function reset(role: RoleSummary) {
    if (busy !== null) return;
    start("reset");
    try {
      const res = await apiFetch("/api/admin/roles", {
        method: "PUT",
        headers: JSON_HEADERS,
        body: JSON.stringify({ role: role.name, reset: true }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setNotice({ tone: "error", text: data.error ?? "Could not reset the role." });
        return;
      }
      applySaved(
        role.name,
        Array.isArray(data.permissions) ? data.permissions : (presetFor(role.name) ?? [])
      );
      setNotice({
        tone: "ok",
        text:
          data.changes === 0
            ? `${role.label} was already at its defaults.`
            : `Put ${role.label} back to its defaults.`,
      });
    } catch {
      setNotice({
        tone: "error",
        text: "Network error while resetting. Reload the page to see what was saved.",
      });
    } finally {
      finish();
    }
  }

  async function remove(role: RoleSummary) {
    if (busy !== null) return;
    start("delete");
    try {
      const res = await apiFetch("/api/admin/roles", {
        method: "DELETE",
        headers: JSON_HEADERS,
        body: JSON.stringify({ role: role.name }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setNotice({ tone: "error", text: data.error ?? "Could not delete the role." });
        return;
      }
      setRoles((list) => list.filter((r) => r.name !== role.name));
      setDrafts((all) => withoutDraft(all, role.name));
      setSelected((name) => (name === role.name ? null : name));
      setNotice({ tone: "ok", text: `Deleted ${role.label}.` });
      // So the View as picker on the rail stops offering it.
      announceRolesChanged();
    } catch {
      setNotice({
        tone: "error",
        text: "Network error while deleting the role. Reload the page to see whether it was deleted.",
      });
    } finally {
      finish();
    }
  }

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy !== null) return;
    const label = form.label.trim();
    if (label === "") {
      setFormError("Give the role a name.");
      return;
    }
    start("create");
    setFormError(null);
    try {
      const res = await apiFetch("/api/admin/roles", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({
          label,
          description: form.description.trim(),
          // The picker's "Nothing ticked" is the empty value.
          copyFrom: form.copyFrom || null,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.role) {
        setFormError(data.error ?? "Could not create the role.");
        return;
      }
      const role: RoleSummary = data.role;
      setRoles((list) => [...list.filter((r) => r.name !== role.name), role]);
      setSelected(role.name);
      setCreating(false);
      setForm(EMPTY_FORM);
      setNotice({
        tone: "ok",
        text:
          `Created ${role.label}. Change its boxes above if needed, ` +
          "then give it to people on the Users tab.",
      });
      // So the View as picker on the rail offers it without a reload.
      announceRolesChanged();
    } catch {
      setFormError(
        "Network error while creating the role. Reload the page to see whether it was made."
      );
    } finally {
      finish();
    }
  }

  function openCreate() {
    setCreating(true);
    setFormError(null);
    setForm(EMPTY_FORM);
  }

  function cancelCreate() {
    setCreating(false);
    setFormError(null);
  }

  return (
    <div>
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <p className="text-[13.5px]" style={{ color: "var(--text-2)" }}>
          Pick a role to see what it can do. Tick a box to allow it.
        </p>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void load(false)}
          disabled={phase === "loading" || busy !== null}
          aria-label="Refresh roles"
        >
          <RefreshIcon size={14} /> Refresh
        </Button>
      </div>

      {phase === "loading" && (
        <div className="mt-4 space-y-3">
          <Skeleton width={240} height={26} radius={999} />
          <Skeleton width="100%" height={420} radius={14} />
        </div>
      )}

      {phase === "error" && (
        <Card className="p-0 overflow-hidden mt-4">
          <div style={{ minHeight: 240 }}>
            <EmptyState
              tone="break"
              icon={<AlertCircleIcon size={22} />}
              title="Couldn't load roles"
              description={loadError ?? undefined}
              actions={
                <Button variant="secondary" size="sm" onClick={() => void load(false)}>
                  <RefreshIcon size={14} /> Retry
                </Button>
              }
            />
          </div>
        </Card>
      )}

      {phase === "ready" && (
        <>
          <div className="mt-4 flex items-center gap-2 flex-wrap">
            {/* Styled like the filter pills on Connections. The number is how
                many people have the role; the dot after it marks unsaved boxes.
                A screen reader gets the same in words from aria-label ("Viewer,
                1 person, unsaved changes") instead of a bare number and a dot. */}
            <div role="group" aria-label="Roles" className="flex flex-wrap gap-2">
              {roles.map((role) => {
                const isCurrent = role.name === current?.name;
                const unsaved = unsavedCount(role) > 0;
                return (
                  <button
                    key={role.name}
                    type="button"
                    className={`pill ${isCurrent ? "pill-brand" : "pill-outline"}`}
                    aria-pressed={isCurrent}
                    aria-label={`${role.label}, ${peopleText(role.userCount)}${
                      unsaved ? ", unsaved changes" : ""
                    }`}
                    title={holdersText(role.userCount)}
                    onClick={() => selectRole(role.name)}
                  >
                    {isCurrent && <span className="dot" />}
                    {role.label}
                    <span className="mono ml-1" style={{ opacity: 0.7 }}>
                      {role.userCount}
                    </span>
                    {unsaved && <span>•</span>}
                  </button>
                );
              })}
            </div>
            {can("roles:create") && !creating && (
              <Button variant="ghost" size="sm" onClick={openCreate}>
                <PlusIcon size={14} /> New role
              </Button>
            )}
          </div>

          {creating && (
            <Card className="mt-4 p-4 sm:p-5">
              <form onSubmit={(event) => void create(event)}>
                <h2 className="text-[15px] font-semibold">New role</h2>
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  <div>
                    <Label htmlFor={nameId} className="mb-1 block">
                      Name
                    </Label>
                    <Input
                      id={nameId}
                      value={form.label}
                      maxLength={ROLE_LABEL_MAX}
                      placeholder="QA Lead"
                      autoFocus
                      onChange={(event) => setForm({ ...form, label: event.target.value })}
                    />
                  </div>
                  <div>
                    <Label htmlFor={copyId} className="mb-1 block">
                      Start from
                    </Label>
                    <Select
                      id={copyId}
                      variant="input"
                      value={form.copyFrom}
                      options={copyOptions}
                      onChange={(value) => setForm({ ...form, copyFrom: value })}
                    />
                    {form.copyFrom === ADMIN_ROLE && (
                      <p className="help mt-1">
                        A copy of Admin leaves out managing people and roles, which only Admin
                        can do.
                      </p>
                    )}
                  </div>
                  <div className="sm:col-span-2">
                    <Label htmlFor={descriptionId} className="mb-1 block">
                      Description (optional)
                    </Label>
                    <Input
                      id={descriptionId}
                      value={form.description}
                      maxLength={ROLE_DESCRIPTION_MAX}
                      placeholder="What this role is for"
                      onChange={(event) => setForm({ ...form, description: event.target.value })}
                    />
                  </div>
                </div>
                {formError && (
                  <div className="banner mt-3" role="alert">
                    <AlertTriangleIcon size={16} className="ico" />
                    <div className="body">{formError}</div>
                  </div>
                )}
                <div className="mt-4 flex items-center justify-end gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={cancelCreate}
                    disabled={busy === "create"}
                  >
                    Cancel
                  </Button>
                  <Button variant="primary" size="sm" type="submit" disabled={busy !== null}>
                    {busy === "create" ? "Creating…" : "Create role"}
                  </Button>
                </div>
              </form>
            </Card>
          )}

          {/* Not overflow-hidden: the save bar at the bottom is sticky, and a
              card that clips its contents would stop it sticking. */}
          {current && (
            <Card className="mt-4 p-0">
              <div className="p-4 sm:p-5 flex items-start justify-between gap-3 flex-wrap">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h2 className="text-[16px] font-semibold">{current.label}</h2>
                    {current.builtIn && (
                      <span
                        className="text-[10.5px] px-1.5 py-0.5 rounded-md flex-none"
                        style={{ background: "var(--surface-2)", color: "var(--text-3)" }}
                      >
                        Built in
                      </span>
                    )}
                  </div>
                  {current.description && (
                    <p className="text-[13px] mt-1 max-w-[60ch]" style={{ color: "var(--text-2)" }}>
                      {current.description}
                    </p>
                  )}
                  <p className="help mt-1">
                    {holdersText(current.userCount)}
                    {showDelete &&
                      current.userCount > 0 &&
                      " To delete it, give them another role on the Users tab first."}
                  </p>
                </div>
                {(showReset || showDelete) && (
                  <div className="flex items-center gap-2 flex-wrap">
                    {showReset && (
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={atDefault || busy !== null}
                        title={atDefault ? "Already at its defaults" : undefined}
                        onClick={() => setToConfirm({ kind: "reset", role: current })}
                      >
                        {/* The dialog closes the moment it is confirmed, so the
                            wait shows here, as "Removing…" does on the Users tab. */}
                        {busy === "reset" ? "Resetting…" : "Reset to default"}
                      </Button>
                    )}
                    {showDelete && (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={current.userCount > 0 || busy !== null}
                        onClick={() => setToConfirm({ kind: "delete", role: current })}
                      >
                        <TrashIcon size={14} /> {busy === "delete" ? "Deleting…" : "Delete role"}
                      </Button>
                    )}
                  </div>
                )}
              </div>

              {isAdminRole && (
                <div className="px-4 sm:px-5 pb-4">
                  <div className="role-note">
                    <InfoIcon size={15} className="ico" />
                    <div>
                      <div className="title">Admin can always do everything</div>
                      <div className="body">
                        {"Its boxes can't be changed, so that nobody can lock every admin out " +
                          "of this page."}
                      </div>
                    </div>
                  </div>
                </div>
              )}

              <PermissionGrid
                roleLabel={current.label}
                isAdminRole={isAdminRole}
                shown={shown}
                saved={saved}
                disabled={!canUpdate || busy !== null}
                onToggle={toggle}
              />

              {!isAdminRole && canUpdate && (
                <p
                  className="help px-4 sm:px-5 py-3"
                  style={{ borderTop: "1px solid var(--border)" }}
                >
                  Ticking any box also ticks Read for that feature, because nothing else on it
                  can be reached without opening it. Unticking Read clears the whole row.
                </p>
              )}

              {(dirty || notice) && (
                <div className="role-savebar">
                  {notice && (
                    <div
                      className={notice.tone === "ok" ? "test-banner test-ok" : "banner"}
                      role={notice.tone === "ok" ? "status" : "alert"}
                    >
                      {notice.tone === "ok" ? (
                        <CheckIcon size={16} className="ico" />
                      ) : (
                        <AlertTriangleIcon size={16} className="ico" />
                      )}
                      <div className="body flex-1">{notice.text}</div>
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label="Dismiss"
                        onClick={() => setNotice(null)}
                      >
                        <XIcon size={14} />
                      </Button>
                    </div>
                  )}
                  {dirty && (
                    <>
                      <span className="text-[13px]" style={{ color: "var(--text-2)" }}>
                        {changeCount} unsaved {changeCount === 1 ? "change" : "changes"} to{" "}
                        {current.label}
                      </span>
                      <div className="flex gap-2">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={discard}
                          disabled={busy !== null}
                        >
                          Discard
                        </Button>
                        <Button
                          variant="primary"
                          size="sm"
                          onClick={() => void save()}
                          disabled={busy !== null}
                        >
                          {busy === "save" ? "Saving…" : "Save changes"}
                        </Button>
                      </div>
                    </>
                  )}
                </div>
              )}
            </Card>
          )}

          <Card className="mt-4 p-4 sm:p-5">
            <h2 className="text-[15px] font-semibold">Recent changes</h2>
            <p className="help mt-0.5 mb-3">Changes to roles and to who has them, newest first.</p>
            <RoleChangeLog changes={changes} />
          </Card>
        </>
      )}

      <ConfirmDialog
        open={toConfirm !== null}
        onClose={() => setToConfirm(null)}
        onConfirm={() => {
          if (!toConfirm) return;
          if (toConfirm.kind === "reset") void reset(toConfirm.role);
          else void remove(toConfirm.role);
        }}
        destructive={toConfirm?.kind === "delete"}
        title={
          toConfirm === null
            ? "Change role?"
            : toConfirm.kind === "reset"
              ? `Reset ${toConfirm.role.label} to its defaults?`
              : `Delete ${toConfirm.role.label}?`
        }
        description={
          toConfirm === null
            ? undefined
            : toConfirm.kind === "reset"
              ? `${toConfirm.role.label} goes back to the boxes it starts with on a new ` +
                "install. Every box this ticks or unticks is listed in Recent changes." +
                (unsavedCount(toConfirm.role) > 0
                  ? " Your unsaved changes to it are dropped."
                  : "")
              : "Nobody has this role, so nobody loses access. The role and its permissions " +
                "are removed. Recent changes keeps a record of it."
        }
        confirmLabel={toConfirm?.kind === "delete" ? "Delete role" : "Reset"}
      />
    </div>
  );
}
