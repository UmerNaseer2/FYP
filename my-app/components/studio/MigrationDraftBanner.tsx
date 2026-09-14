"use client";

import { useState } from "react";
import { InfoIcon } from "@/components/ui/icons";
import { useMigrationDraft } from "@/hooks/useMigrationDraft";
import {
  clearMigrationDraft,
  draftStatementCount,
  type MigrationDraft,
} from "@/lib/migration-draft";
import { countOf } from "@/lib/plural";

/**
 * The Script Editor's offer to load a migration saved on a Performance tab
 * ("Save as a migration" in FixScriptBuilder.tsx).
 *
 * Offered, never loaded by itself: the editor may already hold someone's
 * unsaved work, and a script that replaced it without asking would lose it.
 * Load fills in the editor through `onLoad` (the page's own setters, via
 * planDraftLoad in lib/migration-draft.ts) and forgets the draft; Discard only
 * forgets it. Either way the offer goes.
 */
export function MigrationDraftBanner({
  connections,
  connectionsLoaded,
  editorHasContent,
  onLoad,
}: {
  connections: { id: number; name: string }[];
  /** Load waits for the list, so it can tell whether the draft's connection is still saved. */
  connectionsLoaded: boolean;
  /** The editor holds SQL, a rollback or a description already. */
  editorHasContent: boolean;
  onLoad: (draft: MigrationDraft) => void;
}) {
  const draft = useMigrationDraft();
  // Hides the offer once it is answered, even if the browser refused to
  // forget the draft (the storage can refuse a removal like anything else).
  const [draftHandled, setDraftHandled] = useState(false);
  if (draft === null || draftHandled) return null;

  const statements = draftStatementCount(draft.sql);
  const connection = connections.find((c) => String(c.id) === draft.connectionId) ?? null;

  return (
    <section className="card p-0 overflow-hidden" aria-label="A script from Performance">
      <div className="p-4 flex items-start gap-3" style={{ borderLeft: "3px solid var(--brand)" }}>
        <InfoIcon size={16} style={{ color: "var(--brand)", marginTop: 2, flexShrink: 0 }} />
        <div className="min-w-0 flex-1 space-y-2">
          <div className="text-[13.5px] font-semibold" style={{ color: "var(--text)" }}>
            A script from Performance is waiting: {countOf(statements, "statement")} for schema{" "}
            <span className="mono">{draft.schema}</span>.
          </div>
          <div className="text-[12.5px] space-y-1 leading-[1.55]" style={{ color: "var(--text-2)" }}>
            <p>
              {connection
                ? `Loading it points the editor at ${connection.name}, schema ${draft.schema}, and fills in the SQL and the description.`
                : connectionsLoaded
                  ? `The connection it was made on is no longer saved. After loading, pick the connection that holds schema ${draft.schema}: every statement names that schema.`
                  : "Loading it fills in the SQL and the description."}{" "}
              {draft.rollbackSql !== null
                ? "The rollback is filled in too: the statements that undo each change, last change first."
                : "It comes with no rollback, because at least one change has no statement that undoes it. Before saving, write one in the Rollback SQL box, or tick Save without a rollback."}
            </p>
            {editorHasContent && (
              <p>Loading replaces the SQL, rollback and description the editor holds now.</p>
            )}
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={!connectionsLoaded}
              title={connectionsLoaded ? undefined : "Waiting for your saved connections to load."}
              onClick={() => {
                onLoad(draft);
                clearMigrationDraft();
                setDraftHandled(true);
              }}
            >
              {editorHasContent ? "Replace the editor contents" : "Load into the editor"}
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => {
                clearMigrationDraft();
                setDraftHandled(true);
              }}
            >
              Discard
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
