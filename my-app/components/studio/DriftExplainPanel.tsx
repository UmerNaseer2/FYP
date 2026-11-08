"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useOrg, useOrgHref } from "@/hooks/useOrg";
import { useUser } from "@/hooks/useUser";
import { apiFetch } from "@/lib/api-fetch";
import { saveMigrationDraft } from "@/lib/migration-draft";
import { countOf } from "@/lib/plural";
import { refusalMessage } from "@/lib/permissions";
import { isCitedChanges, type CitedChange } from "@/lib/ai/features/compare-summary-view";
import {
  isDriftExplainAnswer,
  isDriftScripts,
  type DriftChoice,
  type DriftExplainAnswer,
  type DriftScript,
  type DriftScripts,
} from "@/lib/ai/features/drift-explain-view";
import { AiPanel } from "./AiPanel";
import { AskAdmin } from "./AskAdmin";
import { ChangeRefs, RiskRow } from "./CompareSummaryPanel";
import { withNames } from "./ai-names";

const CHOICE_LABEL: Record<DriftChoice, string> = {
  revert: "Revert the live database",
  adopt: "Adopt the change into the registry",
  either: "Either way out works",
};

const SCRIPT_TEXT: Record<keyof DriftScripts, { title: string; what: string; open: string }> = {
  revert: {
    title: "Revert",
    what: "Puts the live database back to the baseline. Run it on the drifted database.",
    open: "Open revert draft",
  },
  adopt: {
    title: "Adopt",
    what: "Writes what changed on live as the registry's next version, so the baseline catches up. Save it as a script; the live database already has these changes.",
    open: "Open adopt draft",
  },
};

function scriptFacts(script: DriftScript): string {
  const parts = [`${countOf(script.runs, "statement")} to run`];
  if (script.heldBack > 0) parts.push(`${countOf(script.heldBack, "drop")} written but commented out`);
  if (script.manual > 0) parts.push(`${countOf(script.manual, "change")} the app cannot script`);
  return parts.join(", ");
}

function ScriptChoice({
  kind,
  script,
  canSave,
  onOpen,
}: {
  kind: keyof DriftScripts;
  script: DriftScript;
  canSave: boolean;
  onOpen: (script: DriftScript) => void;
}) {
  const text = SCRIPT_TEXT[kind];
  return (
    <div className="rounded-md p-3" style={{ border: "1px solid var(--border)" }}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="font-medium">{text.title}</div>
          <div className="text-[12px]" style={{ color: "var(--text-3)" }}>
            {scriptFacts(script)}
          </div>
        </div>
        {canSave && (
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={script.runs === 0}
            title={script.runs === 0 ? "Nothing in this script runs, so there is no draft to open." : undefined}
            onClick={() => onOpen(script)}
          >
            {text.open}
          </button>
        )}
      </div>
      <p className="mt-1.5 text-[12.5px]" style={{ color: "var(--text-2)" }}>
        {text.what}
      </p>
      <details className="mt-1.5">
        <summary className="cursor-pointer text-[12px]" style={{ color: "var(--text-3)" }}>
          Show the SQL
        </summary>
        <pre className="mono mt-1.5 max-h-72 overflow-auto rounded p-2 text-[11.5px] whitespace-pre-wrap" style={{ background: "var(--surface-2)" }}>
          {script.sql}
        </pre>
      </details>
    </div>
  );
}

function ExplainView({
  answer,
  cited,
  scripts,
  canSave,
  roleLabel,
  saveFailed,
  onOpen,
}: {
  answer: DriftExplainAnswer;
  cited: Record<string, CitedChange>;
  scripts: DriftScripts | null;
  canSave: boolean;
  roleLabel: string;
  saveFailed: boolean;
  onOpen: (script: DriftScript) => void;
}) {
  return (
    <div className="space-y-4 text-[13.5px]">
      <p style={{ color: "var(--text-1)" }}>{withNames(answer.headline)}</p>

      <div>
        <h4 className="text-[12px] font-semibold uppercase tracking-wide" style={{ color: "var(--text-3)" }}>
          What changed
        </h4>
        <ol className="mt-2 space-y-3">
          {answer.items.map((item, i) => (
            <RiskRow key={i} item={item} cited={cited} />
          ))}
        </ol>
      </div>

      {answer.likelyCause && (
        <div>
          <h4 className="text-[12px] font-semibold uppercase tracking-wide" style={{ color: "var(--text-3)" }}>
            Likely cause
          </h4>
          <p className="mt-1" style={{ color: "var(--text-2)" }}>
            {withNames(answer.likelyCause)}
          </p>
        </div>
      )}

      {answer.manualNotes.length > 0 && (
        <div>
          <h4 className="text-[12px] font-semibold uppercase tracking-wide" style={{ color: "var(--text-3)" }}>
            To do by hand
          </h4>
          <ul className="mt-2 space-y-2">
            {answer.manualNotes.map((note, i) => (
              <li key={i}>
                <p style={{ color: "var(--text-2)" }}>
                  {withNames(note.note)}
                  {note.fromApp && (
                    <span
                      className="pill pill-outline ml-2 text-[11.5px]"
                      title="The app wrote this note: no statement can make these changes and the AI's answer left them out."
                    >
                      From the app
                    </span>
                  )}
                </p>
                <ChangeRefs ids={note.changes} cited={cited} />
              </li>
            ))}
          </ul>
        </div>
      )}

      <div>
        <h4 className="text-[12px] font-semibold uppercase tracking-wide" style={{ color: "var(--text-3)" }}>
          Two ways out
        </h4>
        <p className="mt-1" style={{ color: "var(--text-2)" }}>
          <span className="font-medium" style={{ color: "var(--text-1)" }}>
            The AI suggests: {CHOICE_LABEL[answer.recommendation.choice] ?? answer.recommendation.choice}.
          </span>{" "}
          {withNames(answer.recommendation.why)}
        </p>
        {scripts && (
          <div className="mt-2 grid gap-2 md:grid-cols-2">
            <ScriptChoice kind="revert" script={scripts.revert} canSave={canSave} onOpen={onOpen} />
            <ScriptChoice kind="adopt" script={scripts.adopt} canSave={canSave} onOpen={onOpen} />
          </div>
        )}
        {saveFailed && (
          <p className="mt-2 text-[12px]" style={{ color: "var(--break)" }}>
            This browser would not keep the draft. Copy the SQL above into the Script Editor instead.
          </p>
        )}
        {!canSave && (
          <p className="mt-2 text-[11.5px]" style={{ color: "var(--text-3)" }}>
            {refusalMessage(roleLabel, "scripts:create")} Copy the SQL above instead.
            <AskAdmin permission="scripts:create" />
          </p>
        )}
      </div>

      <p className="text-[12px]" style={{ color: "var(--text-3)" }}>
        The app writes both scripts itself, and drops in them stay commented out until someone removes the comment. A
        change is never graded below what the app&apos;s own comparison says. Nothing is run or changed from here.
      </p>
    </div>
  );
}

/**
 * The AI's explanation of a schema's drift on the Drift screen, with the two
 * scripts the app writes for it: revert (live back to the baseline) and adopt
 * (live's changes as the registry's next version). Either one opens as a
 * Script Editor draft; nothing runs from here.
 */
export function DriftExplainPanel({
  trackedSchemaId,
  connectionId,
  schemaName,
  resetKey,
}: {
  trackedSchemaId: number;
  connectionId: number;
  schemaName: string;
  resetKey: string;
}) {
  const router = useRouter();
  const org = useOrg();
  const orgPath = useOrgHref();
  const { can, loading, roleLabel } = useUser();
  const canSave = !loading && can("scripts:create");
  const [saveFailed, setSaveFailed] = useState(false);

  function open(script: DriftScript) {
    const saved = saveMigrationDraft({
      sql: script.sql,
      rollbackSql: script.rollbackSql,
      description: script.description,
      connectionId: String(connectionId),
      schema: schemaName,
      createdAt: new Date().toISOString(),
      org: org?.slug ?? "",
    });
    if (saved) router.push(orgPath("/script-editor"));
    else setSaveFailed(true);
  }

  return (
    <AiPanel
      feature="drift-explain"
      title="Explain this drift"
      blurb="An AI read of what changed on the live database, how it may have happened and which way out fits. The schema structure on both sides is sent to the AI, never your rows."
      askLabel="Explain with AI"
      resetKey={resetKey}
      isAnswer={isDriftExplainAnswer}
      ask={(signal, refresh) =>
        apiFetch("/api/lineage/drift/explain", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ trackedSchemaId, refresh }),
          signal,
        })
      }
    >
      {(answer, extra) => (
        <ExplainView
          answer={answer}
          cited={isCitedChanges(extra.cited) ? extra.cited : {}}
          scripts={isDriftScripts(extra.scripts) ? extra.scripts : null}
          canSave={canSave}
          roleLabel={roleLabel}
          saveFailed={saveFailed}
          onOpen={open}
        />
      )}
    </AiPanel>
  );
}
