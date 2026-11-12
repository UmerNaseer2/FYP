"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { REPLAY_INTRO_EVENT, takeIntroTurn } from "@/lib/intro";

// The logo reveal (see lib/intro.ts for when it plays).
//
// What happens, in order:
//   1. The two squares fly in and lock together, a light sweeps across them
//      and the words "Schema Studio" write themselves out beside the mark.
//   2. After a short hold (or a click, or Esc) the words fade, the background
//      fades, and the mark flies into the logo at the top of the sidebar
//      (the element marked data-intro-target), while the page rises in.
//   3. The overlay goes away.
//
// With reduced motion turned on, nothing moves: the mark shows for under a
// second and fades. With no sidebar on screen (a phone), the mark fades where
// it is instead of flying.

const HOLD_MS = 2400;
const HOLD_CALM_MS = 900;
const FLY_MS = 580;
const FADE_MS = 320;
const WORD = "Schema Studio";

export default function LogoIntro() {
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    // The head script marked the page as waiting for the intro. This is a
    // one-off check when the studio first draws, not state that follows props.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (takeIntroTurn()) setPlaying(true);
    const replay = () => setPlaying(true);
    window.addEventListener(REPLAY_INTRO_EVENT, replay);
    return () => window.removeEventListener(REPLAY_INTRO_EVENT, replay);
  }, []);

  if (!playing) return null;
  return createPortal(<IntroOverlay onDone={() => setPlaying(false)} />, document.body);
}

function IntroOverlay({ onDone }: { onDone: () => void }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const markRef = useRef<HTMLDivElement>(null);
  const finishRef = useRef<() => void>(() => {});
  const onDoneRef = useRef(onDone);

  useEffect(() => {
    onDoneRef.current = onDone;
  }, [onDone]);

  useEffect(() => {
    const html = document.documentElement;
    // The studio was hidden while it waited for us; show it under the overlay.
    html.setAttribute("data-intro", "playing");

    const calm = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    const target = document.querySelector<SVGElement>("[data-intro-target]");
    const animations: Animation[] = [];
    const timers: number[] = [];
    let finished = false;
    let closed = false;

    function close() {
      if (closed) return;
      closed = true;
      animations.forEach((a) => a.cancel());
      if (target) target.style.visibility = "";
      // Leave "landing" on for a moment so the page finishes rising in. Not
      // in timers: the overlay unmounts next, and that must not cancel this.
      window.setTimeout(() => html.removeAttribute("data-intro"), 900);
      onDoneRef.current();
    }

    function finish() {
      if (finished) return;
      finished = true;
      const root = rootRef.current;
      const mark = markRef.current;
      // jsdom and very old browsers have no Element.animate: just end.
      if (!root || !mark || typeof mark.animate !== "function") {
        close();
        return;
      }
      const from = mark.getBoundingClientRect();
      const to = target?.getBoundingClientRect();
      const fly = !calm && !!to && to.width > 0;
      root.classList.add("out");

      const fade = (selector: string, keyframes: Keyframe[], options: KeyframeAnimationOptions) => {
        const el = root.querySelector(selector);
        if (el) animations.push(el.animate(keyframes, { fill: "forwards", ...options }));
      };
      fade(".bt-w", [{ opacity: 1, transform: "none" }, { opacity: 0, transform: "translateX(-10px)" }], { duration: 180, easing: "ease-out" });
      fade(".bt-skip", [{ opacity: 1 }, { opacity: 0 }], { duration: 120 });
      fade(".bt-bg", [{ opacity: 1 }, { opacity: 0 }], { duration: fly ? 460 : FADE_MS, delay: fly ? 140 : 0, easing: "ease-out" });

      let move: Animation;
      if (fly && to) {
        if (target) target.style.visibility = "hidden";
        html.setAttribute("data-intro", "landing");
        mark.style.transformOrigin = "0 0";
        const dx = to.left - from.left;
        const dy = to.top - from.top;
        const scale = to.width / from.width;
        move = mark.animate(
          [{ transform: "none" }, { transform: `translate(${dx}px, ${dy}px) scale(${scale})` }],
          { duration: FLY_MS, easing: "cubic-bezier(.65,0,.35,1)", fill: "forwards" }
        );
      } else {
        move = mark.animate(
          [{ opacity: 1, transform: "none" }, { opacity: 0, transform: "scale(1.12)" }],
          { duration: FADE_MS, easing: "cubic-bezier(.65,0,.35,1)", fill: "forwards" }
        );
      }
      animations.push(move);
      move.finished.then(close, close);
      // In case the animation never reports back (a hidden tab pauses it).
      timers.push(window.setTimeout(close, (fly ? FLY_MS : FADE_MS) + 200));
    }

    finishRef.current = finish;
    timers.push(window.setTimeout(finish, calm ? HOLD_CALM_MS : HOLD_MS));

    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      finish();
    };
    document.addEventListener("keydown", onKey, true);

    return () => {
      document.removeEventListener("keydown", onKey, true);
      timers.forEach((t) => window.clearTimeout(t));
      animations.forEach((a) => a.cancel());
      if (target) target.style.visibility = "";
      // Never leave the studio hidden behind a half-finished intro.
      if (!closed) html.removeAttribute("data-intro");
    };
  }, []);

  return (
    <div
      ref={rootRef}
      className="boot"
      role="img"
      aria-label="Schema Studio is opening"
      data-testid="logo-intro"
      onClick={() => finishRef.current()}
    >
      <div className="bt-bg" />
      <div className="bt-stage">
        <div className="bt-m" ref={markRef}>
          <i className="bt-ring" />
          <i className="bt-ring r2" />
          <svg viewBox="0 0 30 30" aria-hidden="true">
            <defs>
              <clipPath id="bt-union">
                <rect x="2" y="2" width="18" height="18" rx="6" />
                <rect x="10" y="10" width="18" height="18" rx="6" />
              </clipPath>
            </defs>
            <rect className="bt-a" x="2" y="2" width="18" height="18" rx="6" fill="var(--accent)" />
            <rect className="bt-b" x="10" y="10" width="18" height="18" rx="6" fill="var(--ink)" />
            <path className="bt-l" d="M16 10H20V14A6 6 0 0 1 14 20H10V16A6 6 0 0 1 16 10Z" fill="var(--bg)" />
            <g clipPath="url(#bt-union)">
              <rect className="bt-sh" x="-12" y="-4" width="7" height="38" fill="#fff" />
            </g>
          </svg>
        </div>
        <div className="bt-w" aria-hidden="true">
          {[...WORD].map((letter, i) =>
            letter === " " ? (
              <span key={i} className="sp" />
            ) : (
              <span key={i} style={{ "--i": i } as CSSProperties}>
                {letter}
              </span>
            )
          )}
        </div>
      </div>
      <span className="bt-skip" aria-hidden="true">
        Click or press Esc to skip
      </span>
    </div>
  );
}
