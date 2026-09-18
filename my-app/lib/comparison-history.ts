// ---------------------------------------------------------------------------
// comparison-history.ts
// What a comparison found, in a form that can be stored and compared with what
// the NEXT one finds.
//
// Spec feature 04: "…and show historical comparison changes." A saved set
// already records when it last ran, but a bare timestamp cannot answer the
// question anybody actually has — "has anything changed since last week?" —
// because nothing recorded WHAT was found. Two runs a week apart, both saying
// "14 differences", may be the same fourteen or a completely different fourteen.
//
// So each run stores a fingerprint of its findings, and the next run says what
// appeared and what was resolved in between. That is the history: not a log of
// runs, but the difference between them.
//
// Pure — no database, no React. The writing and reading live in
// comparison-history-db.ts, which imports the metadata models. Keeping the
// rules here means the screen can render a comparison of two runs without
// importing Sequelize, and the rules themselves are unit-tested directly.

import type { ChangeRow } from "./compare-export";
import type { ChangeSeverity } from "./compare-types";

/** One difference, identified in a way that survives to the next run. */
export type HistoryItem = {
  /**
   * A JSON array of [category, table, object, change].
   *
   * JSON rather than a joined string because a table or a column may legally
   * be named with whatever separator character would otherwise be picked, and
   * a key that two different differences can share would report one of them as
   * resolved the moment the other appeared.
   */
  key: string;
  severity: ChangeSeverity;
};

/** Everything one run recorded about what it found. */
export type RunSnapshot = {
  breaking: number;
  safe: number;
  info: number;
  /** Every difference the run found, including the ones `items` left out. */
  total: number;
  /** The differences themselves, up to HISTORY_ITEM_LIMIT of them. */
  items: HistoryItem[];
  /** True when `total` is larger than `items` — see the limit below. */
  truncated: boolean;
  /**
   * A hash over EVERY key, not just the stored ones.
   *
   * This is what makes "nothing has changed since the last run" exact even on
   * a schema whose differences run past the limit: two runs with the same
   * fingerprint found the same set of differences, whatever was stored.
   */
  fingerprint: string;
};

/**
 * How many differences one run stores individually.
 *
 * A comparison of two schemas that have drifted badly can produce thousands of
 * rows, and this goes into a JSONB column that is read back on every Compare.
 * The cap keeps one bad pair from filling the metadata database — and the
 * fingerprint above still covers the rest, so what is lost is the ability to
 * NAME what changed, not the ability to know that something did.
 */
export const HISTORY_ITEM_LIMIT = 500;

/** The key for one change row. See HistoryItem.key. */
function keyOf(row: ChangeRow): string {
  return JSON.stringify([row.category, row.table, row.object, row.change, row.detail]);
}

/**
 * A stable 32-bit hash of the whole key list, as hex.
 *
 * FNV-1a rather than md5 from node:crypto, so this module stays importable from
 * the browser along with the screen that renders its output. Nothing here is a
 * security boundary — the worst a collision does is report "no change" for a
 * run that changed — and 32 bits over a sorted list of schema object names is
 * far past what that risk needs.
 */
function fingerprintOf(keys: ReadonlyArray<string>): string {
  let hash = 0x811c9dc5;
  for (const key of keys) {
    for (let i = 0; i < key.length; i += 1) {
      hash ^= key.charCodeAt(i);
      // The FNV prime, as the shifts and adds that keep the arithmetic inside
      // the 32 bits JavaScript's bitwise operators work in. A plain `* 16777619`
      // loses the low bits to floating point long before it wraps.
      hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
    }
    // Hashed into the running value so that ["ab"] and ["a", "b"] differ.
    hash = (hash ^ 0x0a) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** What this run found, ready to store. */
export function snapshotChanges(changes: ReadonlyArray<ChangeRow>): RunSnapshot {
  // Deduplicated: two rows that produce the same key are the same difference
  // said twice, and counting both would make a run look like it drifted from
  // itself. Sorted so the fingerprint does not depend on the order the report
  // happened to walk the schema in.
  const bySeverity = new Map<string, ChangeSeverity>();
  for (const row of changes) {
    const key = keyOf(row);
    const seen = bySeverity.get(key);
    // The worse severity wins, so a difference never reads as safer for having
    // been listed twice.
    if (seen === undefined || rank(row.severity) > rank(seen)) {
      bySeverity.set(key, row.severity);
    }
  }
  const keys = [...bySeverity.keys()].sort();

  return {
    breaking: count(bySeverity, "breaking"),
    safe: count(bySeverity, "safe"),
    info: count(bySeverity, "info"),
    total: keys.length,
    items: keys.slice(0, HISTORY_ITEM_LIMIT).map((key) => ({
      key,
      severity: bySeverity.get(key) as ChangeSeverity,
    })),
    truncated: keys.length > HISTORY_ITEM_LIMIT,
    fingerprint: fingerprintOf(keys),
  };
}

function rank(severity: ChangeSeverity): number {
  return severity === "breaking" ? 2 : severity === "safe" ? 1 : 0;
}

function count(items: Map<string, ChangeSeverity>, severity: ChangeSeverity): number {
  let n = 0;
  for (const value of items.values()) if (value === severity) n += 1;
  return n;
}

/** What changed between one run and the next. */
export type RunDelta = {
  /** Differences this run has that the previous one did not. */
  appeared: HistoryItem[];
  /** Differences the previous run had that this one does not. */
  resolved: HistoryItem[];
  /** True when the two runs found exactly the same set of differences. */
  same: boolean;
  /**
   * False when either run stored only part of its findings, so `appeared` and
   * `resolved` are what could be seen rather than the whole answer. The screen
   * says so rather than presenting a partial list as a complete one.
   */
  complete: boolean;
};

/**
 * Compare two runs of the same pair.
 *
 * `same` comes from the fingerprints, which cover every difference, and NOT
 * from the two lists being empty — on a truncated pair the lists can easily be
 * empty while the part that was never stored is what moved.
 */
export function compareRuns(previous: RunSnapshot, current: RunSnapshot): RunDelta {
  const before = new Map(previous.items.map((item) => [item.key, item]));
  const after = new Map(current.items.map((item) => [item.key, item]));
  return {
    appeared: current.items.filter((item) => !before.has(item.key)),
    resolved: previous.items.filter((item) => !after.has(item.key)),
    same: previous.fingerprint === current.fingerprint,
    complete: !previous.truncated && !current.truncated,
  };
}

/** One stored difference, in words. See HistoryItem.key for the shape. */
export function describeItem(item: HistoryItem): string {
  let parts: unknown;
  try {
    parts = JSON.parse(item.key);
  } catch {
    // A key written by a build that shaped them differently. Showing the raw
    // key is ugly; dropping the row would quietly shrink a list of what
    // changed, which is worse.
    return item.key;
  }
  if (!Array.isArray(parts)) return item.key;
  const [category, table, object, change] = parts.map((part) =>
    typeof part === "string" ? part : "",
  );
  const name = table ? `${table}.${object}` : object;
  return `${name} — ${category.toLowerCase()} ${change}`;
}

/**
 * The sentence above the list, or null when there is nothing to say.
 *
 * `null` for a first run: there is no previous comparison to have drifted
 * from, and "0 differences appeared" would read as a finding about the two
 * schemas rather than about this being the first time anybody looked.
 */
export function describeDelta(delta: RunDelta, when: string): string {
  if (delta.same) {
    return `The same differences as the comparison ${when}. Nothing has drifted since.`;
  }
  const parts: string[] = [];
  if (delta.appeared.length > 0) {
    const breaking = delta.appeared.filter((item) => item.severity === "breaking").length;
    parts.push(
      `${delta.appeared.length} new ${plural(delta.appeared.length)}` +
        (breaking > 0 ? `, ${breaking} of them breaking` : ""),
    );
  }
  if (delta.resolved.length > 0) {
    parts.push(`${delta.resolved.length} ${plural(delta.resolved.length)} resolved`);
  }
  if (parts.length === 0) {
    // The fingerprints disagree but neither stored list moved — only possible
    // when a run stored part of its findings and the part it did not store is
    // what changed. Saying "nothing appeared" here would be a lie by omission.
    return (
      `Something changed since the comparison ${when}, past the ${HISTORY_ITEM_LIMIT} ` +
      `differences a run records individually.`
    );
  }
  return (
    `Since the comparison ${when}: ${parts.join(", ")}.` +
    (delta.complete
      ? ""
      : ` One of the two runs recorded only its first ${HISTORY_ITEM_LIMIT} differences, ` +
        `so this list is what could be compared rather than everything that moved.`)
  );
}

function plural(n: number): string {
  return n === 1 ? "difference" : "differences";
}

/**
 * Read a snapshot back out of the JSONB column.
 *
 * Returns null for anything that is not the expected shape — a row written by
 * an older build, most likely. A run with no readable history is a run with no
 * history, and the screen shows nothing rather than a comparison against
 * numbers it could not verify.
 */
export function readRunSnapshot(value: unknown): RunSnapshot | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.fingerprint !== "string") return null;
  if (!Array.isArray(raw.items)) return null;

  const items: HistoryItem[] = [];
  for (const entry of raw.items) {
    if (entry === null || typeof entry !== "object") continue;
    const item = entry as Record<string, unknown>;
    if (typeof item.key !== "string") continue;
    if (item.severity !== "breaking" && item.severity !== "safe" && item.severity !== "info") {
      continue;
    }
    items.push({ key: item.key, severity: item.severity });
  }

  const num = (field: unknown, fallback: number): number =>
    typeof field === "number" && Number.isFinite(field) ? field : fallback;

  return {
    breaking: num(raw.breaking, 0),
    safe: num(raw.safe, 0),
    info: num(raw.info, 0),
    // Falls back to what was actually stored rather than to 0: a total smaller
    // than the list under it would make "of 500 shown" nonsense.
    total: num(raw.total, items.length),
    items,
    truncated: raw.truncated === true,
    fingerprint: raw.fingerprint,
  };
}
