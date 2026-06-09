"use client";

import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AlertTriangleIcon } from "./icons";

type ModalProps = {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  /** Max width of the centered card. Defaults to 380px. */
  width?: number | string;
};

/** Centered overlay card, portaled to <body>. */
export function Modal({ open, onClose, children, width = 380 }: ModalProps) {
  const [mounted, setMounted] = useState(false);
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
        className="card relative w-full p-5"
        style={{ maxWidth: typeof width === "number" ? `${width}px` : width, boxShadow: "var(--shadow-lg)" }}
        role="dialog"
        aria-modal="true"
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
  onConfirm: () => void;
  title: string;
  description?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Style the confirm button as destructive and show a warning icon. */
  destructive?: boolean;
};

/** Confirm gate for destructive or risky actions. Built on Modal. */
export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  description,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  destructive = false,
}: ConfirmDialogProps) {
  return (
    <Modal open={open} onClose={onClose}>
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
          <h4 className="text-[15px] font-semibold">{title}</h4>
          {description && (
            <p className="text-[13px] mt-1" style={{ color: "var(--text-2)" }}>
              {description}
            </p>
          )}
        </div>
      </div>
      <div className="flex justify-end gap-2 mt-5">
        <button className="btn btn-ghost btn-sm" onClick={onClose}>
          {cancelLabel}
        </button>
        <button
          className={`btn btn-sm ${destructive ? "btn-destructive" : "btn-primary"}`}
          onClick={() => {
            onConfirm();
            onClose();
          }}
        >
          {confirmLabel}
        </button>
      </div>
    </Modal>
  );
}
