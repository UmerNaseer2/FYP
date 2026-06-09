"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button, ConfirmDialog } from "@/components/ui";
import { CompareIcon, CheckIcon } from "@/components/ui/icons";
import { RecheckDriftButton } from "./RecheckDriftButton";

type DriftState = "drifted" | "in_sync" | "unreachable" | "no_baseline";

/**
 * The drift resolution actions for one tracked schema. Every action is honest:
 *   • Author a migration — opens Compare with this live schema preloaded (the
 *     bridge to the existing author flow; no fabricated migration is created).
 *   • Re-baseline to live — POST /api/lineage/rebaseline behind a confirm; it
 *     accepts the current structure as the new expected snapshot.
 *   • Acknowledge — POST /api/lineage/acknowledge; records the drift as reviewed
 *     without changing the database.
 *   • Re-check — re-runs the drift check (shared RecheckDriftButton island).
 *
 * The page stays a server component; only these buttons are client. Each write
 * calls router.refresh() so the server-rendered hero + diff re-read fresh data.
 */
export function DriftResolutionBar({
  trackedSchemaId,
  state,
  compareHref,
}: {
  trackedSchemaId: number;
  state: DriftState;
  compareHref: string | null;
}) {
  const router = useRouter();
  const [confirmRebaseline, setConfirmRebaseline] = useState(false);
  const [busy, setBusy] = useState<null | "rebaseline" | "acknowledge">(null);
  const [error, setError] = useState<string | null>(null);

  async function post(path: string, kind: "rebaseline" | "acknowledge") {
    setBusy(kind);
    setError(null);
    try {
      const res = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ trackedSchemaId }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.success) {
        setError(data?.error ?? "Action failed.");
        return;
      }
      router.refresh();
    } catch {
      setError("Network error during the action.");
    } finally {
      setBusy(null);
    }
  }

  // Resolution actions only make sense when the schema has actually drifted.
  const canResolve = state === "drifted";
  const recheckLabel = state === "in_sync" ? "Re-check" : "Check drift now";

  return (
    <div className="flex items-center gap-2 flex-wrap">
      {canResolve && compareHref && (
        <Link href={compareHref} className="btn btn-primary btn-sm">
          <CompareIcon size={13} /> Author a migration
        </Link>
      )}
      {canResolve && (
        <Button
          variant="secondary"
          size="sm"
          onClick={() => setConfirmRebaseline(true)}
          disabled={busy !== null}
        >
          {busy === "rebaseline" ? "Re-baselining…" : "Re-baseline to live"}
        </Button>
      )}
      {canResolve && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void post("/api/lineage/acknowledge", "acknowledge")}
          disabled={busy !== null}
        >
          {busy === "acknowledge" ? (
            "Acknowledging…"
          ) : (
            <>
              <CheckIcon size={13} /> Acknowledge
            </>
          )}
        </Button>
      )}

      <RecheckDriftButton
        trackedSchemaId={trackedSchemaId}
        variant="secondary"
        label={recheckLabel}
      />

      {error && (
        <span className="text-[11.5px]" style={{ color: "var(--break)" }}>
          {error}
        </span>
      )}

      <ConfirmDialog
        open={confirmRebaseline}
        onClose={() => setConfirmRebaseline(false)}
        onConfirm={() => void post("/api/lineage/rebaseline", "rebaseline")}
        title="Re-baseline to the live schema?"
        description={
          <>
            This captures the live structure as a new lineage snapshot and marks the schema in
            sync. It does <b>not</b> revert anything — you&apos;re accepting the current structure
            as the new expected baseline.
          </>
        }
        confirmLabel="Re-baseline"
      />
    </div>
  );
}
