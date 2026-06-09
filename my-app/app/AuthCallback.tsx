"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

/**
 * Completes the Azure SSO (PKCE) round-trip. Microsoft → Supabase returns the
 * browser to the site root with a `?code=…`. The browser Supabase client is
 * configured with PKCE + detectSessionInUrl, so simply mounting this component
 * lets it exchange that code for a session (stored in localStorage). We then
 * forward into the app.
 *
 * It is rendered by the root server page ONLY when a `?code` is present, so the
 * code is never stripped by a server-side redirect before the exchange runs.
 */
export function AuthCallback() {
  const router = useRouter();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const supabase = createClient();
    let active = true;

    // getSession() resolves only after the client has finished initializing,
    // which includes the detectSessionInUrl code exchange.
    supabase.auth.getSession().then(({ data }) => {
      if (active && data.session) router.replace("/studio");
    });

    // Belt-and-suspenders: also forward as soon as the SIGNED_IN event fires.
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      if (active && session) router.replace("/studio");
    });

    // If no session materializes in a reasonable time, fall back to sign-in
    // rather than spinning forever.
    const timeout = setTimeout(() => {
      if (active) setFailed(true);
    }, 10000);

    return () => {
      active = false;
      sub.subscription.unsubscribe();
      clearTimeout(timeout);
    };
  }, [router]);

  return (
    <div className="auth-stage">
      <div className="bg-grid" aria-hidden="true" />
      <main className="relative z-10 flex-1 grid place-items-center px-6">
        <div className="auth-card p-8 text-center" style={{ maxWidth: 420 }}>
          {failed ? (
            <>
              <h1 className="text-[18px] font-semibold">Sign-in didn&apos;t complete</h1>
              <p className="text-[13.5px] mt-1.5" style={{ color: "var(--text-2)" }}>
                Please try signing in again.
              </p>
              <a href="/login" className="btn btn-secondary btn-sm mt-4">
                Back to sign in
              </a>
            </>
          ) : (
            <>
              <span className="spin" aria-hidden="true" />
              <h1 className="text-[18px] font-semibold mt-3">Finishing sign-in…</h1>
              <p className="text-[13.5px] mt-1.5" style={{ color: "var(--text-2)" }}>
                One moment.
              </p>
            </>
          )}
        </div>
      </main>
    </div>
  );
}
