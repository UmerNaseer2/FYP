import {
  acceptVersionTable,
  determineNewerSchema,
  fetchSchemaVersionInfo,
  normalizeChangeLevel,
  pickCurrentVersion,
  type VersionDetectionResult,
} from "@/lib/version-detection";
import { createFakeClient, queriesMatching, type FakeClient, type FakeStep } from "./helpers/fake-pg";

// fetchSchemaVersionInfo reads through getPoolForConfig. The fake answers each
// query from the steps a test lists, so nothing here reaches a database.
let mockClient: FakeClient;
jest.mock("../lib/postgres", () => ({
  getPoolForConfig: () => mockClient,
}));

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
  scheme: "semver" | "numeric" | null,
  familyHeads: Record<string, string> | null = null
): VersionDetectionResult {
  return {
    schema,
    hasVersionTable: version !== null,
    tableName: version !== null ? "schema_version" : null,
    detectedVersion: version,
    comparableValue: comparable,
    versionScheme: scheme,
    timeline: [],
    familyHeads,
    truncated: false,
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

  it("accepts Liquibase's table", () => {
    // Its name has neither "version" nor "migration" in it, so unless it is
    // known by name nothing finds it — and a Liquibase-managed schema was
    // reported as having no version table while the docs said otherwise.
    const liquibaseColumns = [
      "id",
      "author",
      "filename",
      "dateexecuted",
      "orderexecuted",
      "exectype",
      "md5sum",
      "description",
      "comments",
      "tag",
      "liquibase",
      "contexts",
      "labels",
      "deployment_id",
    ];
    expect(acceptVersionTable("databasechangelog", liquibaseColumns)).toBe(true);
    // Read through `tag`, which is the only column in it that names a release.
    // The changesets in between carry none, and a row with no version is
    // already handled — it is listed without one.
    expect(acceptVersionTable("databasechangelog", ["id", "author", "filename"])).toBe(false);
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

describe("determineNewerSchema, script group by script group", () => {
  // A script_patch keeps several version lines at once. The overall version
  // (the highest in the whole table) is set to point the other way in some of
  // these: with groups on both sides, only the groups count.
  const withGroups = (schema: string, version: string, heads: Record<string, string>) =>
    detected(schema, version, 1, "semver", heads);

  it("is the same when every group has the same head, however it is spelled", () => {
    const verdict = determineNewerSchema(
      withGroups("dev", "3.0.0", { users_migration: "3.0.0", orders_migration: "1.0.0" }),
      withGroups("prod", "3.0.0", { users_migration: "v3.0.0", orders_migration: "1.0.0" })
    );
    expect(verdict).toEqual({
      newer: "same",
      reason: "Both schemas are at the same version in every script group.",
    });
  });

  it("says left when the target is behind in one group and ahead in none", () => {
    const verdict = determineNewerSchema(
      withGroups("dev", "3.0.0", { users_migration: "3.0.0", orders_migration: "1.0.0" }),
      withGroups("prod", "1.0.0", { users_migration: "1.0.0", orders_migration: "1.0.0" })
    );
    expect(verdict).toEqual({
      newer: "left",
      reason: "prod is behind in users_migration (v1.0.0 vs v3.0.0).",
    });
  });

  it("follows the groups, not the highest version in the table", () => {
    // dev's highest version is orders_migration's 5.0.0, which says nothing
    // about users_migration, where dev is behind.
    const verdict = determineNewerSchema(
      withGroups("dev", "5.0.0", { orders_migration: "5.0.0", users_migration: "1.0.0" }),
      withGroups("prod", "3.0.0", { orders_migration: "5.0.0", users_migration: "3.0.0" })
    );
    expect(verdict).toEqual({
      newer: "right",
      reason: "dev is behind in users_migration (v1.0.0 vs v3.0.0).",
    });
  });

  it("says diverged when each side is ahead in a group, and names both", () => {
    const verdict = determineNewerSchema(
      withGroups("dev", "3.0.0", { users_migration: "3.0.0", orders_migration: "1.0.0" }),
      withGroups("prod", "2.0.0", { users_migration: "1.0.0", orders_migration: "2.0.0" })
    );
    expect(verdict).toEqual({
      newer: "diverged",
      reason:
        "Diverged: dev is ahead in users_migration, prod in orders_migration, " +
        "so neither schema is simply newer.",
    });
  });

  it("counts a group only one side has as that side being ahead", () => {
    const verdict = determineNewerSchema(
      withGroups("dev", "1.0.0", { users_migration: "1.0.0", billing: "1.0.0" }),
      withGroups("prod", "1.0.0", { users_migration: "1.0.0" })
    );
    expect(verdict).toEqual({ newer: "left", reason: "prod is behind in billing (none vs v1.0.0)." });
  });

  it("names the sides by role when both schemas are called the same thing", () => {
    const left = withGroups("public", "3.0.0", { users_migration: "3.0.0", orders_migration: "1.0.0" });
    const diverged = withGroups("public", "2.0.0", { users_migration: "1.0.0", orders_migration: "2.0.0" });
    expect(determineNewerSchema(left, diverged).reason).toBe(
      "Diverged: the source schema is ahead in users_migration, the target schema in " +
        "orders_migration, so neither schema is simply newer."
    );
    const ahead = withGroups("public", "3.0.0", { users_migration: "3.0.0", orders_migration: "2.0.0" });
    expect(determineNewerSchema(left, ahead).reason).toBe(
      "The source schema is behind in orders_migration (v1.0.0 vs v2.0.0)."
    );
  });

  it("cuts a long list of groups so the reason stays one sentence", () => {
    const behind = { a: "1.0.0", b: "1.0.0", c: "1.0.0", d: "1.0.0", e: "1.0.0" };
    const ahead = { a: "2.0.0", b: "2.0.0", c: "2.0.0", d: "2.0.0", e: "2.0.0" };
    expect(determineNewerSchema(withGroups("dev", "2.0.0", ahead), withGroups("prod", "1.0.0", behind)).reason).toBe(
      "prod is behind in a (v1.0.0 vs v2.0.0), b (v1.0.0 vs v2.0.0), c (v1.0.0 vs v2.0.0) and 2 more."
    );
  });

  it("uses the one overall version when only one side has groups", () => {
    const verdict = determineNewerSchema(
      detected("dev", "2.0.0", 2_000_000, "semver", { users_migration: "2.0.0" }),
      detected("prod", "1.0.0", 1_000_000, "semver")
    );
    // dev keeps script groups, so its version was written by this app and
    // reads v2.0.0, the way the version bar's headline prints it.
    expect(verdict).toEqual({ newer: "left", reason: "dev is newer based on version v2.0.0." });
  });
});

describe("fetchSchemaVersionInfo", () => {
  const cfg = {} as Parameters<typeof fetchSchemaVersionInfo>[0];

  /** The two catalog reads that find the version table and list its columns. */
  function catalogSteps(table: string, columns: string[]): FakeStep[] {
    // Both catalog queries have an ORDER BY too, so they go before any step
    // that matches on ORDER BY.
    return [
      { match: /information_schema\.tables/, rows: [{ table_name: table }] },
      { match: /information_schema\.columns/, rows: columns.map((column_name) => ({ column_name })) },
    ];
  }

  it("reads each script group's head from the whole table, and each entry's group", async () => {
    mockClient = createFakeClient([
      ...catalogSteps("script_patch", ["id", "script_name", "version", "change_type", "applied_at", "sql_content"]),
      {
        match: /SELECT DISTINCT/,
        rows: [
          { script_name: "users_migration", version: "3.0.0" },
          { script_name: "users_migration", version: "1.0.0" },
          // Not among the rows the timeline read, and still this group's head.
          { script_name: "orders_migration", version: "1.0.0" },
        ],
      },
      {
        match: /ORDER BY/,
        rows: [
          {
            script_name: "users_migration",
            version: "3.0.0",
            change_type: "breaking",
            applied_at: new Date("2026-01-03T00:00:00Z"),
          },
          {
            script_name: "users_migration",
            version: "1.0.0",
            change_type: "additive",
            applied_at: new Date("2026-01-02T00:00:00Z"),
          },
        ],
      },
    ]);

    const info = await fetchSchemaVersionInfo(cfg, "public");
    expect(info.familyHeads).toEqual({ users_migration: "3.0.0", orders_migration: "1.0.0" });
    expect(info.timeline.map((entry) => entry.scriptName)).toEqual(["users_migration", "users_migration"]);
    expect(info.detectedVersion).toBe("3.0.0");

    // One row per version, from the whole table: no ORDER BY, no LIMIT.
    const heads = queriesMatching(mockClient, /SELECT DISTINCT/);
    expect(heads).toHaveLength(1);
    expect(heads[0].text).toBe('SELECT DISTINCT "script_name", "version" FROM "public"."script_patch"');
  });

  it("reads a success column too, so a failed run is not a head", async () => {
    mockClient = createFakeClient([
      ...catalogSteps("schema_version", ["script_name", "version", "success", "applied_at"]),
      {
        match: /SELECT DISTINCT/,
        rows: [
          { script_name: "g", version: "2.0.0", success: false },
          { script_name: "g", version: "1.0.0", success: true },
        ],
      },
    ]);

    const info = await fetchSchemaVersionInfo(cfg, "public");
    expect(info.familyHeads).toEqual({ g: "1.0.0" });
    expect(queriesMatching(mockClient, /SELECT DISTINCT/)[0].text).toBe(
      'SELECT DISTINCT "script_name", "version", "success" FROM "public"."schema_version"'
    );
  });

  it("reads no groups from a table without a script_name column", async () => {
    mockClient = createFakeClient([
      ...catalogSteps("flyway_schema_history", ["installed_rank", "version", "description", "installed_on", "success"]),
      {
        match: /ORDER BY/,
        rows: [{ installed_rank: 1, version: "1.0", description: "init", installed_on: "2024-01-01", success: true }],
      },
    ]);

    const info = await fetchSchemaVersionInfo(cfg, "public");
    expect(info.familyHeads).toBeNull();
    expect(info.timeline[0].scriptName).toBeNull();
    expect(queriesMatching(mockClient, /SELECT DISTINCT/)).toHaveLength(0);
  });

  it("reads a Liquibase changelog newest-first, by its own date and order columns", async () => {
    // Only a tagged changeset carries a version. The ones between it and the
    // next tag still belong in the timeline, listed without one — so the order
    // has to come from the columns Liquibase does fill in on every row.
    mockClient = createFakeClient([
      ...catalogSteps("databasechangelog", [
        "id", "author", "filename", "dateexecuted", "orderexecuted", "description", "tag",
      ]),
      {
        match: /ORDER BY/,
        rows: [
          { id: "3", author: "mei", dateexecuted: "2026-02-01", orderexecuted: 3, description: "add index", tag: null },
          { id: "2", author: "mei", dateexecuted: "2026-01-02", orderexecuted: 2, description: "release", tag: "2.0.0" },
        ],
      },
    ]);

    const info = await fetchSchemaVersionInfo(cfg, "public");
    expect(info.tableName).toBe("databasechangelog");
    expect(info.hasVersionTable).toBe(true);
    // Matched on the table, not on ORDER BY: the catalog read has one too.
    const query = queriesMatching(mockClient, /FROM "public"\."databasechangelog"/)[0].text;
    expect(query).toContain('ORDER BY "dateexecuted" DESC NULLS LAST, "orderexecuted" DESC NULLS LAST');
    // The untagged changeset is kept, with no version of its own.
    expect(info.timeline.map((entry) => entry.version)).toEqual([null, "2.0.0"]);
  });

  it("has no groups when there is no version table, or it cannot be read", async () => {
    mockClient = createFakeClient([]);
    expect((await fetchSchemaVersionInfo(cfg, "public")).familyHeads).toBeNull();

    mockClient = createFakeClient([
      { match: /information_schema\.tables/, error: { message: "permission denied for schema public" } },
    ]);
    const failed = await fetchSchemaVersionInfo(cfg, "public");
    expect(failed.familyHeads).toBeNull();
    expect(failed.message).toContain("permission denied for schema public");
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
