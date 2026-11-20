// generateMigration(): the entry point. Calls the other parts and lays their
// statements out in the order the script runs.

import type { CompareReport, TableMatch } from "../../compare/types";
import { ownedSequenceRenamePairs, ownedSequenceRenameStatement, possibleTableRenameNote } from "./alter-helpers";
import { alterStatementsForMatch } from "./alter-table";
import { q } from "./basics";
import { retypesBehindKeptComputedColumns } from "./column-changes";
import { sequencePlanFor, usesSerialShorthand } from "./columns";
import { inboundForeignKeysByTable } from "./inbound-keys";
import { dropIndexesFirst } from "./indexes";
import { freeReusedNames } from "./name-clashes";
import { objectPhases } from "./object-phases";
import { findPrivilege } from "./object-phase-types";
import { holdBackDropsStillInUse } from "./safe-mode";
import { columnSequenceStatements } from "./sequences";
import { onlyIfMissing, tableConstraintQuery } from "./statement-helpers";
import { buildCreateTable, buildFkDef, describeNewTable, orderTablesForCreate } from "./tables";
import type { MigrationOptions, MigrationScript, SqlStatement } from "./types";
import { viewsCascadedBy } from "./views";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate a migration script that brings B (right/target) in sync with A (left/source).
 * The returned statements are ordered so they can be run top-to-bottom without
 * manual reordering:
 *
 *    1. Move old keys, indexes and sequences off names the script needs
 *    2. Types and standalone sequences — a column may use one
 *    3. Drop views — they read the tables everything below is about to change
 *    4. Rename tables in B to match A's names
 *    5. CREATE TABLE for tables only in A (its FK constraints are queued)
 *    6. Functions and procedures — a trigger or a CHECK may call one
 *    7. ALTER matched tables (renames → adds → type/null → constraints → DROP COLUMN)
 *    8. Drop tables that are only in B
 *    9. Indexes, now that every column exists
 *   10. FK constraints, now that every table and column exists
 *   11. Triggers
 *   12. Create views, last of the additive work: every table they read is final
 *   13. Drop the routines, types and sequences nothing uses any more
 *
 * The steps are named rather than numbered in the code below, so that inserting
 * one does not silently make every cross-reference wrong.
 *
 * Views are dropped near the top and rebuilt near the bottom on purpose. A view
 * pins the columns it reads: ALTER TABLE cannot change a column's type while a
 * view selects it, and rebuilding a view before the tables are final just
 * rebuilds it against the old shape. Dropping tables BEFORE the views are
 * rebuilt matters for the same reason — a DROP TABLE ... CASCADE would
 * otherwise take a freshly recreated view straight back out again.
 *
 * This is a COMPLETE sync: it always GENERATES the destructive statements
 * (DROP TABLE / DROP COLUMN) needed to fully match A, so the report can show
 * the user exactly what a full sync would remove. Whether those statements are
 * ARMED in the rendered SQL is a separate decision:
 *
 *   allowDataLoss: false  (default)  destructive statements are rendered
 *                                    commented out — running the script cannot
 *                                    drop a table or a column
 *   allowDataLoss: true              they are rendered live
 *
 * Nothing is silently skipped in either mode: renderMigrationScript states how
 * many statements were held back and how to arm them.
 */
export function generateMigration(
  report: CompareReport,
  options: MigrationOptions = {},
): MigrationScript {
  const allowDataLoss = options.allowDataLoss === true;
  const sourceSchema = report.left.schema;
  const statements: SqlStatement[] = [];
  const warnings: string[] = [];
  // Which columns may be written as `serial`, and which identity sequences keep
  // a name of their own. Built once for the whole source schema: who else reads
  // a sequence, and whether it belongs to anybody, is not something one column
  // can answer. See sequencePlanFor.
  const plan = sequencePlanFor(report.left);
  // Names the script is about to use that the target still gives to something
  // else. Worked out before anything is written, as it can take an identity
  // sequence's name back out of the plan, and has some grants written in full.
  const clashes = freeReusedNames(report, allowDataLoss, plan);
  const objects = objectPhases(
    report,
    options.appliesToSchema ?? report.right.schema,
    clashes.parkedSequences,
    clashes.parkedDrops,
    clashes.adoptedSequences
  );
  const rightViews = report.right.views ?? [];

  // ── Extensions ────────────────────────────────────────────────────────────
  // Ahead of everything. An extension brings its own types, operators,
  // functions and sometimes collations, none of which the snapshot records on
  // their own — so a column, a domain or an index that names one of them has
  // nothing to name until the extension is installed.
  statements.push(...objects.extensions);

  // ── Collations ────────────────────────────────────────────────────────────
  // Ahead of the types below as well as the tables: a domain can be declared
  // COLLATE "x" exactly the way a column can.
  statements.push(...objects.collations);

  // ── Free names the script is about to use ──
  // An old key, index or sequence that still has a name something new needs
  // moves out of the way first. Before everything else, and before the table
  // renames, so these name tables the way the target does. See name-clashes.ts.
  statements.push(...clashes.statements);

  // ── Types and standalone sequences ────────────────────────────────────────
  // A CREATE TABLE below can name an enum or a domain, and a column
  // default can call nextval on a standalone sequence, so both have to exist
  // before any table is built.
  //
  // A new standalone sequence whose name a serial or identity column's own
  // sequence still has waits until that one is renamed (below), or CREATE
  // SEQUENCE IF NOT EXISTS would see the old one and skip.
  const ownedRenames = ownedSequenceRenamePairs(report, clashes.freedNames);
  const namesOwnedRenamesFree = new Set(ownedRenames.map((pair) => pair.from));
  const waitsForOwnedRename = (statement: SqlStatement) =>
    statement.kind === "CREATE_SEQUENCE" && namesOwnedRenamesFree.has(statement.tableName);
  statements.push(...objects.beforeTables.filter((statement) => !waitsForOwnedRename(statement)));

  // ── Functions a new table cannot be built without ─────────────────────────
  // After the types above, because a function's arguments or return type can
  // name one. Before the tables below, because a new table's DEFAULT or CHECK
  // may call one and PostgreSQL resolves both at CREATE TABLE time. Only the
  // functions actually named end up here — see ObjectPhases.hoistedRoutines.
  statements.push(...objects.hoistedRoutines);

  // ── Drop views ────────────────────────────────────────────────────────────
  // First, not last. A view holds its source columns in place: ALTER TABLE
  // refuses to change the type of a column a view selects, and a view that has
  // to be rebuilt has to be gone before the rebuild. Anything the source still
  // has is recreated further down, once the tables are final.
  statements.push(...objects.viewDrops);

  // Which foreign keys elsewhere in the target hold each table's keys in place.
  // Built once, up here, because a table's own diff cannot see them.
  const inboundFks = inboundForeignKeysByTable(report, report.right.schema);

  // ── Rename tables ─────────────────────────────────────────────────────────
  // Similarity-matched tables have different names in A and B.
  // We rename B's table to A's name so subsequent ALTER TABLE statements work.
  // IF EXISTS so a second run, when the old name is already gone, skips it.
  for (const match of report.matchedTables) {
    if (!match.exact) {
      statements.push({
        sql: `ALTER TABLE IF EXISTS ${q(match.right.name)} RENAME TO ${q(match.left.name)};`,
        description: `Rename table "${match.right.name}" → "${match.left.name}" (${match.score}% similarity — verify this is a rename and not two unrelated tables)`,
        kind: "RENAME_TABLE",
        severity: "breaking",
        tableName: match.right.name,
        destructive: false,
      });
    }
  }

  // ── Rename owned sequences ────────────────────────────────────────────────
  // Straight after the table renames, so everything below (the sequence
  // settings in the alters, the owner and grant statements at the end) can use
  // the source's name for a serial or identity column's sequence.
  statements.push(...ownedRenames.map(ownedSequenceRenameStatement));
  statements.push(...objects.beforeTables.filter(waitsForOwnedRename));

  // ── Drop indexes whose name a new key takes ───────────────────────────────
  // Before the tables are created or altered: see keyNamesTheScriptAdds.
  statements.push(...objects.indexDropsFirst);

  // ── CREATE TABLE for tables only in A ─────────────────────────────────────
  // FK constraints are queued separately (fkStatements) and appended later
  // so the ordering of CREATE TABLE statements doesn't matter.
  const fkStatements: SqlStatement[] = [];

  for (const table of orderTablesForCreate(report.tablesOnlyInA)) {
    // A serial column whose sequence was tuned needs that sequence built before
    // the table's DEFAULT nextval(...) can name it, and tied to the column
    // afterwards — see columnSequenceStatements.
    const tunedSerials = table.columns.map((col) =>
      columnSequenceStatements(col, table.name, usesSerialShorthand(plan, table.name, col.name))
    );
    const renameNote = possibleTableRenameNote(report, table.name);
    if (renameNote) statements.push(renameNote);
    for (const pair of tunedSerials) statements.push(...pair.before);

    statements.push({
      sql: buildCreateTable(table, plan),
      description: `Create ${describeNewTable(table)}`,
      kind: "CREATE_TABLE",
      severity: "info",
      tableName: table.name,
      destructive: false,
    });

    for (const pair of tunedSerials) statements.push(...pair.after);

    for (const fk of table.foreignKeys) {
      fkStatements.push({
        sql: onlyIfMissing(
          tableConstraintQuery(table.name, fk.name),
          `ALTER TABLE ${q(table.name)} ADD CONSTRAINT ${q(fk.name)} ${buildFkDef(fk, sourceSchema)};`
        ),
        description: `Add FK "${fk.name}" to "${table.name}"`,
        kind: "ADD_CONSTRAINT",
        severity: "info",
        tableName: table.name,
        destructive: false,
      });
    }
  }

  // ── Functions and procedures ──────────────────────────────────────────────
  // Before the alters below, because a CHECK constraint or a column default
  // added there may call one. They come after CREATE TABLE so a function whose body
  // reads a new table finds it.
  statements.push(...objects.routines);

  // ── Triggers and policies in the way of the alters ────────────────────────
  // Dropped here, after the table renames (they name the table the way the
  // source does) and before the first ALTER COLUMN ... TYPE. Each one the source
  // keeps is created again in the trigger and policy phases below.
  statements.push(...objects.beforeAlters);

  // ── Alter matched tables ──────────────────────────────────────────────────
  // Each match yields immediate ALTERs plus any new-FK ADDs, which are deferred
  // into the FK bucket so they run after every table's columns exist.
  // Counted for the safe-mode warnings at the end of this function.
  let retypesHeldForComputed = 0;
  for (const fullMatch of report.matchedTables) {
    const match = withoutInheritedColumnChanges(fullMatch, report.matchedTables);
    // A required column with nothing to fill it. The script adds it nullable
    // and sets NOT NULL only if the table is empty, so on a table with rows the
    // column stays nullable and the next comparison shows it again. Said here,
    // so the person reads it BEFORE deploying instead of finding a difference
    // left over afterwards.
    const leftNullable = match.columnsOnlyInA
      .filter((col) => !col.nullable && col.columnDefault === null && !col.generated && !col.identity)
      .map((col) => `"${col.name}"`);
    if (leftNullable.length > 0) {
      const many = leftNullable.length > 1;
      warnings.push(
        `Table "${match.right.name}": new column${many ? "s" : ""} ${leftNullable.join(", ")} ` +
          `${many ? "are" : "is"} NOT NULL in the source and ${many ? "have" : "has"} no default. ` +
          `If the table has rows, the script adds ${many ? "them" : "it"} but leaves ` +
          `${many ? "them" : "it"} nullable, because there is no value for the existing rows. ` +
          `Fill the column, then run ALTER TABLE ... SET NOT NULL yourself, or give the column ` +
          `a default in the source first.`,
      );
    }
    const { stmts, fkStmts } = alterStatementsForMatch(
      match,
      sourceSchema,
      report.left.sequences,
      report.right.views,
      inboundFks.get(match.right.name) ?? [],
      plan,
      clashes.parkedKeys.get(match.left.name),
      findPrivilege(report.right.privileges, `table ${match.right.name}`)?.owner,
    );
    // Safe mode comments a materialized view's drop out, and the retype it was
    // dropped for has to be held back with it — see ObjectPhases.retypeBlockedBy.
    // Marked rather than skipped, so the reader still sees the statement and the
    // "N held back" count still includes it.
    // A type change that a computed column safe mode leaves in place would stop
    // arrives already marked: see retypesBehindKeptComputedColumns. Said here,
    // by column, because the count at the end cannot say which or why.
    if (!allowDataLoss) {
      for (const [column, computed] of retypesBehindKeptComputedColumns(match)) {
        retypesHeldForComputed++;
        warnings.push(
          `The type change of "${column}" in "${match.left.name}" is held back: the computed ` +
            `column${computed.length === 1 ? "" : "s"} ${computed.map((c) => `"${c}"`).join(", ")} ` +
            `${computed.length === 1 ? "reads" : "read"} it, safe mode leaves ` +
            `${computed.length === 1 ? "that column" : "those columns"} in place, and PostgreSQL ` +
            `refuses to change the type of a column that a computed column uses. Enable ` +
            `"allow data loss" to run it.`,
        );
      }
    }
    const blockers = objects.retypeBlockedBy.get(match.left.name);
    if (blockers && blockers.length > 0 && !allowDataLoss) {
      for (const stmt of stmts) {
        if (stmt.kind === "ALTER_COLUMN_TYPE") stmt.needsArmedDrop = true;
      }
      warnings.push(
        `The column type change${stmts.filter((s) => s.kind === "ALTER_COLUMN_TYPE").length === 1 ? "" : "s"} ` +
          `on "${match.left.name}" ${blockers.length === 1 ? "needs" : "need"} ` +
          `${blockers.join(", ")} out of the way, and dropping a materialized view ` +
          `throws its rows away, so both are held back. Enable "allow data loss" to ` +
          `run them.`,
      );
    }
    statements.push(...stmts);
    fkStatements.push(...fkStmts);
  }

  // ── Drop tables that exist in B but not in A ──────────────────────────────
  // Destructive: removes the table and all its data. After the alter work, so
  // nothing above trips over a missing table — and BEFORE the views are
  // rebuilt, because CASCADE here would otherwise take a view that was just
  // recreated straight back out again.
  for (const table of report.tablesOnlyInB) {
    // Name the dependents CASCADE is about to take. Without this the script
    // reads as if it removes one table, while silently removing every view
    // built on it — and a report that never mentioned them cannot restore them.
    const alsoDropped = viewsCascadedBy(rightViews, new Set([table.name])).map((v) => v.name);
    const cascadeNote =
      alsoDropped.length > 0
        ? `; CASCADE also drops ${alsoDropped.join(", ")}`
        : "";
    statements.push({
      sql: `DROP TABLE IF EXISTS ${q(table.name)} CASCADE;`,
      description: `Drop table "${table.name}" — WARNING: removes the table and all its data${cascadeNote}`,
      kind: "DROP_TABLE",
      severity: "breaking",
      tableName: table.name,
      destructive: true,
    });
  }

  // ── Indexes ───────────────────────────────────────────────────────────────
  // After every ADD COLUMN, so an index over a new column has something to
  // index. Plain CREATE INDEX, never CONCURRENTLY — see the note at the top of
  // statement-helpers.ts: the apply route runs this inside one transaction. Drops go
  // ahead of creates so a name that moved between tables is freed first.
  statements.push(...dropIndexesFirst(objects.indexes));

  // ── FK constraints (new tables + matched tables) ──────────────────────────
  // All tables exist and all columns have been added, so every FK is safe now.
  statements.push(...fkStatements);

  // ── Triggers ──────────────────────────────────────────────────────────────
  // Triggers need both their function and the columns they read.
  statements.push(...objects.triggers);

  // ── Row security ──────────────────────────────────────────────────────────
  // After the triggers, because a policy can call a function the same way a
  // trigger does, and after every column, because a policy expression reads
  // them. Nothing later in the script depends on a policy existing.
  statements.push(...objects.policies);

  // ── Create views ──────────────────────────────────────────────────────────
  // Last of the additive work. Every table a view reads is now in its final
  // shape, and every table that was going to be dropped is already gone, so
  // nothing here can be cascaded away by a later statement.
  statements.push(...objects.views);

  // ── Indexes and triggers on those views ───────────────────────────────────
  // Immediately after, and not with the table-scoped ones far above: a
  // materialized view's indexes and a view's INSTEAD OF triggers need the view
  // itself to exist, and it has only just been made. Index drops (only ever on
  // views this script does not rebuild) go first, for the moved-name reason
  // above; the drops on rebuilt views were handled by dropping the view itself.
  statements.push(...dropIndexesFirst(objects.afterViews));

  // ── Ownership and grants ──────────────────────────────────────────────────
  // Everything the script builds now exists, so there is something to grant on
  // — and nothing has been dropped yet, so nothing is granted on a name that
  // has already gone.
  statements.push(...objects.privileges);

  // ── Routines that are no longer used ──────────────────────────────────────
  // Before the types below: a function whose argument or return type is an enum
  // holds that enum in place, and DROP TYPE deliberately carries no CASCADE.
  statements.push(...objects.routineDrops);

  // ── Types and sequences that are no longer used ───────────────────────────
  // Last of all: a type cannot be dropped while a column still has it, and that
  // column only went away with the table drops above.
  statements.push(...objects.afterTables);

  // ── Collations that are no longer used ────────────────────────────────────
  // After the type drops, not with them: a domain can carry a collation, so
  // the collation outlives the domain by exactly one statement.
  statements.push(...objects.collationDrops);

  // ── Extensions that are no longer used ────────────────────────────────────
  // The very last thing. DROP EXTENSION carries no CASCADE and an extension
  // holds everything it installed — a column on one of its types, an index on
  // one of its operator classes, a collation it shipped. The drops above are
  // what clear the way.
  statements.push(...objects.extensionDrops);

  warnings.push(...clashes.warnings, ...objects.warnings);

  // Roles are cluster-wide, and the snapshot records one schema. So the script
  // can name a role the target server has never heard of, and GRANT or OWNER
  // TO fails on a role that does not exist rather than creating one. Said once
  // here, because saying it on every statement would bury the statements
  // themselves.
  //
  // Only the roles the source names count. A REVOKE takes a privilege off a
  // role the target's own snapshot listed, so that role is there. It used to
  // be listed anyway, and an owner change was listed as a grant: a script that
  // only moved an owner said "This script grants to".
  const grantedTo = new Set<string>();
  const ownedBy = new Set<string>();
  for (const statement of objects.privileges) {
    const into =
      statement.kind === "GRANT" ? grantedTo : statement.kind === "ALTER_OWNER" ? ownedBy : null;
    // PUBLIC is a keyword meaning everybody, not a role anyone has to create.
    if (!into || statement.role === undefined || statement.role.toUpperCase() === "PUBLIC") continue;
    into.add(statement.role);
  }
  const roleList = (roles: Set<string>) =>
    [...roles].sort().map((r) => `"${r}"`).join(", ");
  const roleActions = [
    grantedTo.size > 0 ? `grants to ${roleList(grantedTo)}` : "",
    ownedBy.size > 0 ? `sets the owner to ${roleList(ownedBy)}` : "",
  ].filter(Boolean);
  if (roleActions.length > 0) {
    warnings.push(
      `This script ${roleActions.join(" and ")}. Roles belong to the whole ` +
        "server, not to a schema, so a snapshot cannot tell whether the target " +
        "has them. CREATE ROLE any that are missing before running it, or the " +
        "statements that name them fail.",
    );
  }
  // Only when there is an OWNER TO to point at. A script that only grants or
  // revokes on objects already there changes no owner.
  if (objects.privileges.some((statement) => statement.kind === "ALTER_OWNER")) {
    warnings.push(
      "Everything this script creates is owned by whoever runs it until the " +
        "ALTER ... OWNER TO statements near the end move it. A login that may " +
        "not give an object to another role (a superuser may, and so may a " +
        "member of that role) skips that owner change with a warning, the rest " +
        "of the script still runs, and the next comparison shows the owner as " +
        "a difference.",
    );
  }

  // ── Safe mode: drops that something held back still needs ─────────────────
  // Only the drops of objects the target alone has. The drop half of a function
  // that is dropped and recreated is not in these lists, and must not be: its
  // CREATE would then run without it.
  const dropsStillInUse = allowDataLoss
    ? 0
    : holdBackDropsStillInUse(report, statements, [
        ...objects.routineDrops,
        ...objects.afterTables,
        ...objects.collationDrops,
      ]);

  const destructiveCount = statements.filter((s) => s.destructive).length;
  const heldBackCount = statements.filter(
    (s) => s.destructive || s.needsArmedDrop === true,
  ).length;
  if (destructiveCount > 0 && !allowDataLoss) {
    warnings.push(
      `${destructiveCount} destructive statement${destructiveCount === 1 ? " is" : "s are"} ` +
        `commented out. Enable "allow data loss" to include ${destructiveCount === 1 ? "it" : "them"}.`,
    );
  }
  if (dropsStillInUse > 0) {
    warnings.push(
      `${dropsStillInUse} drop${dropsStillInUse === 1 ? "" : "s"} of a type, sequence, ` +
        `function or collation ${dropsStillInUse === 1 ? "is" : "are"} also commented out: ` +
        `a table or column that safe mode leaves in place still uses ` +
        `${dropsStillInUse === 1 ? "it" : "them"}, and PostgreSQL refuses to drop ` +
        `something that is in use. Enable "allow data loss" to run ` +
        `${dropsStillInUse === 1 ? "it" : "them"}.`,
    );
  }
  // A rebuild that is inert without its drop is held back too, and silently
  // skipping it is what let a safe-mode run report success over a materialized
  // view that still had the old definition and the old rows.
  const inertCount =
    heldBackCount - destructiveCount - dropsStillInUse - retypesHeldForComputed;
  if (inertCount > 0 && !allowDataLoss) {
    warnings.push(
      `${inertCount} view rebuild${inertCount === 1 ? " is" : "s are"} also commented ` +
        `out: a rebuild cannot run while the materialized view it replaces is still ` +
        `there, so ${inertCount === 1 ? "that view keeps" : "those views keep"} the ` +
        `target's definition and rows until data loss is enabled.`,
    );
  }

  return {
    statements,
    warnings,
    sourceSchema: `${report.left.database}.${report.left.schema}`,
    targetSchema: `${report.right.database}.${report.right.schema}`,
    allowDataLoss,
    destructiveCount,
    heldBackCount,
  };
}

/**
 * The match for a partition (or an INHERITS child) without the column adds and
 * drops its parent already makes.
 *
 * A partition gets every column from its parent. When the parent gains a
 * column the partition gains it in the same statement, and PostgreSQL refuses
 * the second one outright ("cannot add column to a partition"), which stopped
 * the whole script. A dropped column is the same story the other way round
 * ("cannot drop inherited column"). So when the parent is in this comparison
 * and makes the same change, the child's own statement is left out.
 */
function withoutInheritedColumnChanges(match: TableMatch, all: TableMatch[]): TableMatch {
  const parentsOf = (table: TableMatch["left"]) => [
    ...(table.partitioning?.partitionOf ? [table.partitioning.partitionOf] : []),
    ...(table.partitioning?.inherits ?? []),
  ];
  const sourceParents = parentsOf(match.left);
  const targetParents = parentsOf(match.right);
  if (sourceParents.length === 0 && targetParents.length === 0) return match;

  // Columns a parent gains, by the parent's name in the source.
  const addedByParent = new Set<string>();
  // Columns a parent loses, by the parent's name in the target.
  const droppedByParent = new Set<string>();
  for (const other of all) {
    if (sourceParents.includes(other.left.name) && targetParents.includes(other.right.name)) {
      for (const col of other.columnsOnlyInA) addedByParent.add(col.name);
      for (const col of other.columnsOnlyInB) droppedByParent.add(col.name);
    }
  }
  if (addedByParent.size === 0 && droppedByParent.size === 0) return match;
  return {
    ...match,
    columnsOnlyInA: match.columnsOnlyInA.filter((col) => !addedByParent.has(col.name)),
    columnsOnlyInB: match.columnsOnlyInB.filter((col) => !droppedByParent.has(col.name)),
  };
}
