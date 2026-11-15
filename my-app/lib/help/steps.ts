// Helpers for the steps in a help file. A step is either plain words, or
// words plus the control they are about. The Help panel puts a "Show me" link
// beside a step whose control is on the page right now, and pressing it lights
// that control up with the tour's spotlight (components/studio/AppTour.tsx).
import type { HelpStep } from "./types";

/** The words of a step. */
export function stepText(step: HelpStep): string {
  return typeof step === "string" ? step : step.text;
}

/** The CSS selector of the control a step is about, or null when it names none. */
export function stepTarget(step: HelpStep): string | null {
  return typeof step === "string" ? null : step.target;
}

/**
 * The selector for a control, by the name in its data-tour attribute:
 * anchor("add-connection") finds <button data-tour="add-connection">.
 *
 * Extra selectors are fallbacks for a page that does not carry the attribute
 * yet. A step whose control is not on the page simply gets no Show me link,
 * so naming an anchor before the page has it is safe.
 */
export function anchor(name: string, ...fallbacks: string[]): string {
  return [`[data-tour="${name}"]`, ...fallbacks].join(", ");
}
