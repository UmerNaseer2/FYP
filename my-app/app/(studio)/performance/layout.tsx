import AuthGuard from "@/components/AuthGuard";

/**
 * Performance reads saved connection credentials and runs queries against live
 * servers, so it stays behind auth like Compare and Connections. The studio
 * route group has no guard of its own, so we re-add one scoped to this route.
 *
 * proxy.ts already covers /performance when the auth bypass is off; this is the
 * same client-side guard every other studio screen has, so the Performance
 * screen behaves like the rest when sign-in is on.
 */
export default function PerformanceLayout({ children }: { children: React.ReactNode }) {
  return <AuthGuard>{children}</AuthGuard>;
}
