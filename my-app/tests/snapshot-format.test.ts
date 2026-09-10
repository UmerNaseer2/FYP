import {
  SNAPSHOT_CATEGORIES,
  SNAPSHOT_FORMAT_HISTORY,
  SNAPSHOT_FORMAT_VERSION,
  recordedCategories,
  snapshotFormatGap,
  snapshotFormatVersion,
  unrecordedCategories,
} from "@/lib/snapshot-format";

/**
 * A stored baseline is never rewritten, so a schema tracked a year ago is still
 * compared against JSON produced by whatever build ran that day. The comparator
 * already refuses to report a category the baseline never recorded — correct,
 * but silent, and silence reads as "checked, and clean".
 *
 * These tests pin the two things that make it speak: that a missing category is
 * detected from the JSON rather than guessed from the version number, and that
 * a baseline with nothing wrong with it produces no note at all. A false note
 * on a healthy baseline would be worse than the silence it replaces.
 */

/** Everything this build records, so a test can subtract from it. */
function fullSnapshot(): Record<string, unknown> {
  const snapshot: Record<string, unknown> = {
    formatVersion: SNAPSHOT_FORMAT_VERSION,
    tables: [],
  };
  for (const category of SNAPSHOT_CATEGORIES) snapshot[category.key] = [];
  return snapshot;
}

describe("snapshotFormatVersion", () => {
  it("reads the stamp a current capture writes", () => {
    expect(snapshotFormatVersion(fullSnapshot())).toBe(SNAPSHOT_FORMAT_VERSION);
  });

  it("returns null for a snapshot captured before stamping existed", () => {
    expect(snapshotFormatVersion({ tables: [] })).toBe(null);
  });

  it("returns null rather than zero, so unstamped and version zero stay apart", () => {
    expect(snapshotFormatVersion({ tables: [] })).not.toBe(0);
  });

  it("ignores a stamp that is not a finite number", () => {
    expect(snapshotFormatVersion({ formatVersion: "4" } as never)).toBe(null);
    expect(snapshotFormatVersion({ formatVersion: Number.NaN })).toBe(null);
  });

  it("treats a missing snapshot as unstamped", () => {
    expect(snapshotFormatVersion(null)).toBe(null);
    expect(snapshotFormatVersion(undefined)).toBe(null);
  });
});

describe("recordedCategories / unrecordedCategories", () => {
  it("counts a category as recorded only when the key holds an array", () => {
    const snapshot = { views: [], sequences: null, types: undefined };
    expect(recordedCategories(snapshot)).toEqual(["views"]);
    expect(unrecordedCategories(snapshot)).toContain("sequences");
    expect(unrecordedCategories(snapshot)).toContain("types");
  });

  it("treats an empty array as recorded, because zero views is a finding", () => {
    expect(recordedCategories({ views: [] })).toEqual(["views"]);
  });

  it("splits every known category between the two lists", () => {
    const snapshot = fullSnapshot();
    expect(recordedCategories(snapshot)).toHaveLength(SNAPSHOT_CATEGORIES.length);
    expect(unrecordedCategories(snapshot)).toEqual([]);
  });

  it("reports nothing at all for a missing snapshot", () => {
    expect(recordedCategories(null)).toEqual([]);
    expect(unrecordedCategories(null)).toEqual([]);
  });
});

describe("snapshotFormatGap", () => {
  it("says nothing about a baseline this build could have written itself", () => {
    const gap = snapshotFormatGap(fullSnapshot());
    expect(gap.kind).toBe("current");
    expect(gap.missing).toEqual([]);
    expect(gap.note).toBe(null);
  });

  it("names the categories an older baseline never recorded", () => {
    const snapshot = fullSnapshot();
    delete snapshot.privileges;
    snapshot.formatVersion = 2;

    const gap = snapshotFormatGap(snapshot);
    expect(gap.kind).toBe("older");
    expect(gap.baselineVersion).toBe(2);
    expect(gap.currentVersion).toBe(SNAPSHOT_FORMAT_VERSION);
    expect(gap.missing).toEqual(["grants"]);
    expect(gap.note).toContain("grants");
    expect(gap.note).toContain("re-baseline");
  });

  it("joins several missing categories into a readable sentence", () => {
    const gap = snapshotFormatGap({ formatVersion: 1, tables: [] });
    expect(gap.missing.length).toBeGreaterThan(2);
    expect(gap.note).toContain(", ");
    expect(gap.note).toContain(" and ");
  });

  it("stays quiet about an unstamped baseline that recorded everything anyway", () => {
    const snapshot = fullSnapshot();
    delete snapshot.formatVersion;

    const gap = snapshotFormatGap(snapshot);
    expect(gap.kind).toBe("unstamped");
    expect(gap.baselineVersion).toBe(null);
    expect(gap.note).toBe(null);
  });

  it("blames the missing stamp rather than a version when there is no stamp", () => {
    const snapshot = fullSnapshot();
    delete snapshot.formatVersion;
    delete snapshot.views;

    const gap = snapshotFormatGap(snapshot);
    expect(gap.kind).toBe("unstamped");
    expect(gap.missing).toEqual(["views"]);
    expect(gap.note).toContain("predates snapshot format stamping");
  });

  it("warns that a newer baseline loses categories on this side instead", () => {
    const snapshot = fullSnapshot();
    snapshot.formatVersion = SNAPSHOT_FORMAT_VERSION + 1;

    const gap = snapshotFormatGap(snapshot);
    expect(gap.kind).toBe("newer");
    expect(gap.note).toContain("newer build");
    expect(gap.note).not.toContain("re-baseline");
  });

  it("has nothing to say when there is no baseline to say it about", () => {
    const gap = snapshotFormatGap(null);
    expect(gap.kind).toBe("unstamped");
    expect(gap.missing).toEqual([]);
    expect(gap.note).toBe(null);
  });
});

describe("SNAPSHOT_FORMAT_HISTORY", () => {
  it("documents every version up to the one this build writes", () => {
    const versions = SNAPSHOT_FORMAT_HISTORY.map((entry) => entry.version);
    expect(versions).toEqual([1, 2, 3, 4]);
    expect(versions[versions.length - 1]).toBe(SNAPSHOT_FORMAT_VERSION);
  });
});
