"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { revealCard } from "@/lib/ui/reveal-card";

/**
 * The bar at the top of one Compare result: Summary, Map, Tables and Script.
 *
 * Testers found a result long to scroll through, and the migration panel easy
 * to miss: it sits beside the list on a wide screen and under all of it on a
 * narrow one. This bar stays at the top of the result while the result scrolls
 * past, shows which part is on screen, and takes the reader to any part in one
 * press. Script is the bright one, because the script is what the page is for.
 *
 * It finds the parts inside its own result (the `.cp-outcome` around it), so
 * with two targets on one page each bar only moves through its own result.
 */

type Part = "summary" | "map" | "tables" | "script";

/** Where each part is inside a result. `spy` is the element whose top says the reader has reached it. */
const PARTS: { id: Part; jump: string; spy: string }[] = [
  { id: "summary", jump: ":scope > .cp-counts", spy: ":scope > .cp-counts" },
  { id: "map", jump: ":scope > .cp-map", spy: ":scope > .cp-map" },
  // The list column starts with the export bar and the critical changes, and
  // the reader is in "the list" from there on, but a press goes straight to
  // the tables themselves.
  { id: "tables", jump: ":scope > .cp-grid [data-jump=\"tables\"]", spy: ":scope > .cp-grid" },
  { id: "script", jump: ":scope > .cp-grid > aside", spy: ":scope > .cp-grid > aside" },
];

/** How far under the bar a part's top has to be before the reader counts as there. */
const READ_LINE = 24;

function find(outcome: Element, selector: string): HTMLElement | null {
  return outcome.querySelector<HTMLElement>(selector);
}

/** The element a part's heading is, so focus lands on words and not on a box. */
function headingOf(element: HTMLElement): HTMLElement {
  const labelledBy = element.getAttribute("aria-labelledby");
  const labelled = labelledBy ? document.getElementById(labelledBy) : null;
  return labelled ?? element.querySelector<HTMLElement>(".section-title") ?? element;
}

export function CompareJumpBar({
  label,
  tables,
  statements,
}: {
  /** The bar's name for screen readers, which says which result it belongs to. */
  label: string;
  /** How many tables differ, for the Tables count. */
  tables: number;
  /** How many statements the generated script has, for the Script count. */
  statements: number;
}) {
  const navRef = useRef<HTMLElement>(null);
  const buttons = useRef<Partial<Record<Part, HTMLButtonElement | null>>>({});
  const [present, setPresent] = useState<Part[]>(["summary", "map", "tables", "script"]);
  const [active, setActive] = useState<Part>("summary");
  const [stuck, setStuck] = useState(false);
  const [pill, setPill] = useState<{ x: number; w: number } | null>(null);
  // While a press is scrolling the page, the bar keeps showing where the
  // reader asked to go instead of every part the scroll passes on the way.
  const pressed = useRef<{ part: Part; timer: number } | null>(null);
  // The last part the reader pressed. Beside the list the script has no place
  // of its own to scroll to, so Script stays lit there until the reader
  // scrolls on to another part.
  const chosen = useRef<Part | null>(null);

  const outcomeOf = () => navRef.current?.closest(".cp-outcome") ?? null;

  // Which part is on screen, and whether the bar has stuck to the top.
  const read = useCallback(() => {
    const nav = navRef.current;
    const outcome = nav?.closest(".cp-outcome");
    if (!nav || !outcome) return;
    const barBox = nav.getBoundingClientRect();
    const line = barBox.bottom + READ_LINE;
    // Stuck once the bar has come up to its sticky place, `top` in the CSS,
    // measured from the top of whatever scrolls.
    const scroller = nav.closest("main");
    const scrollerTop = scroller ? scroller.getBoundingClientRect().top : 0;
    const stickyTop = Number.parseFloat(getComputedStyle(nav).top);
    setStuck(barBox.top - scrollerTop <= (Number.isFinite(stickyTop) ? stickyTop : 10) + 0.5);
    if (pressed.current) return;

    const grid = find(outcome, ":scope > .cp-grid");
    const list = grid ? find(grid, ":scope > .cp-col") : null;
    const aside = grid ? find(grid, ":scope > aside") : null;
    // The script only takes its turn when it sits under the list. Beside the
    // list it is on screen the whole time the list is.
    const stacked =
      list !== null && aside !== null &&
      aside.getBoundingClientRect().top > list.getBoundingClientRect().top + 1;

    let next: Part | null = null;
    for (const part of PARTS) {
      if (part.id === "script" && !stacked) continue;
      const element = find(outcome, part.spy);
      if (element && element.getBoundingClientRect().top <= line) next = part.id;
    }
    if (!stacked && next === "tables" && chosen.current === "script") next = "script";
    else if (next !== chosen.current) chosen.current = null;
    setActive(next ?? "summary");
  }, []);

  // Which parts this result has. A comparison with nothing to draw has no map.
  // The parts are the bar's neighbours on the page, so the bar reads them
  // before the first paint and again whenever they come or go.
  useLayoutEffect(() => {
    const outcome = navRef.current?.closest(".cp-outcome");
    if (!outcome) return;
    const scan = () => {
      const found = PARTS.filter((part) => find(outcome, part.jump) !== null).map((part) => part.id);
      setPresent((previous) => (previous.join() === found.join() ? previous : found));
    };
    scan();
    if (typeof MutationObserver === "undefined") return;
    const observer = new MutationObserver(scan);
    observer.observe(outcome, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);

  // Follow the page as it scrolls. The page scrolls inside the shell's <main>,
  // not the window, so that is what is listened to when it is there.
  useEffect(() => {
    const nav = navRef.current;
    if (!nav) return;
    const scroller: HTMLElement | Window = nav.closest("main") ?? window;
    let frame = 0;
    const onScroll = () => {
      if (pressed.current) {
        // Let the press go once the page has been still for a moment.
        const held = pressed.current;
        window.clearTimeout(held.timer);
        held.timer = window.setTimeout(release, 140);
      }
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        read();
      });
    };
    const release = () => {
      pressed.current = null;
      read();
    };
    read();
    scroller.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      scroller.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (frame) window.cancelAnimationFrame(frame);
      if (pressed.current) window.clearTimeout(pressed.current.timer);
    };
  }, [read]);

  // Slide the white pill under the part on screen, and keep that part in view
  // when the bar is scrolled sideways on a phone.
  const place = useCallback(() => {
    const nav = navRef.current;
    const button = buttons.current[active];
    // On Script the pill stays where it was and fades: Script has its own colour.
    if (!nav || !button || active === "script") return;
    const x = button.offsetLeft;
    const w = button.offsetWidth;
    setPill((previous) => (previous && previous.x === x && previous.w === w ? previous : { x, w }));
    const left = nav.scrollLeft;
    if (x < left || x + w > left + nav.clientWidth) {
      nav.scrollTo?.({ left: Math.max(0, x - 8), behavior: "smooth" });
    }
  }, [active]);

  useLayoutEffect(() => {
    place();
  }, [place, present]);

  // The buttons are watched as well as the bar: a font that loads late or a
  // narrower screen changes a button's width while the bar stays as wide.
  useEffect(() => {
    const nav = navRef.current;
    if (!nav || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => place());
    observer.observe(nav);
    // The border box, so a change of padding counts too.
    nav.querySelectorAll(".cp-jump__btn").forEach((button) => observer.observe(button, { box: "border-box" }));
    return () => observer.disconnect();
  }, [place, present]);

  const go = (part: Part) => {
    const outcome = outcomeOf();
    const spec = PARTS.find((each) => each.id === part);
    const element = outcome && spec ? find(outcome, spec.jump) : null;
    if (!element) return;
    if (pressed.current) window.clearTimeout(pressed.current.timer);
    // Released by the scroll going still, or straight away if the part was
    // already where it needed to be and nothing scrolls.
    pressed.current = {
      part,
      timer: window.setTimeout(() => {
        pressed.current = null;
        read();
      }, 600),
    };
    setActive(part);
    chosen.current = part;

    if (part === "script") {
      // The panel's first card rings, and focus goes to its heading.
      const card = element.querySelector<HTMLElement>(".card") ?? element;
      revealCard(card, headingOf(card));
      return;
    }
    // The map starts folded; it opens before the scroll lands on it.
    if (part === "map") element.dispatchEvent(new CustomEvent("cp:reveal"));
    const still =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    element.scrollIntoView?.({ behavior: still ? "auto" : "smooth", block: "start" });
    const heading = headingOf(element);
    if (!heading.hasAttribute("tabindex") && !heading.matches("a[href], button, summary")) {
      heading.setAttribute("tabindex", "-1");
    }
    heading.focus({ preventScroll: true });
  };

  const has = (part: Part) => present.includes(part);
  const current = (part: Part) => (active === part ? ("location" as const) : undefined);

  return (
    <nav
      ref={navRef}
      className="cp-jump"
      aria-label={label}
      data-stuck={stuck ? "" : undefined}
      data-ready={pill ? "" : undefined}
      style={pill ? ({ "--x": `${pill.x}px`, "--w": `${pill.w}px` } as CSSProperties) : undefined}
    >
      <span className={`cp-jump__pill${active === "script" ? " is-away" : ""}`} aria-hidden="true" />
      {has("summary") && (
        <button
          type="button"
          ref={(element) => {
            buttons.current.summary = element;
          }}
          className="cp-jump__btn"
          aria-current={current("summary")}
          onClick={() => go("summary")}
        >
          Summary
        </button>
      )}
      {has("map") && (
        <button
          type="button"
          ref={(element) => {
            buttons.current.map = element;
          }}
          className="cp-jump__btn"
          aria-current={current("map")}
          onClick={() => go("map")}
        >
          Map
        </button>
      )}
      {has("tables") && (
        <button
          type="button"
          ref={(element) => {
            buttons.current.tables = element;
          }}
          className="cp-jump__btn"
          aria-current={current("tables")}
          onClick={() => go("tables")}
        >
          Tables <span className="cp-jump__n">{tables}</span>
          <span className="sr-only"> with changes</span>
        </button>
      )}
      {has("script") && (
        <button
          type="button"
          ref={(element) => {
            buttons.current.script = element;
          }}
          className="cp-jump__btn cp-jump__btn--go"
          aria-current={current("script")}
          onClick={() => go("script")}
        >
          Script <span className="cp-jump__n">{statements}</span>
          <span className="sr-only"> {statements === 1 ? "statement" : "statements"}</span>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M5 12h14M13 6l6 6-6 6" />
          </svg>
        </button>
      )}
    </nav>
  );
}
