"use client";

// Two kinds of tabs live in this file.
//
//   PageTabs: underline tabs, for the sections of a page (Drift, Admin,
//             Performance, Visualizer). This is the one tab style for pages.
//   PillTabs: the older pill tabs. Pills are for filters now, so a page's
//             sections should move to PageTabs.
//
// PageTabs, with panels on the same page (the tabs are buttons):
//
//   const [tab, setTab] = useState("users");
//   <PageTabs
//     label="Admin sections"
//     tabs={[
//       { key: "users", label: "Users" },
//       { key: "roles", label: "Roles & permissions", count: 2 },
//     ]}
//     value={tab}
//     onChange={setTab}
//     idPrefix="admin-tab-"
//     panelPrefix="admin-panel-"
//   />
//   <div role="tabpanel" id="admin-panel-users" aria-labelledby="admin-tab-users">...</div>
//
// PageTabs, where each tab is its own address (the tabs are links): give
// every tab an href and leave out onChange, idPrefix and panelPrefix.
//
//   <PageTabs
//     label="Drift views"
//     tabs={[
//       { key: "detail", label: "Drift detail", href: orgPath("/drift?tab=detail") },
//       { key: "audit", label: "Audit log", href: orgPath("/drift?tab=audit") },
//     ]}
//     value={tab}
//   />
//
// Put it inside <PageHeader> (as its children) or straight under it. On a
// narrow screen the row scrolls sideways, and its edge fades while more tabs
// are hidden that way.

import "@/app/styles/atelier-tabs.css";
import Link from "next/link";
import { useCallback, useEffect, useLayoutEffect, useRef, type KeyboardEvent } from "react";

export type PageTab = {
  key: string;
  label: string;
  /** A small number after the label, such as how many things are waiting. Left out when 0. */
  count?: number;
  /** Where the tab goes, when each tab is its own address. Give it to every tab or to none. */
  href?: string;
};

type PageTabsProps = {
  /** What this group of tabs is, for a screen reader: "Admin sections". */
  label: string;
  tabs: PageTab[];
  /** The key of the picked tab. */
  value: string;
  /** Called with the new key. Not needed when the tabs are links. */
  onChange?: (key: string) => void;
  /** Each tab's id is this plus its key. The page's panels point at it with aria-labelledby. */
  idPrefix?: string;
  /** Each panel's id is this plus the tab's key. */
  panelPrefix?: string;
};

/**
 * Underline tabs for the sections of a page. See the top of this file for how
 * to use them.
 *
 * As buttons they are a real tablist: only the picked tab is in the Tab
 * order, and Left, Right, Home and End move between tabs and pick them. As
 * links they are a nav, the open one marked with aria-current, and the same
 * keys move focus between the links without following them.
 */
export function PageTabs({ label, tabs, value, onChange, idPrefix = "", panelPrefix }: PageTabsProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const asLinks = tabs.length > 0 && tabs.every((tab) => tab.href);

  // Say which edges hide more tabs, so the CSS can fade them.
  const markEdges = useCallback(() => {
    const wrap = wrapRef.current;
    const list = listRef.current;
    if (!wrap || !list) return;
    const hiddenRight = list.scrollWidth - list.clientWidth - list.scrollLeft;
    wrap.toggleAttribute("data-more-left", list.scrollLeft > 4);
    wrap.toggleAttribute("data-more-right", hiddenRight > 4);
  }, []);

  useEffect(() => {
    markEdges();
    window.addEventListener("resize", markEdges);
    return () => window.removeEventListener("resize", markEdges);
  }, [markEdges, tabs]);

  // Keep the picked tab in view when the row is scrolled sideways.
  useLayoutEffect(() => {
    const list = listRef.current;
    const picked = list?.querySelector<HTMLElement>("[data-picked]");
    if (!list || !picked) return;
    const left = picked.offsetLeft;
    const right = left + picked.offsetWidth;
    if (left < list.scrollLeft) list.scrollLeft = left;
    else if (right > list.scrollLeft + list.clientWidth) list.scrollLeft = right - list.clientWidth;
    markEdges();
  }, [value, markEdges]);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const items = Array.from(listRef.current?.querySelectorAll<HTMLElement>(".ptabs__tab") ?? []);
    const focused = items.indexOf(document.activeElement as HTMLElement);
    const at = focused >= 0 ? focused : tabs.findIndex((tab) => tab.key === value);
    let next = -1;
    if (event.key === "ArrowRight") next = (at + 1) % tabs.length;
    if (event.key === "ArrowLeft") next = (at - 1 + tabs.length) % tabs.length;
    if (event.key === "Home") next = 0;
    if (event.key === "End") next = tabs.length - 1;
    if (next < 0) return;
    event.preventDefault();
    // Buttons are picked as focus moves. A link is only focused: Enter follows it.
    if (!asLinks) onChange?.(tabs[next].key);
    items[next]?.focus();
  }

  const row = tabs.map((tab) => {
    const picked = tab.key === value;
    const inside = (
      <>
        {tab.label}
        {tab.count ? <span className="ptabs__count">{tab.count}</span> : null}
      </>
    );
    if (asLinks) {
      return (
        // Colour alone would leave a screen reader with identical links, so
        // aria-current says which one is open.
        <Link
          key={tab.key}
          href={tab.href ?? ""}
          className="ptabs__tab"
          aria-current={picked ? "page" : undefined}
          data-picked={picked ? "" : undefined}
        >
          {inside}
        </Link>
      );
    }
    return (
      <button
        key={tab.key}
        type="button"
        role="tab"
        className="ptabs__tab"
        id={idPrefix + tab.key}
        aria-selected={picked}
        aria-controls={panelPrefix === undefined ? undefined : panelPrefix + tab.key}
        tabIndex={picked ? 0 : -1}
        data-picked={picked ? "" : undefined}
        onClick={() => onChange?.(tab.key)}
      >
        {inside}
      </button>
    );
  });

  return (
    <div className="ptabs" ref={wrapRef}>
      {asLinks ? (
        <nav className="ptabs__list" ref={listRef} aria-label={label} onKeyDown={onKeyDown} onScroll={markEdges}>
          {row}
        </nav>
      ) : (
        <div
          className="ptabs__list"
          ref={listRef}
          role="tablist"
          aria-label={label}
          onKeyDown={onKeyDown}
          onScroll={markEdges}
        >
          {row}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- pill tabs

export type PillTab = {
  key: string;
  label: string;
  /** A small number after the label, such as how many things are waiting. Left out when 0. */
  count?: number;
};

type PillTabsProps = {
  /** What this group of tabs is, for a screen reader: "Admin sections". */
  label: string;
  tabs: PillTab[];
  /** The key of the picked tab. */
  value: string;
  onChange: (key: string) => void;
  /** Each tab's id is this plus its key. The page's panels point at it with aria-labelledby. */
  idPrefix: string;
  /** Each panel's id is this plus the tab's key. */
  panelPrefix: string;
};

/**
 * A row of pill tabs with a dark thumb that slides behind the picked one.
 * For a page's sections use PageTabs (above) instead; pills are for filters.
 * Only the picked tab is in the Tab order. Left, Right, Home and End move
 * between tabs, as people expect of tabs.
 *
 * The page draws its own panels: give each one role="tabpanel", the id
 * `panelPrefix + key`, and aria-labelledby `idPrefix + key`.
 */
export function PillTabs({ label, tabs, value, onChange, idPrefix, panelPrefix }: PillTabsProps) {
  const listRef = useRef<HTMLDivElement>(null);

  // Put the thumb behind the picked tab. Measured again when the window
  // changes size, because the tabs' widths change with it.
  useLayoutEffect(() => {
    function place() {
      const list = listRef.current;
      const picked = list?.querySelector<HTMLElement>('[aria-selected="true"]');
      if (!list || !picked) return;
      list.style.setProperty("--x", `${picked.offsetLeft}px`);
      list.style.setProperty("--w", `${picked.offsetWidth}px`);
    }
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [value, tabs]);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const at = tabs.findIndex((tab) => tab.key === value);
    let next = -1;
    if (event.key === "ArrowRight") next = (at + 1) % tabs.length;
    if (event.key === "ArrowLeft") next = (at - 1 + tabs.length) % tabs.length;
    if (event.key === "Home") next = 0;
    if (event.key === "End") next = tabs.length - 1;
    if (next < 0) return;
    event.preventDefault();
    onChange(tabs[next].key);
    document.getElementById(idPrefix + tabs[next].key)?.focus();
  }

  return (
    <div
      ref={listRef}
      className="atabs"
      role="tablist"
      aria-label={label}
      onKeyDown={onKeyDown}
    >
      <span className="atabs__thumb" aria-hidden />
      {tabs.map((tab) => {
        const picked = tab.key === value;
        return (
          <button
            key={tab.key}
            type="button"
            role="tab"
            id={idPrefix + tab.key}
            aria-selected={picked}
            aria-controls={panelPrefix + tab.key}
            tabIndex={picked ? 0 : -1}
            onClick={() => onChange(tab.key)}
          >
            {tab.label}
            {tab.count ? <span className="atabs__count">{tab.count}</span> : null}
          </button>
        );
      })}
    </div>
  );
}
