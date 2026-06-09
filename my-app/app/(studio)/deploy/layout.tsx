import AuthGuard from "@/components/AuthGuard";

/**
 * Deploy reads saved connection credentials and applies migrations to live
 * databases, so it stays behind auth. The studio route group has no guard of
 * its own, so we re-add one scoped to this route only (same pattern as
 * Connections and Compare).
 */
export default function DeployLayout({ children }: { children: React.ReactNode }) {
  return <AuthGuard>{children}</AuthGuard>;
}
