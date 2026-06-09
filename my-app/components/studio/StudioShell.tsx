"use client";

import { useMemo, useState, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { useUser } from "@/hooks/useUser";
import { useTheme } from "@/hooks/useTheme";
import { StudioSidebar, type StudioUser } from "./StudioSidebar";
import { StudioTopbar } from "./StudioTopbar";
import { NAV_ITEMS, activeNavItem } from "./nav";

// Shown when no one is signed in. Auth is currently bypassed for testing, so
// this is the honest state during local use — NOT a fabricated person.
const SIGNED_OUT_USER: StudioUser = {
  name: "Guest",
  email: "Not signed in",
  initials: "?",
};

/** Build a display identity from the real Supabase session (Azure SSO). */
function toStudioUser(authUser: ReturnType<typeof useUser>["user"]): StudioUser {
  if (!authUser) return SIGNED_OUT_USER;
  const meta = (authUser.user_metadata ?? {}) as Record<string, unknown>;
  const name =
    (typeof meta.full_name === "string" && meta.full_name) ||
    (typeof meta.name === "string" && meta.name) ||
    authUser.email ||
    "Signed in";
  const email = authUser.email ?? "";
  // Initials: first letters of the first two words, else first two of the email.
  const words = name.trim().split(/\s+/).filter(Boolean);
  const initials =
    words.length >= 2
      ? (words[0][0] + words[1][0]).toUpperCase()
      : (name || email).slice(0, 2).toUpperCase();
  return { name, email, initials };
}

type StudioShellProps = {
  children: ReactNode;
  /** Optional explicit identity override; defaults to the live session. */
  user?: StudioUser;
};

/**
 * The chrome every Studio screen lives inside: collapsible left nav, top
 * breadcrumb + per-screen action, theme toggle, identity. Owns theme +
 * collapse state; screens render as `children`.
 */
export function StudioShell({ children, user }: StudioShellProps) {
  const pathname = usePathname();
  const router = useRouter();
  const { user: authUser } = useUser();
  const { theme, toggleTheme } = useTheme();
  const [collapsed, setCollapsed] = useState(false);

  // Real identity from the Supabase session; honest signed-out state otherwise.
  const studioUser = useMemo(() => user ?? toStudioUser(authUser), [user, authUser]);

  async function signOut() {
    try {
      await createClient().auth.signOut();
    } finally {
      router.push("/login");
    }
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
        onSignOut={signOut}
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
