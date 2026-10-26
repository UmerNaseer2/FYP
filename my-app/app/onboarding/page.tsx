import { redirect } from "next/navigation";
import { desktopMode } from "@/auth.config";
import { OnboardingPage } from "@/components/onboarding/OnboardingPage";
import { BYPASS_AUTH } from "@/lib/auth-mode";

/**
 * "Your organizations": the organizations someone belongs to, and a form to
 * make a new one.
 *
 * Who is sent here:
 *   - Someone signed in who belongs to no organization, which is everyone the
 *     first time they sign in, unless an invitation brought them. /studio and
 *     the old addresses send them (lib/org-redirect.ts), and so does an
 *     organization's address they are not a member of (app/[org]/layout.tsx).
 *   - Someone removed from the organization they had open, from the guard's
 *     "not a member" screen (components/AuthGuard.tsx).
 *   - A new visitor, from the landing page's "Create account", by way of
 *     /login?callbackUrl=/onboarding.
 *
 * The proxy sends a signed-out visitor to sign in first, so the page itself
 * only has to know two things about the server. Inside the desktop app it
 * forwards to /studio: the app keeps one organization of its own and has
 * nowhere to show another. With sign-in switched off (the bypass) it lists the
 * demo's organizations, and the form is not offered, because nobody is signed
 * in to be a new organization's Admin.
 *
 * Rendered on every request, never once at build time, for the reason
 * app/page.tsx gives: whether this is the desktop app is read from the
 * server's environment, and a prerendered page would keep the build machine's
 * answer.
 */
export const dynamic = "force-dynamic";

export default function Onboarding() {
  if (desktopMode) redirect("/studio");
  return <OnboardingPage demo={BYPASS_AUTH} />;
}
