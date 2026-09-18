// Reading a target database's application names.
//
// Split out from lib/application-targeting.ts so that module stays what its
// header says it is: pure, and safe for the deploy screen to import into the
// browser. This half touches a database, so it is server-only — and it is one
// file rather than a copy in each route, because pre-flight showing a script
// as allowed and the apply route then refusing it (or the reverse) would be a
// worse bug than either being wrong on its own.

import { applicationNamesSql, type TargetApplications } from "./application-targeting";

/** The little of a pg client this needs, so nothing here depends on pg. */
type Queryable = {
  query: <R extends Record<string, unknown>>(
    text: string,
    values?: unknown[]
  ) => Promise<{ rows: R[] }>;
};

/** Quote a PostgreSQL identifier. The same rule the deploy routes use. */
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Which applications the target says it hosts (spec feature 11).
 *
 * `configured` is what the connection names: "reporting.application", or a
 * bare "application" which is read in the schema being deployed to. A name
 * with more than one dot is rejected rather than guessed at — a table called
 * "a.b.c" is a name this app does not know how to read, and picking two of
 * the three parts would send the query somewhere nobody asked for.
 *
 * Never throws. Every failure — no table named, the table missing, no
 * application_name column, no privilege to read it — comes back as
 * `known: false`, which checkApplications treats as "cannot confirm" and
 * refuses a restricted script on. Throwing would take down the whole
 * pre-flight, including for the unrestricted scripts this has no bearing on.
 */
export async function readApplications(
  client: Queryable,
  schemaName: string,
  configured: string | null
): Promise<TargetApplications> {
  const wanted = (configured ?? "").trim();
  if (wanted === "") return { known: false, names: [], source: null };

  const parts = wanted.split(".");
  if (parts.length > 2 || parts.some((part) => part.trim() === "")) {
    return { known: false, names: [], source: null };
  }
  const [schemaPart, tablePart] = parts.length === 2 ? parts : [schemaName, parts[0]];
  const quoted = `${quoteIdent(schemaPart.trim())}.${quoteIdent(tablePart.trim())}`;

  try {
    // Ask the catalog first, the same way the ledger check does: a SELECT
    // against a table that is not there fails the statement, and inside a
    // transaction that would poison every statement after it.
    const present = await client.query<{ reg: string | null }>(
      `SELECT to_regclass($1) AS reg`,
      [quoted]
    );
    if (!present.rows[0]?.reg) return { known: false, names: [], source: null };

    const rows = await client.query<{ application_name: string | null }>(
      applicationNamesSql(quoted)
    );
    return {
      known: true,
      names: rows.rows
        .map((row) => (row.application_name ?? "").trim())
        .filter((name) => name.length > 0),
      source: quoted,
    };
  } catch {
    return { known: false, names: [], source: null };
  }
}
