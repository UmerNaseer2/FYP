import type { Metadata } from "next";
import Link from "next/link";
import { EmptyState } from "@/components/ui";
import { CompareIcon } from "@/components/ui/icons";

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
  return (
    <div style={{ height: "100vh", background: "var(--bg)" }}>
      <EmptyState
        icon={<CompareIcon size={22} />}
        title="The live demo is coming soon"
        description="This page will run a ready-made compare of two sample databases, with nothing to sign in to. Until then, the home page shows what Schema Studio does."
        actions={
          <Link href="/" className="btn btn-primary btn-sm">
            Go to the home page
          </Link>
        }
      />
    </div>
  );
}
