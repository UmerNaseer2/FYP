// ---------------------------------------------------------------------------
// lib/ai/prompts/index.ts
// The version stamp of every prompt. A cached answer is keyed on it, so
// changing a prompt's wording means bumping its number here and old answers
// stop being served.
// ---------------------------------------------------------------------------

export const PROMPT_VERSIONS = {
  "compare-summary": 2,
  "migration-review": 2,
  "drift-explain": 2,
  "drift-oneliner": 2,
  "sql-generate": 3,
  "schema-chat": 2,
} as const;

export type AiFeature = keyof typeof PROMPT_VERSIONS;

export const AI_FEATURES = Object.keys(PROMPT_VERSIONS) as AiFeature[];

/** What each feature is called on the Admin screen. */
export const FEATURE_LABELS: Record<AiFeature, string> = {
  "compare-summary": "Compare change summary",
  "migration-review": "Migration review before deploy",
  "drift-explain": "Explain drift",
  "drift-oneliner": "One line in drift alerts",
  "sql-generate": "Write SQL from plain words",
  "schema-chat": "Schema chat",
};

/** Lines every system prompt starts with. */
export const SHARED_RULES = [
  "You help people who manage PostgreSQL schemas in an app called Schema Studio.",
  "Write in plain, short sentences a junior developer can follow. No marketing words.",
  "Only name tables, columns, views, types and functions that appear in the schema text you are given. If something is not there, say you cannot see it.",
  "The app has already worked out facts such as change levels and risks. Treat them as true and explain them; never contradict them.",
  "Never invent row counts, data values, hostnames or people.",
].join("\n");
