import { redirectToLastOrg, type OldAddressProps } from "@/lib/org-redirect";

// /history with no organization in front of it: sent on to the same page in an
// organization, the way a link written by hand would expect. See lib/org-redirect.ts.
export default function OldAddress(props: OldAddressProps) {
  return redirectToLastOrg("history", props);
}
