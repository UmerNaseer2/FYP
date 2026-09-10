/**
 * What ran a drift check.
 *
 * A drift_events row used to say only that a check happened, which was enough
 * when every check was a button press. Now that a scheduler runs them too, "at
 * 14:05 this schema was in sync" leaves out the thing a user most wants to
 * know: whether the app is actually watching, or whether they are looking at
 * their own click from an hour ago.
 *
 * Import-free on purpose — the audit table, the API routes and the scheduler
 * all read it, and one of those runs in the browser.
 */

/** Every value the `source` column is allowed to hold, and how it reads. */
export const DRIFT_SOURCES = [
  { key: "manual", label: "Checked by hand", verb: "checked" },
  { key: "scheduled", label: "Checked on schedule", verb: "checked automatically" },
  { key: "tracking", label: "First check after tracking", verb: "checked on tracking" },
  { key: "deploy", label: "Recorded after a deploy", verb: "recorded after deploy" },
  { key: "rebaseline", label: "Recorded after re-baselining", verb: "recorded after re-baseline" },
  { key: "acknowledged", label: "Acknowledged by a person", verb: "acknowledged" },
] as const;

/** The union of the keys above, so a caller cannot invent a seventh. */
export type DriftSource = (typeof DRIFT_SOURCES)[number]["key"];

/** Plain array for Sequelize's `isIn` and for SQL constraint generation. */
export const DRIFT_SOURCE_VALUES: string[] = DRIFT_SOURCES.map((s) => s.key);

/**
 * What a row written before this column existed is treated as.
 *
 * "manual" rather than "unknown": every check that could have written a row
 * back then WAS a button press, so this is the true answer, not a placeholder.
 */
export const DEFAULT_DRIFT_SOURCE: DriftSource = "manual";

/** Narrow whatever came out of the database back into the union. */
export function toDriftSource(value: unknown): DriftSource {
  const found = DRIFT_SOURCES.find((s) => s.key === value);
  return found ? found.key : DEFAULT_DRIFT_SOURCE;
}

/** "Checked on schedule" — the label for a filter chip or a column. */
export function driftSourceLabel(value: unknown): string {
  const key = toDriftSource(value);
  return DRIFT_SOURCES.find((s) => s.key === key)?.label ?? key;
}

/** "checked automatically" — the verb for a sentence about one event. */
export function driftSourceVerb(value: unknown): string {
  const key = toDriftSource(value);
  return DRIFT_SOURCES.find((s) => s.key === key)?.verb ?? key;
}
