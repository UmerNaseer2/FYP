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

/**
 * How many changes a document holds: every row except the rename suggestions.
 *
 * A suggestion is a row so the reader sees it beside the add and the drop it
 * might join, but it is not a change — nothing in the migration comes from it,
 * and the Compare header above the export does not count it. Counting it here
 * made the export read "8 changes" under a header that said 7.
 */
export function countedChanges(totals: DiffDocument["totals"]): number {
  return totals.changes - totals.renameSuggestions;
}

/** Column headings for the CSV, in the order documentRows writes them. */
const CSV_HEADERS = [
  "category",
  "table",
  "object",
  "change",
  "severity",
  // yes when the migration script cannot make this change and writes a note
  // instead. A filter on "changed" still finds the row; this column is what
  // tells the reader nothing will run for it.
  "manual",
  "detail",
];

/**
 * Column headings for the category board.
 *
 * `status` is the reason this row exists. The Markdown board can spend a
 * sentence explaining that a category was skipped; a spreadsheet cannot, and
 * without a word in the row a reader who filters the changes for "View", finds
 * nothing, and concludes the views match has been told something false by a
 * file that simply never looked at them.
 */
const SUMMARY_CSV_HEADERS = [
  "category",
  "status",
  "in_sync",
  "added",
  "changed",
  "dropped",
  "manual",
];

/** Column headings for the row-data block, written only when one was run. */
const DATA_CSV_HEADERS = [
  "table",
  "status",
  "source_rows",
  "target_rows",
  "source_checksum",
  "target_checksum",
  "note",
];

/** A row count as a cell, or empty when that side has no table to count. */
function countField(value: number | null): string {
  return value === null ? "" : String(value);
}

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

/**
 * What the `status` cell says for one category row.
 *
 * Three outcomes, and collapsing any two of them loses the thing the reader
 * needs: "compared" means the counts beside it are real, "none on either side"
 * means the counts are real and all zero, and "not compared" means there are no
 * counts. The two reasons for the last one are kept apart because telling
 * someone their snapshot is stale, when the truth is that no table matched, is
 * a wrong instruction and not just a vague one.
 */
function summaryStatus(row: DiffDocument["categories"][number]): string {
  if (!row.compared) {
    return row.notComparedReason === "noMatchedTables"
      ? "not compared — no matched tables"
      : "not compared — this snapshot has no record of them";
  }
  return row.absent ? "none on either side" : "compared";
}

export function documentToCsv(document: DiffDocument): string {
  const lines = [CSV_HEADERS.join(",")];
  for (const row of document.changes) {
    lines.push(
      [
        row.category,
        row.table,
        row.object,
        row.change,
        row.severity,
        row.manual ? "yes" : "no",
        row.detail,
      ]
        .map(csvField)
        .join(",")
    );
  }
  // The category board, and then the row data, go in the same file as further
  // blocks after a blank line rather than in files of their own: someone handed
  // one export should not have to be told there were others. A spreadsheet
  // shows each as more rows, which is why every block carries its own heading
  // line saying what its rows are.
  lines.push("");
  lines.push(SUMMARY_CSV_HEADERS.join(","));
  for (const row of document.categories) {
    // Counts are left empty rather than written as zeros on a row nobody
    // looked at. A zero is a measurement; this is the absence of one.
    const cells = row.compared
      ? [row.inSync, row.added, row.changed, row.dropped, row.manual].map(String)
      : ["", "", "", "", ""];
    lines.push(
      [row.label, summaryStatus(row), ...cells].map(csvField).join(",")
    );
  }

  if (document.data) {
    lines.push("");
    lines.push(DATA_CSV_HEADERS.join(","));
    if (document.data.error) {
      lines.push(
        ["", "error", "", "", "", "", document.data.error].map(csvField).join(",")
      );
    }
    for (const table of document.data.tables) {
      lines.push(
        [
          table.table,
          table.status,
          countField(table.leftRows),
          countField(table.rightRows),
          table.leftChecksum ?? "",
          table.rightChecksum ?? "",
          table.note ?? "",
        ]
          .map(csvField)
          .join(",")
      );
    }
  }

  // Trailing newline: some tools drop the last row of a file that lacks one.
  return `${lines.join("\n")}\n`;
}

export function documentToJson(document: DiffDocument, exportedAt: string): string {
  // exportedAt is threaded in rather than read from the clock here so this stays
  // a pure function — the same document always renders the same text.
  return `${JSON.stringify({ exportedAt, ...document }, null, 2)}\n`;
}

/** A row count for a Markdown cell, or a dash when that side has no table. */
function rowCount(value: number | null): string {
  return value === null ? "—" : String(value);
}

/** A Markdown table cell cannot hold a bare pipe — a note can. */
function cell(text: string): string {
  return text.replace(/\|/g, "\\|");
}

/** `- Table "orders" · dropped · breaking — …` */
function markdownRow(row: ChangeRow): string {
  const where = row.table && row.table !== row.object ? `${row.table}.` : "";
  // The reader of a pull request sees this line and nothing else about the row,
  // so the fact that the script writes a note instead of a statement has to be
  // on it. Without this, "Type `ts_range` · added" reads as work already done.
  const manual = row.manual ? " · by hand" : "";
  return `- **${row.category}** \`${where}${row.object}\` · ${row.change} · ${row.severity}${manual} — ${row.detail}`;
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
  const counted = countedChanges(totals);
  const out: string[] = [];

  out.push(`# Schema diff — ${source.database}.${source.schema} → ${target.database}.${target.schema}`);
  out.push("");

  if (counted === 0) {
    // "In sync" is a claim about the schema only. When a row comparison ran and
    // found differences, that sentence on its own reads as "nothing to do".
    const rowsDiffer = document.data ? document.data.totals.different : 0;
    out.push(
      rowsDiffer > 0
        ? `The two schemas are in sync. Nothing to migrate — but ${rowsDiffer} table` +
            `${rowsDiffer === 1 ? " holds" : "s hold"} different data (see below).`
        : "The two schemas are in sync. Nothing to migrate."
    );
    out.push("");
  } else {
    const bits = [
      `${totals.added} added`,
      `${totals.changed} changed`,
      `${totals.dropped} dropped`,
    ];
    if (totals.renamed > 0) bits.push(`${totals.renamed} renamed`);
    out.push(`**${counted} change${counted === 1 ? "" : "s"}** — ${bits.join(", ")}.`);
    // Suggestions get their own line, not a place in the sum above: they are
    // listed with the changes, but nothing in the script comes from them.
    const suggested = totals.renameSuggestions;
    if (suggested > 0) {
      out.push("");
      out.push(
        `🔎 ${suggested} possible rename${suggested === 1 ? " is" : "s are"} ` +
          "listed below but not applied. The script still adds one name and " +
          "drops the other, so check " +
          `${suggested === 1 ? "it" : "them"} before running it.`
      );
    }
    if (totals.breaking > 0) {
      out.push("");
      out.push(
        `⚠️ ${totals.breaking} of them ${totals.breaking === 1 ? "is" : "are"} breaking.`
      );
    }
    if (totals.manual > 0) {
      out.push("");
      out.push(
        `✋ ${totals.manual} of them ${totals.manual === 1 ? "has" : "have"} to be ` +
          `done by hand — the script writes a note for ` +
          `${totals.manual === 1 ? "it" : "each"} and runs nothing. ` +
          `Marked \`by hand\` below.`
      );
    }
    out.push("");
  }

  out.push("| Category | In sync | Added | Changed | Dropped |");
  out.push("| --- | --: | --: | --: | --: |");
  for (const row of document.categories) {
    if (!row.compared) {
      // The cell says WHICH kind of "not compared" this is. A category counted
      // per matched table pair, on a comparison with no matched pair, is not a
      // stale snapshot — and the sentence below used to tell every reader it
      // was.
      const cell =
        row.notComparedReason === "noMatchedTables"
          ? "no matched tables"
          : "not compared";
      out.push(`| ${row.label} | ${cell} | | | |`);
      continue;
    }
    out.push(
      `| ${row.label} | ${row.inSync} | ${row.added} | ${row.changed} | ${row.dropped} |`
    );
  }
  out.push("");

  const unmatched = document.notCompared
    .filter((entry) => entry.reason === "noMatchedTables")
    .map((entry) => entry.category);
  const stale = document.notCompared
    .filter((entry) => entry.reason === "snapshotPredatesCategory")
    .map((entry) => entry.category);
  if (unmatched.length > 0) {
    out.push(
      `Not compared: ${unmatched.join(", ")} — these are counted per pair of ` +
        "tables that exist on both sides, and no table matched. Whatever hangs " +
        "off a table that exists on one side only is created or dropped with " +
        "that table, and the migration script covers it."
    );
    out.push("");
  }
  if (stale.length > 0) {
    out.push(
      `Not compared: ${stale.join(", ")} — one of the two snapshots ` +
        "has no record of them, which is not the same as them matching. " +
        "Re-capture it to include them."
    );
    out.push("");
  }

  if (document.changes.length > 0) {
    out.push("## Changes");
    out.push("");
    for (const row of document.changes) out.push(markdownRow(row));
    out.push("");
  }

  if (document.data) {
    const data = document.data;
    out.push("## Row data");
    out.push("");
    if (data.error) {
      out.push(`The row comparison could not finish: ${data.error}`);
      out.push("");
    } else {
      const totals = data.totals;
      out.push(
        `${totals.identical} identical, ${totals.different} different, ` +
          `${totals.sourceOnly} only in the source, ${totals.targetOnly} only in the ` +
          `target, ${totals.skipped} skipped — ${data.timeoutMs} ms per table.`
      );
      if (totals.rowsAtRiskOfDrop > 0) {
        out.push("");
        out.push(
          `⚠️ ${totals.rowsAtRiskOfDrop} row` +
            `${totals.rowsAtRiskOfDrop === 1 ? "" : "s"} sit in tables only the target ` +
            "has. The migration drops those tables, and no down script can bring the " +
            "rows back."
        );
      }
      // Said separately, and even when the count above is zero: a dropped table
      // the run never read is dropped just the same, and its rows are missing
      // from that figure rather than added to it.
      if (totals.unreadDrops > 0) {
        out.push("");
        out.push(
          `⚠️ A further ${totals.unreadDrops} table` +
            `${totals.unreadDrops === 1 ? " is" : "s are"} dropped by the migration ` +
            `but ${totals.unreadDrops === 1 ? "was" : "were"} not read, so ` +
            `${totals.unreadDrops === 1 ? "its rows are" : "their rows are"} not ` +
            "counted above."
        );
      }
      out.push("");
      out.push("| Table | Status | Source rows | Target rows | Note |");
      out.push("| --- | --- | --: | --: | --- |");
      for (const table of data.tables) {
        out.push(
          `| \`${table.table}\` | ${table.status} | ${rowCount(table.leftRows)} | ` +
            `${rowCount(table.rightRows)} | ${cell(table.note ?? "")} |`
        );
      }
      out.push("");
    }
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
