// Whether a failed COMMIT really leaves the outcome in doubt.
//
// COMMIT is the one statement whose failure is genuinely ambiguous: PostgreSQL
// can commit and then lose the connection on the way back, so nobody on this
// side knows whether the work landed. Both deploy routes therefore treated any
// failed COMMIT that way, and told the reader to go and inspect script_patch to
// find out what happened.
//
// Most failed COMMITs are not ambiguous at all. A DEFERRABLE constraint is
// checked at COMMIT: when it fails, the server answers, names the constraint,
// and rolls the whole transaction back — definitely, and it says so. A
// serialization failure and a deadlock end the same way. Sending the reader off
// to inspect a table when the server has already given them the reason is worse
// than unhelpful, because the answer they find there ("no row") is the same one
// a genuinely lost connection leaves behind.
//
// The signal is the SQLSTATE. A server that answered at all did not lose the
// connection: it processed the COMMIT, refused it, and rolled back. Two groups
// are the exception, because there the server is going away as it speaks.

/** A SQLSTATE is five characters: a two-character class and a three-character code. */
const SQLSTATE = /^[0-9A-Za-z]{5}$/;

/**
 * Node puts its own failures in the same `code` field, and the shape alone does
 * not tell them apart: "EPIPE" is five letters and reads as a perfectly valid
 * SQLSTATE. It is not one — it is the socket dying mid-write, which is the very
 * case that has to stay unknown. What gives it away is `errno`/`syscall`, which
 * every Node system error carries and no server error does.
 */
function isNodeSystemError(error: unknown): boolean {
  const details = error as { errno?: unknown; syscall?: unknown } | null;
  return typeof details?.errno === "number" || typeof details?.syscall === "string";
}

/**
 * Class 08 — connection_exception. The server is telling us the connection
 * itself is in trouble, which is exactly the case where the commit's fate
 * cannot be read from the answer.
 */
const CONNECTION_CLASS = "08";

/**
 * Shutdowns. The server is stopping (or has just come back from a crash) as it
 * answers, so a COMMIT in flight may have been written before it went or may
 * not: admin_shutdown, crash_shutdown, cannot_connect_now.
 */
const SHUTDOWN_CODES = new Set(["57P01", "57P02", "57P03"]);

/**
 * True when a failed COMMIT leaves the run's outcome unknown — no answer from
 * the server, or an answer that says the server is going away.
 *
 * False means the server refused the COMMIT and rolled the transaction back. Say
 * so, and show what it said.
 */
export function commitOutcomeIsUnknown(error: unknown): boolean {
  if (isNodeSystemError(error)) return true;
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code !== "string" || !SQLSTATE.test(code)) return true;
  if (code.slice(0, 2) === CONNECTION_CLASS) return true;
  return SHUTDOWN_CODES.has(code);
}

/**
 * What the server said, ready to put at the end of a sentence. Empty when it
 * said nothing useful, so the caller's sentence still reads properly.
 *
 * A pg error carries the constraint's own name in `constraint` and the table in
 * `table`; a deferred foreign key's message does not always name them, and they
 * are the first thing the reader needs.
 */
export function describeCommitError(error: unknown): string {
  const details = error as { message?: unknown; constraint?: unknown; table?: unknown } | null;
  const message = typeof details?.message === "string" ? details.message.trim() : "";
  if (message === "") return "";
  const constraint = typeof details?.constraint === "string" ? details.constraint : "";
  const table = typeof details?.table === "string" ? details.table : "";
  if (constraint === "") return message;
  const where = table === "" ? "" : ` on "${table}"`;
  // Only when the message has not named the constraint already.
  if (message.includes(constraint)) return message;
  return `${message} (constraint "${constraint}"${where})`;
}
