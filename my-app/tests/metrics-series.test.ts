import {
  buildSeries,
  countSnapshot,
  describeChange,
  driftShare,
  formatBytes,
  formatCount,
  metricMeta,
  METRICS,
  type MetricSample,
  type SeriesBox,
} from "@/lib/metrics-series";
import type {
  RoutineSnapshot,
  SchemaSnapshot,
  TableSnapshot,
  ViewSnapshot,
} from "@/lib/postgres";

/**
 * Monitoring is the one screen in this app that draws a picture instead of
 * listing facts, and a picture is much easier to lie with. These tests are
 * mostly about the lies that are easy to tell by accident.
 *
 * Three of them matter more than the arithmetic:
 *
 *   • A reading that could not be taken must not be drawn as zero. A schema
 *     whose sizes were unreadable for two days did not shrink to nothing and
 *     grow back; it was not measured, and the series has to say so separately
 *     from the numbers it does have.
 *   • The x axis is time. Checks are not evenly spaced, so spacing the points
 *     evenly would close real gaps — a chart that says "flat all week" when
 *     the truth is "we looked twice" is worse than no chart.
 *   • One reading is not a trend. The honest answer to "what changed?" after a
 *     single check is that nothing has been compared yet.
 */

const BOX: SeriesBox = { width: 100, height: 100, pad: 0 };

/** A sample with everything readable, overridable field by field. */
function sample(at: string, extra: Partial<MetricSample> = {}): MetricSample {
  return {
    at,
    tables: 1,
    columns: 1,
    indexes: 1,
    foreignKeys: 1,
    views: 0,
    routines: 0,
    totalBytes: 1024,
    indexBytes: 512,
    estimatedRows: 10,
    drifted: false,
    ...extra,
  };
}

function table(name: string, extra: Partial<TableSnapshot> = {}): TableSnapshot {
  return {
    name,
    columns: [],
    primaryKey: null,
    uniqueConstraints: [],
    foreignKeys: [],
    checkConstraints: [],
    excludeConstraints: [],
    ...extra,
  };
}

function view(name: string): ViewSnapshot {
  return {
    name,
    materialized: false,
    definition: "SELECT 1",
    normalizedDefinition: "select 1",
    columns: ["one"],
    dependsOn: [],
  };
}

function routine(name: string): RoutineSnapshot {
  return {
    name,
    kind: "FUNCTION",
    identityArguments: "",
    signature: `${name}()`,
    returnType: "integer",
    language: "sql",
    definition: "SELECT 1",
    normalizedDefinition: "select 1",
  };
}

function snapshot(extra: Partial<SchemaSnapshot> = {}): SchemaSnapshot {
  return { database: "shop", schema: "public", tables: [], ...extra };
}

// ── Counting a snapshot ──────────────────────────────────────────────────────

describe("countSnapshot", () => {
  it("adds up columns, indexes and foreign keys across every table", () => {
    const counts = countSnapshot(
      snapshot({
        tables: [
          table("orders", {
            columns: [
              { name: "id", ordinalPosition: 1, typeDisplay: "integer", nullable: false,
                columnDefault: null, isPrimaryKey: true, uniqueConstraintNames: [],
                foreignKeyConstraintNames: [] },
              { name: "customer_id", ordinalPosition: 2, typeDisplay: "integer",
                nullable: false, columnDefault: null, isPrimaryKey: false,
                uniqueConstraintNames: [], foreignKeyConstraintNames: ["fk"] },
            ],
            indexes: [
              { name: "i1", definition: "d", normalizedDefinition: "d", columns: ["id"],
                isUnique: true, method: "btree", predicate: null },
            ],
            foreignKeys: [
              { name: "fk", kind: "FOREIGN KEY", columns: ["customer_id"], definition: "d",
                normalizedDefinition: "d", referencedSchema: "public",
                referencedTable: "customers", referencedColumns: ["id"],
                onUpdate: "NO ACTION", onDelete: "NO ACTION" },
            ],
          }),
          table("customers", {
            columns: [
              { name: "id", ordinalPosition: 1, typeDisplay: "integer", nullable: false,
                columnDefault: null, isPrimaryKey: true, uniqueConstraintNames: [],
                foreignKeyConstraintNames: [] },
            ],
          }),
        ],
      })
    );
    expect(counts).toEqual({
      tables: 2,
      columns: 3,
      indexes: 1,
      foreignKeys: 1,
      views: 0,
      routines: 0,
    });
  });

  it("counts views and routines a snapshot recorded", () => {
    const counts = countSnapshot(
      snapshot({ views: [view("v_orders")], routines: [routine("total")] })
    );
    expect(counts.views).toBe(1);
    expect(counts.routines).toBe(1);
  });

  it("reads a collection an older snapshot never recorded as none", () => {
    // Deliberate — see the note on countSnapshot. A sample has to be a number,
    // and the alternative is six more gaps per chart describing snapshots this
    // app no longer takes.
    const counts = countSnapshot(snapshot({ tables: [table("orders")] }));
    expect(counts.views).toBe(0);
    expect(counts.routines).toBe(0);
    expect(counts.indexes).toBe(0);
  });
});

// ── Metric metadata ──────────────────────────────────────────────────────────

describe("metricMeta", () => {
  it("finds every metric it advertises", () => {
    for (const meta of METRICS) {
      expect(metricMeta(meta.key).label).toBe(meta.label);
    }
  });

  it("carries a plural for every metric, spelled out rather than derived", () => {
    // Deriving it is what produced "2 indexs" on the first live run, and a
    // screen that gets that wrong is a screen the reader stops trusting about
    // the numbers as well.
    for (const meta of METRICS) {
      expect(meta.nounPlural.length).toBeGreaterThan(0);
      expect(meta.nounPlural).not.toBe(meta.noun);
    }
    expect(metricMeta("indexes").nounPlural).toBe("indexes");
  });

  it("gives back a usable metric rather than throwing on a bad key", () => {
    // The key arrives from a query string, and a typo there must not take the
    // whole screen down.
    const meta = metricMeta("nonsense" as never);
    expect(meta.key).toBe(METRICS[0].key);
  });
});

// ── Geometry ─────────────────────────────────────────────────────────────────

describe("buildSeries", () => {
  it("returns an empty series when there is nothing at all", () => {
    const series = buildSeries([], "tables", BOX);
    expect(series.points).toEqual([]);
    expect(series.path).toBe("");
    expect(series.first).toBeNull();
    expect(series.last).toBeNull();
  });

  it("counts an unmeasured reading as missing instead of drawing a zero", () => {
    const series = buildSeries(
      [
        sample("2026-09-01T00:00:00.000Z", { totalBytes: 4096 }),
        sample("2026-09-02T00:00:00.000Z", { totalBytes: null }),
        sample("2026-09-03T00:00:00.000Z", { totalBytes: 8192 }),
      ],
      "totalBytes",
      BOX
    );
    expect(series.points.length).toBe(2);
    expect(series.missing).toBe(1);
    expect(series.min).toBe(4096);
    expect(series.points.some((p) => p.value === 0)).toBe(false);
  });

  it("orders points by time even when the samples arrive shuffled", () => {
    const series = buildSeries(
      [
        sample("2026-09-03T00:00:00.000Z", { tables: 3 }),
        sample("2026-09-01T00:00:00.000Z", { tables: 1 }),
        sample("2026-09-02T00:00:00.000Z", { tables: 2 }),
      ],
      "tables",
      BOX
    );
    expect(series.points.map((p) => p.value)).toEqual([1, 2, 3]);
    expect(series.first).toBe(1);
    expect(series.last).toBe(3);
  });

  it("spaces points by time, so a gap in the checks stays visible", () => {
    // Three checks: two an hour apart, then one nine hours later. Evenly
    // spaced, the middle point would sit at the halfway mark and the long
    // silence would disappear.
    const series = buildSeries(
      [
        sample("2026-09-01T00:00:00.000Z", { tables: 1 }),
        sample("2026-09-01T01:00:00.000Z", { tables: 2 }),
        sample("2026-09-01T10:00:00.000Z", { tables: 3 }),
      ],
      "tables",
      BOX
    );
    expect(series.points[0].x).toBe(0);
    expect(series.points[1].x).toBe(10);
    expect(series.points[2].x).toBe(100);
  });

  it("draws a series that never moves down the middle, not along an edge", () => {
    const series = buildSeries(
      [
        sample("2026-09-01T00:00:00.000Z", { tables: 7 }),
        sample("2026-09-02T00:00:00.000Z", { tables: 7 }),
      ],
      "tables",
      BOX
    );
    expect(series.points.map((p) => p.y)).toEqual([50, 50]);
  });

  it("puts the highest reading at the top of the box and the lowest at the bottom", () => {
    const series = buildSeries(
      [
        sample("2026-09-01T00:00:00.000Z", { tables: 10 }),
        sample("2026-09-02T00:00:00.000Z", { tables: 20 }),
      ],
      "tables",
      BOX
    );
    // A tenth of the range is left as padding at each end, so the extremes sit
    // just inside the box rather than on its edges.
    expect(series.points[0].y).toBeGreaterThan(series.points[1].y);
    expect(series.points[1].y).toBeCloseTo(8.33, 1);
    expect(series.points[0].y).toBeCloseTo(91.67, 1);
  });

  it("draws no line through a single reading", () => {
    // One point is a dot. A zero-length path renders as nothing but reads, in
    // the markup and to anyone debugging it, as a flat line.
    const series = buildSeries([sample("2026-09-01T00:00:00.000Z")], "tables", BOX);
    expect(series.points.length).toBe(1);
    expect(series.path).toBe("");
    expect(series.area).toBe("");
  });

  it("puts a single reading at the right-hand edge, where now belongs", () => {
    const series = buildSeries([sample("2026-09-01T00:00:00.000Z")], "tables", BOX);
    expect(series.points[0].x).toBe(100);
  });

  it("closes the area down to the bottom of the box", () => {
    const series = buildSeries(
      [
        sample("2026-09-01T00:00:00.000Z", { tables: 1 }),
        sample("2026-09-02T00:00:00.000Z", { tables: 2 }),
      ],
      "tables",
      BOX
    );
    expect(series.path.startsWith("M0,")).toBe(true);
    expect(series.area.endsWith(`L0,${BOX.height} Z`)).toBe(true);
  });

  it("labels three rules when the line moves and one when it does not", () => {
    const moving = buildSeries(
      [
        sample("2026-09-01T00:00:00.000Z", { tables: 1 }),
        sample("2026-09-02T00:00:00.000Z", { tables: 3 }),
      ],
      "tables",
      BOX
    );
    expect(moving.ticks.map((t) => t.value)).toEqual([3, 2, 1]);

    const flat = buildSeries([sample("2026-09-01T00:00:00.000Z", { tables: 3 })], "tables", BOX);
    expect(flat.ticks.length).toBe(1);
  });

  it("drops a middle rule that reads the same as the top or the bottom", () => {
    // Two to three tables puts the middle at 2.5, which formats as "3" — the
    // same text as the rule above it. Two rules claiming the same number is
    // worse than one rule fewer.
    const series = buildSeries(
      [
        sample("2026-09-01T00:00:00.000Z", { tables: 2 }),
        sample("2026-09-02T00:00:00.000Z", { tables: 3 }),
      ],
      "tables",
      BOX
    );
    expect(series.ticks.map((t) => t.label)).toEqual(["3", "2"]);
  });

  it("keeps the middle rule when it stands for a number of its own", () => {
    const series = buildSeries(
      [
        sample("2026-09-01T00:00:00.000Z", { tables: 10 }),
        sample("2026-09-02T00:00:00.000Z", { tables: 30 }),
      ],
      "tables",
      BOX
    );
    expect(series.ticks.map((t) => t.label)).toEqual(["30", "20", "10"]);
  });

  it("marks the checks that found drift, in time order", () => {
    const series = buildSeries(
      [
        sample("2026-09-01T00:00:00.000Z", { tables: 1 }),
        sample("2026-09-02T00:00:00.000Z", { tables: 1, drifted: true }),
        sample("2026-09-03T00:00:00.000Z", { tables: 1 }),
      ],
      "tables",
      BOX
    );
    expect(series.driftMarks.length).toBe(1);
    expect(series.driftMarks[0].x).toBe(50);
  });

  it("marks a drifted check whose measurement was unreadable", () => {
    // The mark is about the check, not about the number. A check that drifted
    // while the sizes were unreadable still happened.
    const series = buildSeries(
      [
        sample("2026-09-01T00:00:00.000Z", { totalBytes: 100 }),
        sample("2026-09-02T00:00:00.000Z", { totalBytes: null, drifted: true }),
        sample("2026-09-03T00:00:00.000Z", { totalBytes: 200 }),
      ],
      "totalBytes",
      BOX
    );
    expect(series.missing).toBe(1);
    expect(series.driftMarks.length).toBe(1);
  });

  it("keeps a drift mark inside the plot when the first readings are missing", () => {
    // The marks come from every sample but the axis used to come only from the
    // samples this metric could read, so a drift recorded before the first
    // readable measurement was placed at a negative percentage — off the left
    // edge of the box, invisible.
    const series = buildSeries(
      [
        sample("2026-09-01T00:00:00.000Z", { totalBytes: null, drifted: true }),
        sample("2026-09-02T00:00:00.000Z", { totalBytes: 100 }),
        sample("2026-09-03T00:00:00.000Z", { totalBytes: 200 }),
      ],
      "totalBytes",
      BOX
    );
    expect(series.driftMarks.length).toBe(1);
    expect(series.driftMarks[0].x).toBe(0);
    expect(series.points.map((p) => p.x)).toEqual([50, 100]);
  });

  it("ignores a reading whose timestamp cannot be read", () => {
    const series = buildSeries(
      [
        sample("not a date", { tables: 99 }),
        sample("2026-09-01T00:00:00.000Z", { tables: 1 }),
      ],
      "tables",
      BOX
    );
    expect(series.points.map((p) => p.value)).toEqual([1]);
    expect(series.missing).toBe(1);
  });
});

// ── The sentence under the chart ─────────────────────────────────────────────

describe("describeChange", () => {
  it("refuses to describe a change when there is only one reading", () => {
    const change = describeChange(buildSeries([sample("2026-09-01T00:00:00.000Z")], "tables", BOX));
    expect(change.direction).toBe("unknown");
    expect(change.sentence).toContain("nothing yet to compare");
  });

  it("says so plainly when nothing in the window could be measured", () => {
    const change = describeChange(
      buildSeries([sample("2026-09-01T00:00:00.000Z", { totalBytes: null })], "totalBytes", BOX)
    );
    expect(change.direction).toBe("unknown");
    expect(change.delta).toBe("not measured");
  });

  it("reports a rise with the size of the rise and the stretch of time", () => {
    const change = describeChange(
      buildSeries(
        [
          sample("2026-09-01T00:00:00.000Z", { tables: 4 }),
          sample("2026-09-15T00:00:00.000Z", { tables: 6 }),
        ],
        "tables",
        BOX
      )
    );
    expect(change.direction).toBe("up");
    expect(change.delta).toBe("up 2");
    expect(change.sentence).toBe("6 tables, up 2 from 4 over the last 14 days.");
  });

  it("reports a fall as a fall, with the drop as a positive size", () => {
    const change = describeChange(
      buildSeries(
        [
          sample("2026-09-01T00:00:00.000Z", { tables: 9 }),
          sample("2026-09-02T00:00:00.000Z", { tables: 8 }),
        ],
        "tables",
        BOX
      )
    );
    expect(change.direction).toBe("down");
    expect(change.sentence).toContain("down 1 from 9");
  });

  it("calls a line that ends where it started unchanged", () => {
    const change = describeChange(
      buildSeries(
        [
          sample("2026-09-01T00:00:00.000Z", { tables: 5 }),
          sample("2026-09-02T00:00:00.000Z", { tables: 5 }),
        ],
        "tables",
        BOX
      )
    );
    expect(change.direction).toBe("flat");
    expect(change.sentence).toContain("unchanged");
  });

  it("writes a size change in bytes, not as a bare number", () => {
    const change = describeChange(
      buildSeries(
        [
          sample("2026-09-01T00:00:00.000Z", { totalBytes: 1_048_576 }),
          sample("2026-09-02T00:00:00.000Z", { totalBytes: 3_145_728 }),
        ],
        "totalBytes",
        BOX
      )
    );
    expect(change.sentence).toContain("3.0 MB");
    expect(change.sentence).toContain("up 2.0 MB");
  });

  it("says indexes, not indexs", () => {
    const change = describeChange(
      buildSeries(
        [
          sample("2026-09-01T00:00:00.000Z", { indexes: 1 }),
          sample("2026-09-02T00:00:00.000Z", { indexes: 4 }),
        ],
        "indexes",
        BOX
      )
    );
    expect(change.sentence.startsWith("4 indexes,")).toBe(true);
  });

  it("says one table, not one tables", () => {
    const change = describeChange(
      buildSeries(
        [
          sample("2026-09-01T00:00:00.000Z", { tables: 3 }),
          sample("2026-09-02T00:00:00.000Z", { tables: 1 }),
        ],
        "tables",
        BOX
      )
    );
    expect(change.sentence.startsWith("1 table,")).toBe(true);
  });
});

// ── How often the schema drifted ─────────────────────────────────────────────

describe("driftShare", () => {
  it("says nothing has run rather than reporting a clean record", () => {
    // Zero checks and zero drifted checks are the same two numbers as a
    // perfect week, and they mean the opposite thing.
    const share = driftShare([]);
    expect(share.checks).toBe(0);
    expect(share.sentence).toContain("No checks have run");
  });

  it("reports a window where every check found the schema in sync", () => {
    const share = driftShare([
      sample("2026-09-01T00:00:00.000Z"),
      sample("2026-09-02T00:00:00.000Z"),
    ]);
    expect(share.drifted).toBe(0);
    expect(share.sentence).toContain("All 2 checks");
  });

  it("counts the checks that found drift", () => {
    const share = driftShare([
      sample("2026-09-01T00:00:00.000Z", { drifted: true }),
      sample("2026-09-02T00:00:00.000Z"),
      sample("2026-09-03T00:00:00.000Z", { drifted: true }),
    ]);
    expect(share.drifted).toBe(2);
    expect(share.sentence).toContain("2 of 3 checks");
  });
});

// ── Formatting ───────────────────────────────────────────────────────────────

describe("formatCount", () => {
  it("separates thousands", () => {
    expect(formatCount(1234567)).toBe("1,234,567");
  });

  it("rounds, because a fractional table is not a thing", () => {
    expect(formatCount(2.5)).toBe("3");
  });
});

describe("formatBytes", () => {
  it("leaves a small number in bytes", () => {
    expect(formatBytes(512)).toBe("512 bytes");
  });

  it("climbs a unit at a time, in powers of 1024", () => {
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(1_048_576)).toBe("1.0 MB");
    expect(formatBytes(1_073_741_824)).toBe("1.0 GB");
  });

  it("keeps one decimal place, not two", () => {
    expect(formatBytes(1_500_000)).toBe("1.4 MB");
  });

  it("gives a dash rather than NaN for a number it cannot read", () => {
    expect(formatBytes(Number.NaN)).toBe("—");
  });
});
