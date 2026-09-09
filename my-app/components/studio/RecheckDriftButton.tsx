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
 */
export function RecheckDriftButton({
  trackedSchemaId,
  variant = "secondary",
  label = "Check drift now",
  onDone,
}: {
  trackedSchemaId: number;
  variant?: "primary" | "secondary";
  label?: string;
  onDone?: () => void;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function recheck() {
    setBusy(true);
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
    }
  }

  return (
    <span className="inline-flex items-center gap-2">
      <Button variant={variant} size="sm" onClick={() => void recheck()} disabled={busy}>
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
