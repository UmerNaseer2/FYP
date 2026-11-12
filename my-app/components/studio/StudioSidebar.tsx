import Link from "next/link";
import type { ReactNode } from "react";
import { ChevronLeftIcon } from "@/components/ui/icons";
import { BrandMark } from "@/components/ui/BrandMark";
import { Pill } from "@/components/ui/Pill";
import { APP_VERSION } from "@/lib/app-version";
import type { NavItem } from "./nav";

// The studio's left rail: a soft rounded panel that floats beside the page.
//
// From the top: the Schema Studio mark and name, the pages as pills (the one
// you are on is solid ink), then the organization switcher at the foot. Who
// you are, the theme and signing out live in the top bar's account menu
// (components/studio/AccountMenu), not here.
//
// Folded to icons it is about the width of one pill. The labels are still in
// the page for screen readers, and every pill keeps its label as a tooltip.

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
          {items.map((item) => {
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
        </nav>

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
