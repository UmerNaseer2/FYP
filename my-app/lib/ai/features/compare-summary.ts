// ---------------------------------------------------------------------------
// lib/ai/features/compare-summary.ts
// Feature 1: the Compare change summary.
//
// The engine has already listed and graded every change (buildDiffDocument).
// The model is shown that list, each row with an id such as C3, and asked for
// a one sentence headline and short plain lines of what is added, dropped and
// changed, each citing the ids it covers. Then the code checks the answer:
//   - a line that cites an id not in the list is dropped;
//   - a name written in backticks that is not in either schema drops the line
//     it is in (or, in the headline, sends the answer back once);
//   - the app, not the model, files each line under Added, Dropped or Changed
//     by the changes it cites, and marks it breaking by the engine's grade;
//   - when there are breaking changes, the answer must cite at least one of
//     them, or it goes back once with that spelled out;
//   - changes the answer leaves out are added by the app as one short line per
//     list, so the summary never reads as complete when it is not.
// Only structure goes in the prompt: change rows, names, types, keys. The
// database names, hosts and any row counts stay out.
// ---------------------------------------------------------------------------

import { z } from "zod";
import { buildDiffDocument, type ChangeRow } from "../../compare-export";
import type { CompareReport } from "../../compare-types";
import type { TableSnapshot } from "../../postgres";
import { isKnownName, knownNames } from "../checks";
import { schemaSlice, tableText } from "../context";
import { estimateTokens } from "../provider";
import type { AiTaskSpec } from "../run";
import type { CitedChange, CompareSummaryAnswer, SummaryLevel, SummaryLine } from "./compare-summary-view";

/** Change rows listed in the prompt. Breaking ones go first, so a cut takes safe and info ones before any breaking one. */
export const MAX_LISTED_CHANGES = 120;
const DETAIL_LIMIT = 180;
const TARGET_SLICE_TOKENS = 2_000;
const NEW_TABLES_TOKENS = 1_000;
/** Left-out changes the app names in its own line of a list. The rest are counted. */
const MAX_LEFT_OUT_NAMED = 8;
/** The most ids one line may cite. */
const MAX_LINE_IDS = 200;

const LEVEL_ORDER: SummaryLevel[] = ["info", "safe", "breaking"];

const summaryLines = z
  .array(
    z.object({
      text: z.string().min(1).max(600),
      changes: z.array(z.string()).min(1).max(MAX_LINE_IDS),
    })
  )
  .max(40);

export const compareSummarySchema = z.object({
  headline: z.string().min(1).max(300),
  added: summaryLines,
  dropped: summaryLines,
  changed: summaryLines,
});

export const COMPARE_SUMMARY_SYSTEM = [
  "You summarise a comparison of two schemas for the person about to apply its migration.",
  "The source is the schema as it should be. The target is the schema the migration rewrites to match it.",
  "Keep it short and plain: a reader should take it in at a glance.",
  "Answer in JSON with four parts:",
  "- headline: one sentence of at most 25 words on what the migration does to the target.",
  "- added: what the migration creates in the target. dropped: what it removes. changed: what it alters or renames.",
  "Each line is at most 12 words, such as \"New table `reviews`\" or \"Column `books.price` goes, with its values\". Group related changes in one line (a new table with its indexes). Cite the ids each line covers in changes (C1, C2 ...). An empty list when there is nothing of that kind.",
  "Cover every change in the CHANGES list. Cite only ids from that list, and only in the changes fields: never write an id in headline or text. Put every table, column, view or other object name you write in backticks, and nothing else in backticks.",
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

  // The target tables and views the drops, renames and changes touch, for
  // the slice of the target schema the prompt shows.
  const target = report.right;
  const targetNames = new Set([...target.tables.map((t) => t.name), ...(target.views ?? []).map((v) => v.name)]);
  // The rows of a matched table are filed under its source name. A renamed
  // table has another name in the target.
  const targetNameOf = new Map<string, string>();
  for (const match of report.matchedTables) targetNameOf.set(match.left.name, match.right.name);
  const touched: string[] = [];
  for (const [, row] of listedEntries) {
    const filedAs = row.table || (row.category === "View" ? row.object : "");
    const name = targetNameOf.get(filedAs) ?? filedAs;
    if (!name || !targetNames.has(name) || touched.includes(name)) continue;
    if (row.severity === "breaking" || row.change !== "added") touched.push(name);
  }

  const slice = schemaSlice(target, { focus: touched, maxTokens: TARGET_SLICE_TOKENS });

  // The source's new tables in full, as far as they fit, so a new table can
  // be told in one line with what comes with it.
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
      cacheInput: { prompt, checks: 3 },
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

function normaliseIds(ids: readonly string[]): string[] {
  return [...new Set(ids.map((id) => id.trim().toUpperCase()))];
}

type Section = "added" | "dropped" | "changed";
const SECTIONS: Section[] = ["added", "dropped", "changed"];

/** Where the engine files a change: what it adds, drops, or anything else. */
function sectionOf(row: ChangeRow): Section {
  if (row.change === "added") return "added";
  if (row.change === "dropped") return "dropped";
  return "changed";
}

/** "column `books.price`", for a line the app writes. */
function tickedLabel(row: ChangeRow): string {
  const name = row.table && row.table !== row.object ? `${row.table}.${row.object}` : row.object;
  return `${row.category.toLowerCase()} \`${name}\``;
}

export type CompareSummaryCheck = {
  value: CompareSummaryAnswer;
  problems: string[];
  /** For the benchmark: what the check had to fix. */
  report: { droppedItems: number; moved: number; leftOut: number };
};

export function checkCompareSummary(answer: CompareSummaryAnswer, facts: CompareSummaryFacts): CompareSummaryCheck {
  const problems: string[] = [];
  const reasons: string[] = [];
  let droppedItems = 0;
  let moved = 0;
  let kept = 0;

  const headlineUnknown = unknownTickedNames(answer.headline, facts.known);
  if (headlineUnknown.length > 0) {
    problems.push(`The headline names things neither schema has: ${headlineUnknown.join(", ")}.`);
  }

  const lists: Record<Section, SummaryLine[]> = { added: [], dropped: [], changed: [] };
  const covered = new Set<string>();
  for (const from of SECTIONS) {
    for (const line of answer[from] ?? []) {
      const ids = normaliseIds(line.changes);
      const badIds = ids.filter((id) => !facts.listed.has(id));
      const badNames = unknownTickedNames(line.text, facts.known);
      if (badIds.length > 0 || badNames.length > 0 || ids.length === 0) {
        droppedItems += 1;
        reasons.push(...badIds.map((id) => `${id} is not a listed change`), ...badNames.map((n) => `${n} is not in either schema`));
        continue;
      }
      const rows = ids.map((id) => facts.rows.get(id)!);
      // The engine says where a line belongs: all adds, all drops, or a change.
      const kinds = new Set(rows.map(sectionOf));
      const section: Section = kinds.size === 1 ? [...kinds][0] : "changed";
      if (section !== from) moved += 1;
      const breaking = rows.some((row) => row.severity === "breaking");
      lists[section].push({ text: line.text.trim(), changes: ids, ...(breaking ? { breaking: true } : {}) });
      ids.forEach((id) => covered.add(id));
      kept += 1;
    }
  }

  if (droppedItems > 0 && droppedItems >= kept) {
    problems.push(
      `Too many lines cite things that are not in the comparison (${[...new Set(reasons)].slice(0, 8).join("; ")}). Cite only the listed change ids and real object names.`
    );
  }
  if (facts.breakingIds.length > 0 && !facts.breakingIds.some((id) => covered.has(id))) {
    problems.push(
      `The answer leaves out every breaking change (${facts.breakingIds.slice(0, 10).join(", ")}). Cover them.`
    );
  }

  // Changes no line cites, listed or not. The app adds them as one line per
  // list: a reader takes the summary as complete, so nothing may be missing
  // from it without a word.
  let leftOutCount = 0;
  for (const section of SECTIONS) {
    const leftOut = [...facts.rows.entries()].filter(([id, row]) => !covered.has(id) && sectionOf(row) === section);
    if (leftOut.length === 0) continue;
    leftOutCount += leftOut.length;
    const named = leftOut.slice(0, MAX_LEFT_OUT_NAMED).map(([, row]) => tickedLabel(row));
    const more = leftOut.length - named.length;
    const text = `Also: ${named.join(", ")}${more > 0 ? ` and ${more} more` : ""}.`;
    const breaking = leftOut.some(([, row]) => row.severity === "breaking");
    lists[section].push({
      text,
      changes: leftOut.slice(0, MAX_LINE_IDS).map(([id]) => id),
      ...(breaking ? { breaking: true } : {}),
    });
  }

  return {
    value: { headline: answer.headline.trim(), ...lists },
    problems,
    report: { droppedItems, moved, leftOut: leftOutCount },
  };
}

/** What each id in an answer stands for, sent beside the answer for the screen. */
export function citedChanges(answer: CompareSummaryAnswer, facts: CompareSummaryFacts): Record<string, CitedChange> {
  const cited: Record<string, CitedChange> = {};
  for (const id of SECTIONS.flatMap((section) => answer[section].flatMap((line) => line.changes))) {
    const row = facts.rows.get(id);
    if (row) cited[id] = { label: changeLabel(row), severity: row.severity };
  }
  return cited;
}
