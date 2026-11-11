"use client";

import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from "react";

type HelpHintProps = {
  /** What the note is about ("Dry run"). Read out as "Help: Dry run". */
  label: string;
  /** The note itself. Keep it to a sentence or two. */
  children: ReactNode;
  className?: string;
};

const NOTE_WIDTH = 300;
const EDGE_GAP = 8;

/**
 * A small "?" beside a field or a section title. Clicking it opens a short
 * note; clicking it again, clicking elsewhere, pressing Escape or scrolling
 * closes it. It takes the place of a grey paragraph under the field, so the
 * page stays short and the explanation is one click away.
 *
 * It opens on a click, not on hover, so it works the same with a mouse, a
 * keyboard and a finger.
 */
export function HelpHint({ label, children, className = "" }: HelpHintProps) {
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState<CSSProperties>({});
  const wrapRef = useRef<HTMLSpanElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const noteId = useId();

  function toggle() {
    if (open) {
      setOpen(false);
      return;
    }
    // Put the note just under the "?", and keep it inside the window: it is
    // placed against the window (position: fixed) so a card that clips its
    // contents cannot cut it off.
    const box = buttonRef.current?.getBoundingClientRect();
    if (box) {
      const width = Math.min(NOTE_WIDTH, window.innerWidth - EDGE_GAP * 2);
      const left = Math.max(EDGE_GAP, Math.min(box.left, window.innerWidth - width - EDGE_GAP));
      setPlace({ top: box.bottom + 6, left, width });
    }
    setOpen(true);
  }

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const onPointerDown = (event: PointerEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) close();
    };
    document.addEventListener("pointerdown", onPointerDown);
    // The note is placed against the window, so it would stay put while the
    // page moved under it. Closing it on a scroll or a resize is simpler.
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [open]);

  return (
    <span
      ref={wrapRef}
      className={`help-hint ${className}`}
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          // Only the note closes, not a drawer or dialog it sits in.
          event.stopPropagation();
          setOpen(false);
          buttonRef.current?.focus();
        }
      }}
    >
      <button
        ref={buttonRef}
        type="button"
        className="help-hint__btn"
        aria-label={`Help: ${label}`}
        aria-expanded={open}
        aria-controls={open ? noteId : undefined}
        onClick={toggle}
      >
        ?
      </button>
      {open && (
        <span id={noteId} role="note" className="help-hint__note" style={place}>
          {children}
        </span>
      )}
    </span>
  );
}
