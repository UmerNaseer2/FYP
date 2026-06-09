"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useUser } from "@/hooks/useUser";

// ⚠️ TEMPORARY — auth is bypassed so the app can be operated and tested without
// a Supabase SSO session. This switches OFF the login gate on every page that
// uses <AuthGuard> (compare, connections, scripts, versions, adminControl, home).
// To restore real auth, set BYPASS_AUTH back to false. Nothing else changes.
const BYPASS_AUTH: boolean = true;

export default function AuthGuard({ children }: { children: React.ReactNode }) {
  const { user, loading } = useUser();
  const router = useRouter();

  useEffect(() => {
    if (BYPASS_AUTH) return;
    if (!loading && !user) {
      router.push("/login");
    }
  }, [user, loading, router]);

  if (BYPASS_AUTH) return <>{children}</>;

  if (loading) return <div className="loading-state">Loading...</div>;
  if (!user) return null;

  return <>{children}</>;
}
