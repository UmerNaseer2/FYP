// Shared, dependency-free SQL guard used by BOTH the server apply route
// (app/api/scripts/apply/route.ts) and the client deploy page
// (app/(studio)/deploy/page.tsx), so the two always agree on what counts as a
// transaction-control statement. Keeping one implementation here removes the
// drift that existed when each screen had its own slightly different regex.

/**
 * Detect a bare transaction-control statement in a migration script. Any of these
 * would break the apply route's outer transaction wrapper (committing partial DDL
 * with no ledger row, or aborting it), so they are rejected up front.
 *
 * Covers COMMIT, ROLLBACK, and their SQL synonyms: ABORT (= ROLLBACK), END /
 * END TRANSACTION / END WORK (= COMMIT), and PREPARE TRANSACTION.
 *
 * Before scanning, we strip the places these words can legitimately appear so
 * they are NOT treated as transaction control:
 *   - `-- line comments`
 *   - `/* block comments *​/`
 *   - dollar-quoted bodies (`$$ … $$` / `$tag$ … $tag$`) — e.g. a normal
 *     `CREATE PROCEDURE … AS $$ BEGIN COMMIT; END $$;` PL/pgSQL body
 *   - `'single-quoted'` string literals — e.g. `INSERT INTO t VALUES ('ROLLBACK')`
 *
 * Dollar-quoted bodies are stripped before single-quoted literals because a
 * function body can itself contain apostrophes; removing the whole `$$ … $$`
 * block first avoids mis-pairing those inner quotes.
 */
export function containsTransactionControl(sql: string): boolean {
  const stripped = sql
    .replace(/--[^\n]*/g, " ") // remove -- line comments
    .replace(/\/\*[\s\S]*?\*\//g, " ") // remove /* block comments */
    .replace(/\$([A-Za-z0-9_]*)\$[\s\S]*?\$\1\$/g, " ") // remove $tag$ … $tag$ bodies
    .replace(/'([^']|'')*'/g, "''"); // replace 'string literals' with ''

  // COMMIT / ROLLBACK / ABORT as standalone words — none is a normal identifier,
  // and ABORT is a ROLLBACK synonym.
  if (/\b(COMMIT|ROLLBACK|ABORT)\b/i.test(stripped)) return true;
  // END / END TRANSACTION / END WORK is a COMMIT synonym, but END also closes a
  // CASE expression (and a PL/pgSQL block, already stripped above). Only flag END
  // at a STATEMENT boundary — start of script or right after a `;` — never
  // mid-expression, so `CASE … END` is not a false positive.
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
 * `$$ … $$`, and cuts a string literal containing a semicolon in half too. This
 * walks the text instead, skipping over comments, `'literals'`, "identifiers"
 * and dollar-quoted bodies, so only a real boundary ends a statement.
 */
function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let start = 0;
  let i = 0;

  while (i < sql.length) {
    const ch = sql[i];

    if (ch === "-" && sql[i + 1] === "-") {
      const newline = sql.indexOf("\n", i);
      i = newline === -1 ? sql.length : newline + 1;
      continue;
    }
    if (ch === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      i = end === -1 ? sql.length : end + 2;
      continue;
    }
    if (ch === "'" || ch === '"') {
      const quote = ch;
      i += 1;
      while (i < sql.length) {
        if (sql[i] !== quote) {
          i += 1;
        } else if (sql[i + 1] === quote) {
          i += 2; // '' inside a literal is an escaped quote, not the end
        } else {
          i += 1;
          break;
        }
      }
      continue;
    }
    if (ch === "$") {
      // A dollar-quote tag is empty or starts with a letter/underscore, which is
      // what keeps a `$1` placeholder from being read as an opening tag.
      const tag = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (tag) {
        const close = sql.indexOf(tag[0], i + tag[0].length);
        i = close === -1 ? sql.length : close + tag[0].length;
        continue;
      }
    }
    if (ch === ";") {
      out.push(sql.slice(start, i));
      start = i + 1;
    }
    i += 1;
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
