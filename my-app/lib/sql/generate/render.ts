// Turning a migration script into text: commenting out held-back statements,
// counting manual notes, grading the script, and renderMigrationScript().

import { changeTypeHeaderLine } from "../../versions/change-type";
import type { ChangeLevel } from "../../versions/detection";
import { oneLine } from "./statement-helpers";
import type { MigrationScript, SqlStatement } from "./types";

// Prefix every line of a statement with "-- " so it is inert when executed.
// PostgreSQL also ends a comment at a lone \r, so that counts as a new line too.
function commentOut(sql: string): string {
  return sql
    .split(/\r\n|\r|\n/)
    .map((line) => `-- ${line}`)
    .join("\n");
}

// Render the migration script as a plain SQL text string with inline comments.
// Each statement is preceded by a comment showing its severity and description.
//
/**
 * How many of these "statements" are notes rather than SQL.
 *
 * A MANUAL statement is a comment describing work no statement can do — a
 * collation that has to be dropped and rebuilt with its columns moved off it,
 * a range type whose canonical function needs a shell type first. It is in the
 * list because the reader has to see it, and it is graded like anything else,
 * so "8 statements" counted it as work the script performs. It performs none.
 *
 * Exported so the two rendered headers and the count under the editor all
 * arrive at the same number from the same rule.
 */
export function manualNoteCount(statements: SqlStatement[]): number {
  return statements.filter((s) => s.kind === "MANUAL").length;
}

// When script.allowDataLoss is false, statements flagged destructive are
// rendered commented out. This is the single point where a generated script
// becomes able to destroy data, so the decision is made here and nowhere else.
/**
 * How severe this migration is, decided from the statements the generator
 * wrote rather than from the text it renders.
 *
 * Only statements that will RUN count. Safe mode comments its destructive
 * statements out, so a migration whose only breaking change is a held-back DROP
 * does not actually break anything when applied, and grading it "breaking"
 * would force a major version bump for a script that just adds a column.
 *
 * A MANUAL note runs nothing either — it is a description of work no statement
 * can do — so it cannot raise the level on its own.
 */
export function migrationChangeLevel(script: MigrationScript): ChangeLevel {
  const willRun = statementsThatRun(script);

  if (willRun.length === 0) return "patch";
  if (willRun.some((stmt) => stmt.severity === "breaking")) return "breaking";
  if (willRun.some((stmt) => stmt.kind.startsWith("CREATE_") || stmt.kind.startsWith("ADD_"))) {
    return "additive";
  }
  return "patch";
}

/**
 * The statements that will actually run when this script is applied. Safe mode
 * comments out the destructive statements (and the ones that do nothing without
 * them), and a MANUAL note describes work instead of doing it. The change level,
 * the header's tally and the Compare page's tally all count this one list, so
 * the three cannot disagree.
 */
export function statementsThatRun(script: MigrationScript): SqlStatement[] {
  return script.statements.filter((stmt) => {
    if (stmt.kind === "MANUAL") return false;
    const muted = (stmt.destructive || stmt.needsArmedDrop === true) && !script.allowDataLoss;
    return !muted;
  });
}

export function renderMigrationScript(script: MigrationScript): string {
  // The tally grades what runs, like the Compare page's: a held-back DROP is
  // in the file but will not break anything, so "3 breaking" in the header
  // beside "1 breaking" on the page read as two different scripts.
  const willRun = statementsThatRun(script);
  const breaking = willRun.filter((s) => s.severity === "breaking").length;
  const safe = willRun.filter((s) => s.severity === "safe").length;
  const info = willRun.filter((s) => s.severity === "info").length;
  const runsLabel =
    willRun.length === script.statements.length ? "" : `${willRun.length} run: `;
  const held = script.allowDataLoss ? 0 : script.heldBackCount;
  // The held-back set is not all destructive: a rebuilt matview is in there
  // because it does nothing until its drop runs, not because it deletes.
  const heldDestructive = script.allowDataLoss ? 0 : script.destructiveCount;

  const header = [
    `-- ================================================================`,
    `-- Migration: ${oneLine(script.sourceSchema)}  →  ${oneLine(script.targetSchema)}`,
    `-- Direction: modifies the RIGHT/TARGET schema to match the LEFT/SOURCE schema`,
    `-- Statements: ${script.statements.length}  (${runsLabel}${breaking} breaking · ${safe} safe · ${info} info)`,
    // Machine-readable, and the only accurate grading of this script that
    // exists: everything downstream sees the file as text and would otherwise
    // have to guess by searching it. See lib/versions/change-type.ts.
    changeTypeHeaderLine(migrationChangeLevel(script)),
  ];

  const notes = manualNoteCount(script.statements);
  if (notes > 0) {
    header.push(
      `-- ${notes} of ${notes === 1 ? "those is a MANUAL note" : "those are MANUAL notes"}: ` +
        `${notes === 1 ? "it describes" : "they describe"} work no statement can do, and ` +
        `${notes === 1 ? "runs" : "run"} nothing.`,
    );
  }

  // What a second run of this script does, and what it cannot put right. This
  // is prose for a person, so it names things in plain words. The SQL reader
  // (gradeSql in lib/versions/change-type.ts) skips comments, so nothing written here
  // can change the grade the script gets on another screen.
  header.push(
    `--`,
    `-- Safe to run again. Anything this script creates or adds is skipped when it`,
    `-- already exists, and so is a new name that is already in place. An object`,
    `-- whose definition changed is removed and built again on every run, and a`,
    `-- column type change is converted again. A skipped object is not checked`,
    `-- against the source, so compare again after running.`,
  );

  if (held > 0) {
    header.push(
      `--`,
      `-- SAFE MODE IS ON. ${held} statement${held === 1 ? "" : "s"} ` +
        `(${heldDestructive} destructive` +
        `${held > heldDestructive ? `, ${held - heldDestructive} inert without ${heldDestructive === 1 ? "it" : "them"}` : ""}) ` +
        `${held === 1 ? "is" : "are"} commented out below`,
      `-- and will NOT run. Each one is marked [NOT EXECUTED]. To apply them,`,
      `-- re-run the comparison with "allow data loss" enabled, or uncomment them`,
      `-- by hand in the script editor after checking the data is expendable.`,
    );
  } else if (script.destructiveCount > 0) {
    header.push(
      `--`,
      `-- DATA LOSS IS ARMED. ${script.destructiveCount} statement` +
        `${script.destructiveCount === 1 ? "" : "s"} below will permanently remove`,
      `-- tables or columns and every row in them. Review each one before running.`,
    );
  }

  header.push(`-- ================================================================`);
  const headerText = header.join("\n");

  if (script.statements.length === 0) {
    return `${headerText}\n\n-- No changes needed.`;
  }

  const body = script.statements
    .map((stmt) => {
      const muted = (stmt.destructive || stmt.needsArmedDrop === true) && !script.allowDataLoss;
      const tag = muted ? "NOT EXECUTED — " : "";
      return (
        `-- [${tag}${stmt.severity.toUpperCase()}] ${oneLine(stmt.description)}\n` +
        (muted ? commentOut(stmt.sql) : stmt.sql)
      );
    })
    .join("\n\n");

  return `${headerText}\n\n${body}`;
}
