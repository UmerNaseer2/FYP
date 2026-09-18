import type { ComparisonHistoryView, HistoryLine } from "@/lib/compare-run";
import { ChevronDownIcon, TrendIcon } from "@/components/ui/icons";

// ---------------------------------------------------------------------------
// CompareHistory — what has changed since the last time this pair was compared.
//
// Spec feature 04: "…and show historical comparison changes." The report below
// says how the two schemas differ TODAY. That is a photograph, and a photograph
// cannot answer the question people come back to this screen with: is this the
// same fourteen differences I looked at last week, or fourteen different ones?
//
// The answer is computed on the server, against the last run of the same pair
// stored in the metadata database — see lib/comparison-history. What arrives
// here is already a sentence and two lists; this file only draws them.
//
// Absent on a first comparison, on purpose. There is nothing to have drifted
// FROM, and a panel reading "no differences appeared" would look like a finding
// about the two databases instead of about nobody having looked before.
// ---------------------------------------------------------------------------

/** See CriticalChanges for why a long list becomes a count. */
const LIST_LIMIT = 15;

export function CompareHistory({ history }: { history: ComparisonHistoryView }) {
  const hasLists = history.appeared.length > 0 || history.resolved.length > 0;

  return (
    <details className="table-group history" open={history.appeared.length > 0}>
      <summary className="tg-header">
        <span className="ico history__ico">
          <TrendIcon size={14} />
        </span>
        {/* The sentence carries the run's time in words ("on 12 Sep 2026,
            14:30"); the stored stamp goes in the tooltip, because "last week"
            is what a reader wants and the exact instant is what they check. */}
        <span className="history__sentence" title={history.since}>
          {history.sentence}
        </span>
        <span className="history__spacer" />
        {/* Only when there is something under the summary to open. A chevron on
            a panel that opens onto one more line of text is a promise the
            panel cannot keep. */}
        {hasLists && (
          <span className="chev">
            <ChevronDownIcon size={14} />
          </span>
        )}
      </summary>

      <div className="obj-group">
        {hasLists ? (
          <>
            <HistoryList
              title="New since then"
              lines={history.appeared}
              sign="+"
              empty="Nothing new."
            />
            <HistoryList
              title="No longer different"
              lines={history.resolved}
              sign="−"
              empty="Nothing was resolved."
            />
          </>
        ) : (
          <p className="help">
            The two schemas differ in exactly the ways they did then.
          </p>
        )}
        <p className="help history__who">
          That run was made by <span className="mono">{history.by}</span>. Only
          structural differences are tracked — row counts move whenever the
          database is used, and counting that as drift would bury the schema
          change that matters.
        </p>
      </div>
    </details>
  );
}

function HistoryList({
  title,
  lines,
  sign,
  empty,
}: {
  title: string;
  lines: HistoryLine[];
  /** "+" for what appeared, "−" for what went away. */
  sign: string;
  empty: string;
}) {
  const shown = lines.slice(0, LIST_LIMIT);
  const hidden = lines.length - shown.length;

  return (
    <div className="history__group">
      <div className="obj-header">
        <span className="history__title">{title}</span>
        <span className="pill pill-neutral">{lines.length}</span>
      </div>
      {shown.length === 0 ? (
        <p className="help">{empty}</p>
      ) : (
        shown.map((line, index) => (
          // The label already encodes the whole identity of the difference —
          // see describeItem — but two runs of the same pair can legitimately
          // produce two rows with the same label under different severities, so
          // the index goes in the key. This list never reorders.
          <div className="diff-row history__row" key={`${line.label}-${index}`}>
            <span className="sign">{sign}</span>
            <span className="body">
              <span className={line.severity === "breaking" ? "chg-break" : "mono"}>
                {line.label}
              </span>
              {line.severity === "breaking" && (
                <span className="tag history__break">breaking</span>
              )}
            </span>
          </div>
        ))
      )}
      {hidden > 0 && <p className="help">…and {hidden} more.</p>}
    </div>
  );
}
