// Query analysis: splitting a condition into tokens.
//
// Holds the small tokenizer used on plan conditions, and the helpers that
// split a token list on AND and OR and find a comparison in it.

/** One piece of a plan condition, as tokenize() cuts it. */
export type Token = {
  kind: "str" | "ident" | "qident" | "num" | "param" | "punct" | "op" | "other";
  /** The text as written, except a quoted name ("Note"), which is unquoted. */
  text: string;
};

/**
 * The shapes a plan condition is written in, tried in this order.
 *
 * A plan's conditions are PostgreSQL's own printout of the query, so they come
 * in a small, regular set of shapes: names, 'literals'::types, $1 parameters,
 * operators with spaces around them, and brackets. Anything else becomes an
 * "other" token, and a side containing one is treated as unreadable.
 */
const TOKEN_PATTERNS: [Token["kind"], RegExp][] = [
  ["str", /^[Ee]?'(?:[^']|'')*'/],
  ["qident", /^"(?:[^"]|"")*"/],
  ["num", /^\d+(?:\.\d+)?/],
  ["param", /^\$\d+/],
  ["ident", /^[A-Za-z_][\w$]*/],
  ["punct", /^(?:::|[(),.[\]])/],
  ["op", /^[+\-*/<>=~!@#%^&|`?]+/],
];

/** Cut a plan condition into tokens, dropping the spaces between them. */
export function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let rest = text.trim();
  while (rest.length > 0) {
    let matched = false;
    for (const [kind, pattern] of TOKEN_PATTERNS) {
      const m = pattern.exec(rest);
      if (m === null) continue;
      const raw = m[0];
      tokens.push({ kind, text: kind === "qident" ? raw.slice(1, -1).replace(/""/g, '"') : raw });
      rest = rest.slice(raw.length).trimStart();
      matched = true;
      break;
    }
    if (!matched) {
      tokens.push({ kind: "other", text: rest[0] });
      rest = rest.slice(1).trimStart();
    }
  }
  return tokens;
}

function isOpen(token: Token | undefined): boolean {
  return token?.kind === "punct" && (token.text === "(" || token.text === "[");
}

function isClose(token: Token | undefined): boolean {
  return token?.kind === "punct" && (token.text === ")" || token.text === "]");
}

export function isWord(token: Token | undefined, word: string): boolean {
  return token?.kind === "ident" && token.text.toUpperCase() === word;
}

/** Where the bracket opened at `open` closes, or -1 when it never does. */
export function closingIndex(tokens: Token[], open: number): number {
  let depth = 0;
  for (let i = open; i < tokens.length; i += 1) {
    if (isOpen(tokens[i])) depth += 1;
    else if (isClose(tokens[i])) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** "((a = 1))" → "a = 1": drop brackets that wrap the whole thing. */
export function stripOuterParens(tokens: Token[]): Token[] {
  let inner = tokens;
  while (inner.length >= 2 && inner[0].text === "(" && closingIndex(inner, 0) === inner.length - 1) {
    inner = inner.slice(1, -1);
  }
  return inner;
}

/** Split at every AND (or OR) outside brackets. One part when there is none. */
export function splitTop(tokens: Token[], word: "AND" | "OR"): Token[][] {
  const parts: Token[][] = [[]];
  let depth = 0;
  for (const token of tokens) {
    if (isOpen(token)) depth += 1;
    else if (isClose(token)) depth -= 1;
    if (depth === 0 && isWord(token, word)) parts.push([]);
    else parts[parts.length - 1].push(token);
  }
  return parts;
}

/**
 * The conditions ANDed together, however PostgreSQL bracketed them.
 * It prints `a AND b AND c` as "((a) AND (b) AND (c))", with brackets nested
 * as deep as the query had them.
 */
export function andParts(tokens: Token[]): Token[][] {
  const inner = stripOuterParens(tokens);
  const parts = splitTop(inner, "AND");
  return parts.length === 1 ? [inner] : parts.flatMap(andParts);
}

/**
 * Every single comparison in a condition, whether ANDed, ORed or under NOT.
 * For rules that ask "is this shape anywhere", not "can an index use it".
 */
export function conditionAtoms(tokens: Token[]): Token[][] {
  const inner = stripOuterParens(tokens);
  for (const word of ["OR", "AND"] as const) {
    const parts = splitTop(inner, word);
    if (parts.length > 1) return parts.flatMap(conditionAtoms);
  }
  if (isWord(inner[0], "NOT")) return conditionAtoms(inner.slice(1));
  return [inner];
}

/** One comparison split at its operator, or null when it is not one comparison. */
export function comparisonOf(tokens: Token[]): { left: Token[]; op: string; right: Token[] } | null {
  const t = stripOuterParens(tokens);
  let depth = 0;
  let at = -1;
  for (let i = 0; i < t.length; i += 1) {
    if (isOpen(t[i])) depth += 1;
    else if (isClose(t[i])) depth -= 1;
    else if (depth === 0 && t[i].kind === "op") {
      // PostgreSQL brackets every inner operation, so a second operator
      // outside brackets means a shape this reader does not know.
      if (at !== -1) return null;
      at = i;
    }
  }
  if (at <= 0 || at === t.length - 1) return null;
  return { left: t.slice(0, at), op: t[at].text, right: t.slice(at + 1) };
}
