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
 * One field, written so it cannot be confused with the text around it: its
 * length, a colon, then the field itself.
 *
 * The obvious spelling — join the fields with a separator line — has a hole.
 * SQL is free text, so a single migration whose body happens to contain the
 * separator (and the header line that follows it) produces exactly the same
 * text as two separate migrations. Those two runs would leave different
 * databases behind, so an approver could read one migration while their name
 * cleared a run of two. A length prefix closes it: the reader always knows
 * where a field ends before it starts reading it, so no content can imitate
 * structure.
 */
function field(value: string): string {
  return `${value.length}:${value}`;
}

/**
 * The shared spelling: a header line ("<count> <noun>"), then one line per
 * script. The two public functions below differ only in the noun.
 */
function runText(noun: string, scripts: ApprovalScript[]): string {
  const header = `${scripts.length} ${noun}`;
  const body = scripts.map(
    (s) => `${field(s.scriptName)}${field(s.version)}${field(s.sqlContent)}`
  );
  return [header, ...body].join("\n");
}

/**
 * Build the text for a deploy run.
 *
 * Order is preserved: the same migrations in a different order are a different
 * run and would leave a different database behind. Names and versions are in
 * the text too, so an approval for v1.2.0 cannot cover v1.3.0 even if the two
 * happen to hold identical SQL. The count leads, so a run cannot be extended
 * without changing the very first line.
 *
 * Changing this spelling invalidates every approval already recorded — they
 * stop matching and read as unapproved, which is the safe direction to fail in.
 */
export function fingerprintBody(scripts: ApprovalScript[]): string {
  return runText("migrations", scripts);
}

/**
 * Build the text for a rollback run: the same spelling under an
 * "<count> rollbacks" header. `sqlContent` is the rollback SQL that will run,
 * and the scripts go in the order they run, newest version first.
 *
 * Why a different header: deploys and rollbacks share one approvals table,
 * and both are just SQL. With the same header, a rollback whose SQL happened
 * to match some migration's SQL would get the same fingerprint, and an
 * approval for one could be spent on the other. The table's `action` column
 * keeps them apart too; the header means one forgotten `AND action = ...`
 * still cannot mix them up.
 *
 * A rollback is never part of a deploy's fingerprint: approving a deploy says
 * nothing about undoing it later, which needs its own approval.
 */
export function rollbackFingerprintBody(scripts: ApprovalScript[]): string {
  return runText("rollbacks", scripts);
}
