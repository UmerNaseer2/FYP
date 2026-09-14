"use client";

import { useMemo, useSyncExternalStore } from "react";
import {
  parseMigrationDraft,
  readMigrationDraftRaw,
  type MigrationDraft,
} from "@/lib/migration-draft";

/**
 * Nothing to subscribe to. The draft sits in this tab's sessionStorage, and
 * while the Script Editor is open only its own Load and Discard buttons change
 * it, and those re-render the page themselves. Defined once, out here, so
 * React sees the same function on every render and never re-subscribes.
 */
const subscribe = () => () => {};

/** What the server, and the first render in the browser, see: no draft. */
const serverSnapshot = () => null;

/**
 * The migration a Performance tab left for the Script Editor, or null.
 *
 * Read with useSyncExternalStore rather than useState plus an effect. The
 * server has no sessionStorage, so the server render and the browser's first
 * render both use serverSnapshot (null) and agree, which keeps hydration
 * clean. React then reads the real value and re-renders with it by itself,
 * with no setState inside an effect. Opened from another page, the browser
 * reads the real value straight away.
 *
 * The store hands back the raw text (see readMigrationDraftRaw for why), and
 * it is parsed here only when that text changes.
 */
export function useMigrationDraft(): MigrationDraft | null {
  const raw = useSyncExternalStore(subscribe, readMigrationDraftRaw, serverSnapshot);
  return useMemo(() => parseMigrationDraft(raw), [raw]);
}
