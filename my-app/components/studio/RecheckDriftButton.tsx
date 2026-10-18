"use client";

import { useState } from "react";
import { Button } from "@/components/ui";
import { RefreshIcon } from "@/components/ui/icons";
import { useUser } from "@/hooks/useUser";
import { refusalMessage } from "@/lib/permissions";

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
 *
 * For a role that may not run a check (useDriftCheckRefusal, below) the button
 * stays on screen but off, with the reason beside it. A caller that explains a
 * whole row of buttons at once passes `explainRefusal={false}` and says it
 * there; the button still carries the reason as its tooltip.
 */
export function RecheckDriftButton({
  trackedSchemaId,
  variant = "secondary",
  label = "Check drift now",
  onDone,
  disabled = false,
  onBusyChange,
  explainRefusal = true,
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
  /** Say beside the button why it is off for this role. See above. */
  explainRefusal?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const runRefusal = useDriftCheckRefusal();

  async function recheck() {
    // The button is off already. The route would refuse it too.
    if (runRefusal !== null) return;
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
        disabled={busy || disabled || runRefusal !== null}
        title={runRefusal ?? undefined}
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
      {runRefusal && explainRefusal && (
        <span className="text-[11.5px]" style={{ color: "var(--text-3)" }}>
          {runRefusal}
        </span>
      )}
    </span>
  );
}

/**
 * Why the signed-in role may not run a drift check, or null when it may (and
 * while the session is still loading, when the server decides).
 *
 * POST /api/lineage/drift takes either box: Deploy runs a check straight after
 * a migration, so a role that may deploy may see that result too. Asking the
 * same question here keeps a button from being off for someone the server
 * would let through. The refusal names Drift tracking: Run, the box meant for
 * this button. The Dashboard's own Check drift buttons ask it too.
 */
export function useDriftCheckRefusal(): string | null {
  const { roleLabel, loading, can } = useUser();
  if (loading || can("drift:run", "deploy:run")) return null;
  return refusalMessage(roleLabel, "drift:run");
}
