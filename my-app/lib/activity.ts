// Helpers for the "Your activity" page. They are plain functions with no
// React in them, so the page stays short and the tests can call them directly.
//
// The page lists the organization's recorded drift checks, which is what
// GET /api/lineage/audit returns.

import type { DriftEventFeedItem, DriftStatus } from "@/lib/lineage-db";
import { driftSourceLabel } from "@/lib/drift-source";

/** The most checks the audit route hands back in one answer. */
export const ACTIVITY_LIMIT = 200;

/** How many days the ribbon at the top of the page shows. */
export const RIBBON_DAYS = 30;

/** The most squares one ribbon day draws. More than this shows as "+3". */
export const RIBBON_MARKS = 5;

/** Which kind of check the pills above the list are showing. */
export type ActivityKind = "all" | DriftStatus | "acknowledged";

export type ActivityFilters = {
  kind: ActivityKind;
  /** A tracked schema id as text, or "" for every schema. */
  schema: string;
  /** A drift source key such as "manual", or "" for every source. */
  source: string;
  /** Free text typed in the search box. */
  search: string;
  /** A day key such as "2026-11-12", or null for every day. */
  day: string | null;
};

export const NO_FILTERS: ActivityFilters = {
  kind: "all",
  schema: "",
  source: "",
  search: "",
  day: null,
};

/** The pills, in the order the page shows them. */
export const ACTIVITY_KINDS: { key: ActivityKind; label: string }[] = [
  { key: "all", label: "All" },
  { key: "drifted", label: "Drifted" },
  { key: "in_sync", label: "In sync" },
  { key: "unreachable", label: "Unreachable" },
  { key: "acknowledged", label: "Acknowledged" },
];

/** "Drifted", "In sync" or "Unreachable". */
export function statusLabel(status: DriftStatus): string {
  if (status === "drifted") return "Drifted";
  if (status === "in_sync") return "In sync";
  return "Unreachable";
}

/** The day a moment falls on, in the reader's own time zone: "2026-11-12". */
export function dayKey(when: string | number | Date): string {
  const date = new Date(when);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

/** The last `count` day keys, oldest first, ending on the day of `now`. */
export function lastDays(now: number, count: number = RIBBON_DAYS): string[] {
  const keys: string[] = [];
  const cursor = new Date(now);
  cursor.setHours(12, 0, 0, 0);
  cursor.setDate(cursor.getDate() - (count - 1));
  for (let i = 0; i < count; i += 1) {
    keys.push(dayKey(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  return keys;
}

/** Does this check belong under the picked pill? */
export function isKind(event: DriftEventFeedItem, kind: ActivityKind): boolean {
  if (kind === "all") return true;
  if (kind === "acknowledged") return event.acknowledgedAt !== null;
  return event.status === kind;
}

/** Does this check pass every filter? */
export function matchesFilters(event: DriftEventFeedItem, filters: ActivityFilters): boolean {
  if (!isKind(event, filters.kind)) return false;
  if (filters.schema !== "" && String(event.trackedSchemaId) !== filters.schema) return false;
  if (filters.source !== "" && event.source !== filters.source) return false;
  if (filters.day !== null && dayKey(event.detectedAt) !== filters.day) return false;

  const words = filters.search.trim().toLowerCase();
  if (words === "") return true;
  const haystack = [
    event.schemaName,
    event.connectionName ?? "",
    event.summary ?? "",
    statusLabel(event.status),
    driftSourceLabel(event.source),
  ]
    .join(" ")
    .toLowerCase();
  return haystack.includes(words);
}

/** One line of a check's counts, such as "Tables added: 2". */
export type CountLine = { label: string; count: number };

/**
 * The counts a drift check stored, as lines to show. The `detail` field is
 * free-form JSON, so every number is checked before it is trusted. Lines with
 * a count of zero are left out.
 */
export function countLines(detail: unknown): CountLine[] {
  if (detail === null || typeof detail !== "object") return [];
  const record = detail as Record<string, unknown>;
  const wanted: { key: string; label: string }[] = [
    { key: "tablesAdded", label: "Tables added" },
    { key: "tablesRemoved", label: "Tables removed" },
    { key: "tablesChanged", label: "Tables changed" },
    { key: "constraintsChanged", label: "Constraints changed" },
    { key: "objectsChanged", label: "Other objects changed" },
  ];
  const lines: CountLine[] = [];
  for (const { key, label } of wanted) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      lines.push({ label, count: value });
    }
  }
  return lines;
}

/**
 * One CSV cell. Quotes are doubled, and a cell that starts with a character a
 * spreadsheet would run as a formula gets a leading apostrophe, so opening the
 * file can never run anything.
 */
export function csvCell(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return `"${safe.replace(/"/g, '""')}"`;
}

/** The checks as a CSV file, one row per check, newest first as given. */
export function activityCsv(events: DriftEventFeedItem[]): string {
  const header = ["When", "Schema", "Connection", "Result", "Started by", "Summary", "Acknowledged"];
  const rows = events.map((event) => [
    event.detectedAt,
    event.schemaName,
    event.connectionName ?? "",
    statusLabel(event.status),
    driftSourceLabel(event.source),
    event.summary ?? "",
    event.acknowledgedAt ?? "",
  ]);
  return [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}
