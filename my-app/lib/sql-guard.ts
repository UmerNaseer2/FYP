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
