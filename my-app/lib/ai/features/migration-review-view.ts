// The migration review as the Deploy screen gets it. No imports that reach a
// database or the AI service, so the Deploy page can use the type and the
// shape check.

export type ReviewSeverity = "high" | "medium" | "low";

export const SEVERITY_ORDER: ReviewSeverity[] = ["low", "medium", "high"];

export type MigrationReviewFinding = {
  /** The statement ids it is about ("S3"). Every one is a real statement of the run. */
  statements: string[];
  /** Never below the app's own reading of the statements it cites. */
  severity: ReviewSeverity;
  /**
   * The severity the AI gave, before the app raised it to its own reading.
   * Set on every finding the AI wrote, absent on the app's own findings.
   */
  modelSeverity?: ReviewSeverity;
  title: string;
  why: string;
  /** How to get the same result with less risk. Empty when there is nothing better. */
  saferWay: string;
  /** The objects it is about. Every one is in the target schema or in the run's SQL. */
  objects: string[];
  /**
   * True when the app wrote this finding itself: a statement its own checks
   * flagged that the AI's answer left out. Its text is the app's, not the AI's.
   */
  fromApp: boolean;
};

export type MigrationReviewAnswer = {
  /** One or two sentences: is this run safe to apply as it stands. */
  verdict: string;
  /** Most serious first. */
  findings: MigrationReviewFinding[];
};

/** What a statement id stands for, sent beside the answer for the screen. */
export type ReviewedStatement = {
  /** "users_migration v2.1.0, statement 3". */
  label: string;
  /** The statement's first line or so, for a hover. */
  preview: string;
  /** The app's own reading of it. */
  floor: ReviewSeverity;
  /** What the app's checks found in it ("deletes rows: DROP COLUMN"). */
  flags: string[];
};

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isSeverity(value: unknown): value is ReviewSeverity {
  return value === "high" || value === "medium" || value === "low";
}

export function isMigrationReviewAnswer(value: unknown): value is MigrationReviewAnswer {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.verdict === "string" &&
    Array.isArray(v.findings) &&
    v.findings.every(
      (f) =>
        typeof f === "object" &&
        f !== null &&
        isStringArray(f.statements) &&
        isSeverity(f.severity) &&
        (f.modelSeverity === undefined || isSeverity(f.modelSeverity)) &&
        typeof f.title === "string" &&
        typeof f.why === "string" &&
        typeof f.saferWay === "string" &&
        isStringArray(f.objects) &&
        typeof f.fromApp === "boolean"
    )
  );
}

export function isReviewedStatements(value: unknown): value is Record<string, ReviewedStatement> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return Object.values(value).every(
    (entry) =>
      typeof entry === "object" &&
      entry !== null &&
      typeof (entry as ReviewedStatement).label === "string" &&
      typeof (entry as ReviewedStatement).preview === "string" &&
      isSeverity((entry as ReviewedStatement).floor) &&
      isStringArray((entry as ReviewedStatement).flags)
  );
}
