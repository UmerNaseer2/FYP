import {
  bumpVersion,
  buildVersionLedger,
  compareVersions,
  isValidSemver,
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

  it("treats no prior version as 0.0.0", () => {
    expect(bumpVersion(null, "major")).toBe("1.0.0");
    expect(bumpVersion(null, "minor")).toBe("0.1.0");
    expect(bumpVersion("", "patch")).toBe("0.0.1");
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
