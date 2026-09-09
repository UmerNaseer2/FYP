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
// place the report admits it did NOT look at something. A snapshot captured
// before a category existed has no record of it, so that category is skipped
// (see ComparedObjectCategories) — and "skipped" rendered as a row of zeros
// would be a lie, so those rows say "not compared" instead.
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
  const skipped = rows.filter((row) => !row.compared).map((row) => row.label);

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
                      not compared
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
          {skipped.length > 0 && (
            <>
              {" "}
              <b style={{ color: "var(--text-2)" }}>
                {skipped.join(", ")} could not be compared
              </b>{" "}
              — one of these snapshots was captured before this app recorded them,
              and treating &ldquo;no record&rdquo; as &ldquo;none&rdquo; would
              report every one of them as newly added.
            </>
          )}
        </div>
      </div>
    </details>
  );
}
