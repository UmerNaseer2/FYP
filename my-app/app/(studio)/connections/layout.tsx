import AuthGuard from "@/components/AuthGuard";

/**
 * The Connections screen shows and edits database credentials, so it must stay
 * behind auth. The legacy `/connections` route had its own AuthGuard layout;
 * the studio route group has no guard of its own, so we re-add one here scoped
 * to this route only.
 */
export default function ConnectionsLayout({ children }: { children: React.ReactNode }) {
  return <AuthGuard>{children}</AuthGuard>;
}
