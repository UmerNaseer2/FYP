"use client";

import { Suspense } from "react";
import AuthGuard from "@/components/AuthGuard";
import PhoneApp from "@/components/phone/PhoneApp";
import { useTheme } from "@/hooks/useTheme";

/**
 * The phone app: drift, history, approvals and alerts, for someone away from a
 * computer. Everything comes from this site's database, so it keeps working with
 * every computer switched off. Any member may open it, and each tab asks for
 * what it needs.
 */
export default function PhonePage() {
  // The shell applies the saved theme on the studio's screens. There is no shell here.
  useTheme();
  return (
    <AuthGuard>
      {/* useSearchParams has to sit under a Suspense boundary. */}
      <Suspense fallback={null}>
        <PhoneApp />
      </Suspense>
    </AuthGuard>
  );
}
