// The Compare change summary as the screen gets it. No imports that reach a
// database or the AI service, so the Compare page can use the type and the
// shape check.

export type SummaryLevel = "breaking" | "safe" | "info";

/** One graded item of an AI answer: a Compare risk, or a drift item. */
export type SummaryItem = {
  title: string;
  /** The change ids it cites, such as "C3". */
  changes: string[];
  /** Always the engine's grade of the cited changes, never the model's. */
  level: SummaryLevel;
  why: string;
  /** Objects that use what changes. Every one exists. */
  affects: string[];
};

/** One short line of the summary, such as "New column `books.isbn`". */
export type SummaryLine = {
  text: string;
  /** The change ids it covers, such as "C3". */
  changes: string[];
  /** Set by the app from the engine's grade, never by the model. */
  breaking?: boolean;
};

export type CompareSummaryAnswer = {
  /** One sentence: what this migration does to the target. */
  headline: string;
  /** What the migration adds, drops and changes. The app files each line by the changes it cites. */
  added: SummaryLine[];
  dropped: SummaryLine[];
  changed: SummaryLine[];
};

/** What a cited change id stands for, sent beside the answer. */
export type CitedChange = { label: string; severity: SummaryLevel };

export function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/** The shape of one SummaryItem. The level is any text here; the screen falls back for one it does not know. */
export function isSummaryItem(value: unknown): value is SummaryItem {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.title === "string" &&
    typeof v.why === "string" &&
    typeof v.level === "string" &&
    isStringArray(v.changes) &&
    isStringArray(v.affects)
  );
}

function isSummaryLine(value: unknown): value is SummaryLine {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.text === "string" && isStringArray(v.changes);
}

export function isCompareSummaryAnswer(value: unknown): value is CompareSummaryAnswer {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.headline === "string" &&
    [v.added, v.dropped, v.changed].every((list) => Array.isArray(list) && list.every(isSummaryLine))
  );
}

export function isCitedChanges(value: unknown): value is Record<string, CitedChange> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return Object.values(value).every(
    (entry) =>
      typeof entry === "object" &&
      entry !== null &&
      typeof (entry as CitedChange).label === "string" &&
      typeof (entry as CitedChange).severity === "string"
  );
}
