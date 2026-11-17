// Query analysis: turning a database error into words.
//
// Holds toQueryError and describeQueryError, which say what went wrong with a
// query in plain language, and where in the text it went wrong.

/**
 * The parts of a PostgreSQL error this module reads.
 *
 * node-pg's DatabaseError carries all four; a network error carries only a
 * message (and a Node.js code such as ECONNRESET, which matches no SQLSTATE
 * below and so falls through to the general sentence).
 */
export type QueryError = {
  /** The five-character SQLSTATE, e.g. "42P01". */
  code?: string;
  message: string;
  /** 1-based character position in the text sent. node-pg gives a string. */
  position?: string | number;
  hint?: string;
};

/** Pull the fields above out of whatever a query threw. */
export function toQueryError(error: unknown): QueryError {
  if (error instanceof Error) {
    const e = error as Error & { code?: unknown; position?: unknown; hint?: unknown };
    return {
      code: typeof e.code === "string" ? e.code : undefined,
      message: e.message,
      position:
        typeof e.position === "string" || typeof e.position === "number" ? e.position : undefined,
      hint: typeof e.hint === "string" ? e.hint : undefined,
    };
  }
  return { message: String(error) };
}

/**
 * "line 2, column 8" for the place PostgreSQL pointed at, or null.
 *
 * PostgreSQL counts from the start of everything it was sent, EXPLAIN prefix
 * included, starting at 1. The user only ever saw their own query, so the
 * prefix is taken off before counting lines.
 */
function locateError(
  err: QueryError,
  source: { sql: string; prefixLength: number } | undefined
): string | null {
  if (!source || err.position === undefined) return null;
  const position = Number(err.position);
  if (!Number.isFinite(position)) return null;
  const index = position - 1 - source.prefixLength;
  // Outside the user's text means the error is about the prefix, which the
  // user cannot see or change; pointing at it would only confuse.
  if (index < 0 || index > source.sql.length) return null;
  const before = source.sql.slice(0, index);
  const line = before.split("\n").length;
  const column = index - (before.lastIndexOf("\n") + 1) + 1;
  return `line ${line}, column ${column}`;
}

/** Text as a sentence. PostgreSQL's own messages usually have no full stop. */
function withStop(text: string): string {
  const trimmed = text.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/**
 * The errors of a measured run whose sentence below is safe to give: they are
 * about the run itself (read-only, time limit, a lock, a missing permission)
 * and never carry a value from a row. Every other error of a measured run gets
 * one fixed sentence. See `source.ran` in describeQueryError.
 */
const RUN_ERRORS_SAFE_TO_DESCRIBE: ReadonlySet<string> = new Set([
  "25006", // tried to write in a read-only transaction
  "57014", // statement timeout, or cancelled
  "55P03", // lock not available
  "42501", // permission denied: names the table or function, not a value
]);

/** What the commonest value errors of a measured run mean, in fixed words. */
const RUN_VALUE_PROBLEMS: Record<string, string> = {
  "22012": "it divided by zero",
  "22003": "a number was too large or too small for its type",
  "22P02": "a value could not be read as the type the query asks for (for example text cast to a number)",
  "22007": "a value could not be read as a date or time",
  "22008": "a date or time was out of range",
};

/**
 * Turn a PostgreSQL error into a sentence an IT person can act on.
 *
 * Mapped by SQLSTATE, the stable code PostgreSQL attaches to every error,
 * rather than by searching the message: messages are translated when the
 * server runs in another language, and "canceling statement" alone cannot
 * tell a timeout from an administrator cancelling the query.
 *
 * `schema` is the one chosen on screen; unqualified names are looked up there
 * and then in public, so a missing table names both. `source` is the query as
 * typed plus the length of the EXPLAIN prefix, for pointing at a line.
 *
 * `source.ran` is true when the error came from the measured run, the one that
 * really runs the query. PostgreSQL has by then read and planned the query
 * once without complaint, so the error comes from the rows it met, and its
 * message can quote them: casting a row to a number fails with
 * `invalid input syntax for type integer: "<the row>"`. An analysis returns a
 * plan and timings, never row values, so PostgreSQL's text is then left out.
 */
export function describeQueryError(
  err: QueryError,
  schema: string,
  timeoutSeconds: number,
  source?: { sql: string; prefixLength: number; ran?: boolean }
): string {
  const message = err.message;
  const where = locateError(err, source);
  const at = where ? ` (at ${where} of your query)` : "";
  const searched = schema === "public" ? "in public" : `in ${schema} or in public`;

  if (source?.ran && !RUN_ERRORS_SAFE_TO_DESCRIBE.has(err.code ?? "")) {
    const what =
      RUN_VALUE_PROBLEMS[err.code ?? ""] ??
      (err.code?.startsWith("22")
        ? "a value it read could not be used the way the query asks"
        : "PostgreSQL stopped it part way");
    return (
      `The query failed while it was running: ${what}` +
      (err.code ? ` (PostgreSQL error code ${err.code})` : "") +
      `. PostgreSQL's own message is not shown, because it can quote values from ` +
      `the rows the query read. Untick Run it and measure to see the plan without ` +
      `running the query.`
    );
  }

  switch (err.code) {
    case "42P01": {
      // relation "orderz" does not exist / relation "nope.orders" does not exist
      const name = /relation "([^"]+)" does not exist/.exec(message)?.[1] ?? "that name";
      if (name.includes(".")) {
        return (
          `There is no table or view called ${name}${at}. Check the spelling of ` +
          `both the schema and the table name.`
        );
      }
      return (
        `There is no table or view called ${name} ${searched}, the schemas this ` +
        `screen searches${at}. Check the spelling, or put the schema in front of ` +
        `the name (for example other_schema.${name}).`
      );
    }
    case "3F000": {
      const name = /schema "([^"]+)" does not exist/.exec(message)?.[1];
      return (
        `There is no schema called ${name ?? "that"} on this server${at}. Check ` +
        `the spelling of the schema name.`
      );
    }
    case "42703": {
      // column o.totl does not exist / column "totl" does not exist
      const found = /column (?:"([^"]+)"|(\S+)) does not exist/.exec(message);
      const name = found ? (found[1] ?? found[2]) : "that name";
      return (
        `There is no column called ${name}${at}. Check the spelling, and which ` +
        `table it belongs to.` +
        (err.hint ? ` PostgreSQL suggests: ${withStop(err.hint)}` : "")
      );
    }
    case "42601": {
      if (/at end of input/.test(message)) {
        return (
          "The query stops too early: something is missing at the end, such as " +
          "a closing bracket or the rest of a clause."
        );
      }
      const near = /at or near "([^"]*)"/.exec(message)?.[1];
      return (
        `There is a syntax error${near !== undefined ? ` near "${near}"` : ""}` +
        `${at}. Look just before that point for a missing comma, bracket or keyword.`
      );
    }
    case "25006": {
      const what = /cannot execute (.+) in a read-only transaction/.exec(message)?.[1];
      return (
        `This query tries to change something${what ? ` (${what})` : ""}, and ` +
        `queries run read-only here, so it was stopped. Only queries that read ` +
        `data can be analysed. Untick Run it and measure to see the plan without ` +
        `running it.`
      );
    }
    case "57014":
      // Both a timeout and a manual cancel arrive as 57014; only the message
      // tells them apart, and it is the one case where that is unavoidable.
      if (/statement timeout/i.test(message)) {
        return (
          `PostgreSQL was still working on this query after ${timeoutSeconds} ` +
          `seconds, so it was stopped. If Run it and measure is ticked, untick it to ` +
          `see the plan without waiting for the query to finish. Or narrow the ` +
          `query down (a tighter WHERE, fewer joins, or a LIMIT) and try again.`
        );
      }
      return (
        "The query was cancelled before it finished, by an administrator or " +
        "another session. Try again; if it keeps happening, ask whoever looks " +
        "after this server."
      );
    case "55P03":
      return (
        "Another session is holding a lock on a table this query reads (often a " +
        "schema change that is still running), and the query gave up waiting for " +
        "it. Nothing is wrong with the query itself. Try again in a moment."
      );
    case "42501":
      return (
        `The database user this connection signs in as is not allowed to do this ` +
        `(PostgreSQL said: ${message}). Ask whoever manages the database to grant ` +
        `access, or use a connection whose user has it.`
      );
    case "42883": {
      if (/^operator does not exist/.test(message)) {
        const op = /operator does not exist: (.+)$/.exec(message)?.[1];
        return (
          `The operator in ${op ?? "this expression"}${at} cannot combine these ` +
          `types of value. Add a cast so both sides are the same type, for ` +
          `example some_column::integer.`
        );
      }
      const fn = /function (.+) does not exist/.exec(message)?.[1];
      return (
        `There is no function ${fn ?? "with that name"} that accepts these types ` +
        `of value${at}. Check the function's name, or add casts (for example ` +
        `::integer) so the values match what it expects.`
      );
    }
    case "42P02": {
      const param = /there is no parameter (\$\d+)/.exec(message)?.[1] ?? "$1";
      return (
        `This query uses ${param}-style placeholders, which an application fills ` +
        `in when it runs the query. Replace each one with a real value (for ` +
        `example 42 or 'paid') and analyse again.`
      );
    }
  }

  // Class 22 is "data exception": division by zero, a value that is not a
  // valid number or date, and so on. The message itself is already specific.
  if (err.code?.startsWith("22")) {
    return (
      `The query ran into a problem with a value${at}: ${message}. Fix the value, ` +
      `or the expression it comes from, and try again.`
    );
  }

  return (
    `PostgreSQL could not analyse this query${at}. PostgreSQL said: ` +
    withStop(message) +
    (err.hint ? ` Hint: ${withStop(err.hint)}` : "")
  );
}
