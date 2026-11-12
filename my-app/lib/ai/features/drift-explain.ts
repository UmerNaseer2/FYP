// ---------------------------------------------------------------------------
// lib/ai/features/drift-explain.ts
// Feature 3: Explain drift, and the one line in a drift alert.
//
// A drift check compares the registry's baseline (left) with the live schema
// (right). Read that way round, its "added" means "the baseline has it, live
// does not", which is backwards for a person asking what changed on live. So
// the changes the AI is shown are the comparison run the other way: from the
// baseline to live, where "added" means someone added it on live.
//
// The engine decides, the AI explains:
//   - the change rows, their grades and the "needs a person" marks are the
//     engine's (buildDiffDocument), each with an id such as C3;
//   - both ways out are scripts the app writes (generateMigration and
//     generateRollback), never SQL from the model: "revert" puts live back to
//     the baseline, "adopt" writes the live changes as the registry's next
//     version;
//   - the answer is checked like the Compare summary's: unknown ids and names
//     drop an item, its level is overwritten with the engine's grade, and the
//     breaking changes must be covered.
// Only structure goes in the prompt: change rows, names, types, keys. No
// database name, host, row or person.
// ---------------------------------------------------------------------------

import { z } from "zod";
import { compareSchemas } from "../../compare";
import { buildDiffDocument, type ChangeRow } from "../../compare-export";
import type { CompareReport } from "../../compare-types";
import {
  generateMigration,
  generateRollback,
  manualNoteCount,
  renderMigrationScript,
  renderRollbackScript,
  statementsThatRun,
  type MigrationScript,
  type RollbackScript,
} from "../../generate-sql";
import type { TableSnapshot } from "../../postgres";
import { MAX_MIGRATION_DESCRIPTION } from "../../perf-sql";
import { isKnownName, knownNames } from "../checks";
import { schemaSlice, tableText } from "../context";
import { buildDependencyIndex, describeDependents } from "../dependents";
import { estimateTokens } from "../provider";
import type { AiTaskSpec } from "../run";
import { changeLabel, unknownTickedNames } from "./compare-summary";
import type { CitedChange, SummaryLevel } from "./compare-summary-view";
import type { DriftExplainAnswer, DriftScript, DriftScripts } from "./drift-explain-view";

/** Change rows listed in the explain prompt. Breaking ones go first, so they are never the ones cut. */
export const MAX_LISTED_CHANGES = 120;
/** Change rows listed for the alert line, which needs only the gist. */
export const ONE_LINER_CHANGES = 40;
const DETAIL_LIMIT = 180;
const LIVE_SLICE_TOKENS = 2_000;
const LOST_TABLES_TOKENS = 1_000;
const MAX_FOCUS = 20;
const MAX_DEPENDENT_LINES = 25;
const MAX_ITEMS = 8;
const MAX_MANUAL_NOTES = 8;
/** The alert line on a lock screen, in characters, after the clean-up. */
export const ALERT_LINE_LIMIT = 160;
const ALERT_LINE_WORDS = 30;

const LEVEL_ORDER: SummaryLevel[] = ["info", "safe", "breaking"];

// ---------------------------------------------------------------------------
// The changes, from the baseline to live
// ---------------------------------------------------------------------------

/**
 * The drift as changes made on live: the check's comparison (baseline left,
 * live right) run the other way round.
 */
export function driftChanges(report: CompareReport): CompareReport {
  return compareSchemas(report.right, report.left);
}

function clip(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit)} ...` : flat;
}

function normaliseIds(ids: readonly string[]): string[] {
  return [...new Set(ids.map((id) => id.trim().toUpperCase()))];
}

type ListedChanges = {
  rows: Map<string, ChangeRow>;
  entries: [string, ChangeRow][];
  lines: string[];
  totalsLine: string;
  notCompared: string[];
};

/** The change rows with their ids, breaking ones first when the list is cut. */
function listChanges(whatChanged: CompareReport, limit: number): ListedChanges | null {
  const doc = buildDiffDocument(whatChanged);
  if (doc.changes.length === 0) return null;
  const rows = new Map<string, ChangeRow>();
  doc.changes.forEach((row, i) => rows.set(`C${i + 1}`, row));
  const entries = [...rows.entries()]
    .sort(([, a], [, b]) => LEVEL_ORDER.indexOf(b.severity) - LEVEL_ORDER.indexOf(a.severity))
    .slice(0, limit)
    // Back into the engine's own order, which keeps a table's changes together.
    .sort(([a], [b]) => Number(a.slice(1)) - Number(b.slice(1)));
  const lines = entries.map(
    ([id, row]) =>
      `${id} [${row.severity}]${row.manual ? " [needs a person]" : ""} ${changeLabel(row)}: ${clip(row.detail, DETAIL_LIMIT)}`
  );
  const unlisted = doc.changes.length - entries.length;
  if (unlisted > 0) lines.push(`(${unlisted} more safe or info changes are not listed.)`);
  const t = doc.totals;
  return {
    rows,
    entries,
    lines,
    totalsLine: `${t.changes} changes on live: ${t.added} added, ${t.dropped} dropped, ${t.changed} changed, ${t.renamed} renamed, ${t.renameSuggestions} possible renames. ${t.breaking} breaking. ${t.manual} need a person.`,
    notCompared: doc.notCompared.map((n) => n.category),
  };
}

// ---------------------------------------------------------------------------
// The two ways out, written by the app
// ---------------------------------------------------------------------------

/**
 * One line of a script's header. Names come from a database, so a line break
 * or an invisible control character in one could end the comment and start a
 * statement; those are taken out.
 */
export function commentLine(text: string): string {
  return `-- ${text.replace(/[\r\n\u2028\u2029]+/g, " ").replace(/[\p{Cc}\p{Cf}]/gu, "")}`;
}

function scriptFrom(
  script: MigrationScript,
  rollback: RollbackScript,
  header: string[],
  description: string
): DriftScript {
  const rollbackSql = rollback.statements.length > 0 ? renderRollbackScript(rollback) : null;
  return {
    sql: `${header.map(commentLine).join("\n")}\n\n${renderMigrationScript(script)}`,
    rollbackSql,
    description: description.slice(0, MAX_MIGRATION_DESCRIPTION),
    statements: script.statements.length,
    runs: statementsThatRun(script).length,
    heldBack: script.allowDataLoss ? 0 : script.heldBackCount,
    manual: manualNoteCount(script.statements),
  };
}

/**
 * Both scripts for a drift. Neither is allowed to lose data: every drop is
 * written but commented out, for a person to arm by hand.
 *
 * `report` is the check's own comparison (baseline left, live right) and
 * `whatChanged` is driftChanges(report).
 */
export function buildDriftScripts(
  report: CompareReport,
  whatChanged: CompareReport,
  context: { schemaName: string; expectedVersion: string | null }
): DriftScripts {
  const baseline = context.expectedVersion ? `the registry's ${context.expectedVersion}` : "its baseline";
  const schema = context.schemaName;

  const revert = scriptFrom(
    generateMigration(report, { allowDataLoss: false }),
    generateRollback(report, { allowDataLoss: false }),
    [
      `Revert drift: puts ${schema} back the way ${baseline} says it should be.`,
      "Run it on the drifted database. It undoes the changes made there outside the registry.",
      "Drops are commented out. Read each one, then uncomment the ones you mean to run.",
    ],
    `Revert drift on ${schema}: back to ${baseline}`
  );

  const adopt = scriptFrom(
    generateMigration(whatChanged, { allowDataLoss: false }),
    generateRollback(whatChanged, { allowDataLoss: false }),
    [
      `Adopt drift: the changes made on the live ${schema}, written as the next version after ${baseline}.`,
      "Do not run this on the drifted database: it already has these changes.",
      "Save it in the registry so the other databases get the same changes, then re-baseline this schema.",
      "Drops are commented out. Uncomment them to adopt the drops as well.",
    ],
    `Adopt drift on ${schema} into the registry`
  );

  return { revert, adopt };
}

// ---------------------------------------------------------------------------
// Explain drift
// ---------------------------------------------------------------------------

export const driftExplainSchema = z.object({
  headline: z.string().min(1).max(300),
  items: z
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
  likelyCause: z.string().max(400),
  recommendation: z.object({
    choice: z.enum(["adopt", "revert", "either"]),
    why: z.string().min(1).max(500),
  }),
  manualNotes: z
    .array(
      z.object({
        changes: z.array(z.string()).min(1).max(20),
        note: z.string().min(1).max(500),
      })
    )
    .max(MAX_MANUAL_NOTES),
});

export const DRIFT_EXPLAIN_SYSTEM = [
  "You explain schema drift to the person who looks after this database.",
  "Drift means the live database no longer matches the version the registry says it should be at, its baseline: something changed it outside the registry.",
  'The CHANGES list goes from the baseline to live. "added" means live has it and the baseline does not; "dropped" means the baseline has it and live lost it; "changed" means live differs from the baseline.',
  "Answer in JSON with five parts:",
  "- headline: one sentence of at most 30 words on what changed on the live database.",
  `- items: what changed, most serious first, at most ${MAX_ITEMS}. Put related changes in one item (a new column and its index). Cover every breaking change, grouping them when there are many. Each item cites the ids of its changes (C1, C2 ...), says in one or two sentences what changed and what it can break, and lists in affects the objects that use what changed, taken from the WHAT USES list or the schema text (an empty list when nothing does). Set level to the grade the app gave the cited changes.`,
  "- likelyCause: one short sentence guessing how this happened, such as a fix run by hand or a migration applied outside the registry, said as a guess. An empty string when nothing points to a cause. Never name or guess a person.",
  '- recommendation: choice "adopt" when the live changes look intended and worth keeping (they become the registry\'s next version), "revert" when they look accidental or risky (live goes back to the baseline), or "either" when it depends on something only a person knows. why says in at most two sentences what decides it.',
  "- manualNotes: for each change marked [needs a person], what someone has to do by hand, citing its ids. An empty list when none is marked.",
  "The CHANGES list shows only what is different now, not how it got that way: never say which statement or option made a change (such as CASCADE), only what changed.",
  "Cite only ids from the CHANGES list, and only in the changes fields: the screen shows them beside each item, so never write an id in headline, title, why, likelyCause, recommendation or note. Put every table, column, view or other object name you write in backticks, and nothing else in backticks.",
].join("\n");

export type DriftExplainFacts = {
  /** Every change row by its id, listed or not. */
  rows: Map<string, ChangeRow>;
  /** The ids the prompt listed. Only these may be cited. */
  listed: Set<string>;
  known: Set<string>;
  breakingIds: string[];
  /** Listed ids the engine marked as needing a person. */
  manualIds: string[];
};

export type DriftExplainTask = {
  spec: AiTaskSpec<DriftExplainAnswer>;
  facts: DriftExplainFacts;
  /** Estimated prompt size, for the benchmark. */
  inputTokens: number;
};

function scriptLine(name: string, what: string, script: DriftScript): string {
  return `${name}: ${script.runs} statements ${what}; ${script.heldBack} drops held back (commented out until someone allows them); ${script.manual} changes the app could not write SQL for.`;
}

/**
 * The question for one drift, or null when the two schemas match.
 *
 * `report` is the check's comparison (baseline left, live right) and
 * `whatChanged` is driftChanges(report).
 */
export function buildDriftExplainTask(
  report: CompareReport,
  whatChanged: CompareReport,
  context: { expectedVersion: string | null; scripts: DriftScripts }
): DriftExplainTask | null {
  const listing = listChanges(whatChanged, MAX_LISTED_CHANGES);
  if (!listing) return null;
  const { rows, entries } = listing;
  const listed = new Set(entries.map(([id]) => id));
  const breakingIds = entries.filter(([, row]) => row.severity === "breaking").map(([id]) => id);
  const manualIds = entries.filter(([, row]) => row.manual).map(([id]) => id);

  const baseline = report.left;
  const live = report.right;
  const liveNames = new Set([...live.tables.map((t) => t.name), ...(live.views ?? []).map((v) => v.name)]);
  const baselineNames = new Set([...baseline.tables.map((t) => t.name), ...(baseline.views ?? []).map((v) => v.name)]);

  // The tables and views the breaking, dropped, renamed and changed rows touch,
  // then the ones that are only new: the slice shows all of live's, the
  // WHAT USES list the touched ones.
  const touched: string[] = [];
  const mentioned: string[] = [];
  for (const [, row] of entries) {
    const name = row.table || (row.category === "View" ? row.object : "");
    if (!name) continue;
    if (!mentioned.includes(name)) mentioned.push(name);
    if ((row.severity === "breaking" || row.change !== "added") && !touched.includes(name)) touched.push(name);
  }
  const liveIndex = buildDependencyIndex(live);
  const baselineIndex = buildDependencyIndex(baseline);
  const dependentLines: string[] = [];
  for (const name of touched.slice(0, MAX_DEPENDENT_LINES)) {
    if (liveNames.has(name)) dependentLines.push(describeDependents(liveIndex, name));
    else if (baselineNames.has(name)) dependentLines.push(`In the baseline: ${describeDependents(baselineIndex, name)}`);
  }

  const focus = [...touched, ...mentioned.filter((n) => !touched.includes(n))].filter((n) => liveNames.has(n));
  const slice = schemaSlice(live, { focus: focus.slice(0, MAX_FOCUS), maxTokens: LIVE_SLICE_TOKENS });

  // The tables live lost, as the baseline has them, as far as they fit.
  const lostTables: string[] = [];
  let lostTokens = 0;
  for (const table of whatChanged.tablesOnlyInB as TableSnapshot[]) {
    const text = tableText(table);
    const cost = estimateTokens(text) + 1;
    if (lostTokens + cost > LOST_TABLES_TOKENS) break;
    lostTables.push(text);
    lostTokens += cost;
  }

  const { revert, adopt } = context.scripts;
  const sections = [
    "THE DRIFT",
    `The live schema no longer matches ${context.expectedVersion ? `the registry's ${context.expectedVersion}` : "its baseline"}. The changes below are what was done to live.`,
    "",
    "ENGINE TOTALS",
    listing.totalsLine,
    ...(listing.notCompared.length > 0 ? [`Not compared, so unknown: ${listing.notCompared.join(", ")}.`] : []),
    "",
    "TWO WAYS OUT (the app has written both scripts)",
    scriptLine("Revert", "put live back to the baseline", revert),
    scriptLine("Adopt", "write the live changes as the registry's next version", adopt),
    "",
    "CHANGES (id [grade] what: detail)",
    ...listing.lines,
    "",
    "WHAT USES THE OBJECTS THAT CHANGED",
    ...(dependentLines.length > 0 ? dependentLines : ["Nothing that changed has known users."]),
    "",
    "LIVE SCHEMA NOW",
    slice.text,
    ...(lostTables.length > 0 ? ["", "BASELINE TABLES LIVE NO LONGER HAS", lostTables.join("\n\n")] : []),
  ];
  const prompt = sections.join("\n");

  const facts: DriftExplainFacts = { rows, listed, known: knownNames(baseline, live), breakingIds, manualIds };
  return {
    facts,
    inputTokens: estimateTokens(`${DRIFT_EXPLAIN_SYSTEM}\n${prompt}`),
    spec: {
      feature: "drift-explain",
      tier: "smart",
      system: DRIFT_EXPLAIN_SYSTEM,
      prompt,
      schema: driftExplainSchema,
      // The prompt is built only from the two schemas, so the same drift asks the same question.
      cacheInput: { prompt },
      maxOutputTokens: 2_000,
      check: (value) => checkDriftExplain(value, facts),
    },
  };
}

/** Something that looks like an email address: a guess at a person, which the answer may not make. */
const EMAIL_LIKE = /[^\s@]+@[^\s@]+\.[^\s@]+/;

export type DriftExplainCheck = {
  value: DriftExplainAnswer;
  problems: string[];
  /** For the benchmark: what the check had to fix. */
  report: { droppedItems: number; droppedNames: number; levelFixed: number; droppedNotes: number };
};

export function checkDriftExplain(answer: DriftExplainAnswer, facts: DriftExplainFacts): DriftExplainCheck {
  const problems: string[] = [];
  const reasons: string[] = [];
  let droppedItems = 0;
  let droppedNames = 0;
  let levelFixed = 0;
  let droppedNotes = 0;

  for (const [part, text] of [
    ["The headline", answer.headline],
    ["The likely cause", answer.likelyCause],
    ["The recommendation", answer.recommendation.why],
  ] as const) {
    const unknown = unknownTickedNames(text, facts.known);
    if (unknown.length > 0) problems.push(`${part} names things neither schema has: ${unknown.join(", ")}.`);
  }
  if (EMAIL_LIKE.test(answer.likelyCause)) {
    problems.push("The likely cause names a person. Guess at how it happened, never at who did it.");
  }

  const items: DriftExplainAnswer["items"] = [];
  for (const item of answer.items) {
    const ids = normaliseIds(item.changes);
    const badIds = ids.filter((id) => !facts.listed.has(id));
    const badNames = unknownTickedNames(`${item.title} ${item.why}`, facts.known);
    if (badIds.length > 0 || badNames.length > 0 || ids.length === 0) {
      droppedItems += 1;
      reasons.push(...badIds.map((id) => `${id} is not a listed change`), ...badNames.map((n) => `${n} is not in either schema`));
      continue;
    }
    const affects = [...new Set(item.affects.map((name) => name.trim()).filter(Boolean))];
    const realAffects = affects.filter((name) => isKnownName(name, facts.known));
    droppedNames += affects.length - realAffects.length;
    // The grade lock: the engine's grade of the cited changes, whatever the model said.
    const level = ids.reduce<SummaryLevel>((highest, id) => {
      const severity = facts.rows.get(id)!.severity;
      return LEVEL_ORDER.indexOf(severity) > LEVEL_ORDER.indexOf(highest) ? severity : highest;
    }, "info");
    if (level !== item.level) levelFixed += 1;
    items.push({ ...item, changes: ids, level, affects: realAffects });
  }
  items.sort((a, b) => LEVEL_ORDER.indexOf(b.level) - LEVEL_ORDER.indexOf(a.level));

  // A note is kept only for changes the engine marked as needing a person.
  const manual = new Set(facts.manualIds);
  const manualNotes: DriftExplainAnswer["manualNotes"] = [];
  for (const note of answer.manualNotes) {
    const ids = normaliseIds(note.changes);
    if (ids.length === 0 || ids.some((id) => !manual.has(id)) || unknownTickedNames(note.note, facts.known).length > 0) {
      droppedNotes += 1;
      continue;
    }
    manualNotes.push({ changes: ids, note: note.note.trim() });
  }

  if (droppedItems > 0 && droppedItems >= items.length) {
    problems.push(
      `Too many items cite things that are not in the drift (${[...new Set(reasons)].slice(0, 8).join("; ")}). Cite only the listed change ids and real object names.`
    );
  }
  if (facts.breakingIds.length > 0 && !items.some((item) => item.level === "breaking")) {
    problems.push(`The items leave out every breaking change (${facts.breakingIds.slice(0, 10).join(", ")}). Cover them.`);
  }

  return {
    value: {
      headline: answer.headline.trim(),
      items: items.slice(0, MAX_ITEMS + 2),
      likelyCause: EMAIL_LIKE.test(answer.likelyCause) ? "" : answer.likelyCause.trim(),
      recommendation: { choice: answer.recommendation.choice, why: answer.recommendation.why.trim() },
      manualNotes,
    },
    problems,
    report: { droppedItems, droppedNames, levelFixed, droppedNotes },
  };
}

/**
 * The answer with a note from the app for each change that needs a person and
 * that no note covers. Added after the check, and after a saved answer is
 * read, so every explanation of this drift gets them.
 */
export function withAppManualNotes(answer: DriftExplainAnswer, facts: DriftExplainFacts): DriftExplainAnswer {
  const covered = new Set(answer.manualNotes.flatMap((note) => note.changes));
  const missing = facts.manualIds.filter((id) => !covered.has(id));
  if (missing.length === 0) return answer;
  const room = Math.max(0, MAX_MANUAL_NOTES - answer.manualNotes.length);
  const notes: DriftExplainAnswer["manualNotes"] = [];
  missing.forEach((id, i) => {
    const row = facts.rows.get(id)!;
    if (i < room - 1 || missing.length <= room) {
      notes.push({
        changes: [id],
        note: `The app could not write SQL for this one: ${clip(row.detail, 300)}`,
        fromApp: true,
      });
    }
  });
  const rest = missing.slice(notes.length);
  if (rest.length > 0) {
    notes.push({
      changes: rest,
      note: "The app could not write SQL for these. Read each one in the comparison below and make it by hand.",
      fromApp: true,
    });
  }
  return { ...answer, manualNotes: [...answer.manualNotes, ...notes] };
}

/** What each id in an answer stands for, sent beside the answer for the screen. */
export function citedDriftChanges(answer: DriftExplainAnswer, facts: DriftExplainFacts): Record<string, CitedChange> {
  const cited: Record<string, CitedChange> = {};
  for (const id of [...answer.items.flatMap((i) => i.changes), ...answer.manualNotes.flatMap((n) => n.changes)]) {
    const row = facts.rows.get(id);
    if (row) cited[id] = { label: changeLabel(row), severity: row.severity };
  }
  return cited;
}

// ---------------------------------------------------------------------------
// The one line in a drift alert
// ---------------------------------------------------------------------------

export const driftOneLinerSchema = z.object({ line: z.string().min(1).max(240) });
export type DriftOneLiner = z.infer<typeof driftOneLinerSchema>;

export const DRIFT_ONE_LINER_SYSTEM = [
  "You write the one line that goes on a drift alert, shown on a phone's lock screen and in a desktop notification.",
  "Drift means the live database no longer matches the registry's baseline. The CHANGES list goes from the baseline to live.",
  `Answer in JSON: line, one plain sentence of at most 25 words on what changed on live, the most serious change first. Name the tables and columns that changed, and put every table and column name in backticks. No change ids, no advice, no greeting, and no guess at who did it.`,
].join("\n");

export type DriftOneLinerTask = { spec: AiTaskSpec<DriftOneLiner>; inputTokens: number };

/** The question for an alert line, or null when the two schemas match. `report` is the check's own comparison. */
export function buildDriftOneLinerTask(report: CompareReport): DriftOneLinerTask | null {
  const whatChanged = driftChanges(report);
  const listing = listChanges(whatChanged, ONE_LINER_CHANGES);
  if (!listing) return null;
  const known = knownNames(report.left, report.right);
  const prompt = ["ENGINE TOTALS", listing.totalsLine, "", "CHANGES (id [grade] what: detail)", ...listing.lines].join("\n");
  return {
    inputTokens: estimateTokens(`${DRIFT_ONE_LINER_SYSTEM}\n${prompt}`),
    spec: {
      feature: "drift-oneliner",
      tier: "fast",
      system: DRIFT_ONE_LINER_SYSTEM,
      prompt,
      schema: driftOneLinerSchema,
      cacheInput: { prompt },
      maxOutputTokens: 500,
      check: (value) => checkDriftOneLiner(value, known),
    },
  };
}

export function checkDriftOneLiner(value: DriftOneLiner, known: Set<string>): { value: DriftOneLiner; problems: string[] } {
  const problems: string[] = [];
  const line = value.line.replace(/\s+/g, " ").trim();
  const names = lineNames(line, known);
  const unknown = [...unknownTickedNames(line, known), ...names.unknownBare];
  if (unknown.length > 0) {
    problems.push(`The line names things neither schema has: ${[...new Set(unknown)].join(", ")}. Put every table and column name in backticks.`);
  }
  if (names.notNames.length > 0) {
    problems.push(`Only put table and column names in backticks, not: ${names.notNames.join(", ")}.`);
  }
  if (names.ticked === 0) problems.push("The line names no table or column in backticks. Name what changed, in backticks.");
  if (/\bC\d+\b/.test(line)) problems.push("The line has a change id in it. Say what changed in words.");
  if (line.split(" ").length > ALERT_LINE_WORDS) problems.push(`The line is longer than ${ALERT_LINE_WORDS} words. Keep it to one short sentence.`);
  if (EMAIL_LIKE.test(line)) problems.push("The line names a person. Say what changed, never who changed it.");
  return { value: { line }, problems };
}

/** A plain name, maybe with a schema or table in front: what unknownTickedNames checks. */
const PLAIN_NAME = /^"?[a-z_][a-z0-9_$]*"?(\s*\.\s*"?[a-z_][a-z0-9_$]*"?){0,2}$/i;

/** Words for a kind of object. The word right before one is often a name: "the customers table". */
const OBJECT_WORDS = new Set([
  "table", "tables", "column", "columns", "index", "indexes", "indices", "view", "views",
  "constraint", "constraints", "trigger", "triggers", "sequence", "sequences", "function", "functions",
]);

/**
 * Ordinary words that stand next to an object word without being a name: "a
 * new table", "the unique index", "the column was dropped". Kept as a list on
 * purpose, so a real name such as "billing" in "the billing table" is still
 * checked.
 */
const NOT_A_NAME = new Set([
  // Which one, and how many.
  "a", "an", "the", "this", "that", "these", "those", "its", "their", "each", "every", "any", "some", "all",
  "both", "no", "another", "other", "same", "whole", "only", "one", "two", "three", "four", "five", "six",
  "seven", "eight", "nine", "ten", "several", "many", "few", "more", "most", "single", "first", "second", "last",
  // What kind.
  "new", "old", "extra", "nullable", "unique", "primary", "foreign", "key", "keys", "check", "partial",
  "composite", "temporary", "temp", "empty", "existing", "missing", "added", "dropped", "removed",
  "renamed", "changed", "altered", "matching", "remaining", "related", "affected",
  // Words that join a sentence together.
  "and", "or", "but", "nor", "so", "then", "also", "still", "now", "not", "of", "to", "on", "in", "from",
  "with", "by", "for", "as", "at", "into", "onto", "over", "under", "about", "after", "before", "since",
  "without", "within", "while", "which", "who", "where", "when", "what", "it", "they", "them", "there",
  "here", "itself", "is", "was", "were", "are", "be", "been", "has", "had", "have", "does", "did", "do",
  "will", "would", "can", "could", "may", "might", "should", "must", "got", "lost", "gone",
]);

/** Words that come after an object word to say something about it: "the column type", "the table rows". */
const ABOUT_AN_OBJECT = new Set(["type", "types", "name", "names", "default", "defaults", "rows", "data", "definition"]);

/** Whether a bare word next to an object word could be the object's name, and so must be checked. */
function mayBeAName(lower: string): boolean {
  return !OBJECT_WORDS.has(lower) && !NOT_A_NAME.has(lower) && !/^\d+$/.test(lower);
}

/**
 * What a line names, checked against the two schemas.
 *
 * The prompt asks for every name in backticks, but the model's answer is
 * untrusted, and alertLine takes the backticks away. So a name outside them
 * would reach a lock screen unchecked. A bare word counts as a name when it
 * looks like one (has an underscore, a dot or a $ in it, or a capital inside
 * it like orderItems), or when it stands right next to a word such as
 * "table" or "column", as in "the customers table" or "the table customers".
 * Each must be in one of the two schemas.
 *
 * Also returned: text in backticks that is no plain name and so cannot be
 * checked (`ghost table`), and how many backticked pieces there are. A line
 * with none ignored the backtick rule, and its names went unchecked, so the
 * caller sends it back.
 */
function lineNames(line: string, known: Set<string>): { unknownBare: string[]; notNames: string[]; ticked: number } {
  const unknownBare: string[] = [];
  const notNames: string[] = [];
  let ticked = 0;
  // Odd pieces sit between two backticks. A backtick with no partner leaves
  // its last piece as bare text, which is how alertLine will show it.
  const pieces = line.split("`");
  // The words in order. A backticked piece is one word marked `ticked`, so
  // "the `orders` table" never takes "the" for the table's name.
  const words: { text: string; ticked: boolean }[] = [];
  pieces.forEach((piece, i) => {
    const isTicked = i % 2 === 1 && i < pieces.length - 1;
    if (isTicked) {
      const name = piece.trim();
      if (name === "") return;
      ticked += 1;
      // A plain name in backticks is checked by unknownTickedNames.
      if (!PLAIN_NAME.test(name) && !isKnownName(name, known)) notNames.push(name);
      words.push({ text: name, ticked: true });
      return;
    }
    for (const match of piece.matchAll(/[\p{L}\p{N}_$]+(?:\.[\p{L}\p{N}_$]+)*/gu)) {
      words.push({ text: match[0], ticked: false });
    }
  });

  words.forEach((word, i) => {
    if (word.ticked) return;
    const lower = word.text.toLowerCase();
    // A number such as 1.5 has a dot in it but is no name.
    const looksLikeName = (/[_$.]/.test(word.text) && !/^[\d.]+$/.test(word.text)) || /\p{Ll}\p{Lu}/u.test(word.text);
    const next = words[i + 1];
    const before = words[i - 1];
    // "the customers table": the word before an object word.
    const beforeObjectWord = next !== undefined && !next.ticked && OBJECT_WORDS.has(next.text.toLowerCase()) && mayBeAName(lower);
    // "the table customers": the word after one.
    const afterObjectWord =
      before !== undefined &&
      !before.ticked &&
      OBJECT_WORDS.has(before.text.toLowerCase()) &&
      mayBeAName(lower) &&
      !ABOUT_AN_OBJECT.has(lower);
    const mustCheck = looksLikeName || beforeObjectWord || afterObjectWord;
    if (mustCheck && !isKnownName(word.text, known) && !unknownBare.includes(word.text)) {
      unknownBare.push(word.text);
    }
  });
  return { unknownBare, notNames, ticked };
}

/**
 * The checked line as an alert shows it: no backticks, no control or
 * invisible characters, one line, at most ALERT_LINE_LIMIT characters. Null
 * when nothing is left.
 */
export function alertLine(line: string): string | null {
  const text = line
    .replace(/`/g, "")
    // \p{Cs} is half of a surrogate pair standing alone. The model's JSON can
    // hold one, and PostgreSQL's jsonb refuses it, which would lose the row.
    .replace(/[\p{Cc}\p{Cf}\p{Cs}\u2028\u2029]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return null;
  // Counted and cut in whole characters (code points), not UTF-16 units, so
  // an emoji at the cut is never split in half.
  const characters = Array.from(text);
  if (characters.length <= ALERT_LINE_LIMIT) return text;
  return `${characters.slice(0, ALERT_LINE_LIMIT - 3).join("").trimEnd()}...`;
}
