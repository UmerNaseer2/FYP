// The Compare screen's version rules: how each side's versions become the
// TimelineEntry lists that mergeTimelines lines up, and the warning the push
// button shows when pushing would take the target back.
//
// A side is read in one of two ways:
// - Its version table is script_patch and it was compared through a saved
//   connection: the whole ledger, with each version's SQL, from
//   GET /api/versionsync/ledger (ledgerTimelineEntries in version-timeline.ts
//   turns those rows into entries). That list is complete, because
//   script_patch holds only applied rows (a rollback moves its row out of the
//   table).
// - Any other version table, through a saved connection: its whole history,
//   without SQL, from GET /api/compare/version-history. Those tables do not
//   store the SQL they applied, so there is none to show — but the history
//   itself is as complete as script_patch's.
// - Anything else: the few entries the comparison already carried
//   (DetectedVersion.recent). Partial unless recentComplete says otherwise.
//
// Pure on purpose: no fetch and no React, so the rules are tested without a
// browser. Every type import from a module that opens connections is
// type-only, so nothing server-side reaches the browser bundle.
import type { DetectedVersion } from "./detected-version";
import { countOf } from "./plural";
import type { NewerSchemaVerdict } from "./version-detection";
import {
  compareFamilyHeads,
  displayVersion,
  familyGaps,
  familyHeadRows,
  hasFamilyHeads,
  listNames,
  pushMovesTargetBack,
  type TimelineEntry,
} from "./version-timeline";

/**
 * True when a side's full history, with its scripts, can be loaded from the
 * ledger route. The route reads a table called exactly script_patch through a
 * saved connection, so both must be true.
 */
export function readsLedger(detected: DetectedVersion | null, connectionId: number | null): boolean {
  return detected?.table === "script_patch" && connectionId !== null;
}

/**
 * True when a side's whole history can be loaded from the version-history
 * route: it keeps its versions somewhere other than script_patch (which has
 * its own route, with the scripts), it was compared through a saved
 * connection, and the comparison did not already carry every row.
 *
 * That last test is why this is not simply "not a ledger side". A schema with
 * three migrations has its whole history on screen already; asking the server
 * for it again would cost the target a read to be told what we knew.
 */
export function readsHistory(detected: DetectedVersion | null, connectionId: number | null): boolean {
  if (!detected || !detected.table || connectionId === null) return false;
  if (detected.table === "script_patch") return false;
  return !detected.recentComplete;
}

/** The entries the comparison carried for a side, as timeline entries. */
export function recentTimelineEntries(detected: DetectedVersion): TimelineEntry[] {
  // Without script groups the detector has already picked the entry the bar
  // prints as this side's version. Marking it makes the timeline's HEAD that
  // same entry. With groups, each group's head is its highest version that did
  // not fail, which is the rule mergeTimelines applies when nothing is marked
  // and the rule the detector's family heads were read with.
  const groups = hasFamilyHeads(detected.familyHeads);
  return detected.recent.map((entry) => ({
    scriptName: entry.scriptName,
    // A row with no version is still an entry the table recorded. Its label
    // (a Liquibase changeset id, say) is the only name it has.
    version: entry.version ?? entry.label,
    appliedAt: entry.appliedAt,
    changeType: entry.changeLevel,
    sqlContent: null,
    // Never the same text twice on one row: not the version again, and not the
    // script group, which is already the heading.
    label:
      entry.version === null || entry.label === entry.version || entry.label === entry.scriptName
        ? null
        : entry.label,
    failed: entry.succeeded === false,
    isHead: !groups && entry.current,
  }));
}

/**
 * The line that says what the timeline shows of a side that is NOT loaded
 * from the ledger, or null for a side that is (it has nothing to explain).
 */
export function describeRecentSide(
  label: string,
  detected: DetectedVersion | null,
  connectionId: number | null
): string | null {
  if (!detected || !detected.table) {
    return `No versions were read from ${label}, so every version below shows as not recorded there.`;
  }
  if (readsLedger(detected, connectionId)) return null;

  const count = detected.recent.length;
  // "Everything it holds" only when recentComplete says nothing older was left out.
  let shown: string;
  if (!detected.recentComplete) {
    shown = `This shows only the ${countOf(count, "entry", "entries")} the comparison read, not its whole history`;
  } else if (count === 0) {
    shown = "It holds no entries";
  } else if (count === 1) {
    shown = "This shows the one entry it holds";
  } else {
    shown = `This shows all ${count} entries it holds`;
  }

  if (detected.table === "script_patch") {
    return (
      `${label} was compared without a saved connection, so its script_patch history ` +
      `and scripts cannot be loaded here. ${shown}.`
    );
  }
  return `${detected.table} on ${label} does not store its scripts. ${shown}.`;
}

// ── The push button's backwards warning ────────────────────────────────────

/** The words of the push button's warning when pushing would take the target back. */
export type BackwardsWarning = {
  /** The warning's heading. */
  head: string;
  /** What each side declares, and what the push may undo. */
  body: string;
  /** The words beside the tick that lets Push go ahead. */
  ack: string;
  /** Why Push is blocked until that box is ticked, shown beside the button. */
  blocker: string;
  /**
   * Offer "Compare the other way instead". True when the target is simply
   * ahead: the other way round pushes the newer schema onto the older one.
   * False when they have diverged: that way round moves the source back in
   * the groups where it is ahead, so it is no safer.
   */
  offerSwap: boolean;
};

/** One side of the comparison, as the warning names it. */
type WarningSide = { name: string; detected: DetectedVersion | null };

/**
 * The warning Compare's push button shows before it takes the target back, or
 * null when it does not. It shows exactly when the version bar colours itself
 * as backwards (pushMovesTargetBack: the target is ahead, everywhere or in
 * some script groups, and the migration has statements), so one never appears
 * without the other.
 *
 * With script groups on both sides the numbers are the groups' heads, printed
 * by familyGaps as the verdict's reason prints them, so the bar and this
 * warning quote the same versions. Otherwise each side's one declared version,
 * printed by displayVersion as the bar prints it.
 */
export function backwardsWarning(
  verdict: NewerSchemaVerdict | null,
  inSync: boolean,
  source: WarningSide,
  target: WarningSide
): BackwardsWarning | null {
  if (!verdict || !pushMovesTargetBack(verdict.newer, inSync)) return null;
  const s = source.name;
  const t = target.name;
  const sourceHeads = source.detected?.familyHeads;
  const targetHeads = target.detected?.familyHeads;

  if (hasFamilyHeads(sourceHeads) && hasFamilyHeads(targetHeads)) {
    const rows = familyHeadRows(sourceHeads, targetHeads);
    // The groups where the target is ahead: what the push may take back.
    const { rightAheadIn } = compareFamilyHeads(sourceHeads, targetHeads);
    const undo =
      `The script below changes ${t} to match ${s}, so it may undo anything that arrived in ` +
      `${t}'s newer versions of ${listNames(rightAheadIn)}.`;
    if (verdict.newer === "diverged") {
      // Each side is ahead somewhere. Name both, so nobody reads "backwards"
      // as "the source is simply older".
      return {
        head: `This would move ${t} backwards in ${listNames(rightAheadIn)}`,
        body:
          `${s} and ${t} have diverged. ${s} is behind in ${familyGaps(rows, "left")}, ` +
          `and ${t} is behind in ${familyGaps(rows, "right")}. ${undo}`,
        ack: `I have checked this and want ${t} to match ${s}, even where ${t} is ahead.`,
        blocker: `Tick the box above to confirm ${t} should match ${s}, even where ${t} is ahead.`,
        offerSwap: false,
      };
    }
    return {
      head: `This would move ${t} backwards`,
      body: `${s} is behind ${t} in ${familyGaps(rows, "left")}. ${undo}`,
      ack: `I have checked this and want ${t} to match the older schema.`,
      blocker: `Tick the box above to confirm ${t} should move back to the older schema.`,
      offerSwap: true,
    };
  }

  if (verdict.newer === "right") {
    const targetDetected = target.detected;
    const sourceDetected = source.detected;
    const targetDeclares = targetDetected?.version
      ? displayVersion(targetDetected.version, hasFamilyHeads(targetDetected.familyHeads))
      : "a newer version";
    const inTable = targetDetected?.table ? ` in its ${targetDetected.table} table` : "";
    const sourceDeclares = sourceDetected?.version
      ? displayVersion(sourceDetected.version, hasFamilyHeads(sourceDetected.familyHeads))
      : "an older version";
    return {
      head: `This would move ${t} backwards`,
      body:
        `${t} declares ${targetDeclares}${inTable}; ${s} declares ${sourceDeclares}. The script below ` +
        `changes ${t} to match the older schema, so it may undo anything that arrived in the newer version.`,
      ack: `I have checked this and want ${t} to match the older schema.`,
      blocker: `Tick the box above to confirm ${t} should move back to the older schema.`,
      offerSwap: true,
    };
  }

  // "diverged" comes only from the script-group comparison, which needs heads
  // on both sides. Should one ever arrive without them, the verdict's own
  // reason still says what differs.
  return {
    head: `This would move ${t} backwards where it is ahead`,
    body:
      `${verdict.reason} The script below changes ${t} to match ${s}, so it may undo anything ` +
      `that arrived in ${t}'s newer versions.`,
    ack: `I have checked this and want ${t} to match ${s}, even where ${t} is ahead.`,
    blocker: `Tick the box above to confirm ${t} should match ${s}, even where ${t} is ahead.`,
    offerSwap: false,
  };
}
