import { useEffect, type RefObject } from "react";

/**
 * Every focusable thing, in document order. `:not([disabled])` and the
 * negative-tabindex filter matter: a disabled Save button and a
 * `tabIndex={-1}` container are both reachable by script but not by Tab, and
 * landing on either would strand the keyboard user.
 */
const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

function focusableWithin(panel: HTMLElement): HTMLElement[] {
  return Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    // offsetParent is null for anything display:none or inside a closed
    // <details>; those are in the DOM but nobody can see them.
    (el) => el.offsetParent !== null || el === document.activeElement
  );
}

/**
 * Keyboard behaviour every dialog owes its user, in one place.
 *
 * A dialog that only *looks* like a dialog is the whole-app defect this fixes:
 * `role="dialog" aria-modal="true"` tells a screen reader the rest of the page
 * is unavailable, but without focus handling Tab walks straight out of the
 * panel and into the page behind it — which is both still there and now
 * announced as if it were not. Three things close that gap:
 *
 *   1. Focus moves into the panel when it opens, so the first Tab starts here.
 *   2. Tab and Shift+Tab wrap at the ends instead of leaving.
 *   3. Focus returns to whatever opened the dialog when it closes, so the
 *      keyboard user is put back where they were rather than at the top of
 *      the document.
 *
 * Escape stays with the callers — Modal and Drawer each already close on it,
 * and both need their own onClose anyway.
 */
export function useDialogFocus(open: boolean, panelRef: RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    if (!panel) return;

    // Remember the trigger before we move focus, so we can hand it back.
    const opener = document.activeElement as HTMLElement | null;

    const first = focusableWithin(panel)[0];
    // The panel itself carries tabIndex={-1}, so it can hold focus when there
    // is nothing focusable inside — a confirm dialog is never that, but a
    // read-only drawer can be.
    (first ?? panel).focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const items = focusableWithin(panel);
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const edge = e.shiftKey ? items[0] : items[items.length - 1];
      // Only intervene at the edges; in the middle the browser's own order is
      // already correct and interfering would break arrow-key widgets.
      if (document.activeElement === edge || !panel.contains(document.activeElement)) {
        e.preventDefault();
        (e.shiftKey ? items[items.length - 1] : items[0]).focus();
      }
    };

    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      // Only take focus back if it is still inside the panel we are closing.
      // If the close was caused by a click elsewhere, that elsewhere should
      // keep it.
      if (opener && document.body.contains(opener)) opener.focus();
    };
  }, [open, panelRef]);
}
