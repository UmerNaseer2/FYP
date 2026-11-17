// Performance advice: why a pass failed, in words.
//
// Holds describeStatsError and describeStructureError.

import {
  STATS_LOCK_TIMEOUT_MS,
  STATS_STATEMENT_TIMEOUT_MS,
  STRUCTURE_LOCK_TIMEOUT_MS,
} from "./types";

/**
 * Why the statistics pass failed, as a sentence for the screen.
 *
 * A timeout and a lock wait each get their own sentence, because each has a
 * cause the reader can do something about. Anything else from PostgreSQL is
 * quoted, since its own message is the most specific thing there is; an error
 * from anywhere else (a dropped connection, say) is quoted differently, so it
 * is not mistaken for something the server said.
 */
export function describeStatsError(error: unknown): string {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? (error as { code: unknown }).code
      : undefined;
  // A SQLSTATE is five digits or capital letters. Node's own error codes can
  // look the same (EPIPE, when the connection drops), but no SQLSTATE class
  // starts with E, so that tells the two apart.
  const fromPostgres = typeof code === "string" && /^[0-9A-DF-Z][0-9A-Z]{4}$/.test(code);
  const message = error instanceof Error ? error.message : String(error);
  const missing = "suggestions based on how the tables are used are missing";

  if (fromPostgres && code === "57014") {
    return (
      `Reading the usage statistics took longer than ${STATS_STATEMENT_TIMEOUT_MS / 1000} ` +
      `seconds, so it was stopped; ${missing}. Try again when the server is quieter.`
    );
  }
  if (fromPostgres && code === "55P03") {
    return (
      `Another session holds a lock on a table or index in this schema (a running ` +
      `ALTER TABLE, for example), so the statistics could not be read within ` +
      `${STATS_LOCK_TIMEOUT_MS / 1000} seconds; ${missing}. Try again once it has finished.`
    );
  }
  // PostgreSQL's words go in brackets, so the sentence still ends with a full
  // stop and whatever the screen adds after it reads as a sentence of its own.
  if (fromPostgres) {
    return `The server's usage statistics could not be read (PostgreSQL said: ${message}), so ${missing}.`;
  }
  return `The server's usage statistics could not be read (${message}), so ${missing}.`;
}

/**
 * Why reading the schema's structure failed, as a sentence for the screen.
 *
 * Without the structure there are no suggestions at all, so this is the
 * whole answer. A lock wait and a timeout get sentences of their own: the
 * connection worked and the server answered, so "check the connection
 * details" would send the reader to the wrong place. `code` is the SQLSTATE
 * that fetchSchemaSnapshot passes on when PostgreSQL sent one.
 */
export function describeStructureError(
  schema: string,
  connectionName: string,
  failure: { error: string; code?: string }
): string {
  const where = `"${schema}" on "${connectionName}"`;
  if (failure.code === "55P03") {
    return (
      `Another session holds a lock on a table or view in ${where} (a running ALTER ` +
      `TABLE, for example), so its structure could not be read within ` +
      `${STRUCTURE_LOCK_TIMEOUT_MS / 1000} seconds. Try again once that has finished.`
    );
  }
  if (failure.code === "57014") {
    return (
      `Reading the structure of ${where} took too long, so it was stopped. ` +
      `The server may be busy; try again when it is quieter.`
    );
  }
  return `Could not read ${where}. Check the connection details. Details: ${failure.error}`;
}
