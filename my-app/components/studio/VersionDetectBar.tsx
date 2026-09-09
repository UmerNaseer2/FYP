import type { DetectedVersion } from "@/lib/compare-run";
import { ChevronDownIcon } from "@/components/ui/icons";

// ---------------------------------------------------------------------------
// VersionDetectBar — what each schema says about its OWN version.
//
// This is not the lineage the app keeps in its own ledger; that is the panel on
// the right, and it only knows about migrations that went through this tool.
// This one reads the target database itself and looks for whatever it already
// uses to track versions — Flyway's flyway_schema_history, Liquibase, a
// hand-rolled schema_version, our script_patch — and reports the latest entry.
//
// The reason it earns space above the diff: a sync runs source → target, and if
// the TARGET is the side declaring the higher version, the migration below
// would move a newer schema backwards. That is worth a colour, not a footnote.
// When neither side records a version — the common case — the bar shrinks to
// one line that says so, because "we looked and found nothing" is information
// and silently omitting the bar would read as "there was nothing to look for".
// ---------------------------------------------------------------------------

/** Both sides of the comparison, in the order determineNewerSchema saw them. */
type Verdict = { newer: "left" | "right" | "same" | "unknown"; reason: string };

/**
 * Short, safe date. Returns "" for a missing or unparseable timestamp rather
 * than "Invalid Date" — a version table found in the wild can hold anything.
 */
function fmtDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/** The pill's words. Deliberately about DIRECTION — the numbers are below. */
function verdictLabel(newer: Verdict["newer"]): string {
  if (newer === "left") return "source ahead";
  if (newer === "right") return "target ahead";
  if (newer === "same") return "same version";
  return "not comparable";
}

/** One schema's row: where the version was read from, and what it said. */
function Side({
  role,
  name,
  detected,
}: {
  role: string;
  name: string;
  detected: DetectedVersion | null;
}) {
  const version = detected ? detected.version : null;
  return (
    <div className="verdet__side">
      <span className="verdet__role">{role}</span>
      <span className="mono text-[12px]">{name}</span>
      <span className={version ? "verdet__ver" : "verdet__ver is-none"}>
        {version ?? "no version"}
      </span>
      <span className="verdet__from">
        {detected && detected.table ? (
          <>
            from <span className="mono">{detected.table}</span>
          </>
        ) : (
          // The detector's own message, as-is. It separates "this schema has no
          // version table" from "we could not read it", and those are different
          // problems for whoever has to act on this screen.
          (detected?.message ?? "not read")
        )}
      </span>
    </div>
  );
}

/** The last few entries one schema's version table recorded, newest first. */
function Timeline({
  title,
  detected,
}: {
  title: string;
  detected: DetectedVersion | null;
}) {
  const entries = detected ? detected.recent : [];
  return (
    <div className="verdet__col">
      <h4>{title}</h4>
      {entries.length === 0 ? (
        <div className="verdet__entry">
          <span className="verdet__label" style={{ color: "var(--text-3)" }}>
            nothing recorded
          </span>
        </div>
      ) : (
        entries.map((entry, index) => (
          <div className="verdet__entry" key={`${entry.version ?? entry.label}-${index}`}>
            <span className={`verdet__dot lvl-${entry.changeLevel}`} />
            <span className="mono">{entry.version ?? "—"}</span>
            <span className="verdet__label">{entry.label}</span>
            <span className="verdet__when">{fmtDate(entry.appliedAt)}</span>
          </div>
        ))
      )}
    </div>
  );
}

export function VersionDetectBar({
  sourceName,
  source,
  targetName,
  target,
  verdict,
}: {
  sourceName: string;
  source: DetectedVersion | null;
  targetName: string;
  target: DetectedVersion | null;
  verdict: Verdict | null;
}) {
  const sourceHas = Boolean(source && source.table);
  const targetHas = Boolean(target && target.table);

  // Neither schema tracks its own versions. Say it in one line and give the
  // space back to the diff, which is the whole answer in that case.
  if (!sourceHas && !targetHas) {
    return (
      <div className="verdet verdet--quiet mb-3">
        <span className="verdet__title">Declared versions</span>
        <span className="verdet__why">
          Neither schema keeps a version table, so there is no version to compare —
          the structural diff below is the whole answer.
        </span>
      </div>
    );
  }

  // Only the backwards direction is coloured. A source that is ahead is the
  // normal direction of a sync and does not need to shout about it.
  const tone =
    verdict && verdict.newer === "right"
      ? " verdet--back"
      : verdict && verdict.newer === "left"
        ? " verdet--fwd"
        : "";

  return (
    <section className={`verdet${tone} mb-3`}>
      <div className="verdet__head">
        <span className="verdet__title">Declared versions</span>
        {verdict && (
          <span className="verdet__verdict">{verdictLabel(verdict.newer)}</span>
        )}
      </div>

      <div className="verdet__pair">
        <Side role="source" name={sourceName} detected={source} />
        <span className="verdet__arrow">→</span>
        <Side role="target" name={targetName} detected={target} />
      </div>

      {verdict && (
        <p className="verdet__why">
          {verdict.newer === "right" && (
            <b>The migration below would move the target backwards. </b>
          )}
          {verdict.reason}
        </p>
      )}

      <details className="verdet__more">
        <summary>
          <ChevronDownIcon className="chev" size={11} />
          Recent entries
        </summary>
        <div className="verdet__cols">
          {/* Named by role, not by schema: the pair two lines above already
              says which schema each side is, and repeating a long
              connection.schema label here only crowds the column. */}
          <Timeline title="Source" detected={source} />
          <Timeline title="Target" detected={target} />
        </div>
      </details>
    </section>
  );
}
