"use client";

import { useEffect, type ReactNode } from "react";

/**
 * The two small pieces of the landing page that run in the browser, next to
 * the theme switch (LandingThemeToggle). The page itself is a Server
 * Component, so anything with a click or a scroll lives here.
 */

function wantsLessMotion(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Fades each `.lp-rv` section in as it scrolls into view.
 *
 * Only sections still below the screen when the page opens are hidden first,
 * so nothing that is already on screen blinks, and without JavaScript (or
 * with reduced motion) every section simply shows. Draws nothing itself.
 */
export function LandingReveal() {
  useEffect(() => {
    if (wantsLessMotion() || typeof IntersectionObserver === "undefined") return;

    const below = Array.from(document.querySelectorAll<HTMLElement>(".lp-rv")).filter(
      (section) => section.getBoundingClientRect().top > window.innerHeight
    );
    if (below.length === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          entry.target.classList.remove("lp-wait");
          observer.unobserve(entry.target);
        }
      },
      { rootMargin: "0px 0px -10% 0px" }
    );
    for (const section of below) {
      section.classList.add("lp-wait");
      observer.observe(section);
    }
    return () => {
      observer.disconnect();
      for (const section of below) section.classList.remove("lp-wait");
    };
  }, []);

  return null;
}

/**
 * A button that scrolls to a part of the same page and moves focus there, so
 * a keyboard user lands where a mouse user looks. The target needs
 * tabIndex={-1} to take the focus.
 *
 * A button, not a link: the front page keeps exactly two links, the two ways in.
 */
export function SectionButton({
  target,
  className,
  children,
}: {
  target: string;
  className?: string;
  children: ReactNode;
}) {
  function go() {
    const place = document.getElementById(target);
    if (!place) return;
    place.scrollIntoView({ behavior: wantsLessMotion() ? "auto" : "smooth", block: "start" });
    place.focus({ preventScroll: true });
  }

  return (
    <button type="button" className={className} onClick={go}>
      {children}
    </button>
  );
}
