// Write SQL from plain words, as the Script Editor gets it. No imports that
// reach a database or the AI service, so the editor can use the types and the
// shape checks.

/**
 * The longest request the editor sends. The route refuses a longer one with a
 * 413, and the editor's box stops at it, so both read it from here.
 */
export const MAX_REQUEST_CHARS = 2_000;

export type SqlGenerateAnswer = {
  /** The script. Empty when the model said it cannot be done. */
  sql: string;
  /** The script that undoes it, in reverse order. May be empty. */
  rollbackSql: string;
  /** What the script does, in a few sentences, names in backticks. */
  summary: string;
  /** What the model had to guess about the request. */
  assumptions: string[];
  /** Why it cannot be done with this schema. Empty when it can. */
  cannot: string;
};

/** Whether the app tried the script on the database, inside a transaction it rolled back. */
export type SqlTrial =
  | { status: "passed"; rollbackTried: boolean }
  | { status: "not-tried"; reason: string };

export type SqlGenerateLevel = "breaking" | "additive" | "patch";

/** The app's own reading of the script. The model writes none of this. */
export type SqlGenerateChecks = {
  level: SqlGenerateLevel | null;
  levelBecause: string | null;
  statements: number;
  rollbackStatements: number;
  /** Statements that delete data, as the deploy screen would list them. */
  dataLoss: string[];
  /** Statements that can fail on rows already there. */
  mightFail: string[];
  enumAdditions: number;
  trial: SqlTrial;
  /** The tables and views the request named, which the model was always shown. */
  focus: string[];
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

export function isSqlGenerateAnswer(value: unknown): value is SqlGenerateAnswer {
  return (
    isObject(value) &&
    typeof value.sql === "string" &&
    typeof value.rollbackSql === "string" &&
    typeof value.summary === "string" &&
    typeof value.cannot === "string" &&
    isStringArray(value.assumptions)
  );
}

function isSqlTrial(value: unknown): value is SqlTrial {
  if (!isObject(value)) return false;
  if (value.status === "passed") return typeof value.rollbackTried === "boolean";
  return value.status === "not-tried" && typeof value.reason === "string";
}

export function isSqlGenerateChecks(value: unknown): value is SqlGenerateChecks {
  return (
    isObject(value) &&
    (value.level === null || value.level === "breaking" || value.level === "additive" || value.level === "patch") &&
    (value.levelBecause === null || typeof value.levelBecause === "string") &&
    typeof value.statements === "number" &&
    typeof value.rollbackStatements === "number" &&
    isStringArray(value.dataLoss) &&
    isStringArray(value.mightFail) &&
    typeof value.enumAdditions === "number" &&
    isSqlTrial(value.trial) &&
    isStringArray(value.focus)
  );
}
