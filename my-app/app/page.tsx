import { redirect } from "next/navigation";

// The dashboard lives inside the studio shell at /studio, so the root path just
// forwards to it.
//
// NOTE: this is a Server Component. An earlier version tried to complete the
// Azure SSO PKCE exchange here by calling `signIn(...)` from "next-auth/react"
// when the browser returned to "/?code=…". That is a CLIENT-only helper — it
// reaches `window` — so awaiting it in server code threw "window is not defined"
// and turned every "/?code=…" request into a 500. NextAuth already handles the
// exchange at its own callback route (/api/auth/callback/[provider]); nothing
// needs to run here, so we unconditionally forward to the dashboard.
export default function RootPage() {
  redirect("/studio");
}
