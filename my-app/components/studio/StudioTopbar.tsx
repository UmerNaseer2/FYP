"use client";

import type { ReactNode } from "react";
import { ChevronRightIcon, MenuIcon } from "@/components/ui/icons";
import { useOrg } from "@/hooks/useOrg";

type StudioTopbarProps = {
  /** Current screen name, shown after the organization's name in the breadcrumb. */
  breadcrumbScreen: string;
  /** Show the hamburger that opens the mobile nav drawer. */
  showMenu?: boolean;
  onMenuClick?: () => void;
  /** Shown at the right end of the bar (the schema chat button). */
  action?: ReactNode;
};

/**
 * Top chrome: a breadcrumb that reflects the active screen, plus a hamburger
 * that opens the nav drawer on mobile. Each screen exposes its own working
 * actions in the page body, so the top bar stays intentionally minimal: the
 * one action it carries is the schema chat, which belongs to no one screen.
 */
export function StudioTopbar({ breadcrumbScreen, showMenu = false, onMenuClick, action }: StudioTopbarProps) {
  // The breadcrumb starts with the organization the page is open in, so
  // someone who belongs to two can see which one they are working in. Every
  // studio page has one (app/[org]/layout.tsx); without one, as in a component
  // test, the screen name stands alone.
  const orgName = useOrg()?.name ?? null;

  return (
    <div
      className="topbar h-14 px-3 sm:px-5 flex items-center gap-2 sm:gap-4 flex-none"
      style={{ borderBottom: "1px solid var(--border)", background: "var(--surface)" }}
    >
      {showMenu && (
        <button
          className="btn btn-ghost btn-sm flex-none"
          aria-label="Open navigation"
          onClick={onMenuClick}
        >
          <MenuIcon size={18} />
        </button>
      )}
      {/* Breadcrumb: the organization, then the active screen. On phones the
          organization half hides (.crumb-org in globals.css) to save room. */}
      <nav className="flex items-center gap-2 text-[13px] min-w-0" style={{ color: "var(--text-2)" }}>
        {orgName && (
          <>
            <span className="crumb-org truncate max-w-[16rem]" style={{ color: "var(--text-3)" }} title={orgName}>
              {orgName}
            </span>
            <ChevronRightIcon size={12} className="crumb-org flex-none" />
          </>
        )}
        <span className="font-medium truncate" style={{ color: "var(--text)" }}>
          {breadcrumbScreen}
        </span>
      </nav>
      {action && <div className="ml-auto flex items-center gap-2 flex-none">{action}</div>}
    </div>
  );
}
