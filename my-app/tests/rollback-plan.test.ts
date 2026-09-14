// Rollback planning decides which SQL undoes a version and which versions a
// "roll back to" undoes. Getting it wrong either runs nothing while reporting
// success (a comment-only rollback), or undoes an older version under a newer
// one that still depends on it.
import {
  checkNewestFirst,
  listVersions,
  loudestChangeLevel,
  MAX_ROLLBACK_VERSIONS,
  planRollback,
  resolveRollback,
  rollbackTargets,
  versionsToUndo,
  vLabel,
} from "@/lib/rollback-plan";

describe("resolveRollback", () => {
  it("prefers the copy stored in the ledger", () => {
    expect(resolveRollback("DROP TABLE a;", "DROP TABLE b;")).toEqual({ sql: "DROP TABLE a;", source: "ledger" });
  });

  it("falls through a comment-only ledger copy to the registry copy", () => {
    expect(resolveRollback("-- nothing here", "DROP TABLE b;")).toEqual({ sql: "DROP TABLE b;", source: "registry" });
    expect(resolveRollback(null, "DROP TABLE b;")).toEqual({ sql: "DROP TABLE b;", source: "registry" });
  });

  it("refuses a copy that ends the transaction itself", () => {
    expect(resolveRollback("DROP TABLE a;\nCOMMIT;", null)).toEqual({ problem: "transaction_control" });
    // A usable registry copy still wins over a refused ledger copy.
    expect(resolveRollback("DROP TABLE a;\nCOMMIT;", "DROP TABLE b;")).toEqual({
      sql: "DROP TABLE b;",
      source: "registry",
    });
  });

  it("reports no rollback when neither copy runs anything", () => {
    expect(resolveRollback(null, null)).toEqual({ problem: "none" });
    expect(resolveRollback("-- x", "   ")).toEqual({ problem: "none" });
  });
});

describe("versionsToUndo", () => {
  const applied = ["1.0.0", "1.1.0", "2.0.0"];

  it("undoes every version above the target, newest first", () => {
    expect(versionsToUndo(applied, "1.0.0")).toEqual(["2.0.0", "1.1.0"]);
    expect(versionsToUndo(applied, "1.1")).toEqual(["2.0.0"]);
    expect(versionsToUndo(applied, "2.0.0")).toEqual([]);
  });

  it("undoes everything when the target is before the first version", () => {
    expect(versionsToUndo(applied, null)).toEqual(["2.0.0", "1.1.0", "1.0.0"]);
  });
});

describe("checkNewestFirst", () => {
  const applied = ["1.0.0", "2.0.0", "3.0.0"];

  it("accepts the newest versions, each once", () => {
    expect(checkNewestFirst(applied, ["3.0.0"])).toEqual({ ok: true });
    expect(checkNewestFirst(applied, ["2.0", "3.0.0"])).toEqual({ ok: true });
    expect(checkNewestFirst(applied, [])).toEqual({ ok: true });
  });

  it("names the newer versions that must be undone too", () => {
    expect(checkNewestFirst(applied, ["2.0.0"])).toEqual({
      ok: false,
      mustAlsoUndo: ["3.0.0"],
      duplicates: [],
      notApplied: [],
    });
    expect(checkNewestFirst(applied, ["3.0.0", "1.0.0"])).toEqual({
      ok: false,
      mustAlsoUndo: ["2.0.0"],
      duplicates: [],
      notApplied: [],
    });
  });

  it("catches one version asked for twice under two spellings", () => {
    expect(checkNewestFirst(["1.0.0", "2.0.0"], ["2.0", "2.0.0"])).toEqual({
      ok: false,
      mustAlsoUndo: [],
      duplicates: ["2.0.0"],
      notApplied: [],
    });
  });

  it("catches a version that is not applied", () => {
    expect(checkNewestFirst(["1.0.0"], ["4.0.0"])).toEqual({
      ok: false,
      mustAlsoUndo: [],
      duplicates: [],
      notApplied: ["4.0.0"],
    });
  });
});

describe("loudestChangeLevel", () => {
  it("records the loudest level in a batch", () => {
    expect(loudestChangeLevel(["patch", "breaking", "additive"])).toBe("breaking");
    expect(loudestChangeLevel(["additive", "patch"])).toBe("additive");
    expect(loudestChangeLevel(["unknown", "patch"])).toBe("patch");
    expect(loudestChangeLevel([])).toBe("unknown");
  });
});

// The revert route's messages and the Deploy screen name versions with these,
// so "v1.2.0" never turns into "vv1.2.0" on one side.
describe("vLabel and listVersions", () => {
  it("adds one v, whichever way the version was written", () => {
    expect(vLabel("1.2.0")).toBe("v1.2.0");
    expect(vLabel(" v1.2.0 ")).toBe("v1.2.0");
    expect(vLabel("V1.2")).toBe("v1.2");
  });

  it("joins a list the way a sentence would", () => {
    expect(listVersions([])).toBe("");
    expect(listVersions(["3.0.0"])).toBe("v3.0.0");
    expect(listVersions(["3.0.0", "2.0.0"])).toBe("v3.0.0 and v2.0.0");
    expect(listVersions(["3.0.0", "v2.0.0", "1.0.0"])).toBe("v3.0.0, v2.0.0 and v1.0.0");
  });
});

// The Deploy screen previews exactly this plan, and the approval fingerprint
// is built from it, so it has to pick what the revert route will run.
describe("planRollback", () => {
  const applied = [
    { version: "1.0.0", applied_at: "2026-01-01T00:00:00Z", down_sql: "DROP TABLE a;" },
    { version: "1.1.0", applied_at: "2026-02-01T00:00:00Z", down_sql: null },
    { version: "2.0.0", applied_at: "2026-03-01T00:00:00Z", down_sql: "DROP TABLE c;" },
  ];
  const registry = [
    { version: "1.0.0", down_sql: "DROP TABLE a;\r\n", state: "usable" },
    { version: "1.1", down_sql: "DROP TABLE b;", state: "usable" },
    { version: "2.0.0", down_sql: "DROP TABLE c CASCADE;", state: "usable" },
  ];

  it("lists every version above the target, newest first, as the ledger spells it", () => {
    expect(planRollback(applied, registry, "1.0.0").map((step) => step.version)).toEqual(["2.0.0", "1.1.0"]);
    expect(planRollback(applied, registry, null).map((step) => step.version)).toEqual(["2.0.0", "1.1.0", "1.0.0"]);
    expect(planRollback(applied, registry, "2.0.0")).toEqual([]);
  });

  it("runs the saved copy, and says when the registry's file is different", () => {
    const [newest] = planRollback(applied, registry, "1.1.0");
    expect(newest.resolved).toEqual({ sql: "DROP TABLE c;", source: "ledger" });
    expect(newest.registryDiffers).toBe(true);
    // Only a line ending apart: not a difference worth reporting.
    const oldest = planRollback(applied, registry, null)[2];
    expect(oldest.resolved).toEqual({ sql: "DROP TABLE a;", source: "ledger" });
    expect(oldest.registryDiffers).toBe(false);
  });

  it("falls back to the registry's copy, found under another spelling, and keeps the entry", () => {
    const step = planRollback(applied, registry, "1.0.0")[1];
    expect(step.version).toBe("1.1.0");
    expect(step.resolved).toEqual({ sql: "DROP TABLE b;", source: "registry" });
    expect(step.registry).toEqual({ version: "1.1", down_sql: "DROP TABLE b;", state: "usable" });
    expect(step.registryDiffers).toBe(false);
  });

  it("reports a version that has no rollback anywhere", () => {
    expect(planRollback([{ version: "3.0.0", applied_at: null }], [], null)).toEqual([
      { version: "3.0.0", appliedAt: null, resolved: { problem: "none" }, registry: null, registryDiffers: false },
    ]);
  });
});

describe("rollbackTargets", () => {
  // Applied versions newest first: "count.0.0" down to "1.0.0".
  const applied = (count: number) => Array.from({ length: count }, (_, index) => `${count - index}.0.0`);

  it("offers each earlier version, then before the first one, with how many versions each undoes", () => {
    expect(rollbackTargets(["3.0.0", "2.0.0", "1.0.0"])).toEqual([
      { target: "2.0.0", undoCount: 1 },
      { target: "1.0.0", undoCount: 2 },
      { target: null, undoCount: 3 },
    ]);
  });

  it("offers nothing when nothing is applied", () => {
    expect(rollbackTargets([])).toEqual([]);
  });

  it("still offers 'before the first version' when that undoes exactly the most one rollback may", () => {
    const targets = rollbackTargets(applied(MAX_ROLLBACK_VERSIONS));
    expect(targets[targets.length - 1]).toEqual({ target: null, undoCount: MAX_ROLLBACK_VERSIONS });
  });

  it("leaves out every choice the revert route would refuse as too long", () => {
    const versions = applied(MAX_ROLLBACK_VERSIONS + 1);
    const targets = rollbackTargets(versions);
    expect(targets.every((choice) => choice.undoCount <= MAX_ROLLBACK_VERSIONS)).toBe(true);
    expect(targets.some((choice) => choice.target === null)).toBe(false);
    expect(targets[targets.length - 1]).toEqual({ target: "1.0.0", undoCount: MAX_ROLLBACK_VERSIONS });
    // The count shown is the number the request will carry.
    expect(versionsToUndo(versions, "1.0.0")).toHaveLength(MAX_ROLLBACK_VERSIONS);
  });
});
