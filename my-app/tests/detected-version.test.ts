import { toDetectedVersion, VERSION_TIMELINE_SHOWN } from "@/lib/detected-version";
import type { VersionDetectionResult, VersionTimelineEntry } from "@/lib/version-detection";

// What the Compare screen receives of each schema's own version table. The
// screen prints a version in its headline and a head per script group, so
// each of those must arrive with an entry behind it, even when it is older
// than the newest five.

/** A script_patch entry with only what a test is about set. */
function row(version: string, extra: Partial<VersionTimelineEntry> = {}): VersionTimelineEntry {
  return {
    version,
    label: "users_migration",
    description: null,
    changeLevel: "unknown",
    appliedAt: null,
    sourceTable: "script_patch",
    succeeded: null,
    scriptName: "users_migration",
    ...extra,
  };
}

/** A detection result around a timeline, with `current` as its version. */
function info(
  timeline: VersionTimelineEntry[],
  current: VersionTimelineEntry | null,
  familyHeads: Record<string, string> | null = null
): VersionDetectionResult {
  return {
    schema: "public",
    hasVersionTable: true,
    tableName: "script_patch",
    detectedVersion: current?.version ?? null,
    comparableValue: null,
    versionScheme: "semver",
    timeline,
    familyHeads,
    fallbackMode: false,
    message: "Version table found: script_patch",
  };
}

describe("toDetectedVersion", () => {
  it("sends the newest five entries, and says when that is all of them", () => {
    expect(VERSION_TIMELINE_SHOWN).toBe(5);

    const five = [5, 4, 3, 2, 1].map((n) => row(`${n}.0.0`));
    const all = toDetectedVersion(info(five, five[0]), five[0]);
    expect(all.recent.map((entry) => entry.version)).toEqual(["5.0.0", "4.0.0", "3.0.0", "2.0.0", "1.0.0"]);
    expect(all.recentComplete).toBe(true);

    const six = [6, 5, 4, 3, 2, 1].map((n) => row(`${n}.0.0`));
    const cut = toDetectedVersion(info(six, six[0]), six[0]);
    expect(cut.recent).toHaveLength(5);
    expect(cut.recentComplete).toBe(false);
  });

  it("adds the current entry after the newest five when it is older than them", () => {
    // The newest rows by date are not always the highest version: a table can
    // record a run of hotfixes on an old line after the current version.
    const timeline = [row("1.0.5"), row("1.0.4"), row("1.0.3"), row("1.0.2"), row("1.0.1"), row("2.0.0")];
    const shown = toDetectedVersion(info(timeline, timeline[5]), timeline[5]);
    expect(shown.recent.map((entry) => entry.version)).toEqual([
      "1.0.5",
      "1.0.4",
      "1.0.3",
      "1.0.2",
      "1.0.1",
      "2.0.0",
    ]);
    expect(shown.recent.filter((entry) => entry.current).map((entry) => entry.version)).toEqual(["2.0.0"]);
  });

  it("adds each script group's head when it is older than the newest five, once", () => {
    const users = [5, 4, 3, 2, 1].map((n) => row(`${n}.0.0`));
    const timeline = [
      ...users,
      // A failed run of the head's version is not the entry the head came from.
      row("1.0.0", { scriptName: "orders_migration", succeeded: false }),
      row("1.0.0", { scriptName: "orders_migration", label: "orders_migration" }),
    ];
    const shown = toDetectedVersion(
      info(timeline, users[0], { users_migration: "5.0.0", orders_migration: "1.0.0" }),
      users[0]
    );
    expect(shown.recent.map((entry) => `${entry.scriptName} ${entry.version}`)).toEqual([
      "users_migration 5.0.0",
      "users_migration 4.0.0",
      "users_migration 3.0.0",
      "users_migration 2.0.0",
      "users_migration 1.0.0",
      "orders_migration 1.0.0",
    ]);
    expect(shown.recent[5].succeeded).toBeNull();
    expect(shown.recentComplete).toBe(false);
  });

  it("does not print the version a second time as its label", () => {
    const timeline = [row("1.0.0", { label: "1.0.0", description: "add users" }), row("0.9.0", { label: "0.9.0" })];
    const shown = toDetectedVersion(info(timeline, timeline[0]), timeline[0]);
    expect(shown.recent.map((entry) => entry.label)).toEqual(["add users", "0.9.0"]);
  });

  it("carries the groups, each entry's group, whether it ran, and which one is current", () => {
    const timeline = [row("1.0.0", { succeeded: true }), row("0.9.0", { scriptName: null, succeeded: false })];
    const shown = toDetectedVersion(info(timeline, timeline[0], { users_migration: "1.0.0" }), timeline[0]);
    expect(shown).toMatchObject({
      table: "script_patch",
      version: "1.0.0",
      familyHeads: { users_migration: "1.0.0" },
      message: "Version table found: script_patch",
    });
    expect(shown.recent[0]).toMatchObject({ scriptName: "users_migration", succeeded: true, current: true });
    expect(shown.recent[1]).toMatchObject({ scriptName: null, succeeded: false, current: false });
  });

  it("reads an entry that says nothing of groups or success as null for both", () => {
    const bare: VersionTimelineEntry = {
      version: "1.0",
      label: "init",
      description: null,
      changeLevel: "unknown",
      appliedAt: null,
      sourceTable: "flyway_schema_history",
    };
    const shown = toDetectedVersion(info([bare], bare), bare);
    expect(shown.recent[0]).toMatchObject({ scriptName: null, succeeded: null, current: true });
    expect(shown.familyHeads).toBeNull();
  });
});
