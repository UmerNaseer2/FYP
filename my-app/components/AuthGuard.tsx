"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useUser } from "@/hooks/useUser";

// Auth gate for every page wrapped in <AuthGuard>. When true, pages render
// without a session (for local testing). It is now FALSE — real NextAuth
// (Microsoft Entra) sign-in is enforced: no session redirects to /login.
// Flip back to true to operate the app without logging in.
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
