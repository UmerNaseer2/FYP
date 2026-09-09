import type { ReactNode } from "react";
import {
  addedColumnSeverity,
  columnMatchSeverity,
  constraintDiffSeverity,
  describeConstraint,
  droppedColumnSeverity,
  objectDiffSeverity,
} from "@/lib/compare";
import type {
  ColumnSnapshot,
  CompareReport,
  ConstraintDiff,
  MatchCandidate,
  ObjectDiff,
  ObjectKind,
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

/**
 * How this view should talk about the drops that making the target match the
 * source would require.
 *
 *   "none"  — no migration script is rendered beside the report (/drift). The
 *             copy states what a sync would cost and claims nothing else.
 *   "safe"  — a script is rendered and its DROP statements are commented out.
 *   "armed" — a script is rendered and its DROP statements will run.
 *
 * These map 1:1 onto generateMigration()'s allowDataLoss option — see
 * lib/generate-sql.ts, which is the only thing that actually emits SQL.
 */
type DropMode = "none" | "safe" | "armed";

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

// This file used to carry a changeKindOf() that re-derived each change's
// severity by string-matching the compare engine's prose. It is gone: a
// ColumnChange now arrives already graded by lib/compare.ts, which is also
// where the migration generator gets its grades from. Rewording a message can
// no longer mis-colour the report, and the four changes that had no matching
// branch at all — default, generated, unique and foreign-key participation —
// are no longer silently graded "info".

const CONSTRAINT_TAG: Record<ConstraintDiff["kind"], string> = {
  "PRIMARY KEY": "pk",
  UNIQUE: "uk",
  "FOREIGN KEY": "fk",
  CHECK: "ck",
  EXCLUDE: "ex",
};

const OBJECT_TAG: Record<ObjectKind, string> = {
  INDEX: "index",
  TRIGGER: "trigger",
  VIEW: "view",
  "MATERIALIZED VIEW": "matview",
  SEQUENCE: "sequence",
  ENUM: "enum",
  DOMAIN: "domain",
  "COMPOSITE TYPE": "type",
  "RANGE TYPE": "range",
  FUNCTION: "function",
  PROCEDURE: "procedure",
};

/**
 * Which schema-scoped objects belong under which heading.
 *
 * Enums, domains, composite types and range types are four kinds of the same
 * thing to anyone reading a diff, and splitting them into four one-line
 * sections would bury the change. Indexes and triggers are absent on purpose —
 * they hang off a table and are rendered inside that table's card.
 */
const SCHEMA_OBJECT_SECTIONS: { label: string; kinds: ObjectKind[] }[] = [
  { label: "Views", kinds: ["VIEW", "MATERIALIZED VIEW"] },
  { label: "Sequences", kinds: ["SEQUENCE"] },
  { label: "Types", kinds: ["ENUM", "DOMAIN", "COMPOSITE TYPE", "RANGE TYPE"] },
  { label: "Functions", kinds: ["FUNCTION", "PROCEDURE"] },
];

function objectKindOf(diff: ObjectDiff): DiffKind {
  return diff.status === "onlyA" ? "add" : diff.status === "onlyB" ? "rem" : "chg";
}

/**
 * What the migration would do about this object, in the reader's words.
 *
 * ObjectDiff.summary is a full sentence naming the object again ("Index idx_x
 * exists only in …"), which reads badly on a line that already shows the name
 * in bold. This is the tail of that sentence and nothing more — display text,
 * never a severity: the grade comes from objectDiffSeverity, which is the same
 * function the SQL generator's statements are graded by.
 */
function objectNote(diff: ObjectDiff): string {
  if (diff.status === "onlyA") return "only in source — created";
  if (diff.status === "onlyB") return "only in target — dropped";
  if (diff.kind === "VIEW" || diff.kind === "MATERIALIZED VIEW") {
    // CREATE OR REPLACE VIEW refuses any change to the column list, so the
    // generator drops the view with CASCADE and rebuilds it.
    return "definition changed — dropped and rebuilt";
  }
  // An index cannot be altered in place either, but nothing depends on one, so
  // the drop takes nothing with it.
  if (diff.kind === "INDEX") return "definition changed — dropped and recreated";
  return "definition changed — replaced";
}

/**
 * One group of object diff lines under a heading.
 *
 * `uniqueIndexes` carries the names of the TARGET's unique indexes, because
 * that is what objectDiffSeverity needs to tell "this index only made reads
 * faster" from "this index was enforcing a rule" — and the target's index is
 * the one a migration drops.
 */
function ObjectLines({
  label,
  diffs,
  uniqueIndexes,
}: {
  label: string;
  diffs: ObjectDiff[];
  uniqueIndexes?: Set<string>;
}) {
  if (diffs.length === 0) return null;
  return (
    <div className="obj-group">
      <ObjHeader label={label} />
      {diffs.map((diff, i) => {
        const severity = objectDiffSeverity(diff, uniqueIndexes?.has(diff.name));
        return (
          <DiffLine
            key={`${diff.kind}-${diff.name}-${i}`}
            kind={objectKindOf(diff)}
            tag={OBJECT_TAG[diff.kind]}
          >
            <b>{diff.name}</b>{" "}
            <span className={severity === "breaking" ? "chg-break" : "muted"}>
              · {objectNote(diff)}
              {severity === "breaking" ? " · breaking" : ""}
            </span>
          </DiffLine>
        );
      })}
    </div>
  );
}

/** The target's unique index names — the input objectDiffSeverity grades on. */
function uniqueIndexNames(table: TableSnapshot): Set<string> {
  return new Set(
    (table.indexes ?? []).filter((ix) => ix.isUnique).map((ix) => ix.name)
  );
}

function pickKinds(diffs: ObjectDiff[], kinds: ObjectKind[]): ObjectDiff[] {
  return diffs.filter((diff) => kinds.includes(diff.kind));
}

// ---------------------------------------------------------------------------
// Per-table change accounting
// ---------------------------------------------------------------------------

type Tally = { adds: number; chgs: number; rems: number };

function matchTally(match: TableMatch): Tally {
  // One test, not two. A column can be renamed AND have its type or nullability
  // changed; it is still one column and one card row, and counting it in a
  // "changed" list and a "renamed" list made the chips read ~2 for it. This is
  // the same test compare-summary.ts uses for the Columns row of the matrix, so
  // the chips and the matrix now agree by construction.
  const changedCols = match.columnMatches.filter(
    (c) => c.changes.length > 0 || !c.exact,
  ).length;
  const addedConstraints = match.constraintDiffs.filter((d) => d.status === "onlyA").length;
  const droppedConstraints = match.constraintDiffs.filter((d) => d.status === "onlyB").length;
  const changedConstraints = match.constraintDiffs.filter(
    (d) => d.status === "changedDefinition",
  ).length;
  // Indexes and triggers count too. They used to be left out, which made a
  // table whose only change was a dropped index show "+0 ~0 −0" above a card
  // that then listed the dropped index underneath.
  const objects = match.objectDiffs;
  return {
    adds:
      match.columnsOnlyInA.length +
      addedConstraints +
      objects.filter((d) => d.status === "onlyA").length,
    chgs:
      changedCols +
      changedConstraints +
      objects.filter((d) => d.status === "changedDefinition").length,
    rems:
      match.columnsOnlyInB.length +
      droppedConstraints +
      objects.filter((d) => d.status === "onlyB").length,
  };
}

/**
 * Worst-case severity for a matched table, used for its header pill.
 *
 * Every clause below defers to a grader in lib/compare.ts. None of them decides
 * anything here, because the pill and the script have to agree about the same
 * table and there is only one way to guarantee that.
 */
function matchLevel(match: TableMatch): "breaking" | "additive" {
  const breakingColumn = match.columnMatches.some(
    (c) => columnMatchSeverity(c) === "breaking",
  );
  const breakingNewCol = match.columnsOnlyInA.some(
    (c) => addedColumnSeverity(c) === "breaking",
  );
  // A dropped column was missing from this list entirely, so a table whose only
  // change was DROP COLUMN wore an "additive" pill above a statement the
  // generator marks both breaking and destructive.
  const droppedColumnGrade =
    match.columnsOnlyInB.length > 0 ? droppedColumnSeverity() : "safe";
  // Same rule the generator grades its ADD/DROP CONSTRAINT statements with, so
  // the pill cannot say "additive" over a statement the script marks breaking.
  const breakingConstraint = match.constraintDiffs.some(
    (d) => constraintDiffSeverity(d) === "breaking",
  );
  // Dropping a unique index or a trigger is breaking in the script, so the pill
  // has to say so too.
  const targetUnique = uniqueIndexNames(match.right);
  const breakingObject = match.objectDiffs.some(
    (d) => objectDiffSeverity(d, targetUnique.has(d.name)) === "breaking",
  );
  return breakingColumn ||
    breakingNewCol ||
    droppedColumnGrade === "breaking" ||
    breakingConstraint ||
    breakingObject
    ? "breaking"
    : "additive";
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

/**
 * A table that exists only in the source — the migration CREATEs it in target.
 *
 * It lists everything that gets created ALONGSIDE the table, not just its
 * columns: the card used to show columns, the primary key and foreign keys and
 * stop there, so a new table arriving with four indexes, a trigger and a couple
 * of CHECK constraints reported "+5" and showed five column lines while the
 * script below it ran a dozen statements.
 */
function NewTableCard({ table }: { table: TableSnapshot }) {
  // undefined means the snapshot has no record of the category, which is not
  // the same as the table having none — see ComparedObjectCategories.
  const indexes = table.indexes ?? [];
  const triggers = table.triggers ?? [];
  const otherConstraints = [
    ...table.uniqueConstraints.map((c) => ({ tag: "uk", constraint: c })),
    ...table.checkConstraints.map((c) => ({ tag: "ck", constraint: c })),
    ...table.excludeConstraints.map((c) => ({ tag: "ex", constraint: c })),
  ];
  const adds =
    table.columns.length +
    (table.primaryKey ? 1 : 0) +
    table.foreignKeys.length +
    otherConstraints.length +
    indexes.length +
    triggers.length;

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
          <DeltaChips adds={adds} chgs={0} rems={0} />
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

      {otherConstraints.length > 0 && (
        <div className="obj-group">
          <ObjHeader label="Other constraints" />
          {otherConstraints.map(({ tag, constraint }) => (
            <DiffLine key={`${tag}-${constraint.name}`} kind="add" tag={tag}>
              <b>{constraint.name}</b>{" "}
              <span className="muted">{constraint.definition}</span>
            </DiffLine>
          ))}
        </div>
      )}

      {indexes.length > 0 && (
        <div className="obj-group">
          <ObjHeader label="Indexes" />
          {indexes.map((index) => (
            <DiffLine key={index.name} kind="add" tag="index">
              <b>{index.name}</b>{" "}
              <span className="muted">
                {index.isUnique ? "unique · " : ""}
                {index.definition}
              </span>
            </DiffLine>
          ))}
        </div>
      )}

      {triggers.length > 0 && (
        <div className="obj-group">
          <ObjHeader label="Triggers" />
          {triggers.map((trigger) => (
            <DiffLine key={trigger.name} kind="add" tag="trigger">
              <b>{trigger.name}</b>{" "}
              <span className="muted">
                calls {trigger.functionName}
                {trigger.enabled ? "" : " · disabled in source"}
              </span>
            </DiffLine>
          ))}
        </div>
      )}
    </details>
  );
}

/**
 * A table that exists only in the target. The migration ALWAYS generates a
 * `DROP TABLE … CASCADE` for it; the drop mode only decides whether that
 * statement is armed, commented out, or not rendered here at all.
 */
function ExtraTableCard({
  table,
  dropMode,
}: {
  table: TableSnapshot;
  dropMode: DropMode;
}) {
  return (
    <details className="table-group">
      <summary className="tg-header">
        <ChevronDown />
        <span className="name">{table.name}</span>
        <span
          className={`pill ${dropMode === "armed" ? "pill-break" : "pill-neutral"}`}
        >
          <span className="dot" />
          {dropMode === "armed"
            ? "will be dropped"
            : dropMode === "safe"
              ? "drop held back"
              : "only in target"}
        </span>
        <div className="ml-auto">
          <DeltaChips adds={0} chgs={0} rems={table.columns.length} />
        </div>
      </summary>

      <div className="obj-group">
        <ObjHeader
          label="Columns"
          note={
            dropMode === "armed"
              ? "dropped with the table"
              : dropMode === "safe"
                ? "drop is commented out"
                : "only in the target"
          }
        />
        {table.columns.map((col) => (
          <DiffLine key={col.name} kind="rem" tag="column">
            {columnBody(col)}
          </DiffLine>
        ))}
        <p className="help mt-1">
          This table is only in the target schema, so making the target match
          the source needs{" "}
          <span className="mono">DROP TABLE {table.name} CASCADE</span>, which
          deletes the table and every row in it.{" "}
          {dropMode === "armed" ? (
            <>
              Data loss is armed, so that statement is live in the script below.
              Untick <b>Allow data loss</b> to hold it back.
            </>
          ) : dropMode === "safe" ? (
            <>
              That statement is commented out in the script below, so running the
              script leaves this table alone. Tick <b>Allow data loss</b> to arm
              it.
            </>
          ) : (
            <>
              Nothing is dropped by viewing this report — open the comparison in
              Compare to generate the SQL.
            </>
          )}
        </p>
      </div>
    </details>
  );
}

/** A table present in both whose structure differs. */
function ChangedTableCard({
  match,
  dropMode,
}: {
  match: TableMatch;
  dropMode: DropMode;
}) {
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
              {/* Each change carries its own grade, so a breaking one stands
                  out even when it sits in a list of harmless ones. */}
              {cm.changes.map((ch, i) => (
                <span key={ch.kind}>
                  {i > 0 && <span className="muted">; </span>}
                  <span className={ch.severity === "breaking" ? "chg-break" : "muted"}>
                    {ch.message}
                  </span>
                </span>
              ))}
            </DiffLine>
          ))}
          {match.columnsOnlyInB.map((col) => (
            <DiffLine key={`b-${col.name}`} kind="rem" tag="column">
              {columnBody(col)}{" "}
              <span className="muted">
                {dropMode === "armed"
                  ? "— only in target · dropped with its data"
                  : dropMode === "safe"
                    ? "— only in target · drop is commented out"
                    : "— only in target · a sync would drop it"}
              </span>
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

      {/* Indexes and triggers. The engine has always computed these and the
          generator has always emitted SQL for them; this card just never drew
          them, so a table whose only change was a dropped index opened to
          nothing at all. */}
      <ObjectLines
        label="Indexes"
        diffs={pickKinds(match.objectDiffs, ["INDEX"])}
        uniqueIndexes={uniqueIndexNames(match.right)}
      />
      <ObjectLines
        label="Triggers"
        diffs={pickKinds(match.objectDiffs, ["TRIGGER"])}
      />
    </details>
  );
}

/**
 * Everything that is not a table: views, sequences, types and functions.
 *
 * One card rather than one per object, because these are usually few and a
 * schema with three changed functions should not push the tables off the
 * screen. Only categories with something in them get a heading.
 */
function SchemaObjectsCard({ diffs }: { diffs: ObjectDiff[] }) {
  const sections = SCHEMA_OBJECT_SECTIONS.map((section) => ({
    label: section.label,
    diffs: pickKinds(diffs, section.kinds),
  })).filter((section) => section.diffs.length > 0);

  if (sections.length === 0) return null;

  const tally: Tally = {
    adds: diffs.filter((d) => d.status === "onlyA").length,
    chgs: diffs.filter((d) => d.status === "changedDefinition").length,
    rems: diffs.filter((d) => d.status === "onlyB").length,
  };
  const breaking = diffs.some((d) => objectDiffSeverity(d) === "breaking");

  return (
    <details className="table-group" open>
      <summary className="tg-header">
        <ChevronDown />
        <span className="name">Schema objects</span>
        <LevelPill level={breaking ? "breaking" : "additive"} />
        <div className="ml-auto">
          <DeltaChips {...tally} />
        </div>
      </summary>

      {sections.map((section) => (
        <ObjectLines key={section.label} label={section.label} diffs={section.diffs} />
      ))}

      <div className="obj-group">
        <p className="help">
          These belong to the schema rather than to any one table. A dropped view
          or function is graded breaking because the migration removes it and
          anything still calling it stops working — a rebuilt view is dropped
          with <span className="mono">CASCADE</span> first, which can take
          dependents with it.
        </p>
      </div>
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

export function DiffReport({
  report,
  allowDataLoss,
}: {
  report: CompareReport;
  /**
   * Mirrors the flag handed to generateMigration(). Pass it only on views that
   * render a migration script beside this report (/compare). Leave it undefined
   * on read-only views (/drift) so the copy makes no claim about a script.
   */
  allowDataLoss?: boolean;
}) {
  const dropMode: DropMode =
    allowDataLoss === undefined ? "none" : allowDataLoss ? "armed" : "safe";
  const changedTables = report.matchedTables.filter((m) => m.hasChanges);
  const unchanged = report.matchedTables.filter((m) => !m.hasChanges);
  const tableRenames = report.possibleTableMatches;

  // Same arithmetic the generator uses: one DROP TABLE per table that is only
  // in the target, one DROP COLUMN per column that is only in the target.
  const droppedTables = report.tablesOnlyInB.length;
  const droppedColumns = report.matchedTables.reduce(
    (n, m) => n + m.columnsOnlyInB.length,
    0,
  );
  // A materialized view holds its own copy of the rows, so dropping one throws
  // data away exactly like a table does — generate-sql marks those statements
  // destructive, and this banner has to count them or it under-reports what the
  // script is about to delete. A plain view is a stored query and holds nothing.
  const droppedMatviews = report.objectDiffs.filter(
    (d) => d.kind === "MATERIALIZED VIEW" && d.status === "onlyB",
  ).length;
  const destructiveCount = droppedTables + droppedColumns + droppedMatviews;

  // Object differences count as changes. They did not, which meant a schema
  // whose only difference was a dropped view rendered "Schemas are in sync"
  // above a script containing DROP VIEW — the same shape of lie as the old
  // "report says untouched while the generator emits DROP TABLE" bug.
  const anyChanges =
    report.tablesOnlyInA.length > 0 ||
    report.tablesOnlyInB.length > 0 ||
    changedTables.length > 0 ||
    tableRenames.length > 0 ||
    report.objectDiffs.length > 0;

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
      {destructiveCount > 0 && (
        <div className="banner">
          <div>
            <div className="title">
              {dropMode === "armed"
                ? `${destructiveCount} destructive statement${destructiveCount === 1 ? "" : "s"} armed`
                : dropMode === "safe"
                  ? `${destructiveCount} destructive statement${destructiveCount === 1 ? "" : "s"} held back`
                  : `Syncing would drop ${destructiveCount} object${destructiveCount === 1 ? "" : "s"}`}
            </div>
            <div className="body">
              Making the target match the source needs{" "}
              {droppedTables > 0 && (
                <b>
                  {droppedTables} table{droppedTables === 1 ? "" : "s"} dropped
                </b>
              )}
              {droppedTables > 0 && droppedColumns > 0 ? " and " : ""}
              {droppedColumns > 0 && (
                <b>
                  {droppedColumns} column{droppedColumns === 1 ? "" : "s"} dropped
                </b>
              )}
              {droppedMatviews > 0 && (
                <>
                  {droppedTables > 0 || droppedColumns > 0 ? " and " : ""}
                  <b>
                    {droppedMatviews} materialized view
                    {droppedMatviews === 1 ? "" : "s"} dropped
                  </b>
                </>
              )}
              .{" "}
              {dropMode === "armed"
                ? "Allow data loss is on, so those statements are live in the script below and the rows they remove cannot be recovered."
                : dropMode === "safe"
                  ? "Those statements are generated but commented out, so running the script below deletes nothing. Tick Allow data loss to arm them."
                  : "Viewing this report changes nothing — open the comparison in Compare to generate that SQL."}
            </div>
          </div>
        </div>
      )}

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
        <ChangedTableCard
          key={`chg-${match.left.name}`}
          match={match}
          dropMode={dropMode}
        />
      ))}

      {/* Tables only in the target — dropped by the migration when armed */}
      {report.tablesOnlyInB.map((table) => (
        <ExtraTableCard
          key={`extra-${table.name}`}
          table={table}
          dropMode={dropMode}
        />
      ))}

      {/* Views, sequences, types and functions — after the tables, because they
          are usually consequences of a table change rather than the point. */}
      <SchemaObjectsCard diffs={report.objectDiffs} />

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
  // Rename suggestions are deliberately NOT counted. A suggestion means the
  // matcher saw two unmatched tables that might be the same one — but it did
  // not accept the pairing, so both tables are still in the only-in-A and
  // only-in-B lists above and the migration still emits a CREATE and a DROP.
  // Adding the suggestion turned one suspected rename into three headline
  // changes above a script holding two statements.
  let chgs = 0;

  for (const match of report.matchedTables) {
    if (!match.hasChanges) continue;
    const t = matchTally(match);
    adds += t.adds;
    chgs += t.chgs;
    rems += t.rems;
  }

  // Schema-scoped objects are part of the headline too. Table-scoped ones are
  // already in matchTally above, so counting report.objectDiffs here and not
  // every match's would be the only way to avoid counting an index twice.
  for (const diff of report.objectDiffs) {
    if (diff.status === "onlyA") adds += 1;
    else if (diff.status === "onlyB") rems += 1;
    else chgs += 1;
  }

  const tablesTouched =
    report.tablesOnlyInA.length +
    report.tablesOnlyInB.length +
    report.matchedTables.filter((m) => m.hasChanges).length;

  return { adds, chgs, rems, tablesTouched, total: adds + chgs + rems };
}
