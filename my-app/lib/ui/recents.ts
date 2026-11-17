// Recents: the last few pages, schemas and actions someone opened, kept in
// this browser's localStorage so the command bar (Ctrl K) can offer a quick
// way back to them.
//
// One list per organization, newest first, no duplicates, at most
// MAX_RECENTS entries. Nothing here touches `window` until a function is
// called, and every read and write is wrapped in try/catch, so it is safe on
// the server, in private windows and when storage is blocked: the list is
// then simply empty.

import { orgSlugFromPath } from "@/lib/orgs/slug";

export type RecentKind = "page" | "schema" | "action";

export type Recent = {
  kind: RecentKind;
  /** What the command bar shows, such as "Drift" or "university". */
  label: string;
  /**
   * Where it goes. For a page or a schema this is an address inside the app
   * ("/acme/drift"). An action that is not a link uses its command id
   * instead ("act:theme").
   */
  href: string;
};

/** The most entries kept for one organization. */
export const MAX_RECENTS = 8;

const KEY_PREFIX = "schema-studio:recents:";

/** The storage key for one organization (or the shared one when there is none). */
function keyFor(orgSlug: string | null | undefined): string {
  return KEY_PREFIX + (orgSlug || "_");
}

/** The organization in the address bar, or null on the server or outside one. */
function currentOrgSlug(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return orgSlugFromPath(window.location.pathname);
  } catch {
    return null;
  }
}

function isRecent(value: unknown): value is Recent {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    (entry.kind === "page" || entry.kind === "schema" || entry.kind === "action") &&
    typeof entry.label === "string" &&
    entry.label.length > 0 &&
    typeof entry.href === "string" &&
    entry.href.length > 0
  );
}

/**
 * The saved list for an organization, newest first. Leave `orgSlug` out to
 * use the organization in the address bar. Anything unreadable gives [].
 */
export function readRecents(orgSlug?: string | null): Recent[] {
  if (typeof window === "undefined") return [];
  try {
    const slug = orgSlug === undefined ? currentOrgSlug() : orgSlug;
    const saved: unknown = JSON.parse(window.localStorage.getItem(keyFor(slug)) ?? "[]");
    if (!Array.isArray(saved)) return [];
    return saved
      .filter(isRecent)
      .map(({ kind, label, href }) => ({ kind, label, href }))
      .slice(0, MAX_RECENTS);
  } catch {
    // Storage blocked or the saved text is not JSON: start from nothing.
    return [];
  }
}

/**
 * Put one entry at the top of the list. An entry of the same kind with the
 * same address is replaced, so the list never repeats itself.
 */
export function recordRecent(entry: Recent, orgSlug?: string | null): void {
  if (typeof window === "undefined" || !isRecent(entry)) return;
  try {
    const slug = orgSlug === undefined ? currentOrgSlug() : orgSlug;
    const rest = readRecents(slug).filter((each) => !(each.kind === entry.kind && each.href === entry.href));
    const next = [{ kind: entry.kind, label: entry.label, href: entry.href }, ...rest].slice(0, MAX_RECENTS);
    window.localStorage.setItem(keyFor(slug), JSON.stringify(next));
  } catch {
    // Storage blocked or full: the list just stays as it was.
  }
}

/** Forget the list for an organization. */
export function clearRecents(orgSlug?: string | null): void {
  if (typeof window === "undefined") return;
  try {
    const slug = orgSlug === undefined ? currentOrgSlug() : orgSlug;
    window.localStorage.removeItem(keyFor(slug));
  } catch {
    // Nothing to do.
  }
}

/**
 * Forget every organization's list in this browser. Sign out calls it, so the
 * next person to sign in here never sees where the last one went.
 */
export function forgetAllRecents(): void {
  if (typeof window === "undefined") return;
  try {
    const storage = window.localStorage;
    const keys: string[] = [];
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key && key.startsWith(KEY_PREFIX)) keys.push(key);
    }
    keys.forEach((key) => storage.removeItem(key));
  } catch {
    // Storage blocked: there is nothing kept to forget.
  }
}
