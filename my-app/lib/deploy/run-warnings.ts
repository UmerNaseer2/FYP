// The warnings PostgreSQL sends while a deploy script runs, kept so Deploy and
// Quick run can show them under the version that raised them. The apply route
// (app/api/scripts/apply) collects them, and the pages read them back.
//
// A script can end without an error and still leave something undone. The
// owner changes in a generated script are one case: a login that may not give
// an object to another role skips that change, and PostgreSQL sends a WARNING
// naming the object (see ownerStatement in lib/sql/generate/privileges.ts). A
// GRANT the login may not make is another: PostgreSQL grants nothing and warns
// "no privileges were granted". Without this, such a run looked like a full
// success.
//
// Only warnings are kept, not every NOTICE. PostgreSQL also sends a NOTICE for
// things a generated script does on purpose, such as "relation already exists,
// skipping" from an IF NOT EXISTS on a second run, and a list of those under
// every row would hide the one that matters.
//
// No imports, so the page and the server can both use it.

/** The parts of a node-postgres notice read here. */
export type PgNotice = { message?: string; severity?: string; code?: string };

/** The warnings one version raised, as the apply route reports them. */
export type RunWarnings = {
  /** The first MAX_RUN_WARNINGS messages, in the order PostgreSQL sent them. */
  warnings: string[];
  /** How many more came after those. */
  moreWarnings: number;
};

/** How many warnings one version keeps. A script that raises more is counted, not listed. */
export const MAX_RUN_WARNINGS = 20;

/** How much of one message is kept. A script may raise any text at all. */
export const MAX_WARNING_LENGTH = 500;

/**
 * True for a notice that is a warning.
 *
 * The SQLSTATE says so in any language: class 01 is "warning", and RAISE
 * WARNING without a code of its own sends 01000. The severity word is a second
 * check, for a warning with a code from another class, but node-postgres reads
 * the translated word, so it only matches on a server that answers in English.
 */
export function isWarning(notice: PgNotice): boolean {
  return (notice.code ?? "").startsWith("01") || notice.severity === "WARNING";
}

/** One line, and not too long. */
function tidy(message: string): string {
  const line = message.replace(/\s+/g, " ").trim();
  return line.length > MAX_WARNING_LENGTH ? `${line.slice(0, MAX_WARNING_LENGTH - 3)}...` : line;
}

/**
 * Collects one script's warnings. Hand `listener` to client.on("notice") for
 * that one query, and put what `result` gives on the version's outcome.
 */
export function warningCollector(): {
  listener: (notice: PgNotice) => void;
  /** Nothing at all when the script raised no warning, so the outcome keeps its old shape. */
  result: () => Partial<RunWarnings>;
} {
  const warnings: string[] = [];
  let moreWarnings = 0;
  return {
    listener(notice) {
      if (!isWarning(notice)) return;
      if (warnings.length >= MAX_RUN_WARNINGS) {
        moreWarnings += 1;
        return;
      }
      warnings.push(tidy(notice.message ?? ""));
    },
    result() {
      if (warnings.length === 0) return {};
      return moreWarnings > 0 ? { warnings: [...warnings], moreWarnings } : { warnings: [...warnings] };
    },
  };
}

/**
 * The warnings on one outcome of an apply answer, as a page reads them.
 * Anything that is not a list of strings counts as none, so an answer from a
 * server without this reads as a run that raised no warnings.
 */
export function readRunWarnings(outcome: unknown): RunWarnings {
  const record =
    typeof outcome === "object" && outcome !== null ? (outcome as Record<string, unknown>) : {};
  const warnings = Array.isArray(record.warnings)
    ? record.warnings.filter((warning): warning is string => typeof warning === "string")
    : [];
  const more = record.moreWarnings;
  const moreWarnings = typeof more === "number" && Number.isInteger(more) && more > 0 ? more : 0;
  return { warnings, moreWarnings };
}
