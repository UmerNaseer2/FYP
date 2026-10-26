import { redirectToLastOrg, type OldAddressProps } from "@/lib/org-redirect";

// /performance and every address under it, from before organizations:
// sent on to the same page in an organization. See lib/org-redirect.ts.
export default function OldAddress(props: OldAddressProps) {
  return redirectToLastOrg("performance", props);
}
