"use client";

// The dialog that retires one saved version of a script family, so Deploy
// stops offering it and the versions after it can run. It says what retiring
// does and what it leaves alone before anything changes, and takes an
// optional reason, which is saved in the note in GitHub.
//
// The page sends the request (POST /api/github/retire); this file only asks.

import { useId, useState } from "react";
import { Modal } from "@/components/ui/Modal";
import { AlertTriangleIcon } from "@/components/ui/icons";
import { vLabel } from "@/lib/deploy/rollback-plan";
import { retiredMarkerName } from "@/lib/github/registry-paths";
import { MAX_RETIRE_REASON_LENGTH } from "@/lib/github/registry-push";
import type { GitHubScript } from "./types";
import { scriptKey } from "./helpers";

type RetireVersionDialogProps = {
  /** The version to retire, or null while the dialog is closed. */
  script: GitHubScript | null;
  /** True while the request is out: the dialog cannot be closed or sent twice. */
  busy: boolean;
  /** Why the last try failed, in plain words, or null. */
  error: string | null;
  onClose: () => void;
  /** The reason as typed, trimmed; "" when none was given. */
  onConfirm: (reason: string) => void;
};

export function RetireVersionDialog({ script, busy, error, onClose, onConfirm }: RetireVersionDialogProps) {
  const titleId = useId();
  return (
    <Modal open={script !== null} onClose={busy ? () => {} : onClose} labelledBy={titleId} width={460}>
      {/* Keyed by the version, so a reason typed for one version is never
          sent for another. */}
      {script && (
        <RetireBody
          key={scriptKey(script)}
          script={script}
          titleId={titleId}
          busy={busy}
          error={error}
          onClose={onClose}
          onConfirm={onConfirm}
        />
      )}
    </Modal>
  );
}

function RetireBody({
  script,
  titleId,
  busy,
  error,
  onClose,
  onConfirm,
}: Omit<RetireVersionDialogProps, "script"> & { script: GitHubScript; titleId: string }) {
  const [reason, setReason] = useState("");
  const reasonId = useId();
  const hintId = useId();
  const label = vLabel(script.version);

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (!busy) onConfirm(reason.trim());
      }}
    >
      <div className="flex items-start gap-3">
        <div
          className="w-9 h-9 rounded-full grid place-items-center flex-none"
          style={{ background: "var(--break-soft)", color: "var(--break)" }}
        >
          <AlertTriangleIcon size={16} />
        </div>
        <div className="min-w-0">
          <h4 id={titleId} className="text-[15px] font-semibold" style={{ overflowWrap: "anywhere" }}>
            Retire {script.script_name} {label}?
          </h4>
          <p className="text-[13px] mt-1" style={{ color: "var(--text-2)" }}>
            Deploy will stop offering it to every database, so the versions after it can run.
          </p>
          <ul className="text-[13px] mt-2 list-disc pl-5 space-y-1" style={{ color: "var(--text-2)" }}>
            <li>Databases that already ran it keep it, and can still roll it back.</li>
            <li>Its SQL stays in GitHub. Its number stays taken, so a new version needs a higher one.</li>
            <li>A later version that builds on it may fail too.</li>
          </ul>
          <p className="text-[13px] mt-2" style={{ color: "var(--text-2)", overflowWrap: "anywhere" }}>
            To undo it, delete <code>{retiredMarkerName(script.version)}</code> from its folder in GitHub.
          </p>
        </div>
      </div>

      <label htmlFor={reasonId} className="label block mt-4">
        Reason (optional)
      </label>
      <textarea
        id={reasonId}
        className="input mt-1"
        rows={2}
        maxLength={MAX_RETIRE_REASON_LENGTH}
        value={reason}
        disabled={busy}
        aria-describedby={hintId}
        onChange={(event) => setReason(event.target.value)}
      />
      <p id={hintId} className="help mt-1">
        Saved in the note in GitHub, so others can see why.
      </p>

      {error && (
        <p role="alert" className="text-[13px] mt-3" style={{ color: "var(--break)" }}>
          {error}
        </p>
      )}

      <div className="flex justify-end gap-2 mt-5">
        <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={onClose}>
          Cancel
        </button>
        <button type="submit" className="btn btn-sm btn-destructive" disabled={busy}>
          {busy ? "Retiring…" : `Retire ${label}`}
        </button>
      </div>
    </form>
  );
}
