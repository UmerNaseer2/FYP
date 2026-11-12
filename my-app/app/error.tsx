"use client";

import { useEffect } from "react";
import Link from "next/link";
import { LandingThemeToggle } from "@/components/landing/LandingThemeToggle";
import { BrandMark } from "@/components/ui/BrandMark";
import { RefreshIcon } from "@/components/ui/icons";
import "@/app/styles/atelier-onboarding.css";

// ---------------------------------------------------------------------------
// The outer error boundary: everything that is NOT a studio screen.
//
// In practice that is the landing page, sign-in and the redirects from old
// addresses, because every other route lives under [org]/(studio) and is
// caught by the boundary there, which keeps the sidebar. This one has no
// sidebar to keep, so it draws the onboarding frame's look: the brand at the
// top and one card in the middle (app/styles/atelier-onboarding.css).
//
// It is also the fallback if the studio boundary itself throws while rendering,
// which is the reason to have both rather than only the inner one.
// ---------------------------------------------------------------------------

export default function AppError({
  error,
  reset,
}: {
  /** `digest` is present for errors thrown on the server — see [org]/(studio)/error. */
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("Page failed to render:", error);
  }, [error]);

  return (
    <div className="ob-page">
      <header className="ob-nav">
        <div className="brand">
          <BrandMark size={30} />
          <span className="brand-name">Schema Studio</span>
        </div>
        {/* Also puts the saved theme back: on this page React redraws the whole
            document in the browser, which drops the head script's choice. */}
        <div className="ob-tools">
          <LandingThemeToggle />
        </div>
      </header>
      <main className="ob-main">
        <article className="card ob-card" role="alert">
          <div className="ob-head">
            <h1>Something went wrong</h1>
            <p>
              This page could not be drawn. Trying again is safe, nothing was written anywhere.
              {error.digest && (
                <>
                  <br />
                  <span className="mono text-[12px]">Reference: {error.digest}</span>
                </>
              )}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className="btn btn-primary" onClick={reset}>
              <RefreshIcon size={14} /> Try again
            </button>
            <Link href="/studio" className="btn btn-secondary">
              Go to Schema Studio
            </Link>
          </div>
        </article>
      </main>
    </div>
  );
}
