// The audit trail of what anyone tried to deploy.
//
// Spec feature 07 — "Track SQL execution history for auditing."
//
// The target's script_patch table is a record of what a database HAS applied,
// and that is the only thing it can be. The apply route writes those rows
// inside the run's own transaction, after the DDL, so every way a run can go
// wrong takes the evidence with it:
//
//   • a script that threw   → ROLLBACK undoes the DDL and the ledger row
//   • a COMMIT the server refused → the server rolls the whole run back
//   • a lock timeout        → same, from inside the transaction
//   • a refusal (wrong application, a version already applied, no approval,
//     a target that could not be opened) → the transaction never started, so
//     there was never a row to write
//
// What survived was a ledger of successes. It answers "what version is this
// database at" and cannot answer "what has anyone tried to do to it" — which
// is the question an audit is usually asked, and the only question that
// matters after something goes wrong at three in the morning.
//
// So an attempt is recorded in this app's own database instead (the
// DeployAttempt model), on a different connection from the target. That is the
// whole mechanism: a ROLLBACK on the target cannot reach across a connection
// it does not own, and a run refused because the target was unreachable still
// leaves a row.
//
// The classification below is pure so it can be tested without either
// database. The writer that uses it lives in lib/deploy-attempts-db.ts, which
// pulls in Sequelize and must not be imported from a client component.

/**
 * What became of an attempt.
 *
 * Four values rather than a boolean, because "it did not succeed" covers three
 * situations an auditor has to tell apart:
 *
 *   • refused — the route said no and never touched the target. Nothing to
 *     inspect, nothing to undo; the fix is in the request or the approval.
 *   • failed  — it ran and was rolled back. The target is as it was, but
 *     something in the script or the schema is wrong.
 *   • unknown — the COMMIT never reported back. This is the one that needs a
 *     person: the run may have landed. Collapsing it into "failed" would tell
 *     that person the opposite of the truth.
 */
export type AttemptOutcome = "applied" | "failed" | "refused" | "unknown";

/** The part of an apply response this module reads. */
export type AttemptResponseBody = {
  success?: unknown;
  /** Set by answerBeforeRun: the route refused before writing anything. */
  nothingRan?: unknown;
  /** Set when the COMMIT did not report back. */
  outcomeUnknown?: unknown;
  error?: unknown;
  message?: unknown;
};

/**
 * How much of a message is kept. An audit row is a signpost, not a transcript:
 * the full text went to the operator and to the server log, and a column that
 * can hold a stack trace is one that eventually holds a thousand of them.
 */
export const MAX_ATTEMPT_DETAIL_LENGTH = 2000;

/**
 * Read an attempt's outcome from the answer the route gave.
 *
 * Deliberately derived from the response rather than passed in by hand at each
 * of the route's exits. The apply route answers in more than twenty places,
 * and a classification written out at every one of them is a classification
 * that is wrong at one of them — most likely at a rare branch nobody exercises,
 * which is exactly the branch an audit trail exists for.
 *
 * The order of the tests is the order of how much they matter:
 *
 *   1. outcomeUnknown first, before anything else. It is the only outcome that
 *      needs a person, and it arrives on a 500 alongside success: false, so a
 *      plain "not ok → failed" reading would bury it.
 *   2. Then success, which on this route means the run committed (or, for a
 *      dry run, rehearsed cleanly).
 *   3. Then nothingRan, the flag the route sets on every answer it gives
 *      before its first write. A status code cannot stand in for it: a lock
 *      timeout after BEGIN is a 503 and so is a target that would not open,
 *      and those are not the same event.
 *   4. Anything left ran and was rolled back.
 */
export function attemptOutcome(status: number, body: AttemptResponseBody | null): AttemptOutcome {
  if (body?.outcomeUnknown === true) return "unknown";
  if (body?.success === true) return "applied";
  // An auth or parse failure answers with neither flag — there is no body to
  // read on some of them at all — so the status has the last word. Nothing at
  // 4xx ever reached the target.
  if (body?.nothingRan === true || (status >= 400 && status < 500)) return "refused";
  return "failed";
}

/**
 * The one line of the answer worth storing, trimmed to something a table can
 * hold. Null for a run that succeeded — the outcome already says so, and
 * repeating "applied successfully" in every row is noise to read past.
 */
export function attemptDetail(outcome: AttemptOutcome, body: AttemptResponseBody | null): string | null {
  if (outcome === "applied") return null;
  const raw = typeof body?.error === "string" ? body.error : typeof body?.message === "string" ? body.message : "";
  const text = raw.trim();
  if (text === "") return null;
  return text.length > MAX_ATTEMPT_DETAIL_LENGTH
    ? `${text.slice(0, MAX_ATTEMPT_DETAIL_LENGTH - 1)}…`
    : text;
}

/** One migration an attempt asked for, as the row stores it. */
export type AttemptScript = { script_name: string; version: string };

/**
 * One row of the trail, as a screen reads it.
 *
 * Declared in this module rather than beside the query that returns it because
 * the deploy screen renders these rows, and the query lives in a module that
 * imports pg — which a client component may never reach. The direction is the
 * safe one: the database module imports this, not the other way round.
 */
export type DeployAttemptRow = {
  id: number;
  connection_id: number | null;
  schema_name: string | null;
  scripts: AttemptScript[];
  outcome: AttemptOutcome;
  dry_run: boolean;
  http_status: number;
  detail: string | null;
  actor: string | null;
  created_at: string;
};

/**
 * What the route knows about a run, filled in as it learns it.
 *
 * Every field is optional because an attempt can be refused before any of them
 * is known — a request whose body will not parse names no connection and no
 * schema, and that refusal is still worth a row. A row with nulls says "this
 * was asked for and turned down", which is more than the nothing that was
 * recorded before.
 */
export type AttemptContext = {
  connectionId?: number | null;
  schemaName?: string | null;
  scripts?: AttemptScript[];
  dryRun?: boolean;
  actor?: string | null;
};

/**
 * A short sentence describing an attempt, for a screen that lists them.
 *
 * Kept here beside the classification so the words a reader sees and the value
 * an auditor filters on cannot describe different things.
 */
export function describeAttempt(outcome: AttemptOutcome, dryRun: boolean): string {
  if (outcome === "unknown") return "Outcome unknown — the commit did not report back";
  if (dryRun) {
    return outcome === "applied" ? "Rehearsed, nothing written" : "Rehearsal did not finish";
  }
  if (outcome === "applied") return "Applied";
  if (outcome === "refused") return "Refused before anything ran";
  return "Failed and rolled back";
}
