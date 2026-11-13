"use client";

import { useState } from "react";
import { Button, ConfirmDialog } from "@/components/ui";
import { apiFetch } from "@/lib/api-fetch";
import { startTour } from "@/lib/tour";

/**
 * The strip across the top of every page in the shared trial organization.
 * It says the trial is shared, and gives the Trial Admin the "Reset trial"
 * button (POST /api/trial/reset), which puts the organization and its demo
 * databases back to how they started, keeping its GitHub and AI settings.
 * Nothing resets the trial on a timer, so this is the only way back.
 * "Take the tour" starts the app tour (lib/tour.ts) for anyone in the trial.
 */
export function TrialBar({ isAdmin }: { isAdmin: boolean }) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function reset() {
    setBusy(true);
    setError(null);
    try {
      const response = await apiFetch("/api/trial/reset", { method: "POST" });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        setError(body?.error ?? "The trial could not be reset just now. Try again in a moment.");
        return;
      }
      window.location.reload();
    } catch {
      setError("Could not reach the server. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="trial-bar no-print" role="note">
      <span>
        <b>Shared trial.</b> Everyone trying Schema Studio sees the same organization, so what you change, they
        see too.
      </span>
      {error && <span className="trial-bar-error">{error}</span>}
      <Button variant="ghost" size="sm" onClick={startTour}>
        Take the tour
      </Button>
      {isAdmin && (
        <Button variant="secondary" size="sm" disabled={busy} onClick={() => setAsking(true)}>
          {busy ? "Resetting..." : "Reset trial"}
        </Button>
      )}
      <ConfirmDialog
        open={asking}
        onClose={() => setAsking(false)}
        onConfirm={() => void reset()}
        title="Reset the trial?"
        description="Every script, request, run and role change in the trial goes, and the demo schemas are built again from the start. The GitHub token and AI settings stay. Anyone else in the trial right now will see it start over."
        confirmLabel="Reset trial"
        destructive
      />
    </div>
  );
}
