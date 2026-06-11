import AuthGuard from "@/components/AuthGuard";

/**
 * Admin (user management) edits roles and removes profiles, so it sits behind
 * the same auth gate as the rest of the studio. The page itself additionally
 * gates on the admin role, and every /api/admin/users method re-checks the role
 * server-side — the gate here is just the first line.
 */
export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return <AuthGuard>{children}</AuthGuard>;
}
