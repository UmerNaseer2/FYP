import AuthGuard from "@/components/AuthGuard";

/**
 * Schema detail reads captured lineage and can be opened straight from a card,
 * so it stays behind auth like the rest of the workspace. The studio route group
 * has no guard of its own, so we re-add one scoped to this route only (same
 * pattern as Connections, Compare and Deploy).
 */
export default function SchemaDetailLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <AuthGuard>{children}</AuthGuard>;
}
