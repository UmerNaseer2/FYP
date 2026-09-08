"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useUser } from "@/hooks/useUser";

// Auth gate for every page wrapped in <AuthGuard>. While this is true, pages
// render without a session and nothing about roles is enforced.
//
// It is TRUE today because the Microsoft Entra keys (AZURE_AD_CLIENT_ID /
// _SECRET / _TENANT_ID, NEXTAUTH_SECRET) are not configured and the `profiles`
// table the session callback reads is never created, so a real sign-in cannot
// complete. Setting those up and creating `profiles` is what flips this to
// false. Note that this guard is client-side only: server-side protection for
// the (studio) pages and the API routes still has to be added alongside it.
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
