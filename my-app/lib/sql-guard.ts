// Shared, dependency-free SQL guard used by BOTH the server apply route
// (app/api/scripts/apply/route.ts) and the client deploy page
// (app/(studio)/deploy/page.tsx), so the two always agree on what counts as a
// transaction-control statement. Keeping one implementation here removes the
// drift that existed when each screen had its own slightly different regex.

/**
 * Blank out every part of a script that is not executable SQL, keeping the
 * text the same length.
 *
 * Comments, string literals, quoted identifiers and dollar-quoted bodies all
 * become runs of spaces, so a caller can scan the result for keywords or
 * semicolons without ever seeing a word that only LOOKS like SQL. Newlines are
 * kept so line numbers still line up with the original.
 *
 * One pass, left to right, is the whole point. This used to be four regex
 * replaces in a row — comments, then dollar bodies, then literals — and that
 * order was a real hole: a block-comment opener sitting inside a string
 * literal opened a comment the SQL parser would never see, so everything up to
 * the next closer disappeared before the scan ran. A script could hide a COMMIT
 * in that gap and be waved past the guard. A scanner cannot be fooled that way,
 * because it only ever recognises an opener while it is actually reading code.
 */
function maskNonCode(sql: string): string {
  const out = sql.split("");
  // A dollar-quote tag is empty or starts with a letter/underscore, which is
  // what keeps a `$1` placeholder from being read as an opening tag. Sticky so
  // it can be tested at one position without slicing the string.
  const dollarTag = /\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/y;

  function blank(from: number, to: number): void {
    for (let k = from; k < to; k += 1) {
      if (out[k] !== "\n") out[k] = " ";
    }
  }

  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];

    if (ch === "-" && sql[i + 1] === "-") {
      const newline = sql.indexOf("\n", i);
      const end = newline === -1 ? sql.length : newline;
      blank(i, end);
      i = end;
      continue;
    }

    if (ch === "/" && sql[i + 1] === "*") {
      const close = sql.indexOf("*/", i + 2);
      const end = close === -1 ? sql.length : close + 2;
      blank(i, end);
      i = end;
      continue;
    }

    if (ch === "'" || ch === '"') {
      // Backslash escapes only exist in an E'' string. In an ordinary literal
      // PostgreSQL treats a backslash as a plain character (the default
      // standard_conforming_strings), so reading it as an escape there would
      // mis-find the closing quote.
      const escapes = ch === "'" && /[Ee]$/.test(sql[i - 1] ?? "") && !/[A-Za-z0-9_]/.test(sql[i - 2] ?? "");
      let j = i + 1;
      while (j < sql.length) {
        if (escapes && sql[j] === "\\") {
          j += 2;
        } else if (sql[j] !== ch) {
          j += 1;
        } else if (sql[j + 1] === ch) {
          j += 2; // '' inside a literal is an escaped quote, not the end
        } else {
          j += 1;
          break;
        }
      }
      blank(i, Math.min(j, sql.length));
      i = j;
      continue;
    }

    if (ch === "$") {
      dollarTag.lastIndex = i;
      const tag = dollarTag.exec(sql);
      if (tag) {
        const close = sql.indexOf(tag[0], i + tag[0].length);
        const end = close === -1 ? sql.length : close + tag[0].length;
        blank(i, end);
        i = end;
        continue;
      }
    }

    i += 1;
  }

  return out.join("");
}

/**
 * Detect a bare transaction-control statement in a migration script. Any of these
 * would break the apply route's outer transaction wrapper (committing partial DDL
 * with no ledger row, or aborting it), so they are rejected up front.
 *
 * Covers COMMIT, ROLLBACK, and their SQL synonyms: ABORT (= ROLLBACK), END /
 * END TRANSACTION / END WORK (= COMMIT), and PREPARE TRANSACTION.
 *
 * The scan runs on the masked copy, so none of these count:
 *   - a word in a comment, of either kind
 *   - a word in a dollar-quoted body — e.g. the ordinary
 *     `CREATE PROCEDURE ... AS $$ BEGIN ... END $$;` shape of PL/pgSQL
 *   - a word in a string literal, e.g. `INSERT INTO t VALUES ('ROLLBACK')`
 *   - a word used as a quoted identifier, e.g. a column called "commit"
 */
export function containsTransactionControl(sql: string): boolean {
  const stripped = maskNonCode(sql);

  // COMMIT / ROLLBACK / ABORT as standalone words — none is a normal identifier,
  // and ABORT is a ROLLBACK synonym.
  if (/\b(COMMIT|ROLLBACK|ABORT)\b/i.test(stripped)) return true;
  // END / END TRANSACTION / END WORK is a COMMIT synonym, but END also closes a
  // CASE expression (and a PL/pgSQL block, already masked above). Only flag END
  // at a STATEMENT boundary — start of script or right after a `;` — never
  // mid-expression, so `CASE ... END` is not a false positive.
  if (/(?:^|;)\s*END(?:\s+(?:TRANSACTION|WORK))?\s*(?:;|$)/i.test(stripped)) return true;
  // PREPARE TRANSACTION commits work into a prepared transaction.
  if (/(?:^|;)\s*PREPARE\s+TRANSACTION\b/i.test(stripped)) return true;
  return false;
}

/**
 * Split a script into statements, ignoring semicolons that are not statement
 * boundaries.
 *
 * A plain `sql.split(";")` cuts a function body in half at the first `;` inside
 * `$$ ... $$`, and cuts a string literal containing a semicolon in half too.
 * Splitting on the masked copy instead means only a semicolon the database
 * would treat as a boundary ends a statement — while the text handed back is
 * sliced from the ORIGINAL, comments, literals and all.
 */
function splitStatements(sql: string): string[] {
  const mask = maskNonCode(sql);
  const out: string[] = [];
  let start = 0;

  for (let i = 0; i < mask.length; i += 1) {
    if (mask[i] === ";") {
      out.push(sql.slice(start, i));
      start = i + 1;
    }
  }

  out.push(sql.slice(start));
  return out.map((stmt) => stmt.trim()).filter((stmt) => stmt.length > 0);
}

/** Drop any comment lines sitting in front of a statement's first keyword. */
function stripLeadingComments(statement: string): string {
  let rest = statement.trimStart();
  for (;;) {
    if (rest.startsWith("--")) {
      const newline = rest.indexOf("\n");
      rest = newline === -1 ? "" : rest.slice(newline + 1).trimStart();
      continue;
    }
    if (rest.startsWith("/*")) {
      const end = rest.indexOf("*/");
      rest = end === -1 ? "" : rest.slice(end + 2).trimStart();
      continue;
    }
    return rest;
  }
}

/**
 * Pull out the `ALTER TYPE … ADD VALUE …` statements in a script, rewritten to
 * be idempotent.
 *
 * PostgreSQL refuses to let a newly added enum value be USED by a later
 * statement in the same transaction ("unsafe use of new value"), and the apply
 * route runs the whole script as one transaction. So a migration that adds
 * `'refunded'` and then creates an index with `WHERE state <> 'refunded'` fails
 * halfway through, however correct the SQL is.
 *
 * The fix is to run these — and only these — before the transaction opens. That
 * is safe because adding an enum label is purely additive, and if the migration
 * then rolls back all that survives is a label nothing references.
 *
 * Only statements that already say IF NOT EXISTS are returned. Without it, the
 * copy still sitting in the script would hit the value this just created and
 * fail with "enum label already exists" — so a statement written without it is
 * left alone rather than rewritten behind the author's back. Every ALTER TYPE
 * the migration generator emits carries IF NOT EXISTS for this reason.
 */
export function extractEnumAddValues(sql: string): string[] {
  const statements: string[] = [];
  for (const raw of splitStatements(sql)) {
    const statement = stripLeadingComments(raw);
    if (!/^ALTER\s+TYPE\b/i.test(statement)) continue;
    if (!/\bADD\s+VALUE\s+IF\s+NOT\s+EXISTS\b/i.test(statement)) continue;
    statements.push(`${statement};`);
  }
  return statements;
}
