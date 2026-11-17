// Performance advice: reading PostgreSQL's own text.
//
// Holds the helpers that read index definitions, column defaults and type
// names as PostgreSQL prints them, and the ones that write names safely
// into SQL comments and literals.

import { identifierParts } from "../../postgres/snapshot-facts";
import { qualifiedName, quoteIdent } from "../sql";
import type { ConstraintSnapshot } from "../../postgres";

// ── Reading PostgreSQL's own text ────────────────────────────────────────────
// The snapshot and the statistics views hand back SQL text: index definitions,
// column defaults, partition keys. The helpers below read just enough of it to
// print correct SQL back, and return null for anything they do not recognise,
// so the rule that asked skips (or explains in words) rather than guessing.

/** The one name in `text`, or null when it is anything but a single name. */
export function singleName(text: string): string | null {
  const parts = identifierParts(text.trim());
  return parts !== null && parts.length === 1 ? parts[0] : null;
}

/**
 * Split on the commas that separate list items, not the ones inside quotes or
 * brackets: `a, "b,c", lower(d, e)` → ["a", '"b,c"', "lower(d, e)"].
 */
export function splitList(text: string): string[] {
  const items: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote !== null) {
      // A doubled quote closes and at once reopens, which comes to the same.
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === "(") {
      depth += 1;
    } else if (ch === ")") {
      depth -= 1;
    } else if (ch === "," && depth === 0) {
      items.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  items.push(text.slice(start).trim());
  return items;
}

/**
 * The column names in a key list when every item is a plain column — no
 * expression, no DESC, no COLLATE, no operator class — or null.
 *
 * Only a list like that can be compared name for name with another one, or
 * turned into a primary key; everything else is compared as text or skipped.
 */
function plainKeys(list: string): string[] | null {
  const names = splitList(list).map(singleName);
  return names.every((n): n is string => n !== null) ? names : null;
}

/** One index definition, as PostgreSQL prints it, taken apart. */
export type ParsedIndex = {
  unique: boolean;
  name: string;
  /**
   * "ON ONLY": how PostgreSQL prints the index of a partitioned table. Run as
   * written it would build the parent's index alone and leave it invalid.
   */
  only: boolean;
  /** btree, hash, gin, … */
  method: string;
  /** Everything after the method: "(customer_id)", "(lower(email)) WHERE …". */
  tail: string;
  /** The key columns when the tail is nothing but plain columns, else null. */
  keys: string[] | null;
};

/** A name as PostgreSQL prints one: quoted with "" inside, or bare. */
export const NAME = String.raw`(?:"(?:[^"]|"")*"|[^\s".(),]+)`;
const INDEX_DEFINITION = new RegExp(
  String.raw`^CREATE (UNIQUE )?INDEX (${NAME}) ON (ONLY )?${NAME}(?:\.${NAME})? USING (\w+) ([\s\S]+)$`
);

/**
 * `CREATE [UNIQUE] INDEX name ON [ONLY] [schema.]table USING method (…)…`,
 * the shape pg_get_indexdef always prints, taken apart — or null, and the
 * caller leaves that index alone.
 */
export function parseIndexDefinition(definition: string): ParsedIndex | null {
  const match = INDEX_DEFINITION.exec(definition.trim());
  if (!match) return null;
  const name = singleName(match[2]);
  if (name === null) return null;
  const tail = match[5].trim();
  const bracketed = /^\(([^()]*)\)$/.exec(tail);
  return {
    unique: Boolean(match[1]),
    name,
    only: Boolean(match[3]),
    method: match[4],
    tail,
    keys: bracketed ? plainKeys(bracketed[1]) : null,
  };
}

/**
 * An index definition as SQL to paste back: its name and table quoted and
 * schema-qualified, then the rest exactly as PostgreSQL printed it.
 *
 * The table is the caller's, not the one parsed out of the text: the snapshot
 * prints it without its schema, and the caller knows both halves for certain.
 *
 * ONLY is left out, so the index is built on every partition again as it was
 * before, and a comment says so.
 *
 * `stripped` is true for definitions from the snapshot, which have their own
 * schema's name taken out of them (see stripSchemaFromExpr in lib/postgres/).
 * Plain key columns name nothing from the schema, but an expression or a WHERE
 * can — a function, a type — and those only mean the same thing again with
 * that schema on the search_path. Definitions from the statistics pass are
 * read with nothing on the search_path, so they arrive fully qualified.
 */
export function indexDefinitionSql(
  parsed: ParsedIndex,
  schema: string,
  table: string,
  stripped: boolean
): string {
  const lines: string[] = [];
  if (parsed.only) {
    lines.push(
      "-- On a partitioned table this also rebuilds each partition's index, under names PostgreSQL picks."
    );
  }
  if (stripped && parsed.keys === null) {
    lines.push(
      comment`-- Any name from ${quoteIdent(schema)} inside this definition is written without ` +
        comment`the schema, so run it with ${quoteIdent(schema)} on the search_path.`
    );
  }
  lines.push(
    `CREATE ${parsed.unique ? "UNIQUE " : ""}INDEX ${quoteIdent(parsed.name)} ` +
      `ON ${qualifiedName(schema, table)} USING ${parsed.method} ${parsed.tail};`
  );
  return lines.join("\n");
}

/**
 * The columns of a PRIMARY KEY or UNIQUE constraint whose index is a plain
 * btree over plain columns — `PRIMARY KEY (id)`, `UNIQUE (email)` — or null.
 *
 * Anything more (NULLS NOT DISTINCT, INCLUDE, DEFERRABLE) makes its index
 * behave differently from a plain unique index on the same columns, so it is
 * not treated as a copy of one.
 */
export function constraintKeys(constraint: ConstraintSnapshot): string[] | null {
  const match = /^(?:PRIMARY KEY|UNIQUE) \(([^()]*)\)$/.exec(constraint.definition.trim());
  return match ? plainKeys(match[1]) : null;
}

/**
 * The sequence named in a serial column's default, `nextval('…'::regclass)`,
 * as schema and name — or null when the default is written some other way.
 *
 * The quoted middle is read as a string literal ('' is one quote) and then as
 * a dotted name. One part means the snapshot's own schema: the snapshot takes
 * that schema's name out of every default (see stripSchemaFromExpr in
 * lib/postgres/), and nothing else is on its search_path, so a sequence in
 * any other schema keeps its schema in the text.
 */
export function serialSequence(
  columnDefault: string,
  schema: string
): { schema: string; name: string } | null {
  const opening = "nextval('";
  if (!columnDefault.toLowerCase().startsWith(opening)) return null;
  let literal: string | null = null;
  let text = "";
  for (let i = opening.length; i < columnDefault.length; i += 1) {
    if (columnDefault[i] === "'") {
      if (columnDefault[i + 1] !== "'") {
        literal = text;
        break;
      }
      i += 1; // '' stands for one quote inside the literal
    }
    text += columnDefault[i];
  }
  const parts = literal === null ? null : identifierParts(literal);
  if (parts === null) return null;
  if (parts.length === 1) return { schema, name: parts[0] };
  if (parts.length === 2) return { schema: parts[0], name: parts[1] };
  return null;
}


/**
 * A tag for template strings that hold comment lines:
 *
 *   comment`-- DROP INDEX ${name};`
 *
 * Every value put into the text has its line breaks turned into spaces; the
 * text around the values keeps its own. PostgreSQL allows any character in a
 * quoted name, a line break included, and inside a comment line that break
 * would start a new line that is not a comment: pasting a fix that is meant to
 * run nothing would run whatever the name went on to say. The commented-out
 * statement then names the object with a space instead, which fails loudly if
 * someone runs it rather than doing something else.
 *
 * Only for comment text. A statement meant to run keeps its names exactly.
 */
export function comment(strings: TemplateStringsArray, ...values: unknown[]): string {
  let text = strings[0];
  values.forEach((value, i) => {
    text += String(value).replace(/[\r\n]+/g, " ") + strings[i + 1];
  });
  return text;
}
/** A SQL string literal: quoted, with any quote inside doubled. */
export function literal(text: string): string {
  return `'${text.replace(/'/g, "''")}'`;
}

/**
 * Lower-cased type name with any length/precision stripped: "varchar(30)" →
 * "varchar", "numeric(10,2)" → "numeric".
 *
 * Deliberately removes the parenthetical rather than truncating at it. Postgres
 * renders a precision in the MIDDLE of a two-word type name — format_type gives
 * "timestamp(3) with time zone" — so truncating turned a timestamptz column
 * into the bare string "timestamp" and the rule in schema-rules.ts then offered to convert
 * an already-zoned column to timestamptz.
 */
export function baseType(typeDisplay: string): string {
  return typeDisplay
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
