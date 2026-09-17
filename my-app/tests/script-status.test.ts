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
  pendingPrefixThrough,
  suggestBumpLevel,
  versionKey,
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

describe("versionKey", () => {
  it("gives every spelling of one version the same key", () => {
    expect(versionKey("v1.2")).toBe("1.2.0");
    expect(versionKey("v1.2.0")).toBe("1.2.0");
    expect(versionKey("1.2.0")).toBe("1.2.0");
    expect(versionKey("1.2.3.0")).toBe(versionKey("1.2.3"));
    expect(versionKey("1.2.0.3")).toBe("1.2.0.3");
  });

  // RD4: one key rule, and it may never disagree with the comparator.
  it("is equal exactly when compareVersions says the versions are equal", () => {
    const versions = ["1", "v1", "1.0", "1.0.0", "1.0.0.0", "1.2", "v1.2.0", "1.2.0.0", "1.2.0.3",
      "1.2.3", "1.2.3.0", "1.10.0", "1.9.0", "2", "V2.0.0", "10.0.0"];
    for (const a of versions) {
      for (const b of versions) {
        expect([a, b, versionKey(a) === versionKey(b)]).toEqual([a, b, compareVersions(a, b) === 0]);
      }
    }
  });

  it("is normalizeVersion's answer for every strict version", () => {
    for (const version of ["2", "v2.1", "1.2.3", "V10.0.1"]) {
      expect(versionKey(version)).toBe(normalizeVersion(version));
    }
  });
});

describe("pendingPrefixThrough", () => {
  const pending = [{ version: "5.0.1" }, { version: "5.0.2" }, { version: "6.0.0" }];
  const versionsOf = (list: { version: string }[]) => list.map((entry) => entry.version);

  it("runs every pending version up to and including the one picked", () => {
    expect(versionsOf(pendingPrefixThrough(pending, "5.0.2"))).toEqual(["5.0.1", "5.0.2"]);
    expect(versionsOf(pendingPrefixThrough(pending, "5.0.1"))).toEqual(["5.0.1"]);
    expect(versionsOf(pendingPrefixThrough(pending, "6.0.0"))).toEqual(["5.0.1", "5.0.2", "6.0.0"]);
  });

  it("runs nothing for a version that is not pending, or no version at all", () => {
    expect(pendingPrefixThrough(pending, "5.0.3")).toEqual([]);
    expect(pendingPrefixThrough(pending, "4.0.0")).toEqual([]);
    expect(pendingPrefixThrough(pending, "")).toEqual([]);
    expect(pendingPrefixThrough(pending, null)).toEqual([]);
    expect(pendingPrefixThrough([], "5.0.1")).toEqual([]);
  });

  it("matches the picked version under any spelling and keeps version order", () => {
    const unsorted = [{ version: "6.0.0" }, { version: "5.0.1" }, { version: "5.0.2" }];
    expect(versionsOf(pendingPrefixThrough(unsorted, "v5.0.2"))).toEqual(["5.0.1", "5.0.2"]);
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

  it("labels applied, pending and skipped against the target history", () => {
    const ledger = buildVersionLedger(
      ["1.0.0", "1.1.0", "1.2.0", "1.3.0"],
      [applied("1.0.0"), applied("1.2.0")]
    );
    const byVersion = Object.fromEntries(ledger.map((e) => [e.version, e.status]));

    expect(byVersion["1.0.0"]).toBe("applied");
    expect(byVersion["1.2.0"]).toBe("applied");
    // Below the high-water mark and never applied — an out-of-order apply left
    // it behind, and a forward-only deploy will not pick it up.
    expect(byVersion["1.1.0"]).toBe("skipped");
    expect(byVersion["1.3.0"]).toBe("pending");
  });

  it("matches an applied v1.2.0 to registry 1.2.0 as one applied row with inRegistry true", () => {
    const ledger = buildVersionLedger(["1.2.0", "1.3.0"], [applied("v1.2.0")]);
    expect(ledger).toEqual([
      // Shown in the registry's spelling; the stored spelling is kept for the database.
      { version: "1.2.0", status: "applied", appliedAt: "2026-01-01T00:00:00Z", appliedVersion: "v1.2.0", inRegistry: true },
      { version: "1.3.0", status: "pending", appliedAt: null, appliedVersion: null, inRegistry: true },
    ]);
  });

  it("registry 1.2 and applied 1.2.0 are one row", () => {
    const ledger = buildVersionLedger(["1.1", "1.2"], [applied("1.2.0")]);
    expect(ledger.map((e) => [e.version, e.status, e.appliedVersion, e.inRegistry])).toEqual([
      ["1.1", "skipped", null, true],
      ["1.2", "applied", "1.2.0", true],
    ]);
  });

  it("shows the ledger's spelling for an applied version the registry does not hold", () => {
    const ledger = buildVersionLedger(["1.0.0"], [applied("v2.0")]);
    expect(ledger[1]).toMatchObject({ version: "v2.0", status: "applied", appliedVersion: "v2.0", inRegistry: false });
  });

  it("lists two registry files that spell one version differently once", () => {
    const ledger = buildVersionLedger(["1.2", "1.2.0"], []);
    expect(ledger.map((e) => e.version)).toEqual(["1.2"]);
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

  // A name that is not a version ("release-2") must not set the applied floor.
  // versionParts reads it as 2.0.0, and left unfiltered that one applied name
  // would push every genuinely-pending registry version below it to "skipped".
  // The floor is taken through highestVersion, which ignores non-version names,
  // so 1.1.0 stays pending — while "release-2" is still listed as its own
  // applied entry, just not counted as a version.
  it("does not let a non-version applied name raise the floor", () => {
    const ledger = buildVersionLedger(
      ["1.0.0", "1.1.0"],
      [applied("1.0.0"), applied("release-2")]
    );
    const byVersion = Object.fromEntries(ledger.map((e) => [e.version, e.status]));

    expect(byVersion["1.0.0"]).toBe("applied");
    // The fix: 1.1.0 is above the real applied floor (1.0.0), so it is pending.
    // Under the old all-names floor it would have been skipped below 2.0.0.
    expect(byVersion["1.1.0"]).toBe("pending");
    // The non-version name is still there, listed as applied in its own spelling.
    expect(ledger.find((e) => e.version === "release-2")).toMatchObject({
      status: "applied",
      appliedVersion: "release-2",
      inRegistry: false,
    });
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

// A pre-release version — "2.0.0-rc1" — and the release it leads up to.
//
// versionParts used to delete every non-digit rather than stop at one, so
// "0-rc1" became "01" → 1 and the whole version read as 2.0.1. Three things
// went wrong from that one reading: the candidate outranked its own release,
// it shared a key with a genuine 2.0.1, and a patch bump from it skipped a
// number. Versions like this arrive from another tool's ledger, which is why
// they are parsed rather than refused.
describe("a pre-release version", () => {
  const applied = (version: string) => ({ version, applied_at: "2026-01-01T00:00:00Z" });

  it("reads as the release it leads up to, not the one after it", () => {
    expect(versionParts("2.0.0-rc1")).toEqual([2, 0, 0]);
    // A dotted tag is the case the old rule could not have got right either
    // way: "rc.1" would have split into a fourth number.
    expect(versionParts("2.0.0-rc.1")).toEqual([2, 0, 0]);
    // Build metadata is not part of the version at all.
    expect(versionParts("2.0.0+build.5")).toEqual([2, 0, 0]);
  });

  it("comes before its release and after the version below it", () => {
    expect(compareVersions("2.0.0-rc1", "2.0.0")).toBeLessThan(0);
    expect(compareVersions("2.0.0", "2.0.0-rc1")).toBeGreaterThan(0);
    expect(compareVersions("2.0.0-rc1", "1.9.9")).toBeGreaterThan(0);
    // And nowhere near the 2.0.1 it used to be read as.
    expect(compareVersions("2.0.0-rc1", "2.0.1")).toBeLessThan(0);
  });

  it("orders candidates among themselves the way semver does", () => {
    expect(compareVersions("2.0.0-rc.1", "2.0.0-rc.2")).toBeLessThan(0);
    // 9 < 10 as numbers; as text it would have been the other way round.
    expect(compareVersions("2.0.0-rc.9", "2.0.0-rc.10")).toBeLessThan(0);
    // A number ranks below text, and a shorter tag below a longer one.
    expect(compareVersions("2.0.0-1", "2.0.0-alpha")).toBeLessThan(0);
    expect(compareVersions("2.0.0-rc", "2.0.0-rc.1")).toBeLessThan(0);
    expect(compareVersions("2.0.0-rc.1", "2.0.0-rc.1")).toBe(0);
  });

  it("keeps a key of its own, so applying it does not mark the release applied", () => {
    expect(versionKey("2.0.0-rc1")).not.toBe(versionKey("2.0.0"));
    expect(versionKey("2.0.0-rc1")).not.toBe(versionKey("2.0.1"));
    // versionKey's contract: same key exactly when compareVersions says equal.
    expect(versionKey("v2.0-rc.01")).toBe(versionKey("2.0.0-rc.1"));
    expect(compareVersions("v2.0-rc.01", "2.0.0-rc.1")).toBe(0);
  });

  it("leaves the release pending in the ledger once only the candidate ran", () => {
    const ledger = buildVersionLedger(["2.0.0"], [applied("1.9.0"), applied("2.0.0-rc1")]);
    const byVersion = Object.fromEntries(ledger.map((e) => [e.version, e.status]));

    // The whole point: 2.0.0 has not run, and it is above the applied floor.
    expect(byVersion["2.0.0"]).toBe("pending");
    expect(byVersion["2.0.0-rc1"]).toBe("applied");
  });

  it("bumps from the numbers it really has", () => {
    // Was "2.0.2", which quietly skipped 2.0.1.
    expect(bumpVersion("2.0.0-rc1", "patch")).toBe("2.0.1");
    expect(bumpVersion("2.0.0-rc1", "minor")).toBe("2.1.0");
  });
});

// An applied name that is not a version at all, when the registry holds the
// version that name used to be read as.
describe("buildVersionLedger — a non-version applied name", () => {
  const applied = (version: string) => ({ version, applied_at: "2026-01-01T00:00:00Z" });

  it("does not mark a registry version applied because a label read as it", () => {
    // versionKey answers "2.0.0" for "release-2". Keyed on that, the registry's
    // real 2.0.0 found an applied row waiting under its key and was reported as
    // Applied — a version nobody had run, shown as run, with a timestamp.
    const ledger = buildVersionLedger(["1.0.0", "2.0.0"], [applied("1.0.0"), applied("release-2")]);
    const byVersion = Object.fromEntries(ledger.map((e) => [e.version, e]));

    expect(byVersion["2.0.0"]).toMatchObject({ status: "pending", appliedVersion: null });
    // The label is still listed in its own right, which is why it is kept.
    expect(byVersion["release-2"]).toMatchObject({ status: "applied", inRegistry: false });
    expect(byVersion["1.0.0"]).toMatchObject({ status: "applied" });
  });

  it("lists two different labels separately", () => {
    // Both used to key as "0.0.0" once versionParts stopped inventing digits,
    // so the second one would have been swallowed by the first.
    const ledger = buildVersionLedger([], [applied("init"), applied("baseline")]);
    expect(ledger.map((e) => e.version).sort()).toEqual(["baseline", "init"]);
  });
});
