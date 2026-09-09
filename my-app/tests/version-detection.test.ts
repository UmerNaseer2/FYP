import {
  determineNewerSchema,
  normalizeChangeLevel,
  type VersionDetectionResult,
} from "@/lib/version-detection";

/**
 * Everything here is about READING what a foreign schema says about itself,
 * which is the part with no database in it. The detection queries need a live
 * Postgres and are covered by running the Compare screen; the grading and the
 * "which side is ahead" verdict are pure, and they are also the two places
 * where being confidently wrong is worse than saying nothing — a wrong verdict
 * puts an amber "the target is newer" banner above a migration that is fine.
 */

/** A detection result with only the fields the verdict actually reads set. */
function detected(
  schema: string,
  version: string | null,
  comparable: number | null,
  scheme: "semver" | "numeric" | null
): VersionDetectionResult {
  return {
    schema,
    hasVersionTable: version !== null,
    tableName: version !== null ? "schema_version" : null,
    detectedVersion: version,
    comparableValue: comparable,
    versionScheme: scheme,
    timeline: [],
    fallbackMode: version === null,
    message: "test fixture",
  };
}

describe("determineNewerSchema", () => {
  it("names the higher version when both sides count the same way", () => {
    const left = detected("dev", "2.3.1", 2_003_001, "semver");
    const right = detected("prod", "1.9.0", 1_009_000, "semver");
    expect(determineNewerSchema(left, right).newer).toBe("left");
    expect(determineNewerSchema(right, left).newer).toBe("right");
  });

  it("reports equal versions as the same, not as unknown", () => {
    const a = detected("dev", "2.0.0", 2_000_000, "semver");
    const b = detected("prod", "2.0.0", 2_000_000, "semver");
    expect(determineNewerSchema(a, b).newer).toBe("same");
  });

  it("refuses to rank a semver against a Flyway-style rank", () => {
    // The whole point of the scheme tag: 20240115 is a perfectly good version
    // and so is 2.3.1, but one is not "eight million behind" the other.
    const semver = detected("dev", "2.3.1", 2_003_001, "semver");
    const rank = detected("prod", "20240115", 20_240_115, "numeric");
    const verdict = determineNewerSchema(semver, rank);
    expect(verdict.newer).toBe("unknown");
    expect(verdict.reason).toContain("not the same");
  });

  it("still ranks two schemas that both use plain numbers", () => {
    const older = detected("dev", "7", 7, "numeric");
    const newer = detected("prod", "9", 9, "numeric");
    expect(determineNewerSchema(older, newer).newer).toBe("right");
  });

  it("says unknown when either side has no version table", () => {
    const has = detected("dev", "1.0.0", 1_000_000, "semver");
    const none = detected("prod", null, null, null);
    expect(determineNewerSchema(has, none).newer).toBe("unknown");
    expect(determineNewerSchema(none, none).newer).toBe("unknown");
  });

  it("gives a reason in every branch, because the screen prints it", () => {
    const a = detected("dev", "1.0.0", 1_000_000, "semver");
    const b = detected("prod", "2.0.0", 2_000_000, "semver");
    const none = detected("prod", null, null, null);
    for (const verdict of [
      determineNewerSchema(a, b),
      determineNewerSchema(b, a),
      determineNewerSchema(a, a),
      determineNewerSchema(a, none),
    ]) {
      expect(verdict.reason.length).toBeGreaterThan(0);
    }
  });
});

describe("normalizeChangeLevel", () => {
  it("reads the obvious words", () => {
    expect(normalizeChangeLevel("breaking")).toBe("breaking");
    expect(normalizeChangeLevel("additive")).toBe("additive");
    expect(normalizeChangeLevel("patch")).toBe("patch");
  });

  it("allows the endings a real description uses", () => {
    expect(normalizeChangeLevel("drops the legacy table")).toBe("breaking");
    expect(normalizeChangeLevel("removed an unused column")).toBe("breaking");
    expect(normalizeChangeLevel("creating the orders index")).toBe("additive");
    expect(normalizeChangeLevel("fixes the default")).toBe("patch");
  });

  it("does not match a word hiding inside another word", () => {
    // The bug this replaced: includes("add") graded an address column as
    // additive, and includes("drop") graded a dropdown as breaking.
    expect(normalizeChangeLevel("add address column")).toBe("additive");
    expect(normalizeChangeLevel("widen the address column")).toBe("unknown");
    expect(normalizeChangeLevel("dropdown options table")).toBe("unknown");
    expect(normalizeChangeLevel("rename deleteria to journal")).toBe("unknown");
  });

  it("is unknown rather than a guess when nothing matches", () => {
    expect(normalizeChangeLevel("")).toBe("unknown");
    expect(normalizeChangeLevel(null)).toBe("unknown");
    expect(normalizeChangeLevel(undefined)).toBe("unknown");
    expect(normalizeChangeLevel("V1__initial")).toBe("unknown");
  });

  it("grades breaking ahead of additive when a row says both", () => {
    // "drop the old column, add the new one" is a breaking migration with an
    // additive half. The dangerous half has to win.
    expect(normalizeChangeLevel("drop the old column and add the new one")).toBe(
      "breaking"
    );
  });
});
