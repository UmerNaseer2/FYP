"use client";

import "@/app/styles/atelier-tabs.css";
import { useLayoutEffect, useRef, type KeyboardEvent } from "react";

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
