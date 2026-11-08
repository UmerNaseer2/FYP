// Explain drift as the screen gets it. No imports that reach a database or
// the AI service, so the drift page can use the types and the shape checks.

import { buildDiffDocument } from "../../compare-export";
import type { CompareReport } from "../../compare-types";
import { isStringArray, isSummaryItem, type SummaryItem } from "./compare-summary-view";

export type DriftChoice = "adopt" | "revert" | "either";

export type DriftExplainAnswer = {
  /** One sentence: what changed on the live database. */
  headline: string;
  /**
   * What changed, most serious first. Each item cites change ids such as
   * "C3", and its affects name objects in the baseline or live.
   */
  items: SummaryItem[];
  /** A guess at how it happened, never naming a person. May be empty. */
  likelyCause: string;
  /** The AI's suggestion only. Nothing acts on it. */
  recommendation: { choice: DriftChoice; why: string };
  /** What a person has to do by hand for the changes no statement can make. */
  manualNotes: {
    changes: string[];
    note: string;
    /** True when the app wrote the note: the AI's answer left these changes out. */
    fromApp?: boolean;
  }[];
};

/** One of the two scripts the app writes for a drift. The AI writes none of it. */
export type DriftScript = {
  sql: string;
  rollbackSql: string | null;
  /** The Script Editor's description line. */
  description: string;
  /** Every statement in the script, held back and manual ones included. */
  statements: number;
  /** The statements that run as written. Zero means there is nothing to save as a draft. */
  runs: number;
  /** Drops written but commented out. */
  heldBack: number;
  /** Changes the app could not write SQL for. */
  manual: number;
};

export type DriftScripts = { revert: DriftScript; adopt: DriftScript };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isDriftExplainAnswer(value: unknown): value is DriftExplainAnswer {
  if (!isObject(value)) return false;
  const { headline, items, likelyCause, recommendation, manualNotes } = value;
  return (
    typeof headline === "string" &&
    typeof likelyCause === "string" &&
    isObject(recommendation) &&
    typeof recommendation.choice === "string" &&
    typeof recommendation.why === "string" &&
    Array.isArray(items) &&
    items.every(isSummaryItem) &&
    Array.isArray(manualNotes) &&
    manualNotes.every((note) => isObject(note) && typeof note.note === "string" && isStringArray(note.changes))
  );
}

function isDriftScript(value: unknown): value is DriftScript {
  return (
    isObject(value) &&
    typeof value.sql === "string" &&
    (value.rollbackSql === null || typeof value.rollbackSql === "string") &&
    typeof value.description === "string" &&
    typeof value.statements === "number" &&
    typeof value.runs === "number" &&
    typeof value.heldBack === "number" &&
    typeof value.manual === "number"
  );
}

export function isDriftScripts(value: unknown): value is DriftScripts {
  return isObject(value) && isDriftScript(value.revert) && isDriftScript(value.adopt);
}

/**
 * What the drift panel's answer is about, as one string: the schema, the
 * baseline, and every difference found. The panel clears its answer (and the
 * scripts that came with it) when this changes.
 *
 * The drift summary is not enough for this: it holds only counts, so a
 * re-check that finds different drift with the same counts (one column
 * dropped and another added) would keep explaining, and offering scripts
 * for, the old drift. buildDiffDocument (lib/compare-export.ts) is the one
 * list of changes the screen shows, and it is safe in the browser.
 */
export function driftExplainKey(
  trackedSchemaId: number,
  report: CompareReport | null,
  baselineSnapshotId: number | null = null
): string {
  const changes = report
    ? buildDiffDocument(report).changes.map((row) =>
        [row.category, row.table, row.object, row.change, row.detail].join("|")
      )
    : [];
  // Sorted, so the same drift read in another order is the same key.
  changes.sort();
  return [String(trackedSchemaId), String(baselineSnapshotId ?? "none"), ...changes].join("\n");
}
