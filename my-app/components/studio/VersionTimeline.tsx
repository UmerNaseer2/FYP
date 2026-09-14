"use client";

// ---------------------------------------------------------------------------
// VersionTimeline — two sides' versions on one axis.
//
// Compare (source against target), Version Sync (source against target) and
// Deploy (the GitHub registry against the database) all ask the same
// question: which versions does each side have, and where is each one now?
// This draws the answer the same way on all three. The screen builds the rows
// with mergeTimelines (lib/version-timeline.ts) and hands them over; this
// component only draws them. It fetches nothing and decides nothing.
//
// One row per version, newest first, grouped by script group:
// - a filled marker in the column of each side that records the version, an
//   empty one where it does not, and "?" where that side's list stops before
//   this version (so a gap is never a guess);
// - HEAD at each side's current version;
// - a coloured dot for the change level (breaking / additive / patch);
// - an optional status word per side, set by the screen (Deploy's Applied,
//   Pending, Skipped).
// Clicking a row opens the script that version ran, read-only.
// ---------------------------------------------------------------------------

import { Fragment, useId, useState, type ReactNode } from "react";
import type { ChangeLevel } from "@/lib/change-level";
import {
  displayVersion,
  scriptsMatch,
  timelineKey,
  type TimelineEntry,
  type TimelineRow,
  type TimelineStatus,
} from "@/lib/version-timeline";
import { ChevronRightIcon } from "@/components/ui/icons";

/** What the script block says for a side whose table keeps no scripts. */
export const NO_STORED_SCRIPT = "This version table does not store its scripts.";

type Side = "left" | "right";

export type VersionTimelineProps = {
  /** Each side's name, as the screen names it elsewhere ("Registry (GitHub)", "prod.public"). */
  leftLabel: string;
  rightLabel: string;
  /** From mergeTimelines. A screen may set leftStatus / rightStatus on each row first. */
  rows: TimelineRow[];
  /** The side the screen's verdict calls behind. Its column heading gets "(Outdated)". */
  outdatedSide: Side | null;
  /**
   * The versions the screen can roll back to (Deploy's Roll back panel offers
   * several). Each one's row gets a button that calls onRevert. Matched like
   * the rows are matched, so "v1.2.0" finds "1.2.0".
   */
  revertableVersions?: ReadonlyArray<string>;
  /** Only this script group's rows of revertableVersions. Leave it out when the rows hold one group. */
  revertableFamily?: string | null;
  onRevert?: (row: TimelineRow) => void;
  /** The revert button's words. */
  revertLabel?: string;
  /** What the script block says when this side stores no script for a version. */
  leftNoScript?: string;
  rightNoScript?: string;
  /** More buttons for a row, such as Deploy's Run buttons. Clicking them does not open the row. */
  renderActions?: (row: TimelineRow) => ReactNode;
  /** A line above the table: what the timeline does and does not show. */
  note?: ReactNode;
  /** Shown instead of the table when there are no rows. */
  emptyText?: string;
};

/** The dot's meaning, as a tooltip and as text for screen readers. */
const LEVEL_WORDS: Record<ChangeLevel, string> = {
  breaking: "Breaking change",
  additive: "Additive change",
  patch: "Patch",
  unknown: "Change level not recorded",
};

/** The pill each status tone uses. The pill classes are the app's own. */
const STATUS_PILL: Record<TimelineStatus["tone"], string> = {
  applied: "pill-sync",
  pending: "pill-pending",
  skipped: "pill-drift",
  "rolled-back": "pill-neutral",
  failed: "pill-break",
};

/**
 * Short, safe date. "" for a missing or unparseable timestamp rather than
 * "Invalid Date": a version table found in the wild can hold anything.
 */
function fmtDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/** A row's identity on screen. Two groups can hold the same version, so both parts count. */
function rowId(row: TimelineRow): string {
  return JSON.stringify([row.family, row.key]);
}

/** The script a side stored for a version, or null when it stored none. */
function storedSql(entry: TimelineEntry | null): string | null {
  return entry && entry.sqlContent && entry.sqlContent.trim() !== "" ? entry.sqlContent : null;
}

/** One column heading: the side's name, and "(Outdated)" when the verdict says it is behind. */
function SideHeading({ label, outdated }: { label: string; outdated: boolean }) {
  return (
    <th scope="col" className="vtl__sidehead">
      <span className="vtl__sidename">{label}</span>
      {outdated && (
        <>
          {" "}
          <span className="vtl__outdated">(Outdated)</span>
        </>
      )}
    </th>
  );
}

/** One side of one row: marker, HEAD, status word and date. */
function SideCell({ row, side, label }: { row: TimelineRow; side: Side; label: string }) {
  const entry = row[side];
  const unknown = side === "left" ? row.leftUnknown : row.rightUnknown;
  const head = side === "left" ? row.isLeftHead : row.isRightHead;
  const status = side === "left" ? row.leftStatus : row.rightStatus;

  // The same words go in the tooltip and, for screen readers, in the cell.
  let mark: string;
  let words: string;
  if (entry?.failed) {
    mark = "is-failed";
    words = `${label} records this version as a failed run`;
  } else if (entry) {
    mark = "is-on";
    words = `${label} records this version`;
  } else if (unknown) {
    mark = "is-unknown";
    words = `Not known: this is older than the entries read from ${label}`;
  } else {
    mark = "is-off";
    words = `${label} does not record this version`;
  }

  return (
    <td className="vtl__side">
      <span className="vtl__cell">
        <span className={`vtl__mark ${mark}`} title={words} aria-hidden="true">
          {mark === "is-unknown" ? "?" : null}
        </span>
        <span className="sr-only">{words}.</span>
        {head && (
          <span
            className="vtl__head"
            title={`${label}'s current version${row.family !== null ? " in this script group" : ""}`}
          >
            HEAD
          </span>
        )}
        {status && (
          <span className={`pill ${STATUS_PILL[status.tone]}`} title={status.title}>
            {status.text}
          </span>
        )}
        {entry?.appliedAt && <span className="vtl__when">{fmtDate(entry.appliedAt)}</span>}
      </span>
    </td>
  );
}

/** The read-only script for one row, from whichever side stored it. */
function ScriptBlock({
  row,
  leftLabel,
  rightLabel,
  leftNoScript,
  rightNoScript,
  shownSide,
  onShowSide,
}: {
  row: TimelineRow;
  leftLabel: string;
  rightLabel: string;
  leftNoScript: string;
  rightNoScript: string;
  shownSide: Side;
  onShowSide: (side: Side) => void;
}) {
  const leftSql = storedSql(row.left);
  const rightSql = storedSql(row.right);

  // Both sides stored a script and they differ: that is worth seeing, so the
  // reader can switch between the two.
  if (leftSql !== null && rightSql !== null && !scriptsMatch(leftSql, rightSql)) {
    return (
      <div className="vtl__script">
        <div className="vtl__scripthead">
          <span>The two sides stored different scripts for this version.</span>
          <span className="vtl__switch" role="group" aria-label="Whose script to show">
            <button type="button" aria-pressed={shownSide === "left"} onClick={() => onShowSide("left")}>
              {leftLabel}
            </button>
            <button type="button" aria-pressed={shownSide === "right"} onClick={() => onShowSide("right")}>
              {rightLabel}
            </button>
          </span>
        </div>
        <pre className="vtl__sql mono">{shownSide === "left" ? leftSql : rightSql}</pre>
      </div>
    );
  }

  if (leftSql !== null && rightSql !== null) {
    return (
      <div className="vtl__script">
        <p className="vtl__scripthead">The same script on both sides.</p>
        <pre className="vtl__sql mono">{leftSql}</pre>
      </div>
    );
  }

  // One side stored it. Say which, and why the other side shows nothing when
  // it has the version too.
  if (leftSql !== null || rightSql !== null) {
    const fromLeft = leftSql !== null;
    const other = fromLeft ? row.right : row.left;
    return (
      <div className="vtl__script">
        <p className="vtl__scripthead">Stored by {fromLeft ? leftLabel : rightLabel}.</p>
        {other && (
          <p className="vtl__scriptnote">
            {fromLeft ? rightLabel : leftLabel}: {fromLeft ? rightNoScript : leftNoScript}
          </p>
        )}
        <pre className="vtl__sql mono">{fromLeft ? leftSql : rightSql}</pre>
      </div>
    );
  }

  // Neither side stored it. One sentence when both give the same reason.
  const reasons: { label: string; text: string }[] = [];
  if (row.left) reasons.push({ label: leftLabel, text: leftNoScript });
  if (row.right) reasons.push({ label: rightLabel, text: rightNoScript });
  if (reasons.length === 2 && reasons[0].text !== reasons[1].text) {
    return (
      <div className="vtl__script">
        {reasons.map((reason) => (
          <p className="vtl__noscript" key={reason.label}>
            {reason.label}: {reason.text}
          </p>
        ))}
      </div>
    );
  }
  return (
    <div className="vtl__script">
      <p className="vtl__noscript">{reasons[0]?.text ?? NO_STORED_SCRIPT}</p>
    </div>
  );
}

export function VersionTimeline({
  leftLabel,
  rightLabel,
  rows,
  outdatedSide,
  revertableVersions = [],
  revertableFamily,
  onRevert,
  revertLabel = "Roll back to here…",
  leftNoScript = NO_STORED_SCRIPT,
  rightNoScript = NO_STORED_SCRIPT,
  renderActions,
  note,
  emptyText = "Neither side records a version.",
}: VersionTimelineProps) {
  const baseId = useId();
  // One row open at a time: the script is long, and two open scripts push
  // the rest of the timeline off the screen.
  const [openId, setOpenId] = useState<string | null>(null);
  // Which side's script shows when the two differ. Starts on the left each
  // time a row opens.
  const [shownSide, setShownSide] = useState<Side>("left");

  const revertKeys = new Set(revertableVersions.map(timelineKey));
  const canRevert = (row: TimelineRow) =>
    onRevert !== undefined &&
    revertKeys.has(row.key) &&
    (revertableFamily === undefined || row.family === revertableFamily);
  // The actions column appears only when some row has something in it.
  const hasActions = renderActions !== undefined || rows.some(canRevert);
  const columns = hasActions ? 4 : 3;

  // A heading per script group only when there are groups at all. A Flyway
  // table has none, and a "No script group" heading over every row is noise.
  const grouped = rows.some((row) => row.family !== null);
  const anyUnknown = rows.some((row) => row.leftUnknown || row.rightUnknown);
  const anyFailed = rows.some((row) => row.left?.failed || row.right?.failed);
  const anyHead = rows.some((row) => row.isLeftHead || row.isRightHead);
  const anyUngraded = rows.some((row) => row.changeType === "unknown");
  // The hint promises a script, so it shows only when at least one row has one.
  const anyScript = rows.some((row) => storedSql(row.left) !== null || storedSql(row.right) !== null);

  function toggle(row: TimelineRow) {
    const id = rowId(row);
    setOpenId((current) => (current === id ? null : id));
    setShownSide("left");
  }

  return (
    <div className="vtl">
      {note && <div className="vtl__note">{note}</div>}

      {rows.length === 0 ? (
        <p className="vtl__empty">{emptyText}</p>
      ) : (
        <>
          <div className="vtl__scroll">
            <table className="vtl__table">
              <thead>
                <tr>
                  <th scope="col">Version</th>
                  <SideHeading label={leftLabel} outdated={outdatedSide === "left"} />
                  <SideHeading label={rightLabel} outdated={outdatedSide === "right"} />
                  {hasActions && (
                    <th scope="col">
                      <span className="sr-only">Actions</span>
                    </th>
                  )}
                </tr>
              </thead>
              <tbody>
                {rows.map((row, index) => {
                  const id = rowId(row);
                  const open = openId === id;
                  const panelId = `${baseId}-script-${index}`;
                  const startsGroup = grouped && (index === 0 || rows[index - 1].family !== row.family);
                  const label = row.left?.label || row.right?.label || null;
                  return (
                    <Fragment key={id}>
                      {startsGroup && (
                        <tr className="vtl__group">
                          <th scope="colgroup" colSpan={columns}>
                            {row.family === null ? (
                              "No script group"
                            ) : (
                              <>
                                Script group{" "}
                                <span className="mono">{row.family}</span>
                              </>
                            )}
                          </th>
                        </tr>
                      )}
                      {/* The whole row opens the script. The button inside is
                          what a keyboard reaches; its click bubbles up to here. */}
                      <tr className={open ? "vtl__row is-open" : "vtl__row"} onClick={() => toggle(row)}>
                        <td className="vtl__vercell">
                          <button
                            type="button"
                            className="vtl__toggle"
                            aria-expanded={open}
                            aria-controls={open ? panelId : undefined}
                            title={open ? "Hide the script" : "Show the script"}
                          >
                            <ChevronRightIcon size={11} className="vtl__chev" />
                            <span
                              className={`vtl__dot lvl-${row.changeType}`}
                              title={LEVEL_WORDS[row.changeType]}
                              aria-hidden="true"
                            />
                            <span className="vtl__ver">{displayVersion(row.version, row.family !== null)}</span>
                            <span className="sr-only">, {LEVEL_WORDS[row.changeType]}</span>
                            {label && <span className="vtl__label">{label}</span>}
                          </button>
                        </td>
                        <SideCell row={row} side="left" label={leftLabel} />
                        <SideCell row={row} side="right" label={rightLabel} />
                        {hasActions && (
                          // A Run or Roll back button does its own thing; it
                          // must not also open the row it sits in.
                          <td className="vtl__actions" onClick={(event) => event.stopPropagation()}>
                            {renderActions?.(row)}
                            {canRevert(row) && (
                              <button type="button" className="btn btn-ghost btn-sm" onClick={() => onRevert?.(row)}>
                                {revertLabel}
                              </button>
                            )}
                          </td>
                        )}
                      </tr>
                      {open && (
                        <tr className="vtl__scriptrow">
                          <td colSpan={columns} id={panelId}>
                            <ScriptBlock
                              row={row}
                              leftLabel={leftLabel}
                              rightLabel={rightLabel}
                              leftNoScript={leftNoScript}
                              rightNoScript={rightNoScript}
                              shownSide={shownSide}
                              onShowSide={setShownSide}
                            />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="vtl__legend">
            <span>
              <span className="vtl__mark is-on" aria-hidden="true" /> recorded
            </span>
            <span>
              <span className="vtl__mark is-off" aria-hidden="true" /> not recorded
            </span>
            {anyUnknown && (
              <span>
                <span className="vtl__mark is-unknown" aria-hidden="true">
                  ?
                </span>{" "}
                older than the entries read from that side
              </span>
            )}
            {anyFailed && (
              <span>
                <span className="vtl__mark is-failed" aria-hidden="true" /> failed run
              </span>
            )}
            {anyHead && (
              <span>
                <span className="vtl__head">HEAD</span>{" "}
                {grouped ? "current version in its script group" : "current version"}
              </span>
            )}
            <span>
              <span className="vtl__dot lvl-breaking" aria-hidden="true" /> breaking
            </span>
            <span>
              <span className="vtl__dot lvl-additive" aria-hidden="true" /> additive
            </span>
            <span>
              <span className="vtl__dot lvl-patch" aria-hidden="true" /> patch
            </span>
            {anyUngraded && (
              <span>
                <span className="vtl__dot lvl-unknown" aria-hidden="true" /> level not recorded
              </span>
            )}
            {anyScript && <span className="vtl__hint">Click a version to see its script.</span>}
          </div>
        </>
      )}
    </div>
  );
}
