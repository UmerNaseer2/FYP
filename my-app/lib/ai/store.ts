// SERVER-ONLY: import this file from API routes and other server code only.
//
// The AI usage log (ai_calls) and the saved answers (ai_results).
//
// A usage row never holds the prompt or the answer, only counts: which
// feature, which model, tokens, time and how it ended. The saved answers do
// hold answers, keyed by a hash of what was asked, so the same question about
// the same schemas is not paid for twice. They are kept for a week.
//
// Old rows are cleared out at most once an hour (pruneOldAiRows): usage rows
// after 90 days, saved answers once they are past their week.
import { createHash } from "node:crypto";
import pool, { syncMetadataTables } from "../version-db";
import type { AI_CALL_OUTCOMES } from "../db/models";
import { AI_FEATURES, type AiFeature } from "./prompts";

export type AiOutcome = (typeof AI_CALL_OUTCOMES)[number];

/** How long a saved answer is served. */
export const CACHE_DAYS = 7;

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
    await pruneOldAiRows();
    return rows[0]?.id ?? null;
  } catch (error) {
    // Counting must never stop an answer reaching the person.
    console.error("[ai] could not record a usage row:", error instanceof Error ? error.message : error);
    return null;
  }
}

/** Who is making one call and to which model, before anything is known about how it went. */
export type AiCallStart = Pick<AiCallRecord, "orgId" | "actor" | "feature" | "provider" | "model" | "promptVersion">;

/** How one call went, written over its reserved row when it ends. */
export type AiCallEnd = Pick<
  AiCallRecord,
  "model" | "inputTokens" | "outputTokens" | "cachedTokens" | "estimated" | "ms" | "retries" | "outcome"
>;

export type AiCallLimits = { dailyLimit: number; perMinuteLimit: number };

export type AiReservation = { kind: "reserved"; id: number } | { kind: "limited"; which: "daily" | "per-minute" };

/**
 * Check the limits and count one call against them in the same step, before
 * the call is sent.
 *
 * Counting rows only after a call ended let ten browser tabs (or a slow
 * model) send far more calls than the limits allow, because nothing in
 * flight was counted. So the row is written first, as a reservation, and
 * finishAiCall fills it in when the call ends. A row that is never finished
 * (the server stopped mid call) stays as a failed call, which is what it was.
 *
 * The check and the write happen under a lock per organization, so two
 * requests cannot both see "9 of 10" and both go ahead. The lock is the two
 * number kind, which never clashes with the one number locks used elsewhere,
 * and it is released when the transaction ends, so it works through a
 * transaction pooler too. The count is its own statement after the lock:
 * each statement sees the rows committed before it started.
 *
 * Throws when the database cannot be reached: a limit that cannot be checked
 * must not let the call through.
 */
export async function reserveAiCall(call: AiCallStart, limits: AiCallLimits): Promise<AiReservation> {
  await syncMetadataTables();
  const client = await pool.connect();
  let reservation: AiReservation;
  try {
    await client.query("BEGIN");
    // Waiting longer than this means something is stuck; fail instead.
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('ai_calls'), $1::int)", [call.orgId]);
    const { rows } = await client.query<{ today: number; last_minute: number }>(
      `SELECT (count(*) FILTER (WHERE created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'))::int AS today,
              (count(*) FILTER (WHERE lower(actor) = lower($2) AND created_at >= now() - interval '1 minute'))::int AS last_minute
         FROM ai_calls
        WHERE org_id = $1 AND NOT cache_hit AND outcome <> 'limit_reached'
          AND created_at >= least(date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC', now() - interval '1 minute')`,
      [call.orgId, call.actor]
    );
    const today = rows[0]?.today ?? 0;
    const lastMinute = rows[0]?.last_minute ?? 0;
    if (today >= limits.dailyLimit || lastMinute >= limits.perMinuteLimit) {
      await client.query("ROLLBACK");
      return { kind: "limited", which: today >= limits.dailyLimit ? "daily" : "per-minute" };
    }
    // Written as a failed call with nothing used, until finishAiCall says otherwise.
    const inserted = await client.query<{ id: number }>(
      `INSERT INTO ai_calls (org_id, actor, feature, provider, model, prompt_version, input_tokens,
                             output_tokens, cached_tokens, estimated, ms, retries, outcome, cache_hit)
       VALUES ($1, $2, $3, $4, $5, $6, 0, 0, 0, false, 0, 0, 'provider_error', false)
       RETURNING id`,
      [call.orgId, call.actor, call.feature, call.provider, call.model, call.promptVersion]
    );
    await client.query("COMMIT");
    reservation = { kind: "reserved", id: inserted.rows[0].id };
  } catch (error) {
    // The ROLLBACK can fail too (the connection may be what broke), and the
    // error worth reporting is the first one.
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
  await pruneOldAiRows();
  return reservation;
}

/** Fill in a reserved row once its call has ended. False when it could not be written. */
export async function finishAiCall(id: number, end: AiCallEnd): Promise<boolean> {
  try {
    await syncMetadataTables();
    const { rowCount } = await pool.query(
      `UPDATE ai_calls
          SET model = $2, input_tokens = $3, output_tokens = $4, cached_tokens = $5,
              estimated = $6, ms = $7, retries = $8, outcome = $9
        WHERE id = $1`,
      [
        id,
        end.model,
        Math.round(end.inputTokens),
        Math.round(end.outputTokens),
        Math.round(end.cachedTokens),
        end.estimated,
        Math.round(end.ms),
        end.retries,
        end.outcome,
      ]
    );
    return (rowCount ?? 0) > 0;
  } catch (error) {
    // As with recordAiCall: the count must never stop an answer reaching the person.
    console.error("[ai] could not finish a usage row:", error instanceof Error ? error.message : error);
    return false;
  }
}

/**
 * How long usage rows are kept. The Admin usage card reads the last 30 days;
 * 90 leaves room to look back over a whole term (and the benchmark write-up)
 * while keeping the table from growing forever.
 */
export const AI_CALLS_KEEP_DAYS = 90;

const HOUR_MS = 60 * 60 * 1000;
let lastPruneAt = 0;

/**
 * Delete usage rows older than AI_CALLS_KEEP_DAYS and saved answers past
 * their week, for every organization. Runs at most once an hour in each
 * server process (it is called on every write, and the rest of the time it
 * does nothing). True when it ran. Never throws: clearing out is not worth
 * failing an answer for.
 */
export async function pruneOldAiRows(now: number = Date.now()): Promise<boolean> {
  if (now - lastPruneAt < HOUR_MS) return false;
  lastPruneAt = now;
  try {
    await pool.query(`DELETE FROM ai_calls WHERE created_at < now() - make_interval(days => $1)`, [AI_CALLS_KEEP_DAYS]);
    await pool.query(`DELETE FROM ai_results WHERE created_at < now() - make_interval(days => $1)`, [CACHE_DAYS]);
    return true;
  } catch (error) {
    console.error("[ai] could not clear out old AI rows:", error instanceof Error ? error.message : error);
    return false;
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

/**
 * A stable hash of what was asked: the feature, its prompt version, the input
 * and, when given, the model (with its service). With the model in the key, a
 * change of model or service asks the new one instead of serving the old
 * one's answers for a week.
 */
export function cacheKey(feature: AiFeature, promptVersion: number, input: unknown, model?: string): string {
  const asked = model === undefined ? { feature, promptVersion, input } : { feature, promptVersion, model, input };
  return createHash("sha256").update(JSON.stringify(asked)).digest("hex");
}

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
    // Answers past their week are cleared out by pruneOldAiRows, at most once an hour.
    await pruneOldAiRows();
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
            (percentile_cont(0.5) WITHIN GROUP (ORDER BY ms)
               FILTER (WHERE NOT cache_hit AND outcome <> 'limit_reached'))::int AS median_ms,
            (percentile_cont(0.95) WITHIN GROUP (ORDER BY ms)
               FILTER (WHERE NOT cache_hit AND outcome <> 'limit_reached'))::int AS p95_ms,
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
