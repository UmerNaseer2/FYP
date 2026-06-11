"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { signOut } from "next-auth/react";
import { useUser, resetUserCache } from "@/hooks/useUser";
import { useTheme } from "@/hooks/useTheme";
import { Drawer } from "@/components/ui";
import { StudioSidebar, type StudioUser } from "./StudioSidebar";
import { StudioTopbar } from "./StudioTopbar";
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
  const { user: authUser, isAdmin } = useUser();
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

  // Admin-only items (e.g. user management) are hidden from non-admins. The page
  // + API still gate on the role, so this is presentation, not the security line.
  const navItems = useMemo(
    () => NAV_ITEMS.filter((item) => !item.adminOnly || isAdmin),
    [isAdmin],
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

      <div className="flex flex-col min-w-0">
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
          width="min(280px, 85vw)"
        >
          {sidebar}
        </Drawer>
      )}
    </div>
  );
}