"use client";

import { useEffect } from "react";
import Link from "next/link";
import { Card, EmptyState } from "@/components/ui";
import { AlertCircleIcon, DashboardIcon, RefreshIcon } from "@/components/ui/icons";

// ---------------------------------------------------------------------------
// The error boundary for every screen in the studio.
//
// Without this file, one thrown render — a payload that arrived in a shape the
// page did not expect, a null nobody guarded — replaces the whole application
// with Next's built-in error screen: a stack trace in development, and a bare
// "Application error: a client-side exception has occurred" in production. Both
// are dead ends. The reader has no way back other than the browser's back
// button, and no idea whether the rest of the app still works.
//
// It lives inside the (studio) group rather than at app/ on purpose. A boundary
// replaces the children of the layout ABOVE it, so this one is caught below
// StudioShell: the sidebar stays on screen, every other screen is one click
// away, and the failure reads as "this page broke" instead of "the app broke".
// ---------------------------------------------------------------------------

export default function StudioError({
  error,
  reset,
}: {
  // Next adds `digest` on errors thrown while rendering on the server: the
  // message itself is stripped before it reaches the browser, and this hash is
  // the only thing tying what the reader sees to the line in the server log.
  error: Error & { digest?: string };
  /** Re-renders the segment that threw. Free to call more than once. */
  reset: () => void;
}) {
  useEffect(() => {
    // The browser console is where a developer looks first, and the boundary
    // swallowing the error is exactly what makes these hard to chase.
    console.error("Studio screen failed to render:", error);
  }, [error]);

  return (
    <div className="max-w-[1100px] mx-auto px-4 sm:px-8 py-8 sm:py-10">
      <Card className="p-0 overflow-hidden">
        <div style={{ height: 340 }}>
          <EmptyState
            tone="break"
            icon={<AlertCircleIcon size={22} />}
            title="This screen stopped working"
            description={
              <>
                Something went wrong while drawing this page. Nothing was
                changed in any database — this happened in the browser, after
                the data had already been read.
                {/* In production the message is redacted, so printing it would
                    show the same useless string on every failure. The digest is
                    what a developer greps the server log for, so it is shown
                    when there is one and suppressed when there is not. */}
                {error.digest && (
                  <>
                    <br />
                    <span className="mono text-[12px]">
                      Reference: {error.digest}
                    </span>
                  </>
                )}
              </>
            }
            actions={
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  onClick={reset}
                >
                  <RefreshIcon size={14} /> Try again
                </button>
                <Link href="/studio" className="btn btn-secondary btn-sm">
                  <DashboardIcon size={14} /> Go to dashboard
                </Link>
              </div>
            }
          />
        </div>
      </Card>
    </div>
  );
}
