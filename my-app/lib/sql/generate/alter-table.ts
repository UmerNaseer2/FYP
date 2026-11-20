// alterStatementsForMatch(): every ALTER statement for one matched table, in
// the order they must run. It is one long function and is kept whole.

import type { TableMatch } from "../../compare/types";
import type { SequenceSnapshot, ViewSnapshot } from "../../postgres";
// Severity is NOT decided here. These four helpers live in the compare engine
// and are the single rule for how dangerous each kind of change is, so the
// warning on a statement and the pill in the report are one decision instead of
// two implementations that have to be kept in step by hand.
import {
  computedChangeSeverity,
  constraintChangeSeverity,
  describeComputed,
  extractBaseType,
  collationChangeSeverity,
  columnMatchPercent,
  generatedChangeSeverity,
  isNarrowingType,
  nullabilityChangeSeverity,
  sequenceOptionsChangeSeverity,
  serialSides,
  typeChangeSeverity,
} from "../../compare/diff";
import {
  constraintsAfterColumnRebuild,
  dropColumnOnlyInTarget,
  possibleColumnRenameNote,
} from "./alter-helpers";
import { normalizeType, q } from "./basics";
import {
  namesRetypedColumn,
  rebuiltForTypeChange,
  retypesBehindKeptComputedColumns,
  stopsComputingInPlace,
} from "./column-changes";
import type { SequencePlan } from "./columns";
import {
  buildColumnDef,
  collateSuffix,
  emptySequencePlan,
  identitySequenceName,
  isNextvalDefault,
  restoreNotNullStatement,
  serialTypeFor,
  usesSerialShorthand,
} from "./columns";
import type { InboundForeignKey } from "./inbound-keys";
import {
  dependentsOnKey,
  dropInboundKeyStatement,
  inboundKeyId,
  restoreInboundKeyStatement,
  sourceKeepsKeyFor,
} from "./inbound-keys";
import {
  columnSequenceStatements,
  counterPastRowsStatement,
  countsDown,
  createSequenceStatement,
  identityOptionsSuffix,
  nextvalSequenceName,
  sequenceOptionSteps,
} from "./sequences";
import {
  literal,
  objectStatement,
  oneLine,
  onlyIfMissing,
  tableColumnQuery,
  tableConstraintQuery,
} from "./statement-helpers";
import { buildFkDef, lookupConstraintDef } from "./tables";
import type { SqlStatement } from "./types";
import { viewsCascadedBy } from "./views";

export function alterStatementsForMatch(
  match: TableMatch,
  sourceSchema: string,
  sourceSequences: SequenceSnapshot[] | undefined,
  // The target's views, only so a DROP ... CASCADE below can name what it takes
  // with it. `undefined` means the snapshot never recorded views, in which case
  // the statement says nothing rather than claiming there are none.
  targetViews: ViewSnapshot[] | undefined,
  // Foreign keys elsewhere in the target that point at this table — see
  // inboundForeignKeysByTable. They stand in the way of a key drop below.
  inboundFks: InboundForeignKey[] = [],
  // Which of the source's columns the `serial` shorthand describes truthfully.
  // An empty plan means "none of them", which is the safe answer: the column is
  // written out in full and its sequence built beside it.
  plan: SequencePlan = emptySequencePlan(),
  // Keys name-clashes.ts moved to a parked name first, by their name in the
  // target. Their drop further down uses the parked name.
  parkedKeys: Map<string, string> = new Map(),
  // The table's owner in the target, so a sequence tied to one of its columns
  // can be given the same owner first. See sequenceOwnerAlignment.
  tableOwner?: string
): { stmts: SqlStatement[]; fkStmts: SqlStatement[] } {
  const stmts: SqlStatement[] = [];
  // New FK ADD CONSTRAINTs are collected here and returned separately so the
  // caller can defer them — they run AFTER every table's columns exist. An FK
  // added inline could reference a column that a later-processed table hasn't
  // gained yet, aborting the migration (issue #23).
  const fkStmts: SqlStatement[] = [];
  // After the renames, the table in B carries A's name. Use that for all
  // subsequent ALTER TABLE statements so they reference the correct name.
  // Table names are UNQUALIFIED — search_path scopes them (see buildCreateTable).
  const tName = match.left.name;

  // ── a. Column renames ────────────────────────────────────────────────────
  // Must come before the add/alter steps so they reference the post-rename name.
  // Each is skipped when the table already has a column by the new name, which
  // on a second run is the very column the first run renamed.
  for (const colMatch of match.columnMatches) {
    if (!colMatch.exact) {
      stmts.push({
        sql: onlyIfMissing(
          tableColumnQuery(tName, colMatch.left.name),
          `ALTER TABLE ${q(tName)} RENAME COLUMN ${q(colMatch.right.name)} TO ${q(colMatch.left.name)};`
        ),
        description: `Rename column "${colMatch.right.name}" → "${colMatch.left.name}" in "${tName}" (${columnMatchPercent(colMatch.score)}% match — verify this is a rename before running)`,
        kind: "RENAME_COLUMN",
        severity: "breaking",
        tableName: tName,
        destructive: false,
      });
    }
  }

  // PostgreSQL refuses ALTER COLUMN ... TYPE on a column that a computed column
  // reads. So a computed column that reads a column retyped in section c is
  // added after that section, not before or in the middle of it: its statements
  // are collected here and appended once the type changes are written.
  const afterTypeChanges: SqlStatement[] = [];

  // PostgreSQL refuses DROP NOT NULL on a column that is still in a primary
  // key ("column is in a primary key"). So for a column in the TARGET's key the
  // statement waits here and is written in section d, after the constraint
  // drops, where the old key is already gone.
  const afterKeyDrops: SqlStatement[] = [];
  const targetKeyColumns = new Set(match.right.primaryKey?.columns ?? []);

  // ── b. Add columns that exist in A but are absent from B ─────────────────
  for (const col of match.columnsOnlyInA) {
    const out =
      col.generated && namesRetypedColumn(match, col.generated.expression, "left")
        ? afterTypeChanges
        : stmts;
    // NOT NULL with no default is the one shape PostgreSQL cannot add to a
    // table that already has rows: there is no value to put in them. Writing it
    // as one ALTER TABLE ADD COLUMN … NOT NULL makes the whole script abort,
    // which matters most on a rollback — restoring a column the migration
    // dropped would be impossible on any table holding data.
    //
    // A computed column fills its own rows from its expression, and an identity
    // column fills them from its sequence, so neither is risky.
    const risky =
      !col.nullable && col.columnDefault === null && !col.generated && !col.identity;
    // Same sequence-first, ownership-after shape a new table uses for a column
    // the `serial` shorthand cannot describe — see columnSequenceStatements.
    const serialOk = usesSerialShorthand(plan, tName, col.name);
    const tunedSerial = columnSequenceStatements(col, tName, serialOk, tableOwner);
    const renameNote = possibleColumnRenameNote(match, col.name, tName);
    if (renameNote) out.push(renameNote);
    out.push(...tunedSerial.before);
    out.push({
      sql: `ALTER TABLE ${q(tName)} ADD COLUMN IF NOT EXISTS ${buildColumnDef(col, risky, serialOk, identitySequenceName(plan, tName, col.name))};`,
      description:
        `Add column "${col.name}" (${col.typeDisplay}) to "${tName}"` +
        (risky ? " — added nullable; the next statement puts NOT NULL back" : ""),
      kind: "ADD_COLUMN",
      severity: "safe",
      tableName: tName,
      destructive: false,
    });
    if (risky) out.push(restoreNotNullStatement(col, tName));
    out.push(...tunedSerial.after);
  }

  // A key on another table may be holding a column or a key of this one in
  // place, and the same key can be holding two of them. Dropped once, put back
  // once, whether a column rebuild below or a key drop further down finds it.
  const clearedInbound = new Set<string>();

  // ── Computed columns in the way of a type change ─────────────────────────
  // The other half of the rule above afterTypeChanges: a computed column the
  // TARGET has, which reads a column retyped below, must be out of the way
  // before that statement runs.
  //
  // One that only the target has is dropped in section e, at the very end. That
  // is too late here, so its drop is written now and section e skips it.
  const droppedBeforeTypeChanges = new Set<string>();
  for (const col of match.columnsOnlyInB) {
    if (!col.generated || !namesRetypedColumn(match, col.generated.expression, "right")) continue;
    stmts.push(dropColumnOnlyInTarget(col, tName));
    droppedBeforeTypeChanges.add(col.name);
  }
  // One that both sides have is handled inside the loop below, where it stops
  // computing or is rebuilt. Those columns only need to be visited first, so
  // that their DROP EXPRESSION or DROP COLUMN is written before the type change
  // of the column they read. Every other column keeps its place.
  const readsRetypedColumn = (col: TableMatch["columnMatches"][number]) =>
    !!col.right.generated && namesRetypedColumn(match, col.right.generated.expression, "right");
  const columnMatchesInOrder = [
    ...match.columnMatches.filter(readsRetypedColumn),
    ...match.columnMatches.filter((col) => !readsRetypedColumn(col)),
  ];
  // In safe mode some of those computed columns stay, and the type change
  // behind each has to stay with it.
  const heldForComputed = retypesBehindKeptComputedColumns(match);

  // ── c. Type, nullability and default changes on matched columns ──────────
  for (const colMatch of columnMatchesInOrder) {
    // After the rename step above, this column is now called colMatch.left.name in B.
    const colName = colMatch.left.name;
    const leftNorm = normalizeType(colMatch.left.typeDisplay);
    const rightNorm = normalizeType(colMatch.right.typeDisplay);

    // ── A GENERATED ALWAYS AS (…) clause appearing, going, or changing ──────
    // One direction has an ALTER: a STORED computed column becoming ordinary
    // (stopsComputingInPlace). For the rest there is none that works
    // everywhere. PostgreSQL cannot turn an ordinary column into a computed
    // one, and SET EXPRESSION only exists from version 17, so the portable
    // answer is to rebuild the column. The rebuild runs before everything else
    // this loop emits and then skips the rest:
    // a SET DEFAULT or a SET NOT NULL aimed at a column that is about to be
    // dropped is at best wasted and at worst rejected.
    const leftComputed = describeComputed(colMatch.left);
    const rightComputed = describeComputed(colMatch.right);
    if (stopsComputingInPlace(colMatch)) {
      // The values stay where they are. What follows in this loop then
      // compares the two columns like any others: a type, a default or a
      // NOT NULL the source has is applied to the now ordinary column.
      // IF EXISTS makes a second run a no-op once the column is ordinary.
      stmts.push({
        sql: `ALTER TABLE ${q(tName)} ALTER COLUMN ${q(colName)} DROP EXPRESSION IF EXISTS;`,
        description:
          `Stop computing "${colName}" in "${tName}": it becomes an ordinary column and ` +
          "keeps the values it holds (needs PostgreSQL 13 or later)",
        kind: "ALTER_COLUMN_DEFAULT",
        severity: computedChangeSeverity(),
        tableName: tName,
        destructive: false,
      });
    } else if (
      leftComputed !== null &&
      rightComputed !== null &&
      (leftComputed !== rightComputed || rebuiltForTypeChange(match, colMatch))
    ) {
      // The second half of that test is a computed column that is the same on
      // both sides and reads a column whose type changes: see
      // rebuiltForTypeChange. It takes the same DROP/ADD route.
      const forTypeChange = leftComputed === rightComputed;
      // The ADD half waits for the type changes when the column it brings back
      // reads one of the retyped columns (see afterTypeChanges).
      const addTo =
        colMatch.left.generated &&
        namesRetypedColumn(match, colMatch.left.generated.expression, "left")
          ? afterTypeChanges
          : stmts;
      // Name them. "CASCADE takes any view built on it" tells the reader a rule;
      // this tells them which of their views it is about to remove, and the
      // caller has already queued the source's copy of each for rebuild.
      const alsoDropped = targetViews
        ? viewsCascadedBy(targetViews, new Set([match.right.name])).map((v) => v.name)
        : [];
      const cascadeNote =
        alsoDropped.length > 0 ? `; CASCADE also drops ${alsoDropped.join(", ")}` : "";
      // The values only come back on their own when the column going away is
      // ITSELF computed: PostgreSQL fills every row from the expression the
      // moment the column returns, so nothing a person typed is lost. A stored
      // column turning INTO a computed one is the other direction, and it is a
      // plain data loss — the new expression is not going to reproduce what was
      // in those rows. That one has to be armed like any other destructive drop.
      const dropsStoredValues = !colMatch.right.generated;
      // A VIRTUAL column turning ordinary (STORED ones stop computing in place,
      // above). Its values were worked out on every read, and the rebuilt
      // column starts with its default or NULL, so the values the target's
      // users saw are gone even though no stored data was.
      const losesComputedValues = !dropsStoredValues && !colMatch.left.generated;
      // Keys on OTHER tables that point at this column. The CASCADE drops them
      // too, without naming them, and a key identical in both schemas is in no
      // diff, so nothing put it back: the other table quietly stopped checking
      // its rows. Each comes off by name here, so the script says so, and goes
      // back on at the very end, once the column and its key are back; putting
      // it back also checks that the rows still point at something.
      // The drop is held back exactly when the column drop is, so safe mode
      // never takes a key off a column it leaves standing.
      for (const entry of inboundFks) {
        if (!entry.fk.referencedColumns.includes(colMatch.right.name)) continue;
        if (clearedInbound.has(inboundKeyId(entry))) continue;
        clearedInbound.add(inboundKeyId(entry));
        stmts.push(
          dropInboundKeyStatement(
            entry,
            `it points at "${colName}" on "${tName}", which is about to be rebuilt`,
            dropsStoredValues || losesComputedValues
          )
        );
        if (entry.survives && !entry.handledByOwner && sourceKeepsKeyFor(match, entry.referencedColumnsAfterRename)) {
          fkStmts.push(restoreInboundKeyStatement(entry));
        }
      }
      stmts.push({
        sql: `ALTER TABLE ${q(tName)} DROP COLUMN IF EXISTS ${q(colName)} CASCADE;`,
        description:
          `Drop column "${colName}" from "${tName}" so it can be rebuilt — ` +
          (forTypeChange
            ? "WARNING: PostgreSQL cannot change the type of a column that a generated " +
              "column reads, so the generated column is rebuilt around the change, and "
            : "WARNING: PostgreSQL cannot change a generated column in place, and ") +
          `CASCADE takes any index or view built on it${cascadeNote}` +
          (dropsStoredValues
            ? `; the values in "${colName}" are stored data and the new expression does not bring them back`
            : losesComputedValues
              ? `; "${colName}" comes back as an ordinary column holding its default or NULL, ` +
                "not the values it used to compute"
              : ""),
        kind: "DROP_COLUMN",
        severity: computedChangeSeverity(),
        tableName: tName,
        destructive: dropsStoredValues || losesComputedValues,
      });
      // Same shape as the add-column section above: NOT NULL with no default is
      // the one thing PostgreSQL cannot add to a table that already has rows,
      // and one ALTER TABLE that cannot run aborts the whole script. A computed
      // or identity column fills its own rows, so this only ever bites the
      // rebuild that ends up ORDINARY.
      const risky =
        !colMatch.left.nullable &&
        colMatch.left.columnDefault === null &&
        !colMatch.left.generated &&
        !colMatch.left.identity;
      // A rebuild that lands on an ordinary column can land on a serial one, so
      // it asks the same question the add-column section does.
      const rebuiltSerialOk = usesSerialShorthand(plan, tName, colMatch.left.name);
      const rebuiltSequence = columnSequenceStatements(colMatch.left, tName, rebuiltSerialOk, tableOwner);
      addTo.push(...rebuiltSequence.before);
      addTo.push({
        sql: `ALTER TABLE ${q(tName)} ADD COLUMN IF NOT EXISTS ${buildColumnDef(colMatch.left, risky, rebuiltSerialOk, identitySequenceName(plan, tName, colMatch.left.name))};`,
        description:
          (colMatch.left.generated
            ? `Rebuild "${colName}" in "${tName}" as ${leftComputed}`
            : `Rebuild "${colName}" in "${tName}" as an ordinary column`) +
          (risky ? " — added nullable; the next statement puts NOT NULL back" : ""),
        kind: "ADD_COLUMN",
        severity: computedChangeSeverity(),
        tableName: tName,
        destructive: false,
      });
      if (risky) addTo.push(restoreNotNullStatement(colMatch.left, tName));
      addTo.push(...rebuiltSequence.after);
      // CASCADE took the column's constraints as well as its indexes. The
      // indexes are put back in objectPhases, where the create lands after every
      // ADD COLUMN; the constraints are put back here.
      const backAfterRebuild = constraintsAfterColumnRebuild(match, colName, tName, sourceSchema);
      addTo.push(...backAfterRebuild.stmts);
      fkStmts.push(...backAfterRebuild.fkStmts);
      continue;
    }

    // How each side generates its values and what default it carries. Read
    // before the type change, which needs them as well as the identity and
    // default sections further down.
    //
    // `identity: undefined` means the snapshot predates the field. That cannot
    // be read as "not an identity column", so such a column emits no identity
    // statement at all and falls through to the plain default handling.
    const identityRecorded =
      colMatch.left.identity !== undefined && colMatch.right.identity !== undefined;
    const leftIdentity = identityRecorded ? (colMatch.left.identity ?? null) : null;
    const rightIdentity = identityRecorded ? (colMatch.right.identity ?? null) : null;
    // A serial is a nextval default on a sequence the column OWNS. A nextval
    // default on a standalone sequence is a plain default, set and dropped like
    // any other: the script must not tie that sequence to this column or move
    // its value. serialSides is the compare engine's rule, used here unchanged.
    const serial = serialSides(colMatch.left, colMatch.right);
    const leftSerial = serial.left;
    const rightSerial = serial.right;
    const leftDefault = colMatch.left.columnDefault?.trim() || null;
    const rightDefault = colMatch.right.columnDefault?.trim() || null;
    // Set when the type change takes the target's default off first. The
    // default section then owes the column the source's default.
    let defaultDroppedForType = false;

    if (leftNorm !== rightNorm) {
      const baseChanged =
        extractBaseType(colMatch.left.typeDisplay) !== extractBaseType(colMatch.right.typeDisplay);
      // Same base type but a SMALLER size/precision (e.g. varchar(200) →
      // varchar(100), numeric(10,2) → numeric(6,2)). This is NOT a safe widen:
      // PostgreSQL rejects the change if any existing value exceeds the new
      // size, so it is a breaking change that must be flagged.
      const narrowing =
        !baseChanged &&
        isNarrowingType(colMatch.right.typeDisplay, colMatch.left.typeDisplay);
      // USING is needed when PostgreSQL can't cast automatically (cross-type changes).
      // Same-family widenings (e.g. varchar(100) → varchar(200)) don't need it.
      const usingSuffix = baseChanged
        ? ` USING ${q(colName)}::${colMatch.left.typeDisplay}`
        : "";

      let description: string;
      if (baseChanged) {
        description = `Change type of "${colName}" in "${tName}": ${colMatch.right.typeDisplay} → ${colMatch.left.typeDisplay} (may require data conversion)`;
      } else if (narrowing) {
        description = `Narrow "${colName}" in "${tName}": ${colMatch.right.typeDisplay} → ${colMatch.left.typeDisplay} — WARNING: will fail if any existing value exceeds the new size`;
      } else {
        description = `Widen "${colName}" in "${tName}": ${colMatch.right.typeDisplay} → ${colMatch.left.typeDisplay}`;
      }
      const severity = typeChangeSeverity(
        colMatch.left.typeDisplay,
        colMatch.right.typeDisplay
      );

      // ALTER COLUMN ... TYPE converts the column's default as well as its rows,
      // but USING is applied to the rows only. A default with no automatic cast
      // to the new type stops the whole statement: a text column with DEFAULT
      // 'active' cannot become an enum. So the default comes off first and the
      // default section below puts the source's back, which is the order the
      // PostgreSQL manual gives for this case.
      //
      // Two defaults stay on. A serial on both sides keeps its own sequence, and
      // nextval() returns a bigint that casts to every integer type. An identity
      // column has no default to drop, and DROP DEFAULT errors on one.
      if (
        baseChanged &&
        rightDefault !== null &&
        rightIdentity === null &&
        !(leftSerial && rightSerial)
      ) {
        const dropDefault = `ALTER TABLE ${q(tName)} ALTER COLUMN ${q(colName)} DROP DEFAULT;`;
        stmts.push({
          // When the column is becoming an identity column, a second run finds
          // it already is one, and must skip the DROP DEFAULT it would refuse.
          sql:
            leftIdentity !== null
              ? onlyIfMissing(
                  `${tableColumnQuery(tName, colName)} AND attidentity <> ''`,
                  dropDefault
                )
              : dropDefault,
          description: `Drop the default on "${colName}" in "${tName}" so its type can change`,
          kind: "ALTER_COLUMN_DEFAULT",
          severity: "safe",
          tableName: tName,
          destructive: false,
        });
        defaultDroppedForType = true;
      }

      // ALTER COLUMN ... TYPE resets the column to the new type's DEFAULT
      // collation whenever COLLATE is omitted, so an ordinary widening used to
      // silently strip a collation the target already had. Restating the
      // source's is what makes the column match the source it is being synced
      // to. The grammar is TYPE <type> [COLLATE ...] [USING ...], in that order.
      stmts.push({
        sql:
          `ALTER TABLE ${q(tName)} ALTER COLUMN ${q(colName)} TYPE ` +
          `${colMatch.left.typeDisplay}${collateSuffix(colMatch.left)}${usingSuffix};`,
        description,
        kind: "ALTER_COLUMN_TYPE",
        severity,
        tableName: tName,
        destructive: false,
        // Held back with the computed column that reads it, when safe mode
        // keeps that column: see retypesBehindKeptComputedColumns.
        ...(heldForComputed.has(colName) ? { needsArmedDrop: true } : {}),
      });
    } else if (
      // Same type, different collation. There is no SET COLLATE in PostgreSQL:
      // the only way to change one is to re-state the type it already has and
      // name the collation beside it. Skipped when either side never recorded
      // one, where `undefined` means "unknown" and not "the type default".
      colMatch.left.collation !== undefined &&
      colMatch.right.collation !== undefined &&
      colMatch.left.collation !== colMatch.right.collation
    ) {
      // Going BACK to the type default still has to be written out — omitting
      // COLLATE on a column that has one leaves that column exactly as it is.
      // pg_catalog is qualified here because "default" is also a perfectly
      // legal name for a collation somebody created in the target schema.
      const clause = colMatch.left.collation
        ? ` COLLATE ${colMatch.left.collation}`
        : ` COLLATE pg_catalog."default"`;
      stmts.push({
        sql:
          `ALTER TABLE ${q(tName)} ALTER COLUMN ${q(colName)} TYPE ` +
          `${colMatch.left.typeDisplay}${clause};`,
        description:
          `Change collation of "${colName}" in "${tName}": ` +
          `${colMatch.right.collation ?? "type default"} → ` +
          `${colMatch.left.collation ?? "type default"} — WARNING: rewrites the ` +
          "table and rebuilds every index on this column, and changes how its " +
          "values sort and compare",
        kind: "ALTER_COLUMN_TYPE",
        severity: collationChangeSeverity(),
        tableName: tName,
        destructive: false,
        ...(heldForComputed.has(colName) ? { needsArmedDrop: true } : {}),
      });
    }

    if (colMatch.left.nullable !== colMatch.right.nullable) {
      if (!colMatch.left.nullable) {
        stmts.push({
          sql: `ALTER TABLE ${q(tName)} ALTER COLUMN ${q(colName)} SET NOT NULL;`,
          description: `Enforce NOT NULL on "${colName}" in "${tName}" — WARNING: will fail if existing rows contain NULLs; backfill first`,
          kind: "ALTER_COLUMN_NULLABILITY",
          severity: nullabilityChangeSeverity(colMatch.left.nullable),
          tableName: tName,
          destructive: false,
        });
      } else {
        // See afterKeyDrops: a column in the target's primary key has to wait.
        const out = targetKeyColumns.has(colMatch.right.name) ? afterKeyDrops : stmts;
        out.push({
          sql: `ALTER TABLE ${q(tName)} ALTER COLUMN ${q(colName)} DROP NOT NULL;`,
          description: `Allow nulls on "${colName}" in "${tName}"`,
          kind: "ALTER_COLUMN_NULLABILITY",
          severity: nullabilityChangeSeverity(colMatch.left.nullable),
          tableName: tName,
          destructive: false,
        });
      }
    }

    // ── How the column generates its own values ─────────────────────────────
    // A serial (a nextval default) and an IDENTITY column do the same job with
    // completely different catalog entries, so they are handled together:
    // moving from one to the other means removing what is there before adding
    // what is wanted, and neither statement is right on its own.
    if (identityRecorded && leftIdentity !== rightIdentity) {
      if (leftIdentity !== null && rightIdentity !== null) {
        // Both are identity columns, only the flavour differs.
        stmts.push({
          sql: `ALTER TABLE ${q(tName)} ALTER COLUMN ${q(colName)} SET GENERATED ${leftIdentity};`,
          description: `Change "${colName}" in "${tName}" to GENERATED ${leftIdentity} AS IDENTITY`,
          kind: "ALTER_COLUMN_DEFAULT",
          severity: generatedChangeSeverity(colMatch.left, colMatch.right),
          tableName: tName,
          destructive: false,
        });
      } else if (leftIdentity !== null) {
        // ADD GENERATED is refused while the column has any default at all, a
        // serial's nextval or a plain value, so the target gives it up first.
        // The type change above may already have done that.
        //
        // Both steps are skipped once the column is an identity column. On a
        // second run ADD GENERATED would find one already there, and DROP
        // DEFAULT is refused outright on an identity column.
        const alreadyIdentity = `${tableColumnQuery(tName, colName)} AND attidentity <> ''`;
        if (rightDefault !== null && !defaultDroppedForType) {
          stmts.push({
            sql: onlyIfMissing(
              alreadyIdentity,
              `ALTER TABLE ${q(tName)} ALTER COLUMN ${q(colName)} DROP DEFAULT;`
            ),
            description: rightSerial
              ? `Drop the sequence default on "${colName}" in "${tName}" before it becomes an identity column`
              : `Drop the default on "${colName}" in "${tName}" before it becomes an identity column`,
            kind: "ALTER_COLUMN_DEFAULT",
            severity: "safe",
            tableName: tName,
            destructive: false,
          });
        }
        stmts.push({
          sql: onlyIfMissing(
            alreadyIdentity,
            `ALTER TABLE ${q(tName)} ALTER COLUMN ${q(colName)} ` +
              `ADD GENERATED ${leftIdentity} AS IDENTITY` +
              `${identityOptionsSuffix(colMatch.left)};`
          ),
          description: `Make "${colName}" in "${tName}" an identity column — WARNING: fails unless the column is NOT NULL`,
          kind: "ALTER_COLUMN_DEFAULT",
          severity: generatedChangeSeverity(colMatch.left, colMatch.right),
          tableName: tName,
          destructive: false,
        });
        // The identity's sequence starts at 1 whatever the rows already hold.
        stmts.push(
          counterPastRowsStatement(
            tName,
            colName,
            null,
            nextvalSequenceName(rightDefault),
            countsDown(colMatch.left.sequenceOptions?.increment)
          )
        );
      } else {
        stmts.push({
          sql: `ALTER TABLE ${q(tName)} ALTER COLUMN ${q(colName)} DROP IDENTITY IF EXISTS;`,
          description: leftSerial
            ? `Remove the identity on "${colName}" in "${tName}" so a sequence default can replace it`
            : `Stop "${colName}" in "${tName}" generating its own values`,
          kind: "ALTER_COLUMN_DEFAULT",
          severity: generatedChangeSeverity(colMatch.left, colMatch.right),
          tableName: tName,
          destructive: false,
        });
      }
    }

    // ── The settings of the sequence behind the column ──────────────────────
    // Only for a column that generates its values the SAME way on both sides.
    // Every other case is a rebuild — the branch above adds the identity clause
    // with its options attached, and the serial branch below creates the
    // sequence from the source's own settings — so emitting these as well would
    // be setting twice what one statement already set.
    //
    // `undefined` on either side is a snapshot taken before the settings were
    // read, and says nothing about what the sequence is configured as, so
    // nothing is emitted for it.
    const leftSequenceOptions = colMatch.left.sequenceOptions;
    const rightSequenceOptions = colMatch.right.sequenceOptions;
    const sameGenerator =
      (leftIdentity !== null && rightIdentity !== null) ||
      (leftIdentity === null && rightIdentity === null && leftSerial && rightSerial);
    if (leftSequenceOptions && rightSequenceOptions && sameGenerator) {
      // An identity column is altered through the table, because that is the
      // only handle the script has on it: its sequence has a generated name
      // that nothing in the snapshot ties back to the column. A serial's
      // sequence is named right there in the target's own default, so it is
      // altered directly.
      const identityForm = leftIdentity !== null;
      const targetSequence = identityForm ? null : nextvalSequenceName(rightDefault);
      const prefix = identityForm
        ? `ALTER TABLE ${q(tName)} ALTER COLUMN ${q(colName)} `
        : targetSequence !== null
          ? `ALTER SEQUENCE ${q(targetSequence)} `
          : null;
      // RESTART is the one step that must not repeat: a second run would move
      // the counter back to the start again, onto ids handed out since the
      // first. It is only there so narrower bounds can be set, so it is skipped
      // once the sequence already has the source's bounds. pg_get_serial_sequence
      // finds an identity column's sequence as well as a serial's.
      const sequenceRegclass = identityForm
        ? `to_regclass(pg_get_serial_sequence(${literal(q(tName))}, ${literal(colName)}))`
        : targetSequence !== null
          ? `to_regclass(${literal(q(targetSequence))})`
          : null;
      const boundsInPlace =
        sequenceRegclass === null
          ? null
          : `SELECT 1 FROM pg_sequence WHERE seqrelid = ${sequenceRegclass} ` +
            `AND seqmin = ${leftSequenceOptions.minValue} ` +
            `AND seqmax = ${leftSequenceOptions.maxValue}`;
      const severity = sequenceOptionsChangeSeverity(
        leftSequenceOptions,
        rightSequenceOptions
      );
      for (const step of sequenceOptionSteps(leftSequenceOptions, rightSequenceOptions)) {
        stmts.push(
          prefix === null
            ? {
                sql: oneLine(
                  `-- MANUAL: set ${step.clause} on the sequence behind "${colName}" in "${tName}" by hand; its name could not be read from the default ${rightDefault}.`,
                ),
                description: `"${colName}" needs ${step.clause} set on its sequence by hand`,
                kind: "ALTER_SEQUENCE",
                severity: "info",
                tableName: tName,
                destructive: false,
              }
            : {
                // Only RESTART has set: false — see sequenceOptionSteps.
                sql:
                  step.set || boundsInPlace === null
                    ? `${prefix}${step.set && identityForm ? "SET " : ""}${step.clause};`
                    : onlyIfMissing(boundsInPlace, `${prefix}${step.clause};`),
                description:
                  `${step.description} on the sequence behind "${colName}" in "${tName}"` +
                  (step.warning ? ` — WARNING: ${step.warning}` : ""),
                kind: "ALTER_SEQUENCE",
                severity,
                tableName: tName,
                destructive: false,
              }
        );
      }
    }

    // ── Default value change ────────────────────────────────────────────────
    // Defaults are schema-relative here (own-schema qualifier stripped at
    // snapshot time), so SET DEFAULT resolves against the target via search_path.
    if (leftIdentity !== null) {
      // The identity clause IS how this column gets its values; it never also
      // carries a default, so there is nothing further to set.
    } else if (leftSerial && rightSerial) {
      // Both serial — the sequence NAME differs between two schemas and nothing
      // else does, so there is no real change here to emit.
    } else if (leftSerial) {
      // Source is serial, target is not. `serial` is not a real type — it is a
      // sequence, a default that reads it, and an ownership link — so all three
      // are rebuilt here. The sequence is created rather than assumed present:
      // an owned sequence never appears in the object diffs (it belongs to its
      // column, not to the schema), so nothing else in the script makes it.
      const sequenceName = nextvalSequenceName(leftDefault);
      if (sequenceName === null) {
        stmts.push({
          sql: oneLine(
            `-- MANUAL: "${colName}" in "${tName}" has the default ${leftDefault}, which could not be read as a sequence; set it by hand.`,
          ),
          description: `"${colName}" needs its default set manually`,
          kind: "ALTER_COLUMN_DEFAULT",
          severity: "info",
          tableName: tName,
          destructive: false,
        });
      } else {
        const sourceSequence = sourceSequences?.find((seq) => seq.name === sequenceName);
        stmts.push(
          sourceSequence
            ? createSequenceStatement(sourceSequence)
            : objectStatement({
                sql: `CREATE SEQUENCE IF NOT EXISTS ${q(sequenceName)};`,
                description: `Create sequence "${sequenceName}" for "${colName}" in "${tName}"`,
                kind: "CREATE_SEQUENCE",
                tableName: sequenceName,
              })
        );
        stmts.push({
          // The name goes in QUOTED inside the literal. nextval reads what is
          // in the string as SQL would read it, so a bare User_id_seq is folded
          // to user_id_seq and the deploy stops on "relation does not exist" —
          // and a Prisma-style "User" table is exactly where that name comes
          // from. counterPastRowsStatement (sequences.ts) writes it the same way.
          sql: `ALTER TABLE ${q(tName)} ALTER COLUMN ${q(colName)} SET DEFAULT nextval(${literal(q(sequenceName))}::regclass);`,
          description: `Make "${colName}" in "${tName}" take its values from sequence "${sequenceName}"`,
          kind: "ALTER_COLUMN_DEFAULT",
          severity: "safe",
          tableName: tName,
          destructive: false,
        });
        // Ownership is what makes it a serial rather than a table plus a loose
        // sequence: it ties the sequence's lifetime to the column's.
        stmts.push({
          sql: `ALTER SEQUENCE ${q(sequenceName)} OWNED BY ${q(tName)}.${q(colName)};`,
          description: `Tie sequence "${sequenceName}" to "${colName}" in "${tName}"`,
          kind: "ALTER_SEQUENCE",
          severity: "safe",
          tableName: tName,
          destructive: false,
        });
        // A new sequence starts at its START whatever the rows already hold.
        // Only on an integer column: max() + 1 has no meaning on anything else,
        // and a nextval default on, say, a text column is not worth guessing at.
        if (serialTypeFor(colMatch.left.typeDisplay) !== null) {
          stmts.push(
            counterPastRowsStatement(
              tName,
              colName,
              sequenceName,
              null,
              countsDown(sourceSequence?.increment ?? colMatch.left.sequenceOptions?.increment)
            )
          );
        }
      }
    } else if (defaultDroppedForType) {
      // The type change took the target's default off, so it is gone even when
      // the two sides' defaults read the same. The source's goes back on,
      // written for the new type.
      if (leftDefault !== null) {
        stmts.push({
          sql: `ALTER TABLE ${q(tName)} ALTER COLUMN ${q(colName)} SET DEFAULT ${leftDefault};`,
          description:
            leftDefault === rightDefault
              ? `Put the default back on "${colName}" in "${tName}" (${leftDefault}) after its type change`
              : `Set default on "${colName}" in "${tName}" to ${leftDefault}`,
          kind: "ALTER_COLUMN_DEFAULT",
          severity: "safe",
          tableName: tName,
          destructive: false,
        });
      }
    } else if (leftDefault !== rightDefault) {
      if (leftDefault === null) {
        stmts.push({
          sql: `ALTER TABLE ${q(tName)} ALTER COLUMN ${q(colName)} DROP DEFAULT;`,
          description: `Drop default on "${colName}" in "${tName}"`,
          kind: "ALTER_COLUMN_DEFAULT",
          severity: "safe",
          tableName: tName,
          destructive: false,
        });
      } else {
        stmts.push({
          sql: `ALTER TABLE ${q(tName)} ALTER COLUMN ${q(colName)} SET DEFAULT ${leftDefault};`,
          description: `Set default on "${colName}" in "${tName}" to ${leftDefault}`,
          kind: "ALTER_COLUMN_DEFAULT",
          severity: "safe",
          tableName: tName,
          destructive: false,
        });
      }
    }

    // The target column is a serial and the source column reads a sequence it
    // does not own. The default above now reads the source's sequence, but the
    // target column still owns its old one, and a column that owns a sequence
    // and has a nextval default is a serial again on the next compare. So the
    // old sequence is let go: dropped when the source has no sequence by that
    // name, and only untied from the column when it does.
    const oldSequence = nextvalSequenceName(rightDefault);
    if (
      rightSerial &&
      !leftSerial &&
      leftIdentity === null &&
      rightIdentity === null &&
      isNextvalDefault(leftDefault) &&
      colMatch.left.sequenceOptions === null &&
      oldSequence !== null
    ) {
      const sourceHasIt =
        sourceSequences === undefined ||
        sourceSequences.some((seq) => seq.name === oldSequence);
      if (sourceHasIt) {
        stmts.push({
          sql: `ALTER SEQUENCE IF EXISTS ${q(oldSequence)} OWNED BY NONE;`,
          description:
            `Untie sequence "${oldSequence}" from "${colName}" in "${tName}": ` +
            "in the source this column reads a sequence it does not own",
          kind: "ALTER_SEQUENCE",
          severity: "safe",
          tableName: tName,
          destructive: false,
        });
      } else {
        stmts.push({
          sql: `DROP SEQUENCE IF EXISTS ${q(oldSequence)};`,
          description:
            `Drop sequence "${oldSequence}": "${colName}" in "${tName}" no longer ` +
            "reads it and the source does not have it",
          kind: "DROP_SEQUENCE",
          severity: "breaking",
          tableName: tName,
          destructive: false,
        });
      }
    }
  }

  // Every type change is written. The computed columns that were waiting for
  // them go in now, ahead of the constraints in section d that may name them.
  stmts.push(...afterTypeChanges);

  // ── d. Constraint diffs ──────────────────────────────────────────────────
  // Drop order: FKs first so we remove the dependency before anything else.
  const toDrop = match.constraintDiffs.filter(
    (d) => d.status === "onlyB" || d.status === "changedDefinition"
  );
  const dropFksFirst = toDrop.filter((d) => d.kind === "FOREIGN KEY");
  const dropRest = toDrop.filter((d) => d.kind !== "FOREIGN KEY");

  for (const diff of [...dropFksFirst, ...dropRest]) {
    const constraintName = diff.rightName ?? "";
    if (!constraintName) continue;
    if (diff.kind === "PRIMARY KEY" || diff.kind === "UNIQUE") {
      for (const entry of dependentsOnKey(match, constraintName, inboundFks)) {
        if (clearedInbound.has(inboundKeyId(entry))) continue;
        clearedInbound.add(inboundKeyId(entry));
        stmts.push(
          dropInboundKeyStatement(
            entry,
            `it depends on ${diff.kind} "${constraintName}" on "${tName}", which is about to go`,
            false
          )
        );
        // Only worth putting back if there will be something to point at: the
        // source has to keep a key over the same columns. When it does not, the
        // reference is gone for good and the description above is the warning.
        if (entry.survives && !entry.handledByOwner && sourceKeepsKeyFor(match, entry.referencedColumnsAfterRename)) {
          fkStmts.push(restoreInboundKeyStatement(entry));
        }
      }
    }
    // name-clashes.ts may have moved the key to a parked name first, so that a
    // key on another table could take this one. The drop follows it there.
    const dropName = parkedKeys.get(constraintName) ?? constraintName;
    stmts.push({
      sql: `ALTER TABLE ${q(tName)} DROP CONSTRAINT IF EXISTS ${q(dropName)};`,
      description:
        `Drop ${diff.kind} "${constraintName}" from "${tName}"` +
        (dropName === constraintName ? "" : ` (now called "${dropName}")`),
      kind: "DROP_CONSTRAINT",
      severity: constraintChangeSeverity(diff.kind, "drop"),
      tableName: tName,
      destructive: false,
    });
  }

  // The old primary key is gone now, so its columns may be made nullable.
  stmts.push(...afterKeyDrops);

  // Add order: non-FKs here; FK ADDs are deferred into fkStmts so they
  // run after every table's ADD COLUMN across ALL matched/created tables.
  const toAdd = match.constraintDiffs.filter(
    (d) => d.status === "onlyA" || d.status === "changedDefinition"
  );
  const addNonFks = toAdd.filter((d) => d.kind !== "FOREIGN KEY");
  const addFks = toAdd.filter((d) => d.kind === "FOREIGN KEY");

  for (const diff of addNonFks) {
    const cName = diff.leftName ?? "";
    if (!cName) continue;
    const found = lookupConstraintDef(match.left, diff.kind, cName);
    if (!found) continue;
    stmts.push({
      sql: onlyIfMissing(
        tableConstraintQuery(tName, found.name),
        `ALTER TABLE ${q(tName)} ADD CONSTRAINT ${q(found.name)} ${found.definition};`
      ),
      description: `Add ${diff.kind} "${found.name}" to "${tName}"`,
      kind: "ADD_CONSTRAINT",
      severity: constraintChangeSeverity(diff.kind, "add"),
      tableName: tName,
      destructive: false,
    });
  }

  for (const diff of addFks) {
    const fkName = diff.leftName ?? "";
    const fk = match.left.foreignKeys.find((f) => f.name === fkName);
    if (!fk) continue;
    fkStmts.push({
      sql: onlyIfMissing(
        tableConstraintQuery(tName, fk.name),
        `ALTER TABLE ${q(tName)} ADD CONSTRAINT ${q(fk.name)} ${buildFkDef(fk, sourceSchema)};`
      ),
      description: `Add FK "${fk.name}" to "${tName}"`,
      kind: "ADD_CONSTRAINT",
      severity: constraintChangeSeverity("FOREIGN KEY", "add"),
      tableName: tName,
      destructive: false,
    });
  }

  // ── e. Drop columns that exist in B but not in A ─────────────────────────
  // Destructive: removes the column and its data. Emitted last (after the
  // constraint drops above) and with CASCADE + IF EXISTS so it never trips over
  // a dependent index/constraint and stays idempotent on re-run.
  for (const col of match.columnsOnlyInB) {
    // Already written, ahead of the type change it stood in the way of.
    if (droppedBeforeTypeChanges.has(col.name)) continue;
    stmts.push(dropColumnOnlyInTarget(col, tName));
  }

  return { stmts, fkStmts };
}
