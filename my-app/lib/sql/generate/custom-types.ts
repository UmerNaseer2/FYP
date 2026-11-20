// User-defined type statements (enum, domain, composite, range): create,
// drop, alter, and the order types depend on each other in.

import type { ObjectDiff } from "../../compare/types";
import type { TypeSnapshot } from "../../postgres";
import {
  domainAddedChecks,
  domainDefaultChanged,
  typeChangeIsAllManual,
  domainNotNullTightens,
} from "../../compare/diff";
// The compare engine asks this same question when it decides whether to tell
// the reader a range type has to be created by hand.
import { rangeTypeIsCreatable } from "../../postgres";
import { findByName, q } from "./basics";
import { literal, manualNote, objectStatement, onlyIfMissing } from "./statement-helpers";
import type { SqlStatement } from "./types";

export function createTypeStatement(type: TypeSnapshot): SqlStatement | null {
  // CREATE TYPE and CREATE DOMAIN have no IF NOT EXISTS, so every kind below
  // asks the catalog first (see onlyIfMissing). A domain is a row in pg_type
  // too, so the one lookup serves all four kinds.
  //
  // It reads current_schema(), the schema the CREATE puts the type in, instead
  // of resolving the name. pg_catalog is searched before every other schema, so
  // a type called "line" or "money" would resolve to the built-in one, the
  // lookup would find that, and the source's own type would never be made.
  const typeIsThere =
    `SELECT 1 FROM pg_type WHERE typname = ${literal(type.name)} ` +
    `AND typnamespace = (SELECT oid FROM pg_namespace WHERE nspname = current_schema())`;
  if (type.kind === "ENUM") {
    const labels = type.labels.map((label) => `  ${literal(label)}`).join(",\n");
    return objectStatement({
      sql: onlyIfMissing(typeIsThere, `CREATE TYPE ${q(type.name)} AS ENUM (\n${labels}\n);`),
      description: `Create enum "${type.name}"`,
      kind: "CREATE_TYPE",
      tableName: type.name,
    });
  }
  if (type.kind === "DOMAIN") {
    const parts = [`CREATE DOMAIN ${q(type.name)} AS ${type.baseType ?? "text"}`];
    // DEFAULT goes before NOT NULL so a new column of this domain on a table
    // that already has rows gets the default instead of a refused null.
    if (type.domainDefault) parts.push(`  DEFAULT ${type.domainDefault}`);
    if (type.notNull) parts.push("  NOT NULL");
    for (const check of type.checks) {
      parts.push(`  CONSTRAINT ${q(check.name)} ${check.expression}`);
    }
    return objectStatement({
      sql: onlyIfMissing(typeIsThere, `${parts.join("\n")};`),
      description: `Create domain "${type.name}"`,
      kind: "CREATE_TYPE",
      tableName: type.name,
    });
  }
  if (type.kind === "COMPOSITE") {
    const fields = type.attributes.map((attribute) => `  ${attribute}`).join(",\n");
    return objectStatement({
      sql: onlyIfMissing(typeIsThere, `CREATE TYPE ${q(type.name)} AS (\n${fields}\n);`),
      description: `Create composite type "${type.name}"`,
      kind: "CREATE_TYPE",
      tableName: type.name,
    });
  }
  // Everything left is a range type. It is written out only when the snapshot
  // recorded enough of it — see rangeTypeIsCreatable, which the compare engine
  // asks the same question of so the report and this agree. When it did not,
  // the caller writes a note instead.
  if (!rangeTypeIsCreatable(type)) return null;
  const range = type.rangeDetails;
  if (!range) return null;
  const options = [`subtype = ${type.baseType ?? "text"}`];
  // Only the options that are not the default were recorded, so each one here
  // is something someone chose. Anything missing is PostgreSQL's own choice,
  // which it will make again.
  if (range.subtypeOpclass !== null) {
    options.push(`subtype_opclass = ${q(range.subtypeOpclass)}`);
  }
  if (range.collation !== null) options.push(`collation = ${q(range.collation)}`);
  if (range.subtypeDiff !== null) options.push(`subtype_diff = ${range.subtypeDiff}`);
  if (range.multirangeName !== null) {
    options.push(`multirange_type_name = ${q(range.multirangeName)}`);
  }
  return objectStatement({
    sql: onlyIfMissing(
      typeIsThere,
      `CREATE TYPE ${q(type.name)} AS RANGE (${options.join(", ")});`
    ),
    description: `Create range type "${type.name}"`,
    kind: "CREATE_TYPE",
    tableName: type.name,
  });
}

/** The diff kinds that describe a type in pg_type, as the compare engine names them. */
const TYPE_DIFF_KINDS = new Set<string>(["ENUM", "DOMAIN", "COMPOSITE TYPE", "RANGE TYPE"]);

/**
 * The names a type is built from: a domain's base type, a range's subtype and
 * each composite field's type.
 *
 * Read as identifier tokens rather than parsed, because format_type spells
 * them every way there is: `mood[]`, `"Mood"`, `character varying(20)`. A word
 * that only looks like one of the schema's type names ("time" in
 * `time with time zone`) can at worst ask for an order nothing needed.
 */
function typeNamesUsedBy(type: TypeSnapshot): Set<string> {
  const parts = type.baseType === null ? [] : [type.baseType];
  for (const attribute of type.attributes) {
    // "field type": drop the field's own name, which is not a type.
    parts.push(attribute.replace(/^("(?:[^"]|"")*"|\S+)\s+/, ""));
  }
  const names = new Set<string>();
  for (const part of parts) {
    for (const match of part.matchAll(/"((?:[^"]|"")*)"|([A-Za-z_][A-Za-z0-9_$]*)/g)) {
      // format_type leaves a name unquoted only when it is already lower case.
      names.add(match[1] !== undefined ? match[1].replace(/""/g, '"') : match[2].toLowerCase());
    }
  }
  return names;
}

/**
 * `diffs` in an order where each type comes after the types it is built from,
 * or with `dependentsFirst`, after the types built from it. Otherwise the order
 * they arrived in. A loop (which PostgreSQL itself would refuse) is broken
 * wherever it is found rather than reported.
 */
function typesInDependencyOrder(
  diffs: ObjectDiff[],
  types: TypeSnapshot[] | undefined,
  dependentsFirst: boolean
): ObjectDiff[] {
  // By position, not by name, so that every diff comes out exactly once.
  const indexByName = new Map<string, number>();
  diffs.forEach((diff, index) => {
    if (!indexByName.has(diff.name)) indexByName.set(diff.name, index);
  });
  const mustComeFirst: number[][] = diffs.map(() => []);
  diffs.forEach((diff, index) => {
    const type = findByName(types, diff.name);
    if (!type) return;
    for (const used of typeNamesUsedBy(type)) {
      const other = indexByName.get(used);
      if (other === undefined || other === index) continue;
      if (dependentsFirst) mustComeFirst[other].push(index);
      else mustComeFirst[index].push(other);
    }
  });

  const ordered: ObjectDiff[] = [];
  const placed = new Set<number>();
  const visiting = new Set<number>();
  function place(index: number): void {
    if (placed.has(index) || visiting.has(index)) return;
    visiting.add(index);
    for (const first of mustComeFirst[index]) place(first);
    visiting.delete(index);
    placed.add(index);
    ordered.push(diffs[index]);
  }
  diffs.forEach((_, index) => place(index));
  return ordered;
}

/**
 * The comparison's diffs with the type diffs among them reordered so each
 * statement can run when it is reached.
 *
 * The comparison sorts its diffs by kind and then by name, so every composite
 * type came before every domain, and every domain before every enum and range.
 * CREATE DOMAIN, CREATE TYPE ... AS (...) and CREATE TYPE ... AS RANGE all need
 * the types they name to exist already, so a new domain over a new enum was
 * created first, and the migration stopped on `type "mood" does not exist`.
 * Drops need the mirror image: DROP TYPE carries no CASCADE, so a type can go
 * only once nothing built on it is left, or the rollback stops instead.
 *
 * Only the type diffs move, and only into places type diffs already held, so
 * everything else keeps its order.
 */
export function withTypesInDependencyOrder(
  diffs: ObjectDiff[],
  sourceTypes: TypeSnapshot[] | undefined,
  targetTypes: TypeSnapshot[] | undefined
): ObjectDiff[] {
  const isType = (diff: ObjectDiff) => TYPE_DIFF_KINDS.has(diff.kind);
  // What gets created or changed is read off the source, what gets dropped off
  // the target. The two lists go to different phases, so they sort separately.
  const queue = [
    ...typesInDependencyOrder(
      diffs.filter((diff) => isType(diff) && diff.status !== "onlyB"),
      sourceTypes,
      false
    ),
    ...typesInDependencyOrder(
      diffs.filter((diff) => isType(diff) && diff.status === "onlyB"),
      targetTypes,
      true
    ),
  ];
  let next = 0;
  return diffs.map((diff) => (isType(diff) ? queue[next++] : diff));
}

export function dropTypeStatement(type: TypeSnapshot): SqlStatement {
  const isDomain = type.kind === "DOMAIN";
  return objectStatement({
    sql: `DROP ${isDomain ? "DOMAIN" : "TYPE"} IF EXISTS ${q(type.name)};`,
    description: `Drop ${isDomain ? "domain" : "type"} "${type.name}" — WARNING: fails while any column still uses it`,
    kind: "DROP_TYPE",
    severity: "breaking",
    tableName: type.name,
  });
}

/**
 * Bring an existing type in line with the source.
 *
 * Enums are the case worth handling properly, because adding a value is both
 * common and genuinely supported. Everything else PostgreSQL cannot express as
 * an in-place ALTER is written out as a MANUAL note rather than guessed at.
 */
export function alterTypeStatements(left: TypeSnapshot, right: TypeSnapshot): SqlStatement[] {
  const stmts: SqlStatement[] = [];

  // Whether any of this can be run at all is the compare engine's call, and the
  // report card reads the same answer off the diff — so "has to be replaced by
  // hand" on screen and a script that runs nothing are one decision. Everything
  // below the gate writes the statements for the cases it calls scriptable; the
  // notes are what the gate itself hands back.
  if (typeChangeIsAllManual(left, right)) {
    if (left.kind !== right.kind) {
      return [
        manualNote(
          `"${left.name}" is a ${left.kind.toLowerCase()} in the source and a ` +
            `${right.kind.toLowerCase()} in the target. Changing one into the other means ` +
            `dropping it, which fails while any column still uses it. Migrate the columns first.`,
          `"${left.name}" changed type category — needs manual work`,
          left.name
        ),
      ];
    }

    if (left.kind === "ENUM") {
      const leftLabels = new Set(left.labels);
      const removed = right.labels.filter((label) => !leftLabels.has(label));
      if (removed.length > 0) {
        return [
          manualNote(
            `enum "${left.name}" has ${removed.length} value${removed.length === 1 ? "" : "s"} ` +
              `the source does not (${removed.map(literal).join(", ")}). PostgreSQL cannot drop ` +
              `an enum value — recreate the type and repoint every column that uses it, or leave ` +
              `the extra value${removed.length === 1 ? "" : "s"} in place.`,
            `Enum "${left.name}" has values that cannot be dropped`,
            left.name
          ),
        ];
      }
      // Same labels, different order. Postgres compares enum values by their
      // stored order, so this changes how the data sorts.
      return [
        manualNote(
          `enum "${left.name}" has the same values in a different order. Postgres sorts by ` +
            `that order, so this changes comparison results. Reordering needs the type to be ` +
            `recreated.`,
          `Enum "${left.name}" values are in a different order`,
          left.name
        ),
      ];
    }

    return [
      manualNote(
        `"${left.name}" differs. Source: ${left.definition}. Target: ${right.definition}. ` +
          `Altering it in place needs the columns that use it handled first.`,
        `"${left.name}" changed and needs manual work`,
        left.name
      ),
    ];
  }

  // Past the gate the kinds match and there is something to run, so only the
  // scriptable halves of each kind are written from here down.
  if (left.kind === "ENUM") {
    const rightLabels = new Set(right.labels);
    const added = left.labels.filter((label) => !rightLabels.has(label));
    const leftLabels = new Set(left.labels);
    const removed = right.labels.filter((label) => !leftLabels.has(label));

    for (const label of added) {
      // Where the label goes, not just that it arrives. ADD VALUE with no
      // neighbour appends, and PostgreSQL sorts an enum by the order its labels
      // were added — so adding 'medium' to ('low','high') used to leave the
      // target sorting low, high, medium while the source sorted low, medium,
      // high. Nothing was missing, so the next comparison could only report it
      // as "same values, different order", which needs the type recreated: a
      // manual note that never went away.
      //
      // The anchor is the next label after this one in the SOURCE that the
      // target already has, so it is guaranteed to exist by the time the
      // statement runs. Labels are added in source order, so two new labels
      // sharing an anchor land in front of it in that same order.
      const anchor = labelAfter(left.labels, label, rightLabels);
      const position = anchor === null ? "" : ` BEFORE ${literal(anchor)}`;
      stmts.push(
        objectStatement({
          sql: `ALTER TYPE ${q(left.name)} ADD VALUE IF NOT EXISTS ${literal(label)}${position};`,
          description:
            `Add value ${literal(label)} to enum "${left.name}"` +
            (anchor === null ? "" : ` before ${literal(anchor)}`),
          kind: "ALTER_TYPE",
          tableName: left.name,
        })
      );
    }
    if (removed.length > 0) {
      stmts.push(
        manualNote(
          `enum "${left.name}" has ${removed.length} value${removed.length === 1 ? "" : "s"} ` +
            `the source does not (${removed.map(literal).join(", ")}). PostgreSQL cannot drop ` +
            `an enum value — recreate the type and repoint every column that uses it, or leave ` +
            `the extra value${removed.length === 1 ? "" : "s"} in place.`,
          `Enum "${left.name}" has values that cannot be dropped`,
          left.name
        )
      );
    }
    // A reorder — same labels, different order — never reaches here: ADD VALUE
    // is the only enum ALTER, so it has nothing to run and the gate above
    // returned its note.
    return stmts;
  }

  // A domain can be altered in place as long as its base type is unchanged:
  // NOT NULL is a direct ALTER, and checks are dropped and added by name. The
  // base type is the one thing ALTER DOMAIN cannot change, so that still falls
  // through to the manual note below.
  if (left.kind === "DOMAIN" && left.baseType === right.baseType) {
    // The two tests below are the compare engine's, not a second copy of them:
    // domainChangeSeverity grades a changed domain "breaking" out of exactly
    // these, so the pill on the report and the warning on the statement cannot
    // drift. (They used to: the report graded every changed type "info" while
    // the script marked the SET NOT NULL below breaking.)
    if (domainDefaultChanged(left, right)) {
      const wanted = left.domainDefault ?? null;
      stmts.push(
        objectStatement({
          sql:
            wanted === null
              ? `ALTER DOMAIN ${q(left.name)} DROP DEFAULT;`
              : `ALTER DOMAIN ${q(left.name)} SET DEFAULT ${wanted};`,
          description:
            wanted === null
              ? `Remove the default of domain "${left.name}"`
              : `Set the default of domain "${left.name}" to ${wanted}`,
          kind: "ALTER_TYPE",
          tableName: left.name,
        })
      );
    }
    if (left.notNull !== right.notNull) {
      const tightens = domainNotNullTightens(left, right);
      stmts.push(
        objectStatement({
          sql: tightens
            ? `ALTER DOMAIN ${q(left.name)} SET NOT NULL;`
            : `ALTER DOMAIN ${q(left.name)} DROP NOT NULL;`,
          description: tightens
            ? `Make domain "${left.name}" NOT NULL — WARNING: fails if any column using it holds a null`
            : `Allow nulls in domain "${left.name}"`,
          kind: "ALTER_TYPE",
          severity: tightens ? "breaking" : "safe",
          tableName: left.name,
        })
      );
    }

    // Match checks by name. A check whose name is the same but whose expression
    // changed has to be dropped and re-added: ALTER DOMAIN has no "replace".
    const leftChecks = new Map(left.checks.map((check) => [check.name, check]));

    for (const check of right.checks) {
      const source = leftChecks.get(check.name);
      if (source && source.expression === check.expression) continue;
      stmts.push(
        objectStatement({
          sql: `ALTER DOMAIN ${q(left.name)} DROP CONSTRAINT IF EXISTS ${q(check.name)};`,
          description: `Remove check "${check.name}" from domain "${left.name}"`,
          kind: "ALTER_TYPE",
          severity: "safe",
          tableName: left.name,
        })
      );
    }

    for (const check of domainAddedChecks(left, right)) {
      stmts.push(
        objectStatement({
          sql: onlyIfMissing(
            `SELECT 1 FROM pg_constraint WHERE contypid = to_regtype(${literal(q(left.name))}) ` +
              `AND conname = ${literal(check.name)}`,
            `ALTER DOMAIN ${q(left.name)} ADD CONSTRAINT ${q(check.name)} ${check.expression};`
          ),
          description:
            `Add check "${check.name}" to domain "${left.name}" — WARNING: fails if any ` +
            `existing value breaks it`,
          kind: "ALTER_TYPE",
          severity: "breaking",
          tableName: left.name,
        })
      );
    }

    if (stmts.length > 0) return stmts;
  }

  // Unreachable while this function and typeChangeIsAllManual agree: every case
  // that gets here is one the gate calls all-manual. Kept as the safety net,
  // because the failure it catches is the worst one this generator can produce — a
  // changed type that generates NOTHING, on a report that says it changed.
  return [
    manualNote(
      `"${left.name}" differs. Source: ${left.definition}. Target: ${right.definition}. ` +
        `Altering it in place needs the columns that use it handled first.`,
      `"${left.name}" changed and needs manual work`,
      left.name
    ),
  ];
}

/**
 * The first label after `label` in the source that the target already has, or
 * null when there is none — which means the label belongs at the end and a
 * plain ADD VALUE puts it there.
 */
function labelAfter(
  sourceLabels: string[],
  label: string,
  targetLabels: Set<string>
): string | null {
  const from = sourceLabels.indexOf(label);
  if (from === -1) return null;
  for (const candidate of sourceLabels.slice(from + 1)) {
    if (targetLabels.has(candidate)) return candidate;
  }
  return null;
}
