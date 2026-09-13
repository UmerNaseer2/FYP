// Rollback planning decides which SQL undoes a version and which versions a
// "roll back to" undoes. Getting it wrong either runs nothing while reporting
// success (a comment-only rollback), or undoes an older version under a newer
// one that still depends on it.
import { checkNewestFirst, loudestChangeLevel, resolveRollback, versionsToUndo } from "@/lib/rollback-plan";

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
