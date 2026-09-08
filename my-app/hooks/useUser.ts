import { useSession } from "next-auth/react";
import {
  BYPASS_AUTH,
  BYPASS_PRINCIPAL,
  DEFAULT_ROLE,
  type Role,
} from "@/lib/auth-mode";

export type CurrentUser = {
  email: string;
  name: string;
};

// Stable identity so components that memoise on `user` (StudioShell does)
// don't recompute on every render while the bypass is on.
const BYPASS_USER: CurrentUser = {
  email: BYPASS_PRINCIPAL.email,
  name: BYPASS_PRINCIPAL.name,
};

/**
 * Kept for the sign-out handler. There is no client-side identity cache to
 * clear any more — `useSession` is the single source — but calling it stays
 * harmless and means the sign-out path doesn't have to change if one returns.
 */
export function resetUserCache() {}

/**
 * Who the browser thinks it is.
 *
 * When the bypass is on (lib/auth-mode) this reports the same admin principal
 * that lib/auth-guard hands the API routes. Without that, the UI would say
 * "you need the admin role" on screens whose API calls are in fact being let
 * through — the client and the server disagreeing about the one switch that is
 * supposed to control both.
 */
export function useUser() {
  const { data: session, status } = useSession();

  if (BYPASS_AUTH) {
    return {
      user: BYPASS_USER,
      role: BYPASS_PRINCIPAL.role,
      isAdmin: true,
      loading: false,
      bypass: true,
    };
  }

  const user: CurrentUser | null = session?.user
    ? {
        email: session.user.email ?? "",
        name: session.user.name ?? session.user.email ?? "",
      }
    : null;
  const role = (session?.user?.role as Role) || DEFAULT_ROLE;

  return {
    user,
    role,
    isAdmin: role === "admin",
    loading: status === "loading",
    bypass: false,
  };
}
