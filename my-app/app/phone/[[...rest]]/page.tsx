import { redirectToLastOrg, type OldAddressProps } from "@/lib/org-redirect";

// The installed phone app opens here (public/manifest.webmanifest): one address
// that works for everyone, sent on to the organization they last had open.
// See lib/org-redirect.ts.
export default function PhoneHome(props: OldAddressProps) {
  return redirectToLastOrg("phone", props);
}
