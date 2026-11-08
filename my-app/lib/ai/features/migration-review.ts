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
//   - a finding's severity is raised to the floor of the statements it cites,
//     never lowered;
//   - after the check, every flagged statement no finding cites gets a finding
//     written by the app itself (fromApp), so a statement the app knows is
//     dangerous is never left off the screen because the model missed it.
// Only structure goes in the prompt: the SQL, names, types, keys, and the
// planner's row estimates for the touched tables, rounded. No rows, no hosts,
// no database names.
// ---------------------------------------------------------------------------

import { z } from "zod";
import { gradeSql } from "../../change-type";
import { scriptLabel } from "../../deploy-risk";
import type { SchemaSnapshot } from "../../postgres";
import {
  findMightFailStatements,
  findRowDestroyingStatements,
  hasExecutableSql,
  maskNonCode,
  splitStatements,
} from "../../sql-guard";
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
export type ReviewScript = { scriptName: string; version: string; sqlContent: string };

/** The model's answer: a finding before the app marks where it came from. */
export type ModelReviewFinding = Omit<MigrationReviewFinding, "fromApp">;
export type ModelReview = { verdict: string; findings: ModelReviewFinding[] };

export const migrationReviewSchema = z.object({
  verdict: z.string().min(1).max(400),
  findings: z
    .array(
      z.object({
        statements: z.array(z.string()).min(1).max(30),
        severity: z.enum(["high", "medium", "low"]),
        title: z.string().min(1).max(160),
        why: z.string().min(1).max(700),
        saferWay: z.string().max(900),
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
  // the run commits. Read here only: Deploy's gates stay the engine's.
  if (/^\s*UPDATE\b/i.test(code) && !/\bWHERE\b/i.test(code)) {
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
      statements.set(`S${statements.size + 1}`, {
        label: parts.length > 1 ? `${label}, statement ${k + 1}` : label,
        sql: withoutComments(sql).trim(),
        floor: reading.floor,
        flags: reading.flags,
        touched: mine,
      });
    });
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
      ? `A deploy of ${scriptCount} script${scriptCount === 1 ? "" : "s"}, ${listing.statements.size} statements, applied in the order listed.`
      : `A rollback: the stored down scripts of ${scriptCount} version${scriptCount === 1 ? "" : "s"}, ${listing.statements.size} statements, applied in the order listed.`,
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
  return bareName(name)
    .split(".")
    .every((part) => facts.runNames.has(part));
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
    // The floor: never below the app's own reading of the cited statements.
    const floor = ids.reduce<ReviewSeverity>((top, id) => higher(top, facts.statements.get(id)!.floor), "low");
    const severity = higher(finding.severity, floor);
    if (severity !== finding.severity) severityRaised += 1;
    findings.push({
      statements: ids,
      severity,
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
  findings.sort((a, b) => SEVERITY_ORDER.indexOf(b.severity) - SEVERITY_ORDER.indexOf(a.severity));

  return {
    value: { verdict: answer.verdict.trim(), findings: findings.slice(0, MAX_FINDINGS + 2) },
    problems,
    report: { droppedItems, droppedObjects, severityRaised },
  };
}

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

  const findings: MigrationReviewFinding[] = [
    ...review.findings.map((f) => ({ ...f, fromApp: false })),
    ...fromApp,
  ].sort((a, b) => SEVERITY_ORDER.indexOf(b.severity) - SEVERITY_ORDER.indexOf(a.severity));

  // A verdict that calls the run safe while the app holds a high finding the
  // model never raised would contradict the list under it.
  const modelHasHigh = review.findings.some((f) => f.severity === "high");
  const appHasHigh = fromApp.some((f) => f.severity === "high");
  const verdict =
    appHasHigh && !modelHasHigh
      ? "The app's own checks flag statements that can lose data or stop the run, and the AI review did not cover them. Read the findings marked as the app's before you deploy."
      : review.verdict;

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
