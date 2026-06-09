"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui";
import { RefreshIcon } from "@/components/ui/icons";

/**
 * Small client island for the schema-detail page. Re-runs the drift check via
 * the existing crisp backend (POST /api/lineage/drift), then refreshes the
 * server component so the banner, timeline and "Current" card re-read fresh
 * data. The page itself stays a server component; only this button is client.
 */
export function RecheckDriftButton({
  trackedSchemaId,
  variant = "secondary",
  label = "Check drift now",
}: {
  trackedSchemaId: number;
  variant?: "primary" | "secondary";
  label?: string;
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
      // The check wrote a drift_event; re-render the server component to show it.
      router.refresh();
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
