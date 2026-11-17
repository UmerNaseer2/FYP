// The app tour: a short walk through the studio's pages, one card at a time,
// with the part of the page it talks about lit up. components/studio/AppTour
// draws it. This file holds what it says and the rules for when it is offered,
// with no React in it, so the tests can read it directly. The last part, "the
// light", finds a part of the page and lights it up.
//
// When it is offered: right after someone arrives by one of two doors, each
// of which adds `?tour=` to the first studio address it opens.
//
//   - new:    making a new organization (components/onboarding/OnboardingPage)
//   - member: joining one by invite (components/invite/InvitePage)
//
// It is offered once. Finishing it, or skipping it, is remembered in this
// browser, and "Take the tour" in the account menu starts it again any time.

import type { PermissionKey } from "@/lib/roles/permissions";

/** Who the tour is for. It changes a few of the words and the last card. */
export type TourAudience = "new" | "member";

/** The query parameter the two doors add: /acme/studio?tour=new. */
export const TOUR_PARAM = "tour";

/** The window event "Take the tour" sends. AppTour listens for it. */
export const START_TOUR_EVENT = "schema-studio:start-tour";

/** Starts the tour, from the account menu or the command bar. */
export function startTour(): void {
  window.dispatchEvent(new Event(START_TOUR_EVENT));
}

/** The audience a `?tour=` value names, or null when it names none. */
export function readTourParam(search: string): TourAudience | null {
  const value = new URLSearchParams(search).get(TOUR_PARAM);
  if (value === "new" || value === "member") return value;
  return null;
}

/** The same query string with `tour` taken out, for history.replaceState. */
export function withoutTourParam(search: string): string {
  const query = new URLSearchParams(search);
  query.delete(TOUR_PARAM);
  const rest = query.toString();
  return rest ? `?${rest}` : "";
}

// ---------------------------------------------------------------- memory

/**
 * What this browser remembers about the tour, per organization and role, so
 * someone whose role changes is offered it again.
 *
 *   - done:   finished or skipped, so it is not offered again
 *   - resume: the stop it was closed at, for "Resume the tour"; null for none
 */
export type TourMemory = { done: boolean; resume: number | null };

const NOTHING_REMEMBERED: TourMemory = { done: false, resume: null };

function memoryKey(orgSlug: string, role: string): string {
  return `schema-studio:tour:${orgSlug}:${role}`;
}

/** Reads what was remembered. Storage that is blocked or broken reads as nothing. */
export function readTourMemory(orgSlug: string, role: string): TourMemory {
  try {
    const saved = window.localStorage.getItem(memoryKey(orgSlug, role));
    if (!saved) return NOTHING_REMEMBERED;
    const parsed = JSON.parse(saved) as Partial<TourMemory>;
    return {
      done: parsed.done === true,
      resume: typeof parsed.resume === "number" && parsed.resume > 0 ? parsed.resume : null,
    };
  } catch {
    return NOTHING_REMEMBERED;
  }
}

/** Remembers it. When storage is blocked the tour still works, it is just offered again. */
export function writeTourMemory(orgSlug: string, role: string, memory: TourMemory): void {
  try {
    window.localStorage.setItem(memoryKey(orgSlug, role), JSON.stringify(memory));
  } catch {
    // Nothing to do: see above.
  }
}

// ---------------------------------------------------------------- the stops

/** The small drawing at the top of each card (AppTour has the shapes). */
export type TourIcon = "home" | "connect" | "compare" | "script" | "ship" | "sync" | "watch" | "ask" | "help";

export type TourStop = {
  id: string;
  /** The page it stands on, without the organization ("/compare"); null for the top bar. */
  page: string | null;
  icon: TourIcon;
  /** The one word beside the icon. */
  kicker: string;
  title: string;
  body: string;
  /** What to light up. The first one on screen wins, or all of them with `union`. */
  targets: string[];
  union?: boolean;
  /**
   * What the card says instead when the page shows its first-run card in place
   * of the real thing (an empty Dashboard, before anything is tracked).
   * `target` is that card, and it must also be in `targets`.
   */
  empty?: { target: string; body: string };
};

export type TourInput = {
  audience: TourAudience;
  /** useUser's can, so a custom role gets the words its permissions call for. */
  can: (key: PermissionKey) => boolean;
  /** The pages on this person's rail, without the organization ("/compare"). */
  pages: readonly string[];
  /** Whether Ask AI is switched on, so the last stop only names what is there. */
  askAi: boolean;
};

/**
 * The stops, in the order the work happens: look, connect, compare, write,
 * ship, catch up, watch, ask. A stop whose page this person's role cannot open
 * is left out, so the tour never walks into "your role can't".
 *
 * The words follow the help notes (lib/help), so the tour and the Help panel
 * never disagree.
 */
export function tourStops({ audience, can, pages, askAi }: TourInput): TourStop[] {
  const mayAddDatabases = can("connections:create");
  const mayRun = can("deploy:run");
  const stops: TourStop[] = [];

  stops.push({
    id: "home",
    page: "/studio",
    icon: "home",
    kicker: "Home",
    title: "Start here, every time",
    body:
      "Every schema your team tracks is drawn here as a building, and its roof colour is how its last drift check went. Press a building to read about it.",
    targets: [".sk-stage", ".sk-first", ".sk-page .page-header"],
    empty: {
      target: ".sk-first",
      body:
        "Nothing is tracked yet, so for now it shows the first steps. Once a schema is tracked it is drawn here as a building, and its roof colour is how its last drift check went.",
    },
  });

  stops.push({
    id: "connect",
    page: "/connections",
    icon: "connect",
    kicker: "Connect",
    title: audience === "new" ? "Add your databases once" : "Your team's databases",
    body: mayAddDatabases
      ? "Save a database here once and everyone in the organization can use it. The password is stored encrypted and never sent back to the browser."
      : "Every database your team has saved is listed here, ready to compare. Passwords are stored encrypted and never shown to anyone.",
    targets: [".cn-group-block", ".cn-page .page-header"],
  });

  stops.push({
    id: "compare",
    page: "/compare",
    icon: "compare",
    kicker: "Compare",
    title: "See exactly what differs",
    body:
      "Pick the schema that looks right, then the one to update. Comparing changes nothing: you get every difference and a script that closes the gap, ready to edit.",
    targets: [".cp-form", ".cp-page .page-header"],
  });

  stops.push({
    id: "script",
    page: "/script-editor",
    icon: "script",
    kicker: "Script",
    title: "Save it as a numbered version",
    body:
      "Or write a migration by hand, with the rollback that undoes it, and save it as the next version. Nothing runs from this page.",
    targets: [".se-line", ".se-card", ".se-page .page-header"],
  });

  stops.push({
    id: "ship",
    page: "/deploy",
    icon: "ship",
    kicker: "Ship",
    title: "Rehearse first, then ship",
    body: mayRun
      ? "A dry run rehearses a saved version and keeps nothing. A real run is one transaction, so every migration in it lands or none do, and you can undo it after. Quick run does the same for SQL you type."
      : "Runs happen here: a dry run first, then the real one, all or nothing, with undo after. Your role can see every run but not start one.",
    targets: [".dp-stage", ".dp-card", ".dp-page .page-header"],
  });


  stops.push({
    id: "watch",
    page: "/drift",
    icon: "watch",
    kicker: "Watch",
    title: "Catch changes nobody told you about",
    body:
      "If someone changes a database by hand, outside this app, it shows up here. For each change you decide: put it back, or accept it.",
    targets: [".dr-watch", ".dr-untracked .text-center", ".dr-page .page-header"],
    empty: {
      // The words in the middle of the empty card, so this card can sit beside them.
      target: ".dr-untracked .text-center",
      body:
        "Nothing is tracked yet, so this page waits for now. Once a schema is tracked, any change made to it by hand, outside this app, shows up here, and you decide: put it back, or accept it.",
    },
  });

  stops.push(askStop(can, mayRun));

  stops.push({
    id: "help",
    page: null,
    icon: "help",
    kicker: "Help",
    title: askAi ? "Stuck? Three ways out" : "Stuck? Two ways out",
    body: askAi
      ? "Search jumps to any page. Ask AI answers questions about your schemas in plain words. Help explains the page you are on. On a phone, Help and Ask AI are in the menu at the top."
      : "Search jumps to any page, and Help explains the page you are on. On a phone, Help is in the menu at the top.",
    // On a phone the top bar's buttons fold into its menu button, so that is lit too.
    targets: [".ck-b", ".top-actions", ".tb-menu"],
    union: true,
  });

  return stops.filter((stop) => stop.page === null || pages.includes(stop.page));
}

/** The Requests stop, which says something different to whoever answers and whoever asks. */
function askStop(can: TourInput["can"], mayRun: boolean): TourStop {
  const base = { id: "ask", page: "/requests", icon: "ask" as const, kicker: "Ask", targets: [".rq-main", ".rq-page .page-header"] };
  if (can("approvals:approve")) {
    return {
      ...base,
      title: "Your team asks, you answer",
      body: "When someone needs something their role does not allow, the request lands here. Read what they asked for, then say yes or no.",
    };
  }
  if (can("approvals:create")) {
    return {
      ...base,
      title: "When your role says no, ask",
      body: "If your role does not allow something, ask for it here. An Admin answers, and you see the answer on this page.",
    };
  }
  return {
    ...base,
    title: "Ask for the rest",
    body: mayRun
      ? "Anything you ask for, and anything waiting on you, shows up here."
      : "Your role lets you look around without changing anything. Anything you ask for, and anything waiting on you, shows up here.",
  };
}

/** "Eight stops", for the welcome card. */
export function stopCountWords(count: number): string {
  const words = ["Zero", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten"];
  const word = words[count] ?? String(count);
  return `${word} ${count === 1 ? "stop" : "stops"}`;
}

// ---------------------------------------------------------------- the last card

export type TourPick = {
  id: string;
  title: string;
  hint: string;
  /** Where it goes, without the organization; null to stay on the Dashboard. */
  page: string | null;
};

/** The choices on the last card, best first. */
export function tourPicks(audience: TourAudience, can: TourInput["can"], pages: readonly string[]): TourPick[] {
  const compare: TourPick = { id: "compare", title: "Run your first compare", hint: "Pick two schemas and see what differs.", page: "/compare" };
  const addDatabase: TourPick = {
    id: "connect",
    title: audience === "new" ? "Add your first database" : "Add a database",
    hint: "Connect one of your own.",
    page: "/connections",
  };
  const lookAround: TourPick = { id: "look", title: "Just look around", hint: "Stay on the Dashboard.", page: null };

  const mayAdd = can("connections:create");
  const picks: TourPick[] =
    audience === "new" && mayAdd ? [addDatabase, compare, lookAround] : [compare, ...(mayAdd ? [addDatabase] : []), lookAround];
  return picks.filter((pick) => pick.page === null || pages.includes(pick.page));
}

// ---------------------------------------------------------------- the light
//
// Finding a part of the page and putting the light (the hole) and the card on
// it. The tour uses these for each stop, and Spotlight (AppTour.tsx) uses them
// for the Help panel's "Show me" links. They only touch the page, so they
// live here with no React.

/** A rectangle on screen: left, top, right, bottom. */
export type Box = { l: number; t: number; r: number; b: number };

/** The band of screen the light may use, top to bottom. */
type Room = { top: number; bottom: number };

function onScreen(element: Element): boolean {
  return element.getClientRects().length > 0 && element.getBoundingClientRect().width > 0;
}

/**
 * The first element matching the selector that is drawn on the page right
 * now, or null. A selector the browser cannot read counts as no match.
 */
export function firstOnScreen(selector: string): Element | null {
  try {
    return Array.from(document.querySelectorAll(selector)).find(onScreen) ?? null;
  } catch {
    return null;
  }
}

/** The smallest box around all of these elements. */
export function boxAround(elements: Element[]): Box {
  const rects = elements.map((element) => element.getBoundingClientRect());
  return {
    l: Math.min(...rects.map((rect) => rect.left)),
    t: Math.min(...rects.map((rect) => rect.top)),
    r: Math.max(...rects.map((rect) => rect.right)),
    b: Math.max(...rects.map((rect) => rect.bottom)),
  };
}

/**
 * Lights up `box` and puts the card beside it, scrolling the page so the
 * element shows. Call it again as the page loads or changes size, passing back
 * the number it returned last time (null the first time): that is where the
 * page was last scrolled to, so it is scrolled again only when that spot
 * moves, never while it is already on its way there.
 */
export function lightUp(
  hole: HTMLElement,
  card: HTMLElement,
  element: Element | null,
  box: Box | null,
  aimed: number | null
): number | null {
  const room = roomFor(card, element);
  if (element) {
    const spot = scrollSpot(element, room);
    if (spot !== null && (aimed === null || Math.abs(spot - aimed) > 8)) {
      aimed = spot;
      scrollPage(spot);
    }
  }
  place(hole, card, box, room);
  return aimed;
}

/** The page's scrolling area (everything under the top bars). */
function pageScroller(): HTMLElement | null {
  return document.getElementById("main-content");
}

function isPhone(): boolean {
  return window.innerWidth <= 640;
}

/**
 * Where the light may go: below the bars at the top when the part is in the
 * page (so the bars are never lit), and on a phone above the sheet.
 */
function roomFor(card: HTMLElement, element: Element | null): Room {
  const scroller = pageScroller();
  const inPage = scroller !== null && element !== null && scroller.contains(element);
  const top = inPage ? scroller.getBoundingClientRect().top + 6 : 6;
  // offsetTop, not getBoundingClientRect: the card's pop-in animation scales it.
  const bottom = isPhone() ? card.offsetTop - 12 : window.innerHeight - 6;
  return { top, bottom };
}

/**
 * The scroll position that shows the part in the room: in the middle when it
 * fits, else with its top at the top. Null when the part is not in the page
 * (the top bar), which never scrolls.
 */
function scrollSpot(element: Element, room: Room): number | null {
  const scroller = pageScroller();
  if (!scroller || !scroller.contains(element)) return null;
  const rect = element.getBoundingClientRect();
  const space = room.bottom - room.top - 16;
  const want = rect.height <= space ? room.top + 8 + (space - rect.height) / 2 : room.top + 8;
  const most = scroller.scrollHeight - scroller.clientHeight;
  return Math.round(clamp(scroller.scrollTop + rect.top - want, 0, Math.max(0, most)));
}

/** Scrolls the page there: a glide, or a jump for someone who asked for less motion. */
function scrollPage(spot: number) {
  const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  pageScroller()?.scrollTo({ top: spot, behavior: still ? "auto" : "smooth" });
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}

function px(value: number): string {
  return `${Math.round(value)}px`;
}

/**
 * Moves the light (the hole) over the box and the card beside it: to the
 * right if there is room, else the left, else below, else above. On a phone
 * the card is a sheet along the bottom (globals.css). The light stays in the
 * room, so it never lights the bars at the top or slips under the sheet.
 */
function place(hole: HTMLElement, card: HTMLElement, box: Box | null, room: Room) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const phone = isPhone();
  const cw = card.offsetWidth;
  const ch = card.offsetHeight;
  const gap = 16;

  if (!box) {
    hole.style.left = px(vw / 2);
    hole.style.top = px(vh / 2);
    hole.style.width = "0px";
    hole.style.height = "0px";
    card.style.left = phone ? "" : px((vw - cw) / 2);
    card.style.top = phone ? "" : px((vh - ch) / 2);
    return;
  }

  let left = Math.max(6, box.l - 8);
  let top = Math.max(room.top, box.t - 8);
  const right = Math.min(vw - 6, box.r + 8);
  let bottom = Math.min(room.bottom, box.b + 8);
  let x = 12;
  let y = 12;

  if (phone) {
    // The card is the sheet; CSS places it.
  } else if (right + gap + cw <= vw - 12) {
    x = right + gap;
    y = clamp(top, 12, vh - ch - 12);
  } else if (left - gap - cw >= 12) {
    x = left - gap - cw;
    y = clamp(top, 12, vh - ch - 12);
  } else {
    if (bottom + gap + ch <= vh - 12) y = bottom + gap;
    else if (top - gap - ch >= 12) y = top - gap - ch;
    else {
      bottom = vh - ch - gap - 12;
      y = bottom + gap;
    }
    x = clamp(left, 12, vw - cw - 12);
  }
  // Out of the room for a moment (the page is still scrolling to it): a thin
  // light at the room's edge it will come in from, rather than none.
  if (bottom < top + 40) {
    if (box.t - 8 < room.top) bottom = top + 40;
    else top = Math.max(6, bottom - 40);
  }
  left = Math.min(left, right);

  hole.style.left = px(left);
  hole.style.top = px(top);
  hole.style.width = px(right - left);
  hole.style.height = px(bottom - top);
  card.style.left = phone ? "" : px(x);
  card.style.top = phone ? "" : px(y);
}
