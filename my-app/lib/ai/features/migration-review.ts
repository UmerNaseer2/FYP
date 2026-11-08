// ---------------------------------------------------------------------------
// lib/ai/features/migration-review.ts
// Feature 2: the migration review on the Deploy screen, before a run.
//
// The engine splits the run into statements, each with an id such as S3, and
// reads every one with the app's own checks: does it destroy rows, is it
// breaking, can it fail on the rows already there, can it run inside the run's
// transaction at all. That reading is each statement's floor. The model is
// shown the statements, the floors, how big the touched tables are and what
// uses them, and asked for a verdict and findings. Then the code checks it:
//   - a finding that cites an id not in the run, or names in backticks an
//     object that is neither in the target nor in the run's SQL, is dropped;
//   - when the answer is shown, a finding's severity is raised to the floor of
//     the statements it cites, never lowered, and the model's own severity is
//     kept beside it, so a "safe" verdict over a finding the app raised is
//     replaced;
//   - every flagged statement no finding cites gets a finding written by the
//     app itself (fromApp), so a statement the app knows is dangerous is never
//     left off the screen because the model missed it.
// Only structure goes in the prompt: the SQL with every value in it replaced
// by ?, names, types, keys, and the planner's row estimates for the touched
// tables, rounded. No rows, no passwords, no hosts, no database names.
// ---------------------------------------------------------------------------

import { z } from "zod";
import { gradeSql } from "../../change-type";
import { readScriptLevel, scriptLabel } from "../../deploy-risk";
import type { SchemaSnapshot } from "../../postgres";
import {
  findMightFailStatements,
  findRowDestroyingStatements,
  hasExecutableSql,
  maskNonCode,
  splitStatements,
} from "../../sql-guard";
import { countOf } from "../../plural";
import { bareName, isKnownName, knownNames } from "../checks";
import { schemaSlice } from "../context";
import { buildDependencyIndex, describeDependents } from "../dependents";
import { estimateTokens } from "../provider";
import type { AiTaskSpec } from "../run";
import { roughBytes, roughRows, type TableSize } from "../table-sizes";
import { unknownTickedNames } from "./compare-summary";
import {
  SEVERITY_ORDER,
  type MigrationReviewAnswer,
  type MigrationReviewFinding,
  type ReviewedStatement,
  type ReviewSeverity,
} from "./migration-review-view";

/** The statement text the prompt shows, in tokens, before it lists only flagged statements. */
export const STATEMENT_TOKENS = 6_000;
const STATEMENT_CHARS = 700;
const STATEMENT_CHARS_PAST_BUDGET = 200;
/** Statements listed at most, flagged or not. */
const MAX_LISTED = 300;
const MAX_TOUCHED = 40;
const TARGET_SLICE_TOKENS = 2_000;
const MAX_FINDINGS = 8;
/** What the apply and revert routes set: SET LOCAL lock_timeout = 15000. */
const RUN_LOCK_WAIT_SECONDS = 15;

/** One script of the run, as the Deploy screen sends it. */
export type ReviewScript = {
  scriptName: string;
  version: string;
  sqlContent: string;
  /**
   * The level the caller sent with the script, as Deploy's change_type. Only
   * "breaking", "additive" or "patch" counts, the same as for deploy-risk.
   */
  changeType?: unknown;
};

/** The model's answer: a finding before the app raises it and marks where it came from. */
export type ModelReviewFinding = Omit<MigrationReviewFinding, "fromApp" | "modelSeverity">;
export type ModelReview = { verdict: string; findings: ModelReviewFinding[] };

// trim() runs before min(1), so an answer of only spaces is refused and asked
// again, rather than saved as an empty verdict the next read would refuse.
export const migrationReviewSchema = z.object({
  verdict: z.string().trim().min(1).max(400),
  findings: z
    .array(
      z.object({
        statements: z.array(z.string()).min(1).max(30),
        severity: z.enum(["high", "medium", "low"]),
        title: z.string().trim().min(1).max(160),
        why: z.string().trim().min(1).max(700),
        saferWay: z.string().trim().max(900),
        objects: z.array(z.string()).max(12),
      })
    )
    .max(12),
});

export const MIGRATION_REVIEW_SYSTEM = [
  "You review a database migration for the person about to apply it to the target database, before it runs.",
  "Answer in JSON with two parts:",
  "- verdict: one or two sentences, at most 50 words, on whether this run is safe to apply as it stands, and what to do first when it is not.",
  `- findings: the problems, most serious first, at most ${MAX_FINDINGS}. Put related statements in one finding. Each finding cites the ids of its statements (S1, S2 ...) and has: severity; title, at most 12 words; why, one or two sentences on what goes wrong on this target, using the table sizes and the WHAT USES list; saferWay, how to get the same result with less risk in one or two sentences, with SQL when it helps, or an empty string when there is nothing better; objects, the tables, columns, views or other objects it is about.`,
  "Severity is high when the run can lose data, fail part way, or hold a lock long enough to stop the application; medium when it can fail on rows already in the table or break something that uses the target; low for anything else worth knowing. Each statement shows the app's own reading in brackets. Never set a severity below the reading of the statements you cite: the app raises it if you do.",
  "Look for: lost data (dropped tables or columns, TRUNCATE, DELETE or UPDATE with no WHERE); statements that fail on existing rows (NOT NULL with no default, a UNIQUE, CHECK or FOREIGN KEY the rows may break, a type change that cannot cast); long locks on big tables (a type change or volatile default that rewrites the table, an index built without CONCURRENTLY, a constraint checked in one go where NOT VALID then VALIDATE CONSTRAINT holds a lighter lock); objects the WHAT USES list shows will break.",
  "Every value written in the SQL (a string, a password, a host, and a number in a statement that reads or writes rows) is shown as ?. The app takes the real value out before it sends the statement, so never treat a ? as the value itself or as a problem.",
  "The whole run is one transaction. Anything that cannot run inside a transaction, such as CREATE INDEX CONCURRENTLY, fails the run if it is in a script, so when you suggest it, say it has to be run by hand outside the app.",
  "When nothing is wrong, findings is an empty list and the verdict says the run looks safe.",
  "Cite only ids from the STATEMENTS list, and only in the statements field: the screen shows them beside each finding, so never write an id in verdict, title, why or saferWay. Put every table, column, view or other object name you write in backticks. In saferWay, SQL may go in backticks too; nowhere else does anything but names.",
].join("\n");

/** Statements that PostgreSQL refuses inside a transaction block, and the word to name. */
const NO_TRANSACTION: [RegExp, string][] = [
  [/\bCONCURRENTLY\b/i, "CONCURRENTLY"],
  [/^\s*VACUUM\b/i, "VACUUM"],
  [/^\s*CREATE\s+DATABASE\b/i, "CREATE DATABASE"],
  [/^\s*ALTER\s+SYSTEM\b/i, "ALTER SYSTEM"],
  [/^\s*CREATE\s+TABLESPACE\b/i, "CREATE TABLESPACE"],
];

export type ReviewStatementFact = {
  label: string;
  sql: string;
  floor: ReviewSeverity;
  flags: string[];
  /** Target tables and views it names. */
  touched: string[];
};

export type ReviewListing = {
  /** S1, S2 ... in the order the run applies them. */
  statements: Map<string, ReviewStatementFact>;
  /** Target tables and views the run names, first touched first. */
  touched: string[];
  /** Every name in the run's SQL, lowercased: a table it creates counts as real. */
  runNames: Set<string>;
};

function clip(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit)} ...` : flat;
}

/**
 * The statement with its comments blanked, strings and quoted names kept. The
 * prompt shows a statement on one line, where a `--` comment would read as if
 * it hid the SQL after it. A comment is where the two masks differ: one blanks
 * comments and strings, the other strings only.
 */
function withoutComments(sql: string): string {
  const all = maskNonCode(sql, { keepQuotedNames: true });
  const strings = maskNonCode(sql, { keepQuotedNames: true, keepComments: true });
  let out = "";
  for (let i = 0; i < sql.length; i += 1) out += all[i] !== strings[i] ? " " : sql[i];
  return out;
}

/** The words that start a statement that reads or writes rows. */
const ROW_STATEMENTS = new Set(["INSERT", "UPDATE", "DELETE", "MERGE", "COPY", "WITH", "SELECT", "VALUES", "CALL", "TABLE"]);

/** The first word of masked code, upper case: "INSERT", "WITH", "DO". */
function firstWord(code: string): string {
  return (/^[\s(]*([A-Za-z_]+)/.exec(code)?.[1] ?? "").toUpperCase();
}

/**
 * Is the dollar-quoted text that starts at `at` the code of a DO block or of
 * a function or procedure? `code` is the masked statement, so the text before
 * `at` holds only code.
 */
function isCodeBody(code: string, at: number): boolean {
  const before = code.slice(0, at);
  if (/^\s*DO\s*(?:LANGUAGE\s+(?:"[^"]*"|\w+)\s*)?$/i.test(before)) return true;
  return /^\s*CREATE\s+(?:OR\s+REPLACE\s+)?(?:FUNCTION|PROCEDURE)\b/i.test(code) && /\bAS\s*$/i.test(before);
}

const DOLLAR_TAG = /^\$(?:[A-Za-z_\u0080-\uffff][A-Za-z0-9_\u0080-\uffff]*)?\$/;

/**
 * Numbers replaced by ?. Only for a statement that reads or writes rows,
 * where a number is a value (VALUES (7, 19.95), WHERE id = 42). The default
 * mask blanks strings and quoted names, so a digit inside either is left
 * alone, and the look-behind keeps the digits of a name (t1) and of a $1.
 */
function hideNumbers(sql: string): string {
  const code = maskNonCode(sql);
  const number = /(?<![A-Za-z0-9_$\u0080-\uffff.])(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?[A-Za-z0-9_]*/g;
  let out = "";
  let from = 0;
  for (const match of code.matchAll(number)) {
    out += `${sql.slice(from, match.index)}?`;
    from = match.index + match[0].length;
  }
  return out + sql.slice(from);
}

/**
 * The statement as the AI and the screen get it: comments taken out, and
 * every value replaced by '?', so no password, host, database name or row
 * value leaves the app. The structure stays: the kind of statement, every
 * name, every type.
 *   - A string or dollar-quoted text becomes '?'.
 *   - The body of a DO block or of a function is code, not a value: it is
 *     kept, and the values inside it are replaced the same way. Inside a body,
 *     every string and nested dollar-quoted text is a value.
 *   - A number is a value only in a statement that reads or writes rows
 *     (INSERT, UPDATE ...). In other statements, and in a function's body, a
 *     number is structure (varchar(80), DEFAULT 0) and stays.
 */
export function redactValues(sql: string, readBodies = true): string {
  const text = withoutComments(sql);
  const code = maskNonCode(text, { keepQuotedNames: true });
  let out = "";
  let i = 0;
  while (i < text.length) {
    if (text[i] === code[i]) {
      out += text[i];
      i += 1;
      continue;
    }
    // A string or dollar-quoted text opens here. The mask blanks it to spaces
    // (keeping newlines), so it ends at the last character the mask changed
    // before the code goes on.
    let end = i + 1;
    for (let j = i; j < text.length && /\s/.test(code[j]); j += 1) {
      if (text[j] !== code[j]) end = j + 1;
    }
    const literal = text.slice(i, end);
    const tag = DOLLAR_TAG.exec(literal)?.[0];
    if (readBodies && tag !== undefined && isCodeBody(code, i)) {
      const closed = literal.length >= tag.length * 2 && literal.endsWith(tag);
      const body = literal.slice(tag.length, closed ? literal.length - tag.length : literal.length);
      out += tag + redactValues(body, false) + (closed ? tag : "");
    } else {
      out += "'?'";
    }
    i = end;
  }
  return readBodies && ROW_STATEMENTS.has(firstWord(code)) ? hideNumbers(out) : out;
}

/**
 * The masked code split by brackets: the top level first, then each bracket
 * group, with the groups inside each one blanked. A WHERE in a subquery is in
 * the subquery's group, not in the statement's own level.
 */
function bracketLevels(code: string): string[] {
  const open: string[] = [""];
  const closed: string[] = [];
  for (const ch of code) {
    if (ch === "(") {
      open[open.length - 1] += " ";
      open.push("");
    } else if (ch === ")" && open.length > 1) {
      closed.push(open.pop()!);
      open[open.length - 1] += " ";
    } else {
      open[open.length - 1] += ch;
    }
  }
  return [...open, ...closed];
}

/**
 * Is this level an UPDATE with no WHERE of its own? A level that starts with
 * WITH runs the first statement word after its CTEs, which are groups of
 * their own and so already blanked here.
 */
function isUpdateWithoutWhere(level: string): boolean {
  let verb = firstWord(level);
  if (verb === "WITH") verb = (/\b(SELECT|INSERT|UPDATE|DELETE|MERGE|VALUES|TABLE)\b/i.exec(level)?.[1] ?? "").toUpperCase();
  return verb === "UPDATE" && !/\bWHERE\b/i.test(level);
}

function higher(a: ReviewSeverity, b: ReviewSeverity): ReviewSeverity {
  return SEVERITY_ORDER.indexOf(a) >= SEVERITY_ORDER.indexOf(b) ? a : b;
}

const IDENT = String.raw`(?:"(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*)`;
const DOTTED = new RegExp(`${IDENT}(?:\\s*\\.\\s*${IDENT}){0,2}`, "g");

/**
 * The names a statement uses, lowercased, each part and each dotted name
 * whole. Comments and string literals are blanked first; the bodies of DO
 * blocks are read, since a generated script adds its constraints in them.
 */
export function statementNames(sql: string): string[] {
  const code = maskNonCode(sql, { keepQuotedNames: true, readDollarBodies: true });
  const names = new Set<string>();
  for (const match of code.matchAll(DOTTED)) {
    const whole = match[0];
    const parts = whole.split(/\s*\.\s*/).map((p) => p.replace(/^"|"$/g, "").replace(/""/g, '"').toLowerCase());
    for (const part of parts) names.add(part);
    if (parts.length > 1) names.add(bareName(parts.join(".")));
  }
  return [...names];
}

/** The app's own reading of one statement: its floor and what made it. */
export function readStatement(sql: string, replacedByNext: boolean): { floor: ReviewSeverity; flags: string[] } {
  const flags: string[] = [];
  let floor: ReviewSeverity = "low";
  const raise = (to: ReviewSeverity) => {
    floor = higher(floor, to);
  };

  const code = maskNonCode(sql);
  for (const [pattern, word] of NO_TRANSACTION) {
    if (pattern.test(code)) {
      flags.push(`cannot run inside the run's transaction (${word})`);
      raise("high");
    }
  }
  const destroys = findRowDestroyingStatements(sql);
  if (destroys.length > 0) {
    flags.push(`deletes rows (${destroys.join(", ")})`);
    raise("high");
  }
  // The engine grades structure, and an UPDATE moves none, so it never flags
  // one. With no WHERE it rewrites every row, and the old values are gone once
  // the run commits. Read here only: Deploy's gates stay the engine's. Each
  // bracket level is read on its own, so a WHERE inside a subquery does not
  // count for the UPDATE around it, and WITH ... UPDATE is read too.
  if (bracketLevels(code).some(isUpdateWithoutWhere)) {
    flags.push("changes every row (UPDATE with no WHERE)");
    raise("medium");
  }
  if (!replacedByNext) {
    const grade = gradeSql(sql);
    if (grade.sureLevel === "breaking") {
      flags.push(`breaking (${grade.because ?? "breaking change"})`);
      raise("high");
    } else if (grade.level === "breaking") {
      flags.push(`breaking unless ${grade.unless ?? "it is known to be safe"}`);
      raise("medium");
    }
  } else {
    flags.push("replaced by the next statement");
  }
  const mightFail = findMightFailStatements(sql);
  if (mightFail.length > 0) {
    flags.push(`can fail on existing rows (${mightFail.join(", ")})`);
    raise("medium");
  }
  return { floor, flags };
}

/**
 * The generator's replace idiom: DROP INDEX or DROP TRIGGER straight before
 * the CREATE that remakes it. gradeSql reads the pair as the CREATE alone, so
 * the pair grades the same as its second half when the DROP is a replacement.
 */
function isReplacement(statement: string, next: string | undefined): boolean {
  if (next === undefined || !/^\s*DROP\s+(INDEX|TRIGGER)\b/i.test(maskNonCode(statement))) return false;
  const pair = gradeSql(`${statement};\n${next}`);
  const alone = gradeSql(next);
  return pair.level === alone.level && pair.sureLevel === alone.sureLevel && pair.because === alone.because;
}

/**
 * The flag a statement carries when Deploy counts its script as breaking
 * (by its stamp, the level sent with it, or its SQL as a whole) and no
 * statement's own reading says so.
 */
export const SCRIPT_BREAKING_FLAG = "breaking (Deploy counts this script as breaking)";

/** The run as numbered statements, or null when nothing in it would run. */
export function listReviewStatements(scripts: readonly ReviewScript[], snapshot: SchemaSnapshot): ReviewListing | null {
  const targetNames = new Map<string, string>();
  for (const name of [...snapshot.tables.map((t) => t.name), ...(snapshot.views ?? []).map((v) => v.name)]) {
    targetNames.set(name.toLowerCase(), name);
  }

  const statements = new Map<string, ReviewStatementFact>();
  const touched: string[] = [];
  const runNames = new Set<string>();
  for (const script of scripts) {
    const parts = splitStatements(script.sqlContent).filter((s) => hasExecutableSql(s));
    const label = scriptLabel(script.scriptName, script.version);
    const ids: string[] = [];
    parts.forEach((sql, k) => {
      const names = statementNames(sql);
      names.forEach((n) => runNames.add(n));
      const mine: string[] = [];
      for (const n of names) {
        const real = targetNames.get(n);
        if (real && !mine.includes(real)) mine.push(real);
      }
      for (const real of mine) if (!touched.includes(real)) touched.push(real);
      const reading = readStatement(sql, isReplacement(sql, parts[k + 1]));
      const id = `S${statements.size + 1}`;
      ids.push(id);
      statements.set(id, {
        label: parts.length > 1 ? `${label}, statement ${k + 1}` : label,
        // What the prompt and the screen show: values replaced by ?.
        sql: redactValues(sql).trim(),
        floor: reading.floor,
        flags: reading.flags,
        touched: mine,
      });
    });

    // The review never rates a script lower than Deploy's risk list does. The
    // stamp is a comment, so neither the model nor readStatement sees it, and
    // a level stamped by hand (or sent with the run) can say more than any one
    // statement's SQL. Then every statement of the script carries Deploy's
    // reading, at least medium, the prompt's grade for breaking what uses the
    // target.
    const level = readScriptLevel({ sqlContent: script.sqlContent, changeType: script.changeType });
    const ownBreaking = ids.some((id) => statements.get(id)!.flags.some((flag) => flag.startsWith("breaking")));
    if (level.breaking && !ownBreaking) {
      for (const id of ids) {
        const statement = statements.get(id)!;
        statement.flags.push(SCRIPT_BREAKING_FLAG);
        statement.floor = higher(statement.floor, "medium");
      }
    }
  }
  return statements.size === 0 ? null : { statements, touched, runNames };
}

export type MigrationReviewFacts = {
  statements: Map<string, ReviewStatementFact>;
  /** The ids the prompt listed. Only these may be cited. */
  listed: Set<string>;
  /** Names in the target schema. */
  known: Set<string>;
  runNames: Set<string>;
};

export type MigrationReviewTask = {
  spec: AiTaskSpec<ModelReview>;
  facts: MigrationReviewFacts;
  /** Estimated prompt size, for the benchmark. */
  inputTokens: number;
};

export function buildMigrationReviewTask(
  listing: ReviewListing,
  options: {
    action: "deploy" | "revert";
    snapshot: SchemaSnapshot;
    sizes: Map<string, TableSize>;
    /** runFingerprint of the scripts: what the approval would be for. */
    fingerprint: string;
  }
): MigrationReviewTask {
  const lines: string[] = [];
  const listed = new Set<string>();
  let tokens = 0;
  let unlisted = 0;
  for (const [id, s] of listing.statements) {
    const flagged = s.floor !== "low";
    const reading = s.flags.length > 0 ? `${s.floor}: ${s.flags.join("; ")}` : s.floor;
    const full = `${id} [${reading}] ${s.label}: ${clip(s.sql, STATEMENT_CHARS)}`;
    const cost = estimateTokens(full) + 1;
    let line: string | null = null;
    if (listed.size < MAX_LISTED && tokens + cost <= STATEMENT_TOKENS) line = full;
    else if (listed.size < MAX_LISTED && flagged) {
      line = `${id} [${reading}] ${s.label}: ${clip(s.sql, STATEMENT_CHARS_PAST_BUDGET)}`;
    }
    if (line === null) {
      unlisted += 1;
      continue;
    }
    lines.push(line);
    listed.add(id);
    tokens += estimateTokens(line) + 1;
  }
  if (unlisted > 0) lines.push(`(${unlisted} more statements are not listed.)`);

  const touched = listing.touched.slice(0, MAX_TOUCHED);
  const sizeLines = touched.map((name) => {
    const size = options.sizes.get(name);
    if (!size) {
      const isView = (options.snapshot.views ?? []).some((v) => v.name === name);
      return `${name}: ${isView ? "a view" : "size unknown"}`;
    }
    return `${name}: ${roughRows(size.rows)}, ${roughBytes(size.bytes)}`;
  });

  const index = buildDependencyIndex(options.snapshot);
  const dependentLines = touched.map((name) => describeDependents(index, name));
  const slice = schemaSlice(options.snapshot, { focus: touched, maxTokens: TARGET_SLICE_TOKENS });

  const scriptCount = new Set([...listing.statements.values()].map((s) => s.label.split(", statement ")[0])).size;
  const sections = [
    "THE RUN",
    options.action === "deploy"
      ? `A deploy of ${countOf(scriptCount, "script")}, ${countOf(listing.statements.size, "statement")}, applied in the order listed.`
      : `A rollback: the stored down scripts of ${countOf(scriptCount, "version")}, ${countOf(listing.statements.size, "statement")}, applied in the order listed.`,
    `It runs as one transaction: if any statement fails, nothing is kept. Each statement waits at most ${RUN_LOCK_WAIT_SECONDS} seconds for a lock, and the run stops if it cannot get one. A statement that holds its lock has no time limit, so a slow one blocks everyone else using that table until the run ends.`,
    "",
    "STATEMENTS (id [the app's reading] script: sql)",
    ...lines,
    "",
    "TOUCHED TABLES (the database's own estimates)",
    ...(sizeLines.length > 0 ? sizeLines : ["The run names no table that is in the target now."]),
    "",
    "WHAT USES THEM",
    ...(dependentLines.length > 0 ? dependentLines : ["Nothing listed."]),
    "",
    "TARGET SCHEMA NOW",
    slice.text,
  ];
  const prompt = sections.join("\n");

  const facts: MigrationReviewFacts = {
    statements: listing.statements,
    listed,
    known: knownNames(options.snapshot),
    runNames: listing.runNames,
  };

  return {
    facts,
    inputTokens: estimateTokens(`${MIGRATION_REVIEW_SYSTEM}\n${prompt}`),
    spec: {
      feature: "migration-review",
      tier: "smart",
      system: MIGRATION_REVIEW_SYSTEM,
      prompt,
      schema: migrationReviewSchema,
      // The prompt carries the sizes, rounded, so a table that grew asks again.
      cacheInput: { fingerprint: options.fingerprint, prompt },
      maxOutputTokens: 2_000,
      check: (value) => checkMigrationReview(value, facts),
    },
  };
}

function normaliseIds(ids: readonly string[]): string[] {
  return [...new Set(ids.map((id) => id.trim().toUpperCase()))];
}

/** A name counts when the target has it, or every part of it is in the run's SQL. */
function knownToReview(name: string, facts: MigrationReviewFacts): boolean {
  if (isKnownName(name, facts.known)) return true;
  // schema.table.column with a schema nobody has: bareName would drop the
  // schema, and the rest could pass on its own.
  const whole = name.replace(/"/g, "").split(".");
  if (whole.length >= 3 && !facts.known.has(`schema:${whole[0].trim().toLowerCase()}`)) return false;
  return bareName(name)
    .split(".")
    .every((part) => facts.runNames.has(part));
}

/** The app's floor for the statements a finding cites: the highest of their readings. */
function floorOf(ids: readonly string[], facts: MigrationReviewFacts): ReviewSeverity {
  return ids.reduce<ReviewSeverity>((top, id) => higher(top, facts.statements.get(id)?.floor ?? "low"), "low");
}

export type MigrationReviewCheck = {
  value: ModelReview;
  problems: string[];
  /** For the benchmark: what the check had to fix. */
  report: { droppedItems: number; droppedObjects: number; severityRaised: number };
};

export function checkMigrationReview(answer: ModelReview, facts: MigrationReviewFacts): MigrationReviewCheck {
  const problems: string[] = [];
  const reasons: string[] = [];
  const alsoKnown = (name: string) => knownToReview(name, facts);
  let droppedItems = 0;
  let droppedObjects = 0;
  let severityRaised = 0;

  const verdictUnknown = unknownTickedNames(answer.verdict, facts.known, alsoKnown);
  if (verdictUnknown.length > 0) {
    problems.push(`The verdict names things that are neither in the target nor in the run: ${verdictUnknown.join(", ")}.`);
  }

  const findings: ModelReviewFinding[] = [];
  for (const finding of answer.findings) {
    const ids = normaliseIds(finding.statements);
    const badIds = ids.filter((id) => !facts.listed.has(id));
    const badNames = unknownTickedNames(`${finding.title} ${finding.why}`, facts.known, alsoKnown);
    if (badIds.length > 0 || badNames.length > 0 || ids.length === 0) {
      droppedItems += 1;
      reasons.push(
        ...badIds.map((id) => `${id} is not a listed statement`),
        ...badNames.map((n) => `${n} is neither in the target nor in the run`)
      );
      continue;
    }
    const objects = [...new Set(finding.objects.map((o) => o.trim().replace(/^`|`$/g, "")).filter(Boolean))];
    const realObjects = objects.filter((o) => knownToReview(o, facts));
    droppedObjects += objects.length - realObjects.length;
    // The value keeps the model's own severity. withAppFindings raises it to
    // the app's floor when the answer is shown, so the two stay apart: a
    // "safe" verdict over a finding the app had to raise is not the model's
    // reading of the run.
    if (higher(finding.severity, floorOf(ids, facts)) !== finding.severity) severityRaised += 1;
    findings.push({
      statements: ids,
      severity: finding.severity,
      title: finding.title.trim(),
      why: finding.why.trim(),
      saferWay: finding.saferWay.trim(),
      objects: realObjects,
    });
  }

  if (droppedItems > 0 && droppedItems >= findings.length) {
    problems.push(
      `Too many findings cite things that are not in the run (${[...new Set(reasons)].slice(0, 8).join("; ")}). Cite only the listed statement ids and real object names.`
    );
  }
  // Most serious first as the screen will show them, after the floor, so the
  // cut below keeps the worst.
  const shown = (f: ModelReviewFinding) => SEVERITY_ORDER.indexOf(higher(f.severity, floorOf(f.statements, facts)));
  findings.sort((a, b) => shown(b) - shown(a));

  return {
    value: { verdict: answer.verdict.trim(), findings: findings.slice(0, MAX_FINDINGS + 2) },
    problems,
    report: { droppedItems, droppedObjects, severityRaised },
  };
}

/** The verdict when the app's own checks find worse than the model did. */
const APP_VERDICT_HIGH =
  "The app's own checks flag statements that can lose data, break what uses the target or stop the run, and the AI review missed them or rated them lower. Read the high findings before you deploy.";
const APP_VERDICT_MEDIUM =
  "The app's own checks flag statements that can fail on existing rows, change every row or break what uses the target, and the AI review missed them or rated them lower. Read the medium findings before you deploy.";

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * The answer the screen shows: the checked model findings, plus one finding
 * written by the app for each kind of flagged statement no finding cites.
 * Runs after the model's answer is checked (and after a saved one is read), so
 * the same run always gets the same app findings.
 */
export function withAppFindings(review: ModelReview, facts: MigrationReviewFacts): MigrationReviewAnswer & {
  appFindings: number;
} {
  const cited = new Set(review.findings.flatMap((f) => f.statements));
  const groups = new Map<string, { floor: ReviewSeverity; flags: string[]; ids: string[]; touched: Set<string> }>();
  for (const [id, s] of facts.statements) {
    if (s.floor === "low" || cited.has(id)) continue;
    const key = `${s.floor}|${s.flags.join("; ")}`;
    const group = groups.get(key) ?? { floor: s.floor, flags: s.flags, ids: [], touched: new Set<string>() };
    group.ids.push(id);
    s.touched.forEach((t) => group.touched.add(t));
    groups.set(key, group);
  }

  const fromApp: MigrationReviewFinding[] = [...groups.values()].map((g) => ({
    statements: g.ids,
    severity: g.floor,
    title: capitalise(g.flags.filter((f) => f !== "replaced by the next statement")[0] ?? "Flagged by the app"),
    why: `The app's own checks flag ${g.ids.length === 1 ? "this statement" : "these statements"}: ${g.flags.join("; ")}. The AI review did not cover ${g.ids.length === 1 ? "it" : "them"}, so read ${g.ids.length === 1 ? "it" : "them"} before you deploy.`,
    saferWay: "",
    objects: [...g.touched],
    fromApp: true,
  }));

  // The model's findings, each raised to the floor of the statements it
  // cites (never lowered), with the model's own severity kept beside it.
  const modelFindings: MigrationReviewFinding[] = review.findings.map((f) => ({
    statements: f.statements,
    severity: higher(f.severity, floorOf(f.statements, facts)),
    modelSeverity: f.severity,
    title: f.title,
    why: f.why,
    saferWay: f.saferWay,
    objects: f.objects,
    fromApp: false,
  }));

  const findings: MigrationReviewFinding[] = [...modelFindings, ...fromApp].sort(
    (a, b) => SEVERITY_ORDER.indexOf(b.severity) - SEVERITY_ORDER.indexOf(a.severity)
  );

  // The model's verdict is its reading of the worst problem it graded. When
  // the app's checks find worse, in a statement the model left out or one it
  // graded lower, a "looks safe" verdict would contradict the list under it.
  const rank = (severity: ReviewSeverity) => SEVERITY_ORDER.indexOf(severity);
  const modelTop = Math.max(-1, ...review.findings.map((f) => rank(f.severity)));
  const appTop = Math.max(
    -1,
    ...fromApp.map((f) => rank(f.severity)),
    ...modelFindings.filter((f) => f.severity !== f.modelSeverity).map((f) => rank(f.severity))
  );
  let verdict = review.verdict;
  if (appTop > modelTop) verdict = appTop === rank("high") ? APP_VERDICT_HIGH : APP_VERDICT_MEDIUM;

  return { verdict, findings, appFindings: fromApp.length };
}

/** What each id in an answer stands for, sent beside the answer for the screen. */
export function reviewedStatements(
  answer: MigrationReviewAnswer,
  facts: MigrationReviewFacts
): Record<string, ReviewedStatement> {
  const out: Record<string, ReviewedStatement> = {};
  for (const id of answer.findings.flatMap((f) => f.statements)) {
    const s = facts.statements.get(id);
    if (s) out[id] = { label: s.label, preview: clip(s.sql, 160), floor: s.floor, flags: s.flags };
  }
  return out;
}
