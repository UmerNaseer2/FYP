import type { SchemaSnapshot } from "./postgres";

/**
 * Spec feature 10 — schema monitoring, minus the database.
 *
 * Everything here is arithmetic over samples that somebody else collected:
 * counting a snapshot, turning a list of samples into the geometry of a line,
 * and saying in a sentence what that line did. No `pg`, no fetch, no clock of
 * its own — which is what lets the trend screen import it directly and the
 * tests check the awkward cases without a server.
 *
 * Two rules run through the whole file, and both are about not inventing data:
 *
 *   • A measurement that could not be taken is `null`, and a null is a GAP.
 *     It is never drawn as zero and never averaged away. "We could not read
 *     the table sizes on 3 September" and "the schema was empty on 3
 *     September" are different facts, and a chart that cannot tell them apart
 *     is worse than no chart.
 *   • One sample is not a trend. A single point has nothing to compare itself
 *     against, so the answer to "what changed?" is "ask again after the next
 *     check", not a flat line drawn through one number.
 */

// ---------------------------------------------------------------------------
// What a sample is.
// ---------------------------------------------------------------------------

/**
 * One reading of a schema, taken at the moment a drift check ran.
 *
 * The counts come from the snapshot the check had already fetched, so they cost
 * nothing extra. The three sizes come from the server's own statistics and are
 * nullable, because reading them needs a privilege the counts do not.
 */
export type MetricSample = {
  /** ISO time the check that produced this reading ran. */
  at: string;
  tables: number;
  columns: number;
  indexes: number;
  foreignKeys: number;
  views: number;
  routines: number;
  /** Heap + indexes + TOAST, in bytes. Null when the sizes could not be read. */
  totalBytes: number | null;
  /** The index part of `totalBytes`. Null under the same conditions. */
  indexBytes: number | null;
  /** The planner's row estimate summed over the schema. Null as above. */
  estimatedRows: number | null;
  /** Whether the check that took this reading found drift. */
  drifted: boolean;
};

/** The numbers a trend can be drawn for. */
export type MetricKey =
  | "tables"
  | "columns"
  | "indexes"
  | "foreignKeys"
  | "views"
  | "routines"
  | "totalBytes"
  | "indexBytes"
  | "estimatedRows";

/** How a value is written out — the two are formatted nothing alike. */
export type MetricUnit = "count" | "bytes";

export type MetricMeta = {
  key: MetricKey;
  /** Column heading and chart title. */
  label: string;
  unit: MetricUnit;
  /** Singular noun for a sentence: "1 table". */
  noun: string;
  /**
   * The plural, spelled out rather than derived.
   *
   * English does not add "s" to "index", and a screen that says "2 indexs" is
   * a screen the reader stops trusting about the numbers as well.
   */
  nounPlural: string;
  /** Why this number is worth watching, in one sentence. */
  help: string;
};

/**
 * The metrics, in the order they are worth reading.
 *
 * Structure first, then size. A reader looking at a schema that suddenly grew
 * wants to know whether it grew because something was added or because the
 * existing tables filled up, and those are the first four and the last three.
 */
export const METRICS: MetricMeta[] = [
  {
    key: "tables",
    label: "Tables",
    unit: "count",
    noun: "table",
    nounPlural: "tables",
    help: "How many tables the schema has. A step here is somebody adding or dropping one.",
  },
  {
    key: "columns",
    label: "Columns",
    unit: "count",
    noun: "column",
    nounPlural: "columns",
    help:
      "Columns across every table. Moves without the table count moving means " +
      "existing tables are being altered.",
  },
  {
    key: "indexes",
    label: "Indexes",
    unit: "count",
    noun: "index",
    nounPlural: "indexes",
    help:
      "Indexes across every table. Worth watching against size: indexes that " +
      "only ever go up are how a schema gets slow to write to.",
  },
  {
    key: "foreignKeys",
    label: "Foreign keys",
    unit: "count",
    noun: "foreign key",
    nounPlural: "foreign keys",
    help: "Foreign keys across every table — the shape of the relationships.",
  },
  {
    key: "views",
    label: "Views",
    unit: "count",
    noun: "view",
    nounPlural: "views",
    help:
      "Views and materialised views the schema defines. A view moving on its " +
      "own is a reporting change; one moving with the table count is usually " +
      "the same migration touching both.",
  },
  {
    key: "routines",
    label: "Functions",
    unit: "count",
    noun: "function",
    nounPlural: "functions",
    help:
      "Functions and procedures the schema defines. These are the objects a " +
      "comparison is most likely to find redefined rather than added.",
  },
  {
    key: "totalBytes",
    label: "Total size",
    unit: "bytes",
    noun: "byte",
    nounPlural: "bytes",
    help:
      "Everything the schema occupies on disk: table data, indexes and TOAST. " +
      "This is the number that turns into a bill.",
  },
  {
    key: "indexBytes",
    label: "Index size",
    unit: "bytes",
    noun: "byte",
    nounPlural: "bytes",
    help:
      "The index share of the total. Climbing much faster than the data " +
      "usually means indexes nobody reads.",
  },
  {
    key: "estimatedRows",
    label: "Rows (estimated)",
    unit: "count",
    noun: "row",
    nounPlural: "rows",
    help:
      "The planner's own row estimate, summed over the schema. It is an " +
      "estimate, refreshed by ANALYZE — good for a trend, not for a count.",
  },
];

/** Look one up by key, so a caller does not have to carry the table around. */
export function metricMeta(key: MetricKey): MetricMeta {
  const found = METRICS.find((m) => m.key === key);
  // Unreachable through the type, but a thrown error here would take a whole
  // screen down over a typo in a query string.
  return found ?? METRICS[0];
}

// ---------------------------------------------------------------------------
// Counting a snapshot.
// ---------------------------------------------------------------------------

/** The structural half of a sample — everything a snapshot alone can answer. */
export type SnapshotCounts = {
  tables: number;
  columns: number;
  indexes: number;
  foreignKeys: number;
  views: number;
  routines: number;
};

/**
 * Count what is in a captured schema.
 *
 * Every collection on a snapshot except `tables` is optional, and that is
 * load-bearing rather than lazy typing — a snapshot captured before views were
 * recorded genuinely has no record of them. Here the distinction does not
 * survive: a sample has to be a number, and `0` is the only honest reading of
 * "this capture knows about no views". The alternative — a nullable count per
 * collection — would put six more gaps in every chart to describe a situation
 * that only arises for snapshots this app no longer takes.
 */
export function countSnapshot(snapshot: SchemaSnapshot): SnapshotCounts {
  let columns = 0;
  let indexes = 0;
  let foreignKeys = 0;
  for (const table of snapshot.tables) {
    columns += table.columns.length;
    indexes += table.indexes?.length ?? 0;
    foreignKeys += table.foreignKeys.length;
  }
  return {
    tables: snapshot.tables.length,
    columns,
    indexes,
    foreignKeys,
    views: snapshot.views?.length ?? 0,
    routines: snapshot.routines?.length ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Turning samples into a line.
// ---------------------------------------------------------------------------

/** One drawn point: the reading, and where it sits in the box. */
export type SeriesPoint = {
  at: string;
  value: number;
  x: number;
  y: number;
};

/** A horizontal rule with the value it stands for. */
export type SeriesTick = { value: number; y: number; label: string };

/** Where a check found drift — drawn as a mark under the line, not on it. */
export type SeriesMark = { at: string; x: number };

export type Series = {
  key: MetricKey;
  /** Readings that could be drawn, oldest first. */
  points: SeriesPoint[];
  /** Readings that existed but could not be measured. Reported, not drawn. */
  missing: number;
  min: number;
  max: number;
  /** First and last drawn readings — null when nothing could be drawn. */
  first: number | null;
  last: number | null;
  /** The polyline, ready for an SVG `d`. Empty when there is nothing to draw. */
  path: string;
  /** The same line closed down to the baseline, for a tint underneath. */
  area: string;
  /** At most three rules: the bottom, the top, and the middle when it differs. */
  ticks: SeriesTick[];
  /** Checks in this window that found drift. */
  driftMarks: SeriesMark[];
  /** The box the geometry was computed in, so the caller's viewBox matches. */
  box: SeriesBox;
};

/** The drawing area, in whatever units the caller's viewBox uses. */
export type SeriesBox = { width: number; height: number; pad: number };

const DEFAULT_BOX: SeriesBox = { width: 640, height: 140, pad: 6 };

/**
 * Lay a metric out as a line.
 *
 * Two decisions are worth stating, because both are visible on screen:
 *
 * X is TIME, not position in the list. Checks are not evenly spaced — a server
 * restart, a cadence change or a week switched off all leave real gaps, and
 * spacing the points evenly would quietly close them. A flat stretch on this
 * chart means "nothing changed for a week"; on an evenly-spaced one it could
 * equally mean "we only looked twice".
 *
 * Y is padded by a tenth of the range, and a series that never moves is drawn
 * down the middle rather than along the top or the bottom. A constant pinned to
 * an edge reads as a line at its limit, which is a claim the data does not make.
 */
export function buildSeries(
  samples: MetricSample[],
  key: MetricKey,
  box: SeriesBox = DEFAULT_BOX
): Series {
  const unit = metricMeta(key).unit;
  const ordered = [...samples].sort((a, b) => timeOf(a.at) - timeOf(b.at));

  const readable: Array<{ at: string; t: number; value: number }> = [];
  let missing = 0;
  for (const sample of ordered) {
    const value = sample[key];
    const t = timeOf(sample.at);
    if (value === null || !Number.isFinite(value) || !Number.isFinite(t)) {
      missing += 1;
      continue;
    }
    readable.push({ at: sample.at, t, value });
  }

  const empty: Series = {
    key,
    points: [],
    missing,
    min: 0,
    max: 0,
    first: null,
    last: null,
    path: "",
    area: "",
    ticks: [],
    driftMarks: [],
    box,
  };
  if (readable.length === 0) return empty;

  const values = readable.map((r) => r.value);
  const min = Math.min(...values);
  const max = Math.max(...values);

  // A tenth of the range as breathing room, and a floor of half a unit so a
  // series that never moves still has somewhere to sit.
  const spread = max - min;
  const padding = spread === 0 ? Math.max(Math.abs(max) * 0.1, 0.5) : spread * 0.1;
  const lo = min - padding;
  const hi = max + padding;

  // The time axis spans every sample in the window, not just the ones this
  // metric could read. Two reasons: the drift marks below are taken from every
  // sample, so an axis built from a subset put them outside the plot box; and
  // the three charts on the Trends screen sit above one another, so they have
  // to agree about where a given moment is.
  const times = ordered.map((s) => timeOf(s.at)).filter((t) => Number.isFinite(t));
  const t0 = Math.min(...times);
  const t1 = Math.max(...times);
  const inner = { w: box.width - box.pad * 2, h: box.height - box.pad * 2 };

  const xOf = (t: number): number =>
    // One reading, or several taken in the same millisecond: put them at the
    // right-hand edge, where "now" is on every other chart in the world.
    t1 === t0 ? box.width - box.pad : box.pad + ((t - t0) / (t1 - t0)) * inner.w;
  const yOf = (value: number): number =>
    box.pad + (1 - (value - lo) / (hi - lo)) * inner.h;

  const points: SeriesPoint[] = readable.map((r) => ({
    at: r.at,
    value: r.value,
    x: round2(xOf(r.t)),
    y: round2(yOf(r.value)),
  }));

  // A single reading has no line. Drawing a dot is honest; drawing a
  // zero-length path is a line the reader will read as flat.
  const path =
    points.length < 2
      ? ""
      : points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x},${p.y}`).join(" ");
  const area =
    path === ""
      ? ""
      : `${path} L${points[points.length - 1].x},${box.height} ` +
        `L${points[0].x},${box.height} Z`;

  const ticks: SeriesTick[] = [
    { value: max, y: round2(yOf(max)), label: formatValue(max, unit) },
  ];
  if (min !== max) {
    const mid = (min + max) / 2;
    const midLabel = formatValue(mid, unit);
    // Over a short range the middle rounds to the same text as one of the ends
    // — "3 / 3 / 2" for a chart that went from two tables to three. A rule
    // repeating a number it does not stand for is worse than one fewer rule.
    if (midLabel !== ticks[0].label && midLabel !== formatValue(min, unit)) {
      ticks.push({ value: mid, y: round2(yOf(mid)), label: midLabel });
    }
    ticks.push({ value: min, y: round2(yOf(min)), label: formatValue(min, unit) });
  }

  const driftMarks: SeriesMark[] = ordered
    .filter((s) => s.drifted && Number.isFinite(timeOf(s.at)))
    .map((s) => ({ at: s.at, x: round2(xOf(timeOf(s.at))) }));

  return {
    key,
    points,
    missing,
    min,
    max,
    first: points[0].value,
    last: points[points.length - 1].value,
    path,
    area,
    ticks,
    driftMarks,
    box,
  };
}

// ---------------------------------------------------------------------------
// Saying what happened, in a sentence.
// ---------------------------------------------------------------------------

export type ChangeDirection = "up" | "down" | "flat" | "unknown";

export type Change = {
  direction: ChangeDirection;
  /** The difference on its own: "up 3", "down 1.2 MB", "unchanged". */
  delta: string;
  /** The whole thing, for a caption under the chart. */
  sentence: string;
};

/**
 * What this line did, for somebody who is not going to squint at it.
 *
 * The chart already shows the shape. The sentence exists to say the two things
 * a shape cannot: how much, and over what stretch of time. "Unknown" is a real
 * answer here — with nothing readable, or with a single reading, there is no
 * change to report and saying "unchanged" would be a claim about a comparison
 * that never happened.
 */
export function describeChange(series: Series): Change {
  const meta = metricMeta(series.key);
  const { first, last, points } = series;

  if (first === null || last === null || points.length === 0) {
    return {
      direction: "unknown",
      delta: "not measured",
      sentence: `${meta.label} could not be measured in this window.`,
    };
  }

  const current = `${formatValue(last, meta.unit)}${
    meta.unit === "count" ? ` ${plural(meta, last)}` : ""
  }`;

  if (points.length === 1) {
    return {
      direction: "unknown",
      delta: "one reading",
      sentence:
        `${current} at the only check in this window — there is nothing yet ` +
        `to compare it against.`,
    };
  }

  const span = describeSpan(points[0].at, points[points.length - 1].at);
  const difference = last - first;

  if (difference === 0) {
    return {
      direction: "flat",
      delta: "unchanged",
      sentence: `${current}, unchanged ${span}.`,
    };
  }

  const size = formatValue(Math.abs(difference), meta.unit);
  const word = difference > 0 ? "up" : "down";
  return {
    direction: difference > 0 ? "up" : "down",
    delta: `${word} ${size}`,
    sentence:
      `${current}, ${word} ${size} from ${formatValue(first, meta.unit)} ${span}.`,
  };
}

/**
 * How many of the checks behind a chart found drift.
 *
 * Separate from the line because it is a different kind of fact: the line is
 * about the schema, this is about how often it stopped matching its baseline.
 */
export function driftShare(samples: MetricSample[]): {
  checks: number;
  drifted: number;
  sentence: string;
} {
  const checks = samples.length;
  const drifted = samples.filter((s) => s.drifted).length;
  if (checks === 0) {
    return { checks, drifted, sentence: "No checks have run in this window yet." };
  }
  if (drifted === 0) {
    return {
      checks,
      drifted,
      sentence: `All ${checks} check${checks === 1 ? "" : "s"} in this window found the schema in sync.`,
    };
  }
  return {
    checks,
    drifted,
    sentence:
      `${drifted} of ${checks} check${checks === 1 ? "" : "s"} in this window ` +
      `found the schema drifted from its baseline.`,
  };
}

// ---------------------------------------------------------------------------
// Formatting.
// ---------------------------------------------------------------------------

/** A count with thousands separators, or a size in the largest sensible unit. */
export function formatValue(value: number, unit: MetricUnit): string {
  return unit === "bytes" ? formatBytes(value) : formatCount(value);
}

/** "40,000". Rounded, because a fractional table is not a thing. */
export function formatCount(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

const BYTE_UNITS = ["bytes", "KB", "MB", "GB", "TB", "PB"];

/**
 * "1.4 MB". Powers of 1024, one decimal place above kilobytes.
 *
 * Two decimals would imply a precision the numbers do not have — these come
 * from the planner's own accounting, which is exact for what it stores and
 * approximate for what a person means by "how big is this".
 */
export function formatBytes(value: number): string {
  if (!Number.isFinite(value)) return "—";
  const sign = value < 0 ? "-" : "";
  let n = Math.abs(value);
  let unit = 0;
  while (n >= 1024 && unit < BYTE_UNITS.length - 1) {
    n /= 1024;
    unit += 1;
  }
  const shown = unit === 0 ? String(Math.round(n)) : n.toFixed(1);
  return `${sign}${shown} ${BYTE_UNITS[unit]}`;
}

/** "2 tables" / "1 table". */
function plural(meta: MetricMeta, count: number): string {
  return Math.round(count) === 1 ? meta.noun : meta.nounPlural;
}

/** "over the last 14 days" / "over the last 3 hours" / "in the last minute". */
function describeSpan(fromAt: string, toAt: string): string {
  const ms = timeOf(toAt) - timeOf(fromAt);
  if (!Number.isFinite(ms) || ms <= 0) return "over this window";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 2) return "over the last minute";
  if (minutes < 90) return `over the last ${minutes} minutes`;
  const hours = Math.round(ms / 3_600_000);
  if (hours < 36) return `over the last ${hours} hours`;
  const days = Math.round(ms / 86_400_000);
  return `over the last ${days} days`;
}

/** Milliseconds for an ISO string, or NaN — never a throw. */
function timeOf(at: string): number {
  return new Date(at).getTime();
}

/** Two decimal places, so the SVG path stays readable in the page source. */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
