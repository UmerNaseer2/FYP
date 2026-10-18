"use client";

import {
  ACTIONS,
  ACTION_LABELS,
  FEATURES,
  PERMISSIONS,
  isAdminOnly,
  isPermissionKey,
  permissionLabel,
  readKeyOf,
  type PermissionKey,
} from "@/lib/permissions";

/**
 * The grid on the Roles & permissions tab: one row per feature, one column per
 * action, a box wherever that feature has that action.
 *
 * Rows and columns come straight from the catalogue in lib/permissions.ts, so
 * a feature added there shows up here with nothing to change in this file. A
 * blank cell means the feature has no such action (nothing on the Dashboard
 * can be deleted), not that the role lacks it.
 *
 * The grid only draws boxes and reports clicks. What a click does to the set
 * (ticking Create also ticks Read, and so on) is withToggled's job, in the
 * same file as the catalogue, so the rule is tested without a screen.
 */

/** What each box lets someone do, for its tooltip. */
const DOES = new Map(PERMISSIONS.map((permission) => [permission.key, permission.does]));

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function PermissionGrid({
  roleLabel,
  isAdminRole,
  shown,
  saved,
  disabled,
  onToggle,
}: {
  /** The role's name as people read it, for the table's caption. */
  roleLabel: string;
  /** True for the admin role: every box ticked, none of them editable. */
  isAdminRole: boolean;
  /** What the boxes show: the unsaved changes, if there are any. */
  shown: readonly PermissionKey[];
  /** What is stored, so a box that differs from it can be marked. */
  saved: readonly PermissionKey[];
  /** Nothing can be changed: no Update permission here, or a save is running. */
  disabled: boolean;
  onToggle: (key: PermissionKey, on: boolean) => void;
}) {
  const shownSet = new Set<string>(shown);
  const savedSet = new Set<string>(saved);

  return (
    <div className="overflow-x-auto">
      <table className="perm-grid">
        <caption className="sr-only">What {roleLabel} can do, feature by feature</caption>
        <thead>
          <tr>
            <th scope="col">Feature</th>
            {ACTIONS.map((action) => (
              <th key={action} scope="col">
                {ACTION_LABELS[action]}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {FEATURES.map((feature) => {
            // Every feature has a Read, so its Read says whether the whole
            // feature is admin-only.
            const adminOnly = isAdminOnly(readKeyOf(feature.key));
            return (
              <tr key={feature.key}>
                <th scope="row">
                  <div>{feature.label}</div>
                  <div className="feature-desc">{feature.description}</div>
                </th>
                {adminOnly && !isAdminRole ? (
                  <td
                    colSpan={ACTIONS.length}
                    className="admins-only"
                    title="Only the admin role can manage people and roles, so no role can make itself an admin."
                  >
                    Admins only
                  </td>
                ) : (
                  ACTIONS.map((action) => {
                    const key = `${feature.key}:${action}`;
                    if (!isPermissionKey(key)) return <td key={action} aria-hidden="true" />;
                    const ticked = isAdminRole || shownSet.has(key);
                    const changed = !isAdminRole && shownSet.has(key) !== savedSet.has(key);
                    return (
                      <td key={action} className={changed ? "changed" : undefined}>
                        <input
                          type="checkbox"
                          aria-label={permissionLabel(key)}
                          title={capitalise(DOES.get(key) ?? "")}
                          checked={ticked}
                          disabled={isAdminRole || disabled}
                          onChange={(event) => onToggle(key, event.target.checked)}
                        />
                      </td>
                    );
                  })
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
