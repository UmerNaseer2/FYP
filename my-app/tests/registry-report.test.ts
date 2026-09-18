import { describeRegistry, readArchivedVersions, type ArchivedVersion } from "@/lib/registry-report";

/**
 * What the apply route says about the GitHub registry after a run (spec 07 —
 * automatically push approved scripts), and the sentences Deploy and Version
 * Sync build from it.
 *
 * The reader is the interesting half. Its input is whatever came back over the
 * wire, so every test here feeds it something a server could plausibly send —
 * including nothing at all, which is the usual case.
 */

function entry(over: Partial<ArchivedVersion> = {}): ArchivedVersion {
  return {
    script_name: "orders_fix",
    version: "2.0.0",
    status: "saved",
    path: "shop/public/orders_fix/v2.0.0.sql",
    reason: null,
    rollback_saved: true,
    ...over,
  };
}

describe("readArchivedVersions", () => {
  it("reads a well-formed list", () => {
    expect(readArchivedVersions([entry()])).toEqual([entry()]);
  });

  it("reads a missing field as nothing to say, not as a gap", () => {
    // The route sends `registry` only when something was added or failed, and
    // a server from before this feature never sends it. Both must read the
    // same as "no news", or every deploy against an older server would report
    // a registry problem that does not exist.
    expect(readArchivedVersions(undefined)).toEqual([]);
    expect(readArchivedVersions(null)).toEqual([]);
    expect(readArchivedVersions("saved")).toEqual([]);
    expect(readArchivedVersions({ script_name: "orders_fix" })).toEqual([]);
  });

  it("keeps the good rows when one is malformed", () => {
    // One bad row must not hide the rest — and the row worth keeping is
    // usually the one saying a version did NOT reach GitHub.
    const rows = readArchivedVersions([
      { nonsense: true },
      entry({ status: "not-saved", path: null, reason: "GitHub was unreachable." }),
      null,
      entry({ version: "3.0.0" }),
    ]);
    expect(rows.map((row) => row.version)).toEqual(["2.0.0", "3.0.0"]);
  });

  it("drops a row whose status is not one of the three", () => {
    // A status this build does not know is not safely read as any of the
    // three: guessing "saved" would claim a push that may not have happened.
    expect(readArchivedVersions([entry({ status: "pushed" as ArchivedVersion["status"] })])).toEqual([]);
  });

  it("defaults the fields a server may leave out", () => {
    const [row] = readArchivedVersions([
      { script_name: "orders_fix", version: "1.0.0", status: "saved" },
    ]);
    expect(row).toEqual({
      script_name: "orders_fix",
      version: "1.0.0",
      status: "saved",
      path: null,
      reason: null,
      // Absent is read as false, so a version is never reported as having
      // carried its rollback across when nothing said it did.
      rollback_saved: false,
    });
  });
});

describe("describeRegistry", () => {
  it("says nothing about a run that changed nothing", () => {
    // The ordinary Deploy run: its scripts came out of the registry, so the
    // registry already lists them.
    expect(describeRegistry([])).toEqual({ saved: null, problem: null });
    expect(describeRegistry([entry({ status: "already-saved" })])).toEqual({
      saved: null,
      problem: null,
    });
  });

  it("names what it added", () => {
    const note = describeRegistry([entry()]);
    expect(note.saved).toBe(`Recorded v2.0.0 of "orders_fix" in the GitHub registry.`);
    expect(note.problem).toBeNull();
  });

  it("says when a version went across without its rollback", () => {
    // Worth saying: Deploy refuses to undo a version with no rollback, so a
    // silent omission here becomes a surprise at the point of rolling back.
    expect(describeRegistry([entry({ rollback_saved: false })]).saved).toBe(
      `Recorded v2.0.0 of "orders_fix" in the GitHub registry, without a rollback file.`
    );
    expect(
      describeRegistry([entry(), entry({ version: "3.0.0", rollback_saved: false })]).saved
    ).toBe(
      `Recorded v2.0.0 of "orders_fix", v3.0.0 of "orders_fix" in the GitHub registry, ` +
      `1 of them without a rollback file.`
    );
  });

  it("passes a single failure's own reason through", () => {
    // The reason comes from whatever actually failed — an unreachable GitHub
    // reads differently from a rejected token — so it is shown rather than
    // replaced with one sentence covering both.
    const note = describeRegistry([
      entry({ status: "not-saved", path: null, reason: "GitHub refused the token." }),
    ]);
    expect(note.problem).toBe("GitHub refused the token.");
    expect(note.saved).toBeNull();
  });

  it("falls back to naming the version when a failure carries no reason", () => {
    expect(
      describeRegistry([entry({ status: "not-saved", path: null, reason: null })]).problem
    ).toBe(`v2.0.0 of "orders_fix" was not recorded in the GitHub registry.`);
  });

  it("sums several failures into one sentence with the way out", () => {
    const note = describeRegistry([
      entry({ status: "not-saved", reason: "GitHub was unreachable." }),
      entry({ version: "3.0.0", status: "not-saved", reason: "GitHub was unreachable." }),
    ]);
    expect(note.problem).toContain(`v2.0.0 of "orders_fix", v3.0.0 of "orders_fix"`);
    expect(note.problem).toContain("applied and safe");
    expect(note.problem).toContain("Script Editor");
  });

  it("reports a saved version and a failed one at the same time", () => {
    // One run can do both, and the two go to different places on screen: the
    // success sits with the run's result, the failure in a warning.
    const note = describeRegistry([
      entry(),
      entry({ version: "3.0.0", status: "not-saved", reason: "GitHub was unreachable." }),
    ]);
    expect(note.saved).toContain("v2.0.0");
    expect(note.saved).not.toContain("v3.0.0");
    expect(note.problem).toContain("GitHub was unreachable.");
  });
});
