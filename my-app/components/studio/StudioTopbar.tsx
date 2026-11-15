"use client";

import { useEffect, useState, type ReactNode } from "react";
import { ChevronRightIcon, MenuIcon, SearchIcon } from "@/components/ui/icons";
import { useOrg } from "@/hooks/useOrg";

type StudioTopbarProps = {
  /** Current screen name, the last part of the breadcrumb. */
  breadcrumbScreen: string;
  /** The screen's menu group ("Watch"), shown before it. Dashboard has none. */
  breadcrumbGroup?: string;
  /** Show the button that opens the navigation drawer (phones). */
  showMenu?: boolean;
  onMenuClick?: () => void;
  /** Requests waiting on this person. Above 0 the menu button carries a dot. */
  menuWaiting?: number;
  /** Opens the command bar. Leave it out and the search pill is not drawn. */
  onOpenCommand?: () => void;
  /**
   * The round buttons at the right end: Ask AI, Help, Needs you, theme and
   * account. On a phone the shell passes the account button only; the rest
   * are in the drawer.
   */
  action?: ReactNode;
};

/**
 * The bar across the top of every studio page, floating on the page with no
 * line under it: where you are, the search pill that opens the command bar,
 * and the round buttons on the right.
 *
 * Each page keeps its own working controls in its body, so the bar only holds
 * what belongs to no one page.
 */
export function StudioTopbar({
  breadcrumbScreen,
  breadcrumbGroup,
  showMenu = false,
  onMenuClick,
  menuWaiting = 0,
  onOpenCommand,
  action,
}: StudioTopbarProps) {
  // The breadcrumb reads "Group › Page", the same two names the menu shows.
  // The organization the page is open in is its tooltip, and is named in the
  // account menu and the menu's organization picker.
  const orgName = useOrg()?.name ?? null;
  const menuLabel =
    menuWaiting > 0
      ? `Open navigation, ${menuWaiting} ${menuWaiting === 1 ? "request" : "requests"} waiting on you`
      : "Open navigation";

  // "⌘ K" on a Mac, "Ctrl K" everywhere else. Read after the first draw, so
  // the server and the browser start out drawing the same thing.
  const [shortcut, setShortcut] = useState("Ctrl K");
  useEffect(() => {
    const platform = navigator.platform || navigator.userAgent;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (/Mac|iPhone|iPad/.test(platform)) setShortcut("⌘ K");
  }, []);

  return (
    <div className="top topbar">
      {showMenu && (
        <button type="button" className="tb tb-menu" aria-label={menuLabel} onClick={onMenuClick}>
          <MenuIcon size={18} />
          {/* A dot, not a number: the count is on Requests inside the drawer. */}
          {menuWaiting > 0 && <i className="tb-dot" aria-hidden="true" />}
        </button>
      )}

      {/* The group half hides on narrow windows (.crumb-group in globals.css);
          the screen name always stays, cut short with an ellipsis if it must be. */}
      <nav
        className="org"
        aria-label="Breadcrumb"
        title={orgName ? `${breadcrumbScreen}, in ${orgName}` : undefined}
      >
        {breadcrumbGroup && (
          <>
            <span className="crumb-group">{breadcrumbGroup}</span>
            <span className="crumb-group crumb-sep" aria-hidden="true">
              <ChevronRightIcon size={13} />
            </span>
          </>
        )}
        <span className="crumb-screen" aria-current="page">
          {breadcrumbScreen}
        </span>
      </nav>

      {onOpenCommand && (
        <button
          type="button"
          className="ck-b"
          onClick={onOpenCommand}
          aria-haspopup="dialog"
          aria-label={`Search or jump to a page (${shortcut})`}
        >
          <SearchIcon size={16} />
          <span>Search or jump to</span>
          <kbd aria-hidden="true">{shortcut}</kbd>
        </button>
      )}

      {action && <div className="top-actions">{action}</div>}
    </div>
  );
}
