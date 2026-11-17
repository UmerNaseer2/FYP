/**
 * How definitions are made comparable: whitespace squeezed outside strings
 * and bodies (normalizeDefinition), stored snapshots brought up to the
 * current rule (withCurrentNormalization), and a schema's own name taken out
 * of expressions (stripSchemaFromExpr).
 */
import { maskNonCode } from "../sql/guard";
import type { SchemaSnapshot } from "./types";

/** PostgreSQL's own whitespace characters, the lexer's `space` class. */
const SQL_WHITESPACE = /[ \t\n\r\f\v]/;

/**
 * The text a definition is compared by: every run of whitespace in the SQL
 * itself squeezed to one space, so the same view or check read from two
 * servers compares equal however each one wrapped and indented it.
 *
 * Whitespace inside a 'string', a "quoted name", a comment or a $$ body $$ is
 * left exactly as it is. There it is data, not layout: 'a  b' is not 'a b',
 * and a body's indentation can matter (PL/Python). Squeezing those too hid
 * real differences.
 *
 * maskNonCode finds those parts the way PostgreSQL's lexer does and turns each
 * of their characters into a space, so a character the mask changed is one to
 * keep. It runs on a copy with spaces made tabs and newlines made carriage
 * returns, which the lexer reads the same way; otherwise a space or newline
 * inside a string would come back unchanged and look like layout.
 */
export function normalizeDefinition(value: string): string {
  const copy = value.replace(/ /g, "\t").replace(/\n/g, "\r");
  const mask = maskNonCode(copy);
  let out = "";
  let spacePending = false;
  for (let i = 0; i < value.length; i += 1) {
    const isLayout = mask[i] === copy[i] && SQL_WHITESPACE.test(value[i]);
    if (isLayout) {
      spacePending = true;
      continue;
    }
    // One space for the whole run, and none at the start or the end.
    if (spacePending && out !== "") out += " ";
    spacePending = false;
    out += value[i];
  }
  return out;
}

/**
 * A stored snapshot with every normalizedDefinition worked out again from its
 * definition, by the rule this build uses.
 *
 * Snapshots are stored as JSONB and never rewritten, so a baseline keeps the
 * normalizedDefinition of the build that captured it. Builds before snapshot
 * format 5 squeezed whitespace inside strings and bodies too, so an old
 * baseline compared with a fresh capture would show nearly every multi-line
 * function as changed. Every capture sets normalizedDefinition to
 * normalizeDefinition(definition), and definition is stored as read, so
 * working it out again gives exactly what a capture today would. Nothing on
 * disk changes. Call it on a snapshot read back from the database before
 * comparing it with a live one.
 */
export function withCurrentNormalization(snapshot: SchemaSnapshot): SchemaSnapshot {
  return renormalize(snapshot) as SchemaSnapshot;
}

function renormalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(renormalize);
  if (value === null || typeof value !== "object") return value;
  const copy: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) copy[key] = renormalize(inner);
  if (typeof copy.definition === "string" && typeof copy.normalizedDefinition === "string") {
    copy.normalizedDefinition = normalizeDefinition(copy.definition);
  }
  return copy;
}

/**
 * The types whose values are names of objects. PostgreSQL prints a constant of
 * one as a quoted name with a cast: `'app.orders_id_seq'::regclass`.
 */
const OBJECT_NAME_TYPES =
  "regclass|regcollation|regconfig|regdictionary|regnamespace|regoper|regoperator|regproc|regprocedure|regrole|regtype";

// pg_get_expr renders a column DEFAULT with every referenced object schema-
// qualified when the object's schema isn't on the introspection session's
// search_path — which it never is here. So `'active'::order_status`,
// `gen_code()`, and `nextval('s')` come back as `'active'::<schema>.order_status`,
// `<schema>.gen_code()`, `nextval('<schema>.s'::regclass)`. That qualifier is
// pure noise when comparing two schemas (the same logical default differs only by
// schema name), and if emitted into a migration it binds the target column to the
// SOURCE schema's object. Strip the column's OWN schema qualifier so defaults are
// stored schema-relative; genuine cross-schema references (a different schema)
// keep their qualifier. Only strips a qualifier that directly precedes an
// identifier, in both quoted and unquoted form (pg doubles embedded quotes).
//
// Text inside a string literal is left alone, because it is data and not a
// name: `current_setting('app.tenant_id')` reads a setting called
// app.tenant_id, and `'%@app.example.com'` is part of an email check. Stripping
// those changed what a migration wrote and showed differences that were not
// there. The exception is a literal cast straight to an object-name type, like
// `nextval('app.s'::regclass)`: that is how PostgreSQL prints a reference to an
// object, so the schema's name inside it goes like any other. A name written as
// plain text, `nextval('app.s')` in a function body, stays as written.
//
// maskNonCode (lib/sql/guard.ts) finds the literals the way PostgreSQL's lexer
// does. Comments keep their text, and a function's dollar-quoted body is read as
// code, so the references inside a function are still made schema-relative.
export function stripSchemaFromExpr(expr: string | null, schema: string): string | null {
  if (expr === null || !schema) return expr;
  const unquoted = schema.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const quoted = schema.replace(/"/g, '""').replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const qualifier = `(^|[^\\w"])(?:"${quoted}"|${unquoted})\\.`;
  const stripNames = (text: string) => text.replace(new RegExp(qualifier, "g"), "$1");

  // The same text with its string literals and quoted names blanked, so a
  // character that is unchanged there is code.
  const code = maskNonCode(expr, { keepComments: true, readDollarBodies: true });
  const isCode = (at: number) => code[at] === expr[at];

  // Either a literal cast to an object-name type, or a qualifier.
  const literalOrQualifier = new RegExp(
    `'((?:[^']|'')*)'(?=::(?:${OBJECT_NAME_TYPES})\\b)|${qualifier}`,
    "g"
  );
  return expr.replace(
    literalOrQualifier,
    (match: string, name: string | undefined, before: string | undefined, offset: number) => {
      if (name !== undefined) {
        // Only a real literal (its opening quote is blanked) with a real cast
        // after it. The name is read unescaped and written back escaped.
        if (isCode(offset) || !isCode(offset + match.length)) return match;
        return `'${stripNames(name.replace(/''/g, "'")).replace(/'/g, "''")}'`;
      }
      // A qualifier only counts when its dot is code: not inside a literal, and
      // not inside a quoted name such as "v1.app.total".
      return isCode(offset + match.length - 1) ? (before ?? "") : match;
    }
  );
}
