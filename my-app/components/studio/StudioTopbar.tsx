import type { ReactNode } from "react";
import { ChevronRightIcon, MenuIcon } from "@/components/ui/icons";

type StudioTopbarProps = {
  /** Current screen name, shown after "Workspace ›" in the breadcrumb. */
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
      {/* Breadcrumb — reflects the active route. "Workspace ›" hides on phones. */}
      <nav className="flex items-center gap-2 text-[13px] min-w-0" style={{ color: "var(--text-2)" }}>
        <span className="crumb-workspace" style={{ color: "var(--text-3)" }}>
          Workspace
        </span>
        <ChevronRightIcon size={12} className="crumb-workspace" />
        <span className="font-medium truncate" style={{ color: "var(--text)" }}>
          {breadcrumbScreen}
        </span>
      </nav>
      {action && <div className="ml-auto flex items-center gap-2 flex-none">{action}</div>}
    </div>
  );
}
