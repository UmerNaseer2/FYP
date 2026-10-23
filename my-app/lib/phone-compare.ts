// ---------------------------------------------------------------------------
// phone-compare.ts
// What a paired phone is told about a comparison (POST /api/compare/phone).
//
// The desktop app's phone link calls that route when a phone asks for a
// comparison (compare.run in desktop/src/shared/remote/rpc.ts), and passes on
// only what it can read as the CompareSummary below. The types are a copy of
// the ones there, kept in step by hand: this app cannot import from the
// desktop folder.
//
// No database in here, so it can be tested without one. The route runs the
// comparison through runComparison, the same as the Compare screen, and this
// decides how much of the result leaves the computer:
//
//   - Nothing a database server said is passed on. A driver's error can name a
//     host, an address or a user ("connect ECONNREFUSED 10.0.0.5:5432"), and a
//     phone is easy to lose. Each failure gets a fixed sentence instead, which
//     says where the details are: on the computer.
//   - Schema names go exactly as they are, because the phone sends them back in
//     its next request, and a tidied name could ask for a schema that is not
//     there. Every other text is only shown, so it is tidied onto one line and
//     cut to a length a phone screen can hold.
//   - A long list of changes is cut to MAX_PHONE_LINES, breaking ones first,
//     and the rest are counted. The SQL is not sent at all: a phone is for
//     seeing what changed, and the script is run from the computer.
// ---------------------------------------------------------------------------

import { buildDiffDocument, type ChangeRow } from "./compare-export";
import { countedChanges } from "./compare-export-format";
import type { ComparisonHistoryView, OutcomeView, SourceView } from "./compare-run";
import { MAX_COMPARISON_TARGETS } from "./comparison-set-rules";
import type { Environment } from "./environments";

// ---------------------------------------------------------------------------
// The request and the answer, as desktop/src/shared/remote/rpc.ts has them
// ---------------------------------------------------------------------------

/** One schema a phone may name: a saved connection, and a schema in it. */
export type SchemaRef = { connectionId: number; schema: string };

/** What a phone asks for: one source schema, compared with each target. */
export type PhoneCompareRequest = { source: SchemaRef; targets: SchemaRef[] };

/** Either side of a comparison, as the phone shows it. */
export type ComparedSide = {
  /** The saved connection, or null when there is no such connection. */
  connectionId: number | null;
  /** The connection's name and database, as Compare shows them. Never its host. */
  name: string;
  environment: Environment;
  /** Exactly the name that was compared, so the phone can ask for it again. */
  schema: string;
};

/** The source, and why it could not be read, if it could not. */
export type SourceSummary = ComparedSide & { error: string | null };

/** What became of one target. Only "compared" has changes to show. */
export type TargetStatus =
  | "compared"
  | "same-as-source"
  | "unreachable"
  | "schema-missing"
  | "duplicate"
  | "no-connection"
  | "failed";

/** One row of the list of changes, as the export writes it (see ChangeRow). */
export type ChangeLine = Pick<
  ChangeRow,
  "category" | "table" | "object" | "change" | "severity" | "detail" | "manual"
>;

export type TargetSummary = ComparedSide & {
  status: TargetStatus;
  /** Why it was not compared, in one of the fixed sentences below. Null when it was. */
  error: string | null;
  /** The number the Compare header shows (see countedChanges). */
  changes: number;
  breaking: number;
  /** Changes no statement can make, which a person has to plan. */
  manual: number;
  /** The first MAX_PHONE_LINES rows, breaking ones first. */
  lines: ChangeLine[];
  /**
   * The rows left out. lines plus moreLines is every row, rename suggestions
   * included, which `changes` does not count.
   */
  moreLines: number;
  /** "Since the comparison on 12 Sept 2026, 10:00: 2 new differences.", or null. */
  history: string | null;
};

export type CompareSummary = { source: SourceSummary; targets: TargetSummary[] };

/** The same limit as rpc.ts. PostgreSQL cuts names at 63 bytes, so it refuses no real schema. */
export const MAX_SCHEMA_NAME_LENGTH = 128;

/**
 * Rows sent for each target. Six targets at this many rows, every text at its
 * longest, stay under 3 MB, well under the 8 MiB a phone link message may be
 * (MAX_LINK_MESSAGE_BYTES in desktop/src/shared/remote/link.ts).
 */
export const MAX_PHONE_LINES = 200;

// The longest each shown text may be, in characters. Room for any real name,
// not for an essay.
const MAX_NAME_LENGTH = 200;
const MAX_TABLE_LENGTH = 128;
const MAX_OBJECT_LENGTH = 160;
const MAX_DETAIL_LENGTH = 240;
const MAX_HISTORY_LENGTH = 400;

// ---------------------------------------------------------------------------
// What the phone is told when something could not be compared
// ---------------------------------------------------------------------------

const GONE = "This connection is no longer saved on the computer.";
const SAME_AS_SOURCE = "This is the source schema itself, so there is nothing to compare.";
const UNREACHABLE =
  "The computer could not connect to this database. Open Compare on the computer to see why.";
const SOURCE_UNREADABLE =
  "The computer could not read this schema. Open Compare on the computer to see why.";
const FAILED =
  "The computer could not compare this schema. Open Compare on the computer to see why.";

function noSuchSchema(schema: string): string {
  return `This database has no schema called "${clean(schema, MAX_SCHEMA_NAME_LENGTH)}".`;
}

/** index is the earlier target's place in the request, counted from 0. */
function duplicate(index: number | null): string {
  return index === null
    ? "This is the same database and schema as another target, so it is compared only once."
    : `This is the same database and schema as target ${index + 1}, so it is compared only once.`;
}

/** What a connection and a schema in a request must be, for the errors below. */
const REF_RULE =
  "a connection ID (a whole number, 1 or more) and a schema name of 1 to " +
  `${MAX_SCHEMA_NAME_LENGTH} characters, with no spaces at either end`;

/** Breaking first, so the changes that need a look survive a cut; the export's order within each. */
const SEVERITY_ORDER: ChangeRow["severity"][] = ["breaking", "safe", "info"];

const ELLIPSIS = "\u{2026}";

/**
 * Characters that show as nothing, or that change how the text around them is
 * shown: control characters other than spaces and line breaks (those are
 * folded into one space instead), the soft hyphen, the zero-width space, the
 * direction marks (U+200E, U+200F, U+202A to U+202E, U+2066 to U+2069) that
 * can make a name read backwards, invisible tags, and halves of a broken
 * emoji. The joiners U+200C and U+200D are kept, because emoji and some
 * scripts need them. Close to cleanDeviceName in
 * desktop/src/shared/remote/pairing.ts, but written out by hand, because this
 * app's ES2017 target has no \p{...} classes.
 */
const INVISIBLE =
  /[\u{0}-\u{8}\u{E}-\u{1F}\u{7F}-\u{9F}\u{AD}\u{61C}\u{180E}\u{200B}\u{200E}\u{200F}\u{202A}-\u{202E}\u{2060}-\u{2064}\u{2066}-\u{206F}\u{FEFF}\u{FFF9}-\u{FFFB}\u{D800}-\u{DFFF}\u{E0001}\u{E0020}-\u{E007F}]/gu;

// ---------------------------------------------------------------------------
// The request
// ---------------------------------------------------------------------------

/**
 * Read a phone's request, refusing anything else.
 *
 * The desktop app has already read it as strictly, but this route does not
 * take that on trust. A schema name with a space at either end is refused
 * rather than trimmed: Compare trims every name it is given, so " x" would
 * compare "x", and a name of only spaces would compare whichever schema
 * Compare picks first, usually public.
 */
export function readPhoneCompareRequest(
  body: unknown,
): { ok: true; data: PhoneCompareRequest } | { ok: false; error: string } {
  if (!isRecord(body)) {
    return {
      ok: false,
      error: "Send the comparison as a JSON object with a source and a list of targets.",
    };
  }
  const source = readSchemaRef(body.source);
  if (source === null) return { ok: false, error: `The source needs ${REF_RULE}.` };

  const list: unknown[] = Array.isArray(body.targets) ? body.targets : [];
  // Counted before any is read, so a long list is refused without reading each entry.
  const targets = list.length <= MAX_COMPARISON_TARGETS ? list.map(readSchemaRef) : [];
  if (targets.length === 0 || targets.includes(null)) {
    return {
      ok: false,
      error: `Send 1 to ${MAX_COMPARISON_TARGETS} targets, each with ${REF_RULE}.`,
    };
  }
  return { ok: true, data: { source, targets: targets.filter((target) => target !== null) } };
}

function readSchemaRef(value: unknown): SchemaRef | null {
  if (!isRecord(value)) return null;
  const { connectionId, schema } = value;
  if (typeof connectionId !== "number" || !Number.isSafeInteger(connectionId) || connectionId < 1) {
    return null;
  }
  if (
    typeof schema !== "string" ||
    schema.length < 1 ||
    schema.length > MAX_SCHEMA_NAME_LENGTH ||
    schema.trim() !== schema
  ) {
    return null;
  }
  return { connectionId, schema };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The request as the query the Compare button sends, for runComparison: run=1,
 * and each target's connection and schema at the same place in their two
 * lists. There is no compareData=1, so only the schemas are compared, never
 * the rows in them.
 */
export function phoneCompareQuery(request: PhoneCompareRequest): URLSearchParams {
  const query = new URLSearchParams();
  query.set("run", "1");
  query.set("sourceConnection", String(request.source.connectionId));
  query.set("sourceSchema", request.source.schema);
  for (const target of request.targets) {
    query.append("targetConnection", String(target.connectionId));
    query.append("targetSchema", target.schema);
  }
  return query;
}

// ---------------------------------------------------------------------------
// The answer
// ---------------------------------------------------------------------------

/**
 * The parts of runComparison's answer the summary reads. Narrowed so that the
 * code below cannot reach for the SQL or a driver's error by mistake, and so
 * that a test can build one by hand.
 */
export type PhoneCompareInput = {
  source: Pick<
    SourceView,
    "connectionId" | "displayName" | "environment" | "schema" | "schemaOptions" | "missingMessage"
  >;
  sourceError: string | null;
  outcomes: PhoneOutcome[];
};

/** One target's part of runComparison's answer, narrowed the same way. */
export type PhoneOutcome = Pick<
  OutcomeView,
  | "connectionId"
  | "displayName"
  | "environment"
  | "schema"
  | "sameAsSource"
  | "failure"
  | "duplicateOf"
  | "report"
> & {
  history: Pick<ComparisonHistoryView, "sentence"> | null;
};

/**
 * What the phone is told about one comparison. Every field is built here by
 * name, so a field added to the Compare screen later reaches a phone only once
 * somebody adds it here and to rpc.ts.
 */
export function summarizeForPhone(screen: PhoneCompareInput): CompareSummary {
  const error = sourceErrorFor(screen.source, screen.sourceError);
  return {
    source: { ...sideOf(screen.source), error },
    // Nothing is compared without a source, so there are no targets to report.
    targets: error === null ? screen.outcomes.map(summarizeTarget) : [],
  };
}

function sideOf(view: {
  connectionId: number | null;
  displayName: string;
  environment: Environment;
  schema: string;
}): ComparedSide {
  return {
    connectionId: view.connectionId,
    name: clean(view.displayName, MAX_NAME_LENGTH),
    environment: view.environment,
    // Not cleaned: the phone sends it back to ask again.
    schema: view.schema,
  };
}

/**
 * Why the source could not be read, in one of this file's sentences. The
 * screen's own message is not used, because it can quote the database server.
 */
function sourceErrorFor(
  source: PhoneCompareInput["source"],
  sourceError: string | null,
): string | null {
  if (source.missingMessage !== null) return GONE;
  if (sourceError === null) return null;
  // The server listed its schemas and this was not one of them: the one
  // failure that is about the name the phone sent, so it says so.
  if (source.schemaOptions.length > 0 && !source.schemaOptions.includes(source.schema)) {
    return noSuchSchema(source.schema);
  }
  return SOURCE_UNREADABLE;
}

function statusOf(outcome: PhoneOutcome): TargetStatus {
  if (outcome.sameAsSource) return "same-as-source";
  if (outcome.failure !== null) return outcome.failure;
  // Neither a report nor a reason should not happen. If it does, it is not
  // passed off as a target with no changes.
  return outcome.report === null ? "failed" : "compared";
}

function targetError(status: TargetStatus, outcome: PhoneOutcome): string | null {
  switch (status) {
    case "compared":
      return null;
    case "same-as-source":
      return SAME_AS_SOURCE;
    case "unreachable":
      return UNREACHABLE;
    case "schema-missing":
      return noSuchSchema(outcome.schema);
    case "duplicate":
      return duplicate(outcome.duplicateOf);
    case "no-connection":
      return GONE;
    case "failed":
      return FAILED;
  }
}

function summarizeTarget(outcome: PhoneOutcome): TargetSummary {
  const side = sideOf(outcome);
  const status = statusOf(outcome);
  // The second test only tells TypeScript what statusOf has already made sure of.
  if (status !== "compared" || outcome.report === null) {
    return {
      ...side,
      status,
      error: targetError(status, outcome),
      changes: 0,
      breaking: 0,
      manual: 0,
      lines: [],
      moreLines: 0,
      history: null,
    };
  }

  // The same rows, counted the same way, as the Compare screen and its export.
  const document = buildDiffDocument(outcome.report);
  const rows = SEVERITY_ORDER.flatMap((severity) =>
    document.changes.filter((row) => row.severity === severity),
  );
  const kept = rows.slice(0, MAX_PHONE_LINES);
  return {
    ...side,
    status,
    error: null,
    changes: countedChanges(document.totals),
    breaking: document.totals.breaking,
    manual: document.totals.manual,
    lines: kept.map(lineOf),
    moreLines: rows.length - kept.length,
    history: outcome.history === null ? null : clean(outcome.history.sentence, MAX_HISTORY_LENGTH),
  };
}

function lineOf(row: ChangeRow): ChangeLine {
  return {
    category: row.category,
    table: clean(row.table, MAX_TABLE_LENGTH),
    object: clean(row.object, MAX_OBJECT_LENGTH),
    change: row.change,
    severity: row.severity,
    detail: clean(row.detail, MAX_DETAIL_LENGTH),
    manual: row.manual,
  };
}

/**
 * Text for a phone screen: invisible characters taken out, each run of spaces
 * and line breaks made one space, and anything longer than max characters cut
 * short with an ellipsis. Array.from splits by code point rather than by
 * UTF-16 unit, so a cut never leaves half of a character such as an emoji.
 */
function clean(text: string, max: number): string {
  const tidy = text.replace(INVISIBLE, "").replace(/\s+/g, " ").trim();
  const chars = Array.from(tidy);
  return chars.length <= max ? tidy : chars.slice(0, max - 1).join("").trimEnd() + ELLIPSIS;
}
