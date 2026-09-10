/**
 * When a tracked schema is next due for a drift check.
 *
 * Pure arithmetic over a cadence and a last-checked time — no database, no
 * timers, no clock of its own. Every function takes `now` as an argument so the
 * behaviour is testable without waiting fifteen minutes for it, and so the
 * scheduler in lib/drift-scheduler.ts can be one thin loop around decisions
 * that are made here.
 *
 * Split out from the runtime deliberately: the UI needs the same answers ("when
 * is this next checked", "what does 'every 15m' read as") and must not import
 * anything that opens a database connection.
 */

/**
 * The cadence a newly tracked schema gets, and the number the product has
 * promised since the first plan: "a drift check runs immediately, then every
 * 15 minutes, adjustable per schema later."
 */
export const DEFAULT_DRIFT_INTERVAL_MINUTES = 15;

/** Zero means "never automatically" — the schema is checked only by hand. */
export const DRIFT_INTERVAL_OFF = 0;

/**
 * The cadences the UI offers, and what to call each one.
 *
 * A closed list rather than a free number box: the value is written into a
 * column every scheduler tick reads, and "every 1 minute" against a production
 * database is a mistake that only shows up as load on somebody else's server.
 */
export const DRIFT_INTERVAL_CHOICES: ReadonlyArray<{
  minutes: number;
  label: string;
}> = [
  { minutes: DRIFT_INTERVAL_OFF, label: "Manual only" },
  { minutes: 5, label: "Every 5 minutes" },
  { minutes: 15, label: "Every 15 minutes" },
  { minutes: 30, label: "Every 30 minutes" },
  { minutes: 60, label: "Every hour" },
  { minutes: 180, label: "Every 3 hours" },
  { minutes: 720, label: "Every 12 hours" },
  { minutes: 1440, label: "Once a day" },
];

/** True when `minutes` is one of the cadences above. */
export function isDriftInterval(minutes: number): boolean {
  return DRIFT_INTERVAL_CHOICES.some((choice) => choice.minutes === minutes);
}

/**
 * Bring a stored value back into the closed list.
 *
 * A row written by an older build, or by hand, can hold anything. Rather than
 * refusing to schedule it — which would quietly stop checking a schema the user
 * believes is watched — snap it to the nearest offered cadence. Off stays off:
 * it is a choice, not a stray value, and rounding it up to five minutes would
 * start hitting a database somebody deliberately stopped checking.
 */
export function normalizeDriftInterval(minutes: unknown): number {
  const n = Number(minutes);
  if (!Number.isFinite(n) || n <= 0) return DRIFT_INTERVAL_OFF;
  if (isDriftInterval(n)) return n;
  const nearest = DRIFT_INTERVAL_CHOICES.filter((c) => c.minutes > 0).reduce((best, c) => {
    const delta = Math.abs(c.minutes - n);
    const bestDelta = Math.abs(best.minutes - n);
    // A stray value that sits exactly between two cadences — 45, say — goes to
    // the LESS frequent one. Rounding down would quietly start hitting somebody
    // else's database more often than the number in the column ever asked for.
    if (delta === bestDelta) return c.minutes > best.minutes ? c : best;
    return delta < bestDelta ? c : best;
  });
  return nearest.minutes;
}

/** "every 15m" / "every 3h" / "once a day" / "manual only". */
export function describeCadence(minutes: number): string {
  const normalized = normalizeDriftInterval(minutes);
  if (normalized === DRIFT_INTERVAL_OFF) return "manual only";
  if (normalized === 1440) return "once a day";
  if (normalized % 60 === 0) return `every ${normalized / 60}h`;
  return `every ${normalized}m`;
}

/** One tracked schema, reduced to what scheduling actually depends on. */
export type DriftScheduleEntry = {
  trackedSchemaId: number;
  /** Cadence in minutes; 0 means the scheduler leaves this schema alone. */
  intervalMinutes: number;
  /**
   * When a check last ran for this schema, from whichever source ran it — a
   * button press counts. Null when none ever has, which makes the schema due
   * immediately and is how "a check runs on tracking" happens even if the
   * track request itself could not reach the database.
   */
  lastCheckedAt: Date | null;
};

/** When this schema is next due, or null when nothing will run it. */
export function nextDueAt(entry: DriftScheduleEntry): Date | null {
  const interval = normalizeDriftInterval(entry.intervalMinutes);
  if (interval === DRIFT_INTERVAL_OFF) return null;
  if (!entry.lastCheckedAt) return null;
  return new Date(entry.lastCheckedAt.getTime() + interval * 60_000);
}

/** Whether this schema should be checked at `now`. */
export function isDue(entry: DriftScheduleEntry, now: Date): boolean {
  const interval = normalizeDriftInterval(entry.intervalMinutes);
  if (interval === DRIFT_INTERVAL_OFF) return false;
  // Never checked and scheduled: due now. This is the "first check runs
  // immediately" half of the promise, and it holds even when the check that was
  // supposed to run at tracking time failed.
  if (!entry.lastCheckedAt) return true;
  const due = entry.lastCheckedAt.getTime() + interval * 60_000;
  return now.getTime() >= due;
}

/**
 * The schemas to check on this tick, oldest first, at most `limit` of them.
 *
 * Ordered by how overdue each one is rather than by id, so a backlog drains
 * fairly instead of the same few rows being checked every tick while the tail
 * starves. `limit` exists because a tick that fans out over fifty schemas at
 * once would open fifty connections to other people's databases; the rest are
 * picked up on the next tick, which is a minute away.
 */
export function selectDue(
  entries: DriftScheduleEntry[],
  now: Date,
  limit: number
): DriftScheduleEntry[] {
  if (limit <= 0) return [];
  const due = entries.filter((entry) => isDue(entry, now));
  due.sort((a, b) => {
    // A schema that has never been checked is the most overdue there is.
    const aAt = a.lastCheckedAt ? a.lastCheckedAt.getTime() : Number.NEGATIVE_INFINITY;
    const bAt = b.lastCheckedAt ? b.lastCheckedAt.getTime() : Number.NEGATIVE_INFINITY;
    return aAt - bAt || a.trackedSchemaId - b.trackedSchemaId;
  });
  return due.slice(0, limit);
}
