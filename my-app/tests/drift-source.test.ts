/**
 * lib/drift-source turns a free-text column into a closed set with words for
 * it. The value is written by four different code paths and read by the audit
 * log, so the two things worth pinning down are that an unknown value can never
 * reach the screen as-is, and that every source the app writes has a label.
 *
 * The second one matters more than it looks: adding a source without adding a
 * label is exactly the kind of change that ships silently and then shows a bare
 * key like "rebaseline" in a table of sentences.
 */

import {
  DEFAULT_DRIFT_SOURCE,
  DRIFT_SOURCES,
  DRIFT_SOURCE_VALUES,
  driftSourceLabel,
  driftSourceVerb,
  toDriftSource,
} from "@/lib/drift-source";

describe("toDriftSource", () => {
  it("returns each known key unchanged", () => {
    for (const source of DRIFT_SOURCES) {
      expect(toDriftSource(source.key)).toBe(source.key);
    }
  });

  it("falls back to the default for a key this build does not know", () => {
    expect(toDriftSource("webhook")).toBe(DEFAULT_DRIFT_SOURCE);
  });

  it("falls back to the default for null, which is what an older row holds", () => {
    expect(toDriftSource(null)).toBe(DEFAULT_DRIFT_SOURCE);
  });

  it("falls back to the default for values that are not strings at all", () => {
    expect(toDriftSource(undefined)).toBe(DEFAULT_DRIFT_SOURCE);
    expect(toDriftSource(7)).toBe(DEFAULT_DRIFT_SOURCE);
    expect(toDriftSource({})).toBe(DEFAULT_DRIFT_SOURCE);
  });

  it("does not treat a differently cased key as known", () => {
    // The column is compared by a CHECK constraint that is case sensitive, so
    // reading "Manual" as manual here would disagree with the database.
    expect(toDriftSource("Manual")).toBe(DEFAULT_DRIFT_SOURCE);
  });
});

describe("driftSourceLabel", () => {
  it("gives every known source a non-empty label", () => {
    for (const source of DRIFT_SOURCES) {
      expect(driftSourceLabel(source.key).length).toBeGreaterThan(0);
    }
  });

  it("never shows the raw key for a source it does not know", () => {
    expect(driftSourceLabel("webhook")).toBe(driftSourceLabel(DEFAULT_DRIFT_SOURCE));
  });

  it("gives each source a distinct label, so the audit column can be read", () => {
    const labels = DRIFT_SOURCES.map((s) => s.label);
    expect(new Set(labels).size).toBe(labels.length);
  });
});

describe("driftSourceVerb", () => {
  it("gives every known source a non-empty verb", () => {
    for (const source of DRIFT_SOURCES) {
      expect(driftSourceVerb(source.key).length).toBeGreaterThan(0);
    }
  });

  it("falls back to the default verb for an unknown source", () => {
    expect(driftSourceVerb("webhook")).toBe(driftSourceVerb(DEFAULT_DRIFT_SOURCE));
  });
});

describe("DRIFT_SOURCE_VALUES", () => {
  it("lists exactly the keys in DRIFT_SOURCES, in the same order", () => {
    // The model validator and the CHECK constraint are both built from this
    // list, so it drifting from DRIFT_SOURCES would let a write pass one and
    // fail the other.
    expect(DRIFT_SOURCE_VALUES).toEqual(DRIFT_SOURCES.map((s) => s.key));
  });

  it("has no duplicates", () => {
    expect(new Set(DRIFT_SOURCE_VALUES).size).toBe(DRIFT_SOURCE_VALUES.length);
  });

  it("includes the default, so a fallback value is always writable", () => {
    expect(DRIFT_SOURCE_VALUES).toContain(DEFAULT_DRIFT_SOURCE);
  });
});
