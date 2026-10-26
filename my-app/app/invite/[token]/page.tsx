import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { desktopMode } from "@/auth.config";
import { InvitePage, type InviteView } from "@/components/invite/InvitePage";
import { requireSignedIn } from "@/lib/auth-guard";
import { inspectInvite } from "@/lib/invites-db";

/**
 * An invitation: the page an invitation link opens.
 *
 * An Admin makes the link on the Users tab and sends it themselves
 * (lib/invites.ts). Whoever opens it is signed in by the time this runs,
 * because the proxy sends a signed-out visitor to sign in first and back here
 * afterwards (lib/callback-url.ts). The page then looks the invitation up for
 * that person, changing nothing, and the client half shows what it found: the
 * organization and role with a Join button, or why it cannot be taken.
 * Joining is a separate request (app/api/invites/accept/route.ts), which
 * checks everything again.
 *
 * The link's token is the only thing that lets someone in, so the page is
 * careful where its address goes:
 *
 * - "no-referrer": a link followed from this page, or anything it loads, does
 *   not tell the other site the address it came from.
 * - Not indexed: a search engine that came across a link has no business
 *   listing it.
 *
 * Inside the desktop app it forwards to /studio, as "Your organizations" does
 * (app/onboarding/page.tsx): the app keeps one organization of its own, and
 * nobody can be invited into it. With sign-in switched off (the bypass) there
 * is nobody to join as, so the page says so instead of looking anything up.
 *
 * Rendered on every request, never once at build time: what it shows depends
 * on who is asking and on the invitation as it is now.
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  referrer: "no-referrer",
  robots: { index: false, follow: false },
};

export default async function Invite({ params }: { params: Promise<{ token: string }> }) {
  if (desktopMode) redirect("/studio");
  const { token } = await params;
  return <InvitePage token={token} view={await viewFor(token)} />;
}

async function viewFor(token: string): Promise<InviteView> {
  const gate = await requireSignedIn();
  // A session with no profile in it: one from before profiles were kept in
  // sessions, or whose profile could not be read. Signing in again mends it.
  if (!gate.ok) return { kind: "signed-out" };
  if (gate.caller.bypass) return { kind: "demo" };
  try {
    return await inspectInvite(token, gate.caller.profileId);
  } catch (error) {
    // Never the token: it would let whoever reads the log take the invitation.
    console.error("Failed to look up an invitation:", error);
    return { kind: "unavailable" };
  }
}
