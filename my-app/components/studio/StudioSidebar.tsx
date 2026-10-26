import Link from "next/link";
import type { ReactNode } from "react";
import { LogoIcon, ChevronLeftIcon, SunIcon, MoonIcon, SignOutIcon } from "@/components/ui/icons";
import { Pill } from "@/components/ui/Pill";
import { BUILT_IN_ROLE_INFO, isBuiltInRole } from "@/lib/permissions";
import type { NavItem } from "./nav";

export type StudioUser = {
  name: string;
  email: string;
  initials: string;
};

type StudioSidebarProps = {
  items: NavItem[];
  activeHref: string;
  collapsed: boolean;
  onToggleCollapse: () => void;
  theme: "dark" | "light";
  onToggleTheme: () => void;
  user: StudioUser;
  /**
   * What the app currently lets this person do. Deliberately NOT part of
   * StudioUser: `user` can be overridden from above for a fixture, and the
   * things below are facts about the running server that an identity passed in
   * by hand must not be able to paint over.
   *
   * The role's key: "viewer", "editor", "admin", or a custom role's.
   */
  role?: string;
  /** The role's name as people read it, for the pill. Falls back to `role`. */
  roleLabel?: string;
  /** True when NEXT_PUBLIC_AUTH_BYPASS is on. See lib/auth-mode. */
  bypass?: boolean;
  /** The View as picker. Shown under the identity while the rail is expanded. */
  viewAs?: ReactNode;
  /**
   * The organization picker. Shown at the top of the footer while the rail is
   * expanded. It may render nothing (one organization and no way to make
   * another), and the rail leaves no gap when it does.
   */
  orgSwitcher?: ReactNode;
  onSignOut: () => void;
  /** Extra classes (e.g. h-full when hosted in the mobile nav drawer). */
  className?: string;
};

/**
 * The pill's tooltip. A built-in role says what it starts out able to do, in
 * the same words the Admin screen uses. A custom role is whatever an admin
 * made it, so all the tooltip can honestly say is where to look.
 */
const CUSTOM_ROLE_TITLE =
  "A custom role. An admin decides what it can do on the Admin screen.";

function roleTitle(role: string): string {
  return isBuiltInRole(role) ? BUILT_IN_ROLE_INFO[role].description : CUSTOM_ROLE_TITLE;
}

export function StudioSidebar({
  items,
  activeHref,
  collapsed,
  onToggleCollapse,
  theme,
  onToggleTheme,
  user,
  role,
  roleLabel,
  bypass = false,
  viewAs,
  orgSwitcher,
  onSignOut,
  className = "",
}: StudioSidebarProps) {
  /*
    Collapsing the rail hides the words, not the controls.
    `hidden` is display:none, which takes an element out of the accessibility
    tree as well as out of the layout — so a collapsed sidebar used to hand a
    screen reader a column of unnamed icons. `sr-only` takes the same room
    (none) and keeps the text readable to assistive tech, so every item in the
    64px rail still says what it is.
  */
  const labelHidden = collapsed ? "sr-only" : "";

  return (
    <aside
      className={`flex flex-col ${className}`}
      style={{ background: "var(--surface)", borderRight: "1px solid var(--border)" }}
    >
      {/* Brand + collapse. When collapsed the whole brand cell becomes the
          expand button (logo + a visible expand chevron), since a right-aligned
          toggle would overflow the 64px rail and get clipped — leaving no way
          back. */}
      <div
        className={`h-14 flex items-center ${collapsed ? "justify-center" : "px-4 gap-2.5"}`}
        style={{ borderBottom: "1px solid var(--border)" }}
      >
        {collapsed ? (
          <button
            className="sb-expand flex items-center gap-1.5 rounded-lg px-1 py-1.5"
            title="Expand"
            aria-label="Expand sidebar"
            onClick={onToggleCollapse}
          >
            <span
              className="w-7 h-7 rounded-lg grid place-items-center flex-none"
              style={{ background: "var(--brand)", color: "#fff" }}
            >
              <LogoIcon size={15} />
            </span>
            <ChevronLeftIcon size={14} style={{ transform: "rotate(180deg)", color: "var(--text-3)" }} />
          </button>
        ) : (
          <>
            <div
              className="w-7 h-7 rounded-lg grid place-items-center flex-none"
              style={{ background: "var(--brand)", color: "#fff" }}
            >
              <LogoIcon size={15} />
            </div>
            <div className="leading-tight">
              <div className="font-semibold text-[13.5px]">Schema Studio</div>
              <div className="text-[11px] mono" style={{ color: "var(--text-3)" }}>
                v2.0.0
              </div>
            </div>
            <button
              className="ml-auto btn btn-ghost btn-sm"
              title="Collapse"
              aria-label="Collapse sidebar"
              onClick={onToggleCollapse}
            >
              <ChevronLeftIcon size={14} />
            </button>
          </>
        )}
      </div>

      {/* Nav */}
      <div className="p-3">
        <div className={`section-title px-2 mb-1 ${labelHidden}`}>Workspace</div>
        <div className="space-y-0.5">
          {items.map((item) => {
            const active = item.href === activeHref;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`nav-item ${active ? "active" : ""}`}
                title={item.label}
              >
                {item.icon}
                <span className={labelHidden}>{item.label}</span>
              </Link>
            );
          })}
        </div>
      </div>

      {/* Footer: theme toggle + identity */}
      <div className="mt-auto p-3 space-y-2" style={{ borderTop: "1px solid var(--border)" }}>
        {/*
          The organization picker, first in the footer. The footer is pinned to
          the bottom of the rail, so the picker grows it upward and the rows
          under it (the theme, the identity, Sign out) stay where they were
          whether it is drawn or not.

          empty:hidden because the picker decides for itself whether there is
          anything to pick, and renders nothing when there is not. The wrapper
          would still be here, and space-y would put a gap above the theme row
          for a box with nothing in it; a hidden box gets no gap.

          Left off the collapsed rail like View as below: there is no room for
          a picker in 64px, and expanding the rail brings it back.
        */}
        {orgSwitcher && !collapsed && <div className="px-2 empty:hidden">{orgSwitcher}</div>}
        <button
          className="nav-item w-full"
          onClick={onToggleTheme}
          title={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
          aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
        >
          {theme === "dark" ? <SunIcon className="ico" /> : <MoonIcon className="ico" />}
          <span className={labelHidden}>Theme</span>
          <span className={`ml-auto text-[11px] ${labelHidden}`} style={{ color: "var(--text-3)" }}>
            {theme === "dark" ? "Dark" : "Light"}
          </span>
        </button>
        {/*
          Sign out used to be hidden along with the labels, so collapsing the
          sidebar removed the only way to leave the app. It stays; the rail is
          64px wide, so the row stacks instead of running off the edge.
        */}
        <div
          className={`flex items-center px-2 py-1.5 ${
            collapsed ? "flex-col gap-1.5 px-0" : "gap-2.5"
          }`}
        >
          <div
            className="w-7 h-7 rounded-full grid place-items-center flex-none text-white text-[11px] font-semibold"
            style={{ background: "linear-gradient(135deg, var(--brand), #a78bfa)" }}
          >
            {user.initials}
          </div>
          <div className={`leading-tight min-w-0 ${labelHidden}`}>
            <div className="text-[12.5px] font-medium truncate">{user.name}</div>
            <div className="text-[11px] mono truncate" style={{ color: "var(--text-3)" }}>
              {user.email}
            </div>
            {/*
              The role, and whether it was earned by signing in.

              Every screen in the app gates on the role (Deploy refuses to run
              a migration, Admin does not appear in the rail above), and before
              this pill the one place a person could have read which role they
              held was the source. Worse for the bypass: it hands out the admin
              role to whoever opens the page, and an app with authentication
              switched off looked exactly like one somebody had signed in to.

              Both pills, not one. "Admin" alone is the thing that would be
              reassuring and wrong.
            */}
            {(role || bypass) && (
              <div className="flex items-center gap-1 mt-1 flex-wrap">
                {role && (
                  <Pill tone="neutral" dot={false} title={roleTitle(role)}>
                    {roleLabel || role}
                  </Pill>
                )}
                {bypass && (
                  <Pill
                    tone="drift"
                    dot={false}
                    title="NEXT_PUBLIC_AUTH_BYPASS is on: nobody signed in, and every request is let through as an admin, or as the role picked in View as. Turn it off before this is used for real."
                  >
                    auth off
                  </Pill>
                )}
              </div>
            )}
          </div>
          <button
            className={`btn btn-ghost btn-sm ${collapsed ? "" : "ml-auto"}`}
            title="Sign out"
            aria-label="Sign out"
            onClick={onSignOut}
          >
            <SignOutIcon size={13} />
          </button>
        </div>
        {/*
          View as, while the bypass is on: the testing stand-in for signing in
          as somebody with another role. Left off the collapsed rail, which has
          no room for a picker; expanding the rail brings it back.
        */}
        {viewAs && !collapsed && <div className="px-2">{viewAs}</div>}
      </div>
    </aside>
  );
}
