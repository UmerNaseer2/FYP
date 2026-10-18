"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { signOut } from "next-auth/react";
import { useUser, resetUserCache } from "@/hooks/useUser";
import { useTheme } from "@/hooks/useTheme";
import { Drawer } from "@/components/ui";
import { isAdminOnly, readKeyOf } from "@/lib/permissions";
import { StudioSidebar, type StudioUser } from "./StudioSidebar";
import { StudioTopbar } from "./StudioTopbar";
import { ViewAsSwitcher } from "./ViewAsSwitcher";
import { NAV_ITEMS, activeNavItem } from "./nav";

// Shown when no one is signed in.
const SIGNED_OUT_USER: StudioUser = {
  name: "Guest",
  email: "Not signed in",
  initials: "?",
};

/** Build a display identity from the NextAuth session. */
function toStudioUser(authUser: ReturnType<typeof useUser>["user"]): StudioUser {
  if (!authUser) return SIGNED_OUT_USER;
  const name = authUser.name || authUser.email || "Signed in";
  const email = authUser.email ?? "";
  const initials = name.slice(0, 2).toUpperCase();
  return { name, email, initials };
}

type StudioShellProps = {
  children: ReactNode;
  /** Optional explicit identity override; defaults to the live session. */
  user?: StudioUser;
};

/**
 * The chrome every Studio screen lives inside: collapsible left nav, top
 * breadcrumb + per-screen action, theme toggle, identity.
 */
export function StudioShell({ children, user }: StudioShellProps) {
  const pathname = usePathname();
  const { user: authUser, role, roleLabel, bypass, loading, can, accessError } = useUser();
  const { theme, toggleTheme } = useTheme();
  const [collapsed, setCollapsed] = useState(false);

  // Mobile: the sidebar leaves the grid and becomes an off-canvas drawer.
  // `matchMedia` (not a one-shot innerWidth read) so rotation/resize is handled,
  // and a mounted guard keeps SSR markup stable (always desktop on the server).
  const [isMobile, setIsMobile] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 768px)");
    const apply = () => setIsMobile(mq.matches);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);
  // Close the drawer whenever the route changes (tapping a nav item navigates).
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMobileNavOpen(false);
  }, [pathname]);

  // Real identity from the NextAuth session; honest signed-out state otherwise.
  const studioUser = useMemo(() => user ?? toStudioUser(authUser), [user, authUser]);

  // A screen is on the rail when the role may Read its feature, the same
  // question its AuthGuard asks, so nothing here opens onto "your role can't".
  // The screens and the API still check for themselves, so this is
  // presentation, not the security line.
  //
  // Until that is known (still loading, nobody signed in, or the database did
  // not answer) the rail shows every screen except the admin-only ones, as it
  // always did. An empty rail would look broken, and each screen still says
  // for itself whether it will open.
  const navItems = useMemo(
    () =>
      NAV_ITEMS.filter((item) => {
        const features = Array.isArray(item.feature) ? item.feature : [item.feature];
        const [first, ...rest] = features.map(readKeyOf);
        if (loading || accessError || !authUser) {
          return ![first, ...rest].every(isAdminOnly);
        }
        return can(first, ...rest);
      }),
    [loading, accessError, authUser, can],
  );

  async function handleSignOut() {
    resetUserCache();
    await signOut({ callbackUrl: "/login" });
  }

  const active = activeNavItem(pathname);

  const sidebar = (
    <StudioSidebar
      items={navItems}
      activeHref={active.href}
      // In the mobile drawer the sidebar is always expanded; its collapse chevron
      // closes the drawer instead (chevron-left = "tuck the panel away").
      collapsed={isMobile ? false : collapsed}
      onToggleCollapse={
        isMobile ? () => setMobileNavOpen(false) : () => setCollapsed((c) => !c)
      }
      theme={theme}
      onToggleTheme={toggleTheme}
      user={studioUser}
      // Straight from useUser, never from the `user` override above: what the
      // server will actually allow is not something a display identity gets to
      // change. See StudioSidebarProps.
      //
      // Withheld while nobody is signed in, and while the role is still being
      // looked up. useUser reports DEFAULT_ROLE for both. That is a sensible
      // floor for code asking "may I", and a lie on screen, where a "Viewer"
      // badge under "Not signed in" would read as a role somebody holds rather
      // than the absence of one.
      role={authUser && !loading ? role : undefined}
      roleLabel={authUser && !loading ? roleLabel : undefined}
      bypass={bypass}
      // The View as picker, only while the bypass is on. With real sign-in a
      // person is their role and nothing else.
      viewAs={bypass ? <ViewAsSwitcher /> : undefined}
      onSignOut={handleSignOut}
      className={isMobile ? "h-full" : ""}
    />
  );

  return (
    <div
      className="studio grid"
      style={{
        gridTemplateColumns: isMobile ? "1fr" : collapsed ? "64px 1fr" : "240px 1fr",
        height: isMobile ? "100dvh" : "100vh",
      }}
    >
      {/* Desktop: sidebar is the first grid column. Mobile: it lives in the drawer. */}
      {!isMobile && sidebar}

      {/*
        min-h-0 is what makes <main> the thing that scrolls. Without it this
        column grows to the height of the page inside it, the grid grows with
        it, and the whole window scrolls instead: the sidebar scrolls away
        with the page, and its footer (the theme, Sign out, View as) ends up
        below the bottom of the screen on any long page.
      */}
      <div className="flex flex-col min-w-0 min-h-0">
        <StudioTopbar
          breadcrumbScreen={active.screen}
          showMenu={isMobile}
          onMenuClick={() => setMobileNavOpen(true)}
        />
        <main className="flex-1 min-h-0 overflow-y-auto" style={{ background: "var(--bg)" }}>
          {children}
        </main>
      </div>

      {isMobile && (
        <Drawer
          open={mobileNavOpen}
          onClose={() => setMobileNavOpen(false)}
          side="left"
          bare
          label="Main navigation"
          width="min(280px, 85vw)"
        >
          {sidebar}
        </Drawer>
      )}
    </div>
  );
}