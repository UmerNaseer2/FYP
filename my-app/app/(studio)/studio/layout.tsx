import AuthGuard from "@/components/AuthGuard";

// The dashboard is the studio landing page (root "/" redirects here), so it must
// sit behind the same auth gate as every other studio route.
export default function StudioDashboardLayout({ children }: { children: React.ReactNode }) {
  return <AuthGuard>{children}</AuthGuard>;
}
