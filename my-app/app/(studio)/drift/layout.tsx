import AuthGuard from "@/components/AuthGuard";

/**
 * Drift & Audit reads live database structure and lineage history, so it stays
 * behind auth like the rest of the workspace. The studio route group has no
 * guard of its own, so we re-add one scoped to this route only (same pattern as
 * Connections, Compare, Deploy and Schema detail).
 */
export default function DriftLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <AuthGuard>{children}</AuthGuard>;
}
