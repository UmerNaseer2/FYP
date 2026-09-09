import type { ReactNode } from "react";
import {
  addedColumnSeverity,
  columnMatchSeverity,
  constraintDiffSeverity,
  describeConstraint,
  describePartitioning,
  describeRowSecurity,
  droppedColumnSeverity,
  objectDiffSeverity,
} from "@/lib/compare";
import type {
  ColumnChange,
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
export type DropMode = "none" | "safe" | "armed";

/**
 * The one place allowDataLoss becomes a DropMode.
 *
 * Exported because the row-data panel below this report has to say the same
 * thing about the same drops. It used to decide on its own and always say
 * "would be destroyed", so with the switch off the page told the reader the
 * rows were gone two inches under a card saying the drop was commented out.
 */
export function dropModeFrom(allowDataLoss: boolean | undefined): DropMode {
  return allowDataLoss === undefined ? "none" : allowDataLoss ? "armed" : "safe";
}

/**
 * What the two sides of the report actually are, in the words of the page
 * around it. The compare engine only knows "left" and "right"; this says what
 * those two mean here, and that decides which way round a changed value reads.
 *
 *   "source-target"  (/compare) — left is the schema you want, right is the one
 *                     the migration rewrites. A changed value reads
 *                     right → left: what it is now, then what the script makes
 *                     it. That is the direction the generated SQL comments use.
 *   "expected-live"  (/drift)   — left is the tracked baseline, right is the
 *                     live database. A changed value reads left → right: what
 *                     it was, then what somebody changed it to.
 */
export type ReportSides = "source-target" | "expected-live";

/** What each side is called on screen, so one component can serve both pages. */
const SIDE_WORDS: Record<ReportSides, { left: string; right: string }> = {
  "source-target": { left: "the source", right: "the target" },
  "expected-live": { left: "the baseline", right: "the live database" },
};

/**
 * One changed column value, printed in the direction this page reads.
 *
 * Falls back to the engine's own sentence when the change has no single
 * before/after pair — a sequence-settings change lists several at once.
 */
function changeText(change: ColumnChange, sides: ReportSides): string {
  if (
    change.label === undefined ||
    change.leftValue === undefined ||
    change.rightValue === undefined
  ) {
    return change.message;
  }
  const [before, after] =
    sides === "expected-live"
      ? [change.leftValue, change.rightValue]
      : [change.rightValue, change.leftValue];
  return `${change.label}: ${before} → ${after}`;
}

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
  POLICY: "policy",
  "ROW SECURITY": "rls",
  PARTITIONING: "partitioning",
  COLLATION: "collation",
  EXTENSION: "extension",
  PRIVILEGES: "grants",
};

/**
 * Which schema-scoped objects belong under which heading.
 *
 * Enums, domains, composite types and range types are four kinds of the same
 * thing to anyone reading a diff, and splitting them into four one-line
 * sections would bury the change.
 *
 * Indexes and triggers appear here too, but only the ones on a VIEW: a
 * materialized view is indexed like a table, and a view's INSTEAD OF triggers
 * are what let anything write to it. A table's own are rendered inside that
 * table's card and never reach this list.
 */
const SCHEMA_OBJECT_SECTIONS: { label: string; kinds: ObjectKind[] }[] = [
  { label: "Views", kinds: ["VIEW", "MATERIALIZED VIEW"] },
  { label: "Indexes and triggers on views", kinds: ["INDEX", "TRIGGER"] },
  { label: "Sequences", kinds: ["SEQUENCE"] },
  { label: "Types", kinds: ["ENUM", "DOMAIN", "COMPOSITE TYPE", "RANGE TYPE"] },
  { label: "Extensions", kinds: ["EXTENSION"] },
  { label: "Collations", kinds: ["COLLATION"] },
  { label: "Functions", kinds: ["FUNCTION", "PROCEDURE"] },
  { label: "Ownership and grants", kinds: ["PRIVILEGES"] },
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
/**
 * Which side of a two-sided value goes first, in the direction this page reads.
 *
 * /compare reads right → left (what the target has now, then what the script
 * makes it); /drift reads left → right (what the baseline says, then what
 * somebody changed it to). Same two values, opposite order, so a reader of
 * either page gets before-then-after rather than a pair to work out.
 */
function sideValues(diff: ObjectDiff, sides: ReportSides): string {
  const words = SIDE_WORDS[sides];
  const left = `${diff.leftDefinition ?? "?"} in ${words.left}`;
  const right = `${diff.rightDefinition ?? "?"} in ${words.right}`;
  return sides === "expected-live" ? `${left}, ${right}` : `${right}, ${left}`;
}

function objectNote(diff: ObjectDiff, sides: ReportSides): string {
  // /drift is a record of what already happened; /compare is a plan for what
  // will. The compare engine has one answer for both, so the same "only in A"
  // bucket that means "the migration creates this" on /compare means "this is
  // in the tracked baseline and somebody dropped it from the live database"
  // here. Printing "created" on /drift tells the reader the opposite of the
  // truth, which is worse than printing nothing.
  const drift = sides === "expected-live";

  if (diff.kind === "EXTENSION" && diff.status === "changedDefinition") {
    // The version each side is on is the whole content of this line, so print
    // both rather than the word "changed". Whether ALTER EXTENSION can get from
    // one to the other is the compare engine's answer, read off the diff — the
    // same answer the generator gates its statement on. Ahead of the general
    // by-hand line below because that one says "replaced", and an extension
    // that cannot be updated is not replaced by anything.
    const versions = sideValues(diff, sides);
    if (drift) return versions;
    return diff.needsManualWork === true
      ? `${versions} — no update path, has to be moved by hand`
      : `${versions} — updated`;
  }
  if (diff.kind === "PRIVILEGES") {
    // Which way the access moved is the whole point of this line — "definition
    // changed" over a REVOKE tells the reader nothing they came here for. Read
    // off the grade the compare engine already decided (breaking there means
    // the right-hand side loses something) rather than re-comparing the two
    // definitions here, which is how the report and the script come to
    // disagree.
    if (diff.status === "changedDefinition") {
      const rightLoses = objectDiffSeverity(diff) === "breaking";
      if (drift) {
        // A sync can only take access away from the live database when the
        // live database has access the baseline does not, so the same grade
        // states a fact about now instead of a plan for later.
        return rightLoses
          ? "access changed — the live database grants more than the baseline"
          : "access changed — the live database grants less than the baseline";
      }
      return rightLoses
        ? "access changed — the target loses some"
        : "access changed — the target only gains";
    }
    if (diff.status === "onlyA") {
      return drift
        ? "granted in the baseline — gone from the live database"
        : "only in source — granted";
    }
  }
  // Set by the compare engine wherever no statement can carry the change. Read
  // rather than re-decided so this line and the generator's MANUAL note come
  // from one answer: a range type the snapshot cannot describe well enough to
  // create used to be drawn as "only in source — created" while the script
  // could do nothing but describe it.
  if (diff.needsManualWork === true) {
    if (diff.status === "onlyA") {
      return drift
        ? "in the baseline — gone from the live database, no automatic way back"
        : "only in source — has to be created by hand";
    }
    return "definition changed — has to be replaced by hand";
  }
  if (diff.status === "onlyA") {
    return drift
      ? "in the baseline — gone from the live database"
      : "only in source — created";
  }
  if (diff.status === "onlyB") {
    return drift
      ? "only in the live database — added since the baseline"
      : "only in target — dropped";
  }
  if (diff.kind === "ROW SECURITY" || diff.kind === "PARTITIONING") {
    // Which way the switch moves is the entire content of these lines.
    // "definition changed", over the setting that decides whether the table
    // returns any rows at all — or over the difference between a plain table
    // and a partitioned one, which no ALTER can carry — tells the reader
    // nothing they came here for.
    return sideValues(diff, sides);
  }
  if (drift) {
    // Every remaining line below describes HOW the generated migration would
    // carry the change: dropped and recreated, replaced in place. /drift
    // renders no migration, so naming statements this page will never write
    // is noise at best and a promise at worst.
    return "definition changed";
  }
  if (diff.kind === "VIEW" || diff.kind === "MATERIALIZED VIEW") {
    // Whether a drop is needed is the compare engine's call, not this file's —
    // re-deciding it here is how a report comes to describe a migration the
    // generator did not write. `false` means the WITH (...) settings moved and
    // the SELECT did not, which CREATE OR REPLACE can carry on its own.
    if (diff.replaceNeedsDrop === false) return "options changed — replaced in place";
    // Otherwise CREATE OR REPLACE VIEW refuses the change (or the object is a
    // materialized view), so the generator drops it with CASCADE and rebuilds.
    return "definition changed — dropped and rebuilt";
  }
  // An index cannot be altered in place either, but nothing depends on one, so
  // the drop takes nothing with it.
  if (diff.kind === "INDEX") return "definition changed — dropped and recreated";
  // CREATE TRIGGER has no OR REPLACE, so the generator drops and writes it
  // again. Said here rather than falling through to "replaced", which reads as
  // if one statement carried it.
  if (diff.kind === "TRIGGER") return "definition changed — dropped and recreated";
  // ALTER POLICY can move the roles and the expressions but not the command the
  // policy applies to, so the generator drops it and writes it again.
  if (diff.kind === "POLICY") return "rule changed — dropped and recreated";
  return "definition changed — replaced";
}

/**
 * One group of object diff lines under a heading.
 *
 * The grade comes off the diff itself. This component used to hand
 * objectDiffSeverity a Set of the target's unique index names that each caller
 * assembled by hand, which is how a created unique index — present only in the
 * source, so never in that Set — came to be drawn as a harmless addition.
 */
function ObjectLines({
  label,
  diffs,
  sides,
}: {
  label: string;
  diffs: ObjectDiff[];
  sides: ReportSides;
}) {
  if (diffs.length === 0) return null;
  return (
    <div className="obj-group">
      <ObjHeader label={label} />
      {diffs.map((diff, i) => {
        const severity = objectDiffSeverity(diff);
        return (
          <DiffLine
            key={`${diff.kind}-${diff.name}-${i}`}
            kind={objectKindOf(diff)}
            tag={OBJECT_TAG[diff.kind]}
          >
            <b>{diff.name}</b>{" "}
            {/* Only an index or a trigger on a view carries this at schema
                scope, and without it the line names an index and never says
                which of three materialized views it is on. */}
            {diff.table !== undefined && (
              <span className="muted">on {diff.table} </span>
            )}
            <span className={severity === "breaking" ? "chg-break" : "muted"}>
              · {objectNote(diff, sides)}
              {severity === "breaking" ? " · breaking" : ""}
            </span>
          </DiffLine>
        );
      })}
    </div>
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
  const breakingObject = match.objectDiffs.some(
    (d) => objectDiffSeverity(d) === "breaking",
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
 * A table that exists only on the left-hand side of the report.
 *
 * On /compare that is a table the migration CREATEs in the target, so the card
 * is headed "new". On /drift the left-hand side is the tracked baseline, so
 * the same bucket is a table that HAS BEEN DROPPED from the live database —
 * and this card used to head it with a green "new" pill and a list of columns
 * marked "added", which is the exact opposite of what happened.
 *
 * Either way it lists everything that belongs to the table, not just its
 * columns: the card used to show columns, the primary key and foreign keys and
 * stop there, so a new table arriving with four indexes, a trigger and a couple
 * of CHECK constraints reported "+5" and showed five column lines while the
 * script below it ran a dozen statements.
 */
function NewTableCard({ table, sides }: { table: TableSnapshot; sides: ReportSides }) {
  const drift = sides === "expected-live";
  // undefined means the snapshot has no record of the category, which is not
  // the same as the table having none — see ComparedObjectCategories.
  const indexes = table.indexes ?? [];
  const triggers = table.triggers ?? [];
  // Same rule, and it matters most here: a table created with row security on
  // and three policies is a table the migration locks down, and the card that
  // used to stop at triggers said nothing about it at all. A snapshot with no
  // record of RLS still says nothing, which is the honest answer for it.
  const rls = table.rowSecurity;
  const policies = rls?.policies ?? [];
  const rlsIsOn = Boolean(rls && (rls.enabled || policies.length > 0));
  const partitioning = table.partitioning;
  const partitioned =
    partitioning !== undefined && describePartitioning(partitioning) !== "standalone";
  const otherConstraints = [
    ...table.uniqueConstraints.map((c) => ({ tag: "uk", constraint: c })),
    ...table.checkConstraints.map((c) => ({ tag: "ck", constraint: c })),
    ...table.excludeConstraints.map((c) => ({ tag: "ex", constraint: c })),
  ];
  // Partitioning is deliberately NOT in this count: it is a clause of the same
  // CREATE TABLE the columns are in, not another thing created. The switch and
  // the policies ARE separate statements, so they are.
  const adds =
    table.columns.length +
    (table.primaryKey ? 1 : 0) +
    table.foreignKeys.length +
    otherConstraints.length +
    indexes.length +
    triggers.length +
    (rlsIsOn ? 1 : 0) +
    policies.length;

  return (
    <details className="table-group" open>
      <summary className="tg-header">
        <ChevronDown />
        <span className="name">{table.name}</span>
        <span className={`pill ${drift ? "pill-break" : "pill-sync"}`}>
          <span className="dot" />
          {drift ? "missing" : "new"}
        </span>
        <div className="ml-auto">
          <DeltaChips adds={adds} chgs={0} rems={0} />
        </div>
      </summary>

      <div className="obj-group">
        <ObjHeader
          label="Columns"
          note={
            drift
              ? `${table.columns.length} gone with the table`
              : `${table.columns.length} added`
          }
        />
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
                {trigger.enabled ? "" : ` · disabled in ${SIDE_WORDS[sides].left}`}
              </span>
            </DiffLine>
          ))}
        </div>
      )}

      {/* Row security. Only when it is actually on: every table has a switch,
          so drawing "DISABLED" on all of them would bury the ones that matter.
          A new table is created with the switch OFF whatever the source says,
          so the script writes it out — and until this group existed, the one
          statement that decides who can read the new table appeared in the SQL
          and nowhere in the report. */}
      {rls && rlsIsOn && (
        <div className="obj-group">
          <ObjHeader
            label="Row security"
            note={
              policies.length === 0
                ? "on, with no policies — nobody but the owner can read it"
                : undefined
            }
          />
          <DiffLine kind="add" tag="rls">
            <b>{describeRowSecurity(rls)}</b>{" "}
            <span className="muted">
              {rls.forced
                ? "policies apply to the table owner too"
                : "the table owner bypasses the policies"}
            </span>
          </DiffLine>
          {policies.map((policy) => (
            <DiffLine key={policy.name} kind="add" tag="policy">
              <b>{policy.name}</b>{" "}
              <span className="muted">{policy.definition}</span>
            </DiffLine>
          ))}
        </div>
      )}

      {/* Partitioning, when there is any. It is part of the CREATE TABLE rather
          than a statement of its own, which is why it is last and why it does
          not move the count above — but "this new table is a partition of
          orders" is the single most important line on the card when it is
          true. */}
      {partitioning && partitioned && (
        <div className="obj-group">
          <ObjHeader
            label="Partitioning"
            note={drift ? "part of the table" : "part of the CREATE TABLE"}
          />
          <DiffLine kind="add" tag="partitioning">
            <span className="muted">{describePartitioning(partitioning)}</span>
          </DiffLine>
        </div>
      )}
    </details>
  );
}

/**
 * A table that exists only on the right-hand side of the report.
 *
 * On /compare that is a table only in the target, and the migration ALWAYS
 * generates a `DROP TABLE … CASCADE` for it; the drop mode only decides
 * whether that statement is armed, commented out, or not rendered here at all.
 *
 * On /drift the right-hand side is the live database, so it is a table
 * somebody created outside the tracked schema. This page generates no SQL at
 * all, so the card used to tell a reader with no such button that "making the
 * target match the source needs DROP TABLE … CASCADE".
 */
function ExtraTableCard({
  table,
  dropMode,
  sides,
}: {
  table: TableSnapshot;
  dropMode: DropMode;
  sides: ReportSides;
}) {
  const drift = sides === "expected-live";
  return (
    <details className="table-group">
      <summary className="tg-header">
        <ChevronDown />
        <span className="name">{table.name}</span>
        <span
          className={`pill ${
            drift ? "pill-drift" : dropMode === "armed" ? "pill-break" : "pill-neutral"
          }`}
        >
          <span className="dot" />
          {drift
            ? "not in the baseline"
            : dropMode === "armed"
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
            drift
              ? "none of them tracked"
              : dropMode === "armed"
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
        {drift ? (
          <p className="help mt-1">
            This table is in the live database and not in the tracked baseline,
            so somebody created it outside this app. Nothing on this page
            changes it: <b>Re-baseline to live</b> accepts it as part of the expected
            structure from now on, and <b>Acknowledge</b> records that you have
            seen it and leaves the baseline alone.
          </p>
        ) : (
          <p className="help mt-1">
            This table is only in the target schema, so making the target match
            the source needs{" "}
            <span className="mono">DROP TABLE {table.name} CASCADE</span>, which
            deletes the table and every row in it.{" "}
            {dropMode === "armed" ? (
              <>
                Data loss is armed, so that statement is live in the script
                below. Untick <b>Allow data loss</b> to hold it back.
              </>
            ) : dropMode === "safe" ? (
              <>
                That statement is commented out in the script below, so running
                the script leaves this table alone. Tick <b>Allow data loss</b>{" "}
                to arm it.
              </>
            ) : (
              <>
                Nothing is dropped by viewing this report — open the comparison
                in Compare to generate the SQL.
              </>
            )}
          </p>
        )}
      </div>
    </details>
  );
}

/** A table present in both whose structure differs. */
function ChangedTableCard({
  match,
  dropMode,
  sides,
}: {
  match: TableMatch;
  dropMode: DropMode;
  sides: ReportSides;
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
          ) : sides === "expected-live" ? (
            <>
              <s>{match.left.name}</s> → {match.right.name}
            </>
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
                    {changeText(ch, sides)}
                  </span>
                </span>
              ))}
            </DiffLine>
          ))}
          {match.columnsOnlyInB.map((col) => (
            <DiffLine key={`b-${col.name}`} kind="rem" tag="column">
              {columnBody(col)}{" "}
              <span className="muted">
                {sides === "expected-live"
                  ? "— added to the live database, not in the baseline"
                  : dropMode === "armed"
                    ? `— only in ${SIDE_WORDS[sides].right} · dropped with its data`
                    : dropMode === "safe"
                      ? `— only in ${SIDE_WORDS[sides].right} · drop is commented out`
                      : `— only in ${SIDE_WORDS[sides].right} · a sync would drop it`}
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
            <RenameChip
              key={`${cand.leftName}-${cand.rightName}`}
              candidate={cand}
              sides={sides}
            />
          ))}
        </div>
      )}

      {/* Confirmed column renames (already accepted by the matcher) */}
      {renamedColumns.length > 0 && (
        <div className="obj-group">
          <ObjHeader label="Renamed columns" />
          {renamedColumns.map((cm) => (
            <DiffLine key={`r-${cm.right.name}`} kind="chg" tag="rename">
              {sides === "expected-live" ? (
                <>
                  <s>{cm.left.name}</s> → <b>{cm.right.name}</b>
                </>
              ) : (
                <>
                  <s>{cm.right.name}</s> → <b>{cm.left.name}</b>
                </>
              )}{" "}
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
        sides={sides}
      />
      <ObjectLines
        label="Triggers"
        diffs={pickKinds(match.objectDiffs, ["TRIGGER"])}
        sides={sides}
      />
      {/* One heading for the switch and its policies, because reading either
          on its own gives the wrong answer: three policies with the switch off
          enforce nothing, and the switch on with no policy denies everyone. */}
      <ObjectLines
        label="Row security"
        diffs={pickKinds(match.objectDiffs, ["ROW SECURITY", "POLICY"])}
        sides={sides}
      />
      {/* Partitioning. A partitioned table and a plain one with the same
          columns used to compare as "identical structure", which was a false
          statement rather than a missing one. */}
      <ObjectLines
        label="Partitioning"
        diffs={pickKinds(match.objectDiffs, ["PARTITIONING"])}
        sides={sides}
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
function SchemaObjectsCard({
  diffs,
  sides,
}: {
  diffs: ObjectDiff[];
  sides: ReportSides;
}) {
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
        <ObjectLines
          key={section.label}
          label={section.label}
          diffs={section.diffs}
          sides={sides}
        />
      ))}

      <div className="obj-group">
        {sides === "expected-live" ? (
          <p className="help">
            These belong to the schema rather than to any one table. Like every
            grade on this page, <b>breaking</b> is measured against putting the
            baseline back: a view only in the live database is graded breaking
            because the way back drops it, and one that is in the baseline and
            already gone is graded breaking because whatever called it has
            already stopped working.
          </p>
        ) : (
          <p className="help">
            These belong to the schema rather than to any one table. A dropped
            view or function is graded breaking because the migration removes it
            and anything still calling it stops working — a rebuilt view is
            dropped with <span className="mono">CASCADE</span> first, which can
            take dependents with it. Rebuilding a view also takes every index and
            trigger on it, so the script writes all of them back, whether or not
            they are listed here as changed.
          </p>
        )}
      </div>
    </details>
  );
}

/** Dashed "possible rename" suggestion with similarity score. */
function RenameChip({
  candidate,
  sides,
}: {
  candidate: MatchCandidate;
  sides: ReportSides;
}) {
  // The struck-through name is the one that already exists on the side being
  // read as "before", exactly like the confirmed-rename line in
  // ChangedTableCard. This chip used to print source → target while that line
  // printed target → source, so the same card offered two renames pointing
  // opposite ways.
  const [before, after] =
    sides === "expected-live"
      ? [candidate.leftName, candidate.rightName]
      : [candidate.rightName, candidate.leftName];
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
          <s>{before}</s> → <b style={{ color: "var(--text)" }}>{after}</b>{" "}
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
  sides = "source-target",
}: {
  report: CompareReport;
  /**
   * Mirrors the flag handed to generateMigration(). Pass it only on views that
   * render a migration script beside this report (/compare). Leave it undefined
   * on read-only views (/drift) so the copy makes no claim about a script.
   */
  allowDataLoss?: boolean;
  /**
   * What "left" and "right" mean on the page rendering this. Defaults to
   * /compare's reading; /drift passes "expected-live". See ReportSides.
   */
  sides?: ReportSides;
}) {
  const dropMode = dropModeFrom(allowDataLoss);
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
  //
  // Which diffs those are is the compare engine's answer, not this file's. The
  // test here used to be `kind === "MATERIALIZED VIEW" && status === "onlyB"`,
  // which missed a matview whose SELECT changed — dropped and rebuilt, so still
  // dropped — and missed a plain view in the source that is a matview in the
  // target, because `kind` is stamped from the SOURCE and reads "VIEW". Both
  // put a destructive DROP in the script this banner sits above.
  const droppedMatviews = report.objectDiffs.filter((d) => d.dropDestroysData).length;
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
            {sides === "expected-live"
              ? "The live database matches the tracked baseline."
              : "No structural differences were found between the two sources."}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* The signs are the first thing a reader has to decode, and they mean
          something different on each page: on /compare a "+" is work the script
          will do, on /drift it is something already missing from the live
          database. Saying so once here is cheaper than qualifying every row. */}
      <p className="help">
        {sides === "expected-live" ? (
          <>
            Read this as the work it would take to put the live database back to
            the baseline. <b>+</b> is in the baseline but missing from the live
            database, <b>−</b> is in the live database and not in the baseline,
            and <b>~</b> is in both with something different about it.
          </>
        ) : (
          <>
            Every row is a change to the <b>target</b>. <b>+</b> is created,{" "}
            <b>−</b> is dropped, and <b>~</b> is altered in place — and a{" "}
            <span className="mono">before → after</span> pair reads left to
            right, the value the target has now and the value this migration
            gives it.
          </>
        )}
      </p>

      {destructiveCount > 0 && (
        <div className="banner">
          <div>
            <div className="title">
              {sides === "expected-live"
                ? `Going back to the baseline would drop ${destructiveCount} thing${destructiveCount === 1 ? "" : "s"}`
                : dropMode === "armed"
                  ? `${destructiveCount} destructive statement${destructiveCount === 1 ? "" : "s"} armed`
                  : dropMode === "safe"
                    ? `${destructiveCount} destructive statement${destructiveCount === 1 ? "" : "s"} held back`
                    : `Syncing would drop ${destructiveCount} object${destructiveCount === 1 ? "" : "s"}`}
            </div>
            <div className="body">
              {sides === "expected-live"
                ? "Undoing this drift needs "
                : "Making the target match the source needs "}
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
              {sides === "expected-live"
                ? "This page writes no SQL and drops nothing. Author a migration opens Compare with the live database already on the target side, and you choose what to compare it against."
                : dropMode === "armed"
                  ? "Allow data loss is on, so those statements are live in the script below and the rows they remove cannot be recovered."
                  : dropMode === "safe"
                    ? "Those statements are generated but commented out, so running the script below deletes nothing. Tick Allow data loss to arm them."
                    : "Viewing this report changes nothing — open the comparison in Compare to generate that SQL."}
              {sides !== "expected-live" && dropMode === "safe" && droppedMatviews > 0 ? (
                // A matview is rebuilt by CREATE MATERIALIZED VIEW IF NOT
                // EXISTS, which does nothing while the old one is still there.
                // The script holds that rebuild back with the drop, so saying
                // only "deletes nothing" would leave the reader expecting the
                // new definition to arrive anyway. It does not.
                <>
                  {" "}
                  {droppedMatviews === 1
                    ? "The rebuild is held back with it, so that view keeps the target's definition and rows until you do."
                    : "The rebuilds are held back with them, so those views keep the target's definition and rows until you do."}
                </>
              ) : null}
            </div>
          </div>
        </div>
      )}

      {/* Possible renamed tables (full-width suggestions) */}
      {tableRenames.map((cand) => (
        <RenameChip
          key={`${cand.leftName}-${cand.rightName}`}
          candidate={cand}
          sides={sides}
        />
      ))}

      {/* Tables only on the left — created by the migration on /compare,
          already gone from the live database on /drift. */}
      {report.tablesOnlyInA.map((table) => (
        <NewTableCard key={`new-${table.name}`} table={table} sides={sides} />
      ))}

      {/* Matched tables with structural changes */}
      {changedTables.map((match) => (
        <ChangedTableCard
          key={`chg-${match.left.name}`}
          match={match}
          dropMode={dropMode}
          sides={sides}
        />
      ))}

      {/* Tables only on the right — dropped by the migration when armed on
          /compare, created outside the tracked schema on /drift. */}
      {report.tablesOnlyInB.map((table) => (
        <ExtraTableCard
          key={`extra-${table.name}`}
          table={table}
          dropMode={dropMode}
          sides={sides}
        />
      ))}

      {/* Views, sequences, types and functions — after the tables, because they
          are usually consequences of a table change rather than the point. */}
      <SchemaObjectsCard diffs={report.objectDiffs} sides={sides} />

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
