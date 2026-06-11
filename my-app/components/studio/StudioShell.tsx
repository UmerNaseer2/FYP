"use client";

import { useMemo, useState, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import { signOut } from "next-auth/react";
import { useUser, resetUserCache } from "@/hooks/useUser";
import { useTheme } from "@/hooks/useTheme";
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
  const router = useRouter();
  const { user: authUser } = useUser();
  const { theme, toggleTheme } = useTheme();
  const [collapsed, setCollapsed] = useState(false);

  // Real identity from the NextAuth session; honest signed-out state otherwise.
  const studioUser = useMemo(() => user ?? toStudioUser(authUser), [user, authUser]);

  async function handleSignOut() {
    resetUserCache();
    await signOut({ callbackUrl: "/login" });
  }

  const active = activeNavItem(pathname);

  return (
    <div
      className="studio grid"
      style={{
        gridTemplateColumns: collapsed ? "64px 1fr" : "240px 1fr",
        height: "100vh",
      }}
    >
      <StudioSidebar
        items={NAV_ITEMS}
        activeHref={active.href}
        collapsed={collapsed}
        onToggleCollapse={() => setCollapsed((c) => !c)}
        theme={theme}
        onToggleTheme={toggleTheme}
        user={studioUser}
        onSignOut={handleSignOut}
      />

      <div className="flex flex-col min-w-0">
        <StudioTopbar breadcrumbScreen={active.screen} />
        <main className="flex-1 min-h-0 overflow-y-auto" style={{ background: "var(--bg)" }}>
          {children}
        </main>
      </div>
    </div>
  );
}