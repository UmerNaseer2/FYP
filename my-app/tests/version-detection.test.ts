import {
  acceptVersionTable,
  determineNewerSchema,
  normalizeChangeLevel,
  pickCurrentVersion,
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

describe("acceptVersionTable", () => {
  it("does not take an app's own history table for a version table", () => {
    // The old "%history%" pattern found this table, and the old reader then
    // read its first column (id) as the schema's version.
    expect(acceptVersionTable("order_history", ["id", "name", "created_at"])).toBe(false);
  });

  it("does not take a name-pattern match whose only version-like column is a name", () => {
    expect(acceptVersionTable("data_migration_log", ["id", "name", "ran_at"])).toBe(false);
  });

  it("accepts Flyway's table", () => {
    const flywayColumns = [
      "installed_rank",
      "version",
      "description",
      "type",
      "script",
      "checksum",
      "installed_by",
      "installed_on",
      "execution_time",
      "success",
    ];
    expect(acceptVersionTable("flyway_schema_history", flywayColumns)).toBe(true);
  });

  it("accepts a name-pattern match that has a real version column", () => {
    expect(acceptVersionTable("app_versions", ["id", "version", "created_at"])).toBe(true);
  });

  it("accepts a known table name with a looser version column", () => {
    // Laravel's `migrations` table has only `migration`; Rails has `version`.
    expect(acceptVersionTable("migrations", ["id", "migration", "batch"])).toBe(true);
    expect(acceptVersionTable("schema_migrations", ["version"])).toBe(true);
  });

  it("rejects a known table name with no version column at all", () => {
    expect(acceptVersionTable("schema_version", ["id", "created_at"])).toBe(false);
  });
});

describe("pickCurrentVersion", () => {
  it("ignores a failed run, however high its version", () => {
    const rows = [
      { version: "1.3.0", succeeded: false },
      { version: "1.2.0", succeeded: true },
      { version: "1.1.0", succeeded: true },
    ];
    expect(pickCurrentVersion(rows)?.version).toBe("1.2.0");
  });

  it("keeps a row whose success is not recorded", () => {
    const rows = [
      { version: "3.0.0", succeeded: null },
      { version: "2.0.0", succeeded: true },
    ];
    expect(pickCurrentVersion(rows)?.version).toBe("3.0.0");
  });

  it("ignores rows with no version, or no number in it", () => {
    const rows = [{ version: null }, { version: "baseline" }, { version: "2.0.0" }];
    expect(pickCurrentVersion(rows)?.version).toBe("2.0.0");
  });

  it("returns null when no row has a usable version", () => {
    expect(pickCurrentVersion([{ version: null }, { version: "initial" }])).toBeNull();
    expect(pickCurrentVersion([])).toBeNull();
  });

  it("compares versions part by part", () => {
    // As text, "1.9.0" sorts above "1.10.0".
    expect(pickCurrentVersion([{ version: "1.9.0" }, { version: "1.10.0" }])?.version).toBe(
      "1.10.0"
    );
    // Packed into one number, 1.1000.0 and 2.0.0 come out equal.
    expect(pickCurrentVersion([{ version: "1.1000.0" }, { version: "2.0.0" }])?.version).toBe(
      "2.0.0"
    );
    expect(pickCurrentVersion([{ version: "2.0.0" }, { version: "1.1000.0" }])?.version).toBe(
      "2.0.0"
    );
  });

  it("reads a missing part as 0, and keeps the first of two equal versions", () => {
    expect(pickCurrentVersion([{ version: "1.2" }, { version: "1.2.1" }])?.version).toBe("1.2.1");
    const rows = [
      { version: "1.2", tag: "newer by date" },
      { version: "1.2.0", tag: "older by date" },
    ];
    expect(pickCurrentVersion(rows)?.tag).toBe("newer by date");
  });

  it("lets the scheme most rows use win when a table mixes them", () => {
    // One timestamp-style rank among releases must not outrank 1.4.0 just
    // because 20240115 is a bigger number.
    const releases = [{ version: "20240115" }, { version: "1.4.0" }, { version: "1.3.0" }];
    expect(pickCurrentVersion(releases)?.version).toBe("1.4.0");

    const timestamps = [
      { version: "20240301120000" },
      { version: "20240115090000" },
      { version: "1.0.0" },
    ];
    expect(pickCurrentVersion(timestamps)?.version).toBe("20240301120000");
  });

  it("breaks an even split between schemes in favour of semver", () => {
    expect(pickCurrentVersion([{ version: "7" }, { version: "1.0.0" }])?.version).toBe("1.0.0");
  });
});

describe("determineNewerSchema, part by part", () => {
  it("does not treat 1.1000.0 and 2.0.0 as the same version", () => {
    // Both pack to 2,000,000 for display. Ordering must not use that number.
    const verdict = determineNewerSchema(
      detected("dev", "1.1000.0", 2_000_000, "semver"),
      detected("prod", "2.0.0", 2_000_000, "semver")
    );
    expect(verdict.newer).toBe("right");
    expect(verdict.reason).toContain("2.0.0");
  });

  it("reads 1.2 and 1.2.0 as the same version", () => {
    const verdict = determineNewerSchema(
      detected("dev", "1.2", 1_002_000, "semver"),
      detected("prod", "1.2.0", 1_002_000, "semver")
    );
    expect(verdict.newer).toBe("same");
  });

  it("orders 1.10.0 above 1.9.0", () => {
    const verdict = determineNewerSchema(
      detected("dev", "1.10.0", 1_010_000, "semver"),
      detected("prod", "1.9.0", 1_009_000, "semver")
    );
    expect(verdict.newer).toBe("left");
  });
});

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

  it("names sides by role when both schemas are called the same thing", () => {
    // Two databases each with a "public" is the ordinary case. Naming the sides
    // by schema then produces "Neither public nor public records a version of
    // its own", which reads like a bug in the tool rather than a fact about the
    // databases.
    const left = detected("public", null, null, null);
    const right = detected("public", null, null, null);
    expect(determineNewerSchema(left, right).reason).toBe(
      "Neither schema records a version of its own, so the structural diff is " +
        "the whole answer."
    );

    // One side blank is worse, because "public records no version" does not say
    // which public the reader should go and look at.
    const versioned = detected("public", "1.0.0", 1_000_000, "semver");
    expect(determineNewerSchema(versioned, right).reason).toContain("The target schema");
    expect(determineNewerSchema(right, versioned).reason).toContain("The source schema");

    // And the ranking sentences too — "public is newer based on version 2.0.0"
    // is a verdict with no subject.
    const ahead = detected("public", "2.0.0", 2_000_000, "semver");
    expect(determineNewerSchema(ahead, versioned).reason).toBe(
      "The source schema is newer based on version 2.0.0."
    );
  });

  it("keeps using the schema names when they differ", () => {
    const dev = detected("dev", null, null, null);
    const prod = detected("prod", null, null, null);
    expect(determineNewerSchema(dev, prod).reason).toContain("Neither dev nor prod");
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
