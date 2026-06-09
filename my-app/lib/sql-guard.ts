// Shared, dependency-free SQL guard used by BOTH the server apply route
// (app/api/scripts/apply/route.ts) and the client deploy page
// (app/(studio)/deploy/page.tsx), so the two always agree on what counts as a
// transaction-control statement. Keeping one implementation here removes the
// drift that existed when each screen had its own slightly different regex.

/**
 * Detect a bare COMMIT or ROLLBACK in a migration script. These would break the
 * apply route's outer transaction wrapper, so they are rejected up front.
 *
 * Before scanning, we strip the places those words can legitimately appear so
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

  // Match COMMIT or ROLLBACK as standalone words (word boundary, case-insensitive).
  return /\b(COMMIT|ROLLBACK)\b/i.test(stripped);
}
