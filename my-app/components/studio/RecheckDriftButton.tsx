"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui";
import { RefreshIcon } from "@/components/ui/icons";

/**
 * Re-runs the drift check via POST /api/lineage/drift, then tells the screen
 * around it to re-read.
 *
 * How it does that depends on who is asking. A screen that fetches its own data
 * passes `onDone` and reloads it; without one the button falls back to
 * router.refresh(), which is what a server-rendered screen needs. Refreshing
 * the router on a screen that holds its data in state would do nothing visible,
 * so the caller says which it is rather than the button guessing.
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
  onDone?: () => void;
  /** Another write to this schema is in flight — don't start a check. */
  disabled?: boolean;
  /** Told when this check starts and stops, so the caller can block its own. */
  onBusyChange?: (busy: boolean) => void;
}) {
  const router = useRouter();
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
      if (onDone) onDone();
      else router.refresh();
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
