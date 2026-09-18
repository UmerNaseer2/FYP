import {
  DB_HEALTH_SQL,
  dbHealthReadings,
  formatBytes,
  ratio,
  readDbHealth,
  type DbHealthRow,
} from "@/lib/db-health";
import { evaluateThresholds, THRESHOLD_KEYS, type ThresholdSetting } from "@/lib/perf-thresholds";

/**
 * Database health is a screen that tells somebody their server is unwell, so
 * the thing worth testing hardest is the opposite case: that it stays silent
 * when it has nothing to go on.
 *
 * Every counter in pg_stat_database is a total since a reset, and right after
 * one they are all zero. A ratio taken from two zeroes is NaN, and a NaN that
 * survives to the screen either prints as "NaN%" or is coerced to 0 — which
 * reports a perfectly healthy server as having no cache hits at all. That is
 * the failure this file is mostly about.
 */

/** A healthy server, with only what a test is about overridden. */
function row(extra: Partial<DbHealthRow> = {}): DbHealthRow {
  return {
    // Strings, because node-postgres returns bigint that way to keep precision.
    blks_hit: "9900",
    blks_read: "100",
    xact_commit: "1000",
    xact_rollback: "10",
    deadlocks: "0",
    temp_files: "0",
    temp_bytes: "0",
    conflicts: "0",
    numbackends: "12",
    stats_reset: "2026-09-01T00:00:00.000Z",
    db_bytes: "1073741824",
    max_connections: 100,
    database_name: "sales",
    ...extra,
  };
}

/** The metric with this key; the test fails when there is not exactly one. */
function metric(r: DbHealthRow, key: string) {
  const found = readDbHealth(r).metrics.filter((m) => m.key === key);
  expect(found).toHaveLength(1);
  return found[0];
}

describe("ratio", () => {
  it("is null rather than NaN when there is nothing to divide", () => {
    // The case this whole module is shaped around: a freshly reset counter.
    expect(ratio(0, 0)).toBeNull();
    expect(ratio(null, 5)).toBeNull();
    expect(ratio(5, null)).toBeNull();
  });

  it("takes a share of the total, not of the other side", () => {
    // 9 hits and 1 read is 90%, not 900%.
    expect(ratio(9, 1)).toBeCloseTo(0.9);
    expect(ratio(0, 7)).toBe(0);
  });
});

describe("formatBytes", () => {
  it("climbs units and keeps whole bytes whole", () => {
    expect(formatBytes(512)).toBe("512 bytes");
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(1_073_741_824)).toBe("1.0 GB");
  });
});

describe("readDbHealth", () => {
  it("reads the counters back as numbers, not as the strings pg sends", () => {
    // A bigint arrives as a string. "9900" + "100" would be "9900100" if any
    // of this were done before parsing, and the ratio would be nonsense.
    expect(metric(row(), "cache_hit_ratio").value).toBeCloseTo(0.99);
    expect(metric(row(), "cache_hit_ratio").display).toBe("99%");
  });

  it("says nothing rather than zero when the counters were just reset", () => {
    const fresh = row({ blks_hit: "0", blks_read: "0", xact_commit: "0", xact_rollback: "0" });
    for (const key of ["cache_hit_ratio", "rollback_ratio"]) {
      const m = metric(fresh, key);
      expect(m.value).toBeNull();
      expect(m.display).toBeNull();
      // Not "good" — nothing was measured, so there is nothing to call good.
      expect(m.level).toBe("unknown");
      expect(m.note).toContain("counters were reset");
    }
  });

  it("does not turn a missing counter into a zero", () => {
    // A view that did not return a column is a column this app could not read,
    // which is not the same fact as "none happened".
    const m = metric(row({ deadlocks: null }), "deadlocks");
    expect(m.value).toBeNull();
    expect(m.level).toBe("unknown");
    // And a real zero is a real answer, reported as good.
    expect(metric(row({ deadlocks: "0" }), "deadlocks").level).toBe("good");
  });

  it("grades the cache hit ratio on how far it has fallen", () => {
    expect(metric(row({ blks_hit: "9990", blks_read: "10" }), "cache_hit_ratio").level).toBe("good");
    expect(metric(row({ blks_hit: "9500", blks_read: "500" }), "cache_hit_ratio").level).toBe("watch");
    expect(metric(row({ blks_hit: "5000", blks_read: "5000" }), "cache_hit_ratio").level).toBe("bad");
  });

  it("grades rollbacks and connections the other way, because lower is better", () => {
    expect(metric(row({ xact_commit: "1000", xact_rollback: "0" }), "rollback_ratio").level).toBe("good");
    expect(metric(row({ xact_commit: "100", xact_rollback: "50" }), "rollback_ratio").level).toBe("bad");

    expect(metric(row({ numbackends: "10", max_connections: 100 }), "connections").level).toBe("good");
    expect(metric(row({ numbackends: "95", max_connections: 100 }), "connections").level).toBe("bad");
  });

  it("shows connections as a count against the limit, not as a bare percentage", () => {
    // "12 of 100" is actionable; "12%" of an unnamed limit is not.
    expect(metric(row({ numbackends: "12", max_connections: 100 }), "connections").display).toBe(
      "12 of 100"
    );
  });

  it("survives a server that will not say what its connection limit is", () => {
    // current_setting is refused to some roles. Dividing by a null limit must
    // not produce Infinity and colour the panel red.
    const m = metric(row({ max_connections: null }), "connections");
    expect(m.value).toBeNull();
    expect(m.display).toBeNull();
    expect(m.level).toBe("unknown");
  });

  it("never calls the database size wrong", () => {
    // There is no size that is a problem, so this one is context and is never
    // coloured — a 4 TB warehouse is not unhealthy for being large.
    const m = metric(row({ db_bytes: "4398046511104" }), "database_size");
    expect(m.display).toBe("4.0 TB");
    expect(m.level).toBe("good");
  });

  it("carries the window the totals cover", () => {
    expect(readDbHealth(row()).since).toBe("2026-09-01T00:00:00.000Z");
    // A server whose counters have never been reset says so with null rather
    // than with a date it invented.
    expect(readDbHealth(row({ stats_reset: null })).since).toBeNull();
  });

  it("names the temp-file total with its size, and stays quiet at zero", () => {
    expect(metric(row({ temp_files: "0", temp_bytes: "0" }), "temp_files").display).toBe("0");
    expect(metric(row({ temp_files: "40", temp_bytes: "104857600" }), "temp_files").display).toBe(
      "40 (100.0 MB)"
    );
  });
});

describe("the SQL it runs", () => {
  it("asks only about the database it is connected to", () => {
    // pg_stat_database has a row per database on the server. Without the
    // WHERE, a server with five databases returns five rows and the panel
    // would describe whichever one came back first.
    expect(DB_HEALTH_SQL).toContain("WHERE d.datname = current_database()");
  });

  it("reads every column the shaping expects", () => {
    for (const column of [
      "blks_hit",
      "blks_read",
      "xact_commit",
      "xact_rollback",
      "deadlocks",
      "temp_files",
      "temp_bytes",
      "numbackends",
      "stats_reset",
      "max_connections",
    ]) {
      expect(DB_HEALTH_SQL).toContain(column);
    }
  });
});

describe("dbHealthReadings", () => {
  /** Every threshold, at its suggested value, switched on. */
  function allEnabled(value: Partial<Record<string, number>> = {}): ThresholdSetting[] {
    return THRESHOLD_KEYS.map((key) => ({ key, value: value[key] ?? 0.9, enabled: true }));
  }

  it("makes the cache-hit threshold able to fire at all", () => {
    // This is the defect it was written for: cache_hit_ratio was offered in
    // the settings screen, validated and stored, and nothing in the app ever
    // produced a reading for it — so it could be enabled and never fire.
    const sick = readDbHealth(row({ blks_hit: "5000", blks_read: "5000" }));
    const breaches = evaluateThresholds(dbHealthReadings(sick), allEnabled({ cache_hit_ratio: 0.9 }));
    expect(breaches.map((b) => b.key)).toEqual(["cache_hit_ratio"]);
    expect(breaches[0].actual).toBeCloseTo(0.5);
    expect(breaches[0].subject).toContain("sales");
  });

  it("stays quiet when the ratio is fine", () => {
    const well = readDbHealth(row({ blks_hit: "9900", blks_read: "100" }));
    expect(evaluateThresholds(dbHealthReadings(well), allEnabled({ cache_hit_ratio: 0.9 }))).toEqual([]);
  });

  it("offers no reading at all when the ratio could not be measured", () => {
    // Otherwise a freshly reset server reports 0% and breaches every
    // cache-hit rule ever set, the first time anybody looks.
    const fresh = readDbHealth(row({ blks_hit: "0", blks_read: "0" }));
    expect(dbHealthReadings(fresh)).toEqual([]);
    expect(evaluateThresholds(dbHealthReadings(fresh), allEnabled({ cache_hit_ratio: 0.9 }))).toEqual([]);
  });

  it("offers only keys the settings screen actually shows", () => {
    // A reading whose key is not in the catalogue would be silently dropped by
    // evaluateThresholds, which is a rule that looks configured and is not.
    const health = readDbHealth(row());
    for (const reading of dbHealthReadings(health)) {
      expect(THRESHOLD_KEYS).toContain(reading.key);
    }
  });
});
