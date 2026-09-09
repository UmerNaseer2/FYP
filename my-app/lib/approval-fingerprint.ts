/**
 * The exact text that identifies one deploy run.
 *
 * This module is deliberately isomorphic — no node-only imports — because two
 * different places have to agree on it byte for byte: the server hashes it with
 * node:crypto when it records or claims an approval, and the Deploy screen
 * hashes it with the Web Crypto API to work out whether the run in front of the
 * user is the one that was approved.
 *
 * If those two ever spelled a run differently, an approved deploy would look
 * unapproved (or worse, the other way round), so the spelling lives here once
 * rather than twice.
 */

/** One migration as it goes into a fingerprint. */
export type ApprovalScript = {
  scriptName: string;
  version: string;
  sqlContent: string;
};

/**
 * Build the text for a run.
 *
 * Order is preserved: the same migrations in a different order are a different
 * run and would leave a different database behind. Names and versions are in
 * the text too, so an approval for v1.2.0 cannot cover v1.3.0 even if the two
 * happen to hold identical SQL.
 *
 * The separator is a whole line rather than a single character, so no SQL body
 * can contain something that makes two different runs read the same way.
 */
export function fingerprintBody(scripts: ApprovalScript[]): string {
  return scripts
    .map((s) => `${s.scriptName} ${s.version}\n${s.sqlContent}`)
    .join("\n-- next migration --\n");
}
