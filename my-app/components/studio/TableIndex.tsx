"use client";

import { useEffect, useId, useRef, useState, type CSSProperties } from "react";
import { revealCard } from "@/lib/ui/reveal-card";

/**
 * The short list of tables above a diff report.
 *
 * A tester comparing two schemas found that every table card opens by default
 * and had to fold each one by hand to see what else was there. This is the
 * answer: every added, changed and removed table as a chip. A chip opens its
 * card, scrolls to it and flashes it. Expand all and Collapse all fold or open
 * every card in the report at once.
 *
 * It lives inside DiffReport and finds the cards through the report's own
 * element, so two results on one page (two targets) never reach into each
 * other. It follows the report's filter, because it is handed only the tables
 * the report is showing.
 */

export type TableIndexKind = "add" | "chg" | "rem";

export type TableIndexItem = {
  /** The card's data-table-card value, for example "add:orders". */
  key: string;
  /** What the chip says. */
  label: string;
};

export type TableIndexGroup = {
  kind: TableIndexKind;
  /** "Added", "Changed", "Removed" on Compare, other words on Drift. */
  title: string;
  items: TableIndexItem[];
};

/** How many chips a group shows before "+N more". */
export const TABLE_INDEX_SHOWN = 12;

const SIGN: Record<TableIndexKind, string> = { add: "+", chg: "~", rem: "−" };

type Fold = "open" | "closed" | "mixed";

/** Every card in the report that folds: the table cards and the objects card. */
function foldingCards(report: HTMLElement): HTMLDetailsElement[] {
  return [...report.querySelectorAll<HTMLDetailsElement>(":scope > details.table-group")];
}

function foldOf(cards: HTMLDetailsElement[]): Fold {
  const open = cards.filter((card) => card.open).length;
  if (open === cards.length) return "open";
  return open === 0 ? "closed" : "mixed";
}

export function TableIndex({ title, groups }: { title: string; groups: TableIndexGroup[] }) {
  const ref = useRef<HTMLElement>(null);
  const titleId = useId();
  const [fold, setFold] = useState<Fold>("open");
  const [showAll, setShowAll] = useState<Partial<Record<TableIndexKind, boolean>>>({});
  const total = groups.reduce((n, group) => n + group.items.length, 0);

  // Which way the cards are folded right now, so the switch shows the truth
  // after the reader opens or closes a card by hand. `toggle` does not bubble,
  // so the report listens for it on the way down instead.
  useEffect(() => {
    const report = ref.current?.parentElement;
    if (!report) return;
    const read = () => {
      const cards = foldingCards(report);
      if (cards.length > 0) setFold(foldOf(cards));
    };
    read();
    report.addEventListener("toggle", read, true);
    return () => report.removeEventListener("toggle", read, true);
  });

  const foldAll = (open: boolean) => {
    const report = ref.current?.parentElement;
    if (!report) return;
    const cards = foldingCards(report);
    for (const card of cards) card.open = open;
    if (cards.length > 0) setFold(open ? "open" : "closed");
  };

  const jump = (key: string) => {
    const report = ref.current?.parentElement;
    if (!report) return;
    const card = [...report.querySelectorAll<HTMLElement>(":scope > [data-table-card]")].find(
      (element) => element.dataset.tableCard === key,
    );
    if (card) revealCard(card);
  };

  return (
    <nav className="ti" ref={ref} aria-labelledby={titleId}>
      <div className="ti__top">
        <span className="ti__title" id={titleId}>
          {title} <span className="ti__total">{total}</span>
        </span>
        <div className="ti-seg" role="group" aria-label="Fold the table cards" data-fold={fold}>
          <span className="ti-seg__thumb" aria-hidden="true" />
          <button
            type="button"
            className={`ti-seg__btn${fold === "open" ? " is-on" : ""}`}
            onClick={() => foldAll(true)}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="m7 15 5 5 5-5" />
              <path d="m7 9 5-5 5 5" />
            </svg>
            Expand all
          </button>
          <button
            type="button"
            className={`ti-seg__btn${fold === "closed" ? " is-on" : ""}`}
            onClick={() => foldAll(false)}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="m7 20 5-5 5 5" />
              <path d="m7 4 5 5 5-5" />
            </svg>
            Collapse all
          </button>
        </div>
      </div>

      <div className="ti__groups">
        {groups
          .filter((group) => group.items.length > 0)
          .map((group) => {
            const all = showAll[group.kind] === true;
            const hidden = group.items.length - TABLE_INDEX_SHOWN;
            const shown = all || hidden <= 0 ? group.items : group.items.slice(0, TABLE_INDEX_SHOWN);
            return (
              <div className={`ti-grp ti-grp--${group.kind}`} key={group.kind}>
                <span className="ti-grp__lab">
                  <i aria-hidden="true" />
                  {group.title}
                  <span className="ti-grp__n">{group.items.length}</span>
                </span>
                <ul className="ti-chips" aria-label={group.title}>
                  {shown.map((item, i) => (
                    <li key={item.key} style={{ "--i": Math.min(i, TABLE_INDEX_SHOWN) } as CSSProperties}>
                      <button
                        type="button"
                        className="ti-chip"
                        title={`Show ${item.label}`}
                        onClick={() => jump(item.key)}
                      >
                        <span className="ti-chip__sg" aria-hidden="true">
                          {SIGN[group.kind]}
                        </span>
                        <span className="ti-chip__name">{item.label}</span>
                      </button>
                    </li>
                  ))}
                  {hidden > 0 && (
                    <li>
                      <button
                        type="button"
                        className="ti-chip ti-chip--more"
                        aria-expanded={all}
                        onClick={() => setShowAll((previous) => ({ ...previous, [group.kind]: !all }))}
                      >
                        {all ? "Show fewer" : `+${hidden} more`}
                      </button>
                    </li>
                  )}
                </ul>
              </div>
            );
          })}
      </div>
    </nav>
  );
}
