import type { ReactNode } from "react";
import type { DetectedVersion } from "@/lib/detected-version";
import type { NewerSchemaVerdict } from "@/lib/version-detection";
import {
  compareFamilyHeads,
  displayVersion,
  familyHeadRows,
  hasFamilyHeads,
  listNames,
  outdatedSideFor,
  pushMovesTargetBack,
  type FamilyHeadRow,
} from "@/lib/version-timeline";

// ---------------------------------------------------------------------------
// VersionDetectBar — what each schema says about its OWN version.
//
// This is not the lineage the app keeps in its own ledger; that is the panel on
// the right, and it only knows about migrations that went through this tool.
// This one reads the target database itself and looks for whatever it already
// uses to track versions — Flyway's flyway_schema_history, Liquibase, a
// hand-rolled schema_version, our script_patch — and reports its version.
//
// The reason it earns space above the diff: a sync runs source → target, and if
// the TARGET is the side declaring the higher version, the migration below
// would move a newer schema backwards. That is worth a colour, not a footnote.
// Unless the two structures already match: then there is no migration, nothing
// moves, and the bar says that instead of warning about a push that can't happen.
// When neither side records a version — the common case — the bar shrinks to
// one line that says so, because "we looked and found nothing" is information
// and silently omitting the bar would read as "there was nothing to look for".
//
// script_patch keeps separate script groups, and versions compare only inside
// one group. When both sides have groups the verdict is read group by group,
// so the bar prints each group's head (a table when there are two or more)
// and says "diverged" when each side is ahead somewhere. The side the verdict
// calls behind is labelled "(Outdated)".
// ---------------------------------------------------------------------------

/**
 * Both sides of the comparison, in the order determineNewerSchema saw them.
 * The same type determineNewerSchema returns; a type-only import, so nothing
 * from the server-side detector reaches the browser bundle.
 */
type Verdict = NewerSchemaVerdict;

/** The pill's words. Deliberately about DIRECTION — the numbers are below. */
function verdictLabel(newer: Verdict["newer"]): string {
  if (newer === "left") return "source ahead";
  if (newer === "right") return "target ahead";
  if (newer === "same") return "same version";
  if (newer === "diverged") return "diverged";
  return "not comparable";
}

/** The label on the side a verdict calls behind. */
function Outdated() {
  return (
    <>
      {" "}
      <span className="verdet__outdated">(Outdated)</span>
    </>
  );
}

/** One schema's row: where the version was read from, and what it said. */
function Side({
  role,
  name,
  detected,
  byGroup,
  outdated,
}: {
  role: string;
  name: string;
  detected: DetectedVersion | null;
  /** Both sides keep script groups, so the verdict compared group heads. */
  byGroup: boolean;
  /** The verdict calls this side behind. */
  outdated: boolean;
}) {
  // With groups on both sides, the verdict compared each group's head, so the
  // headline is the head (one group) or the count (the table below has them).
  // Otherwise the verdict compared this one declared version.
  const heads = byGroup && detected && hasFamilyHeads(detected.familyHeads) ? detected.familyHeads : null;
  const groups = heads ? Object.keys(heads) : [];
  const onlyGroup = heads && groups.length === 1 ? groups[0] : null;

  let shown: string | null = null;
  if (heads && onlyGroup !== null) shown = displayVersion(heads[onlyGroup], true);
  else if (heads) shown = `${groups.length} script groups`;
  else if (detected?.version) shown = displayVersion(detected.version, hasFamilyHeads(detected.familyHeads));

  return (
    <div className="verdet__side">
      <span className="verdet__role">{role}</span>
      <span className="mono text-[12px]">{name}</span>
      <span className={shown ? "verdet__ver" : "verdet__ver is-none"}>
        {shown ?? "no version"}
        {shown && outdated && <Outdated />}
      </span>
      <span className="verdet__from">
        {detected && detected.table ? (
          <>
            from <span className="mono">{detected.table}</span>
            {onlyGroup !== null && (
              <>
                , script group <span className="mono">{onlyGroup}</span>
              </>
            )}
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

/** One side's head in one group, and "(Outdated)" when that side is behind in it. */
function HeadCell({ version, outdated }: { version: string | null; outdated: boolean }) {
  return (
    <td className={version === null ? "is-none" : undefined}>
      {version === null ? "none" : <span className="mono">{displayVersion(version, true)}</span>}
      {outdated && <Outdated />}
    </td>
  );
}

/**
 * Every script group either side has, with each side's head. A side with no
 * version in a group reads "none" and is behind there: the other side has
 * versions it lacks.
 */
function FamilyTable({ rows }: { rows: FamilyHeadRow[] }) {
  return (
    <div className="verdet__fam">
      <table>
        <thead>
          <tr>
            <th scope="col">Script group</th>
            <th scope="col">Source</th>
            <th scope="col">Target</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.family}>
              <td>
                <span className="mono">{row.family}</span>
              </td>
              <HeadCell version={row.left} outdated={row.older === "left"} />
              <HeadCell version={row.right} outdated={row.older === "right"} />
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * The bold sentence before the verdict's reason, or null when the reason says
 * enough. Only a target that is ahead (everywhere, or in some groups) needs
 * one: that is the direction the push would take it back.
 */
function leadSentence(verdict: Verdict, inSync: boolean, targetAheadIn: string[]): string | null {
  if (verdict.newer === "right") {
    return inSync
      ? "The structures already match, so there is nothing to push. Only the declared versions differ:"
      : "The migration below would move the target backwards. The push button below asks you to confirm first.";
  }
  if (verdict.newer === "diverged") {
    if (inSync) {
      return "The structures already match, so there is nothing to push. Only the declared versions differ.";
    }
    const where =
      targetAheadIn.length > 0 ? listNames(targetAheadIn) : "the script groups where it is ahead";
    return `The migration below would move the target backwards in ${where}. The push button below asks you to confirm first.`;
  }
  return null;
}

export function VersionDetectBar({
  sourceName,
  source,
  targetName,
  target,
  verdict,
  inSync,
  timeline,
}: {
  sourceName: string;
  source: DetectedVersion | null;
  targetName: string;
  target: DetectedVersion | null;
  verdict: Verdict | null;
  /** The migration has no statements: the structures already match. */
  inSync: boolean;
  /** The version timeline disclosure, shown under the verdict. */
  timeline?: ReactNode;
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

  // The detector compares group by group exactly when both sides have groups,
  // so the bar prints groups on the same condition.
  const sourceHeads = source?.familyHeads;
  const targetHeads = target?.familyHeads;
  const byGroup = hasFamilyHeads(sourceHeads) && hasFamilyHeads(targetHeads);
  const rows = byGroup ? familyHeadRows(sourceHeads ?? {}, targetHeads ?? {}) : [];
  const targetAheadIn = byGroup ? compareFamilyHeads(sourceHeads ?? {}, targetHeads ?? {}).rightAheadIn : [];
  const outdatedSide = outdatedSideFor(verdict?.newer);
  const lead = verdict ? leadSentence(verdict, inSync, targetAheadIn) : null;

  // Only the backwards direction is coloured. A source that is ahead is the
  // normal direction of a sync and does not need to shout about it. With the
  // structures in sync nothing would move, so there is nothing to warn about.
  // The push button's backwards tick asks the same question, so the two agree.
  const tone =
    verdict && pushMovesTargetBack(verdict.newer, inSync)
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
        <Side
          role="source"
          name={sourceName}
          detected={source}
          byGroup={byGroup}
          outdated={outdatedSide === "left"}
        />
        <span className="verdet__arrow">→</span>
        <Side
          role="target"
          name={targetName}
          detected={target}
          byGroup={byGroup}
          outdated={outdatedSide === "right"}
        />
      </div>

      {/* One group is already in the headline; two or more need a row each. */}
      {rows.length >= 2 && <FamilyTable rows={rows} />}

      {verdict && (
        <p className="verdet__why">
          {lead && (
            <>
              <b>{lead}</b>{" "}
            </>
          )}
          {verdict.reason}
        </p>
      )}

      {timeline}
    </section>
  );
}
