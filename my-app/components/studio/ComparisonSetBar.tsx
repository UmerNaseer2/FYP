"use client";

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Input } from "@/components/ui/Input";
import { AlertTriangleIcon, CheckIcon, ChevronDownIcon, TrashIcon } from "@/components/ui/icons";
import { timeAgo } from "@/lib/time-ago";
import { useUser } from "@/hooks/useUser";
import { refusalMessage } from "@/lib/permissions";
import {
  MAX_NAME_LENGTH,
  saveButtonLabel,
  setOptionLabel,
} from "@/lib/comparison-set-rules";
import { selectionToQuery, type CurrentSelection } from "@/lib/compare-selection";
import { apiFetch } from "@/lib/api-fetch";
import { useOrgHref } from "@/hooks/useOrg";

/**
 * Saved comparisons on the Compare page, in two parts:
 *
 * - "open": the "Saved comparisons" button at the top of the page. It opens a
 *   list of the saved ones, and picking one opens and runs it.
 * - "save": the "Save this comparison" row under the results, with the name
 *   box, Save (or Update) and Delete. Saving comes after a result, never
 *   before it.
 *
 * The page renders each part where it belongs with the `part` prop. Leaving
 * `part` out draws both together.
 *
 * A client island rather than part of the pickers' form, because saving writes
 * to the database and that form is a GET that must stay safe to reload,
 * bookmark and share. Opening a set is still just a navigation: the URL is
 * `/compare?set=<id>&run=1`, so a saved comparison is a link somebody can put
 * in a runbook, and re-saving the set changes what that link does.
 */

/** One entry in the picker. The page sends only what the bar draws. */
export type ComparisonSetOption = {
  id: number;
  name: string;
  targetCount: number;
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
  /** Which part to draw: "open", "save", or both when left out. */
  part?: "open" | "save";
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
  part,
}: Props) {
  const router = useRouter();
  const orgPath = useOrgHref();
  const currentQuery = useSearchParams().toString();
  const activeSet = sets.find((set) => set.id === activeSetId) ?? null;

  // Four boxes on the Roles tab, one for each thing this bar does: open a
  // saved set (Read), save a new one (Create), save over one (Update) and
  // delete one (Delete). The API refuses each of them on its own, and saying
  // so here beats a button that fails when it is pressed.
  const { roleLabel, loading, can } = useUser();
  const mayRead = can("comparison_sets:read");
  const mayCreate = can("comparison_sets:create");
  const mayUpdate = can("comparison_sets:update");
  const mayDelete = can("comparison_sets:delete");
  const mayWrite = mayCreate || mayUpdate;

  const [name, setName] = useState(activeSet?.name ?? "");
  const [busy, setBusy] = useState<"save" | "delete" | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The list of saved comparisons, open or closed.
  const [listOpen, setListOpen] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const listButtonRef = useRef<HTMLButtonElement>(null);
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
    router.push(orgPath(`/compare?${query}`));
  }

  function open(id: number) {
    if (!Number.isInteger(id) || id <= 0) return;
    setListOpen(false);
    goTo(`set=${id}&run=1`);
  }

  // While the list is open, a press anywhere outside it closes it.
  useEffect(() => {
    if (!listOpen) return;
    function onPress(event: MouseEvent) {
      if (listRef.current && !listRef.current.contains(event.target as Node)) setListOpen(false);
    }
    document.addEventListener("mousedown", onPress);
    return () => document.removeEventListener("mousedown", onPress);
  }, [listOpen]);

  // Escape closes the list and puts the keyboard back on its button.
  function onListKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (!listOpen || event.key !== "Escape") return;
    event.preventDefault();
    setListOpen(false);
    listButtonRef.current?.focus();
  }

  async function postSet(trimmed: string, overwrite: boolean) {
    const res = await apiFetch("/api/comparison-sets", {
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
          setError("Not saved. Pick a different name, or confirm to replace it.");
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
      const res = await apiFetch("/api/comparison-sets", {
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

  // A role that may not open saved sets has no use for this bar, so it is
  // left out, the way the rail leaves out a screen the role may not open. It
  // may not save one either: every box on the Roles tab brings its feature's
  // Read with it (effectivePermissions in lib/permissions). A link to a saved
  // set still says why it did not open: the page says so under the pickers.
  if (!loading && !mayRead) return null;

  // Save is one button for two boxes, so which one it needs depends on the
  // name, decided the way saveComparisonSet (lib/comparison-sets) decides it:
  // a name no saved set has makes a new set (Create), and a name a set already
  // has, whatever its capitals, saves over that set (Update), whether it is
  // the open one or another. It follows the name as it is typed, so a role
  // that may only create is told to pick a new name, and Save comes back the
  // moment it has one.
  const typed = name.trim().toLowerCase();
  const nameTaken =
    typed !== "" && sets.some((set) => set.name.trim().toLowerCase() === typed);
  const maySave = nameTaken ? mayUpdate : mayCreate;
  // Not while the session is still being read: that frame has no
  // permissions yet, and is not a role that may not save.
  const saveRefusal =
    loading || maySave
      ? null
      : nameTaken
        ? refusalMessage(roleLabel, "comparison_sets:update") +
          (mayCreate ? " Or save it under a new name." : "")
        : refusalMessage(roleLabel, "comparison_sets:create");

  // A set is open or a name is being typed: someone means to save. Until then
  // the line under Compare already says the changes are not applied, and a
  // second warning here for every picker change was only noise.
  const workingOnASet = activeSet !== null || name.trim() !== "";

  // One sentence under the bar, the one that matters most right now.
  let note: { text: string; tone: "error" | "warn" | "quiet" } | null = null;
  if (error) {
    note = { text: error, tone: "error" };
  } else if (activeSet?.hasMissingConnection) {
    note = {
      text: mayUpdate
        ? "A connection this set used has been deleted. Pick a replacement in the pickers, press Compare, then Update the set."
        : mayCreate
          ? "A connection this set used has been deleted. Pick a replacement in the pickers, press Compare, then save it under a new name."
          : "A connection this set used has been deleted. Someone whose role may update comparison sets can pick a replacement and update the set.",
      tone: "warn",
    };
  } else if (mayWrite && hasUnappliedChanges && workingOnASet) {
    note = {
      text: "Press Compare first. Save stores the selection as the page last loaded it, and your latest changes are not in it yet.",
      tone: "warn",
    };
  } else if (modified) {
    note = {
      text: mayUpdate
        ? "Changed since it was saved. Press Update to keep it, or reopen the set to go back."
        : mayCreate
          ? "Changed since it was saved. Save it under a new name to keep it, or reopen the set to go back."
          : "Changed since it was saved. Reopen the set to go back.",
      tone: "quiet",
    };
  } else if (saveRefusal) {
    note = { text: saveRefusal, tone: "quiet" };
  }

  const saveLabel =
    busy === "save" ? "Saving…" : saveButtonLabel(activeSet?.name ?? null, name);

  // Update with nothing changed would only write the set back as it is. The
  // name test is exact, so correcting a set's capitals still counts.
  const nothingToUpdate =
    activeSet !== null && !modified && name.trim() === activeSet.name;

  // The "Saved comparisons" button and the list it opens.
  const openPart = (
    <div className="cp-saved" ref={listRef} onKeyDown={onListKeyDown}>
      <button
        type="button"
        ref={listButtonRef}
        className="btn btn-secondary cp-saved__button"
        aria-haspopup="dialog"
        aria-expanded={listOpen}
        onClick={() => setListOpen((now) => !now)}
      >
        Saved comparisons
        {sets.length > 0 && <span className="cp-saved__count">{sets.length}</span>}
        <ChevronDownIcon size={14} />
      </button>
      {/* After a delete before any run the save row is not on the page, so
          the confirmation is said here instead. */}
      {part === "open" && !error && done && !asked && activeSetId === null && (
        <span className="cp-saved__done" role="status">
          {done}
        </span>
      )}
      {listOpen && (
        <div className="cp-saved__panel" role="dialog" aria-label="Saved comparisons">
          {sets.length === 0 ? (
            <p className="cp-saved__none">
              {mayCreate
                ? "None yet. Run a comparison, then name it and save it under the results."
                : "None saved yet."}
            </p>
          ) : (
            sets.map((set) => {
              // Everything worth knowing before opening it: targets, row
              // data, a deleted connection, and when it last ran.
              const label = setOptionLabel(set, ranAgo(set.lastRunAt));
              const isOpen = set.id === activeSet?.id;
              return (
                <button
                  key={set.id}
                  type="button"
                  className="cp-saved__row"
                  aria-label={label}
                  aria-current={isOpen ? "true" : undefined}
                  onClick={() => open(set.id)}
                >
                  <span className="cp-saved__tick" aria-hidden="true">
                    {isOpen && <CheckIcon size={14} />}
                  </span>
                  <span className="cp-saved__text">
                    <b>{set.name}</b>
                    <small>{label.slice(set.name.length).replace(/^ · /, "")}</small>
                  </span>
                </button>
              );
            })
          )}
        </div>
      )}
    </div>
  );

  // The "Save this comparison" row: name, Save, Delete, and one sentence.
  const savePart = (
    <div className="cp-save" role="group" aria-label="Save this comparison">
      <span className="cp-save__label">Save this comparison</span>
      <div className="cp-save__controls">
        <Input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Name this comparison…"
          aria-label="Comparison set name"
          maxLength={MAX_NAME_LENGTH}
          disabled={!mayWrite}
        />
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={() => void save()}
          disabled={busy !== null || hasUnappliedChanges || !maySave || nothingToUpdate}
          title={
            saveRefusal ??
            (hasUnappliedChanges
              ? "Press Compare first"
              : nothingToUpdate
                ? "Nothing to update. This is the comparison the set already holds."
                : undefined)
          }
        >
          {saveLabel}
        </button>
        {activeSet && mayDelete && (
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
          className="cp-save__note"
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
          describes the screen. The note about the change says more. */}
      {!error && done && !hasUnappliedChanges && !modified && (
        <div className="cp-save__note" role="status" style={{ color: "var(--text-3)" }}>
          {done}
        </div>
      )}
    </div>
  );

  if (part === "open") return openPart;
  if (part === "save") return savePart;
  return (
    <div className="cp-savedset">
      {openPart}
      {savePart}
    </div>
  );
}
