// ---------------------------------------------------------------------------
// compare-export.ts
// Flattens a finished CompareReport into a document that can leave the screen.
//
// The report is a tree — tables holding columns holding changes, plus objects
// hanging off both the tables and the schema. Nothing outside a browser can
// read that shape usefully, so everything the canvas draws is flattened here
// into one list of rows: one row per change, with the category, the object, the
// verdict and the severity spelled out. A spreadsheet, a diff of two exports, a
// script that greps for "breaking" — all of them want the flat list.
//
// Severity is never decided here. Every row's grade comes from the graders in
// compare.ts, which are the same ones the diff canvas reads and are checked
// against what lib/generate-sql.ts writes. An export that graded a change
// differently from the screen it was exported from would be worse than no
// export at all.
//
// Rendering the document as JSON / CSV / Markdown lives in
// compare-export-format.ts, which imports nothing at runtime so the browser
// bundle for the export buttons does not drag the whole compare engine in.
// ---------------------------------------------------------------------------

import {
  addedColumnSeverity,
  columnMatchSeverity,
  constraintDiffSeverity,
  droppedColumnSeverity,
  objectDiffSeverity,
} from "./compare";
// From compare-data-summary, not compare-data: the export bar is a client
// component, and compare-data opens connections, so importing a value from it
// would put the PostgreSQL driver in the browser bundle.
import {
  summarizeDataCompare,
  type DataCompareReport,
  type TableDataCompare,
} from "./compare-data-summary";
import { summaryRows, type SummaryRow } from "./compare-summary";
import type {
  ChangeSeverity,
  ColumnSnapshot,
  CompareReport,
  NotComparedReason,
  ObjectDiff,
  ObjectKind,
} from "./compare-types";

/** The heading a row files under. Deliberately the matrix's own vocabulary. */
export type ChangeCategory =
  | "Table"
  | "Column"
  | "Constraint"
  | "Index"
  | "Trigger"
  | "View"
  | "Sequence"
  | "Type"
  | "Collation"
  | "Extension"
  | "Function"
  | "Row security"
  | "Partitioning"
  | "Privileges";

/**
 * What the migration would do.
 *
 * "rename-suggested" is not a change the script makes — it is a pairing the
 * matcher spotted but did not accept, shown on screen as a suggestion. It is
 * carried in the same list so a reader who exports the page gets everything the
 * page showed them, and it is a distinct verb so nobody mistakes it for work
 * the migration is about to do.
 */
export type ChangeVerdict =
  | "added"
  | "dropped"
  | "changed"
  | "renamed"
  | "rename-suggested";

export type ChangeRow = {
  category: ChangeCategory;
  /** The table the object belongs to; empty for schema-scoped objects. */
  table: string;
  object: string;
  change: ChangeVerdict;
  severity: ChangeSeverity;
  detail: string;
  /**
   * True when no statement can carry this change and a person has to plan it —
   * a range type the snapshot cannot describe well enough to write CREATE TYPE,
   * a changed collation, a changed range type. The script writes a note for
   * each of these and runs nothing.
   *
   * Kept beside `change` rather than folded into it as a sixth verdict: the row
   * is still an addition or still a change, and a reader filtering the CSV for
   * "changed" should keep finding it. What this adds is that the migration will
   * not do it for them. See ObjectDiff.needsManualWork, which is where the
   * decision is made — this only carries it out to the file.
   */
  manual: boolean;
};

/**
 * The row-level half of a comparison, when one was run.
 *
 * Carried in the document rather than left on screen because the numbers that
 * matter most in a review are here: a table only the target has is a table the
 * migration drops, and `rowsAtRiskOfDrop` counts the rows that go with it. An
 * export that showed the schema changes but not that number would understate
 * the migration to exactly the reader who most needs it spelled out.
 */
export type DataSection = {
  /** Per-statement timeout the run actually used, in milliseconds. */
  timeoutMs: number;
  /** A failure that stopped the whole run — no table line below is meaningful. */
  error: string | null;
  totals: {
    identical: number;
    different: number;
    sourceOnly: number;
    targetOnly: number;
    skipped: number;
    /** Rows a full sync destroys: they live in tables only the target has. */
    rowsAtRiskOfDrop: number;
    /**
     * Tables a full sync drops whose rows were never counted. Their rows are
     * NOT in rowsAtRiskOfDrop, so a reader shown only that number would be told
     * a smaller loss than the one the migration causes.
     */
    unreadDrops: number;
  };
  tables: TableDataCompare[];
};

export type DiffDocument = {
  /** Stamped so a file found on disk months later identifies itself. */
  format: "schema-studio-diff";
  version: 1;
  source: { database: string; schema: string };
  target: { database: string; schema: string };
  totals: {
    changes: number;
    added: number;
    dropped: number;
    changed: number;
    renamed: number;
    renameSuggestions: number;
    breaking: number;
    /** Of those changes, how many the script cannot make. See ChangeRow.manual. */
    manual: number;
  };
  /**
   * Categories that were skipped, each with the reason it was skipped.
   * Absent from `categories` counts and absent from `changes` — a reader has to
   * be told that, or "0 views changed" reads as "the views match".
   *
   * The reason is carried rather than assumed. This used to be a bare list and
   * every reader of it printed "one of the two snapshots has no record of
   * them", which is untrue for a category that is counted per table pair when
   * no table pair exists.
   */
  notCompared: Array<{ category: ChangeCategory; reason: NotComparedReason }>;
  categories: SummaryRow[];
  changes: ChangeRow[];
  /**
   * null when no row comparison was run. That is not "the rows match", so the
   * formatters say which of the two it is instead of printing nothing.
   */
  data: DataSection | null;
};

/** Which heading each object kind files under. Matches SummaryMatrix's rows. */
const OBJECT_CATEGORY: Record<ObjectKind, ChangeCategory> = {
  INDEX: "Index",
  TRIGGER: "Trigger",
  VIEW: "View",
  "MATERIALIZED VIEW": "View",
  SEQUENCE: "Sequence",
  ENUM: "Type",
  DOMAIN: "Type",
  "COMPOSITE TYPE": "Type",
  "RANGE TYPE": "Type",
  FUNCTION: "Function",
  PROCEDURE: "Function",
  POLICY: "Row security",
  "ROW SECURITY": "Row security",
  PARTITIONING: "Partitioning",
  COLLATION: "Collation",
  EXTENSION: "Extension",
  PRIVILEGES: "Privileges",
};

/**
 * Matrix row labels back to export categories.
 *
 * summaryRows names its rows for a reader ("Enums & types", "Functions"); the
 * export files rows under a single-word category. Only the rows that can be
 * "not compared" need an entry — Tables, Columns and Constraints are always
 * compared, so they are absent on purpose.
 */
const SUMMARY_LABEL_CATEGORY: Record<string, ChangeCategory | undefined> = {
  Indexes: "Index",
  Triggers: "Trigger",
  Views: "View",
  Sequences: "Sequence",
  "Enums & types": "Type",
  Collations: "Collation",
  Extensions: "Extension",
  Functions: "Function",
  "Row security": "Row security",
  Partitioning: "Partitioning",
  Privileges: "Privileges",
};

/** The verdict for an object diff, in the export's vocabulary. */
function objectVerdict(diff: ObjectDiff): ChangeVerdict {
  if (diff.status === "onlyA") return "added";
  if (diff.status === "onlyB") return "dropped";
  return "changed";
}

/** A column in one line: enough to tell two similar columns apart. */
function describeColumn(column: ColumnSnapshot): string {
  const parts = [column.typeDisplay];
  if (!column.nullable) parts.push("NOT NULL");
  if (column.columnDefault !== null) parts.push(`default ${column.columnDefault}`);
  if (column.isPrimaryKey) parts.push("primary key");
  return parts.join(" · ");
}

export function buildDiffDocument(
  report: CompareReport,
  data?: DataCompareReport | null
): DiffDocument {
  const changes: ChangeRow[] = [];

  // ── Tables that exist on one side only ───────────────────────────────────
  for (const table of report.tablesOnlyInA) {
    changes.push({
      category: "Table",
      table: table.name,
      object: table.name,
      change: "added",
      severity: "safe",
      detail: `created with ${table.columns.length} column${
        table.columns.length === 1 ? "" : "s"
      }`,
      manual: false,
    });
  }
  for (const table of report.tablesOnlyInB) {
    changes.push({
      category: "Table",
      table: table.name,
      object: table.name,
      change: "dropped",
      // DROP TABLE ... CASCADE takes the rows and every dependent object with
      // it, and the snapshot has no record of the dependents to restore.
      severity: "breaking",
      detail: `dropped with ${table.columns.length} column${
        table.columns.length === 1 ? "" : "s"
      } — CASCADE also removes anything depending on it`,
      manual: false,
    });
  }

  // ── Matched tables ───────────────────────────────────────────────────────
  for (const match of report.matchedTables) {
    if (!match.hasChanges) continue;
    const tableName = match.left.name;

    // An accepted rename is a change to the table itself, listed before the
    // changes inside it so the reader knows which name the rest of the rows
    // are talking about.
    if (!match.exact) {
      changes.push({
        category: "Table",
        table: tableName,
        object: tableName,
        change: "renamed",
        severity: "breaking",
        detail: `renamed from "${match.right.name}" (match score ${match.score})`,
        manual: false,
      });
    }

    for (const column of match.columnsOnlyInA) {
      changes.push({
        category: "Column",
        table: tableName,
        object: column.name,
        change: "added",
        severity: addedColumnSeverity(column),
        detail: describeColumn(column),
        manual: false,
      });
    }
    for (const column of match.columnsOnlyInB) {
      changes.push({
        category: "Column",
        table: tableName,
        object: column.name,
        change: "dropped",
        severity: droppedColumnSeverity(),
        detail: `${describeColumn(column)} — removes the column and its data`,
        manual: false,
      });
    }
    for (const column of match.columnMatches) {
      if (column.exact && column.changes.length === 0) continue;
      const notes = column.changes.map((change) => change.message);
      if (!column.exact) notes.unshift(`renamed from "${column.right.name}"`);
      changes.push({
        category: "Column",
        table: tableName,
        object: column.left.name,
        change: column.exact ? "changed" : "renamed",
        severity: columnMatchSeverity(column),
        detail: notes.join("; "),
        manual: false,
      });
    }

    // Pairings the matcher offered for two columns and did not accept. Both
    // columns are still listed above, one as added and one as dropped, which is
    // what the migration does. This is the line that says they might be the
    // same column under a new name - on screen it is the "Possible renamed
    // columns" group, and an export without it hands the reader the two halves
    // and not the suggestion that ties them together.
    for (const candidate of match.possibleColumnMatches) {
      changes.push({
        category: "Column",
        table: tableName,
        object: candidate.leftName,
        change: "rename-suggested",
        severity: "info",
        detail: `may be "${candidate.rightName}" renamed (score ${candidate.score}) — not applied`,
        manual: false,
      });
    }

    for (const diff of match.constraintDiffs) {
      changes.push({
        category: "Constraint",
        table: tableName,
        object: diff.leftName ?? diff.rightName ?? diff.kind,
        change:
          diff.status === "onlyA"
            ? "added"
            : diff.status === "onlyB"
              ? "dropped"
              : "changed",
        severity: constraintDiffSeverity(diff),
        detail: `${diff.kind} — ${diff.summary}`,
        manual: false,
      });
    }

    // Indexes, triggers and row security hang off the table, so they carry
    // its name.
    for (const diff of match.objectDiffs) {
      changes.push({
        category: OBJECT_CATEGORY[diff.kind],
        table: diff.table ?? tableName,
        object: diff.name,
        change: objectVerdict(diff),
        severity: objectDiffSeverity(diff),
        detail: diff.summary,
        manual: diff.needsManualWork === true,
      });
    }
  }

  // ── Objects that hang off the schema, not off a table ────────────────────
  for (const diff of report.objectDiffs) {
    changes.push({
      category: OBJECT_CATEGORY[diff.kind],
      table: diff.table ?? "",
      object: diff.name,
      change: objectVerdict(diff),
      severity: objectDiffSeverity(diff),
      detail: diff.summary,
      manual: diff.needsManualWork === true,
    });
  }

  // ── Rename pairings the matcher offered but did not apply ────────────────
  // The column-level suggestions are written inside the matched table above,
  // so they sit with the table they belong to. These are table renames.
  for (const candidate of report.possibleTableMatches) {
    changes.push({
      category: "Table",
      table: candidate.leftName,
      object: candidate.leftName,
      change: "rename-suggested",
      severity: "info",
      detail: `may be "${candidate.rightName}" renamed (score ${candidate.score}) — not applied`,
      manual: false,
    });
  }

  const categories = summaryRows(report);
  const notCompared = categories
    .filter((row) => !row.compared)
    .map((row) => ({
      category: SUMMARY_LABEL_CATEGORY[row.label],
      // A report restored from before the reason existed records none, and the
      // old wording is the one it was written under.
      reason: row.notComparedReason ?? ("snapshotPredatesCategory" as const),
    }))
    .filter(
      (entry): entry is { category: ChangeCategory; reason: NotComparedReason } =>
        entry.category !== undefined
    );

  const count = (verdict: ChangeVerdict) =>
    changes.filter((row) => row.change === verdict).length;

  return {
    format: "schema-studio-diff",
    version: 1,
    source: { database: report.left.database, schema: report.left.schema },
    target: { database: report.right.database, schema: report.right.schema },
    totals: {
      changes: changes.length,
      added: count("added"),
      dropped: count("dropped"),
      changed: count("changed"),
      renamed: count("renamed"),
      renameSuggestions: count("rename-suggested"),
      breaking: changes.filter((row) => row.severity === "breaking").length,
      manual: changes.filter((row) => row.manual).length,
    },
    notCompared,
    categories,
    changes,
    // Totals come from compare-data's own summariser for the same reason the
    // severities come from compare.ts's graders: the export must not hold a
    // second opinion about the screen it was exported from.
    data: data
      ? {
          timeoutMs: data.timeoutMs,
          error: data.error,
          totals: summarizeDataCompare(data),
          tables: data.tables,
        }
      : null,
  };
}
