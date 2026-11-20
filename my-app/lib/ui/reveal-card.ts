/**
 * Take the reader to one card on the page: open it if it folds, scroll it to
 * the top, flash it once, and put keyboard focus on it.
 *
 * Compare's map, the list of tables above the report and the jump bar over a
 * result all send the reader somewhere further down the page. They do it the
 * same way so the page feels like one thing: a smooth scroll (an instant one
 * when the reader asked for less motion), a short ring that says "this one",
 * and focus on the card's own heading so Tab carries on from there.
 *
 * The ring is the `card-flash` class in globals.css. The class comes off again
 * after the animation, so the same card can be flashed twice in a row.
 */
export function revealCard(card: HTMLElement, focusTarget?: HTMLElement | null): void {
  if (card instanceof HTMLDetailsElement) card.open = true;
  const still =
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  // jsdom has no scrollIntoView, and a test that clicks a chip should not
  // fail on the scroll it cannot see.
  card.scrollIntoView?.({ behavior: still ? "auto" : "smooth", block: "start" });
  card.classList.remove("card-flash");
  // Read the layout so the animation starts again when the class comes back.
  void card.offsetWidth;
  card.classList.add("card-flash");
  window.setTimeout(() => card.classList.remove("card-flash"), 1600);
  const target = focusTarget ?? card.querySelector<HTMLElement>(":scope > summary") ?? card;
  // A heading or a plain box takes focus only with a tabindex. -1 keeps it
  // out of the Tab order.
  if (!target.hasAttribute("tabindex") && !target.matches("a[href], button, input, select, textarea, summary")) {
    target.setAttribute("tabindex", "-1");
  }
  target.focus({ preventScroll: true });
}
