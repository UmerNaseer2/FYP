/**
 * The questions the site may put to a linked computer, and the answers it keeps.
 *
 * Two questions, both read-only, and nothing here can name another. A computer
 * refuses any other method too (desktop/src/main/cloud-agent.ts), so a mistake on
 * one side does not make a linked computer do more.
 *
 * Answers are copied, key by key, rather than stored as they came. That is what
 * keeps "no SQL, no hosts, no rows" true on this side: anything a computer sent
 * beyond these fields has nowhere to go.
 *
 * No database in here, so it can be tested without one.
 */
import {
  MAX_SCHEMA_NAME_LENGTH,
  readCompareSummary,
  readPhoneCompareRequest,
  type PhoneCompareRequest,
} from "./phone-compare";

export type AgentJob =
  | { method: "schemas.list"; params: { connectionId: number } }
  | { method: "compare.run"; params: PhoneCompareRequest };

const MOST_SCHEMAS = 2000;

const NOT_A_JOB = "Ask for the schemas on a connection, or for one comparison.";
const ONE_TARGET = "Compare one target at a time.";

/** Read what a person asked a computer to do, refusing anything else. */
export function readAgentJob(method: unknown, params: unknown): { ok: true; job: AgentJob } | { ok: false; error: string } {
  if (method === "schemas.list") {
    const connectionId = (params as { connectionId?: unknown } | null)?.connectionId;
    if (typeof connectionId !== "number" || !Number.isSafeInteger(connectionId) || connectionId < 1) {
      return { ok: false, error: NOT_A_JOB };
    }
    return { ok: true, job: { method, params: { connectionId } } };
  }
  if (method === "compare.run") {
    const read = readPhoneCompareRequest(params);
    if (!read.ok) return read;
    // One at a time, so an answer always fits (MAX_ANSWER_BYTES in lib/agent-rules.ts).
    if (read.data.targets.length !== 1) return { ok: false, error: ONE_TARGET };
    return { ok: true, job: { method, params: read.data } };
  }
  return { ok: false, error: NOT_A_JOB };
}

/** Every connection a job names, to check each is one the computer shares. */
export function connectionsIn(job: AgentJob): number[] {
  if (job.method === "schemas.list") return [job.params.connectionId];
  return [job.params.source, ...job.params.targets].map((ref) => ref.connectionId);
}

/** A clean copy of a computer's answer to this kind of question, or null if it is not one. */
export function readAgentAnswer(method: string, value: unknown): unknown {
  if (method === "compare.run") return readCompareSummary(value);
  if (method === "schemas.list") return readSchemaList(value);
  return null;
}

function readSchemaList(value: unknown): { schemas: string[] } | null {
  const schemas = (value as { schemas?: unknown } | null)?.schemas;
  if (!Array.isArray(schemas) || schemas.length > MOST_SCHEMAS) return null;
  const fits = schemas.every(
    (name) => typeof name === "string" && name.length >= 1 && name.length <= MAX_SCHEMA_NAME_LENGTH
  );
  return fits ? { schemas } : null;
}
