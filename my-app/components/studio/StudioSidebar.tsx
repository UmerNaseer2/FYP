import Link from "next/link";
import type { ReactNode } from "react";
import { ChevronLeftIcon } from "@/components/ui/icons";
import { BrandMark } from "@/components/ui/BrandMark";
import { Pill } from "@/components/ui/Pill";
import { APP_VERSION } from "@/lib/ui/app-version";
import { groupNavItems, type NavItem } from "./nav";

// The studio's left rail: a soft rounded panel that floats beside the page.
//
// From the top: the Schema Studio mark and name, the pages as pills (the one
// you are on is solid ink) under their group headings (Connect, Compare,
// Script, Ship, Watch, People), then the organization switcher at the foot.
// Who you are, the theme and signing out live in the top bar's account menu
// (components/studio/AccountMenu), not here. On a phone the shell also hands
// in `tools` (Help, the theme switch, Ask AI), which the top bar has no room
// for.
//
// Folded to icons it is about the width of one pill. The labels are still in
// the page for screen readers, every pill keeps its label as a tooltip, and
// each group heading becomes a short line between the groups.

export type StudioUser = {
  name: string;
  email: string;
  /** Up to two letters for the round avatar. */
  initials: string;
};

type StudioSidebarProps = {
  items: NavItem[];
  /** The href of the page you are on. */
  activeHref: string;
  collapsed: boolean;
  onToggleCollapse: () => void;
  /**
   * Only with the sign-in bypass on (a developer's machine): the auth off
   * warning and the "View as" role picker, so nobody forgets it is on.
   */
  bypass?: boolean;
  viewAs?: ReactNode;
  /** The organization switcher (components/studio/OrgSwitcher). */
  orgSwitcher?: ReactNode;
  /** Extra buttons above the footer: the phone drawer's Help, theme and Ask AI. */
  tools?: ReactNode;
  className?: string;
};

export function StudioSidebar({
  items,
  activeHref,
  collapsed,
  onToggleCollapse,
  bypass,
  viewAs,
  orgSwitcher,
  tools,
  className = "",
}: StudioSidebarProps) {
  const labelHidden = collapsed ? "sr-only" : "";

  return (
    <aside className={`side-wrap ${className}`}>
      <div className={`side ${collapsed ? "side-folded" : ""}`}>
        {collapsed ? (
          <button
            type="button"
            className="brand sb-expand"
            onClick={onToggleCollapse}
            title="Expand"
            aria-label="Expand sidebar"
          >
            <BrandMark size={28} data-intro-target="" />
          </button>
        ) : (
          <div className="brand">
            <BrandMark size={30} data-intro-target="" />
            <span className="brand-name">Schema Studio</span>
            <span className="brand-v mono">v{APP_VERSION}</span>
            <button
              type="button"
              className="sb-fold"
              onClick={onToggleCollapse}
              title="Collapse"
              aria-label="Collapse sidebar"
            >
              <ChevronLeftIcon size={14} />
            </button>
          </div>
        )}

        <nav className="nav" aria-label="Pages">
          {groupNavItems(items).map((section) => (
            // One group of pages. The heading names the group for screen
            // readers too; Dashboard on top has no heading and no group.
            <div
              key={section.group ?? "top"}
              className="nav-sec"
              role={section.group ? "group" : undefined}
              aria-label={section.group ?? undefined}
            >
              {section.group && (
                <p className="nav-group" aria-hidden="true">
                  <span className={labelHidden}>{section.group}</span>
                </p>
              )}
              {section.items.map((item) => {
                const active = item.href === activeHref;
                const badge = item.badge ?? 0;
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={`nav-item ${active ? "active" : ""}`}
                    aria-current={active ? "page" : undefined}
                    title={item.label}
                  >
                    {item.icon}
                    <span className={labelHidden}>{item.label}</span>
                    {badge > 0 && (
                      <em className={collapsed ? "badge badge-dot" : "badge"}>
                        <span className={collapsed ? "sr-only" : ""}>{badge}</span>
                        <span className="sr-only"> waiting</span>
                      </em>
                    )}
                  </Link>
                );
              })}
            </div>
          ))}
        </nav>

        {tools && <div className="side-tools">{tools}</div>}

        <div className="side-foot">
          {!collapsed && orgSwitcher && <div className="empty:hidden">{orgSwitcher}</div>}
          {bypass && (
            <Pill
              tone="drift"
              className="side-bypass"
              title="NEXT_PUBLIC_AUTH_BYPASS is on: nobody signed in, and every request is let through as an admin, or as the role picked in View as. Turn it off before this is used for real."
            >
              <span className={labelHidden}>auth off</span>
            </Pill>
          )}
          {!collapsed && viewAs}
        </div>
      </div>
    </aside>
  );
}
