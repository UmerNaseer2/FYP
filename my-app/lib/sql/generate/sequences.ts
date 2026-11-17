// Sequence statements: options, identity columns, CREATE and ALTER SEQUENCE,
// the sequence behind a column default, and moving a counter past existing rows.

import type { ColumnSnapshot, SequenceOptions, SequenceSnapshot } from "../../postgres";
import { sequenceBoundsComparable } from "../../compare/diff";
import { q } from "./basics";
import { literal, objectStatement } from "./statement-helpers";
import type { SqlStatement } from "./types";

// ── Sequences ──────────────────────────────────────────────────────────────

/**
 * The MAXVALUE a sequence takes when nobody set one, per underlying type.
 *
 * Used to tell a sequence that was configured from one that was merely created:
 * an unknown type is deliberately absent so it reads as "configured" and the
 * options get written out rather than silently dropped.
 */
const SEQUENCE_TYPE_MAX: Record<string, string> = {
  smallint: "32767",
  integer: "2147483647",
  bigint: "9223372036854775807",
};

/**
 * Whether these are the settings a sequence gets when nobody chose any.
 *
 * The point is to keep the common case looking exactly as it always has. A
 * plain `serial` or a plain `GENERATED ALWAYS AS IDENTITY` still generates as
 * `serial` and as a bare IDENTITY, and only a column somebody actually tuned
 * grows a clause. Same reasoning as the range types, which are left out of a
 * CREATE TYPE unless a subtype option was really chosen.
 *
 * A descending sequence (INCREMENT BY -1) fails this on its bounds, which is
 * correct — its settings were chosen and have to be written down.
 */
export function sequenceOptionsAreDefault(options: SequenceOptions): boolean {
  const typeMax = SEQUENCE_TYPE_MAX[options.dataType];
  if (typeMax === undefined) return false;
  return (
    options.startValue === "1" &&
    options.increment === "1" &&
    options.minValue === "1" &&
    options.maxValue === typeMax &&
    options.cacheSize === "1" &&
    !options.cycles
  );
}

/**
 * The sequence options as one line, for the parenthesised list that follows
 * `AS IDENTITY`.
 *
 * No `AS <type>` in this one: inside an identity clause the type comes from the
 * column, and writing it there is a syntax error.
 */
function sequenceOptionsInline(options: SequenceOptions): string {
  return [
    `START WITH ${options.startValue}`,
    `INCREMENT BY ${options.increment}`,
    `MINVALUE ${options.minValue}`,
    `MAXVALUE ${options.maxValue}`,
    `CACHE ${options.cacheSize}`,
    options.cycles ? "CYCLE" : "NO CYCLE",
  ].join(" ");
}

/**
 * ` (START WITH … )` for a column whose sequence was tuned, or "" for one on
 * the defaults — and also for a snapshot taken before the settings were read,
 * where the field is undefined and there is nothing honest to write.
 */
export function identityOptionsSuffix(col: ColumnSnapshot): string {
  const options = col.sequenceOptions;
  if (!options || sequenceOptionsAreDefault(options)) return "";
  return ` (${sequenceOptionsInline(options)})`;
}

/**
 * The sequence a column has to have built for it, or null when it does not need
 * one — either because the `serial` shorthand builds it, or because the sequence
 * is somebody else's to build.
 *
 * The commonest reason the shorthand is not available is tuning: `serial`
 * expands to a sequence on every default, so a column whose sequence starts at
 * 10 and steps by 4 comes out starting at 1 and stepping by 1 — two shards that
 * were handing out interleaved ids quietly start handing out the same ones. The
 * others are in sequencePlanFor. Either way such a column is written the long
 * way instead: CREATE SEQUENCE, the plain type with its nextval default, then
 * ALTER SEQUENCE … OWNED BY, which is byte-for-byte the catalog state `serial`
 * would have produced.
 *
 * Only the column that OWNS the sequence builds it. `sequenceOptions` is put on
 * a column by the snapshot exactly when the catalog says that column owns the
 * sequence, so a column merely reading somebody else's sequence answers null
 * here and just carries its nextval default.
 *
 * The name comes out of the column's own default rather than the schema's
 * sequence list, because an owned sequence is never in the object diffs — it
 * belongs to its column, not to the schema.
 */
function ownedSequenceToBuild(
  col: ColumnSnapshot,
  serialOk: boolean
): { name: string; options: SequenceOptions } | null {
  if (col.identity) return null;
  if (serialOk) return null;
  const options = col.sequenceOptions;
  if (!options) return null;
  const name = nextvalSequenceName(col.columnDefault);
  return name === null ? null : { name, options };
}

// Only STANDALONE sequences reach here: the comparator drops the ones owned by
// a serial or identity column, because those are created by the column itself
// and a CREATE SEQUENCE for them would collide.
function sequenceClauses(sequence: SequenceOptions): string[] {
  return [
    `  AS ${sequence.dataType}`,
    `  INCREMENT BY ${sequence.increment}`,
    `  MINVALUE ${sequence.minValue}`,
    `  MAXVALUE ${sequence.maxValue}`,
    `  START WITH ${sequence.startValue}`,
    `  CACHE ${sequence.cacheSize}`,
    sequence.cycles ? "  CYCLE" : "  NO CYCLE",
  ];
}

export function createSequenceStatement(sequence: SequenceSnapshot): SqlStatement {
  const head = `CREATE SEQUENCE IF NOT EXISTS ${q(sequence.name)}`;
  return objectStatement({
    sql: `${[head, ...sequenceClauses(sequence)].join("\n")};`,
    description: `Create sequence "${sequence.name}"`,
    kind: "CREATE_SEQUENCE",
    tableName: sequence.name,
  });
}

export function alterSequenceStatement(sequence: SequenceSnapshot): SqlStatement {
  return objectStatement({
    sql: `${[`ALTER SEQUENCE ${q(sequence.name)}`, ...sequenceClauses(sequence)].join("\n")};`,
    // START WITH changes where a future RESTART begins, not the value the
    // sequence is currently sitting on. Saying so stops the script from looking
    // like it rewinds a live counter.
    description: `Update sequence "${sequence.name}" bounds (does not move its current value)`,
    kind: "ALTER_SEQUENCE",
    tableName: sequence.name,
  });
}

/**
 * One clause of a sequence reconfiguration.
 *
 * `set` says whether the ALTER TABLE spelling wants SET in front of it: every
 * clause here takes it except RESTART, where `ALTER COLUMN id SET RESTART` is a
 * syntax error and `ALTER COLUMN id RESTART WITH 5000` is the form. The
 * ALTER SEQUENCE spelling takes all of them bare.
 */
// `warning` is kept apart from `description` so the caller can name the
// sequence first and still end the sentence with the warning.
type SequenceStep = { clause: string; set: boolean; description: string; warning?: string };

/**
 * The settings that have to be changed to move a sequence from `target` to
 * `source`, in an order that never leaves it in a state PostgreSQL rejects.
 *
 * The order is widen, then move START, then RESTART, then narrow, and it is the
 * whole reason this is a list rather than one statement. PostgreSQL rechecks
 * the sequence after every step, and all three of these are real answers it
 * gave to the obvious orderings:
 *
 * - "MINVALUE (5000) must be less than MAXVALUE (1000)" — raising the minimum
 *   before widening the maximum.
 * - "START value (1) cannot be less than MINVALUE (10)" — narrowing the
 *   minimum before moving START up to meet it.
 * - "RESTART value (800) cannot be greater than MAXVALUE (500)" — narrowing a
 *   bound past the number the sequence is currently sitting on.
 *
 * That last one is why a narrowing carries a RESTART. There is no way to give a
 * sequence a bound its counter is already outside of, so the counter moves to
 * the source's own START, which is by definition inside the new range. It is
 * the reason narrowing a bound is graded breaking: on a table with rows the
 * counter can move BACKWARDS, and the ids it then hands out are ones the table
 * already has.
 */
export function sequenceOptionSteps(
  source: SequenceOptions,
  target: SequenceOptions
): SequenceStep[] {
  // A bound past what a JavaScript number holds exactly is normal here —
  // MAXVALUE on a bigint sequence is 9223372036854775807 — so the comparison
  // is done in BigInt. A value that will not parse is treated as a widening,
  // which only affects where its clause lands in the list.
  const widens = (from: string, to: string, looser: (a: bigint, b: bigint) => boolean) => {
    try {
      return looser(BigInt(to.trim()), BigInt(from.trim()));
    } catch {
      return true;
    }
  };
  // Bounds are left alone once the underlying type differs: they moved because
  // the column's type did, and ALTER COLUMN ... TYPE has already carried them.
  // Same rule the report reads — see sequenceBoundsComparable.
  const bounds = sequenceBoundsComparable(source, target);
  const minMoved = bounds && source.minValue !== target.minValue;
  const maxMoved = bounds && source.maxValue !== target.maxValue;
  const minWidens = minMoved && widens(target.minValue, source.minValue, (a, b) => a < b);
  const maxWidens = maxMoved && widens(target.maxValue, source.maxValue, (a, b) => a > b);

  const step = (clause: string): SequenceStep => ({
    clause,
    set: true,
    description: `Set ${clause}`,
  });

  const steps: SequenceStep[] = [];
  if (maxWidens) steps.push(step(`MAXVALUE ${source.maxValue}`));
  if (minWidens) steps.push(step(`MINVALUE ${source.minValue}`));
  if (source.startValue !== target.startValue) {
    steps.push(step(`START WITH ${source.startValue}`));
  }
  if ((minMoved && !minWidens) || (maxMoved && !maxWidens)) {
    steps.push({
      clause: `RESTART WITH ${source.startValue}`,
      set: false,
      description: `Move the counter to ${source.startValue}`,
      warning:
        "the narrower bounds below cannot be set while it sits outside them, " +
        "and on a table with rows a counter that moves backwards hands out ids " +
        "the table already has",
    });
  }
  if (minMoved && !minWidens) steps.push(step(`MINVALUE ${source.minValue}`));
  if (maxMoved && !maxWidens) steps.push(step(`MAXVALUE ${source.maxValue}`));
  if (source.increment !== target.increment) {
    steps.push(step(`INCREMENT BY ${source.increment}`));
  }
  if (source.cacheSize !== target.cacheSize) steps.push(step(`CACHE ${source.cacheSize}`));
  if (source.cycles !== target.cycles) {
    steps.push(step(source.cycles ? "CYCLE" : "NO CYCLE"));
  }
  return steps;
}

/**
 * The CREATE SEQUENCE that has to run before a column written the long way
 * exists, and the ALTER SEQUENCE … OWNED BY that has to run after it.
 *
 * Ownership is not decoration: it is what ties the sequence's lifetime to the
 * column's, so dropping the table takes the sequence with it exactly as a plain
 * `serial` would. Without it the schema is left with a loose sequence that no
 * later comparison expects to find.
 *
 * Both lists are empty for every column the `serial` shorthand still covers,
 * and for a column that only reads a sequence somebody else owns — that one
 * carries its nextval default and nothing more.
 */
export function columnSequenceStatements(
  col: ColumnSnapshot,
  tableName: string,
  serialOk: boolean
): { before: SqlStatement[]; after: SqlStatement[] } {
  const tuned = ownedSequenceToBuild(col, serialOk);
  if (tuned === null) return { before: [], after: [] };
  const head = `CREATE SEQUENCE IF NOT EXISTS ${q(tuned.name)}`;
  return {
    before: [
      objectStatement({
        sql: `${[head, ...sequenceClauses(tuned.options)].join("\n")};`,
        description: `Create sequence "${tuned.name}" for "${col.name}" on "${tableName}"`,
        kind: "CREATE_SEQUENCE",
        tableName: tuned.name,
      }),
    ],
    after: [
      {
        sql: `ALTER SEQUENCE ${q(tuned.name)} OWNED BY ${q(tableName)}.${q(col.name)};`,
        description: `Tie sequence "${tuned.name}" to "${col.name}" on "${tableName}"`,
        kind: "ALTER_SEQUENCE",
        severity: "safe",
        tableName,
        destructive: false,
      },
    ],
  };
}

/**
 * The sequence a `nextval('name'::regclass)` default reads from, or null.
 *
 * Defaults are schema-stripped at snapshot time, so the name that comes back is
 * already relative to the target schema.
 */
export function nextvalSequenceName(columnDefault: string | null): string | null {
  if (columnDefault === null) return null;
  const match = /^\s*nextval\s*\(\s*'([^']+)'/i.exec(columnDefault);
  if (!match) return null;
  // pg renders the name quoted only when it needs quoting; strip either form.
  return match[1].replace(/^"(.*)"$/, "$1");
}

/**
 * The statement that moves a column's new sequence past the values its rows
 * already hold.
 *
 * A column that becomes serial or identity on a table that already has rows
 * gets a sequence that starts at 1, so the next insert takes a number a row
 * already has and fails on the primary key. This sets the counter to one past
 * the highest value in the column (one below the lowest, for a sequence that
 * counts down).
 *
 * It only ever moves the counter on. The sequence's own nextval() is one of the
 * candidates, so a sequence that is already further along (it existed before,
 * or the script is running a second time) keeps its place, and a new sequence
 * on an empty table stays on its START: max() of no rows is NULL, which
 * GREATEST skips. `false` makes the next nextval() return that number itself
 * rather than the one after it.
 *
 * `previousSequence` is the sequence the column's default used to read. It can
 * be ahead of max() when the newest rows were deleted, and carrying on from it
 * means those numbers are not handed out a second time. to_regclass turns a
 * sequence that no longer exists into NULL, which nextval passes straight
 * through. nextval is not undone by a rollback, so a dry run leaves that old
 * sequence one number further on: a gap, never a repeat.
 *
 * `serialSequence` is null for an identity column, whose sequence has a name
 * the snapshot never recorded. It is looked up as the one sequence tied to the
 * column as its identity (deptype 'i'). pg_get_serial_sequence would be the
 * obvious call, but a serial turned identity still owns its old sequence, and
 * pg_get_serial_sequence returns whichever of the two it finds first, usually
 * the old one (see the serial fix in lib/performance/advice/serial-fix.ts).
 */
export function counterPastRowsStatement(
  tableName: string,
  columnName: string,
  serialSequence: string | null,
  previousSequence: string | null,
  downwards: boolean
): SqlStatement {
  const sequence =
    serialSequence === null ? "identity_sequence.seq" : literal(q(serialSequence));
  const edge = downwards
    ? `(SELECT min(${q(columnName)}) - 1 FROM ${q(tableName)})`
    : `(SELECT max(${q(columnName)}) + 1 FROM ${q(tableName)})`;
  const candidates = [
    `nextval(${sequence})`,
    ...(previousSequence === null
      ? []
      : [`nextval(to_regclass(${literal(q(previousSequence))}))`]),
    edge,
  ];
  const setval = `SELECT setval(${sequence}, ${downwards ? "LEAST" : "GREATEST"}(${candidates.join(", ")}), false)`;
  return {
    sql:
      serialSequence === null
        ? `${setval}\n  FROM (SELECT d.objid::regclass AS seq FROM pg_depend d ` +
          `JOIN pg_attribute a ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid ` +
          `WHERE d.classid = 'pg_class'::regclass AND d.refclassid = 'pg_class'::regclass ` +
          `AND d.deptype = 'i' AND d.refobjid = to_regclass(${literal(q(tableName))}) ` +
          `AND a.attname = ${literal(columnName)}) AS identity_sequence;`
        : `${setval};`,
    description: `Move the counter behind "${columnName}" in "${tableName}" past the values its rows already hold`,
    kind: "ALTER_SEQUENCE",
    severity: "safe",
    tableName,
    destructive: false,
  };
}

/** Whether a sequence's INCREMENT is negative. Unknown counts as upwards, the default. */
export function countsDown(increment: string | undefined): boolean {
  return increment !== undefined && increment.trim().startsWith("-");
}
