// ---------------------------------------------------------------------------
// migration-draft.ts
// The hand-over from a Performance tab to the Script Editor.
//
// "Save as a migration" on either Performance tab
// (components/studio/FixScriptBuilder.tsx) keeps the ticked schema changes
// here, and the Script Editor (components/studio/MigrationDraftBanner.tsx)
// offers to load them. They wait in this tab's sessionStorage rather than in
// the URL: a URL ends up in the browser's history and in request logs, and a
// script can be long. sessionStorage belongs to this one tab and is emptied
// when the tab closes.
//
// This is the first place the app uses browser storage, and a browser can
// refuse it (a privacy setting, a policy that blocks site data, a sandboxed
// frame). Then even looking up window.sessionStorage throws. So every touch
// is inside a try/catch and says whether it worked, and Save tells the person
// to copy or download the script instead, which need no storage.
// ---------------------------------------------------------------------------

import { MAX_MIGRATION_DESCRIPTION } from "./perf-sql";
import { hasExecutableSql, splitStatements } from "./sql-guard";

/** The one key the draft is kept under. */
export const MIGRATION_DRAFT_KEY = "schema-studio:migration-draft";

/** What a Performance tab hands to the Script Editor. */
export type MigrationDraft = {
  /** The schema changes, each headed by its finding (buildFixScript's `changes`). */
  sql: string;
  /** The statements that undo them, last change first, or null when a change has none. */
  rollbackSql: string | null;
  /** One line for the migration's description. */
  description: string;
  /** The saved connection the findings came from: its id, as text, like the editor's picker. */
  connectionId: string;
  /**
   * The schema the migration is for: the one picked on the Performance tab.
   * Save leaves out every change to another schema, so each statement names
   * this one.
   */
  schema: string;
  /** When it was saved, as an ISO date. */
  createdAt: string;
};

/** This tab's sessionStorage, or null on the server or when the browser refuses it. */
function sessionStore(): Storage | null {
  try {
    if (typeof window === "undefined") return null;
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/** Keep the draft for the Script Editor. False when the browser would not store it. */
export function saveMigrationDraft(draft: MigrationDraft): boolean {
  const store = sessionStore();
  if (!store) return false;
  try {
    store.setItem(MIGRATION_DRAFT_KEY, JSON.stringify(draft));
    return true;
  } catch {
    // Refused, or the tab's storage is full.
    return false;
  }
}

/**
 * The stored draft exactly as it was saved, or null.
 *
 * The raw text rather than the parsed draft, on purpose. The Script Editor
 * reads it with useSyncExternalStore, which calls this on every render and
 * compares the answers with Object.is. The same text is equal to itself; a
 * freshly parsed object never is, and React would keep re-rendering.
 */
export function readMigrationDraftRaw(): string | null {
  const store = sessionStore();
  if (!store) return null;
  try {
    return store.getItem(MIGRATION_DRAFT_KEY);
  } catch {
    return null;
  }
}

/** Forget the draft. */
export function clearMigrationDraft(): void {
  const store = sessionStore();
  if (!store) return;
  try {
    store.removeItem(MIGRATION_DRAFT_KEY);
  } catch {
    // Nothing more to do. At worst the offer comes back the next time the
    // Script Editor opens in this tab, and can be discarded then.
  }
}

/**
 * The draft, checked, or null.
 *
 * What is in storage may be from an older version of the app, or edited by
 * hand (it is the person's own browser), so every field is checked for its
 * type. A draft with no statement to run, or no schema, is no draft.
 */
export function parseMigrationDraft(raw: string | null): MigrationDraft | null {
  if (raw === null) return null;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null) return null;
  const { sql, rollbackSql, description, connectionId, schema, createdAt } = data as Record<
    string,
    unknown
  >;
  if (
    typeof sql !== "string" ||
    !(rollbackSql === null || typeof rollbackSql === "string") ||
    typeof description !== "string" ||
    typeof connectionId !== "string" ||
    typeof schema !== "string" ||
    typeof createdAt !== "string"
  ) {
    return null;
  }
  if (!hasExecutableSql(sql) || schema.trim() === "") return null;
  return { sql, rollbackSql, description, connectionId, schema, createdAt };
}

/**
 * How many statements the SQL runs. The draft's comments (the header, each
 * finding's title and notes) are not statements and are not counted.
 */
export function draftStatementCount(sql: string): number {
  return splitStatements(sql).filter(hasExecutableSql).length;
}

/** What the Script Editor sets when the person loads the draft. */
export type DraftLoadPlan = {
  sql: string;
  /**
   * The rollback, or "" when the draft has none. An empty box rather than the
   * one already there: the old rollback undoes a different script.
   */
  rollbackSql: string;
  description: string;
  /**
   * Where to point the editor, or null when the draft's connection is not
   * among the saved ones (deleted since, say). Then the editor keeps its
   * target and the person picks one.
   */
  target: { connectionId: string; schema: string } | null;
  /**
   * True when the target moves, so the script family chosen for the old one
   * is cleared, exactly as picking another connection or schema by hand does.
   */
  resetFamily: boolean;
};

/** What loading `draft` into the editor does, given what the editor holds now. */
export function planDraftLoad(
  draft: MigrationDraft,
  editor: { connectionIds: string[]; connectionId: string; schema: string }
): DraftLoadPlan {
  const target = editor.connectionIds.includes(draft.connectionId)
    ? { connectionId: draft.connectionId, schema: draft.schema }
    : null;
  const moves =
    target !== null &&
    (target.connectionId !== editor.connectionId || target.schema !== editor.schema);
  return {
    sql: draft.sql,
    rollbackSql: draft.rollbackSql ?? "",
    // Saved within the limit, but storage can be edited by hand, and the push
    // route refuses a longer one.
    description: draft.description.slice(0, MAX_MIGRATION_DESCRIPTION),
    target,
    resetFamily: moves,
  };
}
