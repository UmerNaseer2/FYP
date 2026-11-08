"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Button, Card, Pill } from "@/components/ui";
import { AlertCircleIcon, CheckIcon, RefreshIcon } from "@/components/ui/icons";
import { useUser } from "@/hooks/useUser";
import { apiFetch } from "@/lib/api-fetch";
import { errorFrom, jsonOf } from "@/lib/api-answer";
import type { AiFeature } from "@/lib/ai/prompts";
import { isAiAnswerBody, isAiStatusView, type AiAnswerMeta, type AiStatusView } from "@/lib/ai/views";

/**
 * The AI card the Compare, Deploy, Drift and Script Editor screens share.
 *
 * It draws nothing for someone without "Use AI assistance", or where AI is not
 * set up or is switched off for the feature. Otherwise it offers one button,
 * waits (a free AI plan can take most of a minute), and shows the answer with
 * a line saying the app checked it, plus a thumbs up or down for the Admin's
 * usage figures.
 *
 * The screen owns the question (`ask`, which calls its route) and how an
 * answer looks (`children`). The answer is only ever an explanation: every
 * fact in it has already been checked against the engine by the route.
 */

let statusRequest: Promise<AiStatusView | null> | null = null;

/** /api/ai/status once per page load, shared by every panel on it. */
function loadStatus(): Promise<AiStatusView | null> {
  statusRequest ??= (async () => {
    try {
      const response = await apiFetch("/api/ai/status", { cache: "no-store" });
      const body = await jsonOf(response);
      return response.ok && isAiStatusView(body) ? body : null;
    } catch {
      return null;
    }
  })();
  return statusRequest;
}

/** Forget the cached status, for the tests and after an Admin change. */
export function resetAiStatus() {
  statusRequest = null;
}

/** Whether this person can use one AI feature here. Null while unknown. */
export function useAiFeature(feature: AiFeature): boolean | null {
  const { can, loading } = useUser();
  const allowed = !loading && can("ai:read");
  const [status, setStatus] = useState<AiStatusView | null | undefined>(undefined);
  useEffect(() => {
    if (!allowed) return;
    let current = true;
    void loadStatus().then((found) => {
      if (current) setStatus(found);
    });
    return () => {
      current = false;
    };
  }, [allowed]);
  if (loading) return null;
  if (!allowed) return false;
  if (status === undefined) return null;
  return Boolean(status && status.configured && status.enabled && status.features[feature]);
}

export type AiAsk = () => Promise<Response>;

type State<T> =
  | { kind: "idle" }
  | { kind: "asking" }
  | { kind: "answer"; answer: T; meta: AiAnswerMeta; extra: Record<string, unknown> }
  | { kind: "error"; message: string };

export function AiPanel<T>({
  feature,
  title,
  blurb,
  askLabel,
  ask,
  isAnswer,
  children,
  resetKey,
  input,
  askDisabled = false,
}: {
  feature: AiFeature;
  title: string;
  /** One line under the title before anything is asked. */
  blurb: string;
  askLabel: string;
  ask: AiAsk;
  /** Checks the answer's shape on the way in. */
  isAnswer: (value: unknown) => value is T;
  /** Draws the answer. `extra` holds whatever the route sent beside it (for Compare, what each change id means). */
  children: (answer: T, extra: Record<string, unknown>) => ReactNode;
  /** When this changes (another comparison, another script), the answer is cleared. */
  resetKey?: string;
  /** What the person fills in before asking (Script Editor: what the script should do). Shown unless an answer is on its way. */
  input?: ReactNode;
  /** True while the input is not ready to ask with. */
  askDisabled?: boolean;
}) {
  const usable = useAiFeature(feature);
  const [state, setState] = useState<State<T>>({ kind: "idle" });
  const [rated, setRated] = useState<1 | -1 | null>(null);

  const [seenKey, setSeenKey] = useState(resetKey);
  if (seenKey !== resetKey) {
    setSeenKey(resetKey);
    setState({ kind: "idle" });
    setRated(null);
  }

  if (!usable) return null;

  async function run() {
    setState({ kind: "asking" });
    setRated(null);
    try {
      const response = await ask();
      const body = await jsonOf(response);
      if (!response.ok || !isAiAnswerBody(body) || !isAnswer(body.answer)) {
        setState({ kind: "error", message: errorFrom(body) ?? "The AI answer could not be read." });
        return;
      }
      const { answer, meta, ...extra } = body as typeof body & Record<string, unknown>;
      setState({ kind: "answer", answer: answer as T, meta, extra });
    } catch {
      setState({ kind: "error", message: "Network error while asking the AI." });
    }
  }

  async function rate(rating: 1 | -1) {
    if (state.kind !== "answer" || state.meta.callId === null) return;
    setRated(rating);
    try {
      await apiFetch("/api/ai/rate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ callId: state.meta.callId, rating }),
      });
    } catch {
      // A lost thumbs is not worth an error on screen.
    }
  }

  return (
    <Card className="ai-panel p-4 sm:p-5" aria-live="polite">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="section-title flex items-center gap-2">
            {title}
            <Pill tone="brand">AI</Pill>
          </h3>
          {state.kind === "idle" && (
            <p className="text-[13px] mt-1 max-w-[62ch]" style={{ color: "var(--text-2)" }}>
              {blurb}
            </p>
          )}
        </div>
        {state.kind !== "asking" && (
          <Button
            size="sm"
            variant={state.kind === "idle" ? "secondary" : "ghost"}
            disabled={askDisabled}
            onClick={() => void run()}
          >
            {state.kind === "idle" ? (
              askLabel
            ) : (
              <>
                <RefreshIcon size={13} /> Ask again
              </>
            )}
          </Button>
        )}
      </div>

      {input !== undefined && state.kind !== "asking" && <div className="mt-3">{input}</div>}

      {state.kind === "asking" && (
        <p className="text-[13px] mt-3" style={{ color: "var(--text-2)" }} role="status">
          Asking the AI. On the free plan this can take up to a minute.
        </p>
      )}

      {state.kind === "error" && (
        <div className="role-note mt-3" role="alert">
          <AlertCircleIcon size={15} className="ico" />
          <div>
            <div className="title">No AI answer</div>
            <div className="body">{state.message}</div>
          </div>
        </div>
      )}

      {state.kind === "answer" && (
        <>
          <div className="mt-3">{children(state.answer, state.extra)}</div>
          <div
            className="mt-4 pt-3 flex flex-wrap items-center justify-between gap-2 text-[12px]"
            style={{ borderTop: "1px solid var(--border)", color: "var(--text-3)" }}
          >
            <span className="flex items-center gap-1.5">
              <CheckIcon size={13} />
              {state.meta.saved
                ? "Checked by the app. A saved answer for the same question, so no AI call was made."
                : `Checked by the app against its own engine. ${state.meta.model}, ${(state.meta.ms / 1000).toFixed(1)} s.`}
            </span>
            {state.meta.callId !== null && (
              <span className="flex items-center gap-1">
                <span>Helpful?</span>
                <button
                  type="button"
                  className="btn btn-ghost px-2 py-0.5"
                  aria-pressed={rated === 1}
                  onClick={() => void rate(1)}
                >
                  Yes
                </button>
                <button
                  type="button"
                  className="btn btn-ghost px-2 py-0.5"
                  aria-pressed={rated === -1}
                  onClick={() => void rate(-1)}
                >
                  No
                </button>
              </span>
            )}
          </div>
        </>
      )}
    </Card>
  );
}
