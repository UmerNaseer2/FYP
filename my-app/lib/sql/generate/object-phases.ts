// objectPhases(): turns every non-table object difference (types, sequences,
// views, routines, indexes, triggers, policies, grants and so on) into the
// ordered phases generateMigration() lays out. It is one long function and is
// kept whole.

import type { CompareReport, ObjectDiff } from "../../compare/types";
import type { PrivilegeSnapshot, RoutineSnapshot, ViewSnapshot } from "../../postgres";
import { extensionUpdateIsForward } from "../../compare/diff";
import { sequenceOwnerTable } from "../../postgres/snapshot-facts";
import { findByName, normalizeType, q } from "./basics";
import { indexTouchesColumn, namesChangingColumn, rebuiltComputedColumns } from "./column-changes";
import {
  alterTypeStatements,
  createTypeStatement,
  dropTypeStatement,
  withTypesInDependencyOrder,
} from "./custom-types";
import {
  createCollationStatement,
  createExtensionStatement,
  dropCollationStatement,
  dropExtensionStatement,
} from "./extensions";
import {
  createIndexStatement,
  dropIndexMakingRoomStatement,
  dropIndexStatement,
  keyNamesTheScriptAdds,
} from "./indexes";
import type { ObjectPhases } from "./object-phase-types";
import { findPrivilege, sequencesTiedToColumns } from "./object-phase-types";
import { privilegeStatements } from "./privileges";
import {
  createRoutineStatement,
  dropRoutineStatement,
  expressionCallsRoutine,
  routinesNeededByNewTables,
  tableUsesOfRoutine,
} from "./routines";
import { alterSequenceStatement, createSequenceStatement, nextvalSequenceName } from "./sequences";
import { literal, manualNote, objectStatement } from "./statement-helpers";
import {
  createPolicyStatement,
  createTriggerStatements,
  dropPolicyStatement,
  dropTriggerForColumnChange,
  dropTriggerStatement,
  policyNamesChangingColumn,
  rowSecurityStatements,
} from "./triggers-policies";
import type { SqlStatement } from "./types";
import {
  createViewStatement,
  dropViewStatement,
  sortViewsByDependency,
  viewsCascadedBy,
} from "./views";

export function objectPhases(
  report: CompareReport,
  appliesToSchema: string,
  // Sequences the script makes again under a name it freed: see name-clashes.ts.
  parkedSequences: Set<string> = new Set(),
  // Sequences of its own the script moved aside first, by name, mapped to the
  // name their drop has to use. See name-clashes.ts.
  parkedDrops: Map<string, string> = new Map(),
  // Sequences of its own that a new column takes over, so they are kept.
  adoptedSequences: Set<string> = new Set()
): ObjectPhases {
  const tiedSequences = sequencesTiedToColumns(report);
  const phases: ObjectPhases = {
    extensions: [],
    collations: [],
    beforeTables: [],
    hoistedRoutines: [],
    routines: [],
    indexes: [],
    indexDropsFirst: [],
    triggers: [],
    policies: [],
    views: [],
    afterViews: [],
    viewDrops: [],
    beforeAlters: [],
    routineDrops: [],
    afterTables: [],
    collationDrops: [],
    extensionDrops: [],
    privileges: [],
    retypeBlockedBy: new Map(),
    warnings: [],
  };

  const leftViews = report.left.views ?? [];
  const rightViews = report.right.views ?? [];

  // Worked out once, up here: the question is about the whole set of new
  // tables, and the routine branch below sees one routine at a time.
  const hoistedSignatures = routinesNeededByNewTables(report);
  const newKeyNames = keyNamesTheScriptAdds(report);

  // ── Table-scoped objects on MATCHED tables ────────────────────────────────
  for (const match of report.matchedTables) {
    // After the rename step the table carries the source's name, so every statement
    // below must use that and not the name the diff was recorded under.
    const tableName = match.left.name;

    for (const diff of match.objectDiffs) {
      if (diff.kind === "INDEX") {
        if (diff.status !== "onlyA") {
          const target = findByName(match.right.indexes, diff.name);
          // An index whose name a new key is about to take goes first of all.
          if (target && newKeyNames.has(diff.name)) {
            phases.indexDropsFirst.push(dropIndexMakingRoomStatement(target, tableName));
          } else if (target) {
            phases.indexes.push(dropIndexStatement(target, tableName));
          }
        }
        if (diff.status !== "onlyB") {
          const source = findByName(match.left.indexes, diff.name);
          if (source) phases.indexes.push(createIndexStatement(source, tableName));
        }
      } else if (diff.kind === "TRIGGER") {
        // A trigger that names a column the alters below retype or rebuild has
        // to be gone before them, not after: see ObjectPhases.beforeAlters.
        const target = findByName(match.right.triggers, diff.name);
        const inTheWay = target !== null && namesChangingColumn(match, target.definition);
        if (diff.status === "onlyB") {
          (inTheWay ? phases.beforeAlters : phases.triggers).push(
            dropTriggerStatement(diff.name, tableName)
          );
        } else {
          if (inTheWay) phases.beforeAlters.push(dropTriggerForColumnChange(diff.name, tableName));
          const source = findByName(match.left.triggers, diff.name);
          if (source) phases.triggers.push(...createTriggerStatements(source, tableName));
        }
      } else if (diff.kind === "ROW SECURITY") {
        // The diff only ever says "these two states differ"; which switches
        // moved is read off the snapshots, which are both still here.
        if (match.left.rowSecurity && match.right.rowSecurity) {
          phases.policies.push(
            ...rowSecurityStatements(match.left.rowSecurity, match.right.rowSecurity, tableName)
          );
        }
      } else if (diff.kind === "PARTITIONING") {
        // There is no ALTER that turns a plain table into a partitioned one,
        // moves a partition to a different parent, or changes a partition key.
        // The only route is a rebuild. Saying nothing here is what let the
        // report claim the script handled a change it could not express.
        const note =
          `Table "${tableName}" is ${diff.leftDefinition ?? "unknown"} in the source and ` +
          `${diff.rightDefinition ?? "unknown"} in the target. PostgreSQL has no ALTER for ` +
          `this — build the table in its new shape, copy the rows across, then swap the names.`;
        phases.beforeTables.push(
          manualNote(note, `Partitioning of "${tableName}" needs a rebuild`, tableName)
        );
        phases.warnings.push(note);
      } else if (diff.kind === "POLICY") {
        // Dropped and recreated rather than altered: ALTER POLICY can change
        // the roles and the expressions but not the command it applies to, so
        // one rewrite would apply and another would fail on the same shape.
        if (diff.status !== "onlyA") {
          // Same as a trigger: early when it reads a column the alters change.
          const target = findByName(match.right.rowSecurity?.policies, diff.name);
          const inTheWay = target !== null && policyNamesChangingColumn(match, target);
          (inTheWay ? phases.beforeAlters : phases.policies).push(
            dropPolicyStatement(
              diff.name,
              tableName,
              diff.status === "onlyB"
                ? " — WARNING: the access rule it enforced stops applying"
                : " so it can be recreated with its new definition"
            )
          );
        }
        if (diff.status !== "onlyB") {
          const source = findByName(match.left.rowSecurity?.policies, diff.name);
          if (source) phases.policies.push(createPolicyStatement(source, tableName));
        }
      }
    }

    // ── Triggers and policies in the way of a column change ─────────────────
    // The ones that differ were handled in the loop above. One that is the same
    // on both sides is in no diff, and still stops the script: PostgreSQL will
    // not change the type of a column that a trigger (UPDATE OF, WHEN) or a
    // policy (USING, WITH CHECK) names, and a column rebuild's CASCADE removes
    // it without saying so. So it is dropped before the alters and the source's
    // copy, which is the same thing, is created again after them.
    const differingTriggers = new Set(
      match.objectDiffs.filter((diff) => diff.kind === "TRIGGER").map((diff) => diff.name)
    );
    for (const trigger of match.right.triggers ?? []) {
      if (differingTriggers.has(trigger.name)) continue;
      if (!namesChangingColumn(match, trigger.definition)) continue;
      const source = findByName(match.left.triggers, trigger.name);
      if (!source) continue;
      phases.beforeAlters.push(dropTriggerForColumnChange(trigger.name, tableName));
      phases.triggers.push(...createTriggerStatements(source, tableName));
    }
    const differingPolicies = new Set(
      match.objectDiffs.filter((diff) => diff.kind === "POLICY").map((diff) => diff.name)
    );
    for (const policy of match.right.rowSecurity?.policies ?? []) {
      if (differingPolicies.has(policy.name)) continue;
      if (!policyNamesChangingColumn(match, policy)) continue;
      const source = findByName(match.left.rowSecurity?.policies, policy.name);
      if (!source) continue;
      phases.beforeAlters.push(
        dropPolicyStatement(
          policy.name,
          tableName,
          " so a column it reads can be changed (it is created again further down)"
        )
      );
      phases.policies.push(createPolicyStatement(source, tableName));
    }

    // ── Indexes a column rebuild takes with it ──────────────────────────────
    // Rebuilding a generated column is a DROP COLUMN ... CASCADE, and CASCADE
    // removes every index over that column without naming one of them. An index
    // that is identical in both schemas is in no diff, so the loop above never
    // saw it and nothing put it back: the migration finished "clean" and left
    // the table an index short. Same reasoning as the view walk further down —
    // and it belongs here rather than beside the rebuild, because this phase is
    // emitted after every ADD COLUMN, so the column is back by then.
    const rebuiltColumns = rebuiltComputedColumns(match);
    if (rebuiltColumns.size > 0) {
      const alreadyHandled = new Set(
        match.objectDiffs.filter((diff) => diff.kind === "INDEX").map((diff) => diff.name)
      );
      for (const index of match.left.indexes ?? []) {
        if (alreadyHandled.has(index.name)) continue;
        const taken = [...rebuiltColumns].some((column) => indexTouchesColumn(index, column));
        if (taken) phases.indexes.push(createIndexStatement(index, tableName));
      }
    }
  }

  // ── Table-scoped objects on tables being CREATED ──────────────────────────
  for (const table of report.tablesOnlyInA) {
    for (const index of table.indexes ?? []) {
      phases.indexes.push(createIndexStatement(index, table.name));
    }
    for (const trigger of table.triggers ?? []) {
      phases.triggers.push(...createTriggerStatements(trigger, table.name));
    }
    // A brand-new table is created with row security OFF whatever the source
    // says, so the switch has to be written out explicitly. Skipping it is how
    // a table that is locked down in the source arrives world-readable in the
    // target — the exact failure this whole slice exists to stop.
    if (table.rowSecurity) {
      phases.policies.push(
        ...rowSecurityStatements(
          table.rowSecurity,
          { enabled: false, forced: false, policies: [] },
          table.name
        )
      );
      for (const policy of table.rowSecurity.policies) {
        phases.policies.push(createPolicyStatement(policy, table.name));
      }
    }
  }

  // ── Schema-scoped objects ─────────────────────────────────────────────────
  const viewsToCreate: ViewSnapshot[] = [];
  /** Views the script drops by name, so a CASCADE taking them is no surprise. */
  const viewsBeingDropped = new Set<string>();
  /**
   * ...of which these are dropped DESTRUCTIVELY, meaning safe mode comments the
   * drop out. Anything written to put those views back has to be held back with
   * them: a plain CREATE OR REPLACE VIEW over a surviving materialized view
   * fails outright ("recent is not a view"), and CREATE MATERIALIZED VIEW IF
   * NOT EXISTS finds the old one and quietly does nothing.
   */
  const heldBackViewDrops = new Set<string>();
  /**
   * INDEX and TRIGGER diffs from the schema-scoped list, which is where the ones
   * belonging to a VIEW arrive. Held aside rather than handled in the loop
   * below, because what to write for them depends on whether the view they hang
   * off is about to be rebuilt — and that is not known until the CASCADE walk
   * further down has finished. See the pass after the views are created.
   */
  const viewObjectDiffs: ObjectDiff[] = [];
  /** Ownership and grant diffs, held aside for the same reason. */
  const privilegeDiffs: ObjectDiff[] = [];

  /**
   * Functions the script drops and creates again because CREATE OR REPLACE is
   * refused (see replaceNeedsDrop below), each with its two statements and the
   * bucket they went into. The pass "Things still using a function that is
   * replaced" further down reads this.
   */
  const replacedFunctions: {
    target: RoutineSnapshot;
    drop: SqlStatement;
    create: SqlStatement;
    bucket: SqlStatement[];
    hoisted: boolean;
  }[] = [];

  /** Queue a drop and record it in both sets — the only place that does. */
  function queueViewDrop(view: ViewSnapshot, reason: string) {
    const statement = dropViewStatement(view, reason);
    phases.viewDrops.push(statement);
    viewsBeingDropped.add(view.name);
    if (statement.destructive) heldBackViewDrops.add(view.name);
  }

  for (const diff of withTypesInDependencyOrder(
    report.objectDiffs,
    report.left.types,
    report.right.types
  )) {
    if (diff.kind === "INDEX" || diff.kind === "TRIGGER") {
      // Only a view puts these in the schema-scoped list; a table's ride on its
      // own match, which the loop above has already dealt with.
      viewObjectDiffs.push(diff);
      continue;
    }

    if (diff.kind === "VIEW" || diff.kind === "MATERIALIZED VIEW") {
      const sourceView = findByName(leftViews, diff.name);
      const targetView = findByName(rightViews, diff.name);
      // A plain view whose SELECT is identical and whose WITH (...) settings
      // are not needs no drop at all: CREATE OR REPLACE replaces the option
      // list in place, and skipping the drop means its CASCADE cannot reach
      // the views built on top of it. A materialized view still has to go —
      // CREATE MATERIALIZED VIEW IF NOT EXISTS would find it there and do
      // nothing, leaving the old settings and the old rows.
      //
      // The compare engine decided that (viewReplaceNeedsDrop) and the report
      // reads the same flag, so the SQL below and the sentence printed next to
      // it on screen cannot disagree about what this migration does.
      const onlyOptionsMoved =
        diff.status === "changedDefinition" && diff.replaceNeedsDrop === false;

      if (diff.status !== "onlyA" && !onlyOptionsMoved && targetView) {
        queueViewDrop(
          targetView,
          diff.status === "onlyB" ? "" : " so it can be rebuilt from the source"
        );
      }
      if (diff.status !== "onlyB") {
        if (sourceView) viewsToCreate.push(sourceView);
      }
      continue;
    }

    if (diff.kind === "SEQUENCE") {
      if (diff.status === "onlyA") {
        const source = findByName(report.left.sequences, diff.name);
        if (source) phases.beforeTables.push(createSequenceStatement(source));
      } else if (diff.status === "onlyB") {
        // The table step ties this very sequence to a serial column, so it is
        // not going anywhere: see sequencesTiedToColumns. A new column takes
        // an adopted one over in the same way.
        if (tiedSequences.has(diff.name) || adoptedSequences.has(diff.name)) continue;
        const parked = parkedDrops.get(diff.name);
        // The source has this name as a serial or identity column's own
        // sequence, and a column here reads it on both sides. PostgreSQL
        // refuses to drop a sequence a column default still reads, so it
        // stays, and whether the two columns should share one counter is
        // left to a person.
        const sourceOwned = parked
          ? undefined
          : (report.left.sequences ?? []).find(
              (seq) => seq.name === diff.name && seq.ownedByTable !== null
            );
        const keptReaders = sourceOwned ? columnsReadingOnBothSides(report, diff.name) : [];
        if (sourceOwned && keptReaders.length > 0) {
          const owner = `"${sequenceOwnerTable(sourceOwned, report.left.schema)}"."${sourceOwned.ownedByColumn}"`;
          phases.warnings.push(
            `Sequence "${diff.name}" is kept. In the source it is the sequence behind ${owner}, ` +
              `but ${keptReaders.join(", ")} still ${keptReaders.length === 1 ? "reads" : "read"} it ` +
              `here, so it cannot be dropped. If ${owner} should share that counter, point it there by hand.`
          );
          continue;
        }
        phases.afterTables.push(
          objectStatement({
            sql: `DROP SEQUENCE IF EXISTS ${q(parked ?? diff.name)};`,
            description:
              `Drop sequence "${diff.name}"` +
              (parked ? ` (moved to "${parked}" earlier in the script)` : "") +
              ` — WARNING: anything using it for new ids stops working`,
            kind: "DROP_SEQUENCE",
            severity: "breaking",
            tableName: diff.name,
          })
        );
      } else {
        const source = findByName(report.left.sequences, diff.name);
        if (source) phases.beforeTables.push(alterSequenceStatement(source));
      }
      continue;
    }

    if (diff.kind === "EXTENSION") {
      const source = findByName(report.left.extensions, diff.name);
      const target = findByName(report.right.extensions, diff.name);
      if (diff.status === "onlyA") {
        if (source) phases.extensions.push(createExtensionStatement(source));
      } else if (diff.status === "onlyB") {
        if (target) phases.extensionDrops.push(dropExtensionStatement(target));
      } else if (source && target) {
        // ALTER EXTENSION ... UPDATE runs the little upgrade scripts the
        // extension's author shipped, and almost nobody ships the ones that go
        // back down. extensionUpdateIsForward is the single answer to whether
        // there is a path — the report reads the same one off the diff, so the
        // card and the script cannot say different things.
        if (extensionUpdateIsForward(source.version, target.version)) {
          phases.extensions.push(
            objectStatement({
              sql: `ALTER EXTENSION ${q(source.name)} UPDATE TO ${literal(source.version)};`,
              description:
                `Update extension "${source.name}" from ${target.definition} ` +
                `to ${source.definition}`,
              kind: "ALTER_EXTENSION",
              tableName: source.name,
            })
          );
        } else {
          phases.extensions.push(
            manualNote(
              `extension "${source.name}" is ${target.definition} in the target and ` +
                `${source.definition} in the source, and ALTER EXTENSION ... UPDATE ` +
                "only goes forwards. Moving back a version means dropping the " +
                "extension and installing the older one, which takes every type, " +
                "operator and function it owns with it — so everything using one " +
                "has to come off first.",
              `Extension "${source.name}" needs moving by hand`,
              source.name
            )
          );
        }
      }
      continue;
    }

    if (diff.kind === "PRIVILEGES") {
      // Held aside for the same reason the view indexes and triggers are:
      // whether the object these grants sit on is really going to be rebuilt is
      // not known until the CASCADE walk below has finished adding to
      // heldBackViewDrops. See the pass after the views are created.
      privilegeDiffs.push(diff);
      continue;
    }

    if (diff.kind === "COLLATION") {
      const source = findByName(report.left.collations, diff.name);
      const target = findByName(report.right.collations, diff.name);
      if (diff.status === "onlyA") {
        // A collation with nothing to write is one on the database default,
        // which every schema already has; there is nothing to create.
        const create = source ? createCollationStatement(source) : null;
        if (create) phases.collations.push(create);
      } else if (diff.status === "onlyB") {
        if (target) phases.collationDrops.push(dropCollationStatement(target));
      } else {
        // No ALTER COLLATION changes how one sorts — the grammar has RENAME,
        // OWNER and REFRESH VERSION and nothing else. Replacing it means
        // dropping it, which fails while a single column still uses it, so
        // every column has to be moved off it first. That is a plan, not a
        // statement, and the generator writes plans as MANUAL notes.
        phases.collations.push(
          manualNote(
            `collation "${diff.name}" has to be replaced by hand: it is ` +
              `(${diff.rightDefinition ?? "?"}) in the target and ` +
              `(${diff.leftDefinition ?? "?"}) in the source, and PostgreSQL has no ` +
              "ALTER that changes either. Move every column off it, drop it, " +
              "create it again, then put the columns back.",
            `Collation "${diff.name}" needs replacing by hand`,
            diff.name
          )
        );
      }
      continue;
    }

    if (diff.kind === "FUNCTION" || diff.kind === "PROCEDURE") {
      // Routines are keyed by signature, so look them up by that.
      const source = report.left.routines?.find((r) => r.signature === diff.name) ?? null;
      const target = report.right.routines?.find((r) => r.signature === diff.name) ?? null;
      if (diff.status === "onlyB") {
        if (target) phases.routineDrops.push(dropRoutineStatement(target));
      } else if (source) {
        // pg_get_functiondef() hands back a CREATE OR REPLACE, which normally
        // covers "changed" as well as "missing". It does not when the return
        // type moved or an argument was renamed: PostgreSQL refuses the replace
        // outright and the migration stops on a line the report had called a
        // harmless swap. compareSchemas works that out — see
        // routineReplaceNeedsDrop — and says so on the diff.
        // A function a new table's DEFAULT or CHECK calls has to be created
        // before that table, not after it. The drop-and-recreate pair travels
        // with it, or the drop would land after the table that needs the
        // function and take it away again.
        const bucket = hoistedSignatures.has(source.signature)
          ? phases.hoistedRoutines
          : phases.routines;
        const create = createRoutineStatement(source);
        if (target && diff.replaceNeedsDrop === true) {
          const drop = dropRoutineStatement(
            target,
            " so it can be recreated with its new signature"
          );
          bucket.push(drop);
          // Remembered for the pass further down that looks at what still uses
          // the function. A procedure is left out: nothing can depend on one.
          if (target.kind === "FUNCTION") {
            replacedFunctions.push({
              target,
              drop,
              create,
              bucket,
              hoisted: bucket === phases.hoistedRoutines,
            });
          }
        }
        bucket.push(create);
      }
      continue;
    }

    // Everything left is a type: enum, domain, composite or range.
    const sourceType = findByName(report.left.types, diff.name);
    const targetType = findByName(report.right.types, diff.name);
    if (diff.status === "onlyA") {
      if (!sourceType) continue;
      const create = createTypeStatement(sourceType);
      if (create) {
        phases.beforeTables.push(create);
      } else {
        // Only a range type gets here: every other kind of type is written
        // out above. Which of the three reasons applies decides the sentence,
        // because "create it by hand" without saying why is not much help.
        const range = sourceType.rangeDetails;
        const why =
          range === undefined
            ? "this snapshot was captured before ranges were recorded in that much " +
              "detail — re-capture the source schema and the statement will be written"
            : range.canonical !== null
              ? `it has a canonical function (${range.canonical}), which takes and ` +
                "returns the range type itself: create a shell type, create the " +
                "function against it, then define the range"
              : `its subtype_diff function (${range.subtypeDiff ?? "?"}) belongs to this ` +
                "schema, and this script creates functions after the tables — create " +
                "that function first, then the type";
        phases.beforeTables.push(
          manualNote(
            `range type "${sourceType.name}" (${sourceType.definition}) has to be created ` +
              `by hand: ${why}.`,
            `Range type "${sourceType.name}" needs creating by hand`,
            sourceType.name
          )
        );
      }
    } else if (diff.status === "onlyB") {
      if (targetType) phases.afterTables.push(dropTypeStatement(targetType));
    } else if (sourceType && targetType) {
      phases.beforeTables.push(...alterTypeStatements(sourceType, targetType));
    }
  }

  // ── Views a CASCADE would take silently ───────────────────────────────────
  // Dropping a table or a column with CASCADE removes every view built on it
  // without naming any of them. Anything the source still has is put back.
  const cascadingRelations = new Set<string>();
  for (const table of report.tablesOnlyInB) cascadingRelations.add(table.name);
  for (const match of report.matchedTables) {
    if (match.columnsOnlyInB.length > 0) cascadingRelations.add(match.right.name);
    // A changed GENERATED ALWAYS AS (...) expression is another DROP COLUMN
    // CASCADE, even though the column comes straight back: PostgreSQL cannot
    // change a generated column in place, so the only portable answer is to
    // rebuild it. The CASCADE is just as wide as any other, and this table was
    // in none of the sets above — it is matched, it lost no column, and it is
    // not a view — so the walk below never saw the victims and nothing put them
    // back. Same test as the branch that emits the statement.
    if (rebuiltComputedColumns(match).size > 0) cascadingRelations.add(match.right.name);
  }
  // A view the script drops by name cascades as well. A second view built on
  // that one is usually byte-identical in both schemas, so the comparator says
  // nothing about it and it was in neither list: the CASCADE took it and
  // nothing put it back — in the migration, and again in the rollback, which
  // still called itself complete. Seeding the set with the views being dropped
  // makes the walk below find those dependents and queue them for rebuild.
  for (const name of viewsBeingDropped) cascadingRelations.add(name);

  // ── Views standing in the way of a column type change ─────────────────────
  // PostgreSQL refuses ALTER TABLE ... ALTER COLUMN ... TYPE while any view
  // selects that column, and a view identical on both sides is in no diff, so
  // nothing dropped it. The migration died on a statement the report had shown
  // as clean, and the rollback died on the mirror image of it. Drop them up
  // front and let the CASCADE walk above queue the rebuild.
  // Keyed by the table's name in the SOURCE, because that is the name the
  // ALTER statements use: the rename step above has already run by then.
  const retypedTables = new Map<string, string>();
  for (const match of report.matchedTables) {
    const retyped = match.columnMatches.some(
      (col) =>
        normalizeType(col.left.typeDisplay) !== normalizeType(col.right.typeDisplay) ||
        // A collation change is written as ALTER COLUMN ... TYPE too — there is
        // no SET COLLATE, so the only way to change one is to re-state the type
        // beside the new collation. The server does not care that the type is
        // unchanged: the statement is still a retype and it is still refused
        // while a view reads the column. Same condition as the branch that
        // emits it, so the two cannot drift apart.
        (col.left.collation !== undefined &&
          col.right.collation !== undefined &&
          col.left.collation !== col.right.collation)
    );
    if (retyped) retypedTables.set(match.right.name, match.left.name);
  }
  // One table at a time rather than one call over the whole set, so each view
  // found is attributable to the table whose column change needs it gone. The
  // union is the same either way; what the per-table walk buys is the map
  // below, which safe mode needs to hold the ALTER back beside the drop.
  for (const [targetName, sourceName] of retypedTables) {
    for (const view of viewsCascadedBy(rightViews, new Set([targetName]))) {
      if (!viewsBeingDropped.has(view.name)) {
        // Only drop what can be put back. A view the source does not have would
        // already be a diff and already be in the set above, so reaching here
        // with no source copy means views were never recorded on that side —
        // and dropping a view this script cannot recreate is worse than the
        // ALTER failing loudly.
        if (!findByName(leftViews, view.name)) continue;
        queueViewDrop(view, " so a column it reads can change type");
        cascadingRelations.add(view.name);
      }
      // A materialized view is dropped destructively — it holds its own rows —
      // so safe mode comments the drop out. The ALTER is not destructive and
      // would stay live, hit a matview that is still sitting there, and fail
      // with "cannot alter type of a column used by a view or rule". The apply
      // route runs the whole script in one transaction, so that failure rolls
      // the entire migration back: the safest mode produced the one script that
      // cannot finish. Held back beside the drop instead.
      if (heldBackViewDrops.has(view.name)) {
        const blocked = phases.retypeBlockedBy.get(sourceName) ?? [];
        if (!blocked.includes(view.name)) blocked.push(view.name);
        phases.retypeBlockedBy.set(sourceName, blocked);
      }
    }
  }

  // ── Things still using a function that is replaced ───────────────────────
  // A changed return type or argument name is written as DROP FUNCTION plus
  // CREATE, and PostgreSQL refuses the drop while anything in the target still
  // uses the function: "cannot drop function g(integer) because other objects
  // depend on it". A view, default, check or index that is identical on both
  // sides is in no diff, so nothing moved it out of the way and the whole
  // script stopped there.
  //
  // Two answers, depending on what uses it:
  //  - only plain views: drop them up front, the same way the block above does
  //    for a column type change, and let the CASCADE walk below rebuild them
  //    from the source once the new function exists;
  //  - anything else: leave the function alone and say so in a MANUAL note.
  //    Taking a default, a check, an index or a generated column off a table
  //    and putting it back is a rebuild of that table's rules, which is too
  //    much to do silently for the sake of a function, and a statement that is
  //    certain to fail takes every other change in the script down with it.
  for (const replaced of replacedFunctions) {
    const name = replaced.target.name;
    const uses = tableUsesOfRoutine(report, name);
    const viewsInTheWay: ViewSnapshot[] = [];
    for (const view of rightViews) {
      if (!expressionCallsRoutine(view.definition, name)) continue;
      // Already dropped by name, and the view drops run before the functions
      // (but after the hoisted ones, which is why those are not let through).
      if (viewsBeingDropped.has(view.name) && !replaced.hoisted) continue;
      // DROP VIEW ... CASCADE reaches the views built on this one. If one of
      // them is a materialized view its rows would go too, and safe mode must
      // never do that, so such a view counts as still in use.
      const takesRows = viewsCascadedBy(rightViews, new Set([view.name])).some(
        (victim) => victim.materialized
      );
      // Only drop what can be put back, as in the block above.
      if (replaced.hoisted || takesRows || !findByName(leftViews, view.name)) {
        uses.push(
          view.materialized
            ? `the materialized view "${view.name}"`
            : takesRows
              ? `the view "${view.name}" (a materialized view is built on it)`
              : `the view "${view.name}"`
        );
      } else {
        viewsInTheWay.push(view);
      }
    }

    if (uses.length === 0) {
      for (const view of viewsInTheWay) {
        // A view that calls two replaced functions is only queued once.
        if (viewsBeingDropped.has(view.name)) continue;
        queueViewDrop(view, " so a function it calls can be replaced");
        cascadingRelations.add(view.name);
      }
      continue;
    }

    // Still in use: take the DROP and the CREATE out together (the CREATE alone
    // would be refused, that is why the pair exists) and leave a note where
    // they stood. The function keeps its old definition, the rest of the
    // script runs, and the next comparison still reports the difference.
    for (const view of viewsInTheWay) uses.push(`the view "${view.name}"`);
    const signature = replaced.target.signature;
    const at = replaced.bucket.indexOf(replaced.drop);
    const kept = replaced.bucket.filter(
      (statement) => statement !== replaced.drop && statement !== replaced.create
    );
    kept.splice(
      at,
      0,
      manualNote(
        `function "${signature}" has to be dropped before it can be created again, because ` +
          `its return type or an argument name changed, and PostgreSQL refuses to drop a ` +
          `function that is still in use. Still using it: ${uses.join(", ")}. Take those out ` +
          `of the way, drop the function, create it from the source, then put them back. ` +
          `If this script removes them itself further down, compare again after running it ` +
          `and the function is replaced then. Until then it keeps its old definition.`,
        `Function "${signature}" needs replacing by hand, something still uses it`,
        name
      )
    );
    replaced.bucket.length = 0;
    replaced.bucket.push(...kept);
    phases.warnings.push(
      `Function "${signature}" is not replaced: its return type or an argument name ` +
        `changed, so it has to be dropped first, and PostgreSQL refuses to drop a function ` +
        `that is still in use (${uses.join(", ")}). It keeps its old definition; see the ` +
        `MANUAL note in the script.`
    );
  }

  const cascaded = viewsCascadedBy(rightViews, cascadingRelations);
  const alreadyQueued = new Set(viewsToCreate.map((view) => view.name));
  const unrecoverable: string[] = [];

  for (const victim of cascaded) {
    const survivor = findByName(leftViews, victim.name);
    if (!survivor) {
      // The source has no such view, so it is meant to go. Warn only when the
      // script does not already drop it by name: a view the migration removes
      // deliberately is not a silent casualty, and warning about it made the
      // report cry wolf on ordinary "this view was deleted" migrations.
      if (!viewsBeingDropped.has(victim.name)) unrecoverable.push(victim.name);
      continue;
    }
    if (!alreadyQueued.has(survivor.name)) {
      viewsToCreate.push(survivor);
      alreadyQueued.add(survivor.name);
    }
  }

  if (unrecoverable.length > 0) {
    phases.warnings.push(
      `CASCADE also removes ${unrecoverable.length} view${unrecoverable.length === 1 ? "" : "s"} ` +
        `that the source does not have, so ${unrecoverable.length === 1 ? "it is" : "they are"} ` +
        `not recreated: ${unrecoverable.join(", ")}.`
    );
  }

  // A view built on another view has to be created after it.
  for (const view of sortViewsByDependency(viewsToCreate)) {
    const held = heldBackViewDrops.has(view.name);
    phases.views.push(createViewStatement(view, held));
    // Every index and trigger the source's copy carries, unconditionally.
    //
    // A view in this list was dropped first — CREATE OR REPLACE without a drop
    // only happens when nothing but the WITH (...) settings moved, and those
    // views are not queued here — so its indexes and its INSTEAD OF triggers
    // went with it whether or not they appear in any diff. An index identical
    // on both sides produces no diff at all, which is exactly how a rebuilt
    // materialized view came back with none: including the one UNIQUE index
    // REFRESH ... CONCURRENTLY cannot work without.
    for (const index of view.indexes ?? []) {
      phases.afterViews.push(createIndexStatement(index, view.name, held));
    }
    for (const trigger of view.triggers ?? []) {
      phases.afterViews.push(
        ...createTriggerStatements(trigger, view.name, {
          afterHeldBackDrop: held,
          onView: true,
        })
      );
    }
  }

  // The views the loop above rebuilt from scratch, by name.
  const rebuiltViews = new Set(viewsToCreate.map((view) => view.name));

  // Indexes and triggers on views the script does NOT rebuild — a materialized
  // view whose SELECT is unchanged but whose indexes moved, or a plain view
  // that gained an INSTEAD OF trigger. Nothing dropped these, so each change
  // has to be written out on its own. Views that WERE rebuilt are skipped: the
  // loop above already wrote every index and trigger they need, and writing the
  // diffs again would emit a DROP INDEX for one that no longer exists and a
  // second CREATE for one that was just made.
  for (const diff of viewObjectDiffs) {
    const viewName = diff.table;
    if (viewName === undefined || rebuiltViews.has(viewName)) continue;

    if (diff.kind === "INDEX") {
      if (diff.status !== "onlyA") {
        const target = findByName(findByName(rightViews, viewName)?.indexes, diff.name);
        if (target) phases.afterViews.push(dropIndexStatement(target, viewName));
      }
      if (diff.status !== "onlyB") {
        const source = findByName(findByName(leftViews, viewName)?.indexes, diff.name);
        if (source) {
          phases.afterViews.push(createIndexStatement(source, viewName));
        }
      }
      continue;
    }

    if (diff.status === "onlyB") {
      phases.afterViews.push(dropTriggerStatement(diff.name, viewName));
      continue;
    }
    const source = findByName(findByName(leftViews, viewName)?.triggers, diff.name);
    if (source) {
      phases.afterViews.push(
        ...createTriggerStatements(source, viewName, { onView: true })
      );
    }
  }

  // ── Ownership and grants ──────────────────────────────────────────────────
  // Last, because it is the first pass that can tell whether the object each
  // entry describes is really going to exist in the shape the source recorded.
  //
  // A view rebuilt above starts again from nothing: DROP VIEW takes its owner
  // and its grants with it, and CREATE VIEW makes it owned by whoever runs the
  // script, granted to nobody. So for those views the target's old grants are
  // no guide, and every grant the source has is written out as if the view
  // were new. Comparing against the target instead skipped exactly the grants
  // both sides shared, which is how a rebuilt view lost every reader.
  const isRebuiltView = (privilege: PrivilegeSnapshot) =>
    (privilege.objectKind === "VIEW" ||
      privilege.objectKind === "MATERIALIZED VIEW") &&
    rebuiltViews.has(privilege.objectName);
  // A sequence a serial or identity column owns in the source is owned by that
  // column in the target too once the script has run (the column creates it,
  // or the table step ties it), so its owner comes from the table's OWNER TO.
  // See privilegeStatements for why its own OWNER TO must not be written.
  const columnOwnedSequences = new Set(
    (report.left.sequences ?? [])
      .filter((sequence) => sequence.ownedByTable !== null)
      .map((sequence) => sequence.name)
  );
  const ownerFollowsTable = (privilege: PrivilegeSnapshot) =>
    privilege.objectKind === "SEQUENCE" &&
    columnOwnedSequences.has(privilege.objectName);
  // A sequence made again under a freed name has none of the old one's grants,
  // so the source's are written in full, as for a new object.
  const isParkedSequence = (privilege: PrivilegeSnapshot) =>
    privilege.objectKind === "SEQUENCE" && parkedSequences.has(privilege.objectName);
  const privilegesWritten = new Set<string>();
  // The schema's own entry goes first, and its REVOKEs go last of all.
  //
  // A login that is not a superuser may give an object to another role only
  // when that role may create in the object's schema. The entries arrive
  // sorted by name, so "schema" came after "function", "materialized view" and
  // "procedure": their OWNER TO ran before the schema's GRANT CREATE to the new
  // owner and was refused, even for a login that may act as that owner. Taking
  // a schema privilege away last keeps every role its access until nothing
  // after it needs it, such as an owner change to a role that is about to lose
  // CREATE on the schema.
  const isSchemaEntry = (diff: ObjectDiff) => diff.name.startsWith("schema ");
  const schemaRevokes: SqlStatement[] = [];
  for (const diff of [
    ...privilegeDiffs.filter(isSchemaEntry),
    ...privilegeDiffs.filter((other) => !isSchemaEntry(other)),
  ]) {
    // Privilege entries are keyed by kind and name together, and the diff
    // carries them already joined, so look them up by the same joined string
    // the compare engine wrote — see privilegeObjects there.
    const source = findPrivilege(report.left.privileges, diff.name);
    // "onlyB" never arrives: the compare engine leaves out an entry the target
    // has and the source does not, because the object it belongs to is one this
    // script is already dropping.
    if (!source) continue;
    privilegesWritten.add(diff.name);
    const target =
      diff.status === "onlyA" || isRebuiltView(source) || isParkedSequence(source)
        ? null
        : findPrivilege(report.right.privileges, diff.name);
    const statements = privilegeStatements(
      source,
      target,
      appliesToSchema,
      // Only a view or a materialized view is ever dropped and put back, so
      // only those two can be sitting there in the old shape.
      (source.objectKind === "VIEW" ||
        source.objectKind === "MATERIALIZED VIEW") &&
        heldBackViewDrops.has(source.objectName),
      ownerFollowsTable(source)
    );
    if (source.objectKind === "SCHEMA") {
      phases.privileges.push(...statements.filter((statement) => statement.kind !== "REVOKE"));
      schemaRevokes.push(...statements.filter((statement) => statement.kind === "REVOKE"));
    } else {
      phases.privileges.push(...statements);
    }
  }
  // ...and a rebuilt view whose owner and grants were the same on both sides,
  // which is the usual case, has no diff at all. Without this it came back
  // owned by the person who ran the script and readable by nobody else.
  for (const view of viewsToCreate) {
    const key = `${view.materialized ? "materialized view" : "view"} ${view.name}`;
    if (privilegesWritten.has(key)) continue;
    const source = findPrivilege(report.left.privileges, key);
    // No entry means the source snapshot never recorded privileges, so there
    // is nothing to put back.
    if (!source) continue;
    phases.privileges.push(
      ...privilegeStatements(
        source,
        null,
        appliesToSchema,
        heldBackViewDrops.has(view.name)
      )
    );
  }

  // A parked sequence whose grants are the same on both sides has no diff of
  // its own, and the new one still needs them.
  for (const name of parkedSequences) {
    const key = `sequence ${name}`;
    if (privilegesWritten.has(key)) continue;
    const source = findPrivilege(report.left.privileges, key);
    if (!source) continue;
    privilegesWritten.add(key);
    phases.privileges.push(...privilegeStatements(source, null, appliesToSchema, false, ownerFollowsTable(source)));
  }

  // The schema REVOKEs held back above, after every owner change and grant.
  phases.privileges.push(...schemaRevokes);

  // ...and dropped before it, which is the same order reversed.
  phases.viewDrops.reverse();

  // Adding an enum value and using it in the same transaction is rejected by
  // PostgreSQL ("unsafe use of new value"). Apply from this app handles it —
  // the route runs these statements before it opens the transaction — but a
  // script pasted straight into psql inside BEGIN/COMMIT still hits the error,
  // so it is worth saying which is which.
  const addsEnumValue = phases.beforeTables.some(
    (stmt) => stmt.kind === "ALTER_TYPE" && stmt.sql.includes("ADD VALUE")
  );
  if (addsEnumValue) {
    phases.warnings.push(
      `This script adds enum values. Applying it from this app is fine — the new values ` +
        `are added before the migration transaction starts. If you run the script by hand ` +
        `inside a single BEGIN/COMMIT, PostgreSQL will reject any later statement that USES ` +
        `one of the new values, so run the ALTER TYPE lines on their own first.`
    );
  }

  return phases;
}

/**
 * Columns, by the source's names, whose default reads sequence `name` in the
 * target and still reads it in the source, so the script leaves them on it.
 */
function columnsReadingOnBothSides(report: CompareReport, name: string): string[] {
  const readers: string[] = [];
  for (const match of report.matchedTables) {
    for (const col of match.columnMatches) {
      if (
        nextvalSequenceName(col.right.columnDefault) === name &&
        nextvalSequenceName(col.left.columnDefault) === name
      ) {
        readers.push(`"${match.left.name}"."${col.left.name}"`);
      }
    }
  }
  return readers;
}
