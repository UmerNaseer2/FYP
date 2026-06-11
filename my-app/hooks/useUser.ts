import { useSession } from "next-auth/react";

// Module-level cache so the first paint after a client-side navigation is
// instant instead of flashing a loading state. It is kept honest two ways:
//   1. resetUserCache() is called from the sign-out handlers, and
//   2. the onAuthStateChange listener below updates it on sign-in / sign-out /
//      token refresh — including changes made in another tab.
// So it can no longer show a signed-in identity after the session is gone.
let cachedUser: any = null;
let cachedRole: string | null = null;

/** Clear the cached identity. Call this from sign-out handlers. */
export function resetUserCache() {
  cachedUser = null;
  cachedRole = null;
}

export function useUser() {
  const { data: session, status } = useSession();
  const loading = status === "loading";
  const user = session?.user || null;
  const role = session?.user?.role || 'viewer';
  const isAdmin = role === 'admin';

  // Update cache when session changes
  if (user !== cachedUser) {
    cachedUser = user;
    cachedRole = role;
  }

  return { user, role, isAdmin, loading };
}