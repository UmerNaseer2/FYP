"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import {
  ChevronDownIcon,
  InboxIcon,
  PhoneIcon,
  PlayIcon,
  RouteIcon,
  SignOutIcon,
  SwapIcon,
} from "@/components/ui/icons";
import { BUILT_IN_ROLE_INFO, isBuiltInRole } from "@/lib/permissions";
import { TRIAL_PEOPLE, TRIAL_ROLES, TRIAL_ROLE_SUMMARY, toTrialRole, type TrialRole } from "@/lib/trial-rules";
import { replayIntro } from "@/lib/intro";
import { readTourMemory, startTour } from "@/lib/tour";
import { useOrg } from "@/hooks/useOrg";
import type { StudioUser } from "./StudioSidebar";

// The round button at the right end of the top bar: who is signed in, with
// what role, and a small menu: "Your requests", "Phone and desktop" (the
// Devices page), "Take the tour" (or "Resume the tour" after it was closed
// part way), "Replay intro" and "Sign out". The two links show only when the
// shell gives their address. History used to be here as "Your activity"; it
// is in the main menu now, under Watch.
//
// In the shared trial the menu also switches role: "Switch to Trial Editor"
// and "Switch to Trial Viewer" for the Trial Admin, and so on. Each is a form
// button that posts to app/api/trial/route.ts with the page it was pressed
// on, which signs in again as that account and opens the same page (the
// trial's home when the new role cannot open it, such as Admin).
//
// Keyboard: Enter, Space or Down Arrow opens it and puts you on the first
// item. Up and Down move (and wrap), Home and End jump to the ends, Escape
// closes it and puts you back on the button, and Tab closes it and moves on.
// A click anywhere outside closes it too.

type AccountMenuProps = {
  user: StudioUser;
  /**
   * The role's key ("viewer", "editor", "admin" or a custom role's). Leave it
   * out while the role is not known yet: the shell does, so the button never
   * claims a role somebody does not hold.
   */
  role?: string;
  /** The role's name as people read it. Falls back to `role`. */
  roleLabel?: string;
  /** The organization this page is open in. */
  orgName?: string | null;
  /** Where "Your requests" goes. Leave it out to hide that item. */
  requestsHref?: string;
  /** Where "Phone and desktop" goes (the Devices page). Leave it out to hide it. */
  devicesHref?: string;
  onSignOut: () => void;
};

const CUSTOM_ROLE_TITLE =
  "A custom role. An admin decides what it can do on the Admin screen.";

/** The tooltip on the role: what a built-in role starts out able to do. */
function roleTitle(role: string): string {
  return isBuiltInRole(role) ? BUILT_IN_ROLE_INFO[role].description : CUSTOM_ROLE_TITLE;
}

export function AccountMenu({
  user,
  role,
  roleLabel,
  orgName,
  requestsHref,
  devicesHref,
  onSignOut,
}: AccountMenuProps) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const roleName = role ? roleLabel || role : undefined;
  const org = useOrg();
  // Read only while the menu is open, so the page drawn on the server (menu
  // closed) and in the browser always agree.
  const resumeTour = open && org !== null && role !== undefined && readTourMemory(org.slug, role).resume !== null;
  const pathname = usePathname();
  const trialRole = org?.trial ? toTrialRole(role) : null;
  const switchId = useId();
  const [switching, setSwitching] = useState<TrialRole | null>(null);
  const switchingRef = useRef(false);

  // Back to this page with the browser's Back button after a switch, the page
  // comes back as it was left, so the switch can be pressed again.
  useEffect(() => {
    if (!trialRole) return;
    const onShow = (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      switchingRef.current = false;
      setSwitching(null);
    };
    window.addEventListener("pageshow", onShow);
    return () => window.removeEventListener("pageshow", onShow);
  }, [trialRole]);

  const items = () =>
    Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);

  // Opening puts you on the first item.
  useEffect(() => {
    if (open) items()[0]?.focus();
  }, [open]);

  // A click anywhere outside closes the menu.
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  function closeAndReturn() {
    setOpen(false);
    buttonRef.current?.focus();
  }

  function onMenuKey(event: KeyboardEvent<HTMLDivElement>) {
    const list = items();
    const at = list.indexOf(document.activeElement as HTMLElement);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      list[(at + step + list.length) % list.length]?.focus();
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      list[event.key === "Home" ? 0 : list.length - 1]?.focus();
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeAndReturn();
    } else if (event.key === "Tab") {
      setOpen(false);
    }
  }

  return (
    <div className="who-wrap" ref={wrapRef}>
      <button
        ref={buttonRef}
        type="button"
        className="who"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        aria-label={`Account menu, signed in as ${user.name}${roleName ? `, ${roleName}` : ""}`}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" && !open) {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        <i className="av" aria-hidden="true">
          {user.initials}
        </i>
        {/* A long name ends with an ellipsis (.who-t); the whole of it is the tooltip. */}
        <span className="who-t" title={roleName ? `${user.name} · ${roleName}` : user.name}>
          <b>{user.name}</b>
          {roleName && <> · {roleName}</>}
        </span>
        <ChevronDownIcon size={14} />
      </button>

      <div
        ref={menuRef}
        id={menuId}
        className="who-m"
        role="menu"
        aria-label="Account"
        hidden={!open}
        onKeyDown={onMenuKey}
      >
        <div className="who-h">
          <i aria-hidden="true">{user.initials}</i>
          <b title={user.name}>{user.name}</b>
          {user.email && <small title={user.email}>{user.email}</small>}
          {roleName && role && (
            <small title={roleTitle(role)} data-testid="account-role">
              {orgName ? `${roleName} at ${orgName}` : roleName}
            </small>
          )}
        </div>
        {/* The trial only: sign in again as one of the other two trial accounts. */}
        {trialRole && (
          <form
            method="post"
            action="/api/trial"
            className="who-sw"
            role="group"
            aria-labelledby={switchId}
          >
            <input type="hidden" name="next" value={pathname ?? ""} />
            <small id={switchId} className="who-sw-t">
              Switch role
            </small>
            {TRIAL_ROLES.filter((other) => other !== trialRole).map((other) => {
              const name = TRIAL_PEOPLE[other].name;
              return (
                <button
                  key={other}
                  type="submit"
                  role="menuitem"
                  tabIndex={-1}
                  name="role"
                  value={other}
                  aria-label={switching === other ? `Switching to ${name}` : `Switch to ${name}`}
                  aria-describedby={`${switchId}-${other}`}
                  aria-busy={switching === other || undefined}
                  onClick={(event) => {
                    // One press switches. A second press on the way does nothing.
                    if (switchingRef.current) {
                      event.preventDefault();
                      return;
                    }
                    switchingRef.current = true;
                    setSwitching(other);
                  }}
                >
                  <span className="who-sw-l">
                    <span>{switching === other ? `Switching to ${name}…` : name}</span>
                    <small id={`${switchId}-${other}`}>{TRIAL_ROLE_SUMMARY[other].short}</small>
                  </span>
                  <SwapIcon size={15} />
                </button>
              );
            })}
          </form>
        )}
        {requestsHref && (
          <Link href={requestsHref} role="menuitem" tabIndex={-1} onClick={() => setOpen(false)}>
            <span>Your requests</span>
            <InboxIcon size={15} />
          </Link>
        )}
        {devicesHref && (
          <Link href={devicesHref} role="menuitem" tabIndex={-1} onClick={() => setOpen(false)}>
            <span>Phone and desktop</span>
            <PhoneIcon size={15} />
          </Link>
        )}
        <button
          type="button"
          role="menuitem"
          tabIndex={-1}
          onClick={() => {
            setOpen(false);
            startTour();
          }}
        >
          <span>{resumeTour ? "Resume the tour" : "Take the tour"}</span>
          <RouteIcon size={15} />
        </button>
        <button
          type="button"
          role="menuitem"
          tabIndex={-1}
          onClick={() => {
            setOpen(false);
            replayIntro();
          }}
        >
          <span>Replay intro</span>
          <PlayIcon size={15} />
        </button>
        <button
          type="button"
          role="menuitem"
          tabIndex={-1}
          className="out"
          onClick={() => {
            setOpen(false);
            onSignOut();
          }}
        >
          <span>Sign out</span>
          <SignOutIcon size={15} />
        </button>
      </div>
    </div>
  );
}
