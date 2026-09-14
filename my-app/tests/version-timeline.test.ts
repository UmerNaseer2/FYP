import {
  compareFamilyHeads,
  displayVersion,
  familyGaps,
  familyHeadRows,
  familyHeadsOf,
  hasFamilyHeads,
  ledgerTimelineEntries,
  listNames,
  mergeTimelines,
  outdatedSideFor,
  outdatedSideOfEntries,
  pushMovesTargetBack,
  scriptsMatch,
  timelineKey,
  type TimelineEntry,
  type TimelineRow,
} from "@/lib/version-timeline";
import type { LedgerEntry } from "@/lib/version-sync";

// The merged timeline and the per-group verdict. Both are pure, and both feed
// words the screens print: a row the merge gets wrong is a version shown as
// missing when it ran, and a verdict it gets wrong is an "(Outdated)" on the
// wrong side.

/** A timeline entry with only what a test is about set. */
function entry(
  version: string,
  scriptName: string | null = "users_migration",
  extra: Partial<TimelineEntry> = {}
): TimelineEntry {
  return { scriptName, version, appliedAt: null, changeType: "unknown", sqlContent: null, ...extra };
}

/** The rows as "group version" strings, in order, so an expectation fits on one line. */
function order(rows: TimelineRow[]): string[] {
  return rows.map((row) => `${row.family ?? "-"} ${row.version}`);
}

describe("mergeTimelines", () => {
  it("puts v1.2.0 on one side and 1.2.0 on the other in one row", () => {
    const rows = mergeTimelines([entry("v1.2.0")], [entry("1.2.0")]);
    expect(rows).toHaveLength(1);
    expect(rows[0].left?.version).toBe("v1.2.0");
    expect(rows[0].right?.version).toBe("1.2.0");
    // The left side's spelling when it has the version.
    expect(rows[0].version).toBe("v1.2.0");
  });

  it("keeps two script groups apart, even with the same version", () => {
    const rows = mergeTimelines([entry("1.0.0", "users_migration")], [entry("1.0.0", "orders_migration")]);
    expect(order(rows)).toEqual(["orders_migration 1.0.0", "users_migration 1.0.0"]);
    expect(rows[0].left).toBeNull();
    expect(rows[1].right).toBeNull();
  });

  it("marks each side's head in each group", () => {
    const rows = mergeTimelines(
      [entry("1.0.0"), entry("2.0.0"), entry("1.0.0", "orders_migration")],
      [entry("1.0.0"), entry("1.0.0", "orders_migration"), entry("1.1.0", "orders_migration")]
    );
    const find = (family: string, version: string) =>
      rows.find((row) => row.family === family && row.version === version);
    expect(find("users_migration", "2.0.0")).toMatchObject({ isLeftHead: true, isRightHead: false });
    expect(find("users_migration", "1.0.0")).toMatchObject({ isLeftHead: false, isRightHead: true });
    expect(find("orders_migration", "1.0.0")).toMatchObject({ isLeftHead: true, isRightHead: false });
    expect(find("orders_migration", "1.1.0")).toMatchObject({ isLeftHead: false, isRightHead: true });
  });

  it("leaves left null for a version only the right side has, spelled as the right side wrote it", () => {
    const rows = mergeTimelines([entry("1.0.0")], [entry("1.0.0"), entry("v1.3.0")]);
    expect(order(rows)).toEqual(["users_migration v1.3.0", "users_migration 1.0.0"]);
    const rightOnly = rows[0];
    expect(rightOnly.left).toBeNull();
    expect(rightOnly.right?.version).toBe("v1.3.0");
    expect(rightOnly.version).toBe("v1.3.0");
    expect(rightOnly.leftUnknown).toBe(false);
  });

  it("orders newest first, part by part", () => {
    const rows = mergeTimelines([entry("1.9.9"), entry("1.2.0")], [entry("1.10.0")]);
    expect(order(rows)).toEqual([
      "users_migration 1.10.0",
      "users_migration 1.9.9",
      "users_migration 1.2.0",
    ]);
  });

  it("puts the rows with no group first, then the groups by name", () => {
    const rows = mergeTimelines([entry("1.0.0", "b"), entry("1.0.0", null), entry("1.0.0", "a")], []);
    expect(rows.map((row) => row.family)).toEqual([null, "a", "b"]);
  });

  it("puts names that are not versions below the versions, newest applied first", () => {
    const rows = mergeTimelines(
      [
        entry("baseline", null, { appliedAt: "2024-01-01T00:00:00Z" }),
        entry("init", null, { appliedAt: "2024-02-01T00:00:00Z" }),
        entry("1.0.0", null),
      ],
      []
    );
    expect(order(rows)).toEqual(["- 1.0.0", "- init", "- baseline"]);
  });

  it("does not merge two Laravel migrations that share their digits", () => {
    // versionKey reads only the digits, and both names start with the same
    // timestamp. Merging them would show one migration where two ran.
    const rows = mergeTimelines(
      [
        entry("2024_01_15_000000_create_users", null, { appliedAt: "2024-01-15T00:00:00Z" }),
        entry("2024_01_15_000000_create_posts", null, { appliedAt: "2024-01-16T00:00:00Z" }),
      ],
      [entry("2024_01_15_000000_create_users", null)]
    );
    expect(order(rows)).toEqual([
      "- 2024_01_15_000000_create_posts",
      "- 2024_01_15_000000_create_users",
    ]);
    expect(rows[1].right).not.toBeNull();
    expect(rows[0].right).toBeNull();
  });

  it("keeps the first of two entries for one version, unless it failed and a later one did not", () => {
    const twice = mergeTimelines([entry("1.0.0", "g", { label: "first" }), entry("1.0.0", "g", { label: "second" })], []);
    expect(twice).toHaveLength(1);
    expect(twice[0].left?.label).toBe("first");

    const retried = mergeTimelines(
      [entry("1.0.0", "g", { label: "failed run", failed: true }), entry("v1.0.0", "g", { label: "retry" })],
      []
    );
    expect(retried).toHaveLength(1);
    expect(retried[0].left?.label).toBe("retry");
    expect(retried[0].isLeftHead).toBe(true);
  });

  it("never marks a failed run as the head", () => {
    const rows = mergeTimelines([entry("2.0.0", "g", { failed: true }), entry("1.0.0", "g")], []);
    expect(order(rows)).toEqual(["g 2.0.0", "g 1.0.0"]);
    expect(rows[0].isLeftHead).toBe(false);
    expect(rows[1].isLeftHead).toBe(true);
  });

  it("takes the entry its reader marked as current over the highest version", () => {
    const rows = mergeTimelines([entry("2.0.0", "g"), entry("1.5.0", "g", { isHead: true })], []);
    expect(rows.find((row) => row.version === "1.5.0")?.isLeftHead).toBe(true);
    expect(rows.find((row) => row.version === "2.0.0")?.isLeftHead).toBe(false);
  });

  it("ignores a current mark on a failed run", () => {
    const rows = mergeTimelines([entry("2.0.0", "g"), entry("1.5.0", "g", { isHead: true, failed: true })], []);
    expect(rows.find((row) => row.version === "2.0.0")?.isLeftHead).toBe(true);
  });

  it("grades a row by the louder of its two sides", () => {
    const rows = mergeTimelines(
      [entry("1.0.0", "g", { changeType: "patch" })],
      [entry("1.0.0", "g", { changeType: "breaking" })]
    );
    expect(rows[0].changeType).toBe("breaking");
    const oneSide = mergeTimelines([entry("1.0.0", "g", { changeType: "additive" })], []);
    expect(oneSide[0].changeType).toBe("additive");
  });

  it("skips an entry with a blank version", () => {
    expect(mergeTimelines([entry("   ")], [])).toEqual([]);
  });

  describe("with a partial side", () => {
    it("marks a version below the oldest one the partial side shows as not known there", () => {
      const rows = mergeTimelines(
        [entry("3.0.0"), entry("2.0.0")],
        [entry("3.0.0"), entry("2.0.0"), entry("1.0.0")],
        { leftPartial: true }
      );
      expect(order(rows)).toEqual([
        "users_migration 3.0.0",
        "users_migration 2.0.0",
        "users_migration 1.0.0",
      ]);
      expect(rows[2].left).toBeNull();
      expect(rows[2].leftUnknown).toBe(true);
      expect(rows[0].leftUnknown).toBe(false);
      expect(rows[2].rightUnknown).toBe(false);
    });

    it("reads a version above the partial side's oldest as missing there", () => {
      const rows = mergeTimelines([entry("3.0.0"), entry("1.0.0")], [entry("2.0.0")], { leftPartial: true });
      const middle = rows.find((row) => row.version === "2.0.0") as TimelineRow;
      expect(middle.left).toBeNull();
      expect(middle.leftUnknown).toBe(false);
    });

    it("reads a group the partial side shows nothing of as a group it does not have", () => {
      const rows = mergeTimelines(
        [entry("1.0.0", "users_migration")],
        [entry("1.0.0", "orders_migration")],
        { leftPartial: true }
      );
      const orders = rows.find((row) => row.family === "orders_migration") as TimelineRow;
      expect(orders.leftUnknown).toBe(false);
    });

    it("keeps the other side's head even when it is below the partial side's oldest", () => {
      // The row is marked, not dropped: the headline names this version, so
      // the timeline under it must show it too.
      const rows = mergeTimelines([entry("5.0.0"), entry("4.0.0")], [entry("2.0.0")], { leftPartial: true });
      const head = rows.find((row) => row.version === "2.0.0") as TimelineRow;
      expect(head.isRightHead).toBe(true);
      expect(head.leftUnknown).toBe(true);
    });

    it("marks a name that is not a version as not known on the partial side", () => {
      const rows = mergeTimelines([entry("1.0.0", null)], [entry("baseline", null)], { leftPartial: true });
      expect(rows.find((row) => row.version === "baseline")?.leftUnknown).toBe(true);
    });

    it("marks nothing unknown when neither side is partial", () => {
      const rows = mergeTimelines([entry("3.0.0")], [entry("3.0.0"), entry("1.0.0")]);
      expect(rows.every((row) => !row.leftUnknown && !row.rightUnknown)).toBe(true);
    });
  });
});

describe("compareFamilyHeads", () => {
  it("is the same when every group has the same head, however it is spelled", () => {
    expect(compareFamilyHeads({ users_migration: "1.0.0" }, { users_migration: "v1.0.0" })).toEqual({
      verdict: "same",
      leftAheadIn: [],
      rightAheadIn: [],
    });
  });

  it("says the left side is behind when the right side is ahead in a group and behind in none", () => {
    expect(
      compareFamilyHeads(
        { users_migration: "1.0.0", orders_migration: "2.0.0" },
        { users_migration: "3.0.0", orders_migration: "2.0.0" }
      )
    ).toEqual({ verdict: "left-behind", leftAheadIn: [], rightAheadIn: ["users_migration"] });
  });

  it("says the right side is behind the other way round", () => {
    expect(compareFamilyHeads({ users_migration: "3.0.0" }, { users_migration: "1.0.0" })).toEqual({
      verdict: "right-behind",
      leftAheadIn: ["users_migration"],
      rightAheadIn: [],
    });
  });

  it("says diverged when each side is ahead somewhere, and lists both", () => {
    expect(
      compareFamilyHeads(
        { users_migration: "3.0.0", orders_migration: "1.0.0" },
        { users_migration: "1.0.0", orders_migration: "2.0.0" }
      )
    ).toEqual({ verdict: "diverged", leftAheadIn: ["users_migration"], rightAheadIn: ["orders_migration"] });
  });

  it("counts a group only one side has as that side being ahead", () => {
    expect(
      compareFamilyHeads({ users_migration: "1.0.0", billing: "1.0.0" }, { users_migration: "1.0.0" })
    ).toEqual({ verdict: "right-behind", leftAheadIn: ["billing"], rightAheadIn: [] });
    expect(compareFamilyHeads({}, { billing: "1.0.0" })).toEqual({
      verdict: "left-behind",
      leftAheadIn: [],
      rightAheadIn: ["billing"],
    });
  });
});

describe("familyHeadRows", () => {
  it("lists every group either side has, by name, with the side that is behind", () => {
    expect(familyHeadRows({ b: "1.0.0", a: "2.0.0" }, { a: "1.0.0", c: "1.0.0", b: "1.0" })).toEqual([
      { family: "a", left: "2.0.0", right: "1.0.0", older: "right" },
      { family: "b", left: "1.0.0", right: "1.0", older: null },
      { family: "c", left: null, right: "1.0.0", older: "left" },
    ]);
  });

  it("reads a group called constructor as a group, not as Object's constructor", () => {
    expect(familyHeadRows({}, { constructor: "1.0.0" })).toEqual([
      { family: "constructor", left: null, right: "1.0.0", older: "left" },
    ]);
  });
});

describe("familyHeadsOf", () => {
  it("takes each group's highest version that ran", () => {
    expect(
      familyHeadsOf([
        { scriptName: "users_migration", version: "1.0.0" },
        { scriptName: "users_migration", version: "3.0.0" },
        { scriptName: "users_migration", version: "4.0.0", failed: true },
        { scriptName: "users_migration", version: null },
        { scriptName: "orders_migration", version: "baseline" },
        { scriptName: "orders_migration", version: "2.0.0" },
        { scriptName: "   ", version: "9.0.0" },
        { scriptName: null, version: "9.0.0" },
      ])
    ).toEqual({ users_migration: "3.0.0", orders_migration: "2.0.0" });
  });

  it("keeps the first of two equal versions", () => {
    expect(
      familyHeadsOf([
        { scriptName: "g", version: "1.2" },
        { scriptName: "g", version: "1.2.0" },
      ])
    ).toEqual({ g: "1.2" });
  });

  it("keeps a group called __proto__ as a key", () => {
    const heads = familyHeadsOf([{ scriptName: "__proto__", version: "1.0.0" }]);
    expect(Object.keys(heads)).toEqual(["__proto__"]);
    expect(Object.getPrototypeOf(heads)).toBe(Object.prototype);
  });

  it("is empty when no row names a group", () => {
    expect(familyHeadsOf([{ scriptName: null, version: "1.0.0" }])).toEqual({});
  });
});

describe("the small rules the screens share", () => {
  it("hasFamilyHeads is true only for a map that names a group", () => {
    expect(hasFamilyHeads(null)).toBe(false);
    expect(hasFamilyHeads(undefined)).toBe(false);
    expect(hasFamilyHeads({})).toBe(false);
    expect(hasFamilyHeads({ g: "1.0.0" })).toBe(true);
  });

  it("outdatedSideFor puts (Outdated) on the side a verdict says is behind", () => {
    expect(outdatedSideFor("left")).toBe("right");
    expect(outdatedSideFor("right")).toBe("left");
    expect(outdatedSideFor("same")).toBeNull();
    expect(outdatedSideFor("diverged")).toBeNull();
    expect(outdatedSideFor("unknown")).toBeNull();
    expect(outdatedSideFor(null)).toBeNull();
  });

  it("displayVersion prints this app's versions as v1.2.0 and other tools' as written", () => {
    expect(displayVersion("1.2.0", true)).toBe("v1.2.0");
    expect(displayVersion(" v1.2.0 ", true)).toBe("v1.2.0");
    expect(displayVersion("baseline", true)).toBe("baseline");
    expect(displayVersion("1.4", false)).toBe("1.4");
    expect(displayVersion("20240115120000", false)).toBe("20240115120000");
  });

  it("listNames joins names into one sentence and cuts a long list", () => {
    expect(listNames([])).toBe("");
    expect(listNames(["a"])).toBe("a");
    expect(listNames(["a", "b"])).toBe("a and b");
    expect(listNames(["a", "b", "c"])).toBe("a, b and c");
    expect(listNames(["a", "b", "c", "d", "e"])).toBe("a, b, c and 2 more");
  });

  it("scriptsMatch ignores line endings and surrounding whitespace, nothing else", () => {
    expect(scriptsMatch("SELECT 1;\r\nSELECT 2;\r\n", "SELECT 1;\nSELECT 2;")).toBe(true);
    expect(scriptsMatch("  SELECT 1; ", "SELECT 1;")).toBe(true);
    expect(scriptsMatch("SELECT 1;", "SELECT 2;")).toBe(false);
  });

  it("timelineKey matches v1.2.0 and 1.2.0, and keeps two Laravel names apart", () => {
    expect(timelineKey("v1.2.0")).toBe(timelineKey("1.2.0"));
    expect(timelineKey(" 1.2.0 ")).toBe(timelineKey("1.2.0"));
    expect(timelineKey("1.2.0")).not.toBe(timelineKey("1.2.1"));
    // versionKey reads only digits, so these two would share a key through it.
    expect(timelineKey("2024_01_15_000000_create_users")).not.toBe(
      timelineKey("2024_01_15_000000_create_posts")
    );
    // A row carries this key, so a screen finds the row for a version it holds
    // (Deploy's revertable version) whichever way either side spelled it.
    const [row] = mergeTimelines([entry("v1.2.0")], []);
    expect(row.key).toBe(timelineKey("1.2.0"));
  });
});

describe("the rules the version bar, the push button and the screens share", () => {
  it("familyGaps names each group a side is behind in, its own head first", () => {
    const rows = familyHeadRows({ a: "1.0.0", b: "2.0.0", c: "1.0.0" }, { a: "3.0.0", b: "1.0.0" });
    expect(familyGaps(rows, "left")).toBe("a (v1.0.0 vs v3.0.0)");
    // A side with no version in a group reads "none", as the bar's table does.
    expect(familyGaps(rows, "right")).toBe("b (v1.0.0 vs v2.0.0) and c (none vs v1.0.0)");
  });

  it("pushMovesTargetBack is true only for a target ahead, with something to push", () => {
    expect(pushMovesTargetBack("right", false)).toBe(true);
    expect(pushMovesTargetBack("diverged", false)).toBe(true);
    expect(pushMovesTargetBack("right", true)).toBe(false);
    expect(pushMovesTargetBack("diverged", true)).toBe(false);
    for (const newer of ["left", "same", "unknown", null, undefined] as const) {
      expect(pushMovesTargetBack(newer, false)).toBe(false);
    }
  });

  it("outdatedSideOfEntries judges two complete lists group by group", () => {
    // The right side lacks v2.0.0.
    expect(outdatedSideOfEntries([entry("1.0.0"), entry("2.0.0")], [entry("1.0.0")])).toBe("right");
    // A database with nothing applied is behind a registry that holds versions.
    expect(outdatedSideOfEntries([], [entry("1.0.0")])).toBe("left");
    // The same head, spelled two ways.
    expect(outdatedSideOfEntries([entry("v1.2.0")], [entry("1.2.0")])).toBeNull();
    // Each side is ahead in one group.
    expect(
      outdatedSideOfEntries(
        [entry("2.0.0", "orders"), entry("1.0.0", "users_migration")],
        [entry("1.0.0", "orders"), entry("2.0.0", "users_migration")]
      )
    ).toBeNull();
    // A failed run is not a head, so it puts nobody behind.
    expect(
      outdatedSideOfEntries([entry("2.0.0", "users_migration", { failed: true }), entry("1.0.0")], [entry("1.0.0")])
    ).toBeNull();
    // Entries without a script group count for nothing.
    expect(outdatedSideOfEntries([entry("2.0.0", null)], [entry("1.0.0", null)])).toBeNull();
  });
});

/** A row as GET /api/versionsync/ledger sends it. */
function ledgerRow(version: string, extra: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    scriptName: "users_migration",
    version,
    changeType: "additive",
    appliedAt: "2026-01-01T00:00:00.000Z",
    hasSql: true,
    sqlContent: "CREATE TABLE t (id int);",
    downSql: null,
    ...extra,
  };
}

describe("ledgerTimelineEntries", () => {
  it("grades each row by its change_type and keeps its script", () => {
    const entries = ledgerTimelineEntries([
      ledgerRow("1.0.0", { changeType: "breaking" }),
      ledgerRow("1.1.0", { changeType: "minor", hasSql: false, sqlContent: null }),
      ledgerRow("1.1.1", { changeType: "nonsense" }),
    ]);
    expect(entries.map((item) => item.changeType)).toEqual(["breaking", "additive", "unknown"]);
    expect(entries[0]).toEqual({
      scriptName: "users_migration",
      version: "1.0.0",
      appliedAt: "2026-01-01T00:00:00.000Z",
      changeType: "breaking",
      sqlContent: "CREATE TABLE t (id int);",
      label: null,
    });
    expect(entries[1].sqlContent).toBeNull();
  });
});
