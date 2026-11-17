import { maskNonCode } from "@/lib/sql/guard";

// The steps of a migration script, in the order they run, so the full screen
// script view can list them beside the editor and jump to each.
//
// One step per statement. The generator writes a line like
//   -- [SAFE] Widen "title" in "courses": varchar(100) → varchar(150)
// above every statement, and that line is the step's label when it is there.
// A tagged line with no statement under it is a step too: a drop held back by
// safe mode ([NOT EXECUTED …], commented out) or a note with nothing to run.
// A hand-written script has no tags, so its steps are labelled with their first
// line of code. Comments and string literals are never code, so a semicolon in
// one does not end a step.

export type ScriptStepKind = "add" | "chg" | "rem";

export type ScriptStep = {
  /** 1-based line the step starts on. */
  line: number;
  /** Character offset of the step's first keyword (or of its tag line). */
  offset: number;
  label: string;
  kind: ScriptStepKind;
  /** Set when nothing runs: held back by safe mode, or a note only. */
  idle?: "held" | "note";
};

const TAG = /^\s*--\s*\[([^\]]+)\]\s*(.*)$/;
const LABEL_MAX = 96;

function squeeze(text: string): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > LABEL_MAX ? `${one.slice(0, LABEL_MAX - 1)}…` : one;
}

/** What a statement does to the target, read from its code alone. */
export function stepKind(code: string): ScriptStepKind {
  const head = code.trimStart().replace(/\s+/g, " ").toUpperCase();
  if (/^(DROP|REVOKE|TRUNCATE|DELETE)\b/.test(head)) return "rem";
  if (/^ALTER\b/.test(head)) {
    if (/\bDROP (COLUMN|CONSTRAINT)\b/.test(head)) return "rem";
    if (/\bADD\b/.test(head) && !/\bDROP\b/.test(head)) return "add";
    return "chg";
  }
  if (/^CREATE OR REPLACE\b/.test(head)) return "chg";
  if (/^(CREATE|GRANT|INSERT)\b/.test(head)) return "add";
  return "chg";
}

/** The same, read from the generator's description, which says it plainly. */
function describedKind(text: string): ScriptStepKind | null {
  if (/^(create|add|grant)\b/i.test(text)) return "add";
  if (/^(drop|remove|revoke)\b/i.test(text)) return "rem";
  if (/^\w/.test(text)) return "chg";
  return null;
}

type Tag = { line: number; offset: number; tag: string; text: string; used: boolean };

export function scriptSteps(sql: string): ScriptStep[] {
  const mask = maskNonCode(sql);
  const rows = sql.split("\n");
  const starts: number[] = [];
  let at = 0;
  for (const row of rows) {
    starts.push(at);
    at += row.length + 1;
  }

  // Tagged lines, by line index.
  const tags = new Map<number, Tag>();
  rows.forEach((row, index) => {
    const match = TAG.exec(row);
    if (match && mask.slice(starts[index], starts[index] + row.length).trim() === "") {
      tags.set(index, {
        line: index + 1,
        offset: starts[index],
        tag: match[1],
        // "Drop column x — WARNING: removes the column" keeps the part before the dash.
        text: match[2].split(" — ")[0],
        used: false,
      });
    }
  });

  const lineIndexOf = (offset: number) => {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (starts[mid] <= offset) low = mid;
      else high = mid - 1;
    }
    return low;
  };

  // The tag that owns a statement: the nearest tagged line above it, with only
  // comment lines between them.
  const ownerOf = (row: number): Tag | null => {
    if (sql.slice(starts[row], starts[row] + rows[row].length).search(/\S/) !==
      mask.slice(starts[row], starts[row] + rows[row].length).search(/\S/)) {
      return null;
    }
    for (let up = row - 1; up >= 0; up -= 1) {
      const tag = tags.get(up);
      if (tag) return tag.used ? null : tag;
      if (!/^\s*--/.test(rows[up])) return null;
    }
    return null;
  };

  const steps: ScriptStep[] = [];
  let start = 0;
  const take = (end: number) => {
    let first = start;
    while (first < end && /\s/.test(mask[first])) first += 1;
    if (first >= end) return;
    const row = lineIndexOf(first);
    const code = mask.slice(first, end);
    const owner = ownerOf(row);
    if (owner) owner.used = true;
    steps.push({
      line: row + 1,
      offset: first,
      label: squeeze(owner?.text || sql.slice(first, end).split("\n")[0]),
      kind: (owner && describedKind(owner.text)) ?? stepKind(code),
    });
  };
  for (let i = 0; i < mask.length; i += 1) {
    if (mask[i] === ";") {
      take(i);
      start = i + 1;
    }
  }
  take(mask.length);

  // Tagged lines nothing runs under.
  for (const tag of tags.values()) {
    if (tag.used) continue;
    const held = /NOT EXECUTED/i.test(tag.tag);
    steps.push({
      line: tag.line,
      offset: tag.offset,
      label: squeeze(tag.text),
      kind: describedKind(tag.text) ?? (held ? "rem" : "chg"),
      idle: held ? "held" : "note",
    });
  }

  return steps.sort((a, b) => a.offset - b.offset);
}
