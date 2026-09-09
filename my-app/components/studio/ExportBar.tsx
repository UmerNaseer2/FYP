"use client";

import { useEffect, useState } from "react";
import {
  documentToCsv,
  documentToJson,
  documentToMarkdown,
  exportFileStem,
} from "@/lib/compare-export-format";
import type { DiffDocument } from "@/lib/compare-export";
import { CheckIcon, ClipboardIcon } from "@/components/ui/icons";

/**
 * The four ways a diff can leave this page.
 *
 * Until now the only thing on the compare screen anyone could take away was the
 * migration SQL. The diff itself — what changed, how badly, and what was never
 * looked at — could only be read on screen, which is no use in a pull request,
 * a spreadsheet, or a submission.
 *
 * The document is built on the server (lib/compare-export.ts) and arrives here
 * as plain data, so this component only formats and hands over. It deliberately
 * does not reach into the report: a second opinion about severity is exactly
 * what an export must not have.
 */

/** Hand the browser a file. Revoking on the next frame keeps Safari happy. */
function downloadText(filename: string, text: string, mime: string) {
  const url = URL.createObjectURL(new Blob([text], { type: `${mime};charset=utf-8` }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function ExportBar({ doc }: { doc: DiffDocument }) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState("");

  // Two things the print stylesheet cannot do for itself, done once for both
  // Ctrl-P and the button below:
  //
  //   1. Every card here is a <details>, and a collapsed one prints as its
  //      one-line summary. Opening them all first means the paper carries the
  //      whole diff, not whichever parts happened to be expanded.
  //   2. The app is dark by default. Printing that either burns a page of ink
  //      or — with background graphics off, which is the default — puts pale
  //      grey text on white paper. The light palette is already defined against
  //      <html data-theme="light">, so borrowing it for the duration of the
  //      print costs one attribute.
  //
  // Both are put back on afterprint. useTheme only writes the attribute on
  // mount and on the toggle button, so nothing else is racing for it.
  useEffect(() => {
    let reclose: HTMLDetailsElement[] = [];
    let previousTheme: string | null = null;

    function prepare() {
      reclose = Array.from(
        window.document.querySelectorAll<HTMLDetailsElement>("details:not([open])")
      );
      for (const element of reclose) element.open = true;

      const root = window.document.documentElement;
      previousTheme = root.getAttribute("data-theme");
      root.setAttribute("data-theme", "light");
    }

    function restore() {
      for (const element of reclose) element.open = false;
      reclose = [];

      const root = window.document.documentElement;
      if (previousTheme === null) root.removeAttribute("data-theme");
      else root.setAttribute("data-theme", previousTheme);
      previousTheme = null;
    }

    window.addEventListener("beforeprint", prepare);
    window.addEventListener("afterprint", restore);
    return () => {
      window.removeEventListener("beforeprint", prepare);
      window.removeEventListener("afterprint", restore);
    };
  }, []);

  const stem = exportFileStem(doc);

  async function copyMarkdown() {
    try {
      await navigator.clipboard.writeText(documentToMarkdown(doc));
      setCopied(true);
      setFailed("");
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard writes are blocked outside a secure context, and there is no
      // way to feature-detect that ahead of time — so say so rather than
      // leaving a button that looks like it did nothing.
      setFailed("Copy blocked by the browser — use the JSON or CSV download.");
    }
  }

  return (
    <div className="export-bar no-print">
      <span className="export-bar__label">Export this diff</span>

      <button type="button" className="btn btn-ghost btn-sm" onClick={copyMarkdown}>
        {copied ? <CheckIcon size={13} /> : <ClipboardIcon size={13} />}
        {copied ? "Copied" : "Copy as Markdown"}
      </button>

      <button
        type="button"
        className="btn btn-ghost btn-sm"
        onClick={() =>
          downloadText(
            `${stem}.json`,
            documentToJson(doc, new Date().toISOString()),
            "application/json"
          )
        }
      >
        JSON
      </button>

      <button
        type="button"
        className="btn btn-ghost btn-sm"
        onClick={() => downloadText(`${stem}.csv`, documentToCsv(doc), "text/csv")}
      >
        CSV
      </button>

      <button
        type="button"
        className="btn btn-ghost btn-sm"
        onClick={() => window.print()}
        title="Opens the browser print dialog — choose “Save as PDF” there for a PDF"
      >
        Print / PDF
      </button>

      <span className="export-bar__count">
        {doc.totals.changes} row{doc.totals.changes === 1 ? "" : "s"}
        {doc.data
          ? ` \u00b7 ${doc.data.tables.length} table${
              doc.data.tables.length === 1 ? "" : "s"
            } of row data`
          : ""}
        {doc.notCompared.length > 0
          ? ` · ${doc.notCompared
              .map((entry) => entry.category)
              .join(", ")
              .toLowerCase()} not compared`
          : ""}
      </span>

      {failed && <span className="export-bar__error">{failed}</span>}
    </div>
  );
}
