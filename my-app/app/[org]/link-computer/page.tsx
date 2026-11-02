"use client";

import { Suspense } from "react";
import AuthGuard from "@/components/AuthGuard";
import LinkComputer from "@/components/computers/LinkComputer";
import { useTheme } from "@/hooks/useTheme";

export default function LinkComputerPage() {
  // The shell applies the saved theme on the studio's screens. There is no shell here.
  useTheme();
  return (
    <AuthGuard>
      {/* useSearchParams has to sit under a Suspense boundary. */}
      <Suspense fallback={null}>
        <LinkComputer />
      </Suspense>
    </AuthGuard>
  );
}
