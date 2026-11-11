// Shared, dependency-free SQL guard used by BOTH the server apply route
// (app/api/scripts/apply/route.ts) and the client deploy page
// (app/[org]/(studio)/deploy/page.tsx), so the two always agree on what counts
// as a transaction-control statement. Keeping one implementation here removes
// the drift that existed when each screen had its own slightly different regex.

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
 * keepComments and readDollarBodies are for stripSchemaFromExpr in
 * lib/postgres.ts, which only needs to know where the string literals are.
 * keepComments still reads a comment as a comment, so a quote inside one opens
 * nothing, but leaves its text in place. readDollarBodies reads a dollar-quoted
 * body the way a function body is read: the tags on both ends are stepped over
 * and the text between is scanned as code, so its own literals are blanked. A
 * dollar-quoted string nested inside that body is still a string, and is
 * blanked. No guard may use either option: a word in a function body would then
 * count as a statement.
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
export function maskNonCode(
  sql: string,
  options: { keepQuotedNames?: boolean; keepComments?: boolean; readDollarBodies?: boolean } = {}
): string {
  const out = sql.split("");
  const len = sql.length;
  // With readDollarBodies, the tag of the body being read as code, if one is open.
  let openBody: string | null = null;

  // A dollar-quote tag is empty or a name (letter/underscore/high byte, then
  // more of those or digits). Tried only at a `$` that did not continue a name,
  // so `$1` placeholders and the `$` inside an identifier never open one.
  const dollarTag = /\$(?:[A-Za-z_\u0080-\uffff][A-Za-z0-9_\u0080-\uffff]*)?\$/y;
  const number = /[0-9]+(?:\.[0-9]*)?(?:[Ee][+-]?[0-9]+)?/y;
  // quotecontinue, from scan.l: horizontal space and -- comments, then a
  // newline, then any run of space or --comment-lines, then the next quote.
  const quoteContinue = /(?:[ \t\f]|--[^\n\r]*)*[\n\r](?:[ \t\n\r\f\v]|--[^\n\r]*[\n\r])*'/y;

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
      if (!options.keepComments) blank(i, j);
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
      if (!options.keepComments) blank(i, j);
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
        // Reading bodies as code: step over the tag that opens the body and the
        // same tag that closes it. Any other tag in between opens a string,
        // which is blanked below like everywhere else.
        if (options.readDollarBodies && (openBody === null || tag[0] === openBody)) {
          openBody = openBody === null ? tag[0] : null;
          i += tag[0].length;
          continue;
        }
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
 * Covers COMMIT, ROLLBACK, and their SQL synonyms: ABORT (= ROLLBACK), END in
 * every spelling PostgreSQL accepts (END, END WORK, END TRANSACTION, END AND
 * NO CHAIN, and so on, all = COMMIT), and PREPARE TRANSACTION.
 *
 * It also refuses any mention of standard_conforming_strings. With that
 * setting off, PostgreSQL reads a backslash inside an ordinary '' string as an
 * escape, so `'\''` is a whole string to the server and an unfinished one to
 * maskNonCode below. A script that turns it off could then hide a COMMIT in
 * what this check takes for a string. Nothing a migration needs depends on it,
 * so the name alone is enough to refuse, wherever it appears.
 *
 * The scan runs on the masked copy, so none of these count:
 *   - a word in a comment, of either kind
 *   - a word in a dollar-quoted body — e.g. the ordinary
 *     `CREATE PROCEDURE ... AS $$ BEGIN ... END $$;` shape of PL/pgSQL
 *   - a word in a string literal, e.g. `INSERT INTO t VALUES ('ROLLBACK')`
 *   - a word used as a quoted identifier, e.g. a column called "commit"
 */
export function containsTransactionControl(sql: string): boolean {
  // Read on the raw text, so a quoted name or a set_config('...') string that
  // spells it is caught too. A comment that mentions it is refused as well;
  // that costs nothing, and the rule stays one line.
  if (/standard_conforming_strings/i.test(sql)) return true;

  const stripped = maskNonCode(sql);

  // COMMIT / ROLLBACK / ABORT as standalone words — none is a normal identifier,
  // and ABORT is a ROLLBACK synonym.
  if (/\b(COMMIT|ROLLBACK|ABORT)\b/i.test(stripped)) return true;
  // END is a COMMIT synonym, but END also closes a CASE expression (and a
  // PL/pgSQL block, already masked above). Only flag END at a STATEMENT
  // boundary — start of script or right after a `;` — never mid-expression, so
  // `CASE ... END` is not a false positive. Whatever follows it does not
  // matter: no statement other than this COMMIT starts with END, and listing
  // the spellings let `END AND NO CHAIN;` through.
  if (/(?:^|;)\s*END\b/i.test(stripped)) return true;
  // PREPARE TRANSACTION commits work into a prepared transaction.
  if (/(?:^|;)\s*PREPARE\s+TRANSACTION\b/i.test(stripped)) return true;
  return false;
}

// The words that can follow DROP inside ALTER TABLE without it being a column.
const NOT_A_COLUMN_AFTER_DROP = new Set([
  "column",
  "constraint",
  "default",
  "not",
  "identity",
  "expression",
]);

/**
 * ALTER TABLE t DROP legacy — a column drop written without the COLUMN keyword,
 * which PostgreSQL accepts. An empty word means the name was a quoted
 * identifier, which the mask blanked; that is a column too.
 *
 * Takes one statement already masked, lower-cased and single-spaced. It lives
 * here rather than in lib/change-type because both readers need it: the version
 * grade asks whether a column goes away, and so does the deletes-rows check
 * below. It was written once, in change-type, and the other question was left
 * with a plain /DROP COLUMN/ search that this spelling walks straight past —
 * so the same statement was graded breaking and "deletes nothing".
 */
export function dropsColumnWithoutKeyword(statement: string): boolean {
  if (!/^alter table\b/.test(statement)) return false;
  // The word after DROP is optional in the pattern, because a blanked quoted
  // name can leave DROP as the last word of the statement.
  for (const match of statement.matchAll(/\bdrop\b(?: if exists\b)?(?: (\w+))?/g)) {
    if (!NOT_A_COLUMN_AFTER_DROP.has(match[1] ?? "")) return true;
  }
  return false;
}

/**
 * Every statement that will run, in the shape the rule above expects: masked,
 * lower-cased, single-spaced. The inside of a DO block is read as well, because
 * maskNonCode blanks it whole and a generated script puts real statements
 * there. BEGIN / THEN / ELSE / LOOP end a piece, so "IF … THEN ALTER TABLE …"
 * is read as a statement starting with ALTER TABLE. (lib/change-type does the
 * same thing for its own rules, and keeps the quoted names alongside.)
 */
function tidyStatements(code: string, doBodies: string): string[] {
  return [...tidyPieces(splitStatements(code)), ...doBlockPieces(doBodies)];
}

/** The statements inside DO blocks only, in the same shape. */
function doBlockPieces(doBodies: string): string[] {
  return tidyPieces(doBodies.replace(/\b(begin|then|else|loop)\b/gi, ";").split(";"));
}

function tidyPieces(pieces: string[]): string[] {
  return pieces.map((piece) => piece.toLowerCase().replace(/\s+/g, " ").trim()).filter(Boolean);
}

/**
 * Whether one statement inside a DO block runs SQL that is built as a string:
 * EXECUTE 'DROP TABLE orders', EXECUTE format(...), FOR r IN EXECUTE '...'.
 * The mask blanks the string, so no reader here can tell what it does.
 *
 * Takes one piece already masked, lower-cased and single-spaced. The EXECUTE
 * in CREATE TRIGGER ... EXECUTE FUNCTION f() names a function, not a string,
 * and does not count. lib/change-type asks the same question for its grade.
 */
export function runsSqlFromString(piece: string): boolean {
  if (/\bexecute (function|procedure)\b/.test(piece)) return false;
  return /^execute\b|\b(in|for|query) execute\b/.test(piece);
}

/** The label findRowDestroyingStatements gives a DO block statement it cannot read. */
export const EXECUTE_CANNOT_BE_READ = "EXECUTE (cannot be read)";

// DROP ... CASCADE of one of these never takes a column with it: it is either
// named in the list on its own (TABLE, SCHEMA, DATABASE, OWNED), or its CASCADE
// only reaches views, constraints and defaults.
const CASCADE_KEEPS_COLUMNS =
  /^drop (table|schema|database|owned|view|materialized view|foreign table|index|sequence|trigger|policy|rule)\b/;

/**
 * DROP TYPE order_status CASCADE also drops every column of that type, and the
 * values in it. The same goes for a domain, a collation, an extension's types
 * and a function a generated column uses. Any DROP with CASCADE counts unless
 * it is one of the kinds above. Takes one tidy statement.
 */
function dropCascadeCanTakeColumns(statement: string): boolean {
  if (!/^drop\b/.test(statement) || !/\bcascade\b/.test(statement)) return false;
  return !CASCADE_KEEPS_COLUMNS.test(statement);
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
 * What it cannot read is named too. EXECUTE inside a DO block runs SQL from a
 * string, and the string could be a TRUNCATE, so it comes back as "EXECUTE
 * (cannot be read)" and the screen asks for the same tick. Two things are still
 * not seen: a function the script creates and then calls, and an UPDATE with
 * no WHERE (it overwrites values but deletes no row).
 *
 * Returns the keywords it found, in a fixed order, so the screen can name them.
 */
export function findRowDestroyingStatements(sql: string): string[] {
  const code = maskNonCode(sql);
  const doBodies = doBlockBodies(sql);
  const found = (pattern: RegExp) => pattern.test(code) || pattern.test(doBodies);

  // A dropped column takes its values with it. It was missing here because it
  // is already graded breaking, but breaking answers a different question:
  // "what stops working" is not "what do I need a backup of".
  //
  // The keyword is optional in PostgreSQL, and "ALTER TABLE t DROP legacy"
  // matches no pattern here, so the statements are asked one by one with the
  // same rule the version grade uses.
  const statements = tidyStatements(code, doBodies);
  const dropsColumn = found(/\bDROP\s+COLUMN\b/i) || statements.some(dropsColumnWithoutKeyword);

  const checks: [boolean, string][] = [
    [found(/\bTRUNCATE\b/i), "TRUNCATE"],
    // MERGE ... WHEN MATCHED THEN DELETE deletes rows without the word FROM.
    [found(/\bDELETE\s+FROM\b/i) || found(/\bTHEN\s+DELETE\b/i), "DELETE"],
    [found(/\bDROP\s+TABLE\b/i), "DROP TABLE"],
    [dropsColumn, "DROP COLUMN"],
    [found(/\bDROP\s+SCHEMA\b/i), "DROP SCHEMA"],
    [found(/\bDROP\s+DATABASE\b/i), "DROP DATABASE"],
    // DROP OWNED BY role drops every table that role owns.
    [found(/\bDROP\s+OWNED\b/i), "DROP OWNED"],
    [statements.some(dropCascadeCanTakeColumns), "DROP … CASCADE"],
    [doBlockPieces(doBodies).some(runsSqlFromString), EXECUTE_CANNOT_BE_READ],
  ];
  return checks.filter(([hit]) => hit).map(([, label]) => label);
}

/**
 * The labels findRowDestroyingStatements can return that the breaking grade
 * never catches. TRUNCATE and DELETE move no structure, so changeTypeOf grades
 * them patch and Deploy shows no breaking pill for them. Every DROP in that
 * list is always breaking as well, so the reader already has one warning for it.
 * "EXECUTE (cannot be read)" is in neither group: it is graded "breaking
 * unless", and nobody knows whether the SQL it runs changes structure.
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
 * The inside of a DO block, masked the same way as the rest of the script.
 * Takes one statement that starts with DO.
 *
 * The body is read in whatever quotes it was written: $$ … $$ (the tag may
 * carry a name, $guard$), '…' or E'…'. It used to be read only between dollar
 * tags, so DO 'BEGIN DROP TABLE orders; END' reached every reader as an empty
 * body: graded patch, with no deletes-rows warning. Empty when the statement
 * has no body this can decode.
 */
function doBlockBody(statement: string): string {
  // The statement starts with DO, so the first DO body found is its own.
  const body = codeBodiesIn(statement).bodies.find((found) => found.kind === "do");
  return body ? maskNonCode(body.text) : "";
}

// ─── Code bodies in any quoting ─────────────────────────────────────────────

/** The inside of a DO block or a function or procedure, as the server will run it. */
export type CodeBody = { kind: "do" | "routine"; text: string };

/** How many bodies inside bodies are read before the reading gives up. */
const MAX_BODY_DEPTH = 4;

/**
 * Every DO body and function or procedure body in a script, decoded, in
 * whatever quotes it was written: $$ … $$, '…' with '' for a quote, or E'…'
 * with backslash escapes. Bodies inside bodies are read too.
 *
 * maskNonCode blanks a '' string whole, so `DO 'BEGIN PERFORM pg_sleep(100);
 * END'` used to pass every scan that reads bodies. This is for scans that must
 * see what really runs. doBlockBodies reads a DO body through it; no reader
 * outside the AI checks reads a function or procedure body.
 *
 * A body is the literal that follows DO (around an optional LANGUAGE name) or
 * the first literal after AS (CREATE FUNCTION … AS '…'). `unreadable` is true
 * when a body is written in a way this does not decode (a U&'' string), or
 * bodies are nested deeper than MAX_BODY_DEPTH. A caller that refuses what it
 * cannot read refuses then.
 *
 * Each text is the body itself, not masked: a caller masks it the way it masks
 * a whole script.
 */
export function codeBodiesIn(sql: string): { bodies: CodeBody[]; unreadable: boolean } {
  const result = { bodies: [] as CodeBody[], unreadable: false };
  collectBodies(sql, 0, result);
  return result;
}

function collectBodies(sql: string, depth: number, result: { bodies: CodeBody[]; unreadable: boolean }): void {
  // The keywords are looked for in code only, never in a string or comment.
  const code = maskNonCode(sql);
  for (const match of code.matchAll(/\b(DO|AS)\b/gi)) {
    const kind: CodeBody["kind"] = match[1].toLowerCase() === "do" ? "do" : "routine";
    let at = match.index + match[0].length;
    for (;;) {
      at = skipSpaceAndComments(sql, at);
      // DO LANGUAGE plpgsql '…' and DO '…' LANGUAGE plpgsql: the name (which
      // may itself be a string) is not a body, so it is stepped over.
      if (kind === "do" && /^LANGUAGE\b/i.test(sql.slice(at, at + 9))) {
        at = skipSpaceAndComments(sql, at + "LANGUAGE".length);
        const name = readLiteral(sql, at);
        if (name) at = name.end;
        else at += (/^(?:"(?:[^"]|"")*"|[A-Za-z_][A-Za-z0-9_$]*)/.exec(sql.slice(at)) ?? [""])[0].length;
        continue;
      }
      const literal = readLiteral(sql, at);
      // ON CONFLICT DO NOTHING, DO INSTEAD, AS SELECT, AS (…): no literal, no body.
      if (!literal) break;
      if (literal.text === null) {
        result.unreadable = true;
      } else if (depth + 1 > MAX_BODY_DEPTH) {
        result.unreadable = true;
      } else {
        result.bodies.push({ kind, text: literal.text });
        collectBodies(literal.text, depth + 1, result);
      }
      at = literal.end;
      // A function has one body. AS 'file', 'symbol' (a C function) names a
      // file and a symbol, and the second is not code.
      if (kind === "routine") break;
    }
  }
}

/** Step over spaces, -- comments and (nested) block comments. */
function skipSpaceAndComments(sql: string, from: number): number {
  let at = from;
  for (;;) {
    while (at < sql.length && /\s/.test(sql[at])) at += 1;
    if (sql.startsWith("--", at)) {
      while (at < sql.length && sql[at] !== "\n" && sql[at] !== "\r") at += 1;
      continue;
    }
    if (sql.startsWith("/*", at)) {
      let depth = 1;
      at += 2;
      while (at < sql.length && depth > 0) {
        if (sql.startsWith("/*", at)) {
          depth += 1;
          at += 2;
        } else if (sql.startsWith("*/", at)) {
          depth -= 1;
          at += 2;
        } else {
          at += 1;
        }
      }
      continue;
    }
    return at;
  }
}

/**
 * The string literal starting at `at`, decoded, and the index just past it.
 * Null when no literal starts there. `text` is null for a literal this does
 * not decode (U&'…').
 */
function readLiteral(sql: string, at: number): { text: string | null; end: number } | null {
  if (sql[at] === "'") return readQuoted(sql, at, false);
  if ((sql[at] === "E" || sql[at] === "e") && sql[at + 1] === "'") return readQuoted(sql, at + 1, true);
  if ((sql[at] === "U" || sql[at] === "u") && sql[at + 1] === "&" && sql[at + 2] === "'") {
    const skipped = readQuoted(sql, at + 2, false);
    return { text: null, end: skipped.end };
  }
  if (sql[at] === "$") {
    const tag = /\$(?:[A-Za-z_\u0080-￿][A-Za-z0-9_\u0080-￿]*)?\$/y;
    tag.lastIndex = at;
    const open = tag.exec(sql);
    if (!open) return null;
    const start = at + open[0].length;
    const close = sql.indexOf(open[0], start);
    if (close === -1) return { text: sql.slice(start), end: sql.length };
    return { text: sql.slice(start, close), end: close + open[0].length };
  }
  return null;
}

/**
 * A '' string opening at `open`, decoded: '' becomes ', and with `escapes`
 * (an E'' string) the backslash escapes are read the way PostgreSQL reads
 * them, so `pg\x5fsleep` is read as pg_sleep. A string that goes on after a
 * newline ('a'<newline>'b' is 'ab') is followed, like maskNonCode does.
 */
function readQuoted(sql: string, open: number, escapes: boolean): { text: string; end: number } {
  const quoteContinue = /(?:[ \t\f]|--[^\n\r]*)*[\n\r](?:[ \t\n\r\f\v]|--[^\n\r]*[\n\r])*'/y;
  let text = "";
  let j = open + 1;
  for (;;) {
    while (j < sql.length) {
      const ch = sql[j];
      if (escapes && ch === "\\") {
        const escape = readEscape(sql, j);
        text += escape.text;
        j = escape.end;
        continue;
      }
      if (ch === "'") {
        if (sql[j + 1] === "'") {
          text += "'";
          j += 2;
          continue;
        }
        break;
      }
      text += ch;
      j += 1;
    }
    if (j >= sql.length) return { text, end: sql.length }; // unterminated
    quoteContinue.lastIndex = j + 1;
    if (!quoteContinue.exec(sql)) return { text, end: j + 1 };
    j = quoteContinue.lastIndex; // just past the quote that carries the string on
  }
}

/** One backslash escape of an E'' string, starting at the backslash. */
function readEscape(sql: string, at: number): { text: string; end: number } {
  const rest = sql.slice(at + 1, at + 10);
  const simple: Record<string, string> = { b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
  if (rest[0] !== undefined && simple[rest[0]]) return { text: simple[rest[0]], end: at + 2 };
  const octal = /^[0-7]{1,3}/.exec(rest);
  if (octal) return { text: String.fromCharCode(parseInt(octal[0], 8) & 0xff), end: at + 1 + octal[0].length };
  const hex = /^x([0-9A-Fa-f]{1,2})/.exec(rest);
  if (hex) return { text: String.fromCharCode(parseInt(hex[1], 16)), end: at + 1 + hex[0].length };
  const unicode = /^(?:u([0-9A-Fa-f]{4})|U([0-9A-Fa-f]{8}))/.exec(rest);
  if (unicode) {
    const point = parseInt(unicode[1] ?? unicode[2], 16);
    const text = point <= 0x10ffff ? String.fromCodePoint(point) : "";
    return { text, end: at + 1 + unicode[0].length };
  }
  // Any other character stands for itself: \\ is \, \' is '.
  if (at + 1 >= sql.length) return { text: "", end: sql.length };
  return { text: sql[at + 1], end: at + 2 };
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
 * The type an `ALTER TYPE … ADD VALUE` statement names, exactly as written.
 *
 * The caller hands this straight to `to_regtype` to ask whether the type is
 * already on the server, so the name is returned unchanged — quoting, schema
 * qualification, capitalisation and all — because to_regtype reads a type name
 * the same way the rest of the statement does. Null means the text is not an
 * ADD VALUE statement at all.
 */
export function enumAddValueTypeName(statement: string): string | null {
  const match = /^ALTER\s+TYPE\s+([\s\S]+?)\s+ADD\s+VALUE\b/i.exec(
    stripLeadingComments(statement)
  );
  return match ? match[1].trim() : null;
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
