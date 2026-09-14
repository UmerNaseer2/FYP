"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui";
import { CheckIcon, ClipboardIcon } from "@/components/ui/icons";
import { useUser } from "@/hooks/useUser";
import { roleAtLeast } from "@/lib/auth-mode";
import { saveMigrationDraft } from "@/lib/migration-draft";
import {
  buildFixScript,
  changesWithoutUndo,
  fixScriptFileName,
  type FixScriptItem,
} from "@/lib/perf-sql";
import { downloadText } from "./ExportBar";

/**
 * "Put these fixes in one script", under the findings on both Performance
 * tabs (PerfAdviceList and QueryAnalyzer).
 *
 * Lists every schema change and maintenance fix with a tick, all ticked to
 * start with, and hands the ticked ones over three ways:
 *
 *   Copy as one script / Download .sql   everything ticked, as one file with a
 *                                        header (buildFixScript in lib/perf-sql.ts)
 *   Save as a migration                  the schema changes only, with their
 *                                        rollback, into the Script Editor, where
 *                                        the usual version and save flow takes over
 *
 * Query rewrites and decisions are not listed: a rewrite changes the query,
 * not the database, and a decision needs a person to choose first.
 *
 * Save hides for viewers. The Script Editor saves through /api/github/push,
 * which needs the editor role, so offering it to a viewer would only lead to
 * a refusal at the end.
 */

/** Where the findings came from: printed at the top of the script, and kept with a saved migration. */
export type FixScriptTarget = {
  /** The saved connection's id, as text, the way the pickers hold it. */
  connectionId: string;
  connectionName: string;
  database: string;
  schema: string;
};

/** Unticked rows, as positions in the list, remembered with the list they belong to. */
type Unticked = { items: FixScriptItem[]; positions: Set<number> };

/** The last thing a button did that the screen should mention, with the list it was for. */
type Notice = { items: FixScriptItem[]; kind: "copied" | "copy-failed" | "save-failed" };

const NONE = new Set<number>();

export function FixScriptBuilder({
  items,
  target,
}: {
  items: FixScriptItem[];
  target: FixScriptTarget;
}) {
  const router = useRouter();
  const { role, loading } = useUser();
  const canSave = !loading && roleAtLeast(role, "editor");

  const [unticked, setUnticked] = useState<Unticked>({ items, positions: NONE });
  const [notice, setNotice] = useState<Notice | null>(null);

  // A new list of findings (the query analysed again, another schema, Run
  // again) starts with everything ticked. Derived rather than reset in an
  // effect: the unticks were kept with the list they were made on, and stop
  // counting the moment the screen shows a different one.
  const off = unticked.items === items ? unticked.positions : NONE;
  const shownNotice = notice !== null && notice.items === items ? notice.kind : null;

  const listed = items.filter((item) => item.fixKind === "change" || item.fixKind === "maintenance");
  if (listed.length === 0) return null;

  const rows = listed.map((item, position) => ({ item, position }));
  const changeRows = rows.filter((row) => row.item.fixKind === "change");
  const maintenanceRows = rows.filter((row) => row.item.fixKind === "maintenance");
  const ticked = listed.filter((_, position) => !off.has(position));
  const tickedChanges = ticked.filter((item) => item.fixKind === "change");
  const tickedMaintenance = ticked.length - tickedChanges.length;
  const notListed = items.length - listed.length;
  // Worked out exactly as the script's rollback is, so this note and what
  // Save puts in the Script Editor always agree.
  const withoutUndo = changesWithoutUndo(tickedChanges);

  function toggle(position: number) {
    const next = new Set(off);
    if (next.has(position)) next.delete(position);
    else next.add(position);
    setUnticked({ items, positions: next });
  }

  // Built only when a button is pressed: the header carries the time, and a
  // render must not read the clock.
  function build(date: Date) {
    return buildFixScript({
      connectionName: target.connectionName,
      database: target.database,
      schema: target.schema,
      date,
      items: ticked,
    });
  }

  async function copyScript() {
    try {
      await navigator.clipboard.writeText(build(new Date()).script);
      setNotice({ items, kind: "copied" });
      setTimeout(() => setNotice((now) => (now?.kind === "copied" ? null : now)), 1500);
    } catch {
      // Refused, e.g. on a page not served over HTTPS. Download needs no permission.
      setNotice({ items, kind: "copy-failed" });
    }
  }

  function downloadScript() {
    const date = new Date();
    downloadText(
      fixScriptFileName(target.database, target.schema, date),
      build(date).script,
      "application/sql"
    );
  }

  function saveAsMigration() {
    const date = new Date();
    const built = build(date);
    if (built.changes === "") return;
    const saved = saveMigrationDraft({
      sql: built.changes,
      rollbackSql: built.rollback,
      description: built.description,
      connectionId: target.connectionId,
      schema: target.schema,
      createdAt: date.toISOString(),
    });
    if (saved) router.push("/script-editor");
    else setNotice({ items, kind: "save-failed" });
  }

  const n = withoutUndo.length;
  let saveNote: string | null = null;
  if (canSave && tickedChanges.length === 0 && tickedMaintenance > 0) {
    saveNote = "Only schema changes go in a migration. Run maintenance by hand: copy or download it.";
  } else if (canSave && tickedChanges.length > 0) {
    saveNote =
      n === 0
        ? "Saving fills in the rollback too: the statements that undo each change, last change first."
        : `Saving leaves the rollback empty, because ${
            n === 1 ? "this change has" : "these changes have"
          } no statement that undoes ${n === 1 ? "it" : "them"}: ${withoutUndo.join("; ")}. ` +
          `Untick ${n === 1 ? "it" : "them"}, or in the Script Editor write the rollback ` +
          "yourself or tick Save without a rollback.";
    if (tickedMaintenance > 0) {
      saveNote +=
        " Maintenance stays out of the migration: it tidies this one server rather than " +
        "changing the schema. Run it by hand from the copied or downloaded script.";
    }
  }

  return (
    <Card className="p-4 space-y-3">
      <div>
        <div className="section-title">Put these fixes in one script</div>
        <p className="text-[12.5px] mt-1 leading-[1.55]" style={{ color: "var(--text-2)" }}>
          Every schema change and maintenance fix from this analysis starts ticked, including
          any the severity filter hides. Untick any you do not want, then copy them as one
          script or download them as a .sql file
          {canSave
            ? ". Or save the schema changes as a migration: the Script Editor opens and offers to load them, ready to version and save."
            : "."}
        </p>
      </div>

      <FixGroup
        heading={`Schema changes (${changeRows.length}) · save them as a migration`}
        rows={changeRows}
        off={off}
        onToggle={toggle}
      />
      <FixGroup
        heading={`Maintenance (${maintenanceRows.length}) · run it by hand`}
        rows={maintenanceRows}
        off={off}
        onToggle={toggle}
      />

      {notListed > 0 && (
        <p className="text-[11.5px]" style={{ color: "var(--text-3)" }}>
          Query rewrites and decisions are not listed. They stay on their cards: a rewrite
          changes your query, not the database, and a decision needs your choice first.
        </p>
      )}

      <div className="flex items-center gap-2 flex-wrap">
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={copyScript}
          disabled={ticked.length === 0}
          title={ticked.length === 0 ? "Tick at least one fix." : undefined}
        >
          {shownNotice === "copied" ? <CheckIcon size={12} /> : <ClipboardIcon size={12} />}
          {shownNotice === "copied" ? "Copied" : "Copy as one script"}
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={downloadScript}
          disabled={ticked.length === 0}
          title={ticked.length === 0 ? "Tick at least one fix." : undefined}
        >
          Download .sql
        </button>
        {canSave && (
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={saveAsMigration}
            disabled={tickedChanges.length === 0}
            title={
              tickedChanges.length === 0
                ? "Tick at least one schema change. Only schema changes go in a migration."
                : undefined
            }
          >
            Save as a migration
          </button>
        )}
      </div>

      {shownNotice === "copy-failed" && (
        <p className="text-[12px]" style={{ color: "var(--break)" }}>
          Your browser blocked the clipboard. Use Download .sql instead.
        </p>
      )}
      {shownNotice === "save-failed" && (
        <p className="text-[12px]" style={{ color: "var(--break)" }}>
          Your browser is blocking site storage, so this page cannot hand the script to the
          Script Editor. Copy or download it instead and paste the schema changes into the
          Script Editor. Each change&apos;s undo is under its fix above, for the rollback box.
        </p>
      )}
      {saveNote && (
        <p className="text-[11.5px] leading-[1.55]" style={{ color: "var(--text-3)" }}>
          {saveNote}
        </p>
      )}
      {!loading && !canSave && (
        <p className="text-[11.5px]" style={{ color: "var(--text-3)" }}>
          Saving as a migration needs the editor role.
        </p>
      )}
    </Card>
  );
}

/** One group of ticks under its heading; nothing when the group is empty. */
function FixGroup({
  heading,
  rows,
  off,
  onToggle,
}: {
  heading: string;
  rows: { item: FixScriptItem; position: number }[];
  off: Set<number>;
  onToggle: (position: number) => void;
}) {
  if (rows.length === 0) return null;
  return (
    <div role="group" aria-label={heading} className="space-y-1.5">
      <div className="text-[11.5px] font-semibold" style={{ color: "var(--text-2)" }}>
        {heading}
      </div>
      {rows.map(({ item, position }) => (
        <label
          key={position}
          className="flex items-start gap-2 text-[12.5px]"
          style={{ color: "var(--text-2)", cursor: "pointer" }}
        >
          <input
            type="checkbox"
            checked={!off.has(position)}
            onChange={() => onToggle(position)}
            style={{ marginTop: 3 }}
          />
          <span className="min-w-0">
            <span style={{ color: "var(--text)" }}>{item.title}</span>{" "}
            <span className="mono text-[11.5px] break-all" style={{ color: "var(--text-3)" }}>
              {item.object}
            </span>
          </span>
        </label>
      ))}
    </div>
  );
}
