import { redirectToLastOrg, type OldAddressProps } from "@/lib/orgs/redirect";

// /requests with no organization in front of it: sent on to the same page in an
// organization, the way a link written by hand would expect. See lib/orgs/redirect.ts.
export default function OldAddress(props: OldAddressProps) {
  return redirectToLastOrg("requests", props);
}
