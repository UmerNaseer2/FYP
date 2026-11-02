import { redirectToLastOrg, type OldAddressProps } from "@/lib/org-redirect";

/** The address the desktop app opens: it does not know which organization someone wants. */
export default function LinkComputerHome(props: OldAddressProps) {
  return redirectToLastOrg("link-computer", props);
}
