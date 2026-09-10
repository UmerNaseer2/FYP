import {
  DEFAULT_DRIFT_INTERVAL_MINUTES,
  DRIFT_INTERVAL_CHOICES,
  DRIFT_INTERVAL_OFF,
  describeCadence,
  isDriftInterval,
  isDue,
  nextDueAt,
  normalizeDriftInterval,
  selectDue,
  type DriftScheduleEntry,
} from "@/lib/drift-schedule";

/**
 * The scheduler is one thin loop around the decisions in this module, so these
 * tests are where the cadence actually gets proved. Two of them matter more
 * than the rest: that a schema which has never been checked is due immediately
 * — that is the "a check runs on tracking" half of the promise, and it has to
 * hold even when the check at tracking time failed — and that a backlog drains
 * most-overdue-first, so a tick cap starves the tail for one minute rather than
 * forever.
 */

const AT = (iso: string) => new Date(iso);

/** A schema with a cadence and a last-checked time, named for readability. */
function entry(
  trackedSchemaId: number,
  intervalMinutes: number,
  lastCheckedAt: string | null
): DriftScheduleEntry {
  return {
    trackedSchemaId,
    intervalMinutes,
    lastCheckedAt: lastCheckedAt ? AT(lastCheckedAt) : null,
  };
}

describe("normalizeDriftInterval", () => {
  it("passes an offered cadence through untouched", () => {
    for (const choice of DRIFT_INTERVAL_CHOICES) {
      expect(normalizeDriftInterval(choice.minutes)).toBe(choice.minutes);
    }
  });

  it("snaps a value from an older build to the nearest offered cadence", () => {
    expect(normalizeDriftInterval(20)).toBe(15);
    expect(normalizeDriftInterval(45)).toBe(60);
    expect(normalizeDriftInterval(10_000)).toBe(1440);
  });

  it("keeps a one-minute cadence away from other people's databases", () => {
    expect(normalizeDriftInterval(1)).toBe(5);
  });

  it("leaves off alone rather than rounding it up to a real cadence", () => {
    expect(normalizeDriftInterval(0)).toBe(DRIFT_INTERVAL_OFF);
    expect(normalizeDriftInterval(-30)).toBe(DRIFT_INTERVAL_OFF);
  });

  it("treats junk as off, since a schema nobody can schedule is not watched", () => {
    expect(normalizeDriftInterval(null)).toBe(DRIFT_INTERVAL_OFF);
    expect(normalizeDriftInterval("soon")).toBe(DRIFT_INTERVAL_OFF);
    expect(normalizeDriftInterval(Number.NaN)).toBe(DRIFT_INTERVAL_OFF);
  });
});

describe("isDriftInterval", () => {
  it("accepts the default the product promised", () => {
    expect(isDriftInterval(DEFAULT_DRIFT_INTERVAL_MINUTES)).toBe(true);
  });

  it("rejects a cadence the picker never offers", () => {
    expect(isDriftInterval(7)).toBe(false);
  });
});

describe("describeCadence", () => {
  it("reads minutes as minutes and hours as hours", () => {
    expect(describeCadence(15)).toBe("every 15m");
    expect(describeCadence(180)).toBe("every 3h");
  });

  it("says once a day rather than every 24h", () => {
    expect(describeCadence(1440)).toBe("once a day");
  });

  it("says manual only when nothing will run it", () => {
    expect(describeCadence(DRIFT_INTERVAL_OFF)).toBe("manual only");
  });
});

describe("nextDueAt", () => {
  it("adds the cadence to the last check", () => {
    const due = nextDueAt(entry(1, 15, "2026-09-09T10:00:00.000Z"));
    expect(due?.toISOString()).toBe("2026-09-09T10:15:00.000Z");
  });

  it("has no answer for a schema nobody schedules", () => {
    expect(nextDueAt(entry(1, DRIFT_INTERVAL_OFF, "2026-09-09T10:00:00.000Z"))).toBe(null);
  });

  it("has no answer before the first check, because due is not a future time", () => {
    expect(nextDueAt(entry(1, 15, null))).toBe(null);
  });
});

describe("isDue", () => {
  it("is due the moment the cadence elapses, not a tick later", () => {
    const e = entry(1, 15, "2026-09-09T10:00:00.000Z");
    expect(isDue(e, AT("2026-09-09T10:14:59.000Z"))).toBe(false);
    expect(isDue(e, AT("2026-09-09T10:15:00.000Z"))).toBe(true);
  });

  it("is due immediately when no check has ever run", () => {
    expect(isDue(entry(1, 15, null), AT("2026-09-09T10:00:00.000Z"))).toBe(true);
  });

  it("is never due when the cadence is off, even after years", () => {
    const e = entry(1, DRIFT_INTERVAL_OFF, null);
    expect(isDue(e, AT("2030-01-01T00:00:00.000Z"))).toBe(false);
  });

  it("uses the snapped cadence, so a stored 20 behaves as 15", () => {
    const e = entry(1, 20, "2026-09-09T10:00:00.000Z");
    expect(isDue(e, AT("2026-09-09T10:15:00.000Z"))).toBe(true);
  });
});

describe("selectDue", () => {
  const NOW = AT("2026-09-09T12:00:00.000Z");

  it("returns only the schemas whose cadence has elapsed", () => {
    const due = selectDue(
      [
        entry(1, 15, "2026-09-09T11:00:00.000Z"),
        entry(2, 15, "2026-09-09T11:59:00.000Z"),
        entry(3, DRIFT_INTERVAL_OFF, null),
      ],
      NOW,
      10
    );
    expect(due.map((e) => e.trackedSchemaId)).toEqual([1]);
  });

  it("drains the backlog most-overdue first", () => {
    const due = selectDue(
      [
        entry(1, 15, "2026-09-09T11:30:00.000Z"),
        entry(2, 15, "2026-09-09T10:00:00.000Z"),
        entry(3, 15, "2026-09-09T11:00:00.000Z"),
      ],
      NOW,
      10
    );
    expect(due.map((e) => e.trackedSchemaId)).toEqual([2, 3, 1]);
  });

  it("puts a never-checked schema ahead of every overdue one", () => {
    const due = selectDue(
      [entry(1, 15, "2020-01-01T00:00:00.000Z"), entry(2, 15, null)],
      NOW,
      10
    );
    expect(due.map((e) => e.trackedSchemaId)).toEqual([2, 1]);
  });

  it("breaks a tie by id so the order is stable across ticks", () => {
    const due = selectDue([entry(9, 15, null), entry(4, 15, null)], NOW, 10);
    expect(due.map((e) => e.trackedSchemaId)).toEqual([4, 9]);
  });

  it("caps a tick, leaving the rest for the next one", () => {
    const due = selectDue(
      [
        entry(1, 15, "2026-09-09T10:00:00.000Z"),
        entry(2, 15, "2026-09-09T10:10:00.000Z"),
        entry(3, 15, "2026-09-09T10:20:00.000Z"),
      ],
      NOW,
      2
    );
    expect(due.map((e) => e.trackedSchemaId)).toEqual([1, 2]);
  });

  it("checks nothing when the cap is zero, rather than everything", () => {
    expect(selectDue([entry(1, 15, null)], NOW, 0)).toEqual([]);
  });

  it("does not mutate the list it was given", () => {
    const entries = [entry(3, 15, null), entry(1, 15, null)];
    selectDue(entries, NOW, 10);
    expect(entries.map((e) => e.trackedSchemaId)).toEqual([3, 1]);
  });
});
