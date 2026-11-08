// ---------------------------------------------------------------------------
// lib/ai/drift-alert-line.ts
// The AI's one line on a new drift, for the phone and desktop alerts.
//
// Only the scheduler asks: a person who presses Check now is looking at the
// answer already. The line is a nice-to-have, so every failure (AI off for the
// organization, no key, over the limits, slow, a wrong answer) is a null and
// the alert goes out as it always did. The wait is capped so a slow service
// never holds up the rest of a tick.
// ---------------------------------------------------------------------------

import type { CompareReport } from "../compare-types";
import { alertLine, buildDriftOneLinerTask } from "./features/drift-explain";
import { defaultAiDeps, runAiTask, type AiDeps } from "./run";

/** How long the service gets for one answer. */
export const ALERT_LINE_TIMEOUT_MS = 8_000;
/** How long the check waits for the line, retry and bookkeeping included. */
export const ALERT_LINE_WAIT_MS = 10_000;
/** Who the AI call log says asked: no person did. */
export const SCHEDULED_ACTOR = "scheduled drift check";

/** The alert line for a drift the scheduler found, or null. `driftReport` is the check's own comparison. */
export async function driftAlertLine(
  orgId: number,
  driftReport: CompareReport,
  deps: AiDeps = defaultAiDeps()
): Promise<string | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const task = buildDriftOneLinerTask(driftReport);
    if (!task) return null;
    const answer = runAiTask(
      { orgId, email: SCHEDULED_ACTOR },
      { ...task.spec, timeoutMs: ALERT_LINE_TIMEOUT_MS },
      deps
    ).then((result) => (result.kind === "ok" ? alertLine(result.value.line) : null));
    const giveUp = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), ALERT_LINE_WAIT_MS);
      timer.unref?.();
    });
    return await Promise.race([answer, giveUp]);
  } catch (error) {
    console.error("AI — the drift alert line failed:", error);
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
