"use client";

import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import dynamic from "next/dynamic";
import Link from "next/link";
import { Skeleton } from "@/components/ui";
import { ExpandIcon, SchemaMapIcon, XIcon } from "@/components/ui/icons";
import { comesWithNewObject, type CompareReport } from "@/lib/compare";
import { countOf, plural } from "@/lib/plural";
import type { DiffStatus } from "@/components/studio/visualizer/diff-graph";

// The Compare page's map of changes: the Visualizer, drawing what the script
// does to the target's tables. It sits between the four tiles and the list,
// answers to the same tile filter, and pressing a table scrolls the list to
// that table's card. Only tables are drawn; views, functions and the like stay
// in the list, and the note under the map says how many there are.

const DiffFlow = dynamic(() => import("@/components/studio/visualizer/DiffFlow"), {
  ssr: false,
  loading: () => (
    <div className="cp-map__loading">
      <Skeleton width="60%" height={10} radius={999} />
      <Skeleton width="40%" height={10} radius={999} />
    </div>
  ),
});

/** More unchanged tables than this and the map starts with only the changed ones. */
const BUSY = 12;
const ONLY_KEY = "schema-studio:compare-map-only-changed";
const HIDDEN_KEY = "schema-studio:compare-map-hidden";

function readFlag(key: string): boolean | null {
  try {
    const value = window.localStorage.getItem(key);
    return value === null ? null : value === "1";
  } catch {
    return null;
  }
}

function writeFlag(key: string, value: boolean): void {
  try {
    window.localStorage.setItem(key, value ? "1" : "0");
  } catch {
    /* private window or blocked storage: the choice lasts this visit only */
  }
}

function usePhone(): boolean {
  const [phone, setPhone] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 720px)");
    const apply = () => setPhone(mq.matches);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);
  return phone;
}

export type ChangeMapProps = {
  report: CompareReport;
  /** The tile pressed above, if any. */
  filter: DiffStatus | null;
  /** Show the card of the table with this node id in the list below. */
  onJump: (nodeId: string) => void;
  /** Opens both schemas side by side in the Visualizer. Null when either side has no saved connection. */
  visualizerHref: string | null;
};

export function ChangeMap({ report, filter, onJump, visualizerHref }: ChangeMapProps) {
  const titleId = useId();
  const bodyId = useId();
  const phone = usePhone();

  const counts = {
    add: report.tablesOnlyInA.length,
    chg: report.matchedTables.filter((m) => m.hasChanges).length,
    rem: report.tablesOnlyInB.length,
    same: report.matchedTables.filter((m) => !m.hasChanges).length,
  };
  const changed = counts.add + counts.chg + counts.rem;
  // Changes to things that are not tables, and not part of a new table either.
  const elsewhere = report.objectDiffs.filter(
    (diff) => diff.table === undefined && !comesWithNewObject(diff),
  ).length;

  // The map only ever draws in the browser (a comparison runs there, never on
  // the server), so the saved choices can be read straight away.
  const [onlyChanged, setOnlyChanged] = useState(() => {
    const saved = changed > 0 ? readFlag(ONLY_KEY) : null;
    return saved ?? (counts.same > BUSY && changed > 0);
  });
  const [hidden, setHidden] = useState(() => readFlag(HIDDEN_KEY) ?? false);

  const [full, setFull] = useState(false);
  const openRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  function closeFull() {
    setFull(false);
    requestAnimationFrame(() => openRef.current?.focus());
  }

  function jumpFromFull(nodeId: string) {
    setFull(false);
    // After the overlay is gone, or the scroll lands under it.
    requestAnimationFrame(() => onJump(nodeId));
  }

  // Full screen is a dialog: Esc closes it, Tab stays inside it, the page
  // behind does not scroll, and focus goes to Close and comes back to the
  // button that opened it.
  useEffect(() => {
    if (!full) return;
    const before = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setFull(false);
        requestAnimationFrame(() => openRef.current?.focus());
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const items = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      );
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = before;
      window.removeEventListener("keydown", onKey);
    };
  }, [full]);

  if (counts.add + counts.chg + counts.rem + counts.same === 0) return null;

  const legend = (
    <div className="cp-map__legend" aria-label="Tables on the map">
      <span className={`cp-map__pill${counts.add ? " is-add" : ""}`}>
        + {counts.add} {phone ? "new" : plural(counts.add, "new table", "new tables")}
      </span>
      <span className={`cp-map__pill${counts.chg ? " is-chg" : ""}`}>
        ~ {counts.chg} {phone ? "changed" : plural(counts.chg, "changed table", "changed tables")}
      </span>
      <span className={`cp-map__pill${counts.rem ? " is-rem" : ""}`}>
        − {counts.rem} {phone ? "dropped" : plural(counts.rem, "dropped table", "dropped tables")}
      </span>
    </div>
  );

  const flowProps = { report, filter, onlyChanged };

  return (
    <section className="cp-map" aria-labelledby={titleId} data-tour="compare-map">
      <header className="cp-map__head">
        <h3 id={titleId} className="cp-map__title">
          Map of changes
        </h3>
        {legend}
        <span className="cp-map__spacer" />
        {counts.same > 0 && changed > 0 && !hidden && (
          <label className="cp-map__check">
            <input
              type="checkbox"
              checked={onlyChanged}
              onChange={(event) => {
                setOnlyChanged(event.target.checked);
                writeFlag(ONLY_KEY, event.target.checked);
              }}
            />
            Only tables with changes
          </label>
        )}
        {visualizerHref && !phone && (
          <Link href={visualizerHref} className="btn btn-ghost btn-sm cp-map__btn">
            <SchemaMapIcon size={14} />
            Open in Visualizer
          </Link>
        )}
        {!hidden && changed > 0 && (
          <button
            ref={openRef}
            type="button"
            className="btn btn-ghost btn-sm cp-map__btn"
            onClick={() => setFull(true)}
          >
            <ExpandIcon size={14} />
            Full screen
          </button>
        )}
        <button
          type="button"
          className="btn btn-ghost btn-sm cp-map__btn"
          aria-expanded={!hidden}
          aria-controls={bodyId}
          onClick={() => {
            setHidden((was) => {
              writeFlag(HIDDEN_KEY, !was);
              return !was;
            });
          }}
        >
          {hidden ? "Show map" : "Hide map"}
        </button>
      </header>

      <div id={bodyId} hidden={hidden}>
        {changed === 0 ? (
          <p className="cp-map__empty">
            Every table matches on both sides, so there is nothing to draw.
          </p>
        ) : full ? (
          // One canvas at a time: the full screen one is drawing.
          <p className="cp-map__empty">The map is open in full screen.</p>
        ) : (
          !hidden && (
            <div className={phone ? "cp-map__body cp-map__body--strip" : "cp-map__body"}>
              <DiffFlow
                key={onlyChanged ? "changed" : "all"}
                {...flowProps}
                full={false}
                compact={phone}
                onJump={onJump}
              />
            </div>
          )
        )}
        {elsewhere > 0 && changed > 0 && (
          <p className="cp-map__note">
            The map draws tables only.{" "}
            {countOf(elsewhere, "change")} to views, functions and other objects{" "}
            {elsewhere === 1 ? "is" : "are"} in the list below.
          </p>
        )}
      </div>

      {full &&
        createPortal(
          <div
            ref={dialogRef}
            className="cp-mapfull"
            role="dialog"
            aria-modal="true"
            aria-labelledby={`${titleId}-full`}
          >
            <div className="cp-mapfull__box">
              <header className="cp-map__head">
                <h2 id={`${titleId}-full`} className="cp-map__title">
                  Map of changes
                </h2>
                {legend}
                <span className="cp-map__spacer" />
                <button
                  ref={closeRef}
                  type="button"
                  className="btn btn-primary btn-sm cp-map__btn"
                  onClick={closeFull}
                >
                  <XIcon size={14} />
                  Close <span className="cp-map__kbd">Esc</span>
                </button>
              </header>
              <div className="cp-mapfull__body">
                <DiffFlow
                  key={onlyChanged ? "changed" : "all"}
                  {...flowProps}
                  full
                  compact={phone}
                  onJump={jumpFromFull}
                />
              </div>
            </div>
          </div>,
          document.body,
        )}
    </section>
  );
}
