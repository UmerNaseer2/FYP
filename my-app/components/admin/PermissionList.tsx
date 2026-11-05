"use client";

import { useId } from "react";
import { RISK_LABELS, type Permission, type PermissionKey, type Risk } from "@/lib/permissions";
import {
  ADMIN_ONLY_LINE,
  SCREEN_GROUPS,
  capitalise,
  type FeatureLines,
  type ToggleHint,
} from "@/lib/role-summary";
import { Button, InfoIcon, LockIcon, Pill, type PillTone } from "@/components/ui";

// ---------------------------------------------------------------------------
// PermissionList
// What one role can do, as plain sentences with a tick box each, grouped
// under the sidebar's screen names in the sidebar's order. A feature's see or
// open line comes first and the lines that need it sit indented under it.
//
// The list only shows and reports clicks. RolesTab keeps the unsaved changes,
// works out what a click did (withToggled) and passes back a hint when the
// click also turned another line on or off, which shows under that feature
// with an Undo.
// ---------------------------------------------------------------------------

/** Red for what changes a database or production, amber for live databases. */
const RISK_TONE: Record<Risk, PillTone> = {
  database: "break",
  production: "break",
  live: "drift",
};

type Props = {
  roleLabel: string;
  /** Admin's lines are all on and can't be changed. */
  isAdminRole: boolean;
  /** What the role holds now, unsaved changes included. */
  shown: readonly PermissionKey[];
  /** What is saved, to mark the lines that would change. */
  saved: readonly PermissionKey[];
  /** True while saving, or when the viewer may not change roles. */
  disabled: boolean;
  hint: ToggleHint | null;
  onToggle: (key: PermissionKey, on: boolean) => void;
  onUndo: () => void;
};

export function PermissionList({
  roleLabel,
  isAdminRole,
  shown,
  saved,
  disabled,
  hint,
  onToggle,
  onUndo,
}: Props) {
  const baseId = useId();
  const held = new Set<string>(shown);
  const before = new Set<string>(saved);
  const idOf = (key: string) => `${baseId}${key}`;

  function undo() {
    // The Undo button goes away with the hint, so focus goes back to the
    // line that was clicked rather than to the top of the page.
    if (hint) document.getElementById(idOf(hint.key))?.focus();
    onUndo();
  }

  function line(permission: Permission) {
    const id = idOf(permission.key);
    const on = isAdminRole || held.has(permission.key);
    const changed = !isAdminRole && on !== before.has(permission.key);
    const riskId = permission.risk ? `${id}-risk` : undefined;
    const noteId = permission.note ? `${id}-note` : undefined;
    const describedBy = [riskId, noteId].filter(Boolean).join(" ") || undefined;
    return (
      <div key={permission.key} className={changed ? "perm-line changed" : "perm-line"}>
        <input
          id={id}
          type="checkbox"
          checked={on}
          disabled={isAdminRole || disabled}
          aria-describedby={describedBy}
          onChange={(event) => onToggle(permission.key, event.target.checked)}
        />
        <div className="perm-line__body">
          <div className="perm-line__head">
            <label htmlFor={id}>{capitalise(permission.does)}</label>
            {permission.risk && (
              <Pill id={riskId} tone={RISK_TONE[permission.risk]} dot={false}>
                {RISK_LABELS[permission.risk]}
              </Pill>
            )}
            {changed && <span className="perm-unsaved">Unsaved</span>}
          </div>
          {permission.note && (
            <p id={noteId} className="help perm-note">
              {permission.note}
            </p>
          )}
        </div>
      </div>
    );
  }

  function feature(lines: FeatureLines) {
    return (
      <div key={lines.feature} className="perm-feature">
        {line(lines.read)}
        {lines.others.length > 0 && <div className="perm-sub">{lines.others.map(line)}</div>}
        {hint?.feature === lines.feature && (
          <div className="perm-hint">
            <InfoIcon size={14} aria-hidden="true" />
            <span className="perm-hint__text">{hint.text}</span>
            <Button variant="ghost" size="sm" onClick={undo} disabled={disabled}>
              Undo
            </Button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="perm-list relative" role="group" aria-label={`What ${roleLabel} can do`}>
      {/* Always in the page, so a screen reader hears each hint as it appears. */}
      <div className="sr-only" role="status">
        {hint?.text ?? ""}
      </div>
      {SCREEN_GROUPS.map((group) => {
        // Every other role skips the admin-only lines: one locked line says why.
        const features = isAdminRole
          ? group.features
          : group.features.filter((lines) => !lines.adminOnly);
        const locked = group.features.some((lines) => lines.adminOnly);
        if (features.length === 0 && !locked) return null;
        const headingId = `${baseId}screen-${group.screen.replace(/[^A-Za-z]+/g, "-")}`;
        return (
          <div key={group.screen} className="perm-screen" role="group" aria-labelledby={headingId}>
            <h3 id={headingId}>{group.screen}</h3>
            {features.map(feature)}
            {locked && (
              <p className="perm-locked">
                <LockIcon size={14} aria-hidden="true" />
                <span>{ADMIN_ONLY_LINE}</span>
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}
