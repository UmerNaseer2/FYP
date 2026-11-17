import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { BYPASS_AUTH } from "../auth/mode";
import { orgHref } from "./slug";
import { findDefaultOrganization, findLastOrganization } from "./orgs-db";
import { sessionProfileId } from "../auth/session-profile";

/** What Next.js hands app/studio/[[...rest]]/page.tsx. */
export type OldAddressProps = {
  params: Promise<{ rest?: string[] }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

/**
 * Sends an address that names no organization (/studio, /studio?tour=1) on to
 * the same page in one (/acme/studio?tour=1).
 *
 * /studio is the way into the app: sign-in lands there when nothing asked
 * for another page (DEFAULT_CALLBACK_URL), and the landing page, the error
 * pages and the 404 page link to it, because none of them knows which
 * organization the person is in. app/studio/[[...rest]]/page.tsx calls this.
 * The optional catch-all [[...rest]] makes that one file answer /studio and
 * every address under it. Next.js serves a folder with a fixed name before
 * app/[org], so /studio comes here and /acme/studio goes to the organization.
 *
 * Before organizations, every studio page had an address like this
 * (/compare, /drift). Those folders were removed for the handover build; the
 * function still takes the page as `segment` so the tests can cover any page.
 *
 * Which organization:
 *   - With sign-in switched off, the default one. The bypass is an admin of
 *     every organization, and the default one holds everything that existed
 *     before there were others.
 *   - Signed in, the one they opened last (findLastOrganization). Someone in
 *     no organization at all is sent to make one (/onboarding), since
 *     nobody joins an organization without being asked.
 *   - Signed out, the sign-in page, which comes back to this same address
 *     and so through here again. With real sign-in proxy.ts has already done
 *     that, so this is for a session with no profile ID in it.
 *
 * The rest of the path and the query come along unchanged. Next.js hands the
 * parts of the path over decoded, so each is encoded again: a part with a "/"
 * or a "?" in it stays one part. The redirect is a temporary one (307),
 * because the answer depends on who is asking and changes when they open a
 * different organization.
 *
 * A database that does not answer is not caught. With no way to know where to
 * send someone, the error page and its "Try again" are the honest answer.
 */
export async function redirectToLastOrg(
  segment: string,
  { params, searchParams }: OldAddressProps
): Promise<never> {
  const { rest = [] } = await params;
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(await searchParams)) {
    const values = Array.isArray(value) ? value : [value];
    for (const one of values) if (one !== undefined) query.append(key, one);
  }
  const search = query.toString();
  const path =
    "/" + [segment, ...rest].map(encodeURIComponent).join("/") + (search ? `?${search}` : "");

  redirect(orgHref(await organizationFor(path), path));
}

/** The slug of the organization to open `path` in, for whoever is asking. */
async function organizationFor(path: string): Promise<string> {
  if (!BYPASS_AUTH) {
    let profileId: number | null = null;
    try {
      profileId = sessionProfileId(await auth());
    } catch (error) {
      // Read as signed out, the same as the gates in lib/auth/guard.ts.
      console.error("Session lookup failed:", error);
    }
    if (profileId === null) redirect(`/login?callbackUrl=${encodeURIComponent(path)}`);
    const last = await findLastOrganization(profileId);
    if (last !== null) return last;
    redirect("/onboarding");
  }
  const fallback = await findDefaultOrganization();
  // The bootstrap always creates it, so this is a row deleted by hand. The log
  // says so; the visitor gets the error page.
  if (!fallback) throw new Error("There is no default organization to open this address in.");
  return fallback.slug;
}
