"use client";

import { useCallback, useEffect, useRef, type ReactNode } from "react";
import { HelpIcon } from "@/components/ui/icons";
import { boxAround, firstOnScreen, lightUp } from "@/lib/tour";

const FOCUSABLE = 'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

type SpotlightProps = {
  /** What to light up: a CSS selector. The first match on screen is used. */
  target: string;
  /** The words on the small card beside the light, such as a help step. */
  children: ReactNode;
  /** Called when it ends: Got it, Escape, or a click anywhere. */
  onDone: () => void;
};

/**
 * The app tour's light on one control, with a small card beside it. The Help
 * panel's "Show me" links use it:
 *
 *   <Spotlight target='[data-tour="add-connection"]' onDone={close}>
 *     Press Add connection.
 *   </Spotlight>
 *
 * It borrows the tour's look (the .tour, .tr-hole and .tr-card styles in
 * globals.css) and its placing code (lib/tour.ts), so the two never drift
 * apart. Got it, Escape, or a click anywhere ends it, and focus then moves to
 * the control when it can take focus. For someone who asked for less motion
 * the page jumps to the control instead of gliding and the ring stays still.
 */
export function Spotlight({ target, children, onDone }: SpotlightProps) {
  const holeRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const doneRef = useRef<HTMLButtonElement>(null);

  const finish = useCallback(() => {
    const element = firstOnScreen(target);
    onDone();
    // After the layer has gone, so the focus ring shows on the control itself.
    // A control that can't take focus hands it to the first thing inside it
    // that can, and failing that to the Help button (or the phone menu).
    window.setTimeout(() => {
      if (element instanceof HTMLElement) {
        element.focus({ preventScroll: true });
        if (document.activeElement === element) return;
        const inside = element.querySelector<HTMLElement>(FOCUSABLE);
        if (inside) {
          inside.focus({ preventScroll: true });
          return;
        }
      }
      const fallback = [...document.querySelectorAll<HTMLElement>("[data-help-button], .tb-menu")].find(
        (each) => each.offsetParent !== null,
      );
      fallback?.focus({ preventScroll: true });
    }, 0);
  }, [target, onDone]);

  // Keep the light on the control while the page scrolls to it or changes size.
  useEffect(() => {
    let aimed: number | null = null;
    function tick() {
      const hole = holeRef.current;
      const card = cardRef.current;
      if (!hole || !card) return;
      const element = firstOnScreen(target);
      aimed = lightUp(hole, card, element, element ? boxAround([element]) : null, aimed);
    }
    tick();
    const timer = window.setInterval(tick, 240);
    window.addEventListener("resize", tick);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("resize", tick);
    };
  }, [target]);

  // Escape ends it, and goes no further (the page's own shortcuts stay quiet).
  // Tab stays on Got it, the card's one button, so focus never wanders onto
  // the page under the light.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Tab") {
        event.preventDefault();
        doneRef.current?.focus({ preventScroll: true });
        return;
      }
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      finish();
    }
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [finish]);

  useEffect(() => {
    doneRef.current?.focus({ preventScroll: true });
  }, []);

  return (
    <div className="tour" onClick={finish}>
      <div className="tr-hole" ref={holeRef} aria-hidden="true" />
      {/* A click on the card itself is not "anywhere": only Got it closes from here. */}
      <div
        className="tr-card help-spot"
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-label="Show me"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="tr-in in">
          <div className="tr-k">
            <i aria-hidden="true">
              <HelpIcon size={16} />
            </i>
            Show me
          </div>
          <p>{children}</p>
        </div>
        <div className="tr-f">
          <button type="button" className="btn btn-primary" ref={doneRef} onClick={finish}>
            Got it
          </button>
        </div>
        <p className="tr-keys">
          Click anywhere or press <kbd>Esc</kbd> to close
        </p>
      </div>
    </div>
  );
}
