// The Compare change summary as the screen gets it. No imports that reach a
// database or the AI service, so the Compare page can use the type and the
// shape check.

export type SummaryLevel = "breaking" | "safe" | "info";

export type CompareSummaryAnswer = {
  /** One sentence: what this migration does to the target. */
  headline: string;
  /** What can hurt, most serious first. Each item cites change ids such as "C3". */
  risks: {
    title: string;
    changes: string[];
    /** Always the engine's grade of the cited changes, never the model's. */
    level: SummaryLevel;
    why: string;
    /** Objects in the target that use what changes. Every one exists. */
    affects: string[];
  }[];
  /** A suggested order to apply the changes in. Every step names real changes. */
  order: { step: string; changes: string[] }[];
};

/** What a cited change id stands for, sent beside the answer. */
export type CitedChange = { label: string; severity: SummaryLevel };

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

export function isCompareSummaryAnswer(value: unknown): value is CompareSummaryAnswer {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.headline === "string" &&
    Array.isArray(v.risks) &&
    v.risks.every(
      (risk) =>
        typeof risk === "object" &&
        risk !== null &&
        typeof risk.title === "string" &&
        typeof risk.why === "string" &&
        typeof risk.level === "string" &&
        isStringArray(risk.changes) &&
        isStringArray(risk.affects)
    ) &&
    Array.isArray(v.order) &&
    v.order.every(
      (step) => typeof step === "object" && step !== null && typeof step.step === "string" && isStringArray(step.changes)
    )
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
