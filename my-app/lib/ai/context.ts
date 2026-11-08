// ---------------------------------------------------------------------------
// lib/ai/context.ts
// Turns a schema snapshot into the compact text a prompt carries, and cuts it
// down to a slice when the whole schema is too big.
//
// The snapshot's own JSON is about twice the size of this text, because every
// key repeats, so prompts never carry the JSON. Only structure goes in: names,
// types, keys, constraints, indexes, views and routines. Never rows, and never
// anything about where the database lives (no host, port, user or password).
//
// A slice is the tables a task is about, their foreign key neighbours both
// ways, and the views and triggers that use them, then the rest of the schema
// if there is room. What is left out is listed by name, so the model knows it
// exists and is not tempted to invent it.
// ---------------------------------------------------------------------------

import type { SchemaSnapshot, TableSnapshot, ViewSnapshot } from "../postgres";
import { estimateTokens } from "./provider";
import { buildDependencyIndex } from "./dependents";

const VIEW_DEFINITION_LIMIT = 600;
const OMITTED_NOTE = "ALSO IN THIS SCHEMA, NOT SHOWN: ";
const ROUTINE_DEFINITION_LIMIT = 0;

function indexLine(index: NonNullable<TableSnapshot["indexes"]>[number]): string {
  const unique = index.isUnique ? "UNIQUE " : "";
  const where = index.predicate ? ` WHERE ${index.predicate}` : "";
  return `  ${unique}INDEX ${index.name} USING ${index.method} (${index.columns.join(", ")})${where}`;
}

/** One table as short DDL-like text. */
export function tableText(table: TableSnapshot): string {
  const lines = [`TABLE ${table.name}`];
  for (const column of [...table.columns].sort((a, b) => a.ordinalPosition - b.ordinalPosition)) {
    const parts = [`  ${column.name} ${column.typeDisplay}`];
    if (!column.nullable) parts.push("NOT NULL");
    if (column.identity) parts.push(`GENERATED ${column.identity} AS IDENTITY`);
    else if (column.generated) parts.push(`GENERATED (${column.generated.expression}) ${column.generated.storage}`);
    else if (column.columnDefault !== null) parts.push(`DEFAULT ${column.columnDefault}`);
    lines.push(parts.join(" "));
  }
  if (table.primaryKey) lines.push(`  PRIMARY KEY ${table.primaryKey.name} (${table.primaryKey.columns.join(", ")})`);
  for (const unique of table.uniqueConstraints) lines.push(`  UNIQUE ${unique.name} (${unique.columns.join(", ")})`);
  for (const fk of table.foreignKeys) {
    const target = fk.referencedTable ?? "?";
    lines.push(
      `  FOREIGN KEY ${fk.name} (${fk.columns.join(", ")}) REFERENCES ${target} (${fk.referencedColumns.join(", ")}) ON DELETE ${fk.onDelete}`
    );
  }
  for (const check of table.checkConstraints) lines.push(`  CHECK ${check.name} ${check.definition.replace(/^CHECK\s*/i, "")}`);
  for (const exclude of table.excludeConstraints) lines.push(`  EXCLUDE ${exclude.name} ${exclude.definition}`);
  for (const index of table.indexes ?? []) lines.push(indexLine(index));
  for (const trigger of table.triggers ?? []) {
    lines.push(`  TRIGGER ${trigger.name} calls ${trigger.functionName}${trigger.enabled ? "" : " (disabled)"}`);
  }
  if (table.rowSecurity?.enabled) lines.push(`  ROW LEVEL SECURITY on, ${table.rowSecurity.policies.length} policies`);
  return lines.join("\n");
}

function oneLine(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit)} ...` : flat;
}

export function viewText(view: ViewSnapshot): string {
  const kind = view.materialized ? "MATERIALIZED VIEW" : "VIEW";
  const reads = view.dependsOn.length > 0 ? ` reads ${view.dependsOn.join(", ")}` : "";
  return `${kind} ${view.name} (${view.columns.join(", ")})${reads}\n  AS ${oneLine(view.definition, VIEW_DEFINITION_LIMIT)}`;
}

/** Enums, domains, sequences, routines and extensions: the small objects. */
function otherObjectsText(snapshot: SchemaSnapshot): string[] {
  const lines: string[] = [];
  for (const type of snapshot.types ?? []) {
    if (type.kind === "ENUM") lines.push(`ENUM ${type.name}: ${type.labels.join(", ")}`);
    else if (type.kind === "DOMAIN") lines.push(`DOMAIN ${type.name} ${type.baseType ?? ""}${type.notNull ? " NOT NULL" : ""}`.trim());
    else lines.push(`TYPE ${type.name} (${type.kind.toLowerCase()})`);
  }
  for (const sequence of snapshot.sequences ?? []) {
    const owned = sequence.ownedByTable ? ` owned by ${sequence.ownedByTable}.${sequence.ownedByColumn}` : "";
    lines.push(`SEQUENCE ${sequence.name}${owned}`);
  }
  for (const routine of snapshot.routines ?? []) {
    const returns = routine.returnType ? ` RETURNS ${routine.returnType}` : "";
    const body = ROUTINE_DEFINITION_LIMIT > 0 ? `\n  ${oneLine(routine.definition, ROUTINE_DEFINITION_LIMIT)}` : "";
    lines.push(`${routine.kind} ${routine.signature}${returns} LANGUAGE ${routine.language}${body}`);
  }
  for (const extension of snapshot.extensions ?? []) lines.push(`EXTENSION ${extension.name} ${extension.version}`);
  return lines;
}

/** The whole schema as text. */
export function schemaText(snapshot: SchemaSnapshot): string {
  return [
    `SCHEMA ${snapshot.schema}`,
    ...snapshot.tables.map(tableText),
    ...(snapshot.views ?? []).map(viewText),
    ...otherObjectsText(snapshot),
  ].join("\n\n");
}

export type ContextSlice = {
  text: string;
  tokens: number;
  /** Tables and views written out in full. */
  included: string[];
  /** Tables and views named only. */
  omitted: string[];
  /** True when the whole schema fitted. */
  whole: boolean;
};

/**
 * The schema as text, cut to fit `maxTokens`.
 *
 * `focus` names the tables or views the task is about. They always go in,
 * even past the budget, because a task about a table it cannot see is no
 * task at all. Then their neighbours (foreign keys both ways, views that read
 * them), then everything else in name order, as long as it fits. The small
 * objects (enums, sequences, routines) go in when they fit after the focus
 * ring. Room is kept for the closing list of names left out, so the text stays
 * inside the budget whenever the focus does.
 */
export function schemaSlice(
  snapshot: SchemaSnapshot,
  options: { focus?: readonly string[]; maxTokens: number }
): ContextSlice {
  const whole = schemaText(snapshot);
  const wholeTokens = estimateTokens(whole);
  const allNames = [...snapshot.tables.map((t) => t.name), ...(snapshot.views ?? []).map((v) => v.name)];
  if (wholeTokens <= options.maxTokens) {
    return { text: whole, tokens: wholeTokens, included: allNames, omitted: [], whole: true };
  }

  const tables = new Map(snapshot.tables.map((t) => [t.name, t]));
  const views = new Map((snapshot.views ?? []).map((v) => [v.name, v]));
  const index = buildDependencyIndex(snapshot);
  const textOf = (name: string) => {
    const table = tables.get(name);
    if (table) return tableText(table);
    const view = views.get(name);
    return view ? viewText(view) : null;
  };

  const focus = (options.focus ?? []).filter((name) => tables.has(name) || views.has(name));
  const neighbours = new Set<string>();
  for (const name of focus) {
    for (const ref of index.referencesOf(name)) neighbours.add(ref);
    for (const dependent of index.dependentsOf(name)) {
      if (dependent.kind !== "trigger") neighbours.add(dependent.name);
    }
    const view = views.get(name);
    for (const source of view?.dependsOn ?? []) neighbours.add(source);
  }
  const ordered = [
    ...focus,
    ...[...neighbours].filter((n) => !focus.includes(n)).sort(),
    ...[...allNames].sort().filter((n) => !focus.includes(n) && !neighbours.has(n)),
  ];

  const header = `SCHEMA ${snapshot.schema} (part of it: the objects this task needs come first)`;
  const parts: string[] = [header];
  let used = estimateTokens(header);
  const included: string[] = [];
  const others = otherObjectsText(snapshot).join("\n");
  const othersTokens = estimateTokens(others);
  let othersAdded = false;
  // Room for the closing list of names left out, at its longest: every name.
  // Each part also costs one token for the blank line that joins it.
  const reserve = estimateTokens(`${OMITTED_NOTE}${allNames.join(", ")}`) + 2;
  const room = options.maxTokens - reserve;

  for (const [position, name] of ordered.entries()) {
    if (!othersAdded && position >= focus.length + neighbours.size && others) {
      if (used + othersTokens + 1 <= room) {
        parts.push(others);
        used += othersTokens + 1;
      }
      othersAdded = true;
    }
    const text = textOf(name);
    if (!text) continue;
    const cost = estimateTokens(text) + 1;
    if (position >= focus.length && used + cost > room) continue;
    parts.push(text);
    used += cost;
    included.push(name);
  }
  if (!othersAdded && others && used + othersTokens + 1 <= room) {
    parts.push(others);
    used += othersTokens + 1;
  }
  const omitted = allNames.filter((name) => !included.includes(name)).sort();
  if (omitted.length > 0) {
    const note = `${OMITTED_NOTE}${omitted.join(", ")}`;
    parts.push(note);
    used += estimateTokens(note);
  }
  const text = parts.join("\n\n");
  return { text, tokens: estimateTokens(text), included, omitted, whole: false };
}

/**
 * The tables and views a sentence names, for the SQL generator's focus.
 * "book", "books" and "Books" all find a table called books; "order items"
 * finds order_items.
 */
export function mentionedObjects(snapshot: SchemaSnapshot, sentence: string): string[] {
  const words = sentence.toLowerCase().replace(/[^a-z0-9_]+/g, " ").trim();
  const padded = ` ${words} `;
  const joined = ` ${words.replace(/ /g, "_")} `;
  const names = [...snapshot.tables.map((t) => t.name), ...(snapshot.views ?? []).map((v) => v.name)];
  return names.filter((name) => {
    const lower = name.toLowerCase();
    const spaced = lower.replace(/_/g, " ");
    const singular = spaced.replace(/(ies)$/, "y").replace(/s$/, "");
    return (
      padded.includes(` ${spaced} `) ||
      padded.includes(` ${singular} `) ||
      (singular.length > 2 && padded.includes(` ${singular}s `)) ||
      joined.includes(`_${lower}_`) ||
      joined.includes(` ${lower} `)
    );
  });
}
