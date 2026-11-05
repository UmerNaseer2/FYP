import AuthGuard from "@/components/AuthGuard";

/**
 * Admin changes people's roles and what each role may do, so it sits behind the
 * same auth gate as the rest of the studio. It opens only for a role that may
 * read one of its tabs (Users, Roles & permissions, Organization or GitHub
 * registry), which out of the box is admin alone, and
 * every /api/admin method checks again on the server. The gate here is just
 * the first line.
 */
export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return <AuthGuard feature={["users", "roles", "organization", "github"]}>{children}</AuthGuard>;
}
