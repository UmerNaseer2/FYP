// SERVER-ONLY: import this file from API routes and other server code only.
//
// The AI usage log (ai_calls) and the saved answers (ai_results).
//
// A usage row never holds the prompt or the answer, only counts: which
// feature, which model, tokens, time and how it ended. The saved answers do
// hold answers, keyed by a hash of what was asked, so the same question about
// the same schemas is not paid for twice. They are kept for a week.
import { createHash } from "node:crypto";
import pool, { syncMetadataTables } from "../version-db";
import type { AI_CALL_OUTCOMES } from "../db/models";
import { AI_FEATURES, type AiFeature } from "./prompts";

export type AiOutcome = (typeof AI_CALL_OUTCOMES)[number];

export type AiCallRecord = {
  orgId: number;
  actor: string;
  feature: AiFeature;
  provider: string;
  model: string;
  promptVersion: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  estimated: boolean;
  ms: number;
  retries: number;
  outcome: AiOutcome;
  cacheHit: boolean;
};

/** Write one usage row. Returns its id, so the person can rate the answer. */
export async function recordAiCall(record: AiCallRecord): Promise<number | null> {
  try {
    await syncMetadataTables();
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO ai_calls (org_id, actor, feature, provider, model, prompt_version, input_tokens,
                             output_tokens, cached_tokens, estimated, ms, retries, outcome, cache_hit)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       RETURNING id`,
      [
        record.orgId,
        record.actor,
        record.feature,
        record.provider,
        record.model,
        record.promptVersion,
        Math.round(record.inputTokens),
        Math.round(record.outputTokens),
        Math.round(record.cachedTokens),
        record.estimated,
        Math.round(record.ms),
        record.retries,
        record.outcome,
        record.cacheHit,
      ]
    );
    return rows[0]?.id ?? null;
  } catch (error) {
    // Counting must never stop an answer reaching the person.
    console.error("[ai] could not record a usage row:", error instanceof Error ? error.message : error);
    return null;
  }
}

/** Calls that reached the AI service today (UTC) for one organization. Saved answers do not count. */
export async function callsToday(orgId: number): Promise<number> {
  await syncMetadataTables();
  const { rows } = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM ai_calls
      WHERE org_id = $1 AND NOT cache_hit AND outcome <> 'limit_reached'
        AND created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`,
    [orgId]
  );
  return rows[0]?.n ?? 0;
}

/** Calls one person made in the last minute, saved answers left out. */
export async function callsLastMinute(orgId: number, actor: string): Promise<number> {
  await syncMetadataTables();
  const { rows } = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM ai_calls
      WHERE org_id = $1 AND lower(actor) = lower($2) AND NOT cache_hit AND outcome <> 'limit_reached'
        AND created_at >= now() - interval '1 minute'`,
    [orgId, actor]
  );
  return rows[0]?.n ?? 0;
}

/** A stable hash of what was asked: the feature, its prompt version and the input. */
export function cacheKey(feature: AiFeature, promptVersion: number, input: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify({ feature, promptVersion, input }))
    .digest("hex");
}

const CACHE_DAYS = 7;

export async function readSavedAnswer<T>(
  orgId: number,
  feature: AiFeature,
  key: string
): Promise<{ answer: T; model: string } | null> {
  await syncMetadataTables();
  const { rows } = await pool.query<{ answer: T; model: string }>(
    `SELECT answer, model FROM ai_results
      WHERE org_id = $1 AND feature = $2 AND cache_key = $3
        AND created_at >= now() - make_interval(days => $4)`,
    [orgId, feature, key, CACHE_DAYS]
  );
  return rows[0] ?? null;
}

export async function saveAnswer(orgId: number, feature: AiFeature, key: string, model: string, answer: unknown) {
  try {
    await syncMetadataTables();
    await pool.query(
      `INSERT INTO ai_results (org_id, feature, cache_key, model, answer)
       VALUES ($1, $2, $3, $4, $5::jsonb)
       ON CONFLICT (org_id, feature, cache_key) DO UPDATE
         SET model = EXCLUDED.model, answer = EXCLUDED.answer, created_at = now()`,
      [orgId, feature, key, model, JSON.stringify(answer)]
    );
    await pool.query(
      `DELETE FROM ai_results WHERE org_id = $1 AND created_at < now() - make_interval(days => $2)`,
      [orgId, CACHE_DAYS]
    );
  } catch (error) {
    console.error("[ai] could not save an answer:", error instanceof Error ? error.message : error);
  }
}

/** A thumbs up or down from the person who asked. Only their own calls. */
export async function rateAiCall(orgId: number, actor: string, callId: number, rating: 1 | -1): Promise<boolean> {
  await syncMetadataTables();
  const { rowCount } = await pool.query(
    `UPDATE ai_calls SET rating = $4 WHERE id = $3 AND org_id = $1 AND lower(actor) = lower($2)`,
    [orgId, actor, callId, rating]
  );
  return (rowCount ?? 0) > 0;
}

export type FeatureUsage = {
  feature: AiFeature;
  calls: number;
  savedAnswers: number;
  ok: number;
  failed: number;
  inputTokens: number;
  outputTokens: number;
  medianMs: number | null;
  p95Ms: number | null;
  thumbsUp: number;
  thumbsDown: number;
};

export type AiUsage = {
  days: number;
  today: number;
  features: FeatureUsage[];
  totals: { calls: number; inputTokens: number; outputTokens: number };
};

/** The Admin screen's usage card: the last `days` days, by feature. */
export async function readAiUsage(orgId: number, days = 30): Promise<AiUsage> {
  await syncMetadataTables();
  const { rows } = await pool.query<{
    feature: string;
    calls: number;
    saved: number;
    ok: number;
    failed: number;
    input_tokens: number;
    output_tokens: number;
    median_ms: number | null;
    p95_ms: number | null;
    up: number;
    down: number;
  }>(
    `SELECT feature,
            (count(*) FILTER (WHERE NOT cache_hit AND outcome <> 'limit_reached'))::int AS calls,
            (count(*) FILTER (WHERE cache_hit))::int AS saved,
            (count(*) FILTER (WHERE outcome = 'ok'))::int AS ok,
            (count(*) FILTER (WHERE outcome NOT IN ('ok', 'limit_reached')))::int AS failed,
            coalesce(sum(input_tokens), 0)::int AS input_tokens,
            coalesce(sum(output_tokens), 0)::int AS output_tokens,
            (percentile_cont(0.5) WITHIN GROUP (ORDER BY ms) FILTER (WHERE NOT cache_hit))::int AS median_ms,
            (percentile_cont(0.95) WITHIN GROUP (ORDER BY ms) FILTER (WHERE NOT cache_hit))::int AS p95_ms,
            (count(*) FILTER (WHERE rating = 1))::int AS up,
            (count(*) FILTER (WHERE rating = -1))::int AS down
       FROM ai_calls
      WHERE org_id = $1 AND created_at >= now() - make_interval(days => $2)
      GROUP BY feature`,
    [orgId, days]
  );
  const byFeature = new Map(rows.map((row) => [row.feature, row]));
  const features = AI_FEATURES.map((feature): FeatureUsage => {
    const row = byFeature.get(feature);
    return {
      feature,
      calls: row?.calls ?? 0,
      savedAnswers: row?.saved ?? 0,
      ok: row?.ok ?? 0,
      failed: row?.failed ?? 0,
      inputTokens: row?.input_tokens ?? 0,
      outputTokens: row?.output_tokens ?? 0,
      medianMs: row?.median_ms ?? null,
      p95Ms: row?.p95_ms ?? null,
      thumbsUp: row?.up ?? 0,
      thumbsDown: row?.down ?? 0,
    };
  });
  return {
    days,
    today: await callsToday(orgId),
    features,
    totals: {
      calls: features.reduce((n, f) => n + f.calls, 0),
      inputTokens: features.reduce((n, f) => n + f.inputTokens, 0),
      outputTokens: features.reduce((n, f) => n + f.outputTokens, 0),
    },
  };
}
