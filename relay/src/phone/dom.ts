/**
 * Building the phone app's screens. Text always goes in as text, never as
 * HTML, so a name that comes from the computer can never become markup: the
 * app never sets innerHTML.
 */
import { ENVIRONMENT_LABELS } from "./format.js";
import type { Environment } from "../shared/remote/rpc.js";

/** An attribute's value: true sets it with no value, and false, null and undefined leave it out. */
export type AttributeValue = string | number | boolean | null | undefined;
/** What can go inside an element: strings and numbers go in as text, and null, undefined and false are left out. */
export type Child = Node | string | number | null | undefined | false;

/** A new element with `attributes` and `children`. */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attributes: Record<string, AttributeValue> = {},
  ...children: (Child | Child[])[]
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (value === false || value === null || value === undefined) continue;
    element.setAttribute(name, value === true ? "" : String(value));
  }
  append(element, children);
  return element;
}

/** Adds `children` to the end of `parent`. */
export function append(parent: Node, children: (Child | Child[])[]): void {
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    parent.appendChild(typeof child === "string" || typeof child === "number" ? document.createTextNode(String(child)) : child);
  }
}

/** A button that calls `onClick` when pressed. */
export function button(label: Child | Child[], onClick: () => void, attributes: Record<string, AttributeValue> = {}): HTMLButtonElement {
  const element = el("button", { type: "button", ...attributes }, label);
  element.addEventListener("click", onClick);
  return element;
}

/** A screen's title, which the app moves the focus to when the screen opens, so a screen reader reads it out. */
export function heading(text: string): HTMLHeadingElement {
  return el("h1", { class: "title", id: "title", tabindex: -1 }, text);
}

/** The label for a connection's environment, colored as the web app colors it. */
export function envBadge(environment: Environment): HTMLSpanElement {
  return el("span", { class: `badge env-${environment}` }, ENVIRONMENT_LABELS[environment]);
}

/** A sentence that stands out from the screen: "bad" for a problem, "info" for anything else. */
export function notice(text: string, tone: "bad" | "info", ...actions: Child[]): HTMLDivElement {
  return el("div", { class: `notice notice-${tone}`, role: tone === "bad" ? "alert" : "status" }, el("p", {}, text), actions);
}

/** What shows while the computer is asked for something. */
export function loading(text: string): HTMLParagraphElement {
  return el("p", { class: "loading", role: "status" }, text);
}

/** What shows when the computer could not answer, with a way to ask again. */
export function failed(message: string, retry: () => void): HTMLDivElement {
  return notice(message, "bad", button("Try again", retry, { class: "secondary" }));
}
