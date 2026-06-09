import AuthGuard from "@/components/AuthGuard";

/**
 * Compare reads saved connection credentials and introspects live databases, so
 * it stays behind auth. The studio route group has no guard of its own, so we
 * re-add one scoped to this route only (same pattern as Connections).
 */
export default function CompareLayout({ children }: { children: React.ReactNode }) {
  return <AuthGuard>{children}</AuthGuard>;
}
