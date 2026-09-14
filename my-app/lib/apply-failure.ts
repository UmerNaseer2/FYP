// How a failed answer from POST /api/scripts/apply ended. This is the one
// reading of it, so the rows, the toast, the header and the recovery bar on a
// screen cannot tell different stories about the same answer.
//
//   unknown      Nothing here saw how the run ended. The request never came
//                back, its body could not be read, the server says its COMMIT
//                did not report back (outcomeUnknown), or the status is not an
//                error and yet the answer is not a success.
//   refused      A 4xx other than 422. The server turned the run away and none
//                of its migrations applied. Every refusal but one comes before
//                the run's first write (it carries nothingRan). The one after
//                it is the forward-only check the route makes again under its
//                locks (step 8a): on a real run the ledger table and any
//                hoisted enum value are committed by then, and its error names
//                the enum values that stay. So a screen says "nothing was
//                applied", never "nothing ran", for a refusal.
//   not-started  A 5xx the server marks nothingRan. It stopped before its
//                first write to the target: a record it needed could not be
//                read, the target could not be reached, or the schema or
//                ledger check could not be made.
//   rolled-back  Anything else. The run reached its transaction and did not
//                commit, so none of its migrations applied. A real run commits
//                the ledger table and any hoisted enum value before that
//                transaction opens, so those can remain; a dry run writes
//                neither.
//
// 422 is the one 4xx that is not a refusal: a dry run whose SQL did run until
// PostgreSQL refused to use a new enum value inside its transaction. That is
// a rehearsal that failed, so it reads as rolled back.
//
// The route sets nothingRan on every answer it gives before its first write,
// 4xx included. Only a 5xx needs it read: a 4xx is a refusal either way, while
// a 500 or 503 on its own could as well be a run that rolled back (a lock
// timeout after BEGIN is a 503 too).

export type ApplyFailure = "unknown" | "refused" | "not-started" | "rolled-back";

/** The fields of a failed apply answer that decide how it is read. */
export type ApplyFailureFlags = {
  outcomeUnknown?: unknown;
  nothingRan?: unknown;
};

/**
 * Read a failed answer from the apply route. Pass `status: null` when the
 * request never completed and `reply: null` when its body was not JSON. Only
 * for an answer that was not a success.
 */
export function readApplyFailure(
  status: number | null,
  reply: ApplyFailureFlags | null
): ApplyFailure {
  if (status === null || reply === null || reply.outcomeUnknown === true) return "unknown";
  if (status < 400) return "unknown";
  if (status < 500 && status !== 422) return "refused";
  if (reply.nothingRan === true) return "not-started";
  return "rolled-back";
}
