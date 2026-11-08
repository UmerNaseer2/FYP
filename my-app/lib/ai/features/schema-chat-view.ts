// Schema chat, as the chat drawer gets it. No imports that reach a database or
// the AI service, so the drawer can use the types and the shape check.

/** One turn of the conversation the drawer sends back with the next question. */
export type ChatTurn = { role: "user" | "assistant"; text: string };

export type ChatAnswer = {
  /** The answer, names in backticks. SQL drafts are taken out into `sql`. */
  text: string;
  /** A draft the AI wrote, never run. Null when it wrote none, or the app refused it. */
  sql: string | null;
  /** Why the app refused the draft. Empty when there was no draft or it passed. */
  sqlProblems: string[];
  /** Backticked names the app could not find in anything the lookups returned. */
  unverifiedNames: string[];
  /** Which lookups the AI made, in order, and whether each worked. */
  toolsUsed: { name: string; ok: boolean }[];
  /** The connection and schema the last lookup was about, for "Open in the Script Editor". */
  target: { connectionId: number; schema: string } | null;
};

/** Kept in step with the limits in lib/ai/chat.ts. */
export const MAX_QUESTION_CHARS = 2_000;
export const MAX_HISTORY_TURNS = 8;

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

export function isChatAnswer(value: unknown): value is ChatAnswer {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.text !== "string") return false;
  if (v.sql !== null && typeof v.sql !== "string") return false;
  if (!isStringArray(v.sqlProblems) || !isStringArray(v.unverifiedNames)) return false;
  if (!Array.isArray(v.toolsUsed)) return false;
  for (const tool of v.toolsUsed) {
    if (typeof tool !== "object" || tool === null) return false;
    const t = tool as Record<string, unknown>;
    if (typeof t.name !== "string" || typeof t.ok !== "boolean") return false;
  }
  if (v.target !== null) {
    if (typeof v.target !== "object") return false;
    const t = v.target as Record<string, unknown>;
    if (typeof t.connectionId !== "number" || typeof t.schema !== "string") return false;
  }
  return true;
}
