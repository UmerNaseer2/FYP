import type { ChangeRow, DiffDocument } from "@/lib/compare-export";
import { AlertTriangleIcon, ChevronDownIcon } from "@/components/ui/icons";

// ---------------------------------------------------------------------------
// CriticalChanges — the differences that can break something, named, up front.
//
// Spec feature 04: "…highlight critical differences…". The engine has always
// graded every difference, and the diff canvas marks the breaking ones where
// they sit. What it could not do is answer "what am I about to break?" without
// reading the whole report: a narrowing type change on one column of a
// forty-table schema is one red word several screens down.
//
// So this pulls them out and puts them at the top, under the count. It is the
// same grading as everywhere else — these rows come from buildDiffDocument,
// which grades with the functions the canvas and the generated SQL both use —
// and it is deliberately a LIST of what they are rather than a second opinion
// about how bad they are.
//
// No "use client": the compare page is a client component, so this is compiled
// into the browser bundle. Everything it imports is pure — compare-export
// carries types and a grader, and opens no connection.
// ---------------------------------------------------------------------------

/**
 * How many are listed before the rest become a count.
 *
 * Two schemas that have drifted for a year can produce hundreds of breaking
 * differences, and a panel that listed all of them would be the whole report
 * again, which is the thing this exists to save the reader from. Whoever has
 * hundreds needs the number and the export, not a longer list.
 */
const LIST_LIMIT = 25;

export function CriticalChanges({
  doc,
  allowDataLoss,
}: {
  doc: DiffDocument;
  /** The form's "allow data loss" switch — see the note below the list. */
  allowDataLoss: boolean;
}) {
  const breaking = doc.changes.filter((row) => row.severity === "breaking");
  const manual = doc.changes.filter((row) => row.manual);

  // Nothing critical and nothing needing a person: no panel. A green "no
  // breaking differences" banner on every comparison would be one more thing
  // to scroll past, and the counts above already say breaking · 0.
  if (breaking.length === 0 && manual.length === 0) return null;

  const shown = breaking.slice(0, LIST_LIMIT);
  const hidden = breaking.length - shown.length;

  return (
    <details className="table-group critical" open={breaking.length > 0}>
      <summary className="tg-header">
        <span className="ico critical__ico">
          <AlertTriangleIcon size={14} />
        </span>
        <span className="critical__title">
          {breaking.length > 0 ? (
            <>
              {breaking.length} breaking difference{breaking.length === 1 ? "" : "s"}
            </>
          ) : (
            <>
              {manual.length} difference{manual.length === 1 ? "" : "s"} no script can
              make
            </>
          )}
        </span>
        {breaking.length > 0 && manual.length > 0 && (
          <span className="pill pill-neutral">{manual.length} need a person</span>
        )}
        <span className="critical__spacer" />
        <span className="chev">
          <ChevronDownIcon size={14} />
        </span>
      </summary>

      <div className="obj-group">
        {shown.map((row, index) => (
          // Two rows can name the same object under different categories — a
          // dropped column and the constraint that went with it — so the index
          // is part of the key. It is a render-only list that never reorders.
          <CriticalRow key={`${row.category}-${row.table}-${row.object}-${index}`} row={row} />
        ))}
        {hidden > 0 && (
          <p className="help critical__more">
            …and {hidden} more. The whole list is in the export above, and every
            one of them is marked in the diff below.
          </p>
        )}

        {breaking.length > 0 && (
          <p className="help critical__note">
            {/* The counts in the header of this section are statements the
                migration will RUN; these are the differences themselves. With
                "allow data loss" off the two disagree on purpose — a dropped
                column is still a breaking difference even though the script
                leaves the DROP commented out — and a reader who spotted
                "breaking · 0" above and this panel here deserves to be told
                why rather than left to guess which one is lying. */}
            Counted from the differences, not from the script.{" "}
            {allowDataLoss
              ? "The migration is set to allow data loss, so the destructive statements among these are armed."
              : "The migration is not allowed to lose data, so the destructive statements among these are written out but commented off — the difference is still here, the script just will not act on it."}
          </p>
        )}

        {manual.length > 0 && (
          <p className="help critical__note">
            {manual.length} of the differences below cannot be carried out by any
            generated statement — the script writes a note and runs nothing. Look
            for them in the diff, marked as manual work.
          </p>
        )}
      </div>
    </details>
  );
}

function CriticalRow({ row }: { row: ChangeRow }) {
  return (
    <div className="diff-row critical__row">
      <span className="sign">!</span>
      <span className="body">
        <span className="tag">{row.category}</span>
        <b className="mono">{row.table && row.table !== row.object ? `${row.table}.` : ""}{row.object}</b>{" "}
        <span className="chg-break">{row.change}</span>
        {/* The detail is the engine's own sentence about the change — the same
            text the export carries. Repeating it here rather than writing a
            second description keeps one wording for one fact. */}
        {row.detail && <span className="muted"> — {row.detail}</span>}
        {row.manual && <span className="tag critical__manual">needs a person</span>}
      </span>
    </div>
  );
}
