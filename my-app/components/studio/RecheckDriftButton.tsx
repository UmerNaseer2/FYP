"use client";

import { useState } from "react";
import { Button } from "@/components/ui";
import { RefreshIcon } from "@/components/ui/icons";

/**
 * Re-runs the drift check via POST /api/lineage/drift, then tells the screen
 * around it to re-read.
 *
 * `onDone` is required. It used to be optional, falling back to
 * router.refresh() for a server-rendered caller — but every screen that shows
 * drift fetches its own data into state, and refreshing the router on one of
 * those repaints nothing while looking like it worked. A button whose whole
 * purpose is to make the page show a new answer must not have a quiet path
 * where it does not, so the type asks instead of guessing. A server-rendered
 * caller would pass `() => router.refresh()` and be explicit about it.
 *
 * `disabled` and `onBusyChange` exist for callers that put this button beside
 * their OWN writes to the same schema — DriftResolutionBar does. This check
 * reads the baseline and writes a drift_event; re-baselining REPLACES that
 * baseline. Run at the same time and the check compares live against a baseline
 * that is being swapped underneath it, so which answer is recorded depends on
 * which request finishes first: a schema could end up marked in sync with a
 * fresh "drifted" event filed after it, or acknowledged against an event the
 * re-check had already superseded. Neither button could see the other on its
 * own, so the parent has to hold the signal.
 */
export function RecheckDriftButton({
  trackedSchemaId,
  variant = "secondary",
  label = "Check drift now",
  onDone,
  disabled = false,
  onBusyChange,
}: {
  trackedSchemaId: number;
  variant?: "primary" | "secondary";
  label?: string;
  /** Make the screen re-read. Required — see above. */
  onDone: () => void;
  /** Another write to this schema is in flight — don't start a check. */
  disabled?: boolean;
  /** Told when this check starts and stops, so the caller can block its own. */
  onBusyChange?: (busy: boolean) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function recheck() {
    setBusy(true);
    onBusyChange?.(true);
    setError(null);
    try {
      const res = await fetch("/api/lineage/drift", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ trackedSchemaId }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.status) {
        setError(data?.error ?? "Drift check failed.");
        return;
      }
      // The check wrote a drift_event; make the screen show it.
      onDone();
    } catch {
      setError("Network error during the drift check.");
    } finally {
      setBusy(false);
      onBusyChange?.(false);
    }
  }

  return (
    <span className="inline-flex items-center gap-2">
      <Button
        variant={variant}
        size="sm"
        onClick={() => void recheck()}
        disabled={busy || disabled}
      >
        {busy ? (
          "Checking…"
        ) : (
          <>
            <RefreshIcon size={13} /> {label}
          </>
        )}
      </Button>
      {error && (
        <span className="text-[11.5px]" style={{ color: "var(--break)" }}>
          {error}
        </span>
      )}
    </span>
  );
}
