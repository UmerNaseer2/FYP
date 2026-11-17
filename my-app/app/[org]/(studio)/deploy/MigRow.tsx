"use client";

// One migration row and its right-hand status cell. The pending list on
// Pre-flight and the run list on the Run step both draw their rows with it.

import type { ReactNode } from "react";
import { CheckIcon, XIcon, AlertTriangleIcon, ChevronDownIcon } from "@/components/ui/icons";
import { countOf } from "@/lib/ui/plural";
import { ChangeLevelPill } from "@/components/studio/ChangeLevelPill";
import type { ChangeKind, RunCell } from "./types";
import { getSqlLineCount, fmtStatements } from "./helpers";

// The right-hand status cell of a migration row.
export function RightStatus({ cell }: { cell: RunCell }) {
  if (cell.status === "running") {
    return (
      <span className="dp-stat">
        <span className="spin" />
        running…
      </span>
    );
  }
  if (cell.status === "applied" || cell.status === "rehearsed") {
    return (
      <span className="dp-stat dp-good">
        <span className="dp-stat-i">
          <CheckIcon size={11} />
        </span>
        {cell.status}
        {cell.statements !== undefined ? ` · ${fmtStatements(cell.statements)}` : ""}
      </span>
    );
  }
  if (cell.status === "failed") {
    return (
      <span className="dp-stat dp-bad">
        <span className="dp-stat-i">
          <XIcon size={11} />
        </span>
        failed
      </span>
    );
  }
  if (cell.status === "skipped") {
    return (
      <span className="dp-stat">
        <span className="dp-stat-i">
          <XIcon size={11} />
        </span>
        skipped
      </span>
    );
  }
  if (cell.status === "unknown") {
    return (
      <span className="dp-stat dp-unsure">
        <span className="dp-stat-i">
          <AlertTriangleIcon size={11} />
        </span>
        not known
      </span>
    );
  }
  if (cell.status === "not-in-run") {
    return <span className="dp-stat">not in this run</span>;
  }
  // queued, waiting to run is not a warning, so it gets a dot, not an alert.
  return (
    <span className="dp-stat">
      <span className="dp-dot" />
      queued
    </span>
  );
}

// One migration row, shared by the pending list (stage 1) and run list (stage 2/3).
export function MigRow({
  seq,
  toggle,
  name,
  kind,
  sub,
  rightPill,
  cell,
  selected,
  sql,
  sqlOpen,
  notes,
  action,
}: {
  seq: string;
  /**
   * Makes the sequence circle a tick box (spec 11.5, select or deselect which
   * pending scripts to run). Absent on the run and rollback lists, where the
   * batch is already fixed and a box that changed nothing would be a lie.
   */
  toggle?: { checked: boolean; onChange: (checked: boolean) => void; label: string; disabled?: boolean };
  name: string;
  kind: ChangeKind;
  sub: string;
  rightPill: string;
  cell: RunCell;
  selected?: boolean;
  /**
   * The statements this row will run. When given, the row opens to show them.
   *
   * The checklist beside this list warns about breaking migrations. A warning
   * about text nobody can read is not much help, so the text is here.
   */
  sql?: string;
  /** Start expanded. Used for the breaking ones, which are the point. */
  sqlOpen?: boolean;
  /**
   * Short sentences under the row: why it counts as breaking when its label
   * says less, a version step that disagrees with its level, and whether a
   * rollback will be saved with it. `warn` colours the ones worth acting on.
   */
  notes?: { text: string; warn: boolean }[];
  /** A control under the notes. The pending list puts its "Run …" button here. */
  action?: ReactNode;
}) {
  const cls = ["dp-mig-row", cell.status, selected ? "selected" : ""]
    .filter(Boolean)
    .join(" ");
  return (
    <div className="dp-mig">
      <div className={cls}>
        {toggle ? (
          // The number stays visible beside the box: it is the run order, and
          // the order is the reason a middle version cannot be dropped.
          <label className="dp-seq" title={toggle.label}>
            <input
              type="checkbox"
              checked={toggle.checked}
              disabled={toggle.disabled}
              aria-label={toggle.label}
              onChange={(e) => toggle.onChange(e.target.checked)}
            />
            {toggle.checked ? <CheckIcon size={13} /> : seq}
          </label>
        ) : (
          <div className="dp-seq">{seq}</div>
        )}
        <div className="dp-mig-text">
          <div className="dp-mig-title">
            <span className="dp-mig-name">{name}</span>
            <ChangeLevelPill level={kind} />
          </div>
          <div className="dp-mig-sub">{sub}</div>
          {notes?.map((note, index) => (
            <div key={index} className={note.warn ? "dp-mig-note dp-warn" : "dp-mig-note"}>
              {note.text}
            </div>
          ))}
          {action && <div className="dp-mig-act">{action}</div>}
        </div>
        <span className="pill pill-outline mono">{rightPill}</span>
        <RightStatus cell={cell} />
      </div>
      {cell.error && <pre className="dp-err">{cell.error}</pre>}
      {sql && (
        <details className="dp-sql" open={sqlOpen}>
          <summary>
            <ChevronDownIcon size={12} />
            <span>SQL</span>
            <span className="mono">{countOf(getSqlLineCount(sql), "line")}</span>
          </summary>
          <pre>{sql.trim()}</pre>
        </details>
      )}
    </div>
  );
}
