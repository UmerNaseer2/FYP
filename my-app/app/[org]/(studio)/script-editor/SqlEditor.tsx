"use client";

import { useRef, useState, type KeyboardEvent } from "react";

/** The small line under the editor: what the text in the open tab amounts to. */
export type EditorStatus = { tone: "idle" | "ok" | "bad"; text: string };

type TabName = "up" | "down";

type SqlEditorProps = {
  sql: string;
  rollbackSql: string;
  onSqlChange: (text: string) => void;
  onRollbackChange: (text: string) => void;
  /** Ctrl S (or Cmd S) inside either box. The page decides whether a save may run. */
  onSaveKey: () => void;
  /** The file names the two boxes will be saved as, shown in the header. */
  sqlFile: string;
  rollbackFile: string;
  sqlStatus: EditorStatus;
  rollbackStatus: EditorStatus;
};

const INDENT = "  ";
const COMMENT = "-- ";

/** Where the caret is, counted from 1 the way editors show it. */
function caretPlace(text: string, offset: number): { line: number; column: number } {
  const before = text.slice(0, offset);
  const lastBreak = before.lastIndexOf("\n");
  return { line: before.split("\n").length, column: offset - lastBreak };
}

/**
 * Comment the selected lines out, or back in when every one of them is
 * already a comment. Returns the new text and the range that was rewritten.
 */
function toggleComment(text: string, start: number, end: number) {
  const from = text.lastIndexOf("\n", start - 1) + 1;
  const nextBreak = text.indexOf("\n", end);
  const to = nextBreak === -1 ? text.length : nextBreak;
  const lines = text.slice(from, to).split("\n");
  const written = lines.filter((line) => line.trim() !== "");
  const allComments = written.length > 0 && written.every((line) => line.trimStart().startsWith("--"));
  const changed = lines.map((line) => {
    if (line.trim() === "") return line;
    if (allComments) return line.replace(/^(\s*)-- ?/, "$1");
    return COMMENT + line;
  });
  return { from, to, replacement: changed.join("\n") };
}

/**
 * The dark editor: one tab for the migration, one for its rollback. Both
 * boxes stay on the page (the closed one is only hidden), so nothing typed in
 * one is lost by opening the other.
 */
export function SqlEditor({
  sql,
  rollbackSql,
  onSqlChange,
  onRollbackChange,
  onSaveKey,
  sqlFile,
  rollbackFile,
  sqlStatus,
  rollbackStatus,
}: SqlEditorProps) {
  const [tab, setTab] = useState<TabName>("up");
  const [caret, setCaret] = useState({ line: 1, column: 1 });
  const [copied, setCopied] = useState<"" | "done" | "failed">("");
  // Tab indents, so a keyboard user needs a way out: Esc, then Tab, leaves.
  const leaveOnTabRef = useRef(false);
  const upTab = useRef<HTMLButtonElement>(null);
  const downTab = useRef<HTMLButtonElement>(null);

  const text = tab === "up" ? sql : rollbackSql;
  const status = tab === "up" ? sqlStatus : rollbackStatus;
  const file = tab === "up" ? sqlFile : rollbackFile;

  function openTab(next: TabName, focus: boolean) {
    setTab(next);
    setCaret({ line: 1, column: 1 });
    setCopied("");
    if (focus) (next === "up" ? upTab : downTab).current?.focus();
  }

  function onTabKey(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    openTab(tab === "up" ? "down" : "up", true);
  }

  async function copyText() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied("done");
    } catch {
      setCopied("failed");
    }
  }

  function downloadText() {
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
    link.download = file;
    link.click();
    URL.revokeObjectURL(link.href);
  }

  return (
    <div className="se-ed">
      <div className="se-h">
        <div className="se-tabs" role="tablist" aria-label="Which script to write">
          <span className={`se-thumb${tab === "down" ? " se-thumb--right" : ""}`} aria-hidden="true" />
          <button
            ref={upTab}
            type="button"
            role="tab"
            id="se-tab-up"
            aria-selected={tab === "up"}
            aria-controls="se-panel-up"
            tabIndex={tab === "up" ? 0 : -1}
            onClick={() => openTab("up", false)}
            onKeyDown={onTabKey}
          >
            <i className={`se-dot se-dot--${sqlStatus.tone}`} aria-hidden="true" />
            Migration
          </button>
          <button
            ref={downTab}
            type="button"
            role="tab"
            id="se-tab-down"
            aria-selected={tab === "down"}
            aria-controls="se-panel-down"
            tabIndex={tab === "down" ? 0 : -1}
            onClick={() => openTab("down", false)}
            onKeyDown={onTabKey}
          >
            <i className={`se-dot se-dot--${rollbackStatus.tone}`} aria-hidden="true" />
            Rollback
          </button>
        </div>
        <span className="se-file" title={file}>
          {file}
        </span>
        <button type="button" className="se-ib" disabled={text === ""} onClick={copyText}>
          Copy
        </button>
        <button type="button" className="se-ib" disabled={text === ""} onClick={downloadText}>
          Download
        </button>
      </div>

      <CodeBox
        panelId="se-panel-up"
        tabId="se-tab-up"
        inputId="se-sql"
        label="SQL"
        hidden={tab !== "up"}
        value={sql}
        minRows={13}
        placeholder={"ALTER TABLE invoices\n  ADD COLUMN due_date date;"}
        caretLine={caret.line}
        leaveOnTabRef={leaveOnTabRef}
        onChange={onSqlChange}
        onCaret={setCaret}
        onSaveKey={onSaveKey}
      />
      <CodeBox
        panelId="se-panel-down"
        tabId="se-tab-down"
        inputId="se-down"
        label="Rollback SQL"
        hidden={tab !== "down"}
        value={rollbackSql}
        minRows={13}
        placeholder={"ALTER TABLE invoices\n  DROP COLUMN due_date;"}
        caretLine={caret.line}
        leaveOnTabRef={leaveOnTabRef}
        onChange={onRollbackChange}
        onCaret={setCaret}
        onSaveKey={onSaveKey}
      />

      <div className="se-foot">
        <span className={`se-stat se-stat--${status.tone}`}>
          <i aria-hidden="true" />
          {status.text}
        </span>
        <span>{`Line ${caret.line}, column ${caret.column}`}</span>
        {/* Said out loud, because the button itself does not change. */}
        <span className="se-foot-end" aria-live="polite">
          {copied === "done" ? "Copied" : copied === "failed" ? "Could not copy. Select the text and copy it yourself." : ""}
        </span>
      </div>
      <p className="se-keys">
        <span>
          <kbd>Tab</kbd> indents
        </span>
        <span>
          <kbd>Esc</kbd> then <kbd>Tab</kbd> leaves the box
        </span>
        <span>
          <kbd>Ctrl</kbd> <kbd>/</kbd> comments a line
        </span>
        <span>
          <kbd>Ctrl</kbd> <kbd>S</kbd> saves
        </span>
      </p>
    </div>
  );
}

type CodeBoxProps = {
  panelId: string;
  tabId: string;
  inputId: string;
  label: string;
  hidden: boolean;
  value: string;
  minRows: number;
  placeholder: string;
  caretLine: number;
  leaveOnTabRef: { current: boolean };
  onChange: (text: string) => void;
  onCaret: (place: { line: number; column: number }) => void;
  onSaveKey: () => void;
};

/** One tab's panel: line numbers beside a plain text box. */
function CodeBox({
  panelId,
  tabId,
  inputId,
  label,
  hidden,
  value,
  minRows,
  placeholder,
  caretLine,
  leaveOnTabRef,
  onChange,
  onCaret,
  onSaveKey,
}: CodeBoxProps) {
  const lineCount = value.split("\n").length;

  function readCaret(box: HTMLTextAreaElement) {
    onCaret(caretPlace(box.value, box.selectionStart));
  }

  // Rewrite part of the box and tell the page. The box is changed directly so
  // the caret stays where the edit left it.
  function rewrite(box: HTMLTextAreaElement, replacement: string, from: number, to: number, select: "end" | "select") {
    box.setRangeText(replacement, from, to, select);
    onChange(box.value);
    readCaret(box);
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    const box = event.currentTarget;
    const command = event.ctrlKey || event.metaKey;
    if (command && event.key.toLowerCase() === "s") {
      event.preventDefault();
      onSaveKey();
      return;
    }
    if (command && event.key === "/") {
      event.preventDefault();
      const edit = toggleComment(box.value, box.selectionStart, box.selectionEnd);
      rewrite(box, edit.replacement, edit.from, edit.to, "select");
      return;
    }
    if (event.key === "Escape") {
      leaveOnTabRef.current = true;
      return;
    }
    if (event.key === "Tab" && !event.shiftKey && !command && !event.altKey && !leaveOnTabRef.current) {
      event.preventDefault();
      rewrite(box, INDENT, box.selectionStart, box.selectionEnd, "end");
      return;
    }
    // Any other key ends the "Esc, then Tab" way out. Holding a modifier does not.
    if (!["Shift", "Control", "Alt", "Meta", "Tab"].includes(event.key)) leaveOnTabRef.current = false;
  }

  return (
    <div className="se-body" role="tabpanel" id={panelId} aria-labelledby={tabId} hidden={hidden}>
      <span className="se-cur" style={{ transform: `translateY(${(caretLine - 1) * 21}px)` }} aria-hidden="true" />
      <div className="se-gut" aria-hidden="true">
        {Array.from({ length: lineCount }, (_, index) => (
          <span key={index}>{index + 1}</span>
        ))}
      </div>
      <textarea
        id={inputId}
        className="se-area"
        aria-label={label}
        wrap="off"
        rows={Math.max(lineCount, minRows)}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        placeholder={placeholder}
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
          readCaret(event.target);
        }}
        onKeyDown={onKeyDown}
        onKeyUp={(event) => readCaret(event.currentTarget)}
        onClick={(event) => readCaret(event.currentTarget)}
        onSelect={(event) => readCaret(event.currentTarget)}
        onBlur={() => {
          leaveOnTabRef.current = false;
        }}
      />
    </div>
  );
}
