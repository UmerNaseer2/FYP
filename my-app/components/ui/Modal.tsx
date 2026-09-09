"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useDialogFocus } from "@/hooks/useDialogFocus";
import { AlertTriangleIcon } from "./icons";

type ModalProps = {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  /** Max width of the centered card. Defaults to 380px. */
  width?: number | string;
  /**
   * What this dialog is, in a few words — "Stop tracking shop_dev", say.
   *
   * Required, because `aria-modal="true"` without a name announces itself as
   * "dialog" and nothing else: the screen-reader user is told the rest of the
   * page is unavailable and not told what replaced it. Callers that render
   * their own heading can point at it with `labelledBy` instead.
   */
  label?: string;
  /** id of the element that titles this dialog. Wins over `label`. */
  labelledBy?: string;
};

/** Centered overlay card, portaled to <body>. */
export function Modal({
  open,
  onClose,
  children,
  width = 380,
  label,
  labelledBy,
}: ModalProps) {
  const [mounted, setMounted] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  useDialogFocus(open && mounted, panelRef);
  // SSR guard: only portal after the client mounts so createPortal never runs
  // against an undefined `document` during server render (e.g. open-on-first-paint).
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!mounted || !open) return null;

  return createPortal(
    <div className="studio-portal fixed inset-0 z-50 grid place-items-center p-6">
      <div
        className="absolute inset-0"
        style={{ background: "color-mix(in oklab, #000 50%, transparent)" }}
        onClick={onClose}
      />
      <div
        ref={panelRef}
        tabIndex={-1}
        className="card relative w-full p-5"
        style={{ maxWidth: typeof width === "number" ? `${width}px` : width, boxShadow: "var(--shadow-lg)" }}
        role="dialog"
        aria-modal="true"
        aria-label={labelledBy ? undefined : label}
        aria-labelledby={labelledBy}
      >
        {children}
      </div>
    </div>,
    document.body
  );
}

type ConfirmDialogProps = {
  open: boolean;
  onClose: () => void;
  /**
   * Runs when the person confirms. `acknowledged` is true only when this dialog
   * asked for a tick and got one; callers that never pass `acknowledge` can
   * ignore the argument entirely.
   */
  onConfirm: (acknowledged: boolean) => void;
  title: string;
  description?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Style the confirm button as destructive and show a warning icon. */
  destructive?: boolean;
  /**
   * Ask for one more deliberate act before confirming.
   *
   * Pass the sentence to put beside the checkbox and the confirm button stays
   * disabled until it is ticked. Use it for the small set of actions where
   * "are you sure?" is genuinely not enough — running SQL on a live production
   * database, say — and leave it off everywhere else, or the tick becomes
   * furniture people click through without reading.
   */
  acknowledge?: ReactNode;
};

/** Confirm gate for destructive or risky actions. Built on Modal. */
export function ConfirmDialog({ open, onClose, ...body }: ConfirmDialogProps) {
  // The dialog's own heading is its name — pointing at it beats repeating the
  // title in an aria-label, because the two can never drift apart.
  const titleId = useId();
  return (
    <Modal open={open} onClose={onClose} labelledBy={titleId}>
      {/* The contents live in their own component so the acknowledgement tick
          is created fresh on every opening. Modal renders nothing while it is
          closed, so ConfirmBody unmounts and there is no stale tick left to
          carry into the next use — no reset effect needed. */}
      <ConfirmBody onClose={onClose} titleId={titleId} {...body} />
    </Modal>
  );
}

function ConfirmBody({
  onClose,
  onConfirm,
  title,
  titleId,
  description,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  destructive = false,
  acknowledge,
}: Omit<ConfirmDialogProps, "open"> & { titleId: string }) {
  const [acknowledged, setAcknowledged] = useState(false);
  const blocked = Boolean(acknowledge) && !acknowledged;

  return (
    <>
      <div className="flex items-start gap-3">
        {destructive && (
          <div
            className="w-9 h-9 rounded-full grid place-items-center flex-none"
            style={{ background: "var(--break-soft)", color: "var(--break)" }}
          >
            <AlertTriangleIcon size={16} />
          </div>
        )}
        <div>
          <h4 id={titleId} className="text-[15px] font-semibold">
            {title}
          </h4>
          {description && (
            <p className="text-[13px] mt-1" style={{ color: "var(--text-2)" }}>
              {description}
            </p>
          )}
        </div>
      </div>
      {acknowledge && (
        <label className="prod-gate__ack">
          <input
            type="checkbox"
            checked={acknowledged}
            onChange={(event) => setAcknowledged(event.target.checked)}
          />
          <span>{acknowledge}</span>
        </label>
      )}
      <div className="flex justify-end gap-2 mt-5">
        <button className="btn btn-ghost btn-sm" onClick={onClose}>
          {cancelLabel}
        </button>
        <button
          className={`btn btn-sm ${destructive ? "btn-destructive" : "btn-primary"}`}
          disabled={blocked}
          onClick={() => {
            if (blocked) return;
            onConfirm(acknowledged);
            onClose();
          }}
        >
          {confirmLabel}
        </button>
      </div>
    </>
  );
}
