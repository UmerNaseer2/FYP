// Write the rollback for SQL a person typed, as Quick run on the Deploy page
// gets it. No imports that reach a database or the AI service, so the panel can
// use the types and the shape checks.
import { isSqlTrial, type SqlTrial } from "./sql-generate-view";

/**
 * The longest SQL the rollback writer reads. The whole script goes in the
 * prompt, so it is kept to what one AI call can read well. A longer script can
 * still run as a quick run: its rollback is then written by hand.
 */
export const MAX_ROLLBACK_SOURCE_CHARS = 20_000;

export type RollbackWriteAnswer = {
  /** The statements that undo the script, in reverse order. Empty when it cannot be undone. */
  rollbackSql: string;
  /** What the rollback does, in a sentence or two, names in backticks. */
  summary: string;
  /** What the rollback cannot put back (deleted rows, say). Empty when it undoes everything. */
  cannot: string;
};

/** The app's own reading of the rollback. The model writes none of this. */
export type RollbackWriteChecks = {
  statements: number;
  /** What the rollback deletes, as the deploy screen would list it. */
  dataLoss: string[];
  /** Whether the app tried the script and then the rollback, inside a transaction it rolled back. */
  trial: SqlTrial;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isRollbackWriteAnswer(value: unknown): value is RollbackWriteAnswer {
  return (
    isObject(value) &&
    typeof value.rollbackSql === "string" &&
    typeof value.summary === "string" &&
    typeof value.cannot === "string"
  );
}

export function isRollbackWriteChecks(value: unknown): value is RollbackWriteChecks {
  return (
    isObject(value) &&
    typeof value.statements === "number" &&
    Array.isArray(value.dataLoss) &&
    value.dataLoss.every((item) => typeof item === "string") &&
    isSqlTrial(value.trial)
  );
}
