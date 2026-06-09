import type { ReactNode } from "react";
import { describeConstraint, isNarrowingType } from "@/lib/compare";
import type {
  ColumnSnapshot,
  CompareReport,
  ConstraintDiff,
  MatchCandidate,
  TableMatch,
  TableSnapshot,
} from "@/lib/compare-types";
import { CheckIcon } from "@/components/ui/icons";

// ---------------------------------------------------------------------------
// DiffReport — the reusable diff canvas.
//
// It renders a CompareReport (live-vs-live today, snapshot-vs-live once Phase 6
// lands) in the Pass-5 visual language: collapsible per-table groups whose rows
// are colour-coded add / change / remove. It deliberately keeps ALL the richness
// the compare engine produces — rename candidates with similarity scores, the
// columns-only-in-A/B split, per-column change descriptions with severity, and
// the full PK / UNIQUE / FK / CHECK / EXCLUDE constraint catalog.
//
// Server component on purpose: groups collapse via native <details>, so there is
// no client JS and nothing to hydrate. Drift detail (Phase 9) reuses this whole
// component with a snapshot-derived report.
// ---------------------------------------------------------------------------

type DiffKind = "add" | "rem" | "chg";

const SIGN: Record<DiffKind, string> = { add: "+", rem: "−", chg: "~" };

/** One colour-coded diff line with an optional left-hand object tag. */
function DiffLine({
  kind,
  tag,
  children,
}: {
  kind: DiffKind;
  tag?: string;
  children: ReactNode;
}) {
  return (
    <div className={`diff-row diff-${kind}`}>
      <span className="sign">{SIGN[kind]}</span>
      <span className="body">
        {tag && <span className="tag">{tag}</span>}
        {children}
      </span>
    </div>
  );
}

/** Group heading inside a table card ("Columns", "Foreign keys", …). */
function ObjHeader({ label, note }: { label: string; note?: string }) {
  return (
    <div className="obj-header">
      <span className="section-title">{label}</span>
      {note && (
        <span className="text-[11px]" style={{ color: "var(--text-3)" }}>
          {note}
        </span>
      )}
    </div>
  );
}

/** The body of a column line: `name type [NOT NULL] [DEFAULT …]`. */
function columnBody(col: ColumnSnapshot) {
  return (
    <>
      <b>{col.name}</b> <span className="muted">{col.typeDisplay}</span>
      {!col.nullable && <> <b>NOT NULL</b></>}
      {col.columnDefault !== null && (
        <> <span className="muted">DEFAULT {col.columnDefault}</span></>
      )}
    </>
  );
}

// ── change-severity → which colour/word a per-column change is ───────────────
// Mirrors the classifier the SQL generator uses so the diff and the script agree.
// Change strings read source→target, but the migration rewrites the TARGET to
// match the SOURCE — so the direction that *looks* relaxing in the text is
// actually the tightening one. The branches below account for that.
function changeKindOf(change: string): "breaking" | "safe" | "info" {
  if (change.startsWith("Type changed")) return "breaking";
  // "not null to nullable" = source NOT NULL, target nullable → migration ADDs
  // NOT NULL = breaking. "nullable to not null" → migration DROPs it = safe.
  if (change.includes("not null to nullable")) return "breaking";
  if (change.includes("nullable to not null")) return "safe";
  // "Size/precision changed: <new> → <current>". A shrink is a breaking
  // narrowing (can overflow existing data); a grow is a safe widen. Reuse the
  // SQL generator's narrowing check so the pill and the script never disagree.
  if (change.startsWith("Size/precision changed")) {
    const m = change.match(/^Size\/precision changed: (.+) → (.+)$/);
    if (m) {
      const newType = m[1]; // source — what the column becomes
      const currentType = m[2]; // target — current type in the DB
      return isNarrowingType(currentType, newType) ? "breaking" : "safe";
    }
    return "safe";
  }
  if (change.startsWith("Order changed")) return "info";
  if (change.includes("Primary key participation changed")) return "breaking";
  return "info";
}

const CONSTRAINT_TAG: Record<ConstraintDiff["kind"], string> = {
  "PRIMARY KEY": "pk",
  UNIQUE: "uk",
  "FOREIGN KEY": "fk",
  CHECK: "ck",
  EXCLUDE: "ex",
};

// ---------------------------------------------------------------------------
// Per-table change accounting
// ---------------------------------------------------------------------------

type Tally = { adds: number; chgs: number; rems: number };

function matchTally(match: TableMatch): Tally {
  const changedCols = match.columnMatches.filter((c) => c.changes.length > 0).length;
  const renamedCols = match.columnMatches.filter((c) => !c.exact).length;
  const addedConstraints = match.constraintDiffs.filter((d) => d.status === "onlyA").length;
  const droppedConstraints = match.constraintDiffs.filter((d) => d.status === "onlyB").length;
  const changedConstraints = match.constraintDiffs.filter(
    (d) => d.status === "changedDefinition",
  ).length;
  return {
    adds: match.columnsOnlyInA.length + addedConstraints,
    chgs: changedCols + renamedCols + changedConstraints,
    rems: match.columnsOnlyInB.length + droppedConstraints,
  };
}

/** Worst-case severity for a matched table, used for its header pill. */
function matchLevel(match: TableMatch): "breaking" | "additive" {
  const breakingColumn = match.columnMatches.some(
    (c) => c.changes.some((ch) => changeKindOf(ch) === "breaking") || !c.exact,
  );
  const breakingNewCol = match.columnsOnlyInA.some(
    (c) => !c.nullable && c.columnDefault === null,
  );
  const breakingConstraint = match.constraintDiffs.some(
    (d) =>
      (d.kind === "PRIMARY KEY" || d.kind === "FOREIGN KEY") &&
      (d.status === "onlyA" || d.status === "onlyB" || d.status === "changedDefinition"),
  );
  return breakingColumn || breakingNewCol || breakingConstraint ? "breaking" : "additive";
}

/** Compact `+a ~c −r` chips for a group/table header. */
function DeltaChips({ adds, chgs, rems }: Tally) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="delta delta-add" style={adds ? undefined : { opacity: 0.4 }}>
        + {adds}
      </span>
      <span className="delta delta-chg" style={chgs ? undefined : { opacity: 0.4 }}>
        ~ {chgs}
      </span>
      <span className="delta delta-rem" style={rems ? undefined : { opacity: 0.4 }}>
        − {rems}
      </span>
    </span>
  );
}

function LevelPill({ level }: { level: "breaking" | "additive" }) {
  return level === "breaking" ? (
    <span className="pill pill-break">
      <span className="dot" />
      breaking
    </span>
  ) : (
    <span className="pill pill-pending">
      <span className="dot" />
      additive
    </span>
  );
}

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

// ---------------------------------------------------------------------------
// Table cards
// ---------------------------------------------------------------------------

/** A table that exists only in the source — the migration CREATEs it in target. */
function NewTableCard({ table }: { table: TableSnapshot }) {
  return (
    <details className="table-group" open>
      <summary className="tg-header">
        <ChevronDown />
        <span className="name">{table.name}</span>
        <span className="pill pill-sync">
          <span className="dot" />
          new
        </span>
        <div className="ml-auto">
          <DeltaChips adds={table.columns.length} chgs={0} rems={0} />
        </div>
      </summary>

      <div className="obj-group">
        <ObjHeader label="Columns" note={`${table.columns.length} added`} />
        {table.columns.map((col) => (
          <DiffLine key={col.name} kind="add" tag="column">
            {columnBody(col)}
          </DiffLine>
        ))}
      </div>

      {table.primaryKey && (
        <div className="obj-group">
          <ObjHeader label="Primary key" />
          <DiffLine kind="add" tag="pk">
            <b>{table.primaryKey.name}</b>{" "}
            <span className="muted">{table.primaryKey.definition}</span>
          </DiffLine>
        </div>
      )}

      {table.foreignKeys.length > 0 && (
        <div className="obj-group">
          <ObjHeader label="Foreign keys" />
          {table.foreignKeys.map((fk) => (
            <DiffLine key={fk.name} kind="add" tag="fk">
              <b>{fk.name}</b>{" "}
              <span className="muted">{describeConstraint(fk)}</span>
            </DiffLine>
          ))}
        </div>
      )}
    </details>
  );
}

/** A table that exists only in the target — kept (never auto-dropped), flagged. */
function ExtraTableCard({ table }: { table: TableSnapshot }) {
  return (
    <details className="table-group">
      <summary className="tg-header">
        <ChevronDown />
        <span className="name">{table.name}</span>
        <span className="pill pill-neutral">
          <span className="dot" />
          only in target
        </span>
        <div className="ml-auto">
          <DeltaChips adds={0} chgs={0} rems={table.columns.length} />
        </div>
      </summary>

      <div className="obj-group">
        <ObjHeader label="Columns" note="kept — not dropped automatically" />
        {table.columns.map((col) => (
          <DiffLine key={col.name} kind="rem" tag="column">
            {columnBody(col)}
          </DiffLine>
        ))}
        <p className="help mt-1">
          This table is only in the target schema. Dropping it could lose data, so
          the migration leaves it untouched — review and remove it manually if it
          really is obsolete.
        </p>
      </div>
    </details>
  );
}

/** A table present in both whose structure differs. */
function ChangedTableCard({ match }: { match: TableMatch }) {
  const tally = matchTally(match);
  const level = matchLevel(match);
  const changedColumns = match.columnMatches.filter((c) => c.changes.length > 0);
  const renamedColumns = match.columnMatches.filter((c) => !c.exact);
  const constraintDiffs = match.constraintDiffs;

  return (
    <details className="table-group" open>
      <summary className="tg-header">
        <ChevronDown />
        <span className="name">
          {match.exact ? (
            match.left.name
          ) : (
            <>
              <s>{match.right.name}</s> → {match.left.name}
            </>
          )}
        </span>
        {!match.exact && (
          <span className="pill pill-drift">
            <span className="dot" />
            renamed · {match.score}%
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          <DeltaChips {...tally} />
          <LevelPill level={level} />
        </div>
      </summary>

      {/* Columns */}
      {(match.columnsOnlyInA.length > 0 ||
        changedColumns.length > 0 ||
        match.columnsOnlyInB.length > 0) && (
        <div className="obj-group">
          <ObjHeader label="Columns" />
          {match.columnsOnlyInA.map((col) => (
            <DiffLine key={`a-${col.name}`} kind="add" tag="column">
              {columnBody(col)}
            </DiffLine>
          ))}
          {changedColumns.map((cm) => (
            <DiffLine key={`c-${cm.left.name}`} kind="chg" tag="type">
              <b>{cm.left.name}</b>{" "}
              <span className="muted">{cm.changes.join("; ")}</span>
            </DiffLine>
          ))}
          {match.columnsOnlyInB.map((col) => (
            <DiffLine key={`b-${col.name}`} kind="rem" tag="column">
              {columnBody(col)}{" "}
              <span className="muted">— only in target, kept</span>
            </DiffLine>
          ))}
        </div>
      )}

      {/* Possible renamed columns */}
      {match.possibleColumnMatches.length > 0 && (
        <div className="obj-group">
          <ObjHeader label="Possible renamed columns" />
          {match.possibleColumnMatches.map((cand) => (
            <RenameChip key={`${cand.leftName}-${cand.rightName}`} candidate={cand} />
          ))}
        </div>
      )}

      {/* Confirmed column renames (already accepted by the matcher) */}
      {renamedColumns.length > 0 && (
        <div className="obj-group">
          <ObjHeader label="Renamed columns" />
          {renamedColumns.map((cm) => (
            <DiffLine key={`r-${cm.right.name}`} kind="chg" tag="rename">
              <s>{cm.right.name}</s> → <b>{cm.left.name}</b>{" "}
              <span className="muted">· {cm.score}% match — verify</span>
            </DiffLine>
          ))}
        </div>
      )}

      {/* Constraints */}
      {constraintDiffs.length > 0 && (
        <div className="obj-group">
          <ObjHeader label="Constraints" />
          {constraintDiffs.map((diff, i) => {
            const kind: DiffKind =
              diff.status === "onlyA" ? "add" : diff.status === "onlyB" ? "rem" : "chg";
            return (
              <DiffLine key={`${diff.kind}-${i}`} kind={kind} tag={CONSTRAINT_TAG[diff.kind]}>
                <span className="muted">{diff.summary}</span>
              </DiffLine>
            );
          })}
        </div>
      )}
    </details>
  );
}

/** Dashed "possible rename" suggestion with similarity score. */
function RenameChip({ candidate }: { candidate: MatchCandidate }) {
  return (
    <div className="rename">
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="var(--drift)"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        style={{ flex: "none" }}
      >
        <circle cx="12" cy="12" r="10" />
        <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3M12 17h.01" />
      </svg>
      <div className="flex-1 min-w-0">
        <div className="text-[12.5px] font-medium">
          Possible {candidate.kind} rename
        </div>
        <div className="what mt-0.5">
          <s>{candidate.leftName}</s> → <b style={{ color: "var(--text)" }}>{candidate.rightName}</b>{" "}
          · {candidate.score}% similarity — verify before treating as a rename
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Public component
// ---------------------------------------------------------------------------

export function DiffReport({ report }: { report: CompareReport }) {
  const changedTables = report.matchedTables.filter((m) => m.hasChanges);
  const unchanged = report.matchedTables.filter((m) => !m.hasChanges);
  const tableRenames = report.possibleTableMatches;

  const anyChanges =
    report.tablesOnlyInA.length > 0 ||
    report.tablesOnlyInB.length > 0 ||
    changedTables.length > 0 ||
    tableRenames.length > 0;

  if (!anyChanges) {
    return (
      <div className="panel p-5 flex items-center gap-3">
        <span
          className="w-8 h-8 rounded-lg grid place-items-center flex-none"
          style={{ background: "var(--sync-soft)", color: "var(--sync)" }}
        >
          <CheckIcon size={16} />
        </span>
        <div>
          <div className="text-[14px] font-medium">Schemas are in sync</div>
          <div className="help">
            No structural differences were found between the two sources.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Possible renamed tables (full-width suggestions) */}
      {tableRenames.map((cand) => (
        <RenameChip key={`${cand.leftName}-${cand.rightName}`} candidate={cand} />
      ))}

      {/* Tables only in the source — created by the migration */}
      {report.tablesOnlyInA.map((table) => (
        <NewTableCard key={`new-${table.name}`} table={table} />
      ))}

      {/* Matched tables with structural changes */}
      {changedTables.map((match) => (
        <ChangedTableCard key={`chg-${match.left.name}`} match={match} />
      ))}

      {/* Tables only in the target — flagged, never auto-dropped */}
      {report.tablesOnlyInB.map((table) => (
        <ExtraTableCard key={`extra-${table.name}`} table={table} />
      ))}

      {/* Unchanged tables — collapsed summary so the diff stays focused */}
      {unchanged.length > 0 && (
        <div
          className="panel p-3 flex items-center gap-3 text-[12.5px]"
          style={{ color: "var(--text-3)" }}
        >
          <span style={{ color: "var(--sync)", flex: "none" }}>
            <CheckIcon size={14} />
          </span>
          <span>
            <b style={{ color: "var(--text-2)" }}>
              {unchanged.length} table{unchanged.length === 1 ? "" : "s"}
            </b>{" "}
            unchanged ·{" "}
            <span className="mono">
              {unchanged
                .slice(0, 5)
                .map((m) => m.left.name)
                .join(", ")}
              {unchanged.length > 5 ? "…" : ""}
            </span>
          </span>
        </div>
      )}
    </div>
  );
}

/** Headline counts for the diff summary strip above the canvas. */
export function tallyDelta(report: CompareReport): {
  adds: number;
  chgs: number;
  rems: number;
  tablesTouched: number;
  total: number;
} {
  let adds = report.tablesOnlyInA.length;
  let rems = report.tablesOnlyInB.length;
  let chgs = report.possibleTableMatches.length;

  for (const match of report.matchedTables) {
    if (!match.hasChanges) continue;
    const t = matchTally(match);
    adds += t.adds;
    chgs += t.chgs;
    rems += t.rems;
  }

  const tablesTouched =
    report.tablesOnlyInA.length +
    report.tablesOnlyInB.length +
    report.matchedTables.filter((m) => m.hasChanges).length;

  return { adds, chgs, rems, tablesTouched, total: adds + chgs + rems };
}
