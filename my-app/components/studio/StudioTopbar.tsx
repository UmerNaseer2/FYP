"use client";

import { useEffect, useState, type ReactNode } from "react";
import { MenuIcon, SearchIcon } from "@/components/ui/icons";
import { useOrg } from "@/hooks/useOrg";

type StudioTopbarProps = {
  /** Current screen name, shown after the organization's name in the breadcrumb. */
  breadcrumbScreen: string;
  /** Show the button that opens the navigation drawer (phones). */
  showMenu?: boolean;
  onMenuClick?: () => void;
  /** Opens the command bar. Leave it out and the search pill is not drawn. */
  onOpenCommand?: () => void;
  /** The round buttons at the right end: Ask AI, Help, Needs you, theme, account. */
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
  showMenu = false,
  onMenuClick,
  onOpenCommand,
  action,
}: StudioTopbarProps) {
  // The breadcrumb starts with the organization the page is open in, so
  // someone who belongs to two can see which one they are working in. Every
  // studio page has one (app/[org]/layout.tsx); without one, as in a component
  // test, the screen name stands alone.
  const orgName = useOrg()?.name ?? null;

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
        <button type="button" className="tb" aria-label="Open navigation" onClick={onMenuClick}>
          <MenuIcon size={18} />
        </button>
      )}

      {/* The organization half hides on narrower windows (.crumb-org in
          globals.css); the screen name always stays. */}
      <nav className="org" aria-label="Breadcrumb">
        {orgName && (
          <>
            <b className="crumb-org" title={orgName}>
              {orgName}
            </b>
            <span className="crumb-org" aria-hidden="true">
              {" · "}
            </span>
          </>
        )}
        <span className="crumb-screen">{breadcrumbScreen}</span>
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
