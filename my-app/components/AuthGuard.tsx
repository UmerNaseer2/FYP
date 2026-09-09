"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useUser } from "@/hooks/useUser";
import { BYPASS_AUTH, roleAtLeast, toRole, type Role } from "@/lib/auth-mode";

/**
 * Client-side gate for the pages wrapped in <AuthGuard>.
 *
 * The bypass value used to be a hard-coded const in this file, which meant the
 * UI and the API routes could disagree about whether auth was on. It now comes
 * from lib/auth-mode, the same module the edge proxy and the server-side
 * route gates read, so one environment variable moves all three together.
 *
 * This guard is a convenience, not a security boundary — it only decides what
 * React renders. The real enforcement is proxy.ts (page requests) and
 * lib/auth-guard.ts (API routes), both of which run before any of this.
 */
export default function AuthGuard({
  children,
  requiredRole,
}: {
  children: React.ReactNode;
  /** Minimum role for this subtree. Omit for "any signed-in person". */
  requiredRole?: Role;
}) {
  const { user, role, loading } = useUser();
  const router = useRouter();

  const allowed =
    Boolean(user) &&
    (!requiredRole || roleAtLeast(toRole(role), requiredRole));

  useEffect(() => {
    if (BYPASS_AUTH) return;
    if (!loading && !user) {
      router.push("/login");
    }
  }, [user, loading, router]);

  if (BYPASS_AUTH) return <>{children}</>;

  if (loading) {
    return (
      <div className="loading-state">
        <div className="title">Checking your access…</div>
      </div>
    );
  }

  // The effect above is already sending them to /login; rendering the page for
  // a frame first would flash content they are not signed in to see.
  if (!user) return null;

  if (!allowed) {
    return (
      <div className="loading-state">
        <div className="title">
          You need the &quot;{requiredRole}&quot; role to open this page.
        </div>
        <div className="hint">
          You are signed in as {user.email ?? "an unknown account"}{" "}
          with the &quot;{toRole(role)}&quot; role. Ask an admin to change it,
          then reload.
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
