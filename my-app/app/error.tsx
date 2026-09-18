"use client";

import { useEffect } from "react";
import Link from "next/link";
import { EmptyState } from "@/components/ui";
import { AlertCircleIcon, RefreshIcon } from "@/components/ui/icons";

// ---------------------------------------------------------------------------
// The outer error boundary: everything that is NOT a studio screen.
//
// In practice that is the sign-in page and the root redirect, because every
// other route lives under (studio) and is caught by the boundary there, which
// keeps the sidebar. This one has no sidebar to keep, so it draws a plain
// centered page inside the root layout.
//
// It is also the fallback if the studio boundary itself throws while rendering,
// which is the reason to have both rather than only the inner one.
// ---------------------------------------------------------------------------

export default function AppError({
  error,
  reset,
}: {
  /** `digest` is present for errors thrown on the server — see (studio)/error. */
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("Page failed to render:", error);
  }, [error]);

  return (
    <div style={{ height: "100vh", background: "var(--bg)" }}>
      <EmptyState
        tone="break"
        icon={<AlertCircleIcon size={22} />}
        title="Something went wrong"
        description={
          <>
            This page could not be drawn. Trying again is safe — nothing was
            written anywhere.
            {error.digest && (
              <>
                <br />
                <span className="mono text-[12px]">Reference: {error.digest}</span>
              </>
            )}
          </>
        }
        actions={
          <div className="flex items-center gap-2">
            <button type="button" className="btn btn-primary btn-sm" onClick={reset}>
              <RefreshIcon size={14} /> Try again
            </button>
            <Link href="/studio" className="btn btn-secondary btn-sm">
              Go to Schema Studio
            </Link>
          </div>
        }
      />
    </div>
  );
}
