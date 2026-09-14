import {
  backwardsWarning,
  describeRecentSide,
  readsLedger,
  recentTimelineEntries,
} from "@/lib/compare-timeline";
import type { DetectedVersion, DetectedVersionEntry } from "@/lib/detected-version";
import type { NewerSchemaVerdict } from "@/lib/version-detection";

// How the Compare screen's version timeline reads each side, and the push
// button's backwards warning. A side read the wrong way shows a version as
// missing when it ran, or asks for a ledger that cannot exist; and a warning
// that quotes other numbers than the version bar makes one of them wrong.

/** An entry the comparison carried, with only what a test is about set. */
function recent(version: string | null, extra: Partial<DetectedVersionEntry> = {}): DetectedVersionEntry {
  return {
    version,
    label: "users_migration",
    appliedAt: null,
    changeLevel: "unknown",
    scriptName: "users_migration",
    succeeded: null,
    current: false,
    ...extra,
  };
}

/** One side's detected version: script_patch, read in full, unless a test says otherwise. */
function detected(extra: Partial<DetectedVersion> = {}): DetectedVersion {
  return {
    table: "script_patch",
    version: "1.0.0",
    recent: [],
    recentComplete: true,
    familyHeads: null,
    message: "Version table found: script_patch",
    ...extra,
  };
}

describe("readsLedger", () => {
  it("loads the ledger only for script_patch compared through a saved connection", () => {
    expect(readsLedger(detected(), 7)).toBe(true);
    expect(readsLedger(detected(), null)).toBe(false);
    expect(readsLedger(detected({ table: "flyway_schema_history" }), 7)).toBe(false);
    expect(readsLedger(detected({ table: null, version: null }), 7)).toBe(false);
    expect(readsLedger(null, 7)).toBe(false);
  });
});

describe("recentTimelineEntries", () => {
  it("names an entry with no version by its label, and never prints the same text twice", () => {
    const entries = recentTimelineEntries(
      detected({
        table: "databasechangelog",
        recent: [
          recent(null, { label: "changeset-42", scriptName: null }),
          recent("1.0.0", { label: "1.0.0", scriptName: null }),
          recent("1.1.0", { label: "users_migration" }),
          recent("1.2.0", { label: "add users", scriptName: null }),
        ],
      })
    );
    expect(entries.map((entry) => entry.version)).toEqual(["changeset-42", "1.0.0", "1.1.0", "1.2.0"]);
    expect(entries.map((entry) => entry.label)).toEqual([null, null, null, "add users"]);
    // These tables do not store scripts, and the comparison carried none.
    expect(entries.every((entry) => entry.sqlContent === null)).toBe(true);
  });

  it("marks a failed run, and the headline's entry as HEAD when there are no script groups", () => {
    const entries = recentTimelineEntries(
      detected({
        table: "flyway_schema_history",
        recent: [
          recent("1.2", { scriptName: null, succeeded: false }),
          recent("1.1", { scriptName: null, succeeded: true, current: true }),
          recent("1.0", { scriptName: null, succeeded: null }),
        ],
      })
    );
    expect(entries.map((entry) => [entry.failed, entry.isHead])).toEqual([
      [true, false],
      [false, true],
      [false, false],
    ]);
  });

  it("leaves HEAD to the per-group rule when the side has script groups", () => {
    const entries = recentTimelineEntries(
      detected({
        familyHeads: { users_migration: "2.0.0" },
        recent: [recent("2.0.0", { current: true }), recent("1.0.0")],
      })
    );
    expect(entries.map((entry) => entry.isHead)).toEqual([false, false]);
  });
});

describe("describeRecentSide", () => {
  it("says a side with no version table records nothing", () => {
    const expected =
      "No versions were read from prod.public, so every version below shows as not recorded there.";
    expect(describeRecentSide("prod.public", null, 7)).toBe(expected);
    expect(describeRecentSide("prod.public", detected({ table: null, version: null }), 7)).toBe(expected);
  });

  it("has nothing to explain about a side loaded from its ledger", () => {
    expect(describeRecentSide("prod.public", detected(), 7)).toBeNull();
  });

  it("says why script_patch compared without a saved connection shows no scripts", () => {
    const start =
      "prod.public was compared without a saved connection, so its script_patch history and scripts " +
      "cannot be loaded here.";
    expect(
      describeRecentSide("prod.public", detected({ recent: [recent("1.0.0"), recent("0.9.0")] }), null)
    ).toBe(`${start} This shows all 2 entries it holds.`);
    const five = [5, 4, 3, 2, 1].map((n) => recent(`${n}.0.0`));
    expect(describeRecentSide("prod.public", detected({ recent: five, recentComplete: false }), null)).toBe(
      `${start} This shows only the 5 entries the comparison read, not its whole history.`
    );
  });

  it("says another tool's table stores no scripts, and how much of it is shown", () => {
    const flyway = (entries: DetectedVersionEntry[], complete: boolean) =>
      detected({ table: "flyway_schema_history", recent: entries, recentComplete: complete });
    const start = "flyway_schema_history on stage.public does not store its scripts.";
    expect(describeRecentSide("stage.public", flyway([recent("1.4")], true), 3)).toBe(
      `${start} This shows the one entry it holds.`
    );
    expect(describeRecentSide("stage.public", flyway([], true), 3)).toBe(`${start} It holds no entries.`);
    const six = [6, 5, 4, 3, 2, 1].map((n) => recent(`1.${n}`));
    expect(describeRecentSide("stage.public", flyway(six, false), 3)).toBe(
      `${start} This shows only the 6 entries the comparison read, not its whole history.`
    );
  });
});

describe("backwardsWarning", () => {
  const verdict = (newer: NewerSchemaVerdict["newer"], reason = "The versions differ."): NewerSchemaVerdict => ({
    newer,
    reason,
  });
  const side = (name: string, extra: Partial<DetectedVersion> = {}) => ({ name, detected: detected(extra) });

  it("warns only when the target is ahead and the migration has statements, as the bar does", () => {
    const dev = side("dev.public", { version: "1.0.0" });
    const prod = side("prod.public", { version: "2.0.0" });
    expect(backwardsWarning(null, false, dev, prod)).toBeNull();
    expect(backwardsWarning(verdict("left"), false, dev, prod)).toBeNull();
    expect(backwardsWarning(verdict("same"), false, dev, prod)).toBeNull();
    expect(backwardsWarning(verdict("unknown"), false, dev, prod)).toBeNull();
    // The structures already match: nothing would move.
    expect(backwardsWarning(verdict("right"), true, dev, prod)).toBeNull();
    expect(backwardsWarning(verdict("diverged"), true, dev, prod)).toBeNull();
    expect(backwardsWarning(verdict("right"), false, dev, prod)).not.toBeNull();
  });

  it("quotes each side's one declared version, spelled as the version bar spells it", () => {
    expect(
      backwardsWarning(
        verdict("right"),
        false,
        side("dev.public", { table: "flyway_schema_history", version: "1.4" }),
        side("prod.public", { table: "flyway_schema_history", version: "2.0" })
      )
    ).toEqual({
      head: "This would move prod.public backwards",
      body:
        "prod.public declares 2.0 in its flyway_schema_history table; dev.public declares 1.4. The script below " +
        "changes prod.public to match the older schema, so it may undo anything that arrived in the newer version.",
      ack: "I have checked this and want prod.public to match the older schema.",
      blocker: "Tick the box above to confirm prod.public should move back to the older schema.",
      offerSwap: true,
    });

    // A side with script groups was numbered by this app, so it reads v1.0.0.
    const mixed = backwardsWarning(
      verdict("right"),
      false,
      side("dev.public", { version: "1.0.0", familyHeads: { users_migration: "1.0.0" } }),
      side("prod.public", { table: "flyway_schema_history", version: "2.0" })
    );
    expect(mixed?.body).toContain("prod.public declares 2.0 in its flyway_schema_history table; dev.public declares v1.0.0.");

    // Nothing read on either side: the words still make a sentence.
    const unread = backwardsWarning(
      verdict("right"),
      false,
      { name: "dev.public", detected: null },
      { name: "prod.public", detected: null }
    );
    expect(unread?.body).toContain("prod.public declares a newer version; dev.public declares an older version.");
  });

  it("names the script groups where the target is ahead, with both heads", () => {
    expect(
      backwardsWarning(
        verdict("right"),
        false,
        side("dev.public", { familyHeads: { orders: "1.0.0", users_migration: "1.0.0" } }),
        side("prod.public", { familyHeads: { orders: "1.0.0", users_migration: "3.0.0" } })
      )
    ).toEqual({
      head: "This would move prod.public backwards",
      body:
        "dev.public is behind prod.public in users_migration (v1.0.0 vs v3.0.0). The script below changes " +
        "prod.public to match dev.public, so it may undo anything that arrived in prod.public's newer versions " +
        "of users_migration.",
      ack: "I have checked this and want prod.public to match the older schema.",
      blocker: "Tick the box above to confirm prod.public should move back to the older schema.",
      offerSwap: true,
    });

    // A group only the target has: the source reads "none" there, as in the bar's table.
    const onlyTarget = backwardsWarning(
      verdict("right"),
      false,
      side("dev.public", { familyHeads: { users_migration: "1.0.0" } }),
      side("prod.public", { familyHeads: { billing: "1.0.0", users_migration: "1.0.0" } })
    );
    expect(onlyTarget?.body).toContain("dev.public is behind prod.public in billing (none vs v1.0.0).");
  });

  it("names where each side is ahead when they have diverged", () => {
    expect(
      backwardsWarning(
        verdict("diverged"),
        false,
        side("dev.public", { familyHeads: { orders: "2.0.0", users_migration: "1.0.0" } }),
        side("prod.public", { familyHeads: { orders: "1.0.0", users_migration: "3.0.0" } })
      )
    ).toEqual({
      head: "This would move prod.public backwards in users_migration",
      body:
        "dev.public and prod.public have diverged. dev.public is behind in users_migration (v1.0.0 vs v3.0.0), " +
        "and prod.public is behind in orders (v1.0.0 vs v2.0.0). The script below changes prod.public to match " +
        "dev.public, so it may undo anything that arrived in prod.public's newer versions of users_migration.",
      ack: "I have checked this and want prod.public to match dev.public, even where prod.public is ahead.",
      blocker: "Tick the box above to confirm prod.public should match dev.public, even where prod.public is ahead.",
      // The other way round would move dev.public back in orders, so it is not offered.
      offerSwap: false,
    });

    // The detector never says diverged without groups; if it did, its reason is quoted.
    const noGroups = backwardsWarning(
      verdict("diverged", "Diverged: dev is ahead in a, prod in b, so neither schema is simply newer."),
      false,
      side("dev.public"),
      side("prod.public")
    );
    expect(noGroups?.head).toBe("This would move prod.public backwards where it is ahead");
    expect(noGroups?.offerSwap).toBe(false);
    expect(noGroups?.body.startsWith("Diverged: dev is ahead in a, prod in b")).toBe(true);
  });
});
