// ---------------------------------------------------------------------------
// compare-export-format.ts
// Renders a DiffDocument as the three things people actually want to leave with:
// a JSON file, a CSV file, and a block of Markdown for a pull request or a chat.
//
// Every import here is `import type`, which TypeScript erases. That is on
// purpose and it is load-bearing: the export buttons are a client component, so
// anything this module imports at runtime gets bundled into the browser, and
// building the document (compare-export.ts) reaches the whole 1700-line compare
// engine. The document is built on the server and arrives here as plain data.
// ---------------------------------------------------------------------------

import type { ChangeRow, DiffDocument } from "./compare-export";

/** Column headings for the CSV, in the order documentRows writes them. */
const CSV_HEADERS = ["category", "table", "object", "change", "severity", "detail"];

/**
 * One CSV field, quoted the way every spreadsheet expects.
 *
 * Always quoted rather than only-when-needed: a detail line can hold a comma, a
 * quote, a newline or a leading `=`, and a half-quoted file opens as garbage in
 * the one program people will open it in.
 */
function csvField(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

export function documentToCsv(document: DiffDocument): string {
  const lines = [CSV_HEADERS.join(",")];
  for (const row of document.changes) {
    lines.push(
      [row.category, row.table, row.object, row.change, row.severity, row.detail]
        .map(csvField)
        .join(",")
    );
  }
  // Trailing newline: some tools drop the last row of a file that lacks one.
  return `${lines.join("\n")}\n`;
}

export function documentToJson(document: DiffDocument, exportedAt: string): string {
  // exportedAt is threaded in rather than read from the clock here so this stays
  // a pure function — the same document always renders the same text.
  return `${JSON.stringify({ exportedAt, ...document }, null, 2)}\n`;
}

/** `- Table "orders" · dropped · breaking — …` */
function markdownRow(row: ChangeRow): string {
  const where = row.table && row.table !== row.object ? `${row.table}.` : "";
  return `- **${row.category}** \`${where}${row.object}\` · ${row.change} · ${row.severity} — ${row.detail}`;
}

/**
 * The whole diff as Markdown, for pasting into a pull request or a message.
 *
 * Leads with the counts, then the per-category board, then every change. The
 * "not compared" line is not decoration: without it a reader takes an empty
 * Views section to mean the views match, when it means nobody looked.
 */
export function documentToMarkdown(document: DiffDocument): string {
  const { source, target, totals } = document;
  const out: string[] = [];

  out.push(`# Schema diff — ${source.database}.${source.schema} → ${target.database}.${target.schema}`);
  out.push("");

  if (totals.changes === 0) {
    out.push("The two schemas are in sync. Nothing to migrate.");
    out.push("");
  } else {
    const bits = [
      `${totals.added} added`,
      `${totals.changed} changed`,
      `${totals.dropped} dropped`,
    ];
    if (totals.renamed > 0) bits.push(`${totals.renamed} renamed`);
    out.push(`**${totals.changes} change${totals.changes === 1 ? "" : "s"}** — ${bits.join(", ")}.`);
    if (totals.breaking > 0) {
      out.push("");
      out.push(
        `⚠️ ${totals.breaking} of them ${totals.breaking === 1 ? "is" : "are"} breaking.`
      );
    }
    out.push("");
  }

  out.push("| Category | In sync | Added | Changed | Dropped |");
  out.push("| --- | --: | --: | --: | --: |");
  for (const row of document.categories) {
    if (!row.compared) {
      out.push(`| ${row.label} | not compared | | | |`);
      continue;
    }
    out.push(
      `| ${row.label} | ${row.inSync} | ${row.added} | ${row.changed} | ${row.dropped} |`
    );
  }
  out.push("");

  if (document.notCompared.length > 0) {
    out.push(
      `Not compared: ${document.notCompared.join(", ")} — one of the two snapshots ` +
        "has no record of them, which is not the same as them matching."
    );
    out.push("");
  }

  if (document.changes.length > 0) {
    out.push("## Changes");
    out.push("");
    for (const row of document.changes) out.push(markdownRow(row));
    out.push("");
  }

  return out.join("\n");
}

/**
 * A filename stem both ends of the comparison can be read out of.
 *
 * Two targets on one page are usually both called "public", so naming a file
 * after the schema alone produces two files called the same thing.
 */
export function exportFileStem(document: DiffDocument): string {
  const raw = `diff_${document.source.database}_${document.source.schema}_to_${document.target.database}_${document.target.schema}`;
  return raw.replace(/[^a-z0-9_]/gi, "_").toLowerCase();
}
