import { redirectToLastOrg, type OldAddressProps } from "@/lib/orgs/redirect";

// /studio and every address under it: the way into the app when the address
// names no organization yet. Sign-in lands here (DEFAULT_CALLBACK_URL), and so
// do the landing page, the error pages and the 404 page. It sends the person
// on to the same page in their organization. See lib/orgs/redirect.ts.
export default function OldAddress(props: OldAddressProps) {
  return redirectToLastOrg("studio", props);
}
