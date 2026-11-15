/**
 * Errors that say what to do. Server messages are written for whoever runs
 * the server; a screen needs three things instead: what happened, in words
 * anyone can read, what to press, and the server's own wording tucked away
 * under "Technical details" for whoever has to fix it.
 *
 * describeError reads a message the API sent back and names the case. Use it
 * through <ErrorNotice/> (components/ui/ErrorNotice) rather than on its own.
 */

export type ErrorKind = "password" | "unreachable" | "no-schemas" | "other";

export type FriendlyError = {
  kind: ErrorKind;
  /** The headline, or null when the message is already plain enough to stand alone. */
  title: string | null;
  /** One or two plain sentences. */
  body: string;
  /** The server's wording, shown under Technical details. Null when it adds nothing. */
  technical: string | null;
};

const PASSWORD_RE =
  /stored credentials can.?t be read|credentials can.?t be read|could not read the saved connection|can.?t be decrypted|cannot be decrypted|needs its password again/i;

// The database itself didn't answer. "Network error" and "failed to fetch"
// are left out on purpose: those mean this browser couldn't reach Schema
// Studio, so blaming the database would point at the wrong thing.
const UNREACHABLE_RE =
  /connection refused|econnrefused|host not found|enotfound|eai_again|getaddrinfo|timed out|timeout|could not connect|couldn.?t connect|can.?t connect|cannot connect|can.?t be reached|unreachable|didn.?t answer|terminated unexpectedly|connection terminated/i;

// A timeout the database itself raised while it was answering (a slow query
// or a held lock). The database is up, so this is not "can't be reached".
const DB_TIMEOUT_RE = /(lock|statement|idle.in.transaction.session|transaction) timeout|canceling statement/i;

const NO_SCHEMAS_RE = /no schemas/i;

export function describeError(
  raw: string | null | undefined,
  opts: { connectionName?: string | null } = {},
): FriendlyError {
  const message = (raw ?? "").trim();
  const name = opts.connectionName?.trim() || "This connection";

  if (PASSWORD_RE.test(message)) {
    return {
      kind: "password",
      title: `${name} needs its password again`,
      body:
        "The saved password can't be opened on this server. Enter it again and everything that uses this connection works as before.",
      technical: message || null,
    };
  }

  if (NO_SCHEMAS_RE.test(message)) {
    return {
      kind: "no-schemas",
      title: "No schemas to show",
      body: "This connection has no schemas your role can read.",
      technical: null,
    };
  }

  if (UNREACHABLE_RE.test(message) && !DB_TIMEOUT_RE.test(message)) {
    return {
      kind: "unreachable",
      title: `${name} can't be reached`,
      body: "The database didn't answer. Try again in a moment.",
      technical: message || null,
    };
  }

  return {
    kind: "other",
    title: null,
    body: message || "Something went wrong. Try again in a moment.",
    technical: null,
  };
}
