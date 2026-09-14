"use client";

// ---------------------------------------------------------------------------
// CompareVersionTimeline — "Version timeline" under the Declared versions bar.
//
// The bar says which side is ahead. This lines up every version the two sides
// record, newest first, so that answer can be checked version by version, and
// each version's script can be read.
//
// A side whose version table is script_patch, compared through a saved
// connection, is loaded in full, scripts included, from
// GET /api/versionsync/ledger. That read waits until the disclosure is opened:
// most comparisons never open it, and a comparison should not cost another
// trip to each database for a panel nobody looked at. Every other side shows
// the entries the comparison already carried. lib/compare-timeline.ts holds
// the rules for which side is read which way.
// ---------------------------------------------------------------------------

import { useState, type ReactNode } from "react";
import type { DetectedVersion } from "@/lib/detected-version";
import type { NewerSchemaVerdict } from "@/lib/version-detection";
import type { LedgerEntry } from "@/lib/version-sync";
import { describeRecentSide, readsLedger, recentTimelineEntries } from "@/lib/compare-timeline";
import {
  ledgerTimelineEntries,
  mergeTimelines,
  outdatedSideFor,
  type TimelineEntry,
} from "@/lib/version-timeline";
import { NO_STORED_SCRIPT, VersionTimeline } from "@/components/studio/VersionTimeline";
import { ChevronDownIcon } from "@/components/ui/icons";

/** One side of the comparison, as the timeline needs it. */
export type CompareTimelineSide = {
  /** The column heading: "Source" or "Target", the bar's own words. */
  label: string;
  /** The schema's full name ("connection.schema"), for the sentences that name it. */
  name: string;
  detected: DetectedVersion | null;
  /** The saved connection it was compared through, or null when there is none. */
  connectionId: number | null;
  schema: string;
};

/** How far one side's ledger read has got. Null in state: not asked for yet. */
type LedgerLoad =
  | { kind: "loading" }
  | { kind: "ready"; hasLedger: boolean; entries: LedgerEntry[] }
  | { kind: "error"; message: string };

type Which = "left" | "right";
const BOTH: readonly Which[] = ["left", "right"];

/** One full stop at the end, whatever the server's message ended with. */
function sentence(text: string): string {
  const trimmed = text.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/** Reads one side's whole script_patch. Never throws: a failure comes back as words. */
async function fetchLedger(side: CompareTimelineSide): Promise<LedgerLoad> {
  const url =
    `/api/versionsync/ledger?connectionId=${encodeURIComponent(String(side.connectionId))}` +
    `&schema=${encodeURIComponent(side.schema)}`;
  try {
    const response = await fetch(url, { cache: "no-store" });
    const data = await response.json().catch(() => null);
    if (response.ok && data && Array.isArray(data.entries)) {
      return { kind: "ready", hasLedger: data.hasLedger === true, entries: data.entries as LedgerEntry[] };
    }
    const message =
      data && typeof data.error === "string" ? data.error : `The server answered with status ${response.status}.`;
    return { kind: "error", message };
  } catch {
    return { kind: "error", message: "The request did not reach the server." };
  }
}

/** What the timeline shows of one side, and the words that go with it. */
type SideView = {
  entries: TimelineEntry[];
  /** Only the newest few entries, so a version below them is "not known" rather than missing. */
  partial: boolean;
  /** Said above the table, or null when there is nothing to explain. */
  note: string | null;
  /** The script block's words for a version this side has without a script. */
  noScript: string;
  /** The ledger read failed, so the note offers Try again. */
  canRetry: boolean;
};

function viewOf(side: CompareTimelineSide, load: LedgerLoad | null): SideView {
  const { detected, connectionId, name } = side;

  // No version table: nothing to line up, so every version reads "not recorded".
  if (!detected || !detected.table) {
    return {
      entries: [],
      partial: false,
      note: describeRecentSide(name, detected, connectionId),
      noScript: NO_STORED_SCRIPT,
      canRetry: false,
    };
  }

  const ledgerSide = readsLedger(detected, connectionId);
  if (ledgerSide && load?.kind === "ready" && load.hasLedger) {
    // The whole table, and complete: script_patch holds only applied rows,
    // because a rollback moves its row out of the table.
    return {
      entries: ledgerTimelineEntries(load.entries),
      partial: false,
      note: null,
      // Rows written before script_patch stored its SQL have none.
      noScript: "No script was stored with this version.",
      canRetry: false,
    };
  }

  // Everything else shows the entries the comparison carried.
  const entries = recentTimelineEntries(detected);
  const partial = !detected.recentComplete;
  if (ledgerSide && load?.kind === "error") {
    return {
      entries,
      partial,
      note:
        `${name}'s script_patch history did not load. ${sentence(load.message)} Nothing was changed. ` +
        "Until it loads, the timeline shows only the entries the comparison read.",
      noScript: "The script_patch history did not load, so no script is shown.",
      canRetry: true,
    };
  }
  if (ledgerSide && load?.kind === "ready") {
    // The comparison found script_patch and the ledger read, a moment later,
    // did not: the table went away in between.
    return {
      entries,
      partial,
      note:
        `No script_patch table was found on ${name} when the timeline loaded, so it shows the entries ` +
        "the comparison read. Compare again to refresh the versions above.",
      noScript: "The script_patch table was not found, so no script is shown.",
      canRetry: false,
    };
  }
  return {
    entries,
    partial,
    note: describeRecentSide(name, detected, connectionId),
    noScript:
      detected.table === "script_patch"
        ? "Scripts load only for a schema compared through a saved connection."
        : NO_STORED_SCRIPT,
    canRetry: false,
  };
}

export function CompareVersionTimeline({
  left,
  right,
  verdict,
}: {
  left: CompareTimelineSide;
  right: CompareTimelineSide;
  /** The bar's verdict. The side it calls behind gets "(Outdated)" here too. */
  verdict: NewerSchemaVerdict | null;
}) {
  const [loads, setLoads] = useState<Record<Which, LedgerLoad | null>>({ left: null, right: null });
  const sides: Record<Which, CompareTimelineSide> = { left, right };
  const needsLedger = (which: Which) => readsLedger(sides[which].detected, sides[which].connectionId);

  function load(which: Which) {
    setLoads((current) => ({ ...current, [which]: { kind: "loading" } }));
    void fetchLedger(sides[which]).then((result) => {
      setLoads((current) => ({ ...current, [which]: result }));
    });
  }

  // Opening the disclosure starts each side's read, once. A read that failed
  // waits for Try again rather than repeating every time the panel opens.
  function onOpen() {
    for (const which of BOTH) {
      if (needsLedger(which) && loads[which] === null) load(which);
    }
  }

  // Not asked yet counts as loading: the panel is closed until then, and on
  // opening it the read starts in the same moment.
  const waiting = BOTH.filter((which) => {
    const state = loads[which];
    return needsLedger(which) && (state === null || state.kind === "loading");
  });

  let body: ReactNode;
  if (waiting.length > 0) {
    body = (
      <div className="vtl">
        <p className="vtl__note">
          {waiting.length === 2
            ? "Loading the script_patch history of both schemas…"
            : `Loading ${sides[waiting[0]].name}'s script_patch history…`}
        </p>
      </div>
    );
  } else {
    const views: Record<Which, SideView> = { left: viewOf(left, loads.left), right: viewOf(right, loads.right) };
    const rows = mergeTimelines(views.left.entries, views.right.entries, {
      leftPartial: views.left.partial,
      rightPartial: views.right.partial,
    });
    const noted = BOTH.filter((which) => views[which].note !== null);
    body = (
      <VersionTimeline
        leftLabel={left.label}
        rightLabel={right.label}
        rows={rows}
        outdatedSide={outdatedSideFor(verdict?.newer)}
        leftNoScript={views.left.noScript}
        rightNoScript={views.right.noScript}
        note={
          noted.length > 0
            ? noted.map((which) => (
                <p key={which}>
                  {views[which].note}
                  {views[which].canRetry && (
                    <>
                      {" "}
                      <button type="button" className="btn btn-ghost btn-sm" onClick={() => load(which)}>
                        Try again
                      </button>
                    </>
                  )}
                </p>
              ))
            : undefined
        }
      />
    );
  }

  return (
    <details
      className="verdet__more"
      onToggle={(event) => {
        if (event.currentTarget.open) onOpen();
      }}
    >
      <summary>
        <ChevronDownIcon className="chev" size={11} />
        Version timeline
      </summary>
      {body}
    </details>
  );
}
