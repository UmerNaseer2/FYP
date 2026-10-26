import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { BYPASS_AUTH } from "./auth-mode";
import { orgHref } from "./org-slug";
import { findDefaultOrganization, findLastOrganization } from "./orgs-db";

/** What Next.js hands a page at app/<segment>/[[...rest]]/page.tsx. */
export type OldAddressProps = {
  params: Promise<{ rest?: string[] }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

/**
 * Sends an address from before organizations (/compare?left=1, /schemas/12)
 * on to the same page in an organization (/acme/compare?left=1).
 *
 * Those addresses are everywhere: bookmarks, links in GitHub pull requests
 * and change logs, the landing page's buttons, the desktop app, which opens
 * /studio, and the sign-in page, which goes back to whatever address sent
 * someone there. Each studio page has an old address at
 * app/<segment>/[[...rest]]/page.tsx that calls this. Next.js serves a folder
 * with a fixed name before app/[org], so /studio comes here and /acme/studio
 * goes to the organization.
 *
 * Which organization:
 *   - With sign-in switched off, the default one. The bypass is an admin of
 *     every organization, and the default one holds everything that existed
 *     before there were others.
 *   - Signed in, the one they opened last (findLastOrganization), and failing
 *     that the default one. Someone in no organization at all lands in the
 *     default one, whose pages say they are not a member and offer to sign
 *     out (see app/[org]/layout.tsx).
 *   - Signed out, the sign-in page, which comes back to this same old address
 *     and so through here again. With real sign-in proxy.ts has already done
 *     that, so this is for a session with no email in it.
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
    let email: string | null | undefined;
    try {
      email = (await auth())?.user?.email;
    } catch (error) {
      // Read as signed out, the same as the gates in lib/auth-guard.ts.
      console.error("Session lookup failed:", error);
    }
    if (!email) redirect(`/login?callbackUrl=${encodeURIComponent(path)}`);
    const last = await findLastOrganization(email);
    if (last !== null) return last;
  }
  const fallback = await findDefaultOrganization();
  // The bootstrap always creates it, so this is a row deleted by hand. The log
  // says so; the visitor gets the error page.
  if (!fallback) throw new Error("There is no default organization to open this address in.");
  return fallback.slug;
}
