// ---------------------------------------------------------------------------
// lib/ai/features/compare-summary.ts
// Feature 1: the Compare change summary.
//
// The engine has already listed and graded every change (buildDiffDocument).
// The model is shown that list, each row with an id such as C3, and asked for
// three things: a headline, what can hurt (citing ids), and an order to apply
// the changes in (citing ids). Then the code checks the answer:
//   - an item that cites an id not in the list is dropped;
//   - a name written in backticks that is not in either schema drops the item
//     it is in (or, in the headline, sends the answer back once);
//   - every item's level is overwritten with the engine's grade of the
//     changes it cites;
//   - a name under "Used by" stays only when the target schema shows it uses
//     the table or view the item's changes are in (a view that reads it, a
//     table with a foreign key to it, a trigger on it);
//   - when there are breaking changes, the answer must cover at least one of
//     them, or it goes back once with that spelled out;
//   - breaking changes the answer still leaves out are added by the app as an
//     item of its own, so the summary never reads as complete when it is not.
// Only structure goes in the prompt: change rows, names, types, keys. The
// database names, hosts and any row counts stay out.
// ---------------------------------------------------------------------------

import { z } from "zod";
import { buildDiffDocument, type ChangeRow } from "../../compare-export";
import type { CompareReport } from "../../compare-types";
import type { TableSnapshot } from "../../postgres";
import { isKnownName, knownNames } from "../checks";
import { schemaSlice, tableText } from "../context";
import { buildDependencyIndex, describeDependents } from "../dependents";
import { estimateTokens } from "../provider";
import type { AiTaskSpec } from "../run";
import type { CitedChange, CompareSummaryAnswer, SummaryLevel } from "./compare-summary-view";

/** Change rows listed in the prompt. Breaking ones go first, so a cut takes safe and info ones before any breaking one. */
export const MAX_LISTED_CHANGES = 120;
const DETAIL_LIMIT = 180;
const TARGET_SLICE_TOKENS = 2_000;
const NEW_TABLES_TOKENS = 1_000;
const MAX_DEPENDENT_LINES = 25;
const MAX_RISKS = 6;
const MAX_STEPS = 8;
/** Left-out breaking changes the app lists in its own item. The same as the most ids one item may cite. */
const MAX_LEFT_OUT = 20;

const LEVEL_ORDER: SummaryLevel[] = ["info", "safe", "breaking"];

export const compareSummarySchema = z.object({
  headline: z.string().min(1).max(300),
  risks: z
    .array(
      z.object({
        title: z.string().min(1).max(160),
        changes: z.array(z.string()).min(1).max(20),
        level: z.enum(["breaking", "safe", "info"]),
        why: z.string().min(1).max(600),
        affects: z.array(z.string()).max(12),
      })
    )
    .max(10),
  order: z
    .array(
      z.object({
        step: z.string().min(1).max(300),
        changes: z.array(z.string()).min(1).max(40),
      })
    )
    .max(12),
});

export const COMPARE_SUMMARY_SYSTEM = [
  "You summarise a comparison of two schemas for the person about to apply its migration.",
  "The source is the schema as it should be. The target is the schema the migration rewrites to match it.",
  "Answer in JSON with three parts:",
  "- headline: one sentence of at most 30 words on what the migration does to the target.",
  `- risks: the changes that can hurt, most serious first, at most ${MAX_RISKS}. Put related changes in one item (a dropped column and its index). Cover every breaking change, grouping them when there are many. Each item cites the ids of its changes (C1, C2 ...), says in one or two sentences why it can hurt, and lists in affects the names of the views, tables and triggers that the WHAT USES list gives for the tables and views its changes are in (an empty list when it gives none, never a guess). Set level to the grade the app gave the cited changes. When nothing can hurt, risks is an empty list.`,
  `- order: the order to apply the changes in, at most ${MAX_STEPS} steps, each citing the ids it covers. The usual order is new types and tables, then new columns, then data fixes, then constraints and indexes, then drops last. Say when a step should wait for a backup or for code that still uses the old shape.`,
  "Cite only ids from the CHANGES list, and only in the changes fields: the screen shows them beside each item, so never write an id in headline, title, why or step. Put every table, column, view or other object name you write in backticks, and nothing else in backticks.",
].join("\n");

/** "Column books.price dropped". */
export function changeLabel(row: ChangeRow): string {
  const verb = row.change === "rename-suggested" ? "may be renamed" : row.change;
  const name = row.table && row.table !== row.object ? `${row.table}.${row.object}` : row.object;
  return `${row.category} ${name} ${verb}`;
}

function clip(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit)} ...` : flat;
}

export type CompareSummaryFacts = {
  /** Every change row by its id, listed or not. */
  rows: Map<string, ChangeRow>;
  /** The ids the prompt listed. Only these may be cited. */
  listed: Set<string>;
  known: Set<string>;
  breakingIds: string[];
  /**
   * For each listed change: the target objects known to use the table or view
   * it is in, in lower case, with and without the schema in front.
   */
  usedBy: Map<string, Set<string>>;
};

export type CompareSummaryTask = {
  spec: AiTaskSpec<CompareSummaryAnswer>;
  facts: CompareSummaryFacts;
  /** Estimated prompt size, for the benchmark. */
  inputTokens: number;
};

/**
 * The question for one comparison, or null when the two schemas match and
 * there is nothing to summarise.
 */
export function buildCompareSummaryTask(
  report: CompareReport,
  options: { allowDataLoss: boolean }
): CompareSummaryTask | null {
  const doc = buildDiffDocument(report);
  if (doc.changes.length === 0) return null;

  const rows = new Map<string, ChangeRow>();
  doc.changes.forEach((row, i) => rows.set(`C${i + 1}`, row));
  const byGrade = [...rows.entries()].sort(
    ([, a], [, b]) => LEVEL_ORDER.indexOf(b.severity) - LEVEL_ORDER.indexOf(a.severity)
  );
  const listedEntries = byGrade
    .slice(0, MAX_LISTED_CHANGES)
    // Back into the engine's own order, which keeps a table's changes together.
    .sort(([a], [b]) => Number(a.slice(1)) - Number(b.slice(1)));
  const listed = new Set(listedEntries.map(([id]) => id));
  const breakingIds = listedEntries.filter(([, row]) => row.severity === "breaking").map(([id]) => id);

  const changeLines = listedEntries.map(
    ([id, row]) =>
      `${id} [${row.severity}]${row.manual ? " [needs a person]" : ""} ${changeLabel(row)}: ${clip(row.detail, DETAIL_LIMIT)}`
  );
  const unlisted = doc.changes.length - listedEntries.length;
  // More breaking changes than the list holds: say how many of the cut ones break.
  const unlistedBreaking = [...rows.entries()].filter(
    ([id, row]) => !listed.has(id) && row.severity === "breaking"
  ).length;
  if (unlistedBreaking > 0) {
    changeLines.push(`(${unlisted} more changes are not listed, ${unlistedBreaking} of them breaking.)`);
  } else if (unlisted > 0) {
    changeLines.push(`(${unlisted} more safe or info changes are not listed.)`);
  }

  // What uses the target objects that change: the tables and views the
  // breaking, dropped, renamed and changed rows touch.
  const target = report.right;
  const targetNames = new Set([...target.tables.map((t) => t.name), ...(target.views ?? []).map((v) => v.name)]);
  // The rows of a matched table are filed under its source name. A renamed
  // table has another name in the target, which is the one its users read.
  const targetNameOf = new Map<string, string>();
  for (const match of report.matchedTables) targetNameOf.set(match.left.name, match.right.name);
  const index = buildDependencyIndex(target);
  const touched: string[] = [];
  // Kept for the check: an item may only say "used by" what is found here.
  const usedBy = new Map<string, Set<string>>();
  for (const [id, row] of listedEntries) {
    const filedAs = row.table || (row.category === "View" ? row.object : "");
    const name = targetNameOf.get(filedAs) ?? filedAs;
    if (!name || !targetNames.has(name)) continue;
    const users = new Set<string>();
    for (const dependent of index.dependentsOf(name)) {
      users.add(dependent.name.toLowerCase());
      users.add(`${target.schema}.${dependent.name}`.toLowerCase());
    }
    usedBy.set(id, users);
    if (touched.includes(name)) continue;
    if (row.severity === "breaking" || row.change !== "added") touched.push(name);
  }
  const dependentLines = touched.slice(0, MAX_DEPENDENT_LINES).map((name) => describeDependents(index, name));

  const slice = schemaSlice(target, { focus: touched, maxTokens: TARGET_SLICE_TOKENS });

  // The source's new tables in full, as far as they fit: the order step needs
  // to see which of them the others point at.
  const newTables: string[] = [];
  let newTableTokens = 0;
  for (const table of report.tablesOnlyInA as TableSnapshot[]) {
    const text = tableText(table);
    const cost = estimateTokens(text) + 1;
    if (newTableTokens + cost > NEW_TABLES_TOKENS) break;
    newTables.push(text);
    newTableTokens += cost;
  }

  const t = doc.totals;
  const notCompared = doc.notCompared.map((n) => n.category);
  const sections = [
    "THE MIGRATION",
    options.allowDataLoss
      ? "It is set to allow data loss: the statements that drop things will run."
      : "It is not allowed to lose data: statements that drop things are written but commented out, so they will not run until someone allows it. The changes are still real differences.",
    "",
    "ENGINE TOTALS",
    `${t.changes} changes: ${t.added} added, ${t.dropped} dropped, ${t.changed} changed, ${t.renamed} renamed, ${t.renameSuggestions} rename suggestions (not applied). ${t.breaking} breaking. ${t.manual} need a person.`,
    ...(notCompared.length > 0 ? [`Not compared, so unknown: ${notCompared.join(", ")}.`] : []),
    "",
    "CHANGES (id [grade] what: detail)",
    ...changeLines,
    "",
    "WHAT USES THE TARGET OBJECTS THAT CHANGE",
    ...(dependentLines.length > 0 ? dependentLines : ["No changed table or view in the target has known users."]),
    "",
    "TARGET SCHEMA NOW",
    slice.text,
    ...(newTables.length > 0 ? ["", "NEW TABLES FROM THE SOURCE", newTables.join("\n\n")] : []),
  ];
  const prompt = sections.join("\n");

  const facts: CompareSummaryFacts = {
    rows,
    listed,
    // The source's objects under the target's schema name as well: that is
    // where a new table will live once the migration runs.
    known: knownNames(report.left, report.right, report.left && report.right ? { ...report.left, schema: report.right.schema } : null),
    breakingIds,
    usedBy,
  };

  return {
    facts,
    inputTokens: estimateTokens(`${COMPARE_SUMMARY_SYSTEM}\n${prompt}`),
    spec: {
      feature: "compare-summary",
      tier: "fast",
      system: COMPARE_SUMMARY_SYSTEM,
      prompt,
      schema: compareSummarySchema,
      // The prompt is built only from the diff, so the same diff asks the same question.
      // "checks" is the version of the code checks below: an answer saved
      // before a check was added is not served again.
      cacheInput: { prompt, checks: 2 },
      maxOutputTokens: 1_500,
      check: (value) => checkCompareSummary(value, facts),
    },
  };
}

/** Words that may sit in backticks without being an object name. */
const SQL_WORDS = new Set(
  [
    "null", "not", "default", "cascade", "restrict", "primary", "key", "foreign", "unique", "check", "index",
    "table", "column", "view", "drop", "add", "alter", "create", "rename", "integer", "int", "bigint",
    "smallint", "text", "varchar", "boolean", "bool", "uuid", "json", "jsonb", "date", "time", "timestamp",
    "timestamptz", "numeric", "decimal", "real", "serial", "bigserial", "bytea", "true", "false",
    "concurrently", "valid", "validate", "analyze", "vacuum", "truncate", "delete", "update", "insert",
    "select", "using", "where", "from", "into", "values", "set", "constraint", "references", "type",
    "sequence", "trigger", "function", "schema", "begin", "commit", "rollback", "transaction", "lock",
    "lock_timeout", "statement_timeout", "exists", "if", "on", "returning", "now",
  ].map((w) => w.toLowerCase())
);

/**
 * The names a sentence puts in backticks that neither schema has. `alsoKnown`
 * lets a feature count names its own input has, such as the tables a
 * migration creates.
 */
export function unknownTickedNames(
  text: string,
  known: Set<string>,
  alsoKnown: (name: string) => boolean = () => false
): string[] {
  const unknown: string[] = [];
  for (const match of text.matchAll(/`([^`]+)`/g)) {
    const name = match[1].trim();
    if (!/^"?[a-z_][a-z0-9_$]*"?(\s*\.\s*"?[a-z_][a-z0-9_$]*"?){0,2}$/i.test(name)) continue;
    if (SQL_WORDS.has(name.toLowerCase()) || /^[cs]\d+$/i.test(name)) continue;
    if (!isKnownName(name, known) && !alsoKnown(name) && !unknown.includes(name)) unknown.push(name);
  }
  return unknown;
}

/** Most serious first. */
function byLevel(a: { level: SummaryLevel }, b: { level: SummaryLevel }): number {
  return LEVEL_ORDER.indexOf(b.level) - LEVEL_ORDER.indexOf(a.level);
}

/** A name as the usedBy lists hold it: no quotes, lower case. */
function plainName(raw: string): string {
  return raw
    .replace(/"/g, "")
    .split(".")
    .map((part) => part.trim().toLowerCase())
    .join(".");
}

function normaliseIds(ids: readonly string[]): string[] {
  return [...new Set(ids.map((id) => id.trim().toUpperCase()))];
}

export type CompareSummaryCheck = {
  value: CompareSummaryAnswer;
  problems: string[];
  /** For the benchmark: what the check had to fix. */
  report: { droppedItems: number; droppedNames: number; levelFixed: number };
};

export function checkCompareSummary(answer: CompareSummaryAnswer, facts: CompareSummaryFacts): CompareSummaryCheck {
  const problems: string[] = [];
  const reasons: string[] = [];
  let droppedItems = 0;
  let droppedNames = 0;
  let levelFixed = 0;

  const headlineUnknown = unknownTickedNames(answer.headline, facts.known);
  if (headlineUnknown.length > 0) {
    problems.push(`The headline names things neither schema has: ${headlineUnknown.join(", ")}.`);
  }

  const risks: CompareSummaryAnswer["risks"] = [];
  for (const risk of answer.risks) {
    const ids = normaliseIds(risk.changes);
    const badIds = ids.filter((id) => !facts.listed.has(id));
    const badNames = unknownTickedNames(`${risk.title} ${risk.why}`, facts.known);
    if (badIds.length > 0 || badNames.length > 0 || ids.length === 0) {
      droppedItems += 1;
      reasons.push(...badIds.map((id) => `${id} is not a listed change`), ...badNames.map((n) => `${n} is not in either schema`));
      continue;
    }
    const affects = [...new Set(risk.affects.map((name) => name.trim()).filter(Boolean))];
    // Only what the target schema shows as a user of a cited change. A name
    // that merely exists somewhere is the model's guess, so it is struck out.
    const realAffects = affects.filter((name) => ids.some((id) => facts.usedBy.get(id)?.has(plainName(name))));
    droppedNames += affects.length - realAffects.length;
    // The grade lock: the engine's grade of the cited changes, whatever the model said.
    const level = ids.reduce<SummaryLevel>((highest, id) => {
      const severity = facts.rows.get(id)!.severity;
      return LEVEL_ORDER.indexOf(severity) > LEVEL_ORDER.indexOf(highest) ? severity : highest;
    }, "info");
    if (level !== risk.level) levelFixed += 1;
    risks.push({ ...risk, changes: ids, level, affects: realAffects });
  }
  risks.sort(byLevel);

  const order: CompareSummaryAnswer["order"] = [];
  for (const step of answer.order) {
    const ids = normaliseIds(step.changes);
    const badIds = ids.filter((id) => !facts.listed.has(id));
    const badNames = unknownTickedNames(step.step, facts.known);
    if (badIds.length > 0 || badNames.length > 0 || ids.length === 0) {
      droppedItems += 1;
      reasons.push(...badIds.map((id) => `${id} is not a listed change`), ...badNames.map((n) => `${n} is not in either schema`));
      continue;
    }
    order.push({ step: step.step, changes: ids });
  }

  const kept = risks.length + order.length;
  if (droppedItems > 0 && droppedItems >= kept) {
    problems.push(
      `Too many items cite things that are not in the comparison (${[...new Set(reasons)].slice(0, 8).join("; ")}). Cite only the listed change ids and real object names.`
    );
  }
  if (facts.breakingIds.length > 0 && !risks.some((risk) => risk.level === "breaking")) {
    problems.push(
      `The risks leave out every breaking change (${facts.breakingIds.slice(0, 10).join(", ")}). Cover them in risks.`
    );
  }

  // Breaking changes no shown item cites, listed or not. The app adds them as
  // an item of its own: a reader takes the summary as complete, so a breaking
  // change must never be missing from it without a word.
  const shown = risks.slice(0, MAX_RISKS + 2);
  const covered = new Set(shown.flatMap((risk) => risk.changes));
  const leftOut = [...facts.rows.entries()]
    .filter(([id, row]) => row.severity === "breaking" && !covered.has(id))
    .map(([id]) => id);
  if (leftOut.length > 0) {
    const more = leftOut.length - MAX_LEFT_OUT;
    shown.push({
      title: "Breaking changes the AI summary did not cover",
      changes: leftOut.slice(0, MAX_LEFT_OUT),
      level: "breaking",
      why:
        "The app added these from its own comparison, because the AI's summary left them out. Check each one before you apply the migration." +
        (more > 0 ? ` Only the first ${MAX_LEFT_OUT} are shown here: ${more} more are in the list of differences.` : ""),
      affects: [],
    });
    // After the AI's own breaking items, before its safe and info ones.
    shown.sort(byLevel);
  }

  return {
    value: { headline: answer.headline.trim(), risks: shown, order },
    problems,
    report: { droppedItems, droppedNames, levelFixed },
  };
}

/** What each id in an answer stands for, sent beside the answer for the screen. */
export function citedChanges(answer: CompareSummaryAnswer, facts: CompareSummaryFacts): Record<string, CitedChange> {
  const cited: Record<string, CitedChange> = {};
  for (const id of [...answer.risks.flatMap((r) => r.changes), ...answer.order.flatMap((s) => s.changes)]) {
    const row = facts.rows.get(id);
    if (row) cited[id] = { label: changeLabel(row), severity: row.severity };
  }
  return cited;
}
