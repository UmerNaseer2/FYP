"use client";

import "@/app/styles/atelier-admin.css";
import { useState } from "react";
import { AskAdmin } from "@/components/studio/AskAdmin";
import { useUser } from "@/hooks/useUser";
import { refusalMessage } from "@/lib/permissions";
import { Skeleton } from "@/components/ui";
import { LockIcon } from "@/components/ui/icons";
import { PageHeader } from "@/components/studio/PageHeader";
import { PillTabs } from "@/components/studio/PillTabs";
import { UsersTab } from "@/components/admin/UsersTab";
import { RolesTab } from "@/components/admin/RolesTab";
import { OrganizationTab } from "@/components/admin/OrganizationTab";
import { GitHubTab } from "@/components/admin/GitHubTab";
import { AiTab } from "@/components/admin/AiTab";

/**
 * The Admin screen: who is in this organization (Users), what each role can do
 * in it (Roles & permissions), the organization itself (Organization: its
 * name, its two-person rule, deleting it), and where its scripts are kept
 * (GitHub: the repository and its access token), and whether AI assistance
 * is on (AI). Each tab lives in its own file
 * under components/admin, and this page only decides which tabs to show.
 *
 * A tab shows only for someone allowed to read it. Out of the box that is the
 * admin role alone for all four, so an admin sees every tab and nobody else
 * gets this far: the layout's AuthGuard turns everyone else away first. Users
 * and GitHub are not admin-only, though, so an Admin can make a role that
 * sees one or both of those tabs alone.
 */

type Tab = "users" | "roles" | "organization" | "github" | "ai";

const TABS: { key: Tab; label: string }[] = [
  { key: "users", label: "Users" },
  { key: "roles", label: "Roles & permissions" },
  { key: "organization", label: "Organization" },
  { key: "github", label: "GitHub" },
  { key: "ai", label: "AI" },
];

export default function AdminPage() {
  const { loading, can, roleLabel, bypass } = useUser();
  // The tab the person clicked. Null until they click one, which shows the
  // first tab they may open.
  const [picked, setPicked] = useState<Tab | null>(null);

  if (loading) {
    return (
      <div className="ad-page max-w-[1100px] mx-auto px-4 sm:px-8 py-8 sm:py-10">
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
    github: can("github:read"),
    // The org-wide AI switch is one of the organization's settings.
    ai: can("organization:read"),
  };
  const tabs = TABS.filter((t) => allowed[t.key]);
  // A tab that was picked and then taken away (the role changed while the
  // page was open) falls back to the first one still allowed.
  const tab = picked && allowed[picked] ? picked : (tabs[0]?.key ?? null);

  // "See them on the Users tab" on the Roles tab. Focus goes to the Users tab
  // itself, so keyboard and screen reader users land where the list starts.
  function showUsers() {
    setPicked("users");
    document.getElementById("admin-tab-users")?.focus();
  }

  return (
    <div className="ad-page max-w-[1100px] mx-auto px-4 sm:px-8 py-8 sm:py-10">
      <PageHeader page="/admin" title="Who can do what.">
        {tab !== null && (
          <PillTabs
            label="Admin sections"
            tabs={tabs}
            value={tab}
            onChange={(key) => setPicked(key as Tab)}
            idPrefix="admin-tab-"
            panelPrefix="admin-panel-"
          />
        )}
      </PageHeader>

      {tab === null ? (
        // Only a fallback: the layout's <AuthGuard feature={["users", "roles",
        // "organization", "github"]}> is what really turns away a role that may
        // read no tab.
        <div className="card ad-stop">
          <span className="ad-stop__lock" aria-hidden>
            <LockIcon size={22} />
          </span>
          <h2>{"You can't manage users or roles"}</h2>
          <p>{refusalMessage(roleLabel, "users:read")}</p>
          <AskAdmin permission="users:read" />
        </div>
      ) : (
        <>
          {/* Every tab stays mounted and a hidden one is only hidden, so a
              half-changed list or a half-filled form is still there when the
              person comes back. `active` tells a tab when it is on screen, so
              it loads then and not while hidden. */}
          {tabs.map((t) => (
            <section
              key={t.key}
              role="tabpanel"
              id={`admin-panel-${t.key}`}
              aria-labelledby={`admin-tab-${t.key}`}
              hidden={tab !== t.key}
              className="ad-panel"
            >
              {t.key === "users" ? (
                <UsersTab active={tab === "users"} />
              ) : t.key === "roles" ? (
                <RolesTab
                  active={tab === "roles"}
                  showViewAs={bypass}
                  onShowUsers={allowed.users ? showUsers : undefined}
                />
              ) : t.key === "organization" ? (
                <OrganizationTab active={tab === "organization"} />
              ) : t.key === "github" ? (
                <GitHubTab active={tab === "github"} />
              ) : (
                <AiTab active={tab === "ai"} />
              )}
            </section>
          ))}
        </>
      )}
    </div>
  );
}
