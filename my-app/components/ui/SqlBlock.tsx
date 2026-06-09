import type { ReactNode } from "react";

type SqlBlockProps = {
  /** Raw SQL text to display. */
  code: string;
  /** Optional header strip (filename, change-level pill, actions). */
  header?: ReactNode;
  /** Optional footer strip (derived version, line count). */
  footer?: ReactNode;
};

/**
 * Monospace SQL surface. Phase 1 renders plain (un-highlighted) text; the
 * `.sql .kw/.ty/.str/.num` token classes already exist in globals.css for the
 * Phase 4 tokenizer to light up later without changing this API.
 */
export function SqlBlock({ code, header, footer }: SqlBlockProps) {
  return (
    <div className="panel overflow-hidden">
      {header && (
        <div
          className="flex items-center justify-between px-4 py-2.5"
          style={{ borderBottom: "1px solid var(--border)", background: "var(--surface-2)" }}
        >
          {header}
        </div>
      )}
      <pre className="sql p-4 overflow-x-auto" style={{ background: "var(--surface)", margin: 0 }}>
        {code}
      </pre>
      {footer && (
        <div
          className="px-4 py-2.5 flex items-center justify-between text-[12px]"
          style={{ borderTop: "1px solid var(--border)", color: "var(--text-3)", background: "var(--surface-2)" }}
        >
          {footer}
        </div>
      )}
    </div>
  );
}
