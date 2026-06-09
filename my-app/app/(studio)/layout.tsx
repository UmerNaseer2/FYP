import type { ReactNode } from "react";
import { StudioShell } from "@/components/studio/StudioShell";

// Every route in the (studio) group renders inside the new design-system shell.
// This is additive: legacy pages outside this group keep their own layout.
export default function StudioLayout({ children }: { children: ReactNode }) {
  return <StudioShell>{children}</StudioShell>;
}
