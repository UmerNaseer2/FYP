"use client";

import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { CheckIcon, ClipboardIcon, RefreshIcon, XIcon } from "@/components/ui/icons";
import { countOf } from "@/lib/ui/plural";
import { scriptSteps } from "@/lib/versions/script-steps";

// The migration script over the whole window. It edits the same text as the
// side panel (the Workbench owns it), so closing keeps every edit. Beside the
// editor, the statements in the order they run; pressing one moves the editor
// to it. A dialog: Esc closes it, Tab stays inside, the page behind holds still,
// and focus goes back to whatever opened it.

const SIGN = { add: "+", chg: "~", rem: "−" } as const;

export type ScriptFullScreenProps = {
  /** Where the script runs, shown as "modifies …". */
  targetLabel: string;
  showingDown: boolean;
  onPane: (pane: "up" | "down") => void;
  /** The script on screen: the migration or the rollback. */
  sql: string;
  onEdit: (text: string) => void;
  onReset: () => void;
  onCopy: () => void;
  copied: boolean;
  /** The line and statement tally the side panel shows under its editor. */
  tally: ReactNode;
  onClose: () => void;
};

export function ScriptFullScreen({
  targetLabel,
  showingDown,
  onPane,
  sql,
  onEdit,
  onReset,
  onCopy,
  copied,
  tally,
  onClose,
}: ScriptFullScreenProps) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const gutterRef = useRef<HTMLPreElement>(null);
  const [current, setCurrent] = useState<number | null>(null);

  const steps = useMemo(() => scriptSteps(sql), [sql]);
  // Held back statements count, as they do in the tally under the editor;
  // a note with nothing under it does not.
  const statements = steps.filter((step) => step.idle !== "note").length;
  const held = steps.filter((step) => step.idle === "held").length;
  const lineCount = sql.split("\n").length;
  const numbers = useMemo(
    () => Array.from({ length: lineCount }, (_, i) => String(i + 1)).join("\n"),
    [lineCount],
  );

  // Opening: hold the page still and put the caret in the editor. Closing:
  // give the page its scroll back and focus to the button that opened this.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const before = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    editorRef.current?.focus({ preventScroll: true });
    return () => {
      document.body.style.overflow = before;
      opener?.focus?.({ preventScroll: true });
    };
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const items = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), textarea, [href], [tabindex]:not([tabindex="-1"])',
        ),
      );
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  function goTo(index: number) {
    const step = steps[index];
    const editor = editorRef.current;
    if (!step || !editor) return;
    setCurrent(index);
    editor.focus({ preventScroll: true });
    editor.setSelectionRange(step.offset, step.offset);
    // Two lines of context above the statement.
    const lineHeight = parseFloat(getComputedStyle(editor).lineHeight) || 23;
    editor.scrollTop = Math.max(0, (step.line - 3) * lineHeight);
    editor.scrollLeft = 0;
    // The scroll event that keeps the line numbers level comes a frame later.
    if (gutterRef.current) gutterRef.current.scrollTop = editor.scrollTop;
  }

  function switchPane(pane: "up" | "down") {
    setCurrent(null);
    onPane(pane);
  }

  return createPortal(
    <div
      ref={dialogRef}
      className="cp-scriptfull"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
    >
      <div className="cp-scriptfull__box">
        <header className="cp-scriptfull__head">
          <h2 id={titleId} className="cp-scriptfull__title">
            Generated migration
          </h2>
          <span className="pill pill-neutral">
            <span className="dot" style={{ background: "var(--text-3)" }} />
            draft
          </span>
          <span className="cp-scriptfull__target">
            modifies <span className="mono">{targetLabel}</span>
          </span>
          <span className="cp-scriptfull__spacer" />
          <div className="seg" role="tablist" aria-label="Script direction">
            <button
              type="button"
              role="tab"
              aria-selected={!showingDown}
              className={showingDown ? "" : "active"}
              onClick={() => switchPane("up")}
            >
              Migration
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={showingDown}
              className={showingDown ? "active" : ""}
              onClick={() => switchPane("down")}
            >
              Rollback
            </button>
          </div>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={onReset}
            title="Discard edits in this pane and restore the generated script"
          >
            <RefreshIcon size={12} />
            Reset
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onCopy}>
            {copied ? <CheckIcon size={12} /> : <ClipboardIcon size={12} />}
            {copied ? "Copied" : "Copy"}
          </button>
          <button type="button" className="btn btn-primary btn-sm" onClick={onClose}>
            <XIcon size={14} />
            Close <span className="cp-map__kbd">Esc</span>
          </button>
        </header>

        <div className="cp-scriptfull__main">
          {steps.length > 0 && (
            <nav className="cp-scriptfull__steps" aria-label="Statements in the script">
              <span className="cp-scriptfull__stepshead">
                {countOf(statements, "statement")}, in run order
                {held > 0 && <> · {held} held back</>}
              </span>
              {steps.map((step, index) => (
                <button
                  key={`${step.offset}-${index}`}
                  type="button"
                  className={step.idle ? "cp-scriptfull__step is-idle" : "cp-scriptfull__step"}
                  aria-current={current === index ? "step" : undefined}
                  onClick={() => goTo(index)}
                >
                  <span className={`cp-scriptfull__sign is-${step.kind}`} aria-hidden="true">
                    {SIGN[step.kind]}
                  </span>
                  <span className="cp-scriptfull__steptext">
                    <span className="cp-scriptfull__steplabel">{step.label}</span>
                    <span className="cp-scriptfull__stepline">
                      Line {step.line}
                      {step.idle === "held" && " · held back, will not run"}
                      {step.idle === "note" && " · note, nothing to run"}
                    </span>
                  </span>
                </button>
              ))}
            </nav>
          )}

          <div className="cp-scriptfull__work">
            <div className="cp-scriptfull__code">
              <pre ref={gutterRef} className="cp-scriptfull__gutter" aria-hidden="true">
                {numbers}
              </pre>
              <textarea
                ref={editorRef}
                className="cp-scriptfull__editor"
                aria-label={showingDown ? "Rollback SQL, editable" : "Migration SQL, editable"}
                value={sql}
                onChange={(event) => onEdit(event.target.value)}
                onScroll={(event) => {
                  if (gutterRef.current) gutterRef.current.scrollTop = event.currentTarget.scrollTop;
                }}
                spellCheck={false}
                wrap="off"
              />
            </div>
            <div className="cp-scriptfull__foot">
              <span>{tally}</span>
              <span className="cp-scriptfull__spacer" />
              <span>Edits here are the same script as the side panel. Close keeps them.</span>
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
