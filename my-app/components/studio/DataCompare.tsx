import {
  summarizeDataCompare,
  type DataCompareReport,
  type TableDataCompare,
} from "@/lib/compare-data-summary";
import { CheckIcon, AlertTriangleIcon } from "@/components/ui/icons";
import { dropModeFrom } from "@/components/studio/DiffReport";

// ---------------------------------------------------------------------------
// DataCompare — the row-level half of a comparison.
//
// It answers the question the structural diff cannot: not "does the target have
// this table" but "how much is in it". The number that matters most on this
// screen is the row count of a table the source no longer has, because that is
// exactly what a DROP TABLE destroys and exactly what no down script can bring
// back.
//
// Server component, same as DiffReport, and it reuses that component's visual
// vocabulary (.table-group / .obj-group / .diff-row) rather than inventing a
// second one — a reader should not have to learn two diff layouts on one page.
// ---------------------------------------------------------------------------

/** The same collapse affordance the diff canvas uses on its table cards. */
function ChevronDown() {
  return (
    <svg
      className="chev"
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

/** Thousands separators without a locale, so server and client never disagree. */
function formatRows(n: number | null): string {
  if (n === null) return "—";
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

/** One row of the data report, colour-coded like a diff line. */
function DataRow({
  kind,
  table,
  detail,
  note,
}: {
  kind: "add" | "rem" | "chg" | "same";
  table: string;
  detail: string;
  note?: string | null;
}) {
  const sign = kind === "add" ? "+" : kind === "rem" ? "−" : kind === "chg" ? "~" : "=";
  return (
    <div className={`diff-row ${kind === "same" ? "" : `diff-${kind}`}`}>
      <span className="sign">{sign}</span>
      <span className="body">
        <span className="tag">table</span>
        <b>{table}</b> <span className="muted">{detail}</span>
        {note && (
          <div className="text-[11px] mt-0.5" style={{ color: "var(--text-3)" }}>
            {note}
          </div>
        )}
      </span>
    </div>
  );
}

/** "1,204 → 1,198 rows", or "1,204 rows" when both sides agree. */
function rowCounts(table: TableDataCompare): string {
  if (table.leftRows === null) return `${formatRows(table.rightRows)} rows in the target`;
  if (table.rightRows === null) return `${formatRows(table.leftRows)} rows in the source`;
  if (table.leftRows === table.rightRows) {
    return `${formatRows(table.leftRows)} ${plural(table.leftRows, "row", "rows")}`;
  }
  return `${formatRows(table.leftRows)} → ${formatRows(table.rightRows)} rows`;
}

/**
 * What "different" actually means for this table, in one phrase.
 *
 * Same count with a different checksum is the interesting case — the same
 * number of rows holding different values — and it reads as a contradiction
 * unless the report says so out loud.
 */
function differenceDetail(table: TableDataCompare): string {
  const counts = rowCounts(table);
  if (table.leftRows !== table.rightRows) return counts;
  if (table.leftChecksum === null) return counts;
  return `${counts}, but the contents differ`;
}

export function DataCompare({
  result,
  allowDataLoss,
}: {
  result: DataCompareReport;
  /**
   * The same flag the migration script beside this panel was built with.
   * Leave it undefined on a view that renders no script — the banner then
   * states what a sync would cost and claims nothing about what will run.
   */
  allowDataLoss?: boolean;
}) {
  if (result.error) {
    return (
      <div className="warn-inline">
        <span className="ico">
          <AlertTriangleIcon size={14} />
        </span>
        <span>{result.error}</span>
      </div>
    );
  }

  const dropMode = dropModeFrom(allowDataLoss);
  const totals = summarizeDataCompare(result);
  const different = result.tables.filter((t) => t.status === "different");
  const targetOnly = result.tables.filter((t) => t.status === "targetOnly");
  const sourceOnly = result.tables.filter((t) => t.status === "sourceOnly");
  const skipped = result.tables.filter((t) => t.status === "skipped");
  const identical = result.tables.filter((t) => t.status === "identical");

  if (result.tables.length === 0) {
    return (
      <div className="panel p-4 text-[13px]" style={{ color: "var(--text-2)" }}>
        There are no tables to compare.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* The whole reason this feature exists: name the rows a sync destroys,
          before the reader gets to a button that would destroy them.

          It fires on unreadDrops as well, because a dropped table the run never
          reached is dropped exactly the same. Keying this on the row count
          alone is what let a schema of more than sixty tables push every drop
          past the cap and show no banner at all.

          What it says depends on dropMode, because the same rows are in three
          different situations. With the switch off the script's DROP TABLEs are
          commented out, and "would be destroyed" over a script that destroys
          nothing contradicts the diff card two inches above saying the drop is
          held back — of the two, the card was right. */}
      {totals.rowsAtRiskOfDrop + totals.unreadDrops > 0 && (
        <div className={dropMode === "armed" ? "banner" : "warn-inline"}>
          <span className="ico">
            <AlertTriangleIcon size={14} />
          </span>
          <div>
            <div className="title">
              {totals.rowsAtRiskOfDrop > 0
                ? `${formatRows(totals.rowsAtRiskOfDrop)} ${plural(
                    totals.rowsAtRiskOfDrop,
                    "row",
                    "rows",
                  )} ${
                    dropMode === "armed"
                      ? "would be destroyed"
                      : "sit in tables a sync drops"
                  }`
                : `${totals.unreadDrops} ${plural(
                    totals.unreadDrops,
                    "table is",
                    "tables are",
                  )} dropped by a sync — row count unknown`}
            </div>
            <div className="body">
              {targetOnly.length + totals.unreadDrops}{" "}
              {plural(
                targetOnly.length + totals.unreadDrops,
                "table exists",
                "tables exist",
              )}{" "}
              only in the target, so a full sync drops{" "}
              {plural(targetOnly.length + totals.unreadDrops, "it", "them")} — and the
              rows with{" "}
              {plural(targetOnly.length + totals.unreadDrops, "it", "them")}.
              {dropMode === "armed"
                ? " Nothing in this app can put them back afterwards."
                : dropMode === "safe"
                  ? " “Allow data loss” is off, so the script below has those" +
                    " drops commented out and running it as written leaves the rows" +
                    " alone. Turning it on runs them, and nothing in this app can put" +
                    " them back afterwards."
                  : " No script is rendered here, so nothing on this page runs that" +
                    " drop — but nothing could put the rows back either."}
              {totals.unreadDrops > 0
                ? ` ${totals.unreadDrops} of ${plural(
                    totals.unreadDrops,
                    "them was",
                    "them were",
                  )} not read, so ${plural(
                    totals.unreadDrops,
                    "its rows are",
                    "their rows are",
                  )} not in the figure above.`
                : ""}
            </div>
          </div>
        </div>
      )}

      <details className="table-group" open>
        <summary className="tg-header">
          <ChevronDown />
          <span className="name">Row data</span>
          {different.length + targetOnly.length > 0 ? (
            <span className="pill pill-drift">
              <span className="dot" />
              {different.length + targetOnly.length}{" "}
              {plural(different.length + targetOnly.length, "table differs", "tables differ")}
            </span>
          ) : skipped.length > 0 ? (
            /* Not green. A skipped table is one nobody read — it timed out, or
               it had no column both sides could be hashed on. Saying "rows
               match" over it claims a result that was never obtained, which is
               the one thing this panel exists to avoid. */
            <span className="pill pill-neutral">
              <span className="dot" />
              {skipped.length} of {result.tables.length}{" "}
              {plural(result.tables.length, "table", "tables")} not read
            </span>
          ) : sourceOnly.length === result.tables.length ? (
            /* Every table is new, so not one row was compared against anything.
               This is the tool's most common first run — a populated source
               against an empty target — and a green "rows match" over it claims
               a result that nothing produced. */
            <span className="pill pill-neutral">
              <span className="dot" />
              nothing to compare — every table is new
            </span>
          ) : sourceOnly.length > 0 ? (
            /* The rows that WERE compared do match. Naming how many stops the
               pill from being read as a verdict on the new tables too. */
            <span className="pill pill-sync">
              <span className="dot" />
              rows match in {identical.length}{" "}
              {plural(identical.length, "shared table", "shared tables")}
            </span>
          ) : (
            <span className="pill pill-sync">
              <span className="dot" />
              rows match
            </span>
          )}
          <span className="ml-auto text-[11px]" style={{ color: "var(--text-3)" }}>
            checksum over the columns both sides share
          </span>
        </summary>

        {different.length > 0 && (
          <div className="obj-group">
            <div className="obj-header">
              <span className="section-title">Contents differ</span>
            </div>
            {different.map((table) => (
              <DataRow
                key={table.table}
                kind="chg"
                table={table.table}
                detail={differenceDetail(table)}
                note={table.note}
              />
            ))}
          </div>
        )}

        {targetOnly.length > 0 && (
          <div className="obj-group">
            <div className="obj-header">
              <span className="section-title">Only in the target</span>
              <span className="text-[11px]" style={{ color: "var(--text-3)" }}>
                dropped by a full sync
              </span>
            </div>
            {targetOnly.map((table) => (
              <DataRow
                key={table.table}
                kind="rem"
                table={table.table}
                detail={rowCounts(table)}
              />
            ))}
          </div>
        )}

        {sourceOnly.length > 0 && (
          <div className="obj-group">
            <div className="obj-header">
              <span className="section-title">Only in the source</span>
              <span className="text-[11px]" style={{ color: "var(--text-3)" }}>
                created empty — the migration copies structure, never rows
              </span>
            </div>
            {sourceOnly.map((table) => (
              <DataRow
                key={table.table}
                kind="add"
                table={table.table}
                detail={rowCounts(table)}
              />
            ))}
          </div>
        )}

        {skipped.length > 0 && (
          <div className="obj-group">
            <div className="obj-header">
              <span className="section-title">Not compared</span>
            </div>
            {skipped.map((table) => (
              <DataRow
                key={table.table}
                kind="same"
                table={table.table}
                detail=""
                note={table.note}
              />
            ))}
          </div>
        )}

        {identical.length > 0 && (
          <details className="obj-group">
            <summary className="obj-header">
              <span className="section-title">
                {identical.length} {plural(identical.length, "table", "tables")}{" "}
                {plural(identical.length, "holds", "hold")} identical rows
              </span>
              <span className="text-[11px]" style={{ color: "var(--text-3)" }}>
                click to list
              </span>
            </summary>
            {identical.map((table) => (
              <DataRow
                key={table.table}
                kind="same"
                table={table.table}
                detail={rowCounts(table)}
                note={table.note}
              />
            ))}
          </details>
        )}
      </details>

      <div className="help flex items-center gap-2">
        <CheckIcon size={12} />
        <span>
          Rows are compared by checksum, so the order they are stored in does not
          matter and no primary key is needed. Values are hashed as text: two
          servers that render the same value differently — a different major
          version, a different DateStyle — will read as different even when the
          data matches. Row counts are exact either way. Statements are capped at{" "}
          {Math.round(result.timeoutMs / 1000)}s each.
        </span>
      </div>
    </div>
  );
}
