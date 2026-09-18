/**
 * Custom alert thresholds for performance.
 *
 * Spec feature 10 — "Allow custom alert thresholds for performance issues."
 *
 * The whole of this module is the definition of what may be alerted on and how
 * a breach is decided. It opens nothing and fetches nothing, so both the screen
 * and the routes can import it and neither can drift from the other.
 *
 * Two decisions worth stating, because both were the other way first:
 *
 *   • A threshold is per connection-and-schema, not global. "Slower than 200 ms
 *     is a problem" is true of a lookup on the login path and nonsense about a
 *     nightly report, and the two live in different schemas. A global number
 *     would have to be set loose enough to never fire.
 *   • Every threshold ships with a default and starts DISABLED. A tool that
 *     invents alert levels and turns them on is a tool whose first act is to
 *     tell its user that their database is broken, using numbers it made up.
 *     The default is a suggestion in the box, not a claim.
 */

/** Which direction counts as a breach. */
export type ThresholdDirection = "above" | "below";

/** The things that can be watched. Adding one means adding it here only. */
export const THRESHOLD_KEYS = [
  "query_exec_ms",
  "query_score",
  "long_running_seconds",
  "cache_hit_ratio",
  "dead_row_ratio",
] as const;

export type ThresholdKey = (typeof THRESHOLD_KEYS)[number];

export type ThresholdDefinition = {
  key: ThresholdKey;
  /** The heading on the settings row. */
  label: string;
  /** What the number is in, for the input's suffix: "ms", "%", "s". */
  unit: string;
  direction: ThresholdDirection;
  /** The value the box is pre-filled with. Not applied until it is enabled. */
  suggested: number;
  /** The range the input accepts, so a typo cannot store a useless rule. */
  min: number;
  max: number;
  /** One sentence under the row saying what firing it would mean. */
  help: string;
  /**
   * How many decimal places the value carries. Ratios are stored 0–1 and shown
   * as percentages, which is the only place this matters.
   */
  asPercent?: boolean;
};

export const THRESHOLDS: Record<ThresholdKey, ThresholdDefinition> = {
  query_exec_ms: {
    key: "query_exec_ms",
    label: "Query slower than",
    unit: "ms",
    direction: "above",
    suggested: 1000,
    min: 1,
    max: 3_600_000,
    help:
      "Fires when an analysed query is timed at more than this. Only measured " +
      "runs count — an estimate has no time to compare.",
  },
  query_score: {
    key: "query_score",
    label: "Query scores below",
    unit: "/ 100",
    direction: "below",
    suggested: 60,
    min: 0,
    max: 100,
    help:
      "Fires when an analysed query scores under this. 60 is the floor of the " +
      "middle band — see lib/query-score.ts for what the bands mean.",
  },
  long_running_seconds: {
    key: "long_running_seconds",
    label: "Session running longer than",
    unit: "s",
    direction: "above",
    suggested: 60,
    min: 1,
    max: 86_400,
    help:
      "Fires when the live-activity check finds a session that has been on the " +
      "same statement for longer than this.",
  },
  cache_hit_ratio: {
    key: "cache_hit_ratio",
    label: "Cache hit ratio below",
    unit: "%",
    direction: "below",
    suggested: 0.9,
    min: 0,
    max: 1,
    asPercent: true,
    help:
      "Checked on the Activity tab, against the whole database. It is the share of " +
      "block reads PostgreSQL served from its own shared buffers — a miss may still " +
      "have come from the operating system's cache, so this is a floor on how much " +
      "was in memory. The counters are totals since they were last reset, so a cold " +
      "server climbs back out of a breach rather than clearing it at once.",
  },
  dead_row_ratio: {
    key: "dead_row_ratio",
    label: "Dead rows above",
    unit: "%",
    direction: "above",
    suggested: 0.2,
    min: 0,
    max: 1,
    asPercent: true,
    help:
      "The only threshold that changes what a screen reports rather than raising an " +
      "alert on top of it: it is the share of dead rows at which the Suggestions tab " +
      "starts reporting a table as needing a vacuum. Left off, that tab uses 20%, " +
      "which is autovacuum's own trigger point.",
  },
};

/** One threshold as it is stored: a value, and whether it is switched on. */
export type ThresholdSetting = {
  key: ThresholdKey;
  value: number;
  enabled: boolean;
};

/** Narrow an arbitrary string to a known key, the way toRole does for roles. */
export function toThresholdKey(value: unknown): ThresholdKey | null {
  return (THRESHOLD_KEYS as readonly string[]).includes(String(value))
    ? (String(value) as ThresholdKey)
    : null;
}

/**
 * Check a value against the definition's range.
 *
 * Returns a sentence for the user, or null when it is fine. NaN and Infinity
 * are caught first: both get through a plain `< min` comparison, and an
 * Infinity stored in the table is a rule that can never fire.
 */
export function validateThreshold(key: ThresholdKey, value: number): string | null {
  const definition = THRESHOLDS[key];
  if (!Number.isFinite(value)) return `${definition.label} needs a number.`;
  if (value < definition.min || value > definition.max) {
    const range = definition.asPercent
      ? `${definition.min * 100}% and ${definition.max * 100}%`
      : `${definition.min} and ${definition.max}`;
    return `${definition.label} has to be between ${range}.`;
  }
  return null;
}

/** The settings a schema starts with: every threshold, suggested and off. */
export function defaultSettings(): ThresholdSetting[] {
  return THRESHOLD_KEYS.map((key) => ({
    key,
    value: THRESHOLDS[key].suggested,
    enabled: false,
  }));
}

/** A threshold that fired, with what it fired on. */
export type ThresholdBreach = {
  key: ThresholdKey;
  /** The value that broke the rule. */
  actual: number;
  /** The rule it broke. */
  limit: number;
  direction: ThresholdDirection;
  /** What it was about: a query's fingerprint, a table name, a pid. */
  subject: string;
  /** One sentence naming the breach, ready for the screen. */
  message: string;
};

/** Format a value the way its definition says, for a message. */
export function formatThresholdValue(key: ThresholdKey, value: number): string {
  const definition = THRESHOLDS[key];
  if (definition.asPercent) return `${Math.round(value * 100)}%`;
  if (definition.unit === "/ 100") return `${Math.round(value)} / 100`;
  return `${Math.round(value).toLocaleString("en-US")} ${definition.unit}`;
}

/**
 * Decide whether one reading breaks one rule.
 *
 * Kept separate from the loop below so a caller with a single reading — the
 * analyse route, checking the query it has just scored — can ask about it
 * without assembling a whole map first.
 */
export function checkThreshold(
  setting: ThresholdSetting,
  actual: number,
  subject: string
): ThresholdBreach | null {
  if (!setting.enabled) return null;
  if (!Number.isFinite(actual)) return null;
  const definition = THRESHOLDS[setting.key];
  const broken =
    definition.direction === "above" ? actual > setting.value : actual < setting.value;
  if (!broken) return null;

  return {
    key: setting.key,
    actual,
    limit: setting.value,
    direction: definition.direction,
    subject,
    message:
      `${subject}: ${formatThresholdValue(setting.key, actual)} is ` +
      `${definition.direction} the ${formatThresholdValue(setting.key, setting.value)} ` +
      `limit set for this schema.`,
  };
}

/** Every reading to check, as {key, actual, subject} triples. */
export type ThresholdReading = { key: ThresholdKey; actual: number; subject: string };

/**
 * Run a batch of readings against the stored settings.
 *
 * A reading whose key has no stored setting is simply not checked — that is a
 * threshold nobody has configured, not an error.
 */
export function evaluateThresholds(
  readings: ThresholdReading[],
  settings: ThresholdSetting[]
): ThresholdBreach[] {
  const byKey = new Map(settings.map((setting) => [setting.key, setting]));
  const breaches: ThresholdBreach[] = [];
  for (const reading of readings) {
    const setting = byKey.get(reading.key);
    if (!setting) continue;
    const breach = checkThreshold(setting, reading.actual, reading.subject);
    if (breach) breaches.push(breach);
  }
  // Worst first, measured as how far past the line each one is. A ratio rather
  // than a difference so that milliseconds and percentages can be ranked
  // against each other at all.
  return breaches.sort((a, b) => overshoot(b) - overshoot(a));
}

/** How far past its limit a breach is, as a ratio, for ranking. */
function overshoot(breach: ThresholdBreach): number {
  if (breach.limit === 0) return breach.actual === 0 ? 0 : Number.MAX_SAFE_INTEGER;
  return breach.direction === "above"
    ? breach.actual / breach.limit
    : breach.limit / Math.max(breach.actual, Number.EPSILON);
}
