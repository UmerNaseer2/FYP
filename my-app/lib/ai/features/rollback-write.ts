// ---------------------------------------------------------------------------
// lib/ai/features/rollback-write.ts
// Write the rollback for SQL the person wrote, for Quick run on Deploy.
//
// The person's SQL is theirs and is never changed. The model is shown it and
// the schema as it is before the SQL runs, and writes only the statements that
// undo it. Then the code checks the rollback the way it checks the rollback of
// an AI-written script (sql-generate.ts):
//   - no transaction control, nothing that acts on the server, no table that
//     neither the schema nor the SQL has, no other schema named;
//   - then, when the caller's role may run scripts on this target, the SQL and
//     the rollback are tried on the database, one after the other, inside a
//     transaction that is always rolled back, and the schema must read the
//     same afterwards as before.
// A problem with the rollback goes back to the model to fix, twice at most.
//
// The person's own SQL is tried on its own first (tryScriptFirst), before any
// AI call: when it fails, no rollback can be checked, and the model cannot
// fix SQL it was told to leave alone. The route then says so plainly.
// Only structure goes in the prompt: no rows, no hosts, no database names.
// ---------------------------------------------------------------------------

import { z } from "zod";
import type { SchemaSnapshot } from "../../postgres";
import { hasExecutableSql } from "../../sql/guard";
import { bareName, checkGeneratedSql, knownNames, unknownTablesInSql } from "../checks";
import { mentionedObjects, schemaSlice } from "../context";
import { estimateTokens } from "../provider";
import type { AiTaskSpec } from "../run";
import { unknownTickedNames } from "./compare-summary";
import {
  backticksToQuotes,
  countStatements,
  createdBy,
  namesIn,
  refusedIn,
  sequenceCallIn,
  tidy,
  type TrialHook,
} from "./sql-generate";
import { MAX_ROLLBACK_SOURCE_CHARS, type RollbackWriteAnswer, type RollbackWriteChecks } from "./rollback-write-view";
import type { SqlTrial } from "./sql-generate-view";

export { MAX_ROLLBACK_SOURCE_CHARS };
const SCHEMA_TOKENS = 10_000;

export const rollbackWriteSchema = z.object({
  rollbackSql: z.string().max(20_000),
  summary: z.string().max(400),
  cannot: z.string().max(600),
});

export const ROLLBACK_WRITE_SYSTEM = [
  "You write the rollback for a PostgreSQL migration script a person wrote: the SQL that undoes it.",
  "SCHEMA is the schema as it is before THE SCRIPT runs. Use only its tables, columns and types, plus what THE SCRIPT creates. Do not put a schema name in front of any name: the app sets the search path to the schema shown.",
  "rollbackSql: the statements that undo THE SCRIPT, in reverse order, each ending with a semicolon. Put a short -- comment above each part saying what it undoes.",
  "summary: at most 40 words on what the rollback does, with every table, column and type name in backticks.",
  "cannot: what the rollback cannot put back, in one or two sentences, such as rows the script deletes or a column it drops with its data. Undo everything else. When nothing at all can be undone, leave rollbackSql empty. When everything can be undone, leave cannot empty.",
  "Rules for the rollback:",
  "- Never write BEGIN, COMMIT, ROLLBACK, SAVEPOINT or END for a transaction. The app runs the rollback as one transaction.",
  "- Undo only what THE SCRIPT does. Never drop or change anything in SCHEMA that THE SCRIPT does not change. When THE SCRIPT changes or drops something in SCHEMA, put it back as SCHEMA shows it.",
  "- Never act on the server rather than the schema: no roles, users, databases, tablespaces, extensions or other schemas, no ALTER SYSTEM, no SET or RESET, no COPY, VACUUM or CHECKPOINT, no pg_terminate_backend, pg_sleep, pg_read_file, set_config or dblink.",
  "- No DROP INDEX CONCURRENTLY or CREATE INDEX CONCURRENTLY: they cannot run inside a transaction.",
  "- No dynamic SQL: no EXECUTE of a built string in a DO block or a function.",
  "- No SECURITY DEFINER functions.",
  "- Never rewrite THE SCRIPT. Write only the rollback.",
].join("\n");

export type RollbackWriteFacts = {
  /** The person's SQL, as it will run. */
  sql: string;
  schemaName: string;
  snapshot: SchemaSnapshot;
  /** The try on the database, or why there is none. */
  trial: TrialHook | { notTried: string };
  /** Set by the check when an answer passes: the app's own reading, for the panel. */
  last: RollbackWriteChecks | null;
  /** Set by the check every time: the problems of the latest answer, for the failure message. */
  lastProblems: string[];
};

function notTried(reason: string): SqlTrial {
  return { status: "not-tried", reason };
}

/**
 * Why the person's SQL is not tried on the database, or null when it may be.
 * The app never asks the database to run what it would refuse from the AI, and
 * a sequence change is not undone when the try is rolled back.
 */
export function scriptTrialBlock(sql: string, schemaName: string, snapshot: SchemaSnapshot): string | null {
  const columns = new Set(snapshot.tables.flatMap((t) => t.columns.map((c) => c.name.toLowerCase())));
  const refused = refusedIn(sql, schemaName, columns);
  if (refused.length > 0) {
    return `Your SQL does something the app never tries on a database (${refused[0]}), so the rollback was checked but not tried.`;
  }
  const sequenceCall = sequenceCallIn(sql);
  if (sequenceCall) {
    return `Your SQL calls ${sequenceCall}. PostgreSQL does not undo a sequence change when a try is rolled back, so the rollback was checked but not tried.`;
  }
  return null;
}

export function buildRollbackWriteTask(options: {
  sql: string;
  schemaName: string;
  snapshot: SchemaSnapshot;
  /** The server's major version, when it could be read. */
  serverMajor: number | null;
  trial: TrialHook | { notTried: string };
}): { spec: AiTaskSpec<RollbackWriteAnswer>; facts: RollbackWriteFacts; inputTokens: number } {
  const sql = tidy(options.sql);
  const blocked = scriptTrialBlock(sql, options.schemaName, options.snapshot);
  const focus = mentionedObjects(options.snapshot, sql);
  const slice = schemaSlice(options.snapshot, { focus, maxTokens: SCHEMA_TOKENS });
  const version = options.serverMajor ? `PostgreSQL ${options.serverMajor}` : "PostgreSQL (version unknown)";
  const prompt = [
    "THE SCRIPT",
    sql,
    "",
    "THE DATABASE",
    `${version}. The script runs in schema ${options.schemaName}, with only that schema on the search path, as one transaction. The rollback runs the same way, after it.`,
    "",
    "SCHEMA (before the script runs)",
    slice.text,
  ].join("\n");

  const facts: RollbackWriteFacts = {
    sql,
    schemaName: options.schemaName,
    snapshot: options.snapshot,
    trial: blocked ? { notTried: blocked } : options.trial,
    last: null,
    lastProblems: [],
  };

  return {
    facts,
    inputTokens: estimateTokens(`${ROLLBACK_WRITE_SYSTEM}\n${prompt}`),
    spec: {
      // The same switch as writing a script: an organization that turns AI
      // writing off turns this off too.
      feature: "sql-generate",
      tier: "smart",
      system: ROLLBACK_WRITE_SYSTEM,
      prompt,
      schema: rollbackWriteSchema,
      // Never saved: the try on the database is part of the answer.
      cacheInput: null,
      maxOutputTokens: 1_500,
      repairs: 2,
      check: (value) => checkRollbackWrite(value, facts),
    },
  };
}

/**
 * Tries the person's SQL on its own, before the AI is asked. Returns why it
 * failed, or null when it ran (or could not be tried, which the check reports
 * on the answer instead).
 */
export async function tryScriptFirst(facts: RollbackWriteFacts): Promise<string | null> {
  if ("notTried" in facts.trial) return null;
  const outcome = await facts.trial(facts.sql, "");
  return outcome.status === "failed" ? outcome.message : null;
}

export async function checkRollbackWrite(
  answer: RollbackWriteAnswer,
  facts: RollbackWriteFacts
): Promise<{ value: RollbackWriteAnswer; problems: string[] }> {
  const value: RollbackWriteAnswer = {
    rollbackSql: backticksToQuotes(tidy(answer.rollbackSql)),
    summary: answer.summary.trim(),
    cannot: answer.cannot.trim(),
  };
  const finish = (problems: string[], checks: RollbackWriteChecks | null) => {
    facts.lastProblems = problems;
    facts.last = problems.length === 0 ? checks : null;
    return { value, problems };
  };

  if (!hasExecutableSql(value.rollbackSql)) {
    if (!value.cannot) return finish(["The answer has no rollback statement in it, and cannot says nothing."], null);
    value.rollbackSql = "";
    return finish([], { statements: 0, dataLoss: [], trial: notTried("There is no rollback to try.") });
  }

  const problems: string[] = [];
  // A rollback may delete what the script added: that is its job.
  const down = checkGeneratedSql(value.rollbackSql, { allowDataLoss: true });
  problems.push(...down.problems);
  const columns = new Set(facts.snapshot.tables.flatMap((t) => t.columns.map((c) => c.name.toLowerCase())));
  problems.push(...refusedIn(value.rollbackSql, facts.schemaName, columns));
  const unknown = unknownTablesInSql(value.rollbackSql, facts.snapshot, createdBy(facts.sql));
  if (unknown.length > 0) {
    problems.push(`The rollback uses tables neither the schema nor the script has: ${unknown.join(", ")}.`);
  }

  const known = knownNames(facts.snapshot);
  const names = new Set([...namesIn(facts.sql), ...namesIn(value.rollbackSql)]);
  const summaryUnknown = unknownTickedNames(value.summary, known, (name) => {
    const parts = name.replace(/"/g, "").split(".");
    if (parts.length >= 3 && !known.has(`schema:${parts[0].trim().toLowerCase()}`)) return false;
    return bareName(name)
      .split(".")
      .every((part) => names.has(part));
  });
  if (summaryUnknown.length > 0) {
    problems.push(`The summary names things that are neither in the schema nor in the script: ${summaryUnknown.join(", ")}.`);
  }

  if (problems.length > 0) return finish(problems, null);

  let trial: SqlTrial;
  const sequenceCall = sequenceCallIn(value.rollbackSql);
  if ("notTried" in facts.trial) {
    trial = notTried(facts.trial.notTried);
  } else if (sequenceCall) {
    trial = notTried(
      `The rollback calls ${sequenceCall}. PostgreSQL does not undo a sequence change when the try is rolled back, so the app did not try it on the database.`
    );
  } else {
    const outcome = await facts.trial(facts.sql, value.rollbackSql);
    if (outcome.status === "failed" && outcome.step === "rollback") {
      return finish([`The script ran, but the rollback failed after it: ${outcome.message}`], null);
    }
    if (outcome.status === "failed") {
      // The person's SQL failed this time (it passed tryScriptFirst). The
      // model cannot fix that, so the rollback is kept, untried.
      trial = notTried(`Your SQL failed when it was tried again, so the rollback could not be tried after it: ${outcome.message}`);
    } else {
      trial = outcome.status === "passed" ? { status: "passed", rollbackTried: true } : notTried(outcome.reason);
    }
  }

  return finish([], {
    statements: countStatements(value.rollbackSql),
    dataLoss: (down.risk?.dataLoss ?? []).flatMap((d) => d.kinds),
    trial,
  });
}
