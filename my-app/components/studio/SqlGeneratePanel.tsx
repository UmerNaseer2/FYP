"use client";

import { useState } from "react";
import { Button, ConfirmDialog } from "@/components/ui";
import { Pill, type PillTone } from "@/components/ui/Pill";
import { apiFetch } from "@/lib/api-fetch";
import { MAX_MIGRATION_DESCRIPTION } from "@/lib/perf-sql";
import { countOf } from "@/lib/plural";
import {
  isSqlGenerateAnswer,
  isSqlGenerateChecks,
  MAX_REQUEST_CHARS,
  type SqlGenerateAnswer,
  type SqlGenerateChecks,
  type SqlGenerateLevel,
} from "@/lib/ai/features/sql-generate-view";
import { AiPanel } from "./AiPanel";
import { withNames } from "./ai-names";

const LEVEL_TONE: Record<SqlGenerateLevel, PillTone> = { breaking: "break", additive: "sync", patch: "neutral" };
const LEVEL_LABEL: Record<SqlGenerateLevel, string> = { breaking: "Breaking", additive: "Additive", patch: "Patch" };

export type GeneratedScript = { sql: string; rollbackSql: string; description: string };

function SqlBlock({ label, text }: { label: string; text: string }) {
  return (
    <div>
      <h4 className="text-[12px] font-semibold uppercase tracking-wide" style={{ color: "var(--text-3)" }}>
        {label}
      </h4>
      <pre
        className="mono mt-1 p-3 text-[12.5px] overflow-x-auto"
        style={{ background: "var(--surface-2)", border: "1px solid var(--border)", borderRadius: 8, lineHeight: 1.55 }}
      >
        {text}
      </pre>
    </div>
  );
}

function List({ title, items, tone }: { title: string; items: string[]; tone?: string }) {
  if (items.length === 0) return null;
  return (
    <div>
      <h4 className="text-[12px] font-semibold uppercase tracking-wide" style={{ color: tone ?? "var(--text-3)" }}>
        {title}
      </h4>
      <ul className="list-disc pl-5 mt-1 space-y-0.5" style={{ color: "var(--text-2)" }}>
        {items.map((item, i) => (
          <li key={i} className="break-words">
            {withNames(item)}
          </li>
        ))}
      </ul>
    </div>
  );
}

function TrialLine({ checks }: { checks: SqlGenerateChecks }) {
  const { trial } = checks;
  if (trial.status === "passed") {
    return (
      <p style={{ color: "var(--sync)" }}>
        {trial.rollbackTried
          ? "Tried on this database: the script and then its rollback ran without an error, and everything was rolled back."
          : "Tried on this database: the script ran without an error, and it was rolled back."}
      </p>
    );
  }
  return <p style={{ color: "var(--text-2)" }}>Not tried on the database. {trial.reason}</p>;
}

function GeneratedView({
  answer,
  checks,
  onUse,
}: {
  answer: SqlGenerateAnswer;
  checks: SqlGenerateChecks | null;
  onUse: (script: GeneratedScript) => void;
}) {
  if (!answer.sql) {
    return (
      <div className="role-note" role="note">
        <div>
          <div className="title">The AI could not write this script</div>
          <div className="body">{withNames(answer.cannot || "It gave no reason.")}</div>
        </div>
      </div>
    );
  }
  return (
    <div className="space-y-4 text-[13.5px]">
      <p style={{ color: "var(--text-1)" }}>{withNames(answer.summary)}</p>
      {checks && (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2 text-[12.5px]" style={{ color: "var(--text-2)" }}>
            {checks.level && (
              <Pill tone={LEVEL_TONE[checks.level]} title={checks.levelBecause ?? undefined}>
                {LEVEL_LABEL[checks.level]}
              </Pill>
            )}
            <span>
              {countOf(checks.statements, "statement")}
              {checks.rollbackStatements > 0
                ? `, rollback of ${countOf(checks.rollbackStatements, "statement")}`
                : ", no rollback"}
            </span>
          </div>
          <TrialLine checks={checks} />
        </div>
      )}
      <List title="Deletes data" items={checks?.dataLoss ?? []} tone="var(--break)" />
      <List title="Can fail on rows already there" items={checks?.mightFail ?? []} tone="var(--drift)" />
      <List title="What the AI assumed" items={answer.assumptions} />
      <SqlBlock label="Script" text={answer.sql} />
      {answer.rollbackSql && <SqlBlock label="Rollback" text={answer.rollbackSql} />}
      <div className="flex flex-wrap items-center gap-3">
        <Button
          size="sm"
          onClick={() =>
            onUse({
              sql: answer.sql,
              rollbackSql: answer.rollbackSql,
              description: answer.summary.replace(/`/g, "").slice(0, MAX_MIGRATION_DESCRIPTION),
            })
          }
        >
          Put it in the editor
        </Button>
        <span className="text-[12px]" style={{ color: "var(--text-3)" }}>
          Nothing is saved until you save it. Read it first: the app checked names and risks, not whether it does what you meant.
        </span>
      </div>
    </div>
  );
}

/**
 * Script Editor: write the script from plain words. The request, the picked
 * schema's structure and the server version go to the AI, never rows. The
 * answer lands in the editor only when the person says so, and replacing what
 * is already there is asked first.
 */
export function SqlGeneratePanel({
  connectionId,
  schemaName,
  editorHasText,
  onUse,
}: {
  connectionId: number;
  schemaName: string;
  editorHasText: boolean;
  onUse: (script: GeneratedScript) => void;
}) {
  const [request, setRequest] = useState("");
  const [pending, setPending] = useState<GeneratedScript | null>(null);
  const words = request.trim();

  function use(script: GeneratedScript) {
    if (editorHasText) setPending(script);
    else onUse(script);
  }

  return (
    <>
      <AiPanel
        feature="sql-generate"
        title="Write it with AI"
        blurb="Say what the script should do, in plain words. The AI writes it and a rollback for this schema; the app checks the names and risks and, on a Dev or Staging target you may deploy to, tries both inside a transaction it rolls back. Your words and the schema structure are sent to the AI, never your rows."
        askLabel="Write the script"
        resetKey={`${connectionId}/${schemaName}`}
        askDisabled={words.length === 0 || words.length > MAX_REQUEST_CHARS}
        input={
          <div>
            <label className="label" htmlFor="se-ai-request">
              What should the script do?
            </label>
            <textarea
              id="se-ai-request"
              className="input mt-1"
              style={{ minHeight: 72, resize: "vertical" }}
              maxLength={MAX_REQUEST_CHARS}
              placeholder="Add a due date to invoices, defaulting to 30 days after the invoice date, and index it."
              value={request}
              onChange={(e) => setRequest(e.target.value)}
            />
          </div>
        }
        isAnswer={isSqlGenerateAnswer}
        ask={(signal, refresh) =>
          apiFetch("/api/scripts/generate", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ connectionId, schemaName, request: words, refresh }),
            signal,
          })
        }
      >
        {(answer, extra) => (
          <GeneratedView answer={answer} checks={isSqlGenerateChecks(extra.checks) ? extra.checks : null} onUse={use} />
        )}
      </AiPanel>
      <ConfirmDialog
        open={pending !== null}
        onClose={() => setPending(null)}
        onConfirm={() => {
          if (pending) onUse(pending);
          setPending(null);
        }}
        title="Replace what is in the editor?"
        description="The SQL, the rollback and the description in the editor are replaced with the AI's script. What is there now is not kept."
        confirmLabel="Replace"
      />
    </>
  );
}
