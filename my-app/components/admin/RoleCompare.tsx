"use client";

import { ADMIN_ROLE, type Permission } from "@/lib/permissions";
import type { RoleSummary } from "@/lib/roles-db";
import { ADMIN_ONLY_TABS, SCREEN_GROUPS, capitalise, glance } from "@/lib/role-summary";
import { CheckIcon } from "@/components/ui";

// ---------------------------------------------------------------------------
// RoleCompare
// Every role side by side, read-only: the four answers at a glance, then the
// same sentences as the one-role list, one column per role. It shows what is
// saved, because that is what people with the role can do right now.
// ---------------------------------------------------------------------------

/** The four at-a-glance questions. Only their wording is used from this call. */
const GLANCE_ROWS = glance("", []);

function Cell({ yes }: { yes: boolean }) {
  return (
    <td className={yes ? "yes" : "no"}>
      {yes ? (
        <>
          <CheckIcon size={13} aria-hidden="true" /> Yes
        </>
      ) : (
        "No"
      )}
    </td>
  );
}

function GroupRow({ title, span }: { title: string; span: number }) {
  return (
    <tr className="ad-cmp__group">
      <th scope="rowgroup" colSpan={span}>
        {title}
      </th>
    </tr>
  );
}

export function RoleCompare({
  roles,
  hasDrafts,
}: {
  roles: readonly RoleSummary[];
  hasDrafts: boolean;
}) {
  const span = roles.length + 1;
  const glances = roles.map((role) => glance(role.name, role.permissions));
  const holds = (role: RoleSummary, permission: Permission) =>
    role.name === ADMIN_ROLE || role.permissions.includes(permission.key);

  return (
    <div className="ad-cmp-wrap">
      {hasDrafts && (
        <p className="help">Shows what is saved. Unsaved changes count once they are saved.</p>
      )}
      <div className="ad-cmp relative" role="region" aria-label="Compare roles" tabIndex={0}>
        <table>
          <caption className="sr-only">What each role can do</caption>
          <thead>
            <tr>
              <th scope="col">What it allows</th>
              {roles.map((role) => (
                <th key={role.name} scope="col">
                  {role.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <GroupRow title="At a glance" span={span} />
            {GLANCE_ROWS.map((row, index) => (
              <tr key={row.label}>
                <th scope="row">{row.detail ? `${row.label}, ${row.detail}` : row.label}</th>
                {roles.map((role, column) => (
                  <Cell key={role.name} yes={glances[column][index].yes} />
                ))}
              </tr>
            ))}
          </tbody>
          {SCREEN_GROUPS.map((group) => {
            const lines = group.features
              .filter((feature) => !feature.adminOnly)
              .flatMap((feature) => [feature.read, ...feature.others]);
            const locked = group.features.some((feature) => feature.adminOnly);
            return (
              <tbody key={group.screen}>
                <GroupRow title={group.screen} span={span} />
                {lines.map((permission) => (
                  <tr key={permission.key}>
                    <th scope="row" className={permission.action === "read" ? undefined : "sub"}>
                      {capitalise(permission.does)}
                    </th>
                    {roles.map((role) => (
                      <Cell key={role.name} yes={holds(role, permission)} />
                    ))}
                  </tr>
                ))}
                {locked && (
                  <tr>
                    <th scope="row">{ADMIN_ONLY_TABS}</th>
                    {roles.map((role) => (
                      <Cell key={role.name} yes={role.name === ADMIN_ROLE} />
                    ))}
                  </tr>
                )}
              </tbody>
            );
          })}
        </table>
      </div>
    </div>
  );
}
