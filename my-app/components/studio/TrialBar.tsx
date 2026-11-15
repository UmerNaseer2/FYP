"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { ConfirmDialog } from "@/components/ui";
import { ChevronDownIcon, RefreshIcon, RouteIcon } from "@/components/ui/icons";
import { apiFetch } from "@/lib/api-fetch";
import { startTour } from "@/lib/tour";

/**
 * The one-line notice across the top of every page in the shared trial
 * organization. It says the trial is shared, and its "Trial options" button
 * opens a small menu:
 *
 * - "Take the tour" starts the app tour (lib/tour.ts) for anyone in the trial.
 * - "Reset trial", for the Trial Admin only, asks first and then posts to
 *   /api/trial/reset, which puts the organization and its demo databases back
 *   to how they started, keeping its GitHub and AI settings. Nothing resets
 *   the trial on a timer, so this is the only way back.
 *
 * Keyboard: Enter, Space or Down Arrow opens the menu on its first item. Up
 * and Down move (and wrap), Escape closes it and puts you back on the button,
 * Tab closes it and moves on. A click anywhere outside closes it too.
 */
export function TrialBar({ isAdmin }: { isAdmin: boolean }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  const items = () =>
    Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);

  // Opening puts you on the first item.
  useEffect(() => {
    if (menuOpen) items()[0]?.focus();
  }, [menuOpen]);

  // A click anywhere outside closes the menu.
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (event: MouseEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [menuOpen]);

  function onMenuKey(event: KeyboardEvent<HTMLDivElement>) {
    const list = items();
    const at = list.indexOf(document.activeElement as HTMLElement);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      list[(at + step + list.length) % list.length]?.focus();
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setMenuOpen(false);
      buttonRef.current?.focus();
    } else if (event.key === "Tab") {
      setMenuOpen(false);
    }
  }

  async function reset() {
    setBusy(true);
    setError(null);
    try {
      const response = await apiFetch("/api/trial/reset", { method: "POST" });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        setError(body?.error ?? "The trial could not be reset just now. Try again in a moment.");
        return;
      }
      window.location.reload();
    } catch {
      setError("Could not reach the server. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="trial-bar no-print" role="note">
      <p className="trial-bar-text" title="Shared trial. Others see what you change.">
        <b>Shared trial.</b> Others see what you change.
      </p>
      {error && (
        <span className="trial-bar-error" role="alert">
          {error}
        </span>
      )}
      <div className="trial-opt" ref={wrapRef}>
        <button
          ref={buttonRef}
          type="button"
          className="trial-opt-b"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-controls={menuId}
          aria-label={busy ? "Resetting the trial" : "Trial options"}
          disabled={busy}
          onClick={() => setMenuOpen((open) => !open)}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown" && !menuOpen) {
              event.preventDefault();
              setMenuOpen(true);
            }
          }}
        >
          {/* The words on a wide screen, three dots on a phone (globals.css). */}
          <span className="trial-opt-t">{busy ? "Resetting..." : "Trial options"}</span>
          <svg className="trial-opt-dots" width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <circle cx="5" cy="12" r="1.6" />
            <circle cx="12" cy="12" r="1.6" />
            <circle cx="19" cy="12" r="1.6" />
          </svg>
          <ChevronDownIcon size={14} className="trial-opt-chev" />
        </button>
        <div
          ref={menuRef}
          id={menuId}
          className="who-m trial-opt-m"
          role="menu"
          aria-label="Trial options"
          hidden={!menuOpen}
          onKeyDown={onMenuKey}
        >
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            onClick={() => {
              setMenuOpen(false);
              startTour();
            }}
          >
            <span>Take the tour</span>
            <RouteIcon size={15} />
          </button>
          {isAdmin && (
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              onClick={() => {
                setMenuOpen(false);
                // The menu item goes away; the confirm dialog hands focus back
                // to the trial button when it closes.
                buttonRef.current?.focus();
                setAsking(true);
              }}
            >
              <span>Reset trial</span>
              <RefreshIcon size={15} />
            </button>
          )}
        </div>
      </div>
      <ConfirmDialog
        open={asking}
        onClose={() => setAsking(false)}
        onConfirm={() => void reset()}
        title="Reset the trial?"
        description="Every script, request, run and role change in the trial goes, and the demo schemas are built again from the start. The GitHub token and AI settings stay. Anyone else in the trial right now will see it start over."
        confirmLabel="Reset trial"
        destructive
      />
    </div>
  );
}
