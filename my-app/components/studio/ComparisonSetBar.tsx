"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Select } from "@/components/ui/Select";
import { Input } from "@/components/ui/Input";
import { AlertTriangleIcon, TrashIcon } from "@/components/ui/icons";
import { timeAgo } from "@/lib/time-ago";
import { useUser } from "@/hooks/useUser";
import { roleAtLeast } from "@/lib/auth-mode";
import {
  MAX_NAME_LENGTH,
  saveButtonLabel,
  setOptionLabel,
} from "@/lib/comparison-set-rules";
import { selectionToQuery, type CurrentSelection } from "@/lib/compare-selection";

/**
 * The saved-set bar above the Compare pickers: open a saved comparison, save
 * the one on screen, or delete one.
 *
 * A client island rather than part of the pickers' form, because saving writes
 * to the database and that form is a GET that must stay safe to reload,
 * bookmark and share. Opening a set is still just a navigation — the URL is
 * `/compare?set=<id>&run=1`, so a saved comparison is a link somebody can put
 * in a runbook, and re-saving the set changes what that link does.
 */

/** One entry in the picker. The page sends only what the bar draws. */
export type ComparisonSetOption = {
  id: number;
  name: string;
  targetCount: number;
  /** True when the source or any target points at a production database. */
  hasProduction: boolean;
  /** True when the set also compares table rows — slower, and it reads data. */
  compareData: boolean;
  /** True when a connection this set used has since been deleted. */
  hasMissingConnection: boolean;
  lastRunAt: string | null;
};

type Props = {
  sets: ComparisonSetOption[];
  /** The set the current URL was opened from, if any. */
  activeSetId: number | null;
  /** True when the on-screen selection no longer matches the saved set. */
  modified: boolean;
  /** The selection the page last loaded, which is what Save writes. */
  selection: CurrentSelection;
  /**
   * True while a picker or a box has been changed and Compare not yet pressed.
   * Save writes `selection`, which does not have those changes in it, so it
   * waits — saving then would store something other than what the reader sees.
   */
  hasUnappliedChanges: boolean;
  /**
   * Whether the comparison on screen was actually run. Saving or deleting
   * lands on a URL for the same selection, and that URL runs it again only if
   * it had been run — a set saved from untouched defaults stays unrun.
   */
  asked: boolean;
  /**
   * Reload the screen's data. The Compare screen fetches its own comparison, so
   * a router refresh would leave the set list showing the name it had before
   * Save. Server-rendered callers can leave this out and get router.refresh().
   */
  onDone?: () => void;
};

/**
 * Two query strings that mean the same thing, whatever order they were written
 * in — `?set=3&run=1` and `?run=1&set=3` open the same comparison.
 */
function sameQuery(a: string, b: string): boolean {
  const normalize = (query: string) => {
    const params = new URLSearchParams(query);
    params.sort();
    return params.toString();
  };
  return normalize(a) === normalize(b);
}

function ranAgo(iso: string | null): string {
  if (!iso) return "never run";
  const rel = timeAgo(iso);
  // timeAgo returns "—" for an unparseable timestamp, which reads as a gap in
  // the sentence rather than an answer. "never run" is the honest fallback.
  return rel === "—" ? "never run" : `run ${rel}`;
}

/**
 * The confirmation a save or delete leaves for the bar that comes after it.
 *
 * Both end in a navigation, and the Compare screen remounts on every new URL
 * (page.tsx keys it by the query), so a message kept only in this bar's state
 * was thrown away with the bar before anyone saw it — Save worked and said
 * nothing. The next bar picks it up, and only if it opened on the set the
 * message is about.
 */
let noticeForNextBar: { setId: number | null; text: string } | null = null;

/** The set a Compare query opens, or null when it names none. */
function setIdIn(query: string): number | null {
  const id = Number(new URLSearchParams(query).get("set"));
  return Number.isInteger(id) && id > 0 ? id : null;
}

export function ComparisonSetBar({
  sets,
  activeSetId,
  modified,
  selection,
  hasUnappliedChanges,
  asked,
  onDone,
}: Props) {
  const router = useRouter();
  const currentQuery = useSearchParams().toString();
  const activeSet = sets.find((set) => set.id === activeSetId) ?? null;

  // Saving and deleting are editor actions, and the API refuses them for a
  // viewer. Saying so here beats a button that fails with "Forbidden".
  const { role, loading } = useUser();
  const canEdit = !loading && roleAtLeast(role, "editor");

  const [name, setName] = useState(activeSet?.name ?? "");
  const [busy, setBusy] = useState<"save" | "delete" | null>(null);
  const [error, setError] = useState<string | null>(null);
  // What the last save or delete did, in words. It starts with the message a
  // save or delete on the previous screen left for this one.
  const [done, setDone] = useState<string | null>(() =>
    noticeForNextBar !== null && noticeForNextBar.setId === activeSetId
      ? noticeForNextBar.text
      : null,
  );

  // Shown once: every new URL has either read it by now or is not about it.
  useEffect(() => {
    noticeForNextBar = null;
  }, [currentQuery]);

  // A reload of the same URL (Update on the set that is open) keeps this bar
  // mounted, and the set can come back under a new name — "Orders" saved over
  // "orders". The name box follows it, or the next Save would write the old
  // name back.
  useEffect(() => {
    setName(activeSet?.name ?? "");
    setError(null);
  }, [activeSet?.id, activeSet?.name]);

  /**
   * Show the comparison `query` describes.
   *
   * Normally a navigation — the URL is the selection, so every one of these is
   * a link somebody could have typed. Pushing the URL we are already on does
   * nothing, though, and re-saving a set under a new name lands exactly there,
   * so that case reloads the screen instead.
   *
   * `notice` is what to tell the reader once the new screen is up.
   */
  function goTo(query: string, notice: string | null = null) {
    if (sameQuery(query, currentQuery)) {
      // Same URL, so this bar stays mounted and keeps its own message.
      if (onDone) onDone();
      else router.refresh();
      return;
    }
    noticeForNextBar = notice === null ? null : { setId: setIdIn(query), text: notice };
    router.push(`/compare?${query}`);
  }

  function open(value: string) {
    const id = Number(value);
    if (!Number.isInteger(id) || id <= 0) return;
    goTo(`set=${id}&run=1`);
  }

  async function postSet(trimmed: string, overwrite: boolean) {
    const res = await fetch("/api/comparison-sets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...selection,
        name: trimmed,
        // The set that is open, so saving over it is an update rather than
        // a clash with its own name.
        id: activeSet?.id ?? null,
        overwrite,
      }),
    });
    const data = await res.json().catch(() => null);
    return { res, data };
  }

  async function save() {
    const trimmed = name.trim();
    if (trimmed.length === 0) {
      setError("Give the set a name so you can find it again.");
      return;
    }
    setBusy("save");
    setError(null);
    setDone(null);
    try {
      let { res, data } = await postSet(trimmed, false);
      if (res.status === 409 && data?.conflict) {
        // The name belongs to a different set. Replacing somebody's saved
        // comparison is the reader's call, not something Save does quietly.
        const replace = window.confirm(
          `A saved set called "${trimmed}" already exists. Replace it with the comparison on screen?`,
        );
        if (!replace) {
          setError("Not saved — pick a different name, or confirm to replace it.");
          return;
        }
        ({ res, data } = await postSet(trimmed, true));
      }
      if (!res.ok) {
        setError(data?.error ?? "Could not save that comparison set.");
        return;
      }
      const notice = data?.created ? `Saved "${trimmed}".` : `Updated "${trimmed}".`;
      setDone(notice);
      // Land on the set we just wrote, so the bar shows it as open and the
      // "changed since saved" hint clears.
      goTo(`set=${data.set.id}${asked ? "&run=1" : ""}`, notice);
    } catch {
      setError("Network error while saving the set.");
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    if (!activeSet) return;
    const confirmed = window.confirm(
      `Delete the saved set "${activeSet.name}"? The comparison on screen stays; only the saved set is removed.`,
    );
    if (!confirmed) return;
    setBusy("delete");
    setError(null);
    setDone(null);
    try {
      const res = await fetch("/api/comparison-sets", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: activeSet.id }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setError(data?.error ?? "Could not delete that comparison set.");
        return;
      }
      // The selection stays on screen — deleting the bookmark should not throw
      // away the comparison you are looking at. It is spelled out in the URL
      // because the set that used to describe it is gone.
      goTo(
        `${selectionToQuery(selection)}${asked ? "&run=1" : ""}`,
        `Deleted "${activeSet.name}".`,
      );
    } catch {
      setError("Network error while deleting the set.");
    } finally {
      setBusy(null);
    }
  }

  const options = sets.map((set) => ({
    value: String(set.id),
    label: setOptionLabel(set, ranAgo(set.lastRunAt)),
  }));

  // One sentence under the bar, the one that matters most right now.
  let note: { text: string; tone: "error" | "warn" | "quiet" } | null = null;
  if (error) {
    note = { text: error, tone: "error" };
  } else if (activeSet?.hasMissingConnection) {
    note = {
      text: canEdit
        ? "A connection this set used has been deleted. Pick a replacement below, press Compare, then Update the set."
        : "A connection this set used has been deleted. An editor can pick a replacement and update the set.",
      tone: "warn",
    };
  } else if (canEdit && hasUnappliedChanges) {
    note = {
      text: "Press Compare first — Save stores the selection as the page last loaded it, and your latest changes are not in it yet.",
      tone: "warn",
    };
  } else if (modified) {
    note = {
      text: canEdit
        ? "Changed since it was saved — press Update to keep it, or reopen the set to go back."
        : "Changed since it was saved — reopen the set to go back.",
      tone: "quiet",
    };
  } else if (!loading && !canEdit) {
    note = { text: "Only editors can save or delete comparison sets.", tone: "quiet" };
  }

  const saveLabel =
    busy === "save" ? "Saving…" : saveButtonLabel(activeSet?.name ?? null, name);

  // Update with nothing changed would only write the set back as it is. The
  // name test is exact, so correcting a set's capitals still counts.
  const nothingToUpdate =
    activeSet !== null && !modified && name.trim() === activeSet.name;

  return (
    <div className="set-bar">
      <div className="set-bar__side">
        <span className="set-bar__label">Saved sets</span>
        {sets.length === 0 ? (
          <span className="text-[12.5px]" style={{ color: "var(--text-3)" }}>
            {canEdit
              ? "None yet — set up a comparison below, then name it and save it."
              : "None saved yet."}
          </span>
        ) : (
          // The open set's last run is already in its label, so it is not
          // repeated beside the picker.
          <Select
            value={activeSet ? String(activeSet.id) : ""}
            options={options}
            onChange={open}
            placeholder="Open a saved set…"
            variant="input"
            ariaLabel="Open a saved comparison set"
          />
        )}
      </div>

      <div className="set-bar__side set-bar__side--end">
        <Input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Name this comparison…"
          aria-label="Comparison set name"
          maxLength={MAX_NAME_LENGTH}
          disabled={!canEdit}
        />
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={() => void save()}
          disabled={busy !== null || hasUnappliedChanges || !canEdit || nothingToUpdate}
          title={
            !canEdit
              ? "Only editors can save comparison sets"
              : hasUnappliedChanges
                ? "Press Compare first"
                : nothingToUpdate
                  ? "Nothing to update — this is the comparison the set already holds"
                  : undefined
          }
        >
          {saveLabel}
        </button>
        {activeSet && canEdit && (
          <button
            type="button"
            className="btn btn-ghost btn-icon"
            onClick={() => void remove()}
            disabled={busy !== null}
            title={`Delete "${activeSet.name}"`}
            aria-label={`Delete the set "${activeSet.name}"`}
          >
            <TrashIcon size={14} />
          </button>
        )}
      </div>

      {note && (
        <div
          className="set-bar__note"
          role={note.tone === "error" ? "alert" : undefined}
          style={{
            color:
              note.tone === "error"
                ? "var(--break)"
                : note.tone === "warn"
                  ? "var(--drift)"
                  : "var(--text-3)",
          }}
        >
          {note.tone === "warn" && <AlertTriangleIcon size={12} />}
          {note.text}
        </div>
      )}
      {/* Once the comparison is changed again, the confirmation no longer
          describes the screen — the note about the change says more. */}
      {!error && done && !hasUnappliedChanges && !modified && (
        <div className="set-bar__note" role="status" style={{ color: "var(--text-3)" }}>
          {done}
        </div>
      )}
    </div>
  );
}
