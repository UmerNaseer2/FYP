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
 *
 * keepQuotedNames leaves "quoted names" as they are and still blanks the rest.
 * The change-type reader needs it to tell DROP TRIGGER "Audit" from a CREATE
 * TRIGGER of some other trigger. Every guard uses the default, which blanks
 * them, so a keyword hidden in a quoted name never counts as code.
 *
 * The scanner mirrors PostgreSQL's own lexer (src/backend/parser/scan.l),
 * because anything it reads differently from the lexer is a hole a second
 * statement can hide in. The subtle parts, and why each is here:
 *
 *   - Identifiers are consumed WHOLE, through letters, digits, `_`, `$` and any
 *     byte ≥ 0x80 — exactly the lexer's ident_cont. So `a$b$` is one name, not
 *     a name and a dollar quote, and `x1F$$` is one name, not a name and a
 *     dollar quote wrapping whatever comes next. Reading that `$$` as a tag
 *     would blank a real COMMIT sitting after it.
 *   - Numbers are consumed too (PG14-style: digits, one dot, one exponent).
 *     Only so a number butted against a dollar quote — `1e5$$…$$` — leaves the
 *     dollar quote to be recognised, instead of the digits being skipped and
 *     the `e5$$` swallowed as an identifier.
 *   - An E'' string — backslash escapes and all — is entered ONLY when the
 *     token just read is the bare word E or e. `aE'…'` and `1E'…'` after a
 *     number are handled by that naturally: the E is part of the name / the
 *     number is read first.
 *   - A '' string CONTINUES across a newline: after its closing quote,
 *     whitespace containing a newline (and -- line comments) then another quote
 *     resumes the SAME string in the SAME mode, so an E'' string's escapes
 *     carry on. A block comment sitting between the two quotes breaks the
 *     continuation, which is why it only skips whitespace and -- comments.
 *   - Block comments NEST (an inner opener raises the depth), matching the
 *     lexer, so a COMMIT after nested block comments is not left half-masked.
 *   - A -- line comment ends at \n OR \r, the lexer's newline class.
 */
export function maskNonCode(sql: string, options: { keepQuotedNames?: boolean } = {}): string {
  const out = sql.split("");
  const len = sql.length;

  // A dollar-quote tag is empty or a name (letter/underscore/high byte, then
  // more of those or digits). Tried only at a `$` that did not continue a name,
  // so `$1` placeholders and the `$` inside an identifier never open one.
  const dollarTag = /\$(?:[A-Za-z_\u0080-\uffff][A-Za-z0-9_\u0080-\uffff]*)?\$/y;
  const number = /[0-9]+(?:\.[0-9]*)?(?:[Ee][+-]?[0-9]+)?/y;
  // quotecontinue, from scan.l: horizontal space and -- comments, then a
  // newline, then any run of space or --comment-lines, then the next quote.
  const quoteContinue = /(?:[ \t\f]|--[^\n\r]*)*[\n\r](?:[ \t\n\r\f\v]+|--[^\n\r]*[\n\r])*'/y;

  function blank(from: number, to: number): void {
    for (let k = from; k < to && k < len; k += 1) {
      if (out[k] !== "\n") out[k] = " ";
    }
  }

  const code = (p: number): number => (p >= 0 && p < len ? sql.charCodeAt(p) : -1);
  function isIdentStart(p: number): boolean {
    const c = code(p);
    return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c >= 128;
  }
  function isIdentCont(p: number): boolean {
    const c = code(p);
    return (
      (c >= 48 && c <= 57) ||
      (c >= 65 && c <= 90) ||
      (c >= 97 && c <= 122) ||
      c === 95 ||
      c === 36 || // $
      c >= 128
    );
  }

  // Walk a '' string that has opened at `open` and blank it, following the end
  // through '' doubling, backslash escapes (E'' only) and newline continuation.
  // Returns the index just past the whole thing.
  function scanQuote(open: number, escapes: boolean): number {
    let j = open + 1;
    for (;;) {
      while (j < len) {
        if (escapes && sql[j] === "\\") {
          j += 2;
          continue;
        }
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") {
            j += 2; // doubled quote, part of the string
            continue;
          }
          break;
        }
        j += 1;
      }
      if (j >= len) {
        blank(open, len); // unterminated
        return len;
      }
      const closeAt = j + 1;
      quoteContinue.lastIndex = closeAt;
      const cont = quoteContinue.exec(sql);
      if (!cont) {
        blank(open, closeAt);
        return closeAt;
      }
      // Blank through the gap and resume the same string at the next quote.
      blank(open, quoteContinue.lastIndex);
      j = quoteContinue.lastIndex; // one past the continuing quote
    }
  }

  let i = 0;
  while (i < len) {
    const ch = sql[i];

    if (ch === "-" && sql[i + 1] === "-") {
      let j = i + 2;
      while (j < len && sql[j] !== "\n" && sql[j] !== "\r") j += 1;
      blank(i, j);
      i = j;
      continue;
    }

    if (ch === "/" && sql[i + 1] === "*") {
      let j = i + 2;
      let depth = 1;
      while (j < len && depth > 0) {
        if (sql[j] === "/" && sql[j + 1] === "*") {
          depth += 1;
          j += 2;
        } else if (sql[j] === "*" && sql[j + 1] === "/") {
          depth -= 1;
          j += 2;
        } else {
          j += 1;
        }
      }
      blank(i, j);
      i = j;
      continue;
    }

    // An identifier, consumed whole. If it is the bare word E/e and a quote
    // follows, it introduces an E'' string (escapes on); the E itself stays.
    if (isIdentStart(i)) {
      let j = i + 1;
      while (j < len && isIdentCont(j)) j += 1;
      const word = sql.slice(i, j);
      if ((word === "E" || word === "e") && sql[j] === "'") {
        i = scanQuote(j, true);
        continue;
      }
      i = j; // an ordinary name is code, left as it is
      continue;
    }

    if (ch >= "0" && ch <= "9") {
      number.lastIndex = i;
      const m = number.exec(sql);
      i = m ? number.lastIndex : i + 1; // a number is code, left as it is
      continue;
    }

    if (ch === "'") {
      i = scanQuote(i, false);
      continue;
    }

    if (ch === '"') {
      let j = i + 1;
      while (j < len) {
        if (sql[j] === '"') {
          if (sql[j + 1] === '"') {
            j += 2; // "" is an escaped quote inside the name
            continue;
          }
          j += 1;
          break;
        }
        j += 1;
      }
      const end = Math.min(j, len);
      if (!options.keepQuotedNames) blank(i, end);
      i = end;
      continue;
    }

    if (ch === "$") {
      dollarTag.lastIndex = i;
      const tag = dollarTag.exec(sql);
      if (tag) {
        const close = sql.indexOf(tag[0], i + tag[0].length);
        const end = close === -1 ? len : close + tag[0].length;
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
 * Statements that take rows out of a live table, named by keyword.
 *
 * Deliberately separate from changeTypeOf. That grades a script for the version
 * bump — how much the SHAPE moved — and TRUNCATE moves no shape at all, so it
 * grades "patch" and the deploy checklist happily reported "nothing in this run
 * is breaking" above a statement that empties a table. Those are two different
 * questions and this is the second one: not how big a version this is, but
 * whether rows go away.
 *
 * DROP TABLE and DROP SCHEMA are here as well as in the breaking grade. They
 * are both things at once, and a reader deciding whether they need a backup
 * first is asking this question, not the version one.
 *
 * The scan runs on maskNonCode's output for the same reason every other scan in
 * this file does: a keyword in a comment or a string literal is not a statement.
 * maskNonCode blanks a dollar-quoted body whole, though, and the inside of a DO
 * block is code: `DO $$ BEGIN IF … THEN DELETE FROM orders …; END IF; END $$`
 * is the usual way to write a cleanup that is safe to run twice. So the DO
 * bodies are read as well (masked in the same way), or that DELETE would reach
 * the target with no warning and no data-loss tick.
 *
 * Returns the keywords it found, in a fixed order, so the screen can name them.
 */
export function findRowDestroyingStatements(sql: string): string[] {
  const code = maskNonCode(sql);
  const doBodies = doBlockBodies(sql);
  const checks: [RegExp, string][] = [
    [/\bTRUNCATE\b/i, "TRUNCATE"],
    [/\bDELETE\s+FROM\b/i, "DELETE"],
    [/\bDROP\s+TABLE\b/i, "DROP TABLE"],
    // A dropped column takes its values with it. It was missing here because it
    // is already graded breaking, but breaking answers a different question:
    // "what stops working" is not "what do I need a backup of".
    [/\bDROP\s+COLUMN\b/i, "DROP COLUMN"],
    [/\bDROP\s+SCHEMA\b/i, "DROP SCHEMA"],
    [/\bDROP\s+DATABASE\b/i, "DROP DATABASE"],
  ];
  return checks
    .filter(([pattern]) => pattern.test(code) || pattern.test(doBodies))
    .map(([, label]) => label);
}

/**
 * The labels findRowDestroyingStatements can return that the breaking grade
 * never catches. TRUNCATE and DELETE move no structure, so changeTypeOf grades
 * them patch and Deploy shows no breaking pill for them. Every DROP in that
 * list is always breaking as well, so the reader already has one warning for it.
 *
 * Deploy uses this to say when its deletes-rows gate is the only warning a
 * statement gets. tests/sql-guard.test.ts checks it against gradeSql, so the
 * two modules cannot drift apart.
 */
export const ROW_DESTROYING_NOT_BREAKING: readonly string[] = ["TRUNCATE", "DELETE"];

/**
 * Statements that can fail when they meet the rows already in the table, even
 * though the SQL itself is perfectly valid.
 *
 * This is the third question a migration raises, and the one this app never
 * asked. The other two are "does it break what reads the schema" (the breaking
 * grade) and "does it delete rows" (findRowDestroyingStatements above). Neither
 * of them covers `ALTER TABLE orders ADD COLUMN ref text NOT NULL` — that adds
 * a column, breaks nothing, deletes nothing, and stops dead on any table that
 * already has a row in it.
 *
 * Splitting the three apart is how Atlas grades migrations, and the reason to
 * copy it is that they fail differently: a breaking change succeeds and takes
 * something else down with it, a destructive one succeeds and cannot be undone,
 * and one of these simply does not run. Because the deploy runs inside one
 * transaction, a failure here rolls the whole run back and changes nothing —
 * which is why the screen warns about these rather than gating on them.
 *
 * Detection is deliberately shallow: it names the shape, not the table, because
 * whether it actually fails depends on data this app has not read. Every check
 * below is written so that an empty table always passes it.
 *
 * The inside of a DO block is read too. maskNonCode blanks a dollar-quoted body
 * whole, and the constraints a generated script adds now live in exactly such
 * blocks, each behind a lookup that skips it when it is already there (see
 * onlyIfMissing in lib/generate-sql.ts). Only the constraint and unique-index
 * checks look inside. The one SET NOT NULL a generated script puts in a DO
 * block already skips a table that holds rows, so it cannot fail this way and
 * is deliberately not counted.
 *
 * Returns the labels it found, in a fixed order, so the screen can name them.
 */
export function findMightFailStatements(sql: string): string[] {
  const code = maskNonCode(sql);
  const doBodies = doBlockBodies(sql);
  // The third item says whether the check also reads the inside of DO blocks.
  const checks: [RegExp, string, boolean][] = [
    // NOT NULL with no DEFAULT: every existing row would need a value and has
    // none. With a DEFAULT the same statement is fine, so the pattern has to
    // look at the rest of the clause, up to the comma or paren that ends it.
    [/\bADD\s+COLUMN\b(?:\s+IF\s+NOT\s+EXISTS)?[^,;()]*\bNOT\s+NULL\b(?![^,;]*\bDEFAULT\b)/i,
      "NOT NULL column with no default", false],
    // Promoting an existing column: fails on the first NULL already stored.
    [/\bSET\s+NOT\s+NULL\b/i, "SET NOT NULL", false],
    // Uniqueness applied after the fact: fails on the first duplicate.
    [/\bADD\s+CONSTRAINT\b[^;]*\bUNIQUE\b/i, "UNIQUE constraint", true],
    [/\bCREATE\s+UNIQUE\s+INDEX\b/i, "UNIQUE index", true],
    // A foreign key added to a populated table fails on the first orphan.
    [/\bADD\s+CONSTRAINT\b[^;]*\bFOREIGN\s+KEY\b/i, "FOREIGN KEY constraint", true],
    // A CHECK is validated against every existing row when it is added.
    [/\bADD\s+CONSTRAINT\b[^;]*\bCHECK\b/i, "CHECK constraint", true],
    // A type change casts every row. Narrowing, or a text column holding one
    // unparseable value, and the whole statement stops.
    [/\bALTER\s+COLUMN\b[^;]*\bTYPE\b/i, "column type change", false],
  ];
  return checks
    .filter(
      ([pattern, , alsoInDoBlocks]) =>
        pattern.test(code) || (alsoInDoBlocks && pattern.test(doBodies))
    )
    .map(([, label]) => label);
}

/**
 * The inside of every DO block in a script, masked, one after another.
 *
 * maskNonCode blanks a dollar-quoted body whole. That is right for most scans,
 * but a generated script runs some of its statements from exactly such a body,
 * behind a lookup that skips them on a second run (see onlyIfMissing in
 * lib/generate-sql.ts). A scan that has to see those statements reads this as
 * well as the masked script.
 */
export function doBlockBodies(sql: string): string {
  return splitStatements(sql)
    .map(stripLeadingComments)
    .filter((statement) => /^DO\b/i.test(statement))
    .map(doBlockBody)
    .join("\n");
}

/**
 * The inside of a DO block, masked the same way as the rest of the script: the
 * text from its first dollar tag up to the next copy of that same tag. The tag
 * may carry a name ($guard$ as well as $$), and only the same tag closes it.
 * Empty when the statement has no dollar-quoted body.
 */
function doBlockBody(statement: string): string {
  const tag = /\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(statement);
  if (!tag) return "";
  const start = tag.index + tag[0].length;
  const end = statement.indexOf(tag[0], start);
  return maskNonCode(end === -1 ? statement.slice(start) : statement.slice(start, end));
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
 *
 * Exported because the query analyser needs the same answer for a different
 * reason: it refuses to EXPLAIN a box holding more than one statement, and
 * "more than one" has to mean what the database would say, not what a split on
 * semicolons would say.
 */
export function splitStatements(sql: string): string[] {
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

/**
 * True when a script has at least one statement that would actually run.
 *
 * "Has text" is not "has a rollback". PostgreSQL accepts a file of nothing but
 * comments and semicolons as an empty query and changes nothing, so a
 * comment-only rollback used to delete the ledger row and report "Rolled back"
 * while the database stayed exactly as it was. This is the ONE executable-SQL
 * test, used at every boundary (push, pull, preflight, Deploy, revert, apply),
 * so every screen and route agree on what counts.
 *
 * Built on maskNonCode: a word inside a comment, a string literal, a quoted
 * name or a dollar-quoted body never counts on its own, while the statement
 * around it (the SELECT holding the literal, the DO holding the body) does.
 */
export function hasExecutableSql(sql: string): boolean {
  // A caller that forwards a request body unchecked can hand in anything.
  if (typeof sql !== "string") return false;
  return maskNonCode(sql).replace(/[;\s]/g, "").length > 0;
}
