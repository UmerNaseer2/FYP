/**
 * Put text on the clipboard, on any page the app is served from.
 *
 * navigator.clipboard only exists in a secure context (https, or localhost).
 * The handover runs the app over plain http at a LAN address, where the API is
 * missing altogether, so every Copy button failed there. The older
 * document.execCommand("copy") still works on such a page while it runs
 * inside the click that asked for it, so copyText tries the modern API first
 * and then copies from a hidden text box.
 *
 * It throws when neither way works, so each caller keeps its own "copy
 * blocked" note.
 *
 * `from` is the element the copy was started from (the Copy button), so the
 * hidden text box can go inside the same dialog: a modal dialog makes the rest
 * of the page inert and a focus trap pulls focus back, and either would stop
 * the text box from being selected.
 */
export async function copyText(text: string, from?: Element | null): Promise<void> {
  const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
  if (clipboard && typeof clipboard.writeText === "function") {
    try {
      await clipboard.writeText(text);
      return;
    } catch {
      // Refused (the page lost focus, a permission policy): try the old way.
    }
  }
  if (!copyWithTextBox(text, from ?? null)) {
    throw new Error("The browser blocked the copy.");
  }
}

/** The dialog the copy started in, or else the top open modal one. */
function dialogFor(anchor: Element | null): Element | null {
  const own = anchor?.closest("dialog, [role='dialog'], [role='alertdialog']");
  if (own) return own;
  try {
    const open = document.querySelectorAll("dialog:modal");
    return open.length > 0 ? open[open.length - 1] : null;
  } catch {
    // An older browser that does not know :modal.
    return null;
  }
}

/** Copy through a hidden, selected text box. True when the browser says it copied. */
function copyWithTextBox(text: string, from: Element | null): boolean {
  if (typeof document === "undefined" || typeof document.execCommand !== "function") return false;
  const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const host = dialogFor(from ?? previousFocus) ?? document.body;

  const box = document.createElement("textarea");
  box.value = text;
  box.setAttribute("readonly", "");
  box.setAttribute("aria-hidden", "true");
  box.tabIndex = -1;
  Object.assign(box.style, {
    position: "fixed",
    top: "0",
    left: "0",
    width: "1px",
    height: "1px",
    padding: "0",
    border: "0",
    opacity: "0",
    pointerEvents: "none",
  });
  host.appendChild(box);

  let copied = false;
  try {
    box.focus({ preventScroll: true });
    box.select();
    box.setSelectionRange(0, text.length);
    copied = document.execCommand("copy");
  } catch {
    copied = false;
  } finally {
    box.remove();
    previousFocus?.focus({ preventScroll: true });
  }
  return copied;
}
