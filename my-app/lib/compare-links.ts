// Links the Compare screen builds from the current selection. Kept apart from
// compare-run.ts because that module opens the metadata database, so neither
// a test nor a client component can load it just to build a URL.
import {
  selectionToQuery,
  swapSourceWithTarget,
  type CurrentSelection,
} from "@/lib/compare-selection";

/**
 * The same comparison the other way round, run at once: the only target
 * becomes the source and the source becomes the target.
 *
 * The Migration Workbench offers it next to the Push button when the target's
 * own version table says the target is AHEAD of the source. Pushing then would
 * move the target backwards, and the swapped comparison is usually what was
 * meant.
 *
 * Null when there is not exactly one target (with several, "the other way"
 * has no single meaning), or when either side has no saved connection (the
 * link would compare a side nobody picked).
 *
 * The query is selectionToQuery's, so the field names are the Compare form's
 * and cannot drift from what the server reads. That also carries the two
 * options over: allow data loss and compare row data, both already chosen for
 * these same two databases. `run=1` makes the link run the comparison instead
 * of only filling in the pickers.
 */
export function buildSwapHref(selection: CurrentSelection): string | null {
  if (selection.targets.length !== 1) return null;
  if (selection.sourceConnectionId === null) return null;
  if (selection.targets[0].connectionId === null) return null;
  const params = new URLSearchParams(selectionToQuery(swapSourceWithTarget(selection, 0)));
  params.set("run", "1");
  return `/compare?${params.toString()}`;
}
