import type { CompareScreen } from "@/lib/compare-run";

// What Compare was showing, so leaving the page and coming back finds it as it
// was: the same two schemas picked, the same result on screen, the same tile
// pressed and the same script edits.
//
// Two places, for two kinds of leaving:
//   - In memory, the whole result. It lasts while the app stays loaded, which
//     covers every move made inside the app (the rail, a link, Back). Coming
//     back shows it at once and checks it again quietly.
//   - In the tab's sessionStorage, only the query string (connection ids and
//     schema names, no data). It lasts through a reload, after which the
//     comparison simply runs again from it.
//
// Every read and write is in the browser only. On the server this module is
// shared by every request, so it must never hold anything there.

type Filter = "add" | "chg" | "rem" | "same";

/** A target's script as the reader left it, and the generated script it was edited from. */
export type ScriptDraft = {
  base: string;
  baseDown: string;
  up: string;
  down: string;
};

type Memory = {
  query: string;
  screen: CompareScreen | null;
  filters: Record<number, Filter | null>;
  drafts: Record<number, ScriptDraft>;
};

const memory = new Map<string, Memory>();
/** The query Compare is about to be sent back to, by organization. */
const restoring = new Map<string, string>();

const storageKey = (org: string) => `schema-studio:compare-last:${org}`;
const inBrowser = () => typeof window !== "undefined";

/** Note the comparison now on screen. A different one starts a fresh memory. */
export function rememberQuery(org: string, query: string): void {
  if (!inBrowser() || query === "") return;
  if (memory.get(org)?.query !== query) {
    memory.set(org, { query, screen: null, filters: {}, drafts: {} });
  }
  if (restoring.get(org) !== query) restoring.delete(org);
  try {
    window.sessionStorage.setItem(storageKey(org), query);
  } catch {
    /* storage is off: the memory lasts until the next reload */
  }
}

export function rememberScreen(org: string, query: string, screen: CompareScreen): void {
  const kept = inBrowser() ? memory.get(org) : undefined;
  if (kept && kept.query === query) kept.screen = screen;
}

export function rememberFilters(
  org: string,
  query: string,
  filters: Record<number, Filter | null>,
): void {
  const kept = inBrowser() ? memory.get(org) : undefined;
  if (kept && kept.query === query) kept.filters = filters;
}

export function rememberDraft(org: string, query: string, index: number, draft: ScriptDraft): void {
  const kept = inBrowser() ? memory.get(org) : undefined;
  if (!kept || kept.query !== query) return;
  if (draft.up === draft.base && draft.down === draft.baseDown) delete kept.drafts[index];
  else kept.drafts[index] = draft;
}

/** What was kept for exactly this comparison, or null. */
export function recall(
  org: string,
  query: string,
): { screen: CompareScreen | null; filters: Record<number, Filter | null>; drafts: Record<number, ScriptDraft> } | null {
  const kept = inBrowser() ? memory.get(org) : undefined;
  if (!kept || kept.query !== query) return null;
  return { screen: kept.screen, filters: { ...kept.filters }, drafts: kept.drafts };
}

/** The last comparison's query, from memory or from the tab after a reload. */
export function recallQuery(org: string): string | null {
  if (!inBrowser()) return null;
  const kept = memory.get(org)?.query;
  if (kept) return kept;
  try {
    return window.sessionStorage.getItem(storageKey(org)) || null;
  } catch {
    return null;
  }
}

/** True while memory holds a comparison for this organization (no storage read, so safe in a first render). */
export function hasMemory(org: string): boolean {
  return inBrowser() && memory.has(org);
}

/**
 * Compare is being sent back to `query` because the reader came back to it,
 * not because they pressed Compare. That visit must not count as a run.
 */
export function markRestoring(org: string, query: string): void {
  if (inBrowser()) restoring.set(org, query);
}

export function isRestoring(org: string, query: string): boolean {
  return inBrowser() && restoring.get(org) === query;
}

/** Start over: forget the last comparison everywhere. */
export function forgetCompare(org: string): void {
  if (!inBrowser()) return;
  memory.delete(org);
  restoring.delete(org);
  try {
    window.sessionStorage.removeItem(storageKey(org));
  } catch {
    /* storage is off: nothing was kept there */
  }
}

/** A short stand-in for a whole script, to tell two scripts apart in a React key. */
export function scriptKey(text: string): string {
  let hash = 5381;
  for (let i = 0; i < text.length; i += 1) hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
  return `${text.length}-${(hash >>> 0).toString(36)}`;
}
