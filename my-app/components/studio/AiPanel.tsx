"use client";

import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Button, Card, Pill } from "@/components/ui";
import { AlertCircleIcon, CheckIcon, RefreshIcon } from "@/components/ui/icons";
import { useOrg } from "@/hooks/useOrg";
import { useUser } from "@/hooks/useUser";
import { apiFetch } from "@/lib/api-fetch";
import { errorFrom, jsonOf } from "@/lib/api-answer";
import { orgSlugFromPath } from "@/lib/org-slug";
import { refusalMessage } from "@/lib/permissions";
import { FEATURE_LABELS, type AiFeature } from "@/lib/ai/prompts";
import { isAiAnswerBody, isAiStatusView, type AiAnswerMeta, type AiStatusView } from "@/lib/ai/views";
import { AskAdmin } from "./AskAdmin";

/**
 * The AI card the Compare, Deploy, Drift and Script Editor screens share.
 *
 * Where AI is off for this person (their role can't use it, it is not set up,
 * or an Admin switched it off), it says so in one plain line. Otherwise it
 * offers one button, waits (a free AI plan can take most of a minute), and
 * shows the answer marked as an AI suggestion, with the model that wrote it, a
 * line saying the app checked it, and a thumbs up or down for the Admin's
 * usage figures.
 *
 * The screen owns the question (`ask`, which calls its route) and how an
 * answer looks (`children`). The answer is only ever an explanation: every
 * fact in it has already been checked against the engine by the route.
 */

/** The label every AI answer carries, here and in the schema chat. */
export const AI_SUGGESTION_LABEL = "AI suggestion, check before use";

/* ------------------------------------------------------------- the status */

// One /api/ai/status request per organization, shared by every panel on the
// page. A failed read is dropped, so the next panel asks again. An Admin
// saving the AI tab calls resetAiStatus(), which makes every panel ask again.
const statusRequests = new Map<string, Promise<AiStatusView | null>>();
let statusVersion = 0;
const statusListeners = new Set<() => void>();

/** The organization a request is sent as: apiFetch reads it from the address too. */
function statusOrg(): string {
  if (typeof window === "undefined") return "";
  return orgSlugFromPath(window.location.pathname) ?? "";
}

/** The AI status of the organization the page is open in. Null when it could not be read. */
export function loadAiStatus(): Promise<AiStatusView | null> {
  const org = statusOrg();
  const known = statusRequests.get(org);
  if (known) return known;
  const request = (async () => {
    try {
      const response = await apiFetch("/api/ai/status", { cache: "no-store" });
      const body = await jsonOf(response);
      return response.ok && isAiStatusView(body) ? body : null;
    } catch {
      return null;
    }
  })();
  statusRequests.set(org, request);
  void request.then((view) => {
    // Keep no failure, so a passing network error is not stuck for the session.
    if (view === null && statusRequests.get(org) === request) statusRequests.delete(org);
  });
  return request;
}

/** Forget every saved status, so each panel asks again. Call after an Admin saves the AI tab. */
export function resetAiStatus() {
  statusRequests.clear();
  statusVersion += 1;
  for (const listener of statusListeners) listener();
}

function subscribeStatus(listener: () => void) {
  statusListeners.add(listener);
  return () => {
    statusListeners.delete(listener);
  };
}

function readStatusVersion() {
  return statusVersion;
}

/** Whether one AI feature is on for this person here, and if not, why not. */
export type AiAccess = { kind: "unknown" } | { kind: "on" } | { kind: "off"; reason: string; askAdmin: boolean };

const UNKNOWN: AiAccess = { kind: "unknown" };

function off(reason: string, askAdmin = false): AiAccess {
  return { kind: "off", reason, askAdmin };
}

/** What the server's status says about one feature. */
function accessFromStatus(view: AiStatusView | null, feature: AiFeature): AiAccess {
  if (!view) return off("Could not check whether AI is on here. Reload the page to try again.");
  if (!view.configured) return off("AI is not set up on this server.");
  if (!view.enabled) {
    return off("AI is switched off for this organization. An Admin can switch it on in Admin, AI.");
  }
  if (!view.features[feature]) {
    return off(
      `${FEATURE_LABELS[feature]} is switched off for this organization. An Admin can switch it on in Admin, AI.`
    );
  }
  return { kind: "on" };
}

/** Whether this person can use one AI feature here, and the reason when not. */
export function useAiAccess(feature: AiFeature): AiAccess {
  const { can, loading, roleLabel, accessError } = useUser();
  const org = useOrg()?.slug ?? "";
  const version = useSyncExternalStore(subscribeStatus, readStatusVersion, readStatusVersion);
  const allowed = !loading && !accessError && can("ai:read");
  // A status is only used for the organization and the reset it was asked for.
  const asked = `${org}|${version}`;
  const [found, setFound] = useState<{ asked: string; view: AiStatusView | null } | null>(null);

  useEffect(() => {
    if (!allowed) return;
    let current = true;
    void loadAiStatus().then((view) => {
      if (current) setFound({ asked, view });
    });
    return () => {
      current = false;
    };
  }, [allowed, asked]);

  if (loading) return UNKNOWN;
  if (accessError) return off("Could not check what your role may do. Reload the page to try again.");
  if (!allowed) return off(refusalMessage(roleLabel, "ai:read"), true);
  if (!found || found.asked !== asked) return UNKNOWN;
  return accessFromStatus(found.view, feature);
}

/** Whether this person can use one AI feature here. Null while unknown. */
export function useAiFeature(feature: AiFeature): boolean | null {
  const access = useAiAccess(feature);
  if (access.kind === "unknown") return null;
  return access.kind === "on";
}

/* -------------------------------------------------------------- the panel */

/**
 * Calls the screen's route. Pass `signal` to the fetch, so a question nobody
 * waits for any more is stopped. Send `refresh` in the body: it is true for
 * "Ask again", which wants a new answer, not the saved one.
 */
/** Sends a Helpful? answer for one AI call. A lost one is not worth an error on screen. */
export async function rateAiAnswer(callId: number, rating: 1 | -1): Promise<void> {
  try {
    await apiFetch("/api/ai/rate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callId, rating }),
    });
  } catch {
    // Nothing to show: the answer itself is still on screen.
  }
}

/** The "Helpful? Yes No" buttons under an AI answer (the AI panels and the schema chat). */
export function RateButtons({ rated, onRate }: { rated: 1 | -1 | null; onRate: (rating: 1 | -1) => void }) {
  return (
    <span className="flex items-center gap-1">
      <span>Helpful?</span>
      <button type="button" className="btn btn-ghost px-2 py-0.5" aria-pressed={rated === 1} onClick={() => onRate(1)}>
        Yes
      </button>
      <button type="button" className="btn btn-ghost px-2 py-0.5" aria-pressed={rated === -1} onClick={() => onRate(-1)}>
        No
      </button>
    </span>
  );
}

export type AiAsk = (signal: AbortSignal, refresh: boolean) => Promise<Response>;

type State<T> =
  | { kind: "idle" }
  | { kind: "asking" }
  | { kind: "answer"; answer: T; meta: AiAnswerMeta; extra: Record<string, unknown> }
  | { kind: "error"; message: string };

/** What is on the card, and the resetKey it belongs to. */
type Shown<T> = { key: string | undefined; state: State<T>; rated: 1 | -1 | null };

const IDLE = { kind: "idle" } as const;

/** The line under an answer: the label, the model, and how it was checked. */
function answerFooter(meta: AiAnswerMeta): string {
  const source = meta.saved
    ? `${meta.model}, a saved answer for the same question, so no AI call was made.`
    : `${meta.model}, ${(meta.ms / 1000).toFixed(1)} s.`;
  return `Checked by the app against its own engine. ${source}`;
}

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
  /** When this changes (another comparison, another script), the answer is cleared and a question on its way is dropped. */
  resetKey?: string;
  /** What the person fills in before asking (Script Editor: what the script should do). Shown unless an answer is on its way. */
  input?: ReactNode;
  /** True while the input is not ready to ask with. */
  askDisabled?: boolean;
}) {
  const access = useAiAccess(feature);
  const [shown, setShown] = useState<Shown<T>>({ key: resetKey, state: IDLE, rated: null });
  // The question on its way. A newer question, another resetKey or leaving the
  // screen stops it, and its answer is then thrown away.
  const asking = useRef<AbortController | null>(null);

  useEffect(() => {
    const questions = asking;
    return () => {
      questions.current?.abort();
      questions.current = null;
    };
  }, [resetKey]);

  // What was shown for another resetKey is never drawn under this one.
  const state: State<T> = shown.key === resetKey ? shown.state : IDLE;
  const rated = shown.key === resetKey ? shown.rated : null;

  if (access.kind === "unknown") return null;

  if (access.kind === "off") {
    return (
      <Card className="ai-panel p-4 sm:p-5">
        <h3 className="section-title flex items-center gap-2">
          {title}
          <Pill tone="brand">AI</Pill>
        </h3>
        <p className="text-[13px] mt-1 max-w-[62ch]" style={{ color: "var(--text-2)" }}>
          {access.reason}
          {access.askAdmin && <AskAdmin permission="ai:read" />}
        </p>
      </Card>
    );
  }

  async function run(refresh: boolean) {
    asking.current?.abort();
    const controller = new AbortController();
    asking.current = controller;
    const key = resetKey;
    const show = (next: State<T>) => {
      // Only the newest question on this resetKey may change the card.
      if (asking.current === controller) setShown({ key, state: next, rated: null });
    };

    show({ kind: "asking" });
    try {
      const response = await ask(controller.signal, refresh);
      const body = await jsonOf(response);
      if (!response.ok || !isAiAnswerBody(body) || !isAnswer(body.answer)) {
        show({ kind: "error", message: errorFrom(body) ?? "The AI answer could not be read." });
        return;
      }
      const { answer, meta, ...extra } = body as typeof body & Record<string, unknown>;
      show({ kind: "answer", answer: answer as T, meta, extra });
    } catch {
      show({ kind: "error", message: "Network error while asking the AI." });
    }
  }

  async function rate(rating: 1 | -1) {
    if (state.kind !== "answer" || state.meta.callId === null) return;
    setShown({ key: resetKey, state, rated: rating });
    await rateAiAnswer(state.meta.callId, rating);
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
            onClick={() => void run(state.kind !== "idle")}
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
          <p className="text-[12px] mt-3 font-semibold" style={{ color: "var(--text-2)" }}>
            {AI_SUGGESTION_LABEL}
          </p>
          <div className="mt-2">{children(state.answer, state.extra)}</div>
          <div
            className="mt-4 pt-3 flex flex-wrap items-center justify-between gap-2 text-[12px]"
            style={{ borderTop: "1px solid var(--border)", color: "var(--text-3)" }}
          >
            <span className="flex items-center gap-1.5">
              <CheckIcon size={13} />
              {answerFooter(state.meta)}
            </span>
            {state.meta.callId !== null && <RateButtons rated={rated} onRate={(rating) => void rate(rating)} />}
          </div>
        </>
      )}
    </Card>
  );
}
