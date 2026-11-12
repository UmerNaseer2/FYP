import type { Metadata } from "next";
import Link from "next/link";
import { OnboardingFrame } from "@/components/onboarding/OnboardingFrame";

/**
 * The live demo, at the address the FYP poster's QR code opens.
 *
 * For now this only holds the address. The poster is printed, so /demo has to
 * answer from the day it goes out, before the demo itself is built. The plan
 * is a ready-made compare of two sample databases that anyone can try without
 * signing in.
 *
 * Anyone can open it (lib/public-paths.ts), signed in or not, so it must never
 * show anything that belongs to an organization or a person. It reads nothing
 * and calls nothing.
 */
export const metadata: Metadata = {
  title: "Live demo | Schema Studio",
};

export default function DemoPage() {
  // The same frame as "Your organizations": the brand at the top and one card
  // in the middle. Nobody is signed in here, so there is no Sign out.
  return (
    <OnboardingFrame
      title="The live demo is coming soon"
      lede="This page will run a ready-made compare of two sample databases, with nothing to sign in to. Until then, the home page shows what Schema Studio does."
      signedIn={false}
    >
      <Link href="/" className="btn btn-primary">
        Go to the home page
      </Link>
    </OnboardingFrame>
  );
}
