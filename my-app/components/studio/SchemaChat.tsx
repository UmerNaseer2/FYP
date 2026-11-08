"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Button, Drawer, Pill } from "@/components/ui";
import { AlertCircleIcon, CheckIcon, ClipboardIcon } from "@/components/ui/icons";
import { useUser } from "@/hooks/useUser";
import { useOrg, useOrgHref } from "@/hooks/useOrg";
import { apiFetch } from "@/lib/api-fetch";
import { errorFrom, jsonOf } from "@/lib/api-answer";
import { isAiAnswerBody, type AiAnswerMeta } from "@/lib/ai/views";
import {
  MAX_HISTORY_TURNS,
  MAX_QUESTION_CHARS,
  isChatAnswer,
  type ChatAnswer,
  type ChatTurn,
} from "@/lib/ai/features/schema-chat-view";
import { saveMigrationDraft } from "@/lib/migration-draft";
import { refusalMessage } from "@/lib/permissions";
import { MAX_MIGRATION_DESCRIPTION } from "@/lib/perf-sql";
import { AI_SUGGESTION_LABEL, RateButtons, rateAiAnswer, useAiFeature } from "./AiPanel";
import { withNames } from "./ai-names";

/** What each lookup is called on screen. */
const LOOKUP_LABEL: Record<string, string> = {
  list_connections: "connections",
  list_schemas: "schemas",
  show_schema: "a schema",
  find_column: "a column search",
  compare_schemas: "a comparison",
  version_history: "version history",
  list_tracked_schemas: "tracked schemas",
  drift_detail: "drift",
  deploy_approvals: "deploy approvals",
  performance_advice: "performance advice",
};

type Entry =
  | { kind: "question"; text: string }
  | { kind: "answer"; answer: ChatAnswer; meta: AiAnswerMeta; rated: 1 | -1 | null }
  | { kind: "error"; message: string };

/** The answer as the AI wrote it, SQL back in its fence, for the next question's history. */
function answerAsText(answer: ChatAnswer): string {
  return answer.sql ? `${answer.text}\n\n\`\`\`sql\n${answer.sql}\n\`\`\`` : answer.text;
}

/** Earlier questions that got an answer, with the answer. A question that failed is left out. */
function historyOf(entries: Entry[]): ChatTurn[] {
  const turns: ChatTurn[] = [];
  entries.forEach((entry, i) => {
    const next = entries[i + 1];
    if (entry.kind === "question" && next?.kind === "answer") {
      turns.push({ role: "user", text: entry.text }, { role: "assistant", text: answerAsText(next.answer) });
    }
  });
  return turns.slice(-MAX_HISTORY_TURNS);
}

function Note({ title, children, tone }: { title: string; children: ReactNode; tone?: string }) {
  return (
    <div className="role-note" role="note">
      <AlertCircleIcon size={15} className="ico" style={tone ? { color: tone } : undefined} />
      <div>
        <div className="title">{title}</div>
        <div className="body">{children}</div>
      </div>
    </div>
  );
}

function Lookups({ tools }: { tools: ChatAnswer["toolsUsed"] }) {
  if (tools.length === 0) {
    return <span>Answered without looking anything up.</span>;
  }
  const parts = tools.map((t) => `${LOOKUP_LABEL[t.name] ?? t.name}${t.ok ? "" : " (not read)"}`);
  return <span>Looked up {parts.join(", ")}.</span>;
}

function AnswerView({
  entry,
  canSave,
  roleLabel,
  onRate,
  onOpen,
  openFailed,
}: {
  entry: Extract<Entry, { kind: "answer" }>;
  canSave: boolean;
  roleLabel: string;
  onRate: (rating: 1 | -1) => void;
  onOpen: (answer: ChatAnswer) => void;
  openFailed: boolean;
}) {
  const { answer, meta, rated } = entry;
  const [copied, setCopied] = useState<"yes" | "blocked" | null>(null);

  async function copy() {
    if (!answer.sql) return;
    try {
      await navigator.clipboard.writeText(answer.sql);
      setCopied("yes");
    } catch {
      setCopied("blocked");
    }
  }

  return (
    <div className="space-y-3 text-[13.5px]">
      <p className="text-[12px] font-semibold" style={{ color: "var(--text-2)" }}>
        {AI_SUGGESTION_LABEL}, written by {meta.model}.
      </p>
      <div className="whitespace-pre-wrap break-words" style={{ color: "var(--text)", lineHeight: 1.55 }}>
        {withNames(answer.text)}
      </div>
      {answer.unverifiedNames.length > 0 && (
        <Note title="Check these names">
          The app could not find {withNames(answer.unverifiedNames.map((n) => `\`${n}\``).join(", "))} in what the AI
          looked up, so they may be wrong.
        </Note>
      )}
      {answer.sqlProblems.length > 0 && (
        <Note title="SQL held back" tone="var(--break)">
          The AI wrote SQL the app will not show: {withNames(answer.sqlProblems.join(" "))}
        </Note>
      )}
      {answer.sql && (
        <div>
          <h4 className="text-[12px] font-semibold uppercase tracking-wide" style={{ color: "var(--text-3)" }}>
            SQL draft, not run
          </h4>
          <pre
            className="mono mt-1 p-3 text-[12.5px] overflow-x-auto"
            style={{ background: "var(--surface-2)", border: "1px solid var(--border)", borderRadius: 8, lineHeight: 1.55 }}
          >
            {answer.sql}
          </pre>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {answer.target && canSave && (
              <Button size="sm" onClick={() => onOpen(answer)}>
                Open in the Script Editor
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={() => void copy()}>
              <ClipboardIcon size={13} /> {copied === "yes" ? "Copied" : "Copy"}
            </Button>
          </div>
          {answer.target && !canSave && (
            <p className="text-[12px] mt-1" style={{ color: "var(--text-3)" }}>
              {refusalMessage(roleLabel, "scripts:create")}
            </p>
          )}
          {!answer.target && (
            <p className="text-[12px] mt-1" style={{ color: "var(--text-3)" }}>
              The app could not tell which database this draft is for, so copy it into the Script Editor yourself.
            </p>
          )}
          {copied === "blocked" && (
            <p className="text-[12px] mt-1" style={{ color: "var(--text-3)" }}>
              Your browser blocked the clipboard. Select the SQL and copy it by hand.
            </p>
          )}
          {openFailed && (
            <p className="text-[12px] mt-1" style={{ color: "var(--text-3)" }}>
              This browser would not keep the draft for the Script Editor. Copy the SQL instead.
            </p>
          )}
        </div>
      )}
      <div
        className="pt-2 flex flex-wrap items-center justify-between gap-2 text-[12px]"
        style={{ borderTop: "1px solid var(--border)", color: "var(--text-3)" }}
      >
        <span className="flex items-start gap-1.5 min-w-0">
          <CheckIcon size={13} className="flex-none mt-0.5" />
          <span>
            <Lookups tools={answer.toolsUsed} /> {meta.model}, {(meta.ms / 1000).toFixed(1)} s.
          </span>
        </span>
        {meta.callId !== null && <RateButtons rated={rated} onRate={onRate} />}
      </div>
    </div>
  );
}

/**
 * The top bar's "Ask AI" button and the chat drawer it opens.
 *
 * Questions go to /api/ai/chat, which lets the AI look things up through the
 * app's own read routes as the person asking: it sees what they may see, and
 * nothing else. It cannot change anything. A SQL draft in an answer is checked
 * by the app and only ever handed to the Script Editor, where nothing runs or
 * is saved until the person does it.
 *
 * The conversation lives here and is gone when the page reloads. Nothing about
 * it is saved, apart from the usage figures every AI call leaves.
 */
export function SchemaChatButton() {
  const usable = useAiFeature("schema-chat");
  const router = useRouter();
  const org = useOrg();
  const orgPath = useOrgHref();
  const { can, loading, roleLabel } = useUser();
  const canSave = !loading && can("scripts:create");
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [draft, setDraft] = useState("");
  const [asking, setAsking] = useState(false);
  const [openFailed, setOpenFailed] = useState<number | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  // The question being asked now, so it can be stopped. Stopping the fetch
  // also stops the work on the server, so no AI calls are spent on an answer
  // nobody will see.
  const askRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (open) endRef.current?.scrollIntoView({ block: "end" });
  }, [entries, asking, open]);

  // Leaving the page (or another organization's page taking its place) stops
  // the question.
  useEffect(() => () => askRef.current?.abort(), []);

  if (!usable) return null;

  const question = draft.trim();
  const canSend = !asking && question.length > 0 && question.length <= MAX_QUESTION_CHARS;

  async function send() {
    if (!canSend) return;
    const history = historyOf(entries);
    setEntries((list) => [...list, { kind: "question", text: question }]);
    setDraft("");
    setAsking(true);
    askRef.current?.abort();
    const controller = new AbortController();
    askRef.current = controller;
    try {
      const response = await apiFetch("/api/ai/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question, history }),
        signal: controller.signal,
      });
      const body = await jsonOf(response);
      // Stopped while the answer was on its way: stop() already said so.
      if (controller.signal.aborted) return;
      if (!response.ok || !isAiAnswerBody(body) || !isChatAnswer(body.answer)) {
        const message = errorFrom(body) ?? "The AI answer could not be read.";
        setEntries((list) => [...list, { kind: "error", message }]);
      } else {
        const answer = body.answer;
        setEntries((list) => [...list, { kind: "answer", answer, meta: body.meta, rated: null }]);
      }
    } catch {
      if (controller.signal.aborted) return;
      setEntries((list) => [...list, { kind: "error", message: "Network error while asking the AI." }]);
    } finally {
      if (askRef.current === controller) {
        askRef.current = null;
        setAsking(false);
      }
    }
  }

  /** Stop the question being asked. The server stops working on it too. */
  function stop() {
    askRef.current?.abort();
    askRef.current = null;
    setAsking(false);
    setEntries((list) => [...list, { kind: "error", message: "You stopped this question." }]);
  }

  async function rate(index: number, rating: 1 | -1) {
    const entry = entries[index];
    if (entry?.kind !== "answer" || entry.meta.callId === null) return;
    setEntries((list) => list.map((e, i) => (i === index && e.kind === "answer" ? { ...e, rated: rating } : e)));
    await rateAiAnswer(entry.meta.callId, rating);
  }

  function openInEditor(index: number, answer: ChatAnswer) {
    if (!answer.sql || !answer.target) return;
    const asked = entries[index - 1];
    const saved = saveMigrationDraft({
      sql: answer.sql,
      rollbackSql: null,
      description: (asked?.kind === "question" ? `Schema chat: ${asked.text}` : "Schema chat draft").slice(
        0,
        MAX_MIGRATION_DESCRIPTION
      ),
      connectionId: String(answer.target.connectionId),
      schema: answer.target.schema,
      createdAt: new Date().toISOString(),
      org: org?.slug ?? "",
    });
    if (saved) {
      setOpen(false);
      router.push(orgPath("/script-editor"));
    } else {
      setOpenFailed(index);
    }
  }

  return (
    <>
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)} aria-haspopup="dialog">
        Ask AI
      </Button>
      <Drawer
        open={open}
        onClose={() => setOpen(false)}
        title="Schema chat"
        badge={<Pill tone="brand">AI</Pill>}
        width={540}
        footer={
          <form
            className="w-full space-y-2"
            onSubmit={(e) => {
              e.preventDefault();
              void send();
            }}
          >
            <label className="sr-only" htmlFor="schema-chat-question">
              Your question
            </label>
            <textarea
              id="schema-chat-question"
              className="input"
              style={{ minHeight: 64, resize: "vertical" }}
              maxLength={MAX_QUESTION_CHARS}
              placeholder="Which tables have a customer_id column, and are they indexed?"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void send();
                }
              }}
            />
            <div className="flex items-center justify-between gap-2">
              <span className="text-[12px]" style={{ color: "var(--text-3)" }}>
                Enter sends, Shift+Enter starts a new line.
              </span>
              <div className="flex items-center gap-2">
                {entries.length > 0 && !asking && (
                  <Button size="sm" variant="ghost" onClick={() => setEntries([])}>
                    Clear
                  </Button>
                )}
                {asking && (
                  <Button size="sm" variant="ghost" onClick={stop}>
                    Stop
                  </Button>
                )}
                <Button size="sm" variant="primary" type="submit" disabled={!canSend}>
                  Send
                </Button>
              </div>
            </div>
          </form>
        }
      >
        <div aria-live="polite" className="space-y-4">
          {entries.length === 0 && (
            <p className="text-[13px]" style={{ color: "var(--text-2)" }}>
              Ask about the schemas you can see: what a table holds, where a column is used, what changed between two
              databases, what is drifting or waiting for approval. The AI looks things up through the app as you, so
              it sees only what you may see, and it cannot change anything. Schema structure is sent to the AI, never
              your rows.
            </p>
          )}
          {entries.map((entry, i) => {
            if (entry.kind === "question") {
              return (
                <div
                  key={i}
                  className="ml-8 p-3 text-[13.5px] whitespace-pre-wrap break-words"
                  style={{ background: "var(--surface-2)", border: "1px solid var(--border)", borderRadius: 8 }}
                >
                  {entry.text}
                </div>
              );
            }
            if (entry.kind === "error") {
              return (
                <div key={i} className="role-note" role="alert">
                  <AlertCircleIcon size={15} className="ico" />
                  <div>
                    <div className="title">No AI answer</div>
                    <div className="body">{entry.message}</div>
                  </div>
                </div>
              );
            }
            return (
              <AnswerView
                key={i}
                entry={entry}
                canSave={canSave}
                roleLabel={roleLabel}
                onRate={(rating) => void rate(i, rating)}
                onOpen={(answer) => openInEditor(i, answer)}
                openFailed={openFailed === i}
              />
            );
          })}
          {asking && (
            <p className="text-[13px]" style={{ color: "var(--text-2)" }} role="status">
              Asking the AI. It may look several things up first; on the free plan this can take a minute or two.
            </p>
          )}
          <div ref={endRef} />
        </div>
      </Drawer>
    </>
  );
}
