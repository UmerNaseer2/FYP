"use client";

import AuthGuard from "@/components/AuthGuard";
import LinkComputer from "@/components/computers/LinkComputer";
import { HelpProvider } from "@/components/help/HelpPanel";
import { useTheme } from "@/hooks/useTheme";

export default function LinkComputerPage() {
  // The shell applies the saved theme on the studio's screens. There is no shell here.
  useTheme();
  return (
    <AuthGuard>
      {/* The Help panel comes with the shell on the studio's screens. Here it is added by hand. */}
      <HelpProvider>
        <LinkComputer />
      </HelpProvider>
    </AuthGuard>
  );
}
