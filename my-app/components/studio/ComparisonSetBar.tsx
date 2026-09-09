"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Select } from "@/components/ui/Select";
import { Input } from "@/components/ui/Input";
import { AlertTriangleIcon, TrashIcon } from "@/components/ui/icons";
import { timeAgo } from "@/lib/time-ago";

/**
 * The saved-set bar above the Compare pickers: open a saved comparison, save
 * the one on screen, or delete one.
 *
 * A client island rather than another form-GET, because saving writes to the
 * database and the rest of this page is a GET that must stay safe to reload,
 * bookmark and share. Opening a set is still just a navigation — the URL is
 * `/compare?set=<id>&run=1`, so a saved comparison is a link somebody can put
 * in a runbook, and re-saving the set changes what that link does.
 */

/** One entry in the picker. The page sends only what the bar draws. */
export type ComparisonSetOption = {
  id: number;
  name: string;
  targetCount: number;
  /** True when any member of the set points at a production database. */
  hasProduction: boolean;
  /** True when a connection this set used has since been deleted. */
  hasMissingConnection: boolean;
  lastRunAt: string | null;
};

/** The selection currently on screen, which is what Save writes. */
export type CurrentSelection = {
  sourceConnectionId: number | null;
  sourceConnectionLabel: string;
  sourceSchema: string;
  allowDataLoss: boolean;
  targets: { connectionId: number | null; connectionLabel: string; schema: string }[];
};

type Props = {
  sets: ComparisonSetOption[];
  /** The set the current URL was opened from, if any. */
  activeSetId: number | null;
  /** True when the on-screen selection no longer matches the saved set. */
  modified: boolean;
  selection: CurrentSelection;
  /**
   * False in the .env fallback, where there are no saved connections to point
   * a set at. Saving there would store a selection that cannot be restored.
   */
  canSave: boolean;
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

export function ComparisonSetBar({
  sets,
  activeSetId,
  modified,
  selection,
  canSave,
  onDone,
}: Props) {
  const router = useRouter();
  const currentQuery = useSearchParams().toString();
  const activeSet = sets.find((set) => set.id === activeSetId) ?? null;

  const [name, setName] = useState(activeSet?.name ?? "");
  const [busy, setBusy] = useState<"save" | "delete" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  // Opening a different set (a navigation, not a remount) has to move the name
  // box with it, or Save would silently overwrite the set you just left.
  useEffect(() => {
    setName(activeSet?.name ?? "");
    setError(null);
    setSaved(null);
  }, [activeSet?.id, activeSet?.name]);

  /**
   * Show the comparison `query` describes.
   *
   * Normally a navigation — the URL is the selection, so every one of these is
   * a link somebody could have typed. Pushing the URL we are already on does
   * nothing, though, and re-saving a set under a new name lands exactly there,
   * so that case reloads the screen instead.
   */
  function goTo(query: string) {
    if (sameQuery(query, currentQuery)) {
      if (onDone) onDone();
      else router.refresh();
      return;
    }
    router.push(`/compare?${query}`);
  }

  function open(value: string) {
    const id = Number(value);
    if (!Number.isInteger(id) || id <= 0) return;
    goTo(`set=${id}&run=1`);
  }

  async function save() {
    const trimmed = name.trim();
    if (trimmed.length === 0) {
      setError("Give the set a name so you can find it again.");
      return;
    }
    setBusy("save");
    setError(null);
    setSaved(null);
    try {
      const res = await fetch("/api/comparison-sets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...selection, name: trimmed }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setError(data?.error ?? "Could not save that comparison set.");
        return;
      }
      setSaved(data?.created ? `Saved "${trimmed}".` : `Updated "${trimmed}".`);
      // Land on the set we just wrote, so the bar shows it as open and the
      // "changed since saved" hint clears.
      goTo(`set=${data.set.id}&run=1`);
    } catch {
      setError("Network error while saving the set.");
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    if (!activeSet) return;
    setBusy("delete");
    setError(null);
    setSaved(null);
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
      // away the comparison you are looking at.
      goTo("run=1");
    } catch {
      setError("Network error while deleting the set.");
    } finally {
      setBusy(null);
    }
  }

  const options = sets.map((set) => ({
    value: String(set.id),
    label: `${set.name} · ${set.targetCount} target${set.targetCount === 1 ? "" : "s"}${
      set.hasProduction ? " · prod" : ""
    }`,
  }));

  return (
    <div className="set-bar">
      <div className="set-bar__side">
        <span className="set-bar__label">Saved sets</span>
        {sets.length === 0 ? (
          <span className="text-[12.5px]" style={{ color: "var(--text-3)" }}>
            None yet — set up a comparison below, then name it and save it.
          </span>
        ) : (
          <>
            <Select
              value={activeSet ? String(activeSet.id) : ""}
              options={options}
              onChange={open}
              placeholder="Open a saved set…"
              variant="input"
              ariaLabel="Open a saved comparison set"
            />
            {activeSet && (
              <span className="text-[12px]" style={{ color: "var(--text-3)" }}>
                {ranAgo(activeSet.lastRunAt)}
              </span>
            )}
          </>
        )}
      </div>

      {canSave && (
        <div className="set-bar__side set-bar__side--end">
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Name this comparison…"
            aria-label="Comparison set name"
            maxLength={60}
          />
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => void save()}
            disabled={busy !== null}
          >
            {busy === "save" ? "Saving…" : activeSet && name.trim() === activeSet.name ? "Update" : "Save"}
          </button>
          {activeSet && (
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
      )}

      {/* Three states worth a sentence, in order of how much they matter. */}
      {error && (
        <div className="set-bar__note" style={{ color: "var(--break)" }}>
          {error}
        </div>
      )}
      {!error && activeSet?.hasMissingConnection && (
        <div className="set-bar__note" style={{ color: "var(--drift)" }}>
          <AlertTriangleIcon size={12} />
          A connection this set used has been deleted. Pick a replacement below,
          then Update the set.
        </div>
      )}
      {!error && !activeSet?.hasMissingConnection && modified && (
        <div className="set-bar__note" style={{ color: "var(--text-3)" }}>
          Changed since it was saved — press Update to keep it, or reopen the set
          to go back.
        </div>
      )}
      {!error && saved && (
        <div className="set-bar__note" style={{ color: "var(--text-3)" }}>
          {saved}
        </div>
      )}
    </div>
  );
}
