import { redirectToLastOrg, type OldAddressProps } from "@/lib/orgs/redirect";

// /compare and every address under it, from before organizations:
// sent on to the same page in an organization. See lib/orgs/redirect.ts.
export default function OldAddress(props: OldAddressProps) {
  return redirectToLastOrg("compare", props);
}
