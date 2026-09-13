import { familyVersions } from "@/lib/registry-push";
import {
  FIRST_VERSION,
  bumpToLevel,
  bumpVersion,
  buildVersionLedger,
  checkNewVersion,
  compareVersions,
  highestVersion,
  isValidSemver,
  levelOfStep,
  levelToBump,
  looksLikeVersion,
  normalizeVersion,
  parseSemver,
  suggestBumpLevel,
  versionParts,
} from "@/lib/script-status";

describe("version parsing", () => {
  it("drops a leading v and pads to three parts when comparing", () => {
    expect(versionParts("v1.2.3")).toEqual([1, 2, 3]);
    expect(compareVersions("1.2", "1.2.0")).toBe(0);
    expect(compareVersions("v1.2.0", "1.2")).toBe(0);
  });

  it("orders versions numerically, not as strings", () => {
    // The string compare that this replaced put "1.10.0" before "1.9.0".
    expect(compareVersions("1.10.0", "1.9.0")).toBeGreaterThan(0);
    expect(compareVersions("2.0.0", "10.0.0")).toBeLessThan(0);
  });

  it("accepts one to three numeric segments and nothing else", () => {
    expect(parseSemver("2")).toEqual({ major: 2, minor: 0, patch: 0 });
    expect(parseSemver("v2.1")).toEqual({ major: 2, minor: 1, patch: 0 });
    expect(parseSemver("1.2.3.4")).toBeNull();
    expect(parseSemver("1.2.beta")).toBeNull();
    expect(parseSemver("")).toBeNull();
    expect(isValidSemver("1.0.0")).toBe(true);
    expect(isValidSemver("latest")).toBe(false);
  });

  it("normalises to X.Y.Z", () => {
    expect(normalizeVersion("v2.1")).toBe("2.1.0");
    expect(normalizeVersion("nope")).toBeNull();
  });
});

describe("bumpVersion", () => {
  it("bumps each level and zeroes the parts below it", () => {
    expect(bumpVersion("1.4.7", "major")).toBe("2.0.0");
    expect(bumpVersion("1.4.7", "minor")).toBe("1.5.0");
    expect(bumpVersion("1.4.7", "patch")).toBe("1.4.8");
  });

  it("starts a new family at 1.0.0 whatever level is picked", () => {
    // Bumping from 0.0.0 used to give 0.1.0 or 0.0.1 for a family's first
    // script; the first version of every family is 1.0.0.
    for (const level of ["major", "minor", "patch"] as const) {
      expect(bumpVersion(null, level)).toBe(FIRST_VERSION);
      expect(bumpVersion("", level)).toBe("1.0.0");
      expect(bumpVersion("garbage", level)).toBe("1.0.0");
    }
  });

  it("reads a v prefix and spaces on the floor", () => {
    expect(bumpVersion(" v1.2 ", "minor")).toBe("1.3.0");
  });

  it("still lands above a four-segment floor", () => {
    // A version like this can arrive from outside the app. Collapsing it to
    // 0.0.0 would suggest a version BELOW the floor and leave the editor's
    // picker with every preset disabled.
    expect(bumpVersion("1.2.0.3", "patch")).toBe("1.2.1");
  });
});

describe("suggestBumpLevel", () => {
  it("calls destructive and rewriting changes major", () => {
    expect(suggestBumpLevel("DROP TABLE orders;")).toBe("major");
    expect(suggestBumpLevel("ALTER TABLE t ALTER COLUMN a TYPE text;")).toBe("major");
    expect(suggestBumpLevel("ALTER TABLE t RENAME TO t2;")).toBe("major");
  });

  it("calls purely additive changes minor", () => {
    expect(suggestBumpLevel("CREATE TABLE orders (id int);")).toBe("minor");
    expect(suggestBumpLevel("ALTER TABLE t ADD COLUMN note text;")).toBe("minor");
  });

  it("falls back to patch", () => {
    expect(suggestBumpLevel("COMMENT ON TABLE t IS 'hi';")).toBe("patch");
    expect(suggestBumpLevel("")).toBe("patch");
  });

  // It used to search the text itself, comments included, so a script that
  // only mentioned a drop in a comment was suggested as a major version.
  it("ignores a drop that is only written in a comment", () => {
    expect(suggestBumpLevel("-- drop table x\nCREATE TABLE y(id int);")).toBe("minor");
  });

  // Deploy has always called this breaking; the old search called it a patch.
  it("agrees with Deploy that dropping a view is major", () => {
    expect(suggestBumpLevel("DROP VIEW v;")).toBe("major");
  });

  it("no longer calls a changed default or a dropped NOT NULL major", () => {
    expect(suggestBumpLevel("ALTER TABLE t ALTER COLUMN a SET DEFAULT 0;")).toBe("patch");
    expect(suggestBumpLevel("ALTER TABLE t ALTER COLUMN a DROP NOT NULL;")).toBe("patch");
  });
});

describe("levelToBump and bumpToLevel", () => {
  it("map breaking/additive/patch onto major/minor/patch and back", () => {
    expect(levelToBump("breaking")).toBe("major");
    expect(levelToBump("additive")).toBe("minor");
    expect(levelToBump("patch")).toBe("patch");
    expect(bumpToLevel("major")).toBe("breaking");
    expect(bumpToLevel("minor")).toBe("additive");
    expect(bumpToLevel("patch")).toBe("patch");
  });
});

describe("levelOfStep", () => {
  it("reads the kind of step from the first part that changes", () => {
    expect(levelOfStep("1.2.3", "2.0.0")).toBe("breaking");
    expect(levelOfStep("1.2.3", "1.3.0")).toBe("additive");
    expect(levelOfStep("1.2.3", "1.2.4")).toBe("patch");
  });

  it("has no step to read without a previous version", () => {
    expect(levelOfStep(null, "1.0.0")).toBeNull();
    expect(levelOfStep("  ", "1.0.0")).toBeNull();
  });

  it("reads a four-part outside version as the patch step it looks like", () => {
    expect(levelOfStep("1.2.0.3", "1.2.1")).toBe("patch");
  });

  it("is not a step when the number stands still or goes backwards", () => {
    expect(levelOfStep("1.2.3", "1.2.3")).toBeNull();
    expect(levelOfStep("v1.2", "1.2.0")).toBeNull();
    expect(levelOfStep("2.0.0", "1.9.9")).toBeNull();
  });
});

describe("buildVersionLedger", () => {
  const applied = (version: string) => ({ version, applied_at: "2026-01-01T00:00:00Z" });

  it("labels applied, pending and superseded against the target history", () => {
    const ledger = buildVersionLedger(
      ["1.0.0", "1.1.0", "1.2.0", "1.3.0"],
      [applied("1.0.0"), applied("1.2.0")]
    );
    const byVersion = Object.fromEntries(ledger.map((e) => [e.version, e.status]));

    expect(byVersion["1.0.0"]).toBe("applied");
    expect(byVersion["1.2.0"]).toBe("applied");
    // Below the high-water mark and never applied — an out-of-order apply left
    // it behind, and a forward-only deploy will not pick it up.
    expect(byVersion["1.1.0"]).toBe("superseded");
    expect(byVersion["1.3.0"]).toBe("pending");
  });

  it("sorts ascending by version", () => {
    const ledger = buildVersionLedger(["1.10.0", "1.2.0", "1.9.0"], []);
    expect(ledger.map((e) => e.version)).toEqual(["1.2.0", "1.9.0", "1.10.0"]);
  });

  it("treats a fresh target as all pending", () => {
    const ledger = buildVersionLedger(["1.0.0", "1.1.0"], []);
    expect(ledger.every((e) => e.status === "pending")).toBe(true);
  });

  it("carries the applied timestamp through", () => {
    const ledger = buildVersionLedger(["1.0.0"], [applied("1.0.0")]);
    expect(ledger[0].appliedAt).toBe("2026-01-01T00:00:00Z");
  });

  // A Version Sync replay lands a version in script_patch without writing any
  // file to the registry for that schema. Dropping it from the ledger hid it
  // completely, which is how a stale older version came to look like the newest
  // applied one and got offered for rollback.
  it("lists an applied version the registry does not have", () => {
    const ledger = buildVersionLedger(["1.0.0"], [applied("1.0.0"), applied("2.0.0")]);
    expect(ledger.map((e) => e.version)).toEqual(["1.0.0", "2.0.0"]);
    expect(ledger.map((e) => e.status)).toEqual(["applied", "applied"]);
  });

  it("says which versions the registry actually holds", () => {
    const ledger = buildVersionLedger(["1.0.0", "1.1.0"], [applied("1.0.0"), applied("2.0.0")]);
    const byVersion = Object.fromEntries(ledger.map((e) => [e.version, e.inRegistry]));
    expect(byVersion["1.0.0"]).toBe(true);
    expect(byVersion["1.1.0"]).toBe(true);
    expect(byVersion["2.0.0"]).toBe(false);
  });
});

describe("looksLikeVersion", () => {
  it("accepts anything that starts with a digit, after an optional v", () => {
    expect(looksLikeVersion("1.2")).toBe(true);
    expect(looksLikeVersion(" v2 ")).toBe(true);
    // Four parts still set the floor: dropping them would offer a version below it.
    expect(looksLikeVersion("1.2.0.3")).toBe(true);
    expect(looksLikeVersion("init")).toBe(false);
    expect(looksLikeVersion("")).toBe(false);
    expect(looksLikeVersion(null)).toBe(false);
  });
});

describe("highestVersion", () => {
  it("compares numerically and ignores the v", () => {
    expect(highestVersion(["1.2.0", "1.10.0", "v1.9.9"])).toBe("1.10.0");
  });

  it("skips labels that are not versions but keeps four-part ones", () => {
    expect(highestVersion(["init", "2.0.0.1", "2.0.0"])).toBe("2.0.0.1");
  });

  it("has no highest for an empty family", () => {
    expect(highestVersion([])).toBeNull();
    expect(highestVersion([null, undefined, "init"])).toBeNull();
  });

  it("is the floor the next version is bumped from", () => {
    expect(bumpVersion(highestVersion(["1.0.0", "1.4.2"]), "minor")).toBe("1.5.0");
    expect(bumpVersion(highestVersion([]), "minor")).toBe("1.0.0");
  });
});

describe("checkNewVersion", () => {
  const existing = ["1.0.0", "1.1.0"];

  it("refuses a version that exists, under any spelling", () => {
    expect(checkNewVersion(existing, "1.1.0")).toEqual({ status: "exists", highest: "1.1.0" });
    expect(checkNewVersion(existing, "1.1")).toEqual({ status: "exists", highest: "1.1.0" });
  });

  it("refuses a version below the highest", () => {
    expect(checkNewVersion(existing, "1.0.5")).toEqual({ status: "not-above", highest: "1.1.0" });
  });

  it("accepts a version above the highest, or any first version", () => {
    expect(checkNewVersion(existing, "1.1.1")).toEqual({ status: "ok", highest: "1.1.0" });
    expect(checkNewVersion([], "1.0.0")).toEqual({ status: "ok", highest: null });
  });
});

describe("familyVersions", () => {
  it("publishes only versions with a migration file and keeps leftover rollbacks apart", () => {
    const result = familyVersions([
      { name: "v1.0.0.sql", sha: "sha-1" },
      { name: "v1.0.0.down.sql", sha: "sha-1-down" },
      { name: "v1.1.0.down.sql", sha: "sha-orphan" },
      { name: "README.md", sha: "sha-readme" },
    ]);
    expect(result.published).toEqual(["1.0.0"]);
    expect(result.orphanRollbacks).toEqual({ "1.1.0": "sha-orphan" });
  });
});
