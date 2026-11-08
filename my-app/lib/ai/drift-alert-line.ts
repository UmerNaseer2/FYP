// ---------------------------------------------------------------------------
// lib/ai/drift-alert-line.ts
// The AI's one line on a new drift, for the phone and desktop alerts.
//
// Only the scheduler asks: a person who presses Check now is looking at the
// answer already. The line is a nice-to-have, so every failure (AI off for the
// organization, no key, over the limits, slow, a wrong answer) is a null and
// the alert goes out as it always did. The plan sets a hard 4 second wait, so
// a slow service never holds up the rest of a tick, and when the wait is up
// the AI task is stopped: no repair request, no late call to the service.
// ---------------------------------------------------------------------------

import type { CompareReport } from "../compare-types";
import { alertLine, buildDriftOneLinerTask } from "./features/drift-explain";
import { runAiTask, type AiDeps } from "./run";

/** How long the service gets for one answer. Never more than the whole wait. */
export const ALERT_LINE_TIMEOUT_MS = 4_000;
/** The plan's hard wait for the line, retry and bookkeeping included. */
export const ALERT_LINE_WAIT_MS = 4_000;
/** Who the AI call log says asked: no person did. */
export const SCHEDULED_ACTOR = "scheduled drift check";

/** The alert line for a drift the scheduler found, or null. `driftReport` is the check's own comparison. */
export async function driftAlertLine(
  orgId: number,
  driftReport: CompareReport,
  /** Left out, the organization's own AI settings are read (aiDepsFor). Tests pass their own. */
  deps?: AiDeps
): Promise<string | null> {
  // Aborted when the wait is up (and in any case once the wait is over), so
  // the AI task that lost the race stops instead of going on in the background.
  const stop = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const task = buildDriftOneLinerTask(driftReport);
    if (!task) return null;
    const answer = runAiTask(
      { orgId, email: SCHEDULED_ACTOR },
      { ...task.spec, timeoutMs: ALERT_LINE_TIMEOUT_MS, signal: stop.signal },
      deps
    )
      .then((result) => (result.kind === "ok" ? alertLine(result.value.line) : null))
      // A task that fails after the wait is up has nobody left to tell, and an
      // uncaught rejection there could stop the whole server process.
      .catch((error: unknown) => {
        if (!stop.signal.aborted) console.error("AI: the drift alert line failed:", error);
        return null;
      });
    const giveUp = new Promise<null>((resolve) => {
      timer = setTimeout(() => {
        stop.abort();
        resolve(null);
      }, ALERT_LINE_WAIT_MS);
      timer.unref?.();
    });
    return await Promise.race([answer, giveUp]);
  } catch (error) {
    console.error("AI: the drift alert line failed:", error);
    return null;
  } finally {
    if (timer) clearTimeout(timer);
    stop.abort();
  }
}
