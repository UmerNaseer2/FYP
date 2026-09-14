// A short date, drawn the same way on every screen.
//
// The ledgers and the server keep time in UTC, and Drift, the schema page and
// Version Sync print a moment as "2026-09-08 01:43 UTC". A short date drawn in
// the reader's own time zone beside one of those can name a different day for
// the same moment: 01:43 UTC on the 8th is still the 7th in New York. So the
// short date is the UTC day as well, and a version reads the same in a list
// and in the timeline under it.

/**
 * The UTC day of an ISO timestamp, e.g. "Sep 8, 2026". "" for a missing or
 * unparseable timestamp rather than "Invalid Date": a version table found in
 * the wild can hold anything.
 */
export function shortUtcDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/**
 * A moment to the minute in UTC, e.g. "2026-09-08 01:43 UTC" — the stamp
 * Drift, the schema page and Version Sync print. "" for a missing or
 * unparseable timestamp, as above.
 */
export function utcStamp(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toISOString().slice(0, 16).replace("T", " ") + " UTC";
}
