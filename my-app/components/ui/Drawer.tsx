"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useDialogFocus } from "@/hooks/useDialogFocus";

type DrawerProps = {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  /** Small status pill / tag shown next to the title. */
  badge?: ReactNode;
  /** Sticky footer area (e.g. Test / Cancel / Save). */
  footer?: ReactNode;
  children: ReactNode;
  /** Panel width. Defaults to 460px. */
  width?: number | string;
  /** Which edge it slides in from. Defaults to "right". */
  side?: "left" | "right";
  /**
   * Skip the built-in header/footer chrome and render children full-height —
   * used to host the nav sidebar (which brings its own header/footer) on mobile.
   */
  bare?: boolean;
  /**
   * What this drawer is, for assistive tech. Only needed in `bare` mode: the
   * normal chrome has a visible <h4> title and the drawer points at that, but
   * a bare drawer hands the whole surface to its child and has no heading of
   * its own to name it by.
   */
  label?: string;
};

/** Slide-over for add / edit flows and the mobile nav. Portaled to <body>. */
export function Drawer({
  open,
  onClose,
  title,
  badge,
  footer,
  children,
  width = 460,
  side = "right",
  bare = false,
  label,
}: DrawerProps) {
  const [mounted, setMounted] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
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

  // Lock body scroll while open so the page behind doesn't scroll on touch.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  if (!mounted || !open) return null;

  const edge = side === "left" ? "left-0" : "right-0";
  const w = typeof width === "number" ? `${width}px` : width;

  return createPortal(
    <div className="studio-portal fixed inset-0 z-50">
      {/* scrim */}
      <div
        className="absolute inset-0"
        style={{ background: "color-mix(in oklab, #000 45%, transparent)" }}
        onClick={onClose}
      />
      {/* panel */}
      <div
        ref={panelRef}
        tabIndex={-1}
        className={`panel absolute ${edge} top-0 bottom-0 flex flex-col`}
        style={{
          width: w,
          maxWidth: "94vw",
          borderRadius: 0,
          borderTop: "none",
          borderBottom: "none",
          borderLeft: side === "left" ? "none" : undefined,
          borderRight: side === "right" ? "none" : undefined,
          boxShadow: "var(--shadow-lg)",
          // In bare mode the child (the sidebar) owns the surface + borders.
          ...(bare ? { background: "transparent", border: "none", padding: 0 } : null),
        }}
        role="dialog"
        aria-modal="true"
        aria-label={bare ? label : undefined}
        aria-labelledby={bare ? undefined : titleId}
      >
        {bare ? (
          children
        ) : (
          <>
            <div
              className="p-4 flex items-center justify-between"
              style={{ borderBottom: "1px solid var(--border)" }}
            >
              <div className="flex items-center gap-2">
                <h4 id={titleId} className="text-[14px] font-semibold">
                  {title}
                </h4>
                {badge}
              </div>
              <button className="btn btn-ghost btn-sm" aria-label="Close" onClick={onClose}>
                ✕
              </button>
            </div>
            <div className="p-4 space-y-3 overflow-y-auto flex-1">{children}</div>
            {footer && (
              <div
                className="p-3 flex justify-between gap-2"
                style={{ borderTop: "1px solid var(--border)", background: "var(--surface)" }}
              >
                {footer}
              </div>
            )}
          </>
        )}
      </div>
    </div>,
    document.body
  );
}
