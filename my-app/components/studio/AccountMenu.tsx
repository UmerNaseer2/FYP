"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { ChevronDownIcon, ClockIcon, InboxIcon, PhoneIcon, PlayIcon, SignOutIcon } from "@/components/ui/icons";
import { BUILT_IN_ROLE_INFO, isBuiltInRole } from "@/lib/permissions";
import { replayIntro } from "@/lib/intro";
import type { StudioUser } from "./StudioSidebar";

// The round button at the right end of the top bar: who is signed in, with
// what role, and a small menu: "Your requests", "Your activity" (the History
// page), "Phone and desktop" (the Devices page), "Replay intro" and
// "Sign out". The three links show only when the shell gives their address.
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
  /** Where "Your activity" goes (the History page). Leave it out to hide it. */
  activityHref?: string;
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
  activityHref,
  devicesHref,
  onSignOut,
}: AccountMenuProps) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const roleName = role ? roleLabel || role : undefined;

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
        <span className="who-t">
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
          <b>{user.name}</b>
          {user.email && <small>{user.email}</small>}
          {roleName && role && (
            <small title={roleTitle(role)} data-testid="account-role">
              {orgName ? `${roleName} at ${orgName}` : roleName}
            </small>
          )}
        </div>
        {requestsHref && (
          <Link href={requestsHref} role="menuitem" tabIndex={-1} onClick={() => setOpen(false)}>
            <span>Your requests</span>
            <InboxIcon size={15} />
          </Link>
        )}
        {activityHref && (
          <Link href={activityHref} role="menuitem" tabIndex={-1} onClick={() => setOpen(false)}>
            <span>Your activity</span>
            <ClockIcon size={15} />
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
