// What the Compare screen shows of a schema's OWN version table.
//
// The version detector reads up to 5,000 rows of a table such as
// flyway_schema_history or script_patch. The screen draws a handful, and
// sending every row for the source and for each target would be most of the
// page's weight. toDetectedVersion trims a full detection result down to what
// is drawn.
//
// It lives apart from compare-run.ts, which opens database connections, so a
// client component can import the type and a test can check the trimming
// without a database. Every import here is type-only.
import type { ChangeLevel } from "./change-level";
import type { VersionDetectionResult, VersionTimelineEntry } from "./version-detection";

/** How many of the newest entries travel to the browser with each schema. */
export const VERSION_TIMELINE_SHOWN = 5;

/** One entry of a schema's version table, as the screen draws it. */
export type DetectedVersionEntry = {
  version: string | null;
  /** A title or description, never the version printed a second time. */
  label: string;
  appliedAt: string | null;
  changeLevel: ChangeLevel;
  /** The script group (script_patch.script_name), or null when the table has none. */
  scriptName: string | null;
  /** False for a run the table records as failed, null when it does not say. */
  succeeded: boolean | null;
  /** The entry the schema's version (DetectedVersion.version) was read from. */
  current: boolean;
};

/**
 * What a schema's OWN version table says about itself.
 *
 * Not the same thing as the lineage this app keeps: this is read out of the
 * target database, from whatever it already uses — Flyway's
 * flyway_schema_history, Liquibase, a hand-rolled schema_version, our own
 * script_patch. A schema that tracks its versions somewhere is telling you
 * which side is ahead, and that is worth knowing before you generate a
 * migration for it.
 */
export type DetectedVersion = {
  /** Where the version was read from, or null when the schema has no such table. */
  table: string | null;
  /** The latest version the table records, as written there. */
  version: string | null;
  /**
   * The newest VERSION_TIMELINE_SHOWN entries, newest first. After them, when
   * they are not already among them: the entry `version` was read from, and
   * each script group's head. So every version the screen names is in here.
   */
  recent: DetectedVersionEntry[];
  /** True when `recent` holds every entry the table has, so nothing older is left out. */
  recentComplete: boolean;
  /**
   * Each script group's highest version, read from the whole table. Null when
   * the table has no script_name column or no row names a group.
   */
  familyHeads: Record<string, string> | null;
  /** Which table was found, or why there is no answer. Shown as-is. */
  message: string;
};

/**
 * Trim a full detection result down to what the screen renders.
 *
 * `current` is the entry the detector read the schema's version from
 * (pickCurrentVersion over info.timeline). It is passed in rather than worked
 * out here because that rule lives in version-detection.ts, which this
 * module must not import at runtime.
 */
export function toDetectedVersion(
  info: VersionDetectionResult,
  current: VersionTimelineEntry | null
): DetectedVersion {
  const newest = info.timeline.slice(0, VERSION_TIMELINE_SHOWN);
  const extra: VersionTimelineEntry[] = [];
  const keep = (entry: VersionTimelineEntry) => {
    if (!newest.includes(entry) && !extra.includes(entry)) extra.push(entry);
  };

  // The headline prints the current version, and the family table prints each
  // group's head. An old head that is not among the newest few would otherwise
  // be a number on screen with no entry behind it.
  if (current) keep(current);
  if (info.familyHeads) {
    for (const [family, head] of Object.entries(info.familyHeads)) {
      const entry = info.timeline.find(
        (candidate) =>
          candidate.scriptName === family &&
          candidate.succeeded !== false &&
          candidate.version !== null &&
          candidate.version.trim() === head
      );
      if (entry) keep(entry);
    }
  }

  return {
    table: info.tableName,
    version: info.detectedVersion,
    recent: [...newest, ...extra].map((entry) => ({
      version: entry.version,
      // The detector falls back to the version string for its label when the
      // table has no title column, which renders as the version printed twice.
      // Plenty of those tables do carry a description — use it instead.
      label: entry.label === entry.version ? (entry.description ?? entry.label) : entry.label,
      appliedAt: entry.appliedAt,
      changeLevel: entry.changeLevel,
      scriptName: entry.scriptName ?? null,
      succeeded: entry.succeeded ?? null,
      current: entry === current,
    })),
    recentComplete: info.timeline.length <= VERSION_TIMELINE_SHOWN,
    familyHeads: info.familyHeads,
    message: info.message,
  };
}
