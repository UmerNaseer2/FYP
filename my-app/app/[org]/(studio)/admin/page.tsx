"use client";

import { useState } from "react";
import { useUser } from "@/hooks/useUser";
import { refusalMessage } from "@/lib/permissions";
import { Skeleton } from "@/components/ui";
import { InfoIcon } from "@/components/ui/icons";
import { UsersTab } from "@/components/admin/UsersTab";
import { RolesTab } from "@/components/admin/RolesTab";
import { OrganizationTab } from "@/components/admin/OrganizationTab";
import { PermissionsGuide } from "@/components/admin/PermissionsGuide";

/**
 * The Admin screen: who is in this organization (Users), what each role can do
 * in it (Roles & permissions), and the organization itself (Organization: its
 * name, its two-person rule, deleting it). Each tab lives in its own file
 * under components/admin, and this page only decides which tabs to show.
 *
 * A tab shows only for someone allowed to read it. Out of the box that is the
 * admin role alone for all three, so an admin sees every tab and nobody else
 * gets this far: the layout's AuthGuard turns everyone else away first. Users
 * is not admin-only, though, so an Admin can make a role that sees that tab
 * alone.
 */

type Tab = "users" | "roles" | "organization";

const TABS: { key: Tab; label: string }[] = [
  { key: "users", label: "Users" },
  { key: "roles", label: "Roles & permissions" },
  { key: "organization", label: "Organization" },
];

export default function AdminPage() {
  const { loading, can, roleLabel, bypass } = useUser();
  // The tab the person clicked. Null until they click one, which shows the
  // first tab they may open.
  const [picked, setPicked] = useState<Tab | null>(null);

  if (loading) {
    return (
      <div className="max-w-[920px] mx-auto px-5 sm:px-8 py-8 sm:py-10">
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

  const allowed: Record<Tab, boolean> = {
    users: can("users:read"),
    roles: can("roles:read"),
    organization: can("organization:read"),
  };
  const tabs = TABS.filter((t) => allowed[t.key]);
  // A tab that was picked and then taken away (the role changed while the
  // page was open) falls back to the first one still allowed.
  const tab = picked && allowed[picked] ? picked : (tabs[0]?.key ?? null);

  return (
    <div className="max-w-[920px] mx-auto px-5 sm:px-8 py-8 sm:py-10">
      <header>
        <div className="section-title">Admin</div>
        <h1 className="text-[26px] sm:text-[28px] font-semibold tracking-[-0.02em] mt-1">
          People and the organization
        </h1>
        <p className="text-[13.5px] mt-1.5 max-w-[56ch]" style={{ color: "var(--text-2)" }}>
          Decide who is in this organization, what each role can do in it, and how it is run.
        </p>
      </header>

      {tab === null ? (
        // Only a fallback: the layout's <AuthGuard feature={["users", "roles",
        // "organization"]}> is what really turns away a role that may read no tab.
        <div className="role-note mt-6">
          <InfoIcon size={15} className="ico" />
          <div>
            <div className="title">{"You can't manage users or roles"}</div>
            <div className="body">{refusalMessage(roleLabel, "users:read")}</div>
          </div>
        </div>
      ) : (
        <>
          {/* Above the tabs, because it explains both: Roles & permissions
              says what a role may do, and Users gives it to people. */}
          <PermissionsGuide showViewAs={bypass} />

          <div className="seg mt-6" role="tablist" aria-label="Admin sections">
            {tabs.map((t) => (
              <button
                key={t.key}
                type="button"
                role="tab"
                id={`admin-tab-${t.key}`}
                aria-controls={`admin-panel-${t.key}`}
                aria-selected={tab === t.key}
                className={tab === t.key ? "active" : ""}
                onClick={() => setPicked(t.key)}
              >
                {t.label}
              </button>
            ))}
          </div>

          {/* Every tab stays mounted and a hidden one is only hidden, so a
              half-ticked grid or a half-filled form is still there when the
              person comes back. `active` tells a tab when it is on screen, so
              it loads then and not while hidden. */}
          {tabs.map((t) => (
            <section
              key={t.key}
              role="tabpanel"
              id={`admin-panel-${t.key}`}
              aria-labelledby={`admin-tab-${t.key}`}
              hidden={tab !== t.key}
              className="mt-6"
            >
              {t.key === "users" ? (
                <UsersTab active={tab === "users"} />
              ) : t.key === "roles" ? (
                <RolesTab active={tab === "roles"} />
              ) : (
                <OrganizationTab active={tab === "organization"} />
              )}
            </section>
          ))}
        </>
      )}
    </div>
  );
}
