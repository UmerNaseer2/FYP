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
import {
  ADMIN_COPY_NOTE,
  changeSentences,
  glance,
  glanceValue,
  roleSummary,
  toggleHint,
  type ToggleHint,
} from "@/lib/role-summary";
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
  UsersIcon,
  XIcon,
} from "@/components/ui/icons";
import { announceRolesChanged } from "@/components/studio/ViewAsSwitcher";
import { PermissionList } from "./PermissionList";
import { PermissionsGuide } from "./PermissionsGuide";
import { RoleChangeLog } from "./RoleChangeLog";
import { RoleCompare } from "./RoleCompare";
import { apiFetch } from "@/lib/api-fetch";

/**
 * The Roles & permissions tab on the Admin screen: every role, what each one
 * can do in plain sentences, a way to change that, every role side by side,
 * and a log of who changed what.
 *
 * Lines are turned on and off on the screen first and saved together, so an
 * admin can go through a whole role and check it before anything takes
 * effect. Each role keeps its own unsaved changes until they are saved or
 * thrown away, so looking at another role on the way loses nothing.
 *
 * Nothing here decides what a role may hold. Turning a line on also turns on
 * its feature's see line (withToggled in lib/permissions.ts), and the server
 * applies the same rules again whatever this screen sends (lib/roles-db.ts).
 * lib/role-summary.ts only puts what they decided into words.
 */

/**
 * Unsaved changes, per role: the whole set the role would have once saved.
 *
 * A Map rather than a plain object because the keys come from names an admin
 * types. A role called "Constructor" has the key "constructor", which every
 * plain object already has (Object.prototype.constructor), so looking it up
 * would find unsaved changes nobody made.
 */
type Drafts = ReadonlyMap<string, PermissionKey[]>;

/** The change being saved. One at a time, as on the Users tab. */
type Busy = null | "save" | "reset" | "delete" | "create";

/** How the last change went, or why a reload failed. Shown in the save bar. */
type Notice = { tone: "ok" | "error"; text: string } | null;

/** The change waiting for the person to confirm it. */
type ToConfirm = { kind: "reset" | "delete"; role: RoleSummary } | null;

/**
 * What the last click did besides itself, for the role it was made on, and
 * what that role held just before, so Undo can put it back.
 */
type Hint = ToggleHint & { role: string; before: readonly PermissionKey[] };

// A new role starts as a copy of Viewer: it can open every screen and change
// nothing, which is the safest place to start from.
const EMPTY_FORM = { label: "", description: "", copyFrom: "viewer" };

const JSON_HEADERS = { "Content-Type": "application/json" };

function sameKeys(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const inA = new Set(a);
  return b.every((key) => inA.has(key));
}

/** How many lines differ between two sets: on in one and off in the other. */
function countDifferences(a: readonly string[], b: readonly string[]): number {
  const inA = new Set(a);
  const inB = new Set(b);
  return a.filter((key) => !inB.has(key)).length + b.filter((key) => !inA.has(key)).length;
}

/**
 * The unsaved changes still worth keeping once a fresh list of roles arrives:
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

/** `keys` as the role's unsaved changes, or none when they match what is saved. */
function withDraft(drafts: Drafts, role: RoleSummary, keys: readonly PermissionKey[]): Drafts {
  return sameKeys(keys, role.permissions)
    ? withoutDraft(drafts, role.name)
    : new Map(drafts).set(role.name, [...keys]);
}

function peopleText(count: number): string {
  return count === 1 ? "1 person" : `${count} people`;
}

function holdersText(count: number): string {
  if (count === 0) return "Nobody has this role yet.";
  return count === 1 ? "1 person has this role." : `${count} people have this role.`;
}

type Props = {
  active: boolean;
  /** Adds the "check it with View as" step, where the View as picker exists. */
  showViewAs?: boolean;
  /** Opens the Users tab. Left out when the person can't see that tab. */
  onShowUsers?: () => void;
};

export function RolesTab({ active, showViewAs = false, onShowUsers }: Props) {
  const { can } = useUser();

  const [roles, setRoles] = useState<RoleSummary[]>([]);
  const [changes, setChanges] = useState<RoleChange[]>([]);
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [loadError, setLoadError] = useState<string | null>(null);
  // The role on screen, by key. Null, or a role that has since gone, shows the
  // first one (Viewer).
  const [selected, setSelected] = useState<string | null>(null);
  // One role and its lines, or every role side by side (read-only).
  const [view, setView] = useState<"one" | "compare">("one");
  const [drafts, setDrafts] = useState<Drafts>(() => new Map());
  const [hint, setHint] = useState<Hint | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [formError, setFormError] = useState<string | null>(null);
  const [toConfirm, setToConfirm] = useState<ToConfirm>(null);

  // The same three as on the Users tab, for the same reasons. `latest` throws
  // away a list that a newer load or a change overtook. `saving` stops a
  // visit to the tab from reloading in the middle of a change, when the list
  // may or may not have the change in it. `loaded` keeps the list on screen
  // during a reload instead of going back to the skeleton.
  const latest = useRef(0);
  const saving = useRef(false);
  const loaded = useRef(false);

  const nameId = useId();
  const copyId = useId();
  const descriptionId = useId();

  // `quiet` keeps the list on screen while the new one loads, and a failure
  // then only shows a message under it. A load that put the skeleton up must
  // take it down again, with the roles or with the error.
  const load = useCallback(async (quiet: boolean) => {
    const mine = ++latest.current;
    // An Undo from before the reload could put back lines someone else has
    // changed since, so the hint goes with it.
    setHint(null);
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
    setHint(null);
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
  const shownHint = hint !== null && hint.role === current?.name ? hint : null;
  const copyOptions = [
    { value: "", label: "Nothing turned on" },
    ...roles.map((r) => ({ value: r.name, label: `A copy of ${r.label}` })),
  ];

  function unsavedCount(role: RoleSummary): number {
    const pending = drafts.get(role.name);
    return pending ? countDifferences(pending, role.permissions) : 0;
  }

  function selectRole(name: string) {
    setView("one");
    if (name === current?.name) return;
    setSelected(name);
    setNotice(null);
    setHint(null);
  }

  function toggle(key: PermissionKey, on: boolean) {
    if (!current || isAdminRole || busy !== null) return;
    const role = current;
    const before = drafts.get(role.name) ?? role.permissions;
    const next = withToggled(before, key, on);
    setDrafts((all) => withDraft(all, role, next));
    const found = toggleHint(before, key, on);
    setHint(found ? { ...found, role: role.name, before } : null);
    setNotice(null);
  }

  /** Puts the role back the way it was before the click the hint is about. */
  function undo() {
    if (!hint || busy !== null) return;
    const role = roles.find((r) => r.name === hint.role);
    if (role) setDrafts((all) => withDraft(all, role, hint.before));
    setHint(null);
  }

  function discard() {
    if (!current) return;
    const name = current.name;
    setDrafts((all) => withoutDraft(all, name));
    setNotice(null);
    setHint(null);
  }

  /** Show what the server stored for the role, and drop its unsaved changes. */
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
      // The whole set, not just the lines that changed: see PUT /api/admin/roles.
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
          // The picker's "Nothing turned on" is the empty value.
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
      setView("one");
      setCreating(false);
      setForm(EMPTY_FORM);
      setNotice({
        tone: "ok",
        text:
          `Created ${role.label}. Change what it can do above if needed, ` +
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
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <PermissionsGuide showViewAs={showViewAs} />
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
          <Skeleton width="100%" height={72} radius={12} />
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
          <div className="mt-4 flex items-center justify-between gap-2 flex-wrap">
            <div className="seg" role="group" aria-label="View">
              <button
                type="button"
                className={view === "one" ? "active" : ""}
                aria-pressed={view === "one"}
                onClick={() => setView("one")}
              >
                One role
              </button>
              <button
                type="button"
                className={view === "compare" ? "active" : ""}
                aria-pressed={view === "compare"}
                onClick={() => setView("compare")}
              >
                Compare roles
              </button>
            </div>
            {can("roles:create") && !creating && (
              <Button variant="ghost" size="sm" onClick={openCreate}>
                <PlusIcon size={14} /> New role
              </Button>
            )}
          </div>

          {/* One card per role: its name, what it adds up to (unsaved changes
              included) and how many people have it. A screen reader gets the
              same from aria-label, with commas between the parts. */}
          <div role="group" aria-label="Roles" className="role-cards mt-3">
            {roles.map((role) => {
              const isCurrent = view === "one" && role.name === current?.name;
              const unsaved = unsavedCount(role) > 0;
              const summary = roleSummary(role.name, drafts.get(role.name) ?? role.permissions);
              return (
                <button
                  key={role.name}
                  type="button"
                  className={isCurrent ? "role-card current" : "role-card"}
                  aria-pressed={isCurrent}
                  aria-label={`${role.label}, ${summary}, ${peopleText(role.userCount)}${
                    unsaved ? ", unsaved changes" : ""
                  }`}
                  onClick={() => selectRole(role.name)}
                >
                  <span className="role-card__name">
                    {role.label}
                    {unsaved && <span className="perm-unsaved">Unsaved</span>}
                  </span>
                  <span className="role-card__summary">{summary}</span>
                  <span className="role-card__people">{peopleText(role.userCount)}</span>
                </button>
              );
            })}
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
                      <p className="help mt-1">{ADMIN_COPY_NOTE}</p>
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

          {view === "compare" && (
            <Card className="mt-4 p-4 sm:p-5">
              <h2 className="text-[15px] font-semibold">Compare roles</h2>
              <p className="help mt-0.5 mb-3">
                Every role side by side. Pick a role above to change what it can do.
              </p>
              <RoleCompare roles={roles} hasDrafts={drafts.size > 0} />
            </Card>
          )}

          {/* Not overflow-hidden: the save bar at the bottom is sticky, and a
              card that clips its contents would stop it sticking. */}
          {view === "one" && current && (
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
                  <div className="mt-1 flex items-center gap-x-2 gap-y-1 flex-wrap">
                    <p className="help">
                      {holdersText(current.userCount)}
                      {showDelete &&
                        current.userCount > 0 &&
                        " To delete it, give them another role on the Users tab first."}
                    </p>
                    {onShowUsers && current.userCount > 0 && (
                      <Button variant="ghost" size="sm" onClick={onShowUsers}>
                        <UsersIcon size={14} /> See them on the Users tab
                      </Button>
                    )}
                  </div>
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

              {/* The four things people ask about a role first, worked out from
                  its lines as they are on screen, unsaved changes included. */}
              <div className="px-4 sm:px-5 pb-4" role="group" aria-label="At a glance">
                <dl className="role-glance">
                  {glance(current.name, shown).map((row) => (
                    <div key={row.label} className={row.yes ? "yes" : "no"}>
                      <dt>{row.label}</dt>
                      <dd>{glanceValue(row)}</dd>
                    </div>
                  ))}
                </dl>
              </div>

              {isAdminRole && (
                <div className="px-4 sm:px-5 pb-4">
                  <div className="role-note">
                    <InfoIcon size={15} className="ico" />
                    <div>
                      <div className="title">Admin can always do everything</div>
                      <div className="body">
                        {"Its lines can't be changed, so that nobody can lock every admin out " +
                          "of this page."}
                      </div>
                    </div>
                  </div>
                </div>
              )}

              <PermissionList
                roleLabel={current.label}
                isAdminRole={isAdminRole}
                shown={shown}
                saved={saved}
                disabled={!canUpdate || busy !== null}
                hint={shownHint}
                onToggle={toggle}
                onUndo={undo}
              />

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
                      <div className="role-savebar__changes">
                        {changeSentences(current.label, saved, shown).map((sentence) => (
                          <p key={sentence}>{sentence}</p>
                        ))}
                      </div>
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
            <p className="help mt-0.5 mb-3">
              Changes to roles, to who has them and to the organization, newest first.
            </p>
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
              ? `${toConfirm.role.label} goes back to what it can do on a new install. ` +
                "Every line this turns on or off is listed in Recent changes." +
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
