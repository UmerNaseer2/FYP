// Query analysis: a plan condition in plain SQL.
//
// Holds plainCondition, which strips the casts and brackets PostgreSQL adds
// to a condition so it reads like the SQL a person would write.

// ── A plan condition in plain SQL ────────────────────────────────────────────

/** The longest condition quoted in a sentence before it is cut short. */
const PLAIN_CONDITION_MAX = 140;

/**
 * Stand-ins for the string literals while a condition is rewritten. Private-
 * use characters, because no real condition contains them.
 */
const LITERAL_OPEN = "\uE000";
const LITERAL_CLOSE = "\uE001";

/** A column name, maybe qualified ("o.status"), or a literal's stand-in. */
const PLAIN_ATOM =
  String.raw`(?:[A-Za-z_][\w$]*(?:\.[A-Za-z_][\w$]*)*|` +
  `${LITERAL_OPEN}\\d+${LITERAL_CLOSE})`;

/**
 * A pair of brackets with nothing but one column or value inside. The
 * lookbehind keeps the brackets of a function call (`lower(email)`) and of
 * an `IN (...)`, `ANY (...)` or `NOT (...)`, whose meaning needs them.
 */
const LONE_ATOM_IN_BRACKETS = new RegExp(
  String.raw`(?<![\w$]|NOT |IN |ANY |ALL )\((${PLAIN_ATOM})\)`,
  "g"
);

/** Innermost brackets, with the same exceptions as above. */
const INNERMOST_BRACKETS = /(?<![\w$]|NOT |IN |ANY |ALL )\(([^()]*)\)/g;

/**
 * The items of an array literal's body, as SQL values: `1,2,3` stays as it is,
 * `paid,"on hold"` becomes `'paid', 'on hold'`.
 */
function arrayItems(body: string): string[] {
  const items: string[] = [];
  // The body is still inside a SQL string, so a quote in it is doubled.
  const unescaped = body.replace(/''/g, "'");
  for (const match of unescaped.matchAll(/"((?:[^"\\]|\\.)*)"|([^,]+)/g)) {
    const quoted = match[1] !== undefined;
    const value = quoted ? match[1].replace(/\\(.)/g, "$1") : match[2].trim();
    if (!quoted && value === "NULL") items.push("NULL");
    else if (!quoted && /^-?\d+(\.\d+)?$/.test(value)) items.push(value);
    else items.push(`'${value.replace(/'/g, "''")}'`);
  }
  return items;
}

/** Where the bracket opened at `open` closes, or -1. */
function closingBracket(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === "(") depth += 1;
    else if (text[i] === ")") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * A plan condition the way a person would write it in a WHERE clause.
 *
 * PostgreSQL prints conditions for its own benefit, with every cast spelled
 * out: `((o.status)::text = 'paid'::text)` is `o.status = 'paid'`, `~~` is
 * LIKE, an IN list is `= ANY ('{1,2,3}'::integer[])`, and a NOT IN subquery
 * is `(NOT (ANY (c.id = (hashed SubPlan 1).col1)))`. Each is rewritten here.
 * The result is display text only, never run, so reading it a little more
 * loosely than the server would (a dropped cast) is safe.
 *
 * String literals are set aside first and put back last, so nothing inside a
 * quoted value ('50% off', 'a ~~ b') is ever rewritten.
 */
export function plainCondition(text: string): string {
  // An IN list first: its values sit inside a literal, which is set aside next.
  let s = text.replace(
    /(=|<>) (ANY|ALL) \('\{((?:[^'}]|'')*)\}'(?:::[\w ]+(?:\[\])?)?\)/g,
    (match: string, op: string, which: string, body: string) => {
      if (op === "=" && which === "ANY") return `IN (${arrayItems(body).join(", ")})`;
      if (op === "<>" && which === "ALL") return `NOT IN (${arrayItems(body).join(", ")})`;
      return match;
    }
  );

  const literals: string[] = [];
  s = s.replace(/'(?:[^']|'')*'/g, (literal) => {
    literals.push(literal);
    return `${LITERAL_OPEN}${literals.length - 1}${LITERAL_CLOSE}`;
  });

  // Casts: "::text", "::character varying(20)", "::timestamp without time
  // zone", "::integer[]". The value reads the same without them.
  s = s.replace(
    /::(?:"[^"]+"|[A-Za-z_][\w$]*(?:\.[A-Za-z_][\w$]*)?)(?:\(\d+(?:, ?\d+)?\))?(?: (?:varying|precision|with(?:out)? time zone))*(?:\(\d+(?:, ?\d+)?\))?(?:\[\])*/g,
    ""
  );

  // The pattern operators under their SQL names. Longest first, so "!~~*"
  // is not read as "!~~" followed by a stray "*".
  s = s
    .replace(/!~~\*/g, "NOT ILIKE")
    .replace(/~~\*/g, "ILIKE")
    .replace(/!~~/g, "NOT LIKE")
    .replace(/~~/g, "LIKE");

  // "(hashed SubPlan 1).col1" and "(InitPlan 1).col1" name the subquery the
  // walk-through describes, so they read as "(SubPlan 1)" and "(InitPlan 1)".
  s = s.replace(/\((?:hashed )?((?:Init|Sub)Plan \d+)\)(?:\.col1(?!\d))?/g, "($1)");

  s = s.replace(LONE_ATOM_IN_BRACKETS, "$1");

  // A NOT IN subquery: "NOT (ANY (c.id = (SubPlan 1)))" → "c.id NOT IN (SubPlan 1)".
  s = s.replace(/ANY \(([^()]+?) = (\((?:Init|Sub)Plan \d+\))\)/g, "$1 IN $2");
  s = s.replace(/NOT \(([^()]+?) IN (\((?:Init|Sub)Plan \d+\))\)/g, "$1 NOT IN $2");

  // Brackets around one comparison, innermost first, until none are left.
  // Those around an AND or OR stay: "a AND (b OR c)" needs them.
  for (let pass = 0; pass < 20; pass += 1) {
    const next = s.replace(INNERMOST_BRACKETS, (match: string, inner: string) =>
      /[=<>]| I?LIKE | IS /.test(inner) && !/ AND | OR |,/.test(inner) ? inner : match
    );
    if (next === s) break;
    s = next;
  }

  // Brackets around the whole condition.
  s = s.trim();
  while (s.startsWith("(") && closingBracket(s, 0) === s.length - 1) {
    s = s.slice(1, -1).trim();
  }

  s = s
    .replace(new RegExp(`${LITERAL_OPEN}(\\d+)${LITERAL_CLOSE}`, "g"), (_m, i: string) =>
      literals[Number(i)] ?? ""
    )
    .replace(/\s+/g, " ")
    .trim();
  return s.length > PLAIN_CONDITION_MAX
    ? `${s.slice(0, PLAIN_CONDITION_MAX - 1).trimEnd()}…`
    : s;
}
