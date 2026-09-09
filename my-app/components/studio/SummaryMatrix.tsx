import type { CompareReport } from "@/lib/compare-types";
import { summaryRows } from "@/lib/compare-summary";
import { ChevronDownIcon } from "@/components/ui/icons";

// ---------------------------------------------------------------------------
// SummaryMatrix — the object-status board that sits above the diff.
//
// The diff canvas below is a narrative: it walks table by table and tells you
// what happened to each one. That is the right shape for reading a change and
// the wrong shape for answering "did anything happen to my views?" — you have
// to scroll the whole thing and hope you did not miss a card.
//
// This is the other half: every category the comparison looked at, on one line
// each, with the four things that can happen to an object. It is also the only
// place the report admits it did NOT look at something, and "skipped" rendered
// as a row of zeros would be a lie, so those rows say so instead — with the
// right reason of the two (see NotComparedReason). A snapshot captured before a
// category existed has no record of it; separately, indexes and triggers are
// counted per matched table pair, so a comparison with no pair at all compares
// none of them while both snapshots are perfectly current.
//
// Server component, and it reuses the diff canvas' vocabulary (.table-group /
// .obj-group) rather than inventing a third layout for one page.
// ---------------------------------------------------------------------------

/** One number. Zero is deliberately quiet so the non-zero cells carry the eye. */
function Count({ n, tone }: { n: number; tone: "sync" | "add" | "rem" | "chg" }) {
  if (n === 0) return <td className="matrix-n is-zero">0</td>;
  return <td className={`matrix-n tone-${tone}`}>{n}</td>;
}

export function SummaryMatrix({ report }: { report: CompareReport }) {
  const rows = summaryRows(report);
  // Split by WHY, not just by whether. A category counted on matched tables is
  // skipped when nothing matched, and telling that reader their snapshot is too
  // old is simply false — it fires on a populated source against an empty
  // target, the tool's most common run, while the panel beside this one is busy
  // creating every index and trigger it just said were "not compared".
  const stale = rows
    .filter((row) => row.notComparedReason === "snapshotPredatesCategory")
    .map((row) => row.label);
  const unmatched = rows
    .filter((row) => row.notComparedReason === "noMatchedTables")
    .map((row) => row.label);
  // Counted here rather than given a column of its own. These are rare — a
  // range type the snapshot cannot describe, a changed collation — and a sixth
  // column of zeros on every row would cost every reader something to buy the
  // one reader who has one. A sentence costs nothing until there is one.
  const manual = rows.reduce((sum, row) => sum + row.manual, 0);
  const manualLabels = rows.filter((row) => row.manual > 0).map((row) => row.label);

  return (
    <details className="table-group" open>
      <summary className="tg-header">
        <ChevronDownIcon className="chev" size={12} />
        <span className="name">Summary</span>
        <span className="ml-auto text-[11px]" style={{ color: "var(--text-3)" }}>
          every object category, not just the ones that changed
        </span>
      </summary>

      <div className="obj-group">
        <div className="matrix-wrap">
          <table className="matrix">
            <thead>
              <tr>
                <th scope="col">Object</th>
                <th scope="col">In sync</th>
                <th scope="col">
                  Only in source<span className="sub">created</span>
                </th>
                <th scope="col">
                  Only in target<span className="sub">dropped</span>
                </th>
                <th scope="col">Changed</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.label}>
                  <th scope="row" className="matrix-name">
                    {row.label}
                  </th>
                  {!row.compared ? (
                    <td className="matrix-na" colSpan={4}>
                      {row.notComparedReason === "noMatchedTables"
                        ? "no matched tables"
                        : "not compared"}
                    </td>
                  ) : row.absent ? (
                    <td className="matrix-na" colSpan={4}>
                      none on either side
                    </td>
                  ) : (
                    <>
                      <Count n={row.inSync} tone="sync" />
                      <Count n={row.added} tone="add" />
                      <Count n={row.dropped} tone="rem" />
                      <Count n={row.changed} tone="chg" />
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="obj-group">
        <div className="help">
          Columns, constraints, indexes and triggers are counted on tables that
          exist on both sides. On a table that exists on one side only they are
          created or dropped with the table itself, so counting them here would
          report the same work twice.
          {unmatched.length > 0 && (
            <>
              {" "}
              <b style={{ color: "var(--text-2)" }}>
                {unmatched.join(", ") + " have no matched tables to be counted on"}
              </b>
              {" — they are counted per table pair, and no table exists on both " +
                "sides. Anything on a table that exists on one side only is created " +
                "or dropped with the table, and the migration below writes it."}
            </>
          )}
          {manual > 0 && (
            <>
              {" "}
              <b style={{ color: "var(--drift)" }}>
                {manual === 1
                  ? "1 of these is counted but cannot be scripted"
                  : manual + " of these are counted but cannot be scripted"}
              </b>
              {" — PostgreSQL has no statement that makes the change (" +
                manualLabels.join(", ") +
                "), so the script writes a note saying what has to be done and " +
                "runs nothing for it."}
            </>
          )}
          {stale.length > 0 && (
            <>
              {" "}
              <b style={{ color: "var(--text-2)" }}>
                {stale.join(", ") + " could not be compared"}
              </b>
              {" — one of these snapshots was captured before this app recorded " +
                "them, and treating \u201cno record\u201d as \u201cnone\u201d would " +
                "report every one of them as newly added. Re-capture it to include " +
                "them."}
            </>
          )}
        </div>
      </div>
    </details>
  );
}
