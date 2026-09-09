import type {
  CollationSnapshot,
  ColumnSnapshot,
  ExtensionSnapshot,
  ConstraintSnapshot,
  ForeignKeySnapshot,
  IndexSnapshot,
  PrivilegeSnapshot,
  RoutineSnapshot,
  RowSecuritySnapshot,
  SchemaSnapshot,
  SequenceOptions,
  SequenceSnapshot,
  TablePartitioning,
  TableSnapshot,
  TriggerSnapshot,
  TypeSnapshot,
  ViewSnapshot,
} from "./postgres";

// The one question "can this range type be written out as a statement" is
// asked once, so the sentence on screen and the SQL underneath cannot disagree.
// It comes from snapshot-facts, not postgres: this module is imported by the
// diff components, and a value import from postgres would put `pg` in the
// browser bundle.
import { rangeTypeIsCreatable } from "./snapshot-facts";

import type {
  ChangeSeverity,
  ColumnChange,
  ColumnMatch,
  ComparedObjectCategories,
  NotComparedReason,
  ObjectCategoryKey,
  CompareReport,
  ConstraintDiff,
  MatchCandidate,
  ObjectDiff,
  ObjectKind,
  ScoreBreakdown,
  TableMatch,
} from "./compare-types";

import {
  multisetSimilarity,
  normalizeIdentifier,
  normalizeSimilarityText,
  roundScore,
  setSimilarity,
  stringSimilarity,
} from "./compare-utils";

// Re-export everything the UI imports from this module
export type {
  ColumnMatch,
  ComparedObjectCategories,
  NotComparedReason,
  ObjectCategoryKey,
  CompareReport,
  ConstraintDiff,
  MatchCandidate,
  ObjectDiff,
  ObjectKind,
  ScoreBreakdown,
  TableMatch,
} from "./compare-types";

// ============================================================================
// Scoring configuration
// ============================================================================
// Tune these weights to change how much each signal contributes to the final
// match score. Change a number, save, re-run the comparison — done.
//
// Table scoring targets a 0–100 scale. Column scoring targets a 0–60 scale.
// The column thresholds are expressed in the same raw units as the column
// weights below (so at defaults, a column match of 50/60 ≈ 83% is "accepted").
// The table thresholds are in the normalised 0–100 space.

const WEIGHTS = {
  // --- Column pair scoring (default total: 60) -----------------------------
  // How strongly each signal counts when matching one column against another.
  column: {
    name: 15,         // How similar the column names are (Levenshtein).
    type: 20,         // Same type? Same family? Completely different?
    constraints: 15,  // Nullable, PK, unique, FK participation flags.
    order: 10,        // Relative position within the table.
  },
  // --- Table pair scoring (default total: 100) -----------------------------
  // How strongly each signal counts when matching one table against another.
  // The final table score is always normalised to 0–100 regardless of which
  // dimensions contribute (see `compareTablePair` for the isolated-table case).
  table: {
    name: 20,           // Table name similarity.
    constraints: 15,    // PK / unique / FK / check / exclude overlap.
    columns: 55,        // Average best-match across columns.
    relationships: 10,  // Position in the FK graph — incoming + outgoing refs.
  },
  // --- Column-level constraint flags (points contributed out of the total) -
  // Each flag that matches between two columns contributes these points.
  columnConstraint: {
    nullable: 5,
    primaryKey: 5,
    unique: 2.5,
    foreignKey: 2.5,
  },
  // --- Type similarity ratio (multiplied by column.type weight) ------------
  // Returned by typeSimilarityRatio; typeScore scales it by column.type.
  typeSimilarity: {
    exact: 1.0,      // varchar(100) vs varchar(100)
    sameBase: 0.6,   // varchar(100) vs varchar(200) — same base, diff size
    different: 0.0,  // integer vs text
  },
} as const;

// --- Match thresholds -------------------------------------------------------
// A pair scoring at or above the accept threshold is a confident match.
// Between accept and possible, it shows up as a rename candidate for review.
// Below possible, it's ignored.
const TABLE_MATCH_ACCEPT_THRESHOLD = 70;
const TABLE_MATCH_POSSIBLE_THRESHOLD = 55;
const COLUMN_MATCH_ACCEPT_THRESHOLD = 50;
const COLUMN_MATCH_POSSIBLE_THRESHOLD = 40;

// Minimum table-name similarity required to AUTO-ACCEPT a non-exact table match.
// Structural signals alone (columns 55 + constraints 15) can clear the 70-point
// accept threshold with near-zero name similarity, which auto-emitted a false
// `ALTER TABLE … RENAME TO` for two unrelated tables (issue #7). Below the floor a
// structurally-similar pair is demoted to a review candidate instead of an
// automatic rename. NOTE: stringSimilarity is edit-distance (Levenshtein) based,
// so an affix rename (users → application_users) scores far below this even though
// it's a real rename — tableNameRenameGuard handles that via substring containment.
const TABLE_NAME_SIMILARITY_FLOOR = 0.3;

// Guard deciding whether a structurally-matched table pair may be AUTO-ACCEPTED as
// a rename. Passes when the names are edit-distance-similar OR when one name is a
// non-trivial substring of the other (affix rename). Failing pairs are surfaced as
// review candidates instead of being auto-renamed OR silently dropped to
// create+drop — the latter would be destructive data loss on apply.
function tableNameRenameGuard(a: string, b: string): boolean {
  const na = normalizeSimilarityText(a);
  const nb = normalizeSimilarityText(b);
  const shorter = na.length <= nb.length ? na : nb;
  const longer = na.length <= nb.length ? nb : na;
  if (shorter.length >= 4 && longer.includes(shorter)) return true;
  return stringSimilarity(a, b) >= TABLE_NAME_SIMILARITY_FLOOR;
}

// --- Derived totals (computed once, reused everywhere) ----------------------
// Changing a weight above automatically updates these.
const COLUMN_TOTAL_WEIGHT =
  WEIGHTS.column.name +
  WEIGHTS.column.type +
  WEIGHTS.column.constraints +
  WEIGHTS.column.order;

const COLUMN_CONSTRAINT_TOTAL_POINTS =
  WEIGHTS.columnConstraint.nullable +
  WEIGHTS.columnConstraint.primaryKey +
  WEIGHTS.columnConstraint.unique +
  WEIGHTS.columnConstraint.foreignKey;

// ============================================================================
// Internal-only types
// ============================================================================

type ColumnConstraintState = {
  nullable: boolean;
  primaryKey: boolean;
  uniqueCount: number;
  foreignKeyCount: number;
};

type ConstraintLike = ConstraintSnapshot | ForeignKeySnapshot;

type IncomingForeignKey = {
  referringTable: string;
  columns: string[];
  referencedColumns: string[];
};

type IncomingForeignKeyMap = Map<string, IncomingForeignKey[]>;

// ============================================================================
// Type comparison
// ============================================================================

function normalizeType(typeDisplay: string): string {
  return normalizeSimilarityText(typeDisplay);
}

// Pulls out just the base type name, stripping any size or precision in parentheses.
// Examples:
//   "character varying(100)"  →  "character varying"
//   "numeric(10,2)"           →  "numeric"
//   "integer"                 →  "integer"
export function extractBaseType(typeDisplay: string): string {
  const normalized = normalizeType(typeDisplay);
  const parenIndex = normalized.indexOf("(");
  if (parenIndex === -1) return normalized;
  return normalized.slice(0, parenIndex).trim();
}

// Pulls the numeric size/precision parameters out of a type display.
//   "character varying(100)" → [100]
//   "numeric(10,2)"          → [10, 2]
//   "integer"                → null   (no size)
export function typeSizeParams(typeDisplay: string): number[] | null {
  const match = typeDisplay.match(/\(([^)]+)\)/);
  if (!match) return null;
  const parts = match[1].split(",").map((p) => Number.parseInt(p.trim(), 10));
  return parts.every((n) => Number.isFinite(n)) ? parts : null;
}

// True when changing a column FROM `currentType` TO `newType` REDUCES its
// capacity — a smaller length/precision/scale, or going from unbounded to
// bounded. Such a change can fail at runtime ("value too long" / "numeric field
// overflow") or truncate data, so callers treat it as breaking, unlike a
// widening which is safe. Only meaningful when both share a base type
// (varchar→varchar, numeric→numeric); a genuine cross-type change is handled
// separately and returns false here.
export function isNarrowingType(currentType: string, newType: string): boolean {
  if (extractBaseType(currentType) !== extractBaseType(newType)) return false;

  const current = typeSizeParams(currentType);
  const next = typeSizeParams(newType);

  if (current && next) {
    // numeric/decimal: (precision, scale). Narrowing if it reduces the
    // fractional scale OR the whole-number capacity (precision − scale) — e.g.
    // numeric(10,2) → numeric(10,4) keeps precision 10 but drops integer digits
    // from 8 to 6, which can overflow existing values.
    if (current.length === 2 && next.length === 2) {
      const currentIntDigits = current[0] - current[1];
      const nextIntDigits = next[0] - next[1];
      return next[1] < current[1] || nextIntDigits < currentIntDigits;
    }
    // single-parameter types (varchar/char/bit length): narrowing if shorter.
    return (next[0] ?? 0) < (current[0] ?? 0);
  }

  // current bounded → new unbounded  = widening (safe)
  // current unbounded → new bounded  = narrowing (constrains existing data)
  if (current && !next) return false;
  if (!current && next) return true;
  return false;
}

// Returns how similar two PostgreSQL column types are as a 0–1 ratio.
// Giving partial credit for same-family types avoids flagging a
// varchar(100)→varchar(200) change the same way as an integer→text change,
// which is far more serious.
function typeSimilarityRatio(
  leftTypeDisplay: string,
  rightTypeDisplay: string
): number {
  const leftNorm  = normalizeType(leftTypeDisplay);
  const rightNorm = normalizeType(rightTypeDisplay);

  if (leftNorm === rightNorm) return WEIGHTS.typeSimilarity.exact;

  const leftBase  = extractBaseType(leftNorm);
  const rightBase = extractBaseType(rightNorm);

  if (leftBase === rightBase) return WEIGHTS.typeSimilarity.sameBase;

  return WEIGHTS.typeSimilarity.different;
}

// Scores how similar two PostgreSQL column types are, scaled to the
// `column.type` weight. At default weights this returns 20 / 12 / 0.
export function typeScore(leftTypeDisplay: string, rightTypeDisplay: string): number {
  return typeSimilarityRatio(leftTypeDisplay, rightTypeDisplay) * WEIGHTS.column.type;
}

// Builds a human-readable message describing a type difference.
// Tells the user whether it was a genuine type change or just a size/precision tweak.
//   "Type changed: integer → text"
//   "Size/precision changed: character varying(100) → character varying(200)"
export function typeChangeDescription(
  leftTypeDisplay: string,
  rightTypeDisplay: string
): string {
  const leftBase  = extractBaseType(leftTypeDisplay);
  const rightBase = extractBaseType(rightTypeDisplay);

  if (leftBase === rightBase) {
    return `Size/precision changed: ${leftTypeDisplay} → ${rightTypeDisplay}`;
  }
  return `Type changed: ${leftTypeDisplay} → ${rightTypeDisplay}`;
}

// ============================================================================
// Constraint signature helpers
// ============================================================================

function columnsAsOrderedSignature(columns: string[]): string {
  return columns.map((column) => normalizeIdentifier(column)).join("|");
}

function columnsAsSetSignature(columns: string[]): string {
  return [...columns].map((column) => normalizeIdentifier(column)).sort().join("|");
}

function uniqueConstraintSignature(constraint: ConstraintSnapshot): string {
  return columnsAsSetSignature(constraint.columns);
}

function primaryKeySignature(constraint: ConstraintSnapshot | null): string {
  return constraint ? columnsAsOrderedSignature(constraint.columns) : "";
}

// A foreign key that references a table in ITS OWN schema is logically the same
// FK no matter which schema the pair lives in. But `referencedSchema` carries the
// literal schema name (e.g. "dev" vs "staging"), so an intra-schema FK compared
// across two differently-named schemas would look "changed" purely because of the
// schema label (issue #8). Collapse a self-schema reference to a "<self>" sentinel
// so those FKs compare equal, while genuine cross-schema references (to a third
// schema) keep their real name and still compare honestly.
function foreignKeyLogicalSignature(
  foreignKey: ForeignKeySnapshot,
  ownSchema: string
): string {
  const referenced = normalizeIdentifier(foreignKey.referencedSchema ?? "");
  // Sentinel for "references its own schema". The surrounding spaces make it
  // impossible to collide with any real schema name: normalizeIdentifier() trims
  // every referencedSchema, so no trimmed identifier can equal " self " — unlike
  // the earlier "<self>", which is itself a legal (quoted) schema name.
  const relativeSchema =
    referenced.length > 0 && referenced === normalizeIdentifier(ownSchema)
      ? " self "
      : referenced;
  return [
    columnsAsOrderedSignature(foreignKey.columns),
    relativeSchema,
    normalizeIdentifier(foreignKey.referencedTable ?? ""),
    columnsAsOrderedSignature(foreignKey.referencedColumns),
    normalizeIdentifier(foreignKey.onUpdate),
    normalizeIdentifier(foreignKey.onDelete),
  ].join("->");
}

// The stored `normalizedDefinition` for an FK comes from pg_get_constraintdef,
// which schema-qualifies the referenced table (e.g. "REFERENCES dev.author(id)").
// For a self-schema FK that qualifier is just the owning schema's name and makes
// two logically identical FKs differ across schemas — so strip it. Cross-schema
// references keep their qualifier.
function schemaRelativeFkDefinition(
  foreignKey: ForeignKeySnapshot,
  ownSchema: string
): string {
  const ref = foreignKey.referencedSchema;
  if (!ref || normalizeIdentifier(ref) !== normalizeIdentifier(ownSchema)) {
    return foreignKey.normalizedDefinition;
  }
  // Strip ONLY the qualifier that directly follows the REFERENCES keyword, so we
  // can never mangle a table/column name elsewhere in the definition that happens
  // to contain the schema name. Handle both quoted and unquoted forms; pg doubles
  // embedded quotes when it renders a quoted identifier, so quote-double first.
  const unquoted = ref.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const quoted = ref.replace(/"/g, '""').replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return foreignKey.normalizedDefinition
    .replace(new RegExp(`(REFERENCES\\s+)"${quoted}"\\.`, "gi"), "$1")
    .replace(new RegExp(`(REFERENCES\\s+)${unquoted}\\.`, "gi"), "$1");
}

function definitionSignature(constraint: ConstraintSnapshot): string {
  return constraint.normalizedDefinition;
}

// ============================================================================
// Column scoring
// ============================================================================

function getColumnState(
  table: TableSnapshot,
  column: ColumnSnapshot
): ColumnConstraintState {
  return {
    nullable: column.nullable,
    primaryKey: column.isPrimaryKey,
    uniqueCount: column.uniqueConstraintNames.length,
    foreignKeyCount: column.foreignKeyConstraintNames.length,
  };
}

function columnConstraintSimilarity(
  leftTable: TableSnapshot,
  leftColumn: ColumnSnapshot,
  rightTable: TableSnapshot,
  rightColumn: ColumnSnapshot
): number {
  const left = getColumnState(leftTable, leftColumn);
  const right = getColumnState(rightTable, rightColumn);
  let points = 0;

  if (left.nullable === right.nullable)                                        points += WEIGHTS.columnConstraint.nullable;
  if (left.primaryKey === right.primaryKey)                                    points += WEIGHTS.columnConstraint.primaryKey;
  if (Math.sign(left.uniqueCount) === Math.sign(right.uniqueCount))            points += WEIGHTS.columnConstraint.unique;
  if (Math.sign(left.foreignKeyCount) === Math.sign(right.foreignKeyCount))    points += WEIGHTS.columnConstraint.foreignKey;

  return COLUMN_CONSTRAINT_TOTAL_POINTS === 0 ? 1 : points / COLUMN_CONSTRAINT_TOTAL_POINTS;
}

function columnOrderSimilarity(
  leftTable: TableSnapshot,
  leftColumn: ColumnSnapshot,
  rightTable: TableSnapshot,
  rightColumn: ColumnSnapshot
): number {
  // We compare where each column sits as a fraction of its table's total column count,
  // not the raw position number. This is the key improvement over the old approach.
  //
  // Old approach (absolute): if you insert a new column at position 2 in table B,
  // every column after it shifts by +1, so they ALL get penalised for "wrong position"
  // even though they didn't actually move relative to the rest of the table.
  //
  // New approach (relative): "email" as the last column in a 3-col table (ratio 1.0)
  // vs "email" as the last column in a 4-col table (ratio 1.0) → diff = 0, no penalty.
  //
  // Multiplying by 2 means: a shift of half the table's width scores 0.
  // Small shifts (neighbour columns) score close to 1.
  const leftRatio  = leftColumn.ordinalPosition / Math.max(leftTable.columns.length, 1);
  const rightRatio = rightColumn.ordinalPosition / Math.max(rightTable.columns.length, 1);
  const diff = Math.abs(leftRatio - rightRatio);
  return Math.max(0, 1 - diff * 2);
}

// A serial/identity column's default is `nextval('<schema>.<seq>'::regclass)`.
// The sequence name embeds the schema, so it differs across two schemas being
// compared even when the columns are logically identical — comparing it would
// manufacture false "default changed" noise. Such columns are excluded from the
// default diff (their identity is reproduced via GENERATED ... AS IDENTITY).
function isNextvalDefault(defaultValue: string | null): boolean {
  return defaultValue !== null && /^\s*nextval\s*\(/i.test(defaultValue);
}

/**
 * How a column produces its own values — "serial", an IDENTITY clause, "none" —
 * or null when the snapshot did not record enough to say.
 *
 * A column can generate its own ids two ways, and they look nothing alike in
 * the catalog: a serial has a nextval default and no identity marker, while an
 * identity column has a marker and no default at all. Comparing the default
 * alone made serial-versus-identity read as "default removed", which is not
 * something any migration statement could ever fix.
 *
 * `identity: undefined` means the snapshot predates the field, so it cannot
 * rule identity out. A nextval default still proves serial in that case; the
 * absence of one proves nothing, hence null.
 */
function describeGenerated(column: ColumnSnapshot): string | null {
  if (column.identity === undefined) {
    return isNextvalDefault(column.columnDefault) ? "serial" : null;
  }
  if (column.identity) return `GENERATED ${column.identity} AS IDENTITY`;
  return isNextvalDefault(column.columnDefault) ? "serial" : "none";
}

/**
 * True when the column's value comes from a sequence, an identity clause or a
 * generation expression — anything but a plain DEFAULT, in other words.
 *
 * Used to suppress the default line. A computed column has no default at all
 * (the expression is moved out of columnDefault at capture), so without this a
 * table where one side computes a column and the other stores it would report
 * "Default changed from none to …" on top of the real change.
 */
function isGeneratedColumn(column: ColumnSnapshot): boolean {
  return (
    Boolean(column.identity) ||
    Boolean(column.generated) ||
    isNextvalDefault(column.columnDefault)
  );
}

/**
 * The GENERATED ALWAYS AS (…) clause as one comparable string, or null when the
 * snapshot predates the field and so cannot say whether there is one.
 *
 * Both the expression and the storage word are in it: STORED and VIRTUAL are
 * different columns as far as DDL is concerned, and swapping one for the other
 * needs the same drop-and-recreate a changed expression does.
 */
export function describeComputed(column: ColumnSnapshot): string | null {
  if (column.generated === undefined) return null;
  if (!column.generated) return "none";
  return `GENERATED ALWAYS AS (${column.generated.expression}) ${column.generated.storage}`;
}

// ---------------------------------------------------------------------------
// Change severity — one rule per kind of change, used by everyone
//
// These four functions are the ONLY place a change is graded. The migration
// generator imports them for the statements it writes, and the compare engine
// stamps the same answer onto every ColumnChange it reports, so the pill in the
// report and the warning on the script are the same decision rather than two
// implementations that happen to agree. Before this, the report re-derived
// severity by string-matching the generator's wording, and rewording a message
// was enough to silently mis-colour it.
//
// The direction matters and is easy to get backwards: a comparison reads
// source → target, but the migration rewrites the TARGET to match the SOURCE.
// So "source is NOT NULL" is what produces a SET NOT NULL, and that is the
// dangerous direction — not the one the sentence appears to describe.
// ---------------------------------------------------------------------------

/**
 * Changing a column's type. A different base type needs a cast that can fail on
 * real values; a smaller size in the same family is refused outright if any
 * stored value no longer fits. Growing a size is the one safe case.
 */
export function typeChangeSeverity(
  sourceTypeDisplay: string,
  targetTypeDisplay: string
): ChangeSeverity {
  if (extractBaseType(sourceTypeDisplay) !== extractBaseType(targetTypeDisplay)) {
    return "breaking";
  }
  return isNarrowingType(targetTypeDisplay, sourceTypeDisplay) ? "breaking" : "safe";
}

/**
 * Changing a column's nullability. SET NOT NULL fails if the target holds a
 * single NULL, so it needs a backfill first; DROP NOT NULL always works.
 */
export function nullabilityChangeSeverity(sourceNullable: boolean): ChangeSeverity {
  return sourceNullable ? "safe" : "breaking";
}

/**
 * Changing a column's collation. Always breaking.
 *
 * PostgreSQL has no way to change one in place: the column is re-stated with
 * `ALTER COLUMN ... TYPE <same type> COLLATE <new>`, which rewrites the table
 * and rebuilds every index over that column. Collation decides ordering and
 * equality, so under a nondeterministic collation it also changes which values
 * a UNIQUE constraint treats as duplicates — a constraint that held before the
 * change can be impossible to re-create after it.
 */
export function collationChangeSeverity(): ChangeSeverity {
  return "breaking";
}

/**
 * Changing how a column generates its own values — serial, identity, or
 * neither. ADD GENERATED … AS IDENTITY is refused unless the column is already
 * NOT NULL, and taking an identity away breaks every insert that relied on it
 * unless a sequence default replaces it.
 */
export function generatedChangeSeverity(
  source: ColumnSnapshot,
  target: ColumnSnapshot
): ChangeSeverity {
  const sourceIdentity = source.identity ?? null;
  const targetIdentity = target.identity ?? null;
  // Both are identity columns and only the flavour differs: SET GENERATED.
  if (sourceIdentity !== null && targetIdentity !== null) return "safe";
  // The target gains an identity clause.
  if (sourceIdentity !== null) return "breaking";
  // The target loses one. Safe only when a sequence default takes over.
  if (targetIdentity !== null) {
    return isNextvalDefault(source.columnDefault) ? "safe" : "breaking";
  }
  // Neither side uses an identity clause, so this is a serial appearing or
  // disappearing — a default change and nothing more.
  return "safe";
}

/**
 * The settings that differ between two sequences, worded for a reader.
 *
 * Only the ones that actually moved, because that is the whole point: a column
 * where nothing but CACHE changed should not print six clauses of which five
 * say the same thing twice.
 */
export function sequenceOptionDifferences(
  source: SequenceOptions,
  target: SequenceOptions
): string[] {
  const parts: string[] = [];
  if (source.startValue !== target.startValue) {
    parts.push(`START WITH ${target.startValue} to ${source.startValue}`);
  }
  if (source.increment !== target.increment) {
    parts.push(`INCREMENT BY ${target.increment} to ${source.increment}`);
  }
  if (sequenceBoundsComparable(source, target)) {
    if (source.minValue !== target.minValue) {
      parts.push(`MINVALUE ${target.minValue} to ${source.minValue}`);
    }
    if (source.maxValue !== target.maxValue) {
      parts.push(`MAXVALUE ${target.maxValue} to ${source.maxValue}`);
    }
  }
  if (source.cycles !== target.cycles) {
    parts.push(source.cycles ? "NO CYCLE to CYCLE" : "CYCLE to NO CYCLE");
  }
  if (source.cacheSize !== target.cacheSize) {
    parts.push(`CACHE ${target.cacheSize} to ${source.cacheSize}`);
  }
  return parts;
}

/**
 * Whether the two sequences' MINVALUE and MAXVALUE are worth comparing.
 *
 * They are not once the underlying type differs. A sequence left on its default
 * bounds takes them from its type — integer stops at 2147483647, bigint at
 * 9223372036854775807 — so widening the column from integer to bigint moves
 * MAXVALUE without anybody having chosen anything. Reporting that as a second
 * difference puts a line about sequence bounds directly under the line about
 * the type change that caused it, and the generator would then emit a MAXVALUE
 * clause restating what ALTER COLUMN ... TYPE already did.
 */
export function sequenceBoundsComparable(
  source: SequenceOptions,
  target: SequenceOptions
): boolean {
  return source.dataType === target.dataType;
}

/**
 * Parse a sequence bound, or null when it is not a plain integer.
 *
 * These arrive as strings because a bigint sequence runs past what a JavaScript
 * number can hold exactly — MAXVALUE on a bigint sequence is 9223372036854775807
 * and Number() rounds it. BigInt keeps it, and null means "could not tell",
 * which the caller grades as the dangerous answer rather than the convenient
 * one.
 */
function sequenceBound(value: string): bigint | null {
  try {
    return BigInt(value.trim());
  } catch {
    return null;
  }
}

/**
 * Moving the settings of the sequence behind an identity or serial column.
 *
 * Narrowing a bound is the dangerous one: PostgreSQL refuses "MINVALUE (5000)
 * must be less than MAXVALUE (1000)" and "START value (200) cannot be greater
 * than MAXVALUE (50)", so a migration that tightens either bound can abort on
 * the real sequence even though it applied to an empty test copy. Widening
 * cannot fail, and INCREMENT, CACHE, CYCLE and START only decide what the
 * sequence hands out next.
 */
export function sequenceOptionsChangeSeverity(
  source: SequenceOptions,
  target: SequenceOptions
): ChangeSeverity {
  const narrows = (from: string, to: string, tighter: (a: bigint, b: bigint) => boolean) => {
    const a = sequenceBound(from);
    const b = sequenceBound(to);
    if (a === null || b === null) return from !== to;
    return tighter(b, a);
  };
  // Bounds that moved only because the type did are not a tightening anybody
  // asked for — see sequenceBoundsComparable.
  if (!sequenceBoundsComparable(source, target)) return "safe";
  // The target's MINVALUE rising, or its MAXVALUE falling, is the tightening.
  if (narrows(target.minValue, source.minValue, (next, now) => next > now)) {
    return "breaking";
  }
  if (narrows(target.maxValue, source.maxValue, (next, now) => next < now)) {
    return "breaking";
  }
  return "safe";
}

/**
 * Gaining, losing or changing a GENERATED ALWAYS AS (…) clause. Always breaking,
 * and the reason is the same in all three directions: PostgreSQL has no ALTER
 * that turns a stored column into a computed one, a computed one back into a
 * stored one, or one expression into another (SET EXPRESSION arrived in
 * PostgreSQL 17 and this tool supports older servers). The only portable way
 * through is to drop the column and add it back, which takes every index and
 * view built on it with it.
 */
export function computedChangeSeverity(): ChangeSeverity {
  return "breaking";
}

/**
 * Adding or dropping a table constraint.
 *
 * Every ADD is breaking. PostgreSQL validates a new constraint against the rows
 * already in the table and refuses it if a single row fails, so an ADD can abort
 * the whole migration on real data — the same reason a narrowing type change is
 * breaking, and the same grade `CREATE UNIQUE INDEX` already carries elsewhere
 * in the generator. (ADD used to be graded "info" for everything except a
 * primary key, which contradicted that unique-index rule for what is, in the
 * database, the same operation.)
 *
 * Dropping is judged differently: it can never fail, so the question is what it
 * takes away. A primary key, a unique constraint or a foreign key is a
 * guarantee something else was built on — a foreign key can only point at a
 * primary or unique key, and `INSERT … ON CONFLICT (col)` needs one to exist —
 * so losing it breaks SQL that used to run. A CHECK or an EXCLUDE constraint
 * cannot be referenced by anything; dropping one only lets more data in.
 *
 * UNIQUE being in that list is also what keeps this in step with the generator,
 * which grades DROP INDEX on a unique index breaking. The two are the same
 * operation as far as the data is concerned, and they used to disagree.
 */
export function constraintChangeSeverity(
  kind: ConstraintDiff["kind"],
  action: "add" | "drop"
): ChangeSeverity {
  if (action === "drop") {
    return kind === "PRIMARY KEY" || kind === "UNIQUE" || kind === "FOREIGN KEY"
      ? "breaking"
      : "info";
  }
  return "breaking";
}

/**
 * The grade for a whole constraint diff. A changed definition is a DROP followed
 * by an ADD, so it takes the worse of the two.
 */
export function constraintDiffSeverity(diff: ConstraintDiff): ChangeSeverity {
  const actions: Array<"add" | "drop"> =
    diff.status === "onlyA" ? ["add"] : diff.status === "onlyB" ? ["drop"] : ["drop", "add"];
  const grades = actions.map((action) => constraintChangeSeverity(diff.kind, action));
  return grades.includes("breaking") ? "breaking" : grades[0];
}

/**
 * ADD COLUMN. A NOT NULL column with no default has nothing to put in the rows
 * that are already there, so the statement aborts; anything else applies.
 *
 * This and the two rules below used to live inline in DiffReport's matchLevel,
 * which is exactly the arrangement that let a table wear an "additive" pill
 * over a script full of breaking statements. They are restatements of what
 * lib/generate-sql.ts grades ADD COLUMN / DROP COLUMN / ALTER COLUMN, and they
 * live here so the canvas, the export and the version picker all read the one
 * copy.
 */
export function addedColumnSeverity(column: ColumnSnapshot): ChangeSeverity {
  // A computed column has nothing to backfill — PostgreSQL evaluates the
  // expression for every existing row — so NOT NULL with no default, which is
  // what a generated column looks like on paper, is not a failure here.
  if (column.generated) return "safe";
  return !column.nullable && column.columnDefault === null ? "breaking" : "safe";
}

/** DROP COLUMN. Always breaking: the column and every row's value in it go. */
export function droppedColumnSeverity(): ChangeSeverity {
  return "breaking";
}

/**
 * A matched pair of columns: the worst of the differences between them.
 *
 * A non-exact match is a rename, and that is breaking on its own even when no
 * property differs — everything that names the column as a string (a view body,
 * a saved query, application code) stops working the moment the ALTER lands.
 * Between the other two grades "info" wins over "safe", because a change worth
 * mentioning outranks one that is merely guaranteed to apply.
 */
export function columnMatchSeverity(match: ColumnMatch): ChangeSeverity {
  if (!match.exact) return "breaking";
  if (match.changes.some((change) => change.severity === "breaking")) return "breaking";
  if (match.changes.some((change) => change.severity === "info")) return "info";
  return "safe";
}

/**
 * A changed domain, graded the way the generator grades what it emits for one.
 *
 * ALTER DOMAIN … SET NOT NULL and ALTER DOMAIN … ADD CONSTRAINT are both
 * checked against every row of every column that uses the domain, so either can
 * abort the migration on real data — the same reason every ADD CONSTRAINT on a
 * table is breaking. Dropping a check, or dropping NOT NULL, only widens what
 * the columns may hold and cannot fail.
 *
 * generate-sql.ts builds its ALTER DOMAIN statements from the two helpers this
 * calls, so the grade on screen and the grade on the statement are one answer.
 */
export function domainNotNullTightens(
  source: TypeSnapshot,
  target: TypeSnapshot
): boolean {
  return source.notNull && !target.notNull;
}

/**
 * The domain checks the migration has to ADD: the ones the source has that the
 * target either lacks or spells differently. A check whose expression changed
 * counts, because ALTER DOMAIN has no "replace" — it is a drop and an add.
 */
export function domainAddedChecks(
  source: TypeSnapshot,
  target: TypeSnapshot
): TypeSnapshot["checks"] {
  const targetChecks = new Map(target.checks.map((check) => [check.name, check.expression]));
  return source.checks.filter((check) => targetChecks.get(check.name) !== check.expression);
}

export function domainChangeSeverity(
  source: TypeSnapshot,
  target: TypeSnapshot
): ChangeSeverity {
  if (domainNotNullTightens(source, target)) return "breaking";
  // "safe" and not "info": what is left is a DROP CONSTRAINT or a DROP NOT
  // NULL, which is what the generator grades those statements, and the two
  // have to say the same word.
  return domainAddedChecks(source, target).length > 0 ? "breaking" : "safe";
}

/**
 * Whether a changed routine has to be dropped before it can be created again.
 *
 * pg_get_functiondef() hands back a CREATE OR REPLACE statement, which is why
 * one string covers both "missing" and "changed" — but PostgreSQL refuses a
 * replacement that changes the return type ("cannot change return type of
 * existing function") or renames an argument ("cannot change name of input
 * parameter"). Either way the migration stops on a line the report had graded
 * as a harmless replacement.
 *
 * Argument NAMES are compared, not the whole argument text: adding a default to
 * a parameter is allowed by CREATE OR REPLACE, and treating that as a rename
 * would emit a DROP that fails whenever a view or a trigger uses the function.
 * `argumentNames` is optional, so a snapshot taken before it was recorded says
 * nothing rather than guessing.
 */
export function routineReplaceNeedsDrop(
  source: RoutineSnapshot,
  target: RoutineSnapshot
): boolean {
  if (source.returnType !== target.returnType) return true;
  if (source.argumentNames === undefined || target.argumentNames === undefined) return false;
  return source.argumentNames.join(",") !== target.argumentNames.join(",");
}

/**
 * How dangerous an index / trigger / view / sequence / type / routine change is.
 *
 * Same job constraintChangeSeverity does for constraints, and it exists for the
 * same reason: the migration generator decides a severity for every statement it
 * writes, and anything else that grades the same change — the diff canvas, the
 * export, the version picker — has to reach the same answer or the screen and
 * the script contradict each other.
 *
 * The answer itself is worked out in compareObjectLists below, where both sides
 * of the change are still in hand; this only reads it. It used to be recomputed
 * here from the diff plus a `Set` of unique index names that every caller had to
 * assemble — and a created unique index was graded from the target's set, which
 * by definition does not contain it.
 */
export function objectDiffSeverity(diff: ObjectDiff): ChangeSeverity {
  return diff.severity;
}

function compareColumnPair(
  leftTable: TableSnapshot,
  leftColumn: ColumnSnapshot,
  rightTable: TableSnapshot,
  rightColumn: ColumnSnapshot
): {
  score: number;
  breakdown: ScoreBreakdown;
  changes: ColumnChange[];
} {
  // Column similarity is split across four categories — the totals are driven
  // by the WEIGHTS.column config at the top of this file, so you can tune them
  // without changing this function. At defaults:
  //
  //   name:        0–15   how similar are the column names? (Levenshtein)
  //   type:        0–20   exact=20, same base different size=12, different=0
  //   constraints: 0–15   nullable, PK, unique, FK participation flags
  //   order:       0–10   relative position in the table (not the raw column number)
  //
  // Type is the heaviest signal because changing a type is usually a breaking
  // database change. Order is the lightest because column reordering is usually
  // cosmetic and should not drag down the overall match score.
  const name        = stringSimilarity(leftColumn.name, rightColumn.name) * WEIGHTS.column.name;
  const type        = typeScore(leftColumn.typeDisplay, rightColumn.typeDisplay);
  const constraints = columnConstraintSimilarity(leftTable, leftColumn, rightTable, rightColumn) * WEIGHTS.column.constraints;
  const order       = columnOrderSimilarity(leftTable, leftColumn, rightTable, rightColumn) * WEIGHTS.column.order;

  const changes: ColumnChange[] = [];

  if (normalizeType(leftColumn.typeDisplay) !== normalizeType(rightColumn.typeDisplay)) {
    // "size" when only the length/precision moved inside the same base type,
    // "type" when the base type itself changed — the two read very differently
    // to someone deciding whether to run the script.
    const sameBase =
      extractBaseType(leftColumn.typeDisplay) === extractBaseType(rightColumn.typeDisplay);
    changes.push({
      kind: sameBase ? "size" : "type",
      severity: typeChangeSeverity(leftColumn.typeDisplay, rightColumn.typeDisplay),
      message: typeChangeDescription(leftColumn.typeDisplay, rightColumn.typeDisplay),
    });
  }
  if (leftColumn.nullable !== rightColumn.nullable) {
    changes.push({
      kind: "nullability",
      severity: nullabilityChangeSeverity(leftColumn.nullable),
      message: `Nullability changed from ${leftColumn.nullable ? "nullable" : "not null"} to ${rightColumn.nullable ? "nullable" : "not null"}`,
    });
  }
  // Collation, only when BOTH snapshots recorded it. `undefined` means the
  // snapshot predates this field, and reading that as "the type default" would
  // report every collated column in the other schema as newly collated — and
  // have the generator strip a collation the target legitimately has.
  if (
    leftColumn.collation !== undefined &&
    rightColumn.collation !== undefined &&
    leftColumn.collation !== rightColumn.collation
  ) {
    changes.push({
      kind: "collation",
      severity: collationChangeSeverity(),
      // left→right, matching the nullability and type wording in this list.
      message: `Collation changed from ${leftColumn.collation ?? "the type default"} to ${rightColumn.collation ?? "the type default"}`,
    });
  }
  // Computed columns first, because a column that gains or loses a GENERATED
  // ALWAYS AS clause is rebuilt rather than altered, and that outranks anything
  // else this loop could say about it.
  const leftComputed = describeComputed(leftColumn);
  const rightComputed = describeComputed(rightColumn);
  if (leftComputed !== null && rightComputed !== null && leftComputed !== rightComputed) {
    changes.push({
      kind: "computed",
      severity: computedChangeSeverity(),
      // left→right, matching the nullability, type and default wording in this
      // same list: the source is stated first, the target second.
      message: `Generated column changed from ${leftComputed} to ${rightComputed}`,
    });
  }

  // How the column generates its own values, compared as one property. Two
  // serial columns in different schemas have different sequence NAMES in their
  // defaults, so the raw text always differs — and serial versus identity is a
  // real change that the default text describes badly.
  const leftGenerated = describeGenerated(leftColumn);
  const rightGenerated = describeGenerated(rightColumn);
  if (leftGenerated !== null && rightGenerated !== null && leftGenerated !== rightGenerated) {
    changes.push({
      kind: "generated",
      severity: generatedChangeSeverity(leftColumn, rightColumn),
      message: `Generated values changed from ${leftGenerated} to ${rightGenerated}`,
    });
  }

  // The settings of the sequence behind an identity or serial column. Compared
  // separately from the line above, which says WHICH kind of generator the
  // column has; this says how that generator is configured, and the two move
  // independently.
  //
  // Both sides have to have recorded it AND both have to have a sequence: an
  // `undefined` is a snapshot with no record, and a `null` on one side alone is
  // the column gaining or losing its generator, which the line above already
  // reported in full.
  const leftSequence = leftColumn.sequenceOptions;
  const rightSequence = rightColumn.sequenceOptions;
  if (leftSequence && rightSequence) {
    const moved = sequenceOptionDifferences(leftSequence, rightSequence);
    if (moved.length > 0) {
      changes.push({
        kind: "sequenceOptions",
        severity: sequenceOptionsChangeSeverity(leftSequence, rightSequence),
        // right→left like every other message in this list: the target's
        // setting first, the source's second.
        message: `Sequence settings changed — ${moved.join(", ")}`,
      });
    }
  }

  // Column default drift. Defaults are already schema-relative (own-schema
  // qualifier stripped at snapshot time), so a plain text compare is safe. It is
  // skipped whenever either side generates its own values, because there the
  // "default" is just the generator showing through and the line above already
  // reported it.
  if (!isGeneratedColumn(leftColumn) && !isGeneratedColumn(rightColumn)) {
    const leftDefault = leftColumn.columnDefault?.trim() || null;
    const rightDefault = rightColumn.columnDefault?.trim() || null;
    if (leftDefault !== rightDefault) {
      // left→right, matching the nullability/type wording in this same list.
      changes.push({
        kind: "default",
        // SET DEFAULT and DROP DEFAULT both always apply: a default only
        // affects rows inserted after it, never rows already stored.
        severity: "safe",
        message: `Default changed from ${leftDefault ?? "none"} to ${rightDefault ?? "none"}`,
      });
    }
  }
  // NOTE: column ORDER is deliberately NOT recorded as a change. PostgreSQL
  // cannot reorder columns in place, so no migration statement can resolve it —
  // counting it as a change made a table report differences forever even after a
  // full sync (phantom drift, issue #18). Order still influences the match SCORE
  // via columnOrderSimilarity; it just isn't a reported, "fixable" change.
  // The three participation flags below are this column's view of a constraint
  // diff, so they are graded with the same rule the constraint itself gets:
  // the source having it means the migration ADDs it, the target having it
  // means the migration DROPs it.
  if (leftColumn.isPrimaryKey !== rightColumn.isPrimaryKey) {
    changes.push({
      kind: "primaryKey",
      severity: constraintChangeSeverity(
        "PRIMARY KEY",
        leftColumn.isPrimaryKey ? "add" : "drop"
      ),
      message: "Primary key participation changed",
    });
  }
  if (Math.sign(leftColumn.uniqueConstraintNames.length) !== Math.sign(rightColumn.uniqueConstraintNames.length)) {
    changes.push({
      kind: "unique",
      severity: constraintChangeSeverity(
        "UNIQUE",
        leftColumn.uniqueConstraintNames.length > 0 ? "add" : "drop"
      ),
      message: "Unique constraint participation changed",
    });
  }
  if (Math.sign(leftColumn.foreignKeyConstraintNames.length) !== Math.sign(rightColumn.foreignKeyConstraintNames.length)) {
    changes.push({
      kind: "foreignKey",
      severity: constraintChangeSeverity(
        "FOREIGN KEY",
        leftColumn.foreignKeyConstraintNames.length > 0 ? "add" : "drop"
      ),
      message: "Foreign key participation changed",
    });
  }

  return {
    score: roundScore(name + type + constraints + order),
    breakdown: {
      name: roundScore(name),
      constraints: roundScore(constraints),
      type: roundScore(type),
      order: roundScore(order),
    },
    changes,
  };
}

function average(values: number[]): number {
  if (values.length === 0) return 1;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function pairwiseAverageBestScore(
  leftTable: TableSnapshot,
  rightTable: TableSnapshot
): number {
  if (leftTable.columns.length === 0 && rightTable.columns.length === 0) return 1;

  const leftScores = leftTable.columns.map((leftColumn) =>
    Math.max(
      0,
      ...rightTable.columns.map(
        (rightColumn) => compareColumnPair(leftTable, leftColumn, rightTable, rightColumn).score / COLUMN_TOTAL_WEIGHT
      )
    )
  );

  const rightScores = rightTable.columns.map((rightColumn) =>
    Math.max(
      0,
      ...leftTable.columns.map(
        (leftColumn) => compareColumnPair(leftTable, leftColumn, rightTable, rightColumn).score / COLUMN_TOTAL_WEIGHT
      )
    )
  );

  return average([...leftScores, ...rightScores]);
}

// ============================================================================
// Table-level constraint family similarity
// ============================================================================

function constraintFamilySimilarity(
  leftTable: TableSnapshot,
  rightTable: TableSnapshot,
  leftSchema: string,
  rightSchema: string
): number {
  const primaryKeySimilarity = (() => {
    if (!leftTable.primaryKey && !rightTable.primaryKey) return 1;
    if (!leftTable.primaryKey || !rightTable.primaryKey) return 0;
    return setSimilarity(leftTable.primaryKey.columns, rightTable.primaryKey.columns);
  })();

  const uniqueSimilarity = setSimilarity(
    leftTable.uniqueConstraints.map(uniqueConstraintSignature),
    rightTable.uniqueConstraints.map(uniqueConstraintSignature)
  );

  const foreignKeySimilarity = setSimilarity(
    leftTable.foreignKeys.map((fk) => foreignKeyLogicalSignature(fk, leftSchema)),
    rightTable.foreignKeys.map((fk) => foreignKeyLogicalSignature(fk, rightSchema))
  );

  const checkSimilarity = setSimilarity(
    leftTable.checkConstraints.map(definitionSignature),
    rightTable.checkConstraints.map(definitionSignature)
  );

  const excludeSimilarity = setSimilarity(
    leftTable.excludeConstraints.map(definitionSignature),
    rightTable.excludeConstraints.map(definitionSignature)
  );

  return average([
    primaryKeySimilarity,
    uniqueSimilarity,
    foreignKeySimilarity,
    checkSimilarity,
    excludeSimilarity,
  ]);
}

// ============================================================================
// Relational mapping (FK graph neighbourhood)
// ============================================================================
// The constraint diffing above compares the FK constraints *on* each table,
// but it never looks at the wider graph — which OTHER tables point at this
// one, and which tables this one points at. That graph context is often the
// strongest signal for rename detection: if `users` in schema A is referenced
// by the same set of tables as some candidate in schema B, that's a very
// strong "these are the same table" signal, even if the names drifted.

function outgoingRelationshipShape(foreignKey: ForeignKeySnapshot): string {
  return [
    String(foreignKey.columns.length),
    String(foreignKey.referencedColumns.length),
    normalizeSimilarityText(foreignKey.onUpdate),
    normalizeSimilarityText(foreignKey.onDelete),
  ].join("|");
}

function incomingRelationshipShape(entry: IncomingForeignKey): string {
  return [String(entry.columns.length), String(entry.referencedColumns.length)].join("|");
}

function relationshipBucketSimilarity(
  leftNames: string[],
  rightNames: string[],
  leftShapes: string[],
  rightShapes: string[]
): number {
  return average([
    multisetSimilarity(leftNames, rightNames),
    multisetSimilarity(leftShapes, rightShapes),
  ]);
}

// Builds a reverse index: "which tables reference me?" for every table in the
// schema. We compute this once per schema and reuse it for all pairwise
// comparisons instead of recomputing on every compareTablePair call.
function buildIncomingForeignKeyMap(schema: SchemaSnapshot): IncomingForeignKeyMap {
  const map: IncomingForeignKeyMap = new Map();
  for (const table of schema.tables) {
    for (const foreignKey of table.foreignKeys) {
      const targetName = normalizeIdentifier(foreignKey.referencedTable ?? "");
      if (targetName.length === 0) continue;
      const entry: IncomingForeignKey = {
        referringTable: table.name,
        columns: foreignKey.columns,
        referencedColumns: foreignKey.referencedColumns,
      };
      const existing = map.get(targetName);
      if (existing) {
        existing.push(entry);
      } else {
        map.set(targetName, [entry]);
      }
    }
  }
  return map;
}

// Returns a 0–1 similarity score for how alike two tables' FK neighbourhoods
// are, or `null` if neither table participates in any FK — in that case there
// is no signal to score and compareTablePair will renormalise the other
// weights instead of penalising isolated tables.
function relationshipSimilarity(
  leftTable: TableSnapshot,
  rightTable: TableSnapshot,
  leftIncoming: IncomingForeignKeyMap,
  rightIncoming: IncomingForeignKeyMap
): number | null {
  const leftOutgoingNames = leftTable.foreignKeys
    .map((fk) => normalizeIdentifier(fk.referencedTable ?? ""))
    .filter((name) => name.length > 0);
  const rightOutgoingNames = rightTable.foreignKeys
    .map((fk) => normalizeIdentifier(fk.referencedTable ?? ""))
    .filter((name) => name.length > 0);
  const leftOutgoingShapes  = leftTable.foreignKeys.map(outgoingRelationshipShape);
  const rightOutgoingShapes = rightTable.foreignKeys.map(outgoingRelationshipShape);

  const leftIncomingList  = leftIncoming.get(normalizeIdentifier(leftTable.name))   ?? [];
  const rightIncomingList = rightIncoming.get(normalizeIdentifier(rightTable.name)) ?? [];
  const leftIncomingNames  = leftIncomingList.map((e) => normalizeIdentifier(e.referringTable));
  const rightIncomingNames = rightIncomingList.map((e) => normalizeIdentifier(e.referringTable));
  const leftIncomingShapes  = leftIncomingList.map(incomingRelationshipShape);
  const rightIncomingShapes = rightIncomingList.map(incomingRelationshipShape);

  const hasOutgoing = leftOutgoingNames.length > 0 || rightOutgoingNames.length > 0;
  const hasIncoming = leftIncomingNames.length > 0 || rightIncomingNames.length > 0;

  if (!hasOutgoing && !hasIncoming) return null;

  const scores: number[] = [];
  if (hasOutgoing) {
    scores.push(
      relationshipBucketSimilarity(leftOutgoingNames, rightOutgoingNames, leftOutgoingShapes, rightOutgoingShapes)
    );
  }
  if (hasIncoming) {
    scores.push(
      relationshipBucketSimilarity(leftIncomingNames, rightIncomingNames, leftIncomingShapes, rightIncomingShapes)
    );
  }

  return average(scores);
}

// ============================================================================
// Table pair scoring
// ============================================================================

function compareTablePair(
  leftTable: TableSnapshot,
  rightTable: TableSnapshot,
  leftIncoming: IncomingForeignKeyMap,
  rightIncoming: IncomingForeignKeyMap,
  leftSchema: string,
  rightSchema: string
): {
  score: number;
  breakdown: ScoreBreakdown;
} {
  // Each dimension earns weighted points, and the final score is renormalised
  // to 0–100 so the threshold constants stay meaningful regardless of which
  // dimensions contributed. `relationships` is skipped when neither table has
  // any FK relationships — see relationshipSimilarity for the rationale.
  const nameRatio          = stringSimilarity(leftTable.name, rightTable.name);
  const constraintsRatio   = constraintFamilySimilarity(leftTable, rightTable, leftSchema, rightSchema);
  const columnsRatio       = pairwiseAverageBestScore(leftTable, rightTable);
  const relationshipsRatio = relationshipSimilarity(leftTable, rightTable, leftIncoming, rightIncoming);

  const namePoints        = nameRatio        * WEIGHTS.table.name;
  const constraintsPoints = constraintsRatio * WEIGHTS.table.constraints;
  const columnsPoints     = columnsRatio     * WEIGHTS.table.columns;

  const breakdown: ScoreBreakdown = {
    name: roundScore(namePoints),
    constraints: roundScore(constraintsPoints),
    columns: roundScore(columnsPoints),
  };

  let rawTotal = namePoints + constraintsPoints + columnsPoints;
  let maxTotal = WEIGHTS.table.name + WEIGHTS.table.constraints + WEIGHTS.table.columns;

  if (relationshipsRatio !== null) {
    const relationshipsPoints = relationshipsRatio * WEIGHTS.table.relationships;
    breakdown.relationships = roundScore(relationshipsPoints);
    rawTotal += relationshipsPoints;
    maxTotal += WEIGHTS.table.relationships;
  }

  // Scale to 0–100. When relationships is skipped, the remaining dimensions
  // fill the whole 0–100 range so an isolated table can still score 100.
  const score = maxTotal === 0 ? 0 : (rawTotal * 100) / maxTotal;

  return { score: roundScore(score), breakdown };
}

// ============================================================================
// Pairwise best-match (used for both tables and columns)
// ============================================================================

function getBestMatches<TLeft, TRight>(
  leftItems: TLeft[],
  rightItems: TRight[],
  computeScore: (left: TLeft, right: TRight) => { score: number; breakdown: ScoreBreakdown },
  acceptThreshold: number,
  possibleThreshold: number,
  kind: "table" | "column",
  getLeftName: (value: TLeft) => string,
  getRightName: (value: TRight) => string,
  // Optional extra gate a pair must pass to be AUTO-ACCEPTED (not just clear the
  // score threshold). Used for tables to require a minimum name similarity, so a
  // pair that is structurally alike but has unrelated names is surfaced as a
  // rename *candidate* for review instead of being silently auto-renamed
  // (issue #7). A pair that clears the score but fails this guard falls through
  // to the `possible` bucket.
  acceptGuard?: (left: TLeft, right: TRight) => boolean
): {
  accepted: Array<{ left: TLeft; right: TRight; score: number; breakdown: ScoreBreakdown }>;
  possible: MatchCandidate[];
  leftOnly: TLeft[];
  rightOnly: TRight[];
} {
  // Score every pair once.
  const matrix = new Map<string, { score: number; breakdown: ScoreBreakdown }>();
  for (let leftIndex = 0; leftIndex < leftItems.length; leftIndex += 1) {
    for (let rightIndex = 0; rightIndex < rightItems.length; rightIndex += 1) {
      matrix.set(`${leftIndex}:${rightIndex}`, computeScore(leftItems[leftIndex], rightItems[rightIndex]));
    }
  }

  const matchedLeft  = new Set<number>();
  const matchedRight = new Set<number>();

  // Pairs the acceptGuard has rejected. They must be EXCLUDED from subsequent
  // matching rounds: a high-scoring but guard-failing pair (e.g. a structural
  // clone with an unrelated name) would otherwise stay each side's mutual-best
  // every round and permanently shadow the real rename, which then gets dropped to
  // create+drop — destructive data loss. Blocking them lets each side fall through
  // to its next-best legitimate partner; they still surface as candidates in the
  // final unfiltered pass.
  const blocked = new Set<string>();

  // Compute the mutual-best pairing over the items not yet matched. A pair is
  // mutual-best when each side's highest-scoring remaining partner is the other.
  // When excludeBlocked is set, guard-rejected pairs are ignored so they don't
  // shadow a side's next-best partner.
  function mutualBestPairs(excludeBlocked: boolean): Array<{ leftIndex: number; rightIndex: number; score: number; breakdown: ScoreBreakdown }> {
    const leftBest  = new Map<number, { index: number; score: number; breakdown: ScoreBreakdown }>();
    const rightBest = new Map<number, { index: number; score: number; breakdown: ScoreBreakdown }>();
    for (let leftIndex = 0; leftIndex < leftItems.length; leftIndex += 1) {
      if (matchedLeft.has(leftIndex)) continue;
      for (let rightIndex = 0; rightIndex < rightItems.length; rightIndex += 1) {
        if (matchedRight.has(rightIndex)) continue;
        if (excludeBlocked && blocked.has(`${leftIndex}:${rightIndex}`)) continue;
        const result = matrix.get(`${leftIndex}:${rightIndex}`)!;
        const bl = leftBest.get(leftIndex);
        if (!bl || result.score > bl.score) leftBest.set(leftIndex, { index: rightIndex, score: result.score, breakdown: result.breakdown });
        const br = rightBest.get(rightIndex);
        if (!br || result.score > br.score) rightBest.set(rightIndex, { index: leftIndex, score: result.score, breakdown: result.breakdown });
      }
    }
    const pairs: Array<{ leftIndex: number; rightIndex: number; score: number; breakdown: ScoreBreakdown }> = [];
    for (const [leftIndex, best] of leftBest.entries()) {
      const reverse = rightBest.get(best.index);
      if (reverse && reverse.index === leftIndex) {
        pairs.push({ leftIndex, rightIndex: best.index, score: best.score, breakdown: best.breakdown });
      }
    }
    return pairs;
  }

  const accepted: Array<{ left: TLeft; right: TRight; score: number; breakdown: ScoreBreakdown }> = [];

  // Iterate over blocked-excluded mutual-best pairs: accept those clearing the
  // threshold + guard; record guard failures in `blocked`. A single pass collapses
  // equal twins onto one partner (leaving the other to a spurious create/drop,
  // issue #14) and lets a blocked clone shadow a real rename; repeating — with
  // blocked pairs removed — lets each side reach its own legitimate match.
  // Terminates because every round either matches ≥1 pair or newly blocks ≥1
  // pair, both of which strictly shrink the remaining search space.
  for (;;) {
    const pairs = mutualBestPairs(true);
    let acceptedThisRound = 0;
    let blockedThisRound = 0;
    for (const pair of pairs) {
      if (pair.score < acceptThreshold) continue;
      if (acceptGuard && !acceptGuard(leftItems[pair.leftIndex], rightItems[pair.rightIndex])) {
        const key = `${pair.leftIndex}:${pair.rightIndex}`;
        if (!blocked.has(key)) { blocked.add(key); blockedThisRound += 1; }
        continue;
      }
      accepted.push({ left: leftItems[pair.leftIndex], right: rightItems[pair.rightIndex], score: pair.score, breakdown: pair.breakdown });
      matchedLeft.add(pair.leftIndex);
      matchedRight.add(pair.rightIndex);
      acceptedThisRound += 1;
    }
    if (acceptedThisRound === 0 && blockedThisRound === 0) break;
  }

  // Final pass WITHOUT blocking, so guard-rejected pairs still surface as review
  // candidates. The tables themselves stay in leftOnly/rightOnly.
  const possible: MatchCandidate[] = [];
  for (const pair of mutualBestPairs(false)) {
    if (pair.score >= possibleThreshold) {
      possible.push({
        kind,
        leftName: getLeftName(leftItems[pair.leftIndex]),
        rightName: getRightName(rightItems[pair.rightIndex]),
        score: pair.score,
        accepted: false,
        breakdown: pair.breakdown,
      });
    }
  }

  return {
    accepted,
    possible,
    leftOnly:  leftItems.filter((_, index) => !matchedLeft.has(index)),
    rightOnly: rightItems.filter((_, index) => !matchedRight.has(index)),
  };
}

// ============================================================================
// Column comparison within a matched table pair
// ============================================================================

function compareColumns(
  leftTable: TableSnapshot,
  rightTable: TableSnapshot
): {
  columnMatches: ColumnMatch[];
  columnsOnlyInA: ColumnSnapshot[];
  columnsOnlyInB: ColumnSnapshot[];
  possibleColumnMatches: MatchCandidate[];
} {
  const leftByName  = new Map(leftTable.columns.map((col) => [normalizeIdentifier(col.name), col]));
  const rightByName = new Map(rightTable.columns.map((col) => [normalizeIdentifier(col.name), col]));

  const matchedRightNames = new Set<string>();
  const columnMatches: ColumnMatch[] = [];

  // 1. Exact name matches
  for (const [name, leftColumn] of leftByName.entries()) {
    const rightColumn = rightByName.get(name);
    if (!rightColumn) continue;

    matchedRightNames.add(name);
    const result = compareColumnPair(leftTable, leftColumn, rightTable, rightColumn);
    columnMatches.push({
      left: leftColumn, right: rightColumn,
      score: result.score, exact: true,
      breakdown: result.breakdown, changes: result.changes,
    });
  }

  // 2. Similarity matching on the leftovers
  const leftOnly  = leftTable.columns.filter((col) => !rightByName.has(normalizeIdentifier(col.name)));
  const rightOnly = rightTable.columns.filter((col) => !matchedRightNames.has(normalizeIdentifier(col.name)));

  const similarityResults = getBestMatches(
    leftOnly,
    rightOnly,
    (leftColumn, rightColumn) => {
      const result = compareColumnPair(leftTable, leftColumn, rightTable, rightColumn);
      return { score: result.score, breakdown: result.breakdown };
    },
    COLUMN_MATCH_ACCEPT_THRESHOLD,
    COLUMN_MATCH_POSSIBLE_THRESHOLD,
    "column",
    (col) => col.name,
    (col) => col.name
  );

  for (const match of similarityResults.accepted) {
    const result = compareColumnPair(leftTable, match.left, rightTable, match.right);
    columnMatches.push({
      left: match.left, right: match.right,
      score: match.score, exact: false,
      breakdown: match.breakdown, changes: result.changes,
    });
  }

  return {
    columnMatches: columnMatches.sort((a, b) => {
      if (a.left.ordinalPosition !== b.left.ordinalPosition) {
        return a.left.ordinalPosition - b.left.ordinalPosition;
      }
      return a.left.name.localeCompare(b.left.name);
    }),
    columnsOnlyInA: similarityResults.leftOnly,
    columnsOnlyInB: similarityResults.rightOnly,
    possibleColumnMatches: similarityResults.possible,
  };
}

// ============================================================================
// Constraint diffing
// ============================================================================

function comparePrimaryKey(left: TableSnapshot, right: TableSnapshot): ConstraintDiff[] {
  if (!left.primaryKey && !right.primaryKey) return [];
  if (left.primaryKey && !right.primaryKey) {
    return [{ kind: "PRIMARY KEY", status: "onlyA", summary: `Primary key ${left.primaryKey.name} exists only in ${left.name}.`, leftName: left.primaryKey.name }];
  }
  if (!left.primaryKey && right.primaryKey) {
    return [{ kind: "PRIMARY KEY", status: "onlyB", summary: `Primary key ${right.primaryKey.name} exists only in ${right.name}.`, rightName: right.primaryKey.name }];
  }
  if (
    primaryKeySignature(left.primaryKey) !== primaryKeySignature(right.primaryKey) ||
    left.primaryKey?.normalizedDefinition !== right.primaryKey?.normalizedDefinition
  ) {
    return [{
      kind: "PRIMARY KEY",
      status: "changedDefinition",
      summary: `Primary key changed from (${left.primaryKey?.columns.join(", ")}) to (${right.primaryKey?.columns.join(", ")}).`,
      leftName: left.primaryKey?.name,
      rightName: right.primaryKey?.name,
    }];
  }
  return [];
}

function compareUniqueConstraints(left: TableSnapshot, right: TableSnapshot): ConstraintDiff[] {
  const diffs: ConstraintDiff[] = [];
  const rightByName      = new Map(right.uniqueConstraints.map((c) => [normalizeIdentifier(c.name), c]));
  const rightBySignature = new Map(right.uniqueConstraints.map((c) => [uniqueConstraintSignature(c), c]));
  const matchedRight     = new Set<string>();

  for (const constraint of left.uniqueConstraints) {
    const byName = rightByName.get(normalizeIdentifier(constraint.name));
    if (byName) {
      matchedRight.add(byName.name);
      if (uniqueConstraintSignature(constraint) !== uniqueConstraintSignature(byName) || constraint.normalizedDefinition !== byName.normalizedDefinition) {
        diffs.push({ kind: "UNIQUE", status: "changedDefinition", summary: `Unique constraint ${constraint.name} changed definition.`, leftName: constraint.name, rightName: byName.name });
      }
      continue;
    }
    const bySignature = rightBySignature.get(uniqueConstraintSignature(constraint));
    if (bySignature) { matchedRight.add(bySignature.name); continue; }
    diffs.push({ kind: "UNIQUE", status: "onlyA", summary: `Unique constraint ${constraint.name} exists only in ${left.name}.`, leftName: constraint.name });
  }

  for (const constraint of right.uniqueConstraints) {
    if (matchedRight.has(constraint.name)) continue;
    diffs.push({ kind: "UNIQUE", status: "onlyB", summary: `Unique constraint ${constraint.name} exists only in ${right.name}.`, rightName: constraint.name });
  }

  return diffs;
}

function compareForeignKeys(
  left: TableSnapshot,
  right: TableSnapshot,
  leftSchema: string,
  rightSchema: string
): ConstraintDiff[] {
  const diffs: ConstraintDiff[] = [];
  const rightByName      = new Map(right.foreignKeys.map((fk) => [normalizeIdentifier(fk.name), fk]));
  const rightBySignature = new Map(right.foreignKeys.map((fk) => [foreignKeyLogicalSignature(fk, rightSchema), fk]));
  const matchedRight     = new Set<string>();

  for (const foreignKey of left.foreignKeys) {
    const byName = rightByName.get(normalizeIdentifier(foreignKey.name));
    if (byName) {
      matchedRight.add(byName.name);
      if (
        foreignKeyLogicalSignature(foreignKey, leftSchema) !== foreignKeyLogicalSignature(byName, rightSchema) ||
        schemaRelativeFkDefinition(foreignKey, leftSchema) !== schemaRelativeFkDefinition(byName, rightSchema)
      ) {
        diffs.push({ kind: "FOREIGN KEY", status: "changedDefinition", summary: `Foreign key ${foreignKey.name} changed definition.`, leftName: foreignKey.name, rightName: byName.name });
      }
      continue;
    }
    const bySignature = rightBySignature.get(foreignKeyLogicalSignature(foreignKey, leftSchema));
    if (bySignature) {
      matchedRight.add(bySignature.name);
      // The logical signature omits DEFERRABLE / MATCH mode, so a signature match
      // alone can hide a real definition difference. Confirm with the schema-
      // relative definition and report a change if they still differ.
      if (schemaRelativeFkDefinition(foreignKey, leftSchema) !== schemaRelativeFkDefinition(bySignature, rightSchema)) {
        diffs.push({ kind: "FOREIGN KEY", status: "changedDefinition", summary: `Foreign key ${foreignKey.name} changed definition.`, leftName: foreignKey.name, rightName: bySignature.name });
      }
      continue;
    }
    diffs.push({ kind: "FOREIGN KEY", status: "onlyA", summary: `Foreign key ${foreignKey.name} exists only in ${left.name}.`, leftName: foreignKey.name });
  }

  for (const foreignKey of right.foreignKeys) {
    if (matchedRight.has(foreignKey.name)) continue;
    diffs.push({ kind: "FOREIGN KEY", status: "onlyB", summary: `Foreign key ${foreignKey.name} exists only in ${right.name}.`, rightName: foreignKey.name });
  }

  return diffs;
}

function compareDefinitionConstraints(
  kind: "CHECK" | "EXCLUDE",
  leftConstraints: ConstraintSnapshot[],
  rightConstraints: ConstraintSnapshot[],
  leftTableName: string,
  rightTableName: string
): ConstraintDiff[] {
  const diffs: ConstraintDiff[] = [];
  const rightByName       = new Map(rightConstraints.map((c) => [normalizeIdentifier(c.name), c]));
  const rightByDefinition = new Map(rightConstraints.map((c) => [c.normalizedDefinition, c]));
  const matchedRight      = new Set<string>();

  for (const constraint of leftConstraints) {
    const byName = rightByName.get(normalizeIdentifier(constraint.name));
    if (byName) {
      matchedRight.add(byName.name);
      if (constraint.normalizedDefinition !== byName.normalizedDefinition) {
        diffs.push({ kind, status: "changedDefinition", summary: `${kind} constraint ${constraint.name} changed definition.`, leftName: constraint.name, rightName: byName.name });
      }
      continue;
    }
    const byDefinition = rightByDefinition.get(constraint.normalizedDefinition);
    if (byDefinition) { matchedRight.add(byDefinition.name); continue; }
    diffs.push({ kind, status: "onlyA", summary: `${kind} constraint ${constraint.name} exists only in ${leftTableName}.`, leftName: constraint.name });
  }

  for (const constraint of rightConstraints) {
    if (matchedRight.has(constraint.name)) continue;
    diffs.push({ kind, status: "onlyB", summary: `${kind} constraint ${constraint.name} exists only in ${rightTableName}.`, rightName: constraint.name });
  }

  return diffs;
}

function compareConstraints(
  left: TableSnapshot,
  right: TableSnapshot,
  leftSchema: string,
  rightSchema: string
): ConstraintDiff[] {
  return [
    ...comparePrimaryKey(left, right),
    ...compareUniqueConstraints(left, right),
    ...compareForeignKeys(left, right, leftSchema, rightSchema),
    ...compareDefinitionConstraints("CHECK",   left.checkConstraints,   right.checkConstraints,   left.name, right.name),
    ...compareDefinitionConstraints("EXCLUDE", left.excludeConstraints, right.excludeConstraints, left.name, right.name),
  ];
}

// ============================================================================
// Object diffing (indexes, triggers, views, sequences, types, routines)
// ============================================================================
// Everything in this section follows one rule, and it is the important one:
//
//   a category is compared only when BOTH snapshots recorded it.
//
// These collections are optional on SchemaSnapshot/TableSnapshot because
// lineage stores snapshots as JSONB and never rewrites a stored row. A snapshot
// captured before views were recorded has `views: undefined`, which means "I
// don't know", not "there are none". Reading that as [] would report every view
// in the live schema as newly added and every tracked schema would show
// permanent phantom drift. So: undefined on either side -> say nothing.

const OBJECT_KIND_LABEL: Record<ObjectKind, string> = {
  INDEX: "Index",
  TRIGGER: "Trigger",
  VIEW: "View",
  "MATERIALIZED VIEW": "Materialized view",
  SEQUENCE: "Sequence",
  ENUM: "Enum",
  DOMAIN: "Domain",
  "COMPOSITE TYPE": "Composite type",
  "RANGE TYPE": "Range type",
  FUNCTION: "Function",
  PROCEDURE: "Procedure",
  POLICY: "Policy",
  "ROW SECURITY": "Row security on",
  PARTITIONING: "Partitioning of",
  COLLATION: "Collation",
  EXTENSION: "Extension",
  PRIVILEGES: "Access to",
};

/**
 * One schema object flattened into the shape the comparison needs: an identity
 * to match on, a kind to label it, and a definition to detect a change.
 */
type ComparableObject = {
  /** Identity. Usually the name; a routine's is its signature (overloads). */
  key: string;
  kind: ObjectKind;
  name: string;
  definition: string;
  normalizedDefinition: string;
  table?: string;
  /**
   * True for a UNIQUE index. It is the one index whose loss changes what the
   * table is allowed to hold rather than only how fast it is read, and the one
   * whose creation can fail on rows that are already there.
   */
  enforcesUniqueness?: boolean;
  /** Carried for a domain: grading a changed one needs both sides. */
  type?: TypeSnapshot;
  /** Carried for a function or procedure, for the same reason. */
  routine?: RoutineSnapshot;
  /** Carried for a view, so the drop-or-replace question is decided once. */
  view?: ViewSnapshot;
  /** Carried for a collation: the generator writes CREATE from the fields. */
  collation?: CollationSnapshot;
  /** Carried for an extension: the generator writes its version into the SQL. */
  extension?: ExtensionSnapshot;
  /**
   * Carried for a privilege entry. Grading a changed one needs both sides —
   * the whole question is whether the target is about to LOSE something.
   */
  privilege?: PrivilegeSnapshot;
};

/**
 * How dangerous it is to create this object.
 *
 * Almost always nothing is taken away, so almost always "info". A unique index
 * is the exception: PostgreSQL builds it against the rows already in the table
 * and refuses it if two of them collide, so it can abort the migration exactly
 * the way ADD CONSTRAINT can — and constraintChangeSeverity grades every ADD
 * breaking for that reason.
 */
function objectCreateSeverity(obj: ComparableObject): ChangeSeverity {
  // A policy is an authorization rule, and a new one always takes something
  // away from somebody: a RESTRICTIVE policy removes rows a caller could read,
  // a PERMISSIVE one removes the protection on rows they could not. Neither is
  // a change anyone should skim past, so both are graded the same way.
  if (obj.kind === "POLICY") return "breaking";
  // A privilege entry that exists only in the source belongs to an object the
  // script is also creating, so its grants are new access rather than moved
  // access. Nothing anybody has today is touched.
  if (obj.kind === "PRIVILEGES") return "info";
  return obj.kind === "INDEX" && obj.enforcesUniqueness === true ? "breaking" : "info";
}

/**
 * How dangerous it is to drop this object.
 *
 * Breaking, because whatever used it stops working — except a plain index,
 * which only made reads faster.
 */
function objectDropSeverity(obj: ComparableObject): ChangeSeverity {
  if (obj.kind !== "INDEX") return "breaking";
  return obj.enforcesUniqueness === true ? "breaking" : "safe";
}

/**
 * How dangerous it is to change this object's definition, which depends
 * entirely on how the generator applies the change:
 *
 *   view      — DROP … CASCADE and rebuild. The cascade is the reason.
 *   index     — dropped and recreated, so it takes the worse of the two.
 *   domain    — ALTER DOMAIN, breaking only when it tightens what the columns
 *               may hold. See domainChangeSeverity.
 *   routine   — CREATE OR REPLACE, unless the signature moved and it has to be
 *               dropped first. See routineReplaceNeedsDrop.
 *   extension — ALTER EXTENSION … UPDATE, which takes nothing away.
 *   the rest  — replaced in place (ALTER SEQUENCE, ALTER TYPE, CREATE TRIGGER
 *               after a drop) and nothing is taken away while it happens.
 */
function objectChangeSeverity(
  source: ComparableObject,
  target: ComparableObject
): ChangeSeverity {
  if (source.kind === "VIEW" || source.kind === "MATERIALIZED VIEW") return "breaking";
  // Both directions of the row-security switch are dangerous, which is why
  // there is no "safe" side to it: turning it ON makes working queries return
  // zero rows, turning it OFF makes every row in the table world-visible.
  // A rewritten policy is graded with the same reasoning as a new one.
  if (source.kind === "POLICY" || source.kind === "ROW SECURITY") return "breaking";
  // A table cannot be turned into a partitioned one, or a partition detached
  // and reattached, by any ALTER the generator can write. Whichever way it
  // moves, the fix is a rebuild — which is the definition of breaking here.
  if (source.kind === "PARTITIONING") return "breaking";
  // PostgreSQL has no ALTER COLLATION that changes how one sorts — only
  // RENAME, OWNER and REFRESH VERSION. A changed collation therefore has to be
  // dropped and recreated, which fails outright while any column still uses
  // it, and re-sorts every index over those columns once it is done.
  if (source.kind === "COLLATION") return "breaking";
  // An extension whose version moved. Graded the same way a replaced function
  // is, and for the same reason: nothing is dropped and no column changes its
  // type — what changes is the behaviour of the routines the extension brought
  // with it. Whether the move is even applicable is a separate question the
  // generator answers, since ALTER EXTENSION ... UPDATE only goes forwards.
  if (source.kind === "EXTENSION") return "info";
  // Access that moved. Breaking only when the target is about to lose some —
  // a REVOKE, or an owner handing the object to somebody else — because that
  // is the case where a query that works today stops working. Handing out MORE
  // access is graded safe: no statement can fail and nothing stops working.
  // Asked through the same exported function the generator asks.
  if (source.kind === "PRIVILEGES" && source.privilege && target.privilege) {
    return privilegeChangeTakesAway(source.privilege, target.privilege)
      ? "breaking"
      : "safe";
  }
  if (source.kind === "INDEX") {
    return objectDropSeverity(target) === "breaking" ||
      objectCreateSeverity(source) === "breaking"
      ? "breaking"
      : "safe";
  }
  if (source.kind === "DOMAIN" && source.type && target.type) {
    return domainChangeSeverity(source.type, target.type);
  }
  if (source.routine && target.routine) {
    return routineReplaceNeedsDrop(source.routine, target.routine) ? "breaking" : "info";
  }
  return "info";
}

/**
 * Whether creating this object is something a person has to do by hand.
 *
 * Only a range type can be, and only when the snapshot does not describe it
 * well enough to write CREATE TYPE ... AS RANGE. rangeTypeIsCreatable is the
 * one place that decides it, and lib/generate-sql.ts asks the same function —
 * so the line on screen and the statement in the script cannot say different
 * things about the same type.
 */
function objectCreateNeedsManualWork(obj: ComparableObject): boolean | undefined {
  if (obj.kind !== "RANGE TYPE") return undefined;
  if (!obj.type) return undefined;
  return rangeTypeIsCreatable(obj.type) ? undefined : true;
}

/**
 * Whether changing this object is something a person has to do by hand.
 *
 * Two kinds, both because PostgreSQL offers no ALTER that does it — not
 * because of anything this app chose. A collation's provider and locale are
 * fixed at CREATE (the grammar has RENAME, OWNER and REFRESH VERSION and
 * nothing else), and a range type's subtype and options are fixed the same
 * way. Either one has to be dropped to be changed, which fails while a single
 * column still uses it, so every column has to be moved off it first — a plan,
 * not a statement.
 *
 * Types are the third case, and they are the awkward one: PostgreSQL has ALTER
 * for parts of an enum and parts of a domain, so "does this need a person"
 * depends on WHICH part changed. That question is answered once, by
 * typeChangeIsAllManual below, and the generator gates on the same function —
 * so the card that says "has to be replaced by hand" and the script that runs
 * nothing are one decision instead of two that drift.
 */
function objectChangeNeedsManualWork(
  obj: ComparableObject,
  peer: ComparableObject
): boolean | undefined {
  if (obj.kind === "COLLATION" || obj.kind === "RANGE TYPE") return true;
  if (obj.extension && peer.extension) {
    return !extensionUpdateIsForward(obj.extension.version, peer.extension.version);
  }
  if (obj.type && peer.type) return typeChangeIsAllManual(obj.type, peer.type);
  return undefined;
}

/**
 * Whether `ALTER EXTENSION ... UPDATE TO` can get the target from the version it
 * has to the one the source has.
 *
 * It only goes forwards. An extension is upgraded by running the little SQL
 * scripts its author shipped — pgcrypto--1.2--1.3.sql and so on — and almost
 * nobody ships the reverse ones, so asking PostgreSQL to go back a version
 * fails with "extension X has no update path". The generator writes a MANUAL
 * note instead of a statement in that case, and the report reads this same
 * answer off the diff rather than guessing from the text.
 *
 * Versions are compared segment by segment as numbers where both segments are
 * numbers, and give up where either is not — "1.10" is after "1.9", but
 * "2.1-beta" against "2.1-rc" is nobody's arithmetic. A version this cannot
 * order is treated as NOT forward, which costs a note where a statement might
 * have worked and never the other way around.
 *
 * A side that runs out of segments is read as 0, so "1.2.1" is after "1.2" and
 * "1.2" is the same version as "1.2.0". Reading the missing one as empty text
 * instead made a patch release unorderable against the release it patched — the
 * single commonest bump there is.
 */
/**
 * Whether syncing the target's access to the source's takes any of it away.
 *
 * "Takes away" means somebody who can do something today cannot do it once the
 * script has run: a grantee dropped entirely, a privilege revoked from one who
 * stays, a GRANT OPTION withdrawn, or the object handed to a different owner —
 * which moves the implicit right to drop and alter it along with everything
 * else an owner may do.
 *
 * This is the question the whole privileges comparison exists to answer, so it
 * is asked once here and read by both the report and the generator. Granting
 * MORE is not a loss: no GRANT can fail on the rows already in a table, and
 * nothing that works today stops working.
 *
 * Note the direction. `source` is the schema being copied FROM and `target` is
 * the one being changed, so the loss is anything the TARGET has that the source
 * does not — the reverse of how a first reading of the argument names suggests
 * it should go.
 */
export function privilegeChangeTakesAway(
  source: PrivilegeSnapshot,
  target: PrivilegeSnapshot
): boolean {
  if (source.owner !== target.owner) return true;
  const sourceByGrantee = new Map(source.grants.map((g) => [g.grantee, g]));
  for (const held of target.grants) {
    const kept = sourceByGrantee.get(held.grantee);
    // The grantee disappears altogether, so everything they had goes.
    if (!kept) return true;
    if (held.privileges.some((p) => !kept.privileges.includes(p))) return true;
    // A privilege they keep, but may no longer pass on. Smaller than losing the
    // privilege itself and still a thing they could do yesterday and cannot
    // today, which is the line this function draws.
    if (held.grantable.some((p) => !kept.grantable.includes(p))) return true;
  }
  return false;
}

export function extensionUpdateIsForward(source: string, target: string): boolean {
  const left = source.split(".");
  const right = target.split(".");
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const a = left[i] ?? "0";
    const b = right[i] ?? "0";
    if (a === b) continue;
    if (/^\d+$/.test(a) && /^\d+$/.test(b)) return Number(a) > Number(b);
    return false;
  }
  // Every segment matched, so the two versions are the same and there is
  // nothing to update — which is not a forward move.
  return false;
}

/**
 * True when nothing about this type change can be written as a statement — the
 * script can only leave a note saying what a person has to do.
 *
 * The generator calls this too, and it is the gate: everything it writes for a
 * changed type is written in the branches this returns false for. The cases:
 *
 *   - the kind changed (an enum in one schema, a domain in the other). Turning
 *     one into the other means dropping it, which fails while a column uses it.
 *   - an enum that gained no value. ADD VALUE is the only enum ALTER there is,
 *     so a reorder, or values the source does not have, leave nothing to run.
 *   - a domain whose base type moved. ALTER DOMAIN can change the NOT NULL and
 *     the named checks and nothing else.
 *   - a domain where none of those parts is what changed, so there is no ALTER
 *     to write.
 *   - a composite type. ALTER TYPE ... ADD/DROP ATTRIBUTE exists, but it fails
 *     on any type a table column already uses, which is every case worth
 *     scripting.
 */
export function typeChangeIsAllManual(left: TypeSnapshot, right: TypeSnapshot): boolean {
  if (left.kind !== right.kind) return true;

  if (left.kind === "ENUM") {
    const rightLabels = new Set(right.labels);
    return left.labels.every((label) => rightLabels.has(label));
  }

  if (left.kind === "DOMAIN") {
    if (left.baseType !== right.baseType) return true;
    if (left.notNull !== right.notNull) return false;
    const leftChecks = new Map(left.checks.map((check) => [check.name, check]));
    const anyDropped = right.checks.some((check) => {
      const source = leftChecks.get(check.name);
      return !source || source.expression !== check.expression;
    });
    if (anyDropped) return false;
    return domainAddedChecks(left, right).length === 0;
  }

  return true;
}

function compareObjectLists(
  left: ComparableObject[],
  right: ComparableObject[],
  leftScope: string,
  rightScope: string
): ObjectDiff[] {
  const diffs: ObjectDiff[] = [];
  const rightByKey = new Map(right.map((obj) => [obj.key, obj]));
  const matched = new Set<string>();

  for (const obj of left) {
    const peer = rightByKey.get(obj.key);
    if (!peer) {
      diffs.push({
        kind: obj.kind,
        name: obj.name,
        table: obj.table,
        status: "onlyA",
        summary: `${OBJECT_KIND_LABEL[obj.kind]} ${obj.name} exists only in ${leftScope}.`,
        leftDefinition: obj.definition,
        severity: objectCreateSeverity(obj),
        needsManualWork: objectCreateNeedsManualWork(obj),
      });
      continue;
    }

    matched.add(obj.key);

    // The kind check matters for views: turning a view into a materialized view
    // keeps the name and the SELECT, so a definition-only comparison would
    // report nothing while the object type changed underneath.
    if (obj.kind !== peer.kind) {
      diffs.push({
        kind: obj.kind,
        name: obj.name,
        table: obj.table,
        status: "changedDefinition",
        summary:
          `${OBJECT_KIND_LABEL[obj.kind]} ${obj.name} is a ` +
          `${OBJECT_KIND_LABEL[peer.kind].toLowerCase()} in ${rightScope}.`,
        leftDefinition: obj.definition,
        rightDefinition: peer.definition,
        // A view that became a materialized view, or the reverse. The old one
        // has to be dropped for the new one to take its name, so it is graded
        // as a drop and not as a definition change.
        severity: objectDropSeverity(peer),
        // Which is a thing the script can do for a view, and cannot for a type:
        // dropping an enum that became a domain fails while any column still
        // uses it, so the columns have to be moved first. Asked here as well as
        // below, because this branch is the only one a kind change reaches.
        needsManualWork: objectChangeNeedsManualWork(obj, peer),
        replaceNeedsDrop: true,
        dropDestroysData: dropDestroysData(peer),
      });
      continue;
    }

    if (obj.normalizedDefinition !== peer.normalizedDefinition) {
      diffs.push({
        kind: obj.kind,
        name: obj.name,
        table: obj.table,
        status: "changedDefinition",
        summary: `${OBJECT_KIND_LABEL[obj.kind]} ${obj.name} changed definition.`,
        leftDefinition: obj.definition,
        rightDefinition: peer.definition,
        severity: objectChangeSeverity(obj, peer),
        needsManualWork: objectChangeNeedsManualWork(obj, peer),
        replaceNeedsDrop:
          obj.routine && peer.routine
            ? routineReplaceNeedsDrop(obj.routine, peer.routine)
            : obj.view && peer.view
              ? viewReplaceNeedsDrop(obj.view, peer.view)
              : undefined,
        // A matview always needs the drop, so a changed one always loses its
        // rows. A plain view replaced in place is never dropped at all.
        dropDestroysData: dropDestroysData(peer),
      });
    }
  }

  for (const obj of right) {
    if (matched.has(obj.key)) continue;
    diffs.push({
      kind: obj.kind,
      name: obj.name,
      table: obj.table,
      status: "onlyB",
      summary: `${OBJECT_KIND_LABEL[obj.kind]} ${obj.name} exists only in ${rightScope}.`,
      rightDefinition: obj.definition,
      severity: objectDropSeverity(obj),
      dropDestroysData: dropDestroysData(obj),
    });
  }

  return diffs;
}

/**
 * What indexObjects and triggerObjects need from the thing they are given.
 *
 * A table is not the only relation that carries these. A materialized view is
 * indexed like a table, and a plain view carries the INSTEAD OF triggers that
 * are the whole reason it can be written to — so both functions take the shape
 * rather than the TableSnapshot they used to.
 */
type IndexedRelation = { name: string; indexes?: IndexSnapshot[] };
type TriggeredRelation = { name: string; triggers?: TriggerSnapshot[] };

function indexObjects(relation: IndexedRelation): ComparableObject[] {
  return (relation.indexes ?? []).map((index) => ({
    key: normalizeIdentifier(index.name),
    kind: "INDEX" as const,
    name: index.name,
    definition: index.definition,
    normalizedDefinition: index.normalizedDefinition,
    table: relation.name,
    enforcesUniqueness: index.isUnique,
  }));
}

function triggerObjects(relation: TriggeredRelation): ComparableObject[] {
  return (relation.triggers ?? []).map((trigger) => ({
    key: normalizeIdentifier(trigger.name),
    kind: "TRIGGER" as const,
    name: trigger.name,
    definition: trigger.definition,
    // A disabled trigger and an enabled one with the same body are not the same
    // thing, and pg_get_triggerdef() does not say which it is.
    normalizedDefinition: `${trigger.normalizedDefinition}${trigger.enabled ? "" : " [DISABLED]"}`,
    table: relation.name,
  }));
}

function policyObjects(table: TableSnapshot): ComparableObject[] {
  return (table.rowSecurity?.policies ?? []).map((policy) => ({
    key: normalizeIdentifier(policy.name),
    kind: "POLICY" as const,
    name: policy.name,
    definition: policy.definition,
    normalizedDefinition: policy.normalizedDefinition,
    table: table.name,
  }));
}

/**
 * The row-security switch as a one-element list, so it rides the same
 * compare-two-lists machinery as everything else.
 *
 * Always exactly one element when the snapshot recorded row security, so the
 * two sides always match on key and the only status it can ever produce is
 * "changedDefinition" — there is no such thing as a table that has a switch in
 * one schema and no switch in the other.
 */
/**
 * The row-security switch as one short phrase.
 *
 * Exported because the report card for a brand-new table has to say the same
 * thing about the same switch — a table created with RLS on is one the reader
 * must be told about, and two places writing that sentence separately is how
 * they end up disagreeing.
 */
export function describeRowSecurity(rls: RowSecuritySnapshot): string {
  return !rls.enabled ? "DISABLED" : rls.forced ? "ENABLED, FORCED" : "ENABLED";
}

function rowSecurityObjects(table: TableSnapshot): ComparableObject[] {
  const rls = table.rowSecurity;
  if (!rls) return [];

  const state = describeRowSecurity(rls);
  return [
    {
      key: "row security",
      kind: "ROW SECURITY" as const,
      name: table.name,
      definition: state,
      normalizedDefinition: state,
      table: table.name,
    },
  ];
}

/**
 * How a table is partitioned, written the way it would appear in the CREATE
 * TABLE that produced it. "standalone" for an ordinary table, so the two sides
 * of a comparison always have something to differ on.
 */
export function describePartitioning(part: TablePartitioning): string {
  const parts: string[] = [];
  if (part.partitionOf) {
    parts.push(`PARTITION OF ${part.partitionOf} ${part.bounds ?? ""}`.trim());
  }
  if (part.inherits.length > 0) {
    parts.push(`INHERITS (${part.inherits.join(", ")})`);
  }
  if (part.key) {
    parts.push(`PARTITION BY ${part.key}`);
  }
  return parts.length > 0 ? parts.join(" ") : "standalone";
}

/**
 * Partitioning as a one-element list, for the same reason as the row-security
 * switch above: every table has exactly one answer to "how is this table
 * partitioned", so the only status this can produce is "changedDefinition".
 */
function partitioningObjects(table: TableSnapshot): ComparableObject[] {
  const part = table.partitioning;
  if (!part) return [];

  const state = describePartitioning(part);
  return [
    {
      key: "partitioning",
      kind: "PARTITIONING" as const,
      name: table.name,
      definition: state,
      normalizedDefinition: state,
      table: table.name,
    },
  ];
}

/**
 * A view's `WITH (...)` clause, or "" when it has none.
 *
 * `undefined` options means the snapshot predates this app reading them, which
 * is not the same as a view with no options — the caller decides whether to ask
 * at all, so this only ever renders what was actually recorded.
 */
export function viewOptionsClause(view: ViewSnapshot): string {
  const options = view.options;
  if (!options || options.length === 0) return "";
  return `WITH (${options.join(", ")})`;
}

/**
 * @param withOptions whether BOTH snapshots recorded reloptions. When one did
 * not, the options are left out of the compared text entirely: folding a
 * missing list in as "no options" would report every view in an older snapshot
 * as having lost its security_invoker.
 */
/**
 * Whether a changed view has to be DROPPED before it can be written again.
 *
 * CREATE OR REPLACE VIEW refuses any change to the column list, and
 * CREATE MATERIALIZED VIEW IF NOT EXISTS finds the old one there and does
 * nothing at all, so the answer is almost always yes. The exception is a plain
 * view whose SELECT is unchanged and whose WITH (...) settings are not:
 * CREATE OR REPLACE swaps the option list in place, and not dropping it means
 * its CASCADE cannot reach the views built on top of it.
 *
 * Decided here so the statement the generator writes and the sentence the
 * report prints come from one rule instead of two.
 */
export function viewReplaceNeedsDrop(left: ViewSnapshot, right: ViewSnapshot): boolean {
  if (left.materialized || right.materialized) return true;
  return left.normalizedDefinition !== right.normalizedDefinition;
}

/**
 * Whether dropping this object throws stored rows away.
 *
 * A materialized view keeps its own copy of the result set, so dropping one
 * loses data exactly as dropping a table does. Everything else here — a plain
 * view, an index, a routine — is derived from something that survives.
 */
function dropDestroysData(obj: ComparableObject): boolean {
  return obj.view?.materialized === true;
}

function viewObjects(views: ViewSnapshot[], withOptions: boolean): ComparableObject[] {
  return views.map((view) => {
    const clause = withOptions ? viewOptionsClause(view) : "";
    // The clause goes in front of the body, which is where it is written in
    // the CREATE statement, so a diff of the two texts reads the way the SQL
    // does rather than putting the setting after a hundred lines of SELECT.
    const definition = clause ? `${clause}\n${view.definition}` : view.definition;
    return {
      key: normalizeIdentifier(view.name),
      kind: view.materialized ? ("MATERIALIZED VIEW" as const) : ("VIEW" as const),
      name: view.name,
      definition,
      normalizedDefinition: clause
        ? `${clause} ${view.normalizedDefinition}`
        : view.normalizedDefinition,
      view,
    };
  });
}

function describeSequence(sequence: SequenceSnapshot): string {
  return [
    `AS ${sequence.dataType}`,
    `START ${sequence.startValue}`,
    `INCREMENT ${sequence.increment}`,
    `MINVALUE ${sequence.minValue}`,
    `MAXVALUE ${sequence.maxValue}`,
    `CACHE ${sequence.cacheSize}`,
    sequence.cycles ? "CYCLE" : "NO CYCLE",
  ].join(" ");
}

/**
 * Whether this sequence is an object in its own right rather than the machinery
 * behind a `serial` or IDENTITY column.
 *
 * A sequence owned by a column exists BECAUSE of that column: it is created by
 * `serial`/IDENTITY and dropped with it. The column is already compared, so
 * reporting the sequence too would show one added serial column as two separate
 * differences — and a migration must never emit CREATE SEQUENCE for it.
 *
 * Exported because the summary matrix has to count the same sequences this
 * comparison looked at. Counting the raw snapshot length there reported six
 * serial primary keys as six sequences "in sync" — asserting a comparison that
 * never ran, and saying it loudest when the target had none of those tables.
 */
export function isStandaloneSequence(sequence: SequenceSnapshot): boolean {
  return sequence.ownedByTable === null;
}

function sequenceObjects(sequences: SequenceSnapshot[]): ComparableObject[] {
  return (
    sequences
      .filter(isStandaloneSequence)
      .map((sequence) => ({
        key: normalizeIdentifier(sequence.name),
        kind: "SEQUENCE" as const,
        name: sequence.name,
        definition: describeSequence(sequence),
        normalizedDefinition: describeSequence(sequence),
      }))
  );
}

function typeObjectKind(type: TypeSnapshot): ObjectKind {
  if (type.kind === "ENUM") return "ENUM";
  if (type.kind === "DOMAIN") return "DOMAIN";
  if (type.kind === "COMPOSITE") return "COMPOSITE TYPE";
  return "RANGE TYPE";
}

function typeObjects(types: TypeSnapshot[]): ComparableObject[] {
  return types.map((type) => ({
    key: normalizeIdentifier(type.name),
    kind: typeObjectKind(type),
    name: type.name,
    definition: type.definition,
    normalizedDefinition: type.normalizedDefinition,
    type,
  }));
}

function collationObjects(collations: CollationSnapshot[]): ComparableObject[] {
  return collations.map((collation) => ({
    key: normalizeIdentifier(collation.name),
    kind: "COLLATION" as const,
    name: collation.name,
    definition: collation.definition,
    normalizedDefinition: collation.normalizedDefinition,
    collation,
  }));
}

/**
 * Privilege entries flattened for comparison.
 *
 * The name carries the object kind — "table orders", "schema app" — because
 * the names are only unique WITHIN a kind. A table and a sequence in one schema
 * may both be called "orders", and matching them to each other would report one
 * as having become the other.
 */
function privilegeObjects(privileges: PrivilegeSnapshot[]): ComparableObject[] {
  return privileges.map((privilege) => {
    // A routine's arguments are what tell two overloads apart, so they are part
    // of both the name on screen and the identity the match is made on.
    const args =
      privilege.identityArguments === undefined
        ? ""
        : `(${privilege.identityArguments})`;
    const name =
      `${privilege.objectKind.toLowerCase()} ${privilege.objectName}${args}`;
    return {
      // The schema entry is keyed on its kind alone. There is exactly one per
      // snapshot and it IS the schema being compared, so the two sides match
      // whatever they are called — keying it by name made a comparison of two
      // differently-named schemas report the source's schema grants as newly
      // added and the target's as nothing at all, which is every run of this
      // tool that compares "public" against anything.
      key:
        privilege.objectKind === "SCHEMA"
          ? "SCHEMA"
          : `${privilege.objectKind}\u0000` +
            `${normalizeIdentifier(privilege.objectName)}\u0000${args}`,
      kind: "PRIVILEGES" as const,
      name,
      definition: privilege.definition,
      normalizedDefinition: privilege.normalizedDefinition,
      privilege,
    };
  });
}

function extensionObjects(extensions: ExtensionSnapshot[]): ComparableObject[] {
  return extensions.map((extension) => ({
    key: normalizeIdentifier(extension.name),
    kind: "EXTENSION" as const,
    name: extension.name,
    definition: extension.definition,
    normalizedDefinition: extension.normalizedDefinition,
    extension,
  }));
}

function routineObjects(routines: RoutineSnapshot[]): ComparableObject[] {
  return routines.map((routine) => ({
    // Postgres allows overloads, so the identity is the signature, not the name.
    key: normalizeIdentifier(routine.signature),
    kind: routine.kind === "PROCEDURE" ? ("PROCEDURE" as const) : ("FUNCTION" as const),
    name: routine.signature,
    definition: routine.definition,
    normalizedDefinition: routine.normalizedDefinition,
    routine,
  }));
}

/** Indexes and triggers, which belong to one table. */
/**
 * Indexes, triggers and row security, which belong to one table.
 *
 * The two scope names are the SCHEMAS, not the tables. They only ever appear in
 * the "exists only in X" summary, and naming the table there made every line
 * read as if the object were somewhere inside the table it is already listed
 * under — "Index ix_code exists only in orders" says nothing about which of the
 * two schemas has it, which is the entire question.
 */
function compareTableObjects(
  left: TableSnapshot,
  right: TableSnapshot,
  leftSchema: string,
  rightSchema: string
): ObjectDiff[] {
  const diffs: ObjectDiff[] = [];

  if (left.indexes && right.indexes) {
    diffs.push(...compareObjectLists(indexObjects(left), indexObjects(right), leftSchema, rightSchema));
  }
  if (left.triggers && right.triggers) {
    diffs.push(...compareObjectLists(triggerObjects(left), triggerObjects(right), leftSchema, rightSchema));
  }
  if (left.rowSecurity && right.rowSecurity) {
    diffs.push(
      ...compareObjectLists(rowSecurityObjects(left), rowSecurityObjects(right), leftSchema, rightSchema)
    );
    diffs.push(...compareObjectLists(policyObjects(left), policyObjects(right), leftSchema, rightSchema));
  }
  if (left.partitioning && right.partitioning) {
    diffs.push(
      ...compareObjectLists(
        partitioningObjects(left),
        partitioningObjects(right),
        leftSchema,
        rightSchema
      )
    );
  }

  return diffs;
}

/**
 * Indexes and triggers on views that exist in both schemas.
 *
 * They are the same two kinds of object a table carries, so they are compared
 * with the same two functions and reported under the same two matrix rows —
 * the only difference is what they hang off, which the diff records in `table`
 * exactly as it does for a table's own.
 *
 * Views are matched by name and nothing else. There is no similarity matching
 * for views, so a renamed view is a drop and an add, and its indexes go with
 * it: not compared here, and created or dropped alongside the view itself.
 */
function compareViewRelationObjects(
  left: SchemaSnapshot,
  right: SchemaSnapshot
): ObjectDiff[] {
  const diffs: ObjectDiff[] = [];
  const rightByKey = new Map(
    (right.views ?? []).map((view) => [normalizeIdentifier(view.name), view])
  );

  for (const view of left.views ?? []) {
    const peer = rightByKey.get(normalizeIdentifier(view.name));
    if (!peer) continue;

    // Both sides, separately, for each kind: a snapshot captured before views
    // recorded their indexes says `undefined`, which is not "there are none".
    if (view.indexes && peer.indexes) {
      diffs.push(
        ...compareObjectLists(
          indexObjects(view),
          indexObjects(peer),
          left.schema,
          right.schema
        )
      );
    }
    if (view.triggers && peer.triggers) {
      diffs.push(
        ...compareObjectLists(
          triggerObjects(view),
          triggerObjects(peer),
          left.schema,
          right.schema
        )
      );
    }
  }

  return diffs;
}

/**
 * Views, sequences, types, collations, extensions and routines, which belong to
 * the schema.
 */
function compareSchemaObjects(left: SchemaSnapshot, right: SchemaSnapshot): ObjectDiff[] {
  const diffs: ObjectDiff[] = [];

  // Ahead of even the collations. An extension installs types, collations and
  // functions of its own, and every one of those is deliberately skipped by the
  // snapshot — so the extension is the only record that they exist, and the
  // statement that installs it has to come before anything that might name one.
  if (left.extensions && right.extensions) {
    diffs.push(
      ...compareObjectLists(
        extensionObjects(left.extensions),
        extensionObjects(right.extensions),
        left.schema,
        right.schema
      )
    );
  }

  // Second in the list on purpose. A column, a domain and an index can all name
  // a collation, so the statement that creates one has to come before them —
  // and the generator emits object statements in the order they arrive here.
  if (left.collations && right.collations) {
    diffs.push(
      ...compareObjectLists(
        collationObjects(left.collations),
        collationObjects(right.collations),
        left.schema,
        right.schema
      )
    );
  }

  if (left.privileges && right.privileges) {
    // Entries the target has and the source does not are dropped rather than
    // reported. An object that exists only in the target is one the script is
    // already dropping, and its grants go with it — so "revoke everything on a
    // table that will not be there" is noise, not a difference to fix. What
    // remains is real work: the objects both sides have, and the ones the
    // script is creating and has to grant access on.
    const sourceEntries = privilegeObjects(left.privileges);
    const sourceKeys = new Set(sourceEntries.map((obj) => obj.key));
    diffs.push(
      ...compareObjectLists(
        sourceEntries,
        privilegeObjects(right.privileges).filter((obj) => sourceKeys.has(obj.key)),
        left.schema,
        right.schema
      )
    );
  }

  if (left.views && right.views) {
    // Options are compared only when both sides recorded them — see viewObjects.
    const withOptions =
      left.views.every((v) => v.options !== undefined) &&
      right.views.every((v) => v.options !== undefined);
    diffs.push(
      ...compareObjectLists(
        viewObjects(left.views, withOptions),
        viewObjects(right.views, withOptions),
        left.schema,
        right.schema
      )
    );
    diffs.push(...compareViewRelationObjects(left, right));
  }
  if (left.sequences && right.sequences) {
    diffs.push(
      ...compareObjectLists(sequenceObjects(left.sequences), sequenceObjects(right.sequences), left.schema, right.schema)
    );
  }
  if (left.types && right.types) {
    diffs.push(...compareObjectLists(typeObjects(left.types), typeObjects(right.types), left.schema, right.schema));
  }
  if (left.routines && right.routines) {
    diffs.push(
      ...compareObjectLists(routineObjects(left.routines), routineObjects(right.routines), left.schema, right.schema)
    );
  }

  return diffs;
}

/**
 * Which categories were actually compared, and for the rest, WHY not.
 *
 * A table-scoped category counts as compared when at least one matched pair of
 * tables recorded it on both sides. That makes an empty matchedTables list turn
 * indexes, triggers, row security and partitioning off — correctly, since no
 * comparison ran — but for a completely different reason than a stale snapshot,
 * and every screen used to print the stale-snapshot reason regardless. So the
 * reason is decided here, once, alongside the flag it explains.
 */
function comparedCategories(
  left: SchemaSnapshot,
  right: SchemaSnapshot,
  matchedTables: TableMatch[]
): ComparedObjectCategories {
  const reasons: Partial<Record<ObjectCategoryKey, NotComparedReason>> = {};

  /** Record a schema-scoped category: only a missing snapshot can turn it off. */
  function schemaScoped(key: ObjectCategoryKey, compared: boolean): boolean {
    if (!compared) reasons[key] = "snapshotPredatesCategory";
    return compared;
  }

  // Views matched by name, for the two categories a view can also carry. A
  // schema with no matched table but a matched materialized view HAS compared
  // its indexes, and "not compared — no matched tables" over a row holding real
  // numbers is a contradiction the reader has no way to resolve.
  const matchedViews: Array<[ViewSnapshot, ViewSnapshot]> = [];
  if (left.views && right.views) {
    const rightByKey = new Map(
      right.views.map((view) => [normalizeIdentifier(view.name), view])
    );
    for (const view of left.views) {
      const peer = rightByKey.get(normalizeIdentifier(view.name));
      if (peer) matchedViews.push([view, peer]);
    }
  }

  /**
   * Record a table-scoped category, which has two ways to be off. With no
   * matched pair at all, no snapshot is at fault — there was nothing to
   * compare. Only when pairs exist and none of them recorded the category on
   * both sides is a snapshot actually too old.
   *
   * `recordedOnView` is passed only for the categories a view can carry —
   * indexes and triggers — and only ever consulted when there is no matched
   * table at all. That order is deliberate. Matched tables that exist but
   * recorded nothing ARE a stale snapshot, whatever the views say: answering
   * "compared" there would put a row of numbers on screen that silently leaves
   * every table's indexes out of them. The views only decide the case the
   * tables cannot speak to, which is a schema of nothing but views — where
   * "not compared, no matched tables" would sit directly above a real count.
   */
  function tableScoped(
    key: ObjectCategoryKey,
    recorded: (m: TableMatch) => boolean,
    recordedOnView?: (left: ViewSnapshot, right: ViewSnapshot) => boolean
  ): boolean {
    if (matchedTables.some(recorded)) return true;
    if (matchedTables.length > 0) {
      reasons[key] = "snapshotPredatesCategory";
      return false;
    }
    const viewPairs = recordedOnView ? matchedViews : [];
    if (viewPairs.some(([l, r]) => recordedOnView?.(l, r))) return true;
    reasons[key] =
      viewPairs.length === 0 ? "noMatchedTables" : "snapshotPredatesCategory";
    return false;
  }

  return {
    indexes: tableScoped(
      "indexes",
      (m) => Boolean(m.left.indexes && m.right.indexes),
      (l, r) => Boolean(l.indexes && r.indexes)
    ),
    triggers: tableScoped(
      "triggers",
      (m) => Boolean(m.left.triggers && m.right.triggers),
      (l, r) => Boolean(l.triggers && r.triggers)
    ),
    views: schemaScoped("views", Boolean(left.views && right.views)),
    sequences: schemaScoped("sequences", Boolean(left.sequences && right.sequences)),
    types: schemaScoped("types", Boolean(left.types && right.types)),
    collations: schemaScoped("collations", Boolean(left.collations && right.collations)),
    extensions: schemaScoped("extensions", Boolean(left.extensions && right.extensions)),
    routines: schemaScoped("routines", Boolean(left.routines && right.routines)),
    rowSecurity: tableScoped("rowSecurity", (m) =>
      Boolean(m.left.rowSecurity && m.right.rowSecurity)
    ),
    partitioning: tableScoped("partitioning", (m) =>
      Boolean(m.left.partitioning && m.right.partitioning)
    ),
    privileges: schemaScoped("privileges", Boolean(left.privileges && right.privileges)),
    reasons,
  };
}

// ============================================================================
// Matched-table assembly
// ============================================================================

function compareMatchedTables(
  left: TableSnapshot,
  right: TableSnapshot,
  score: number,
  exact: boolean,
  breakdown: ScoreBreakdown,
  leftSchema: string,
  rightSchema: string
): TableMatch {
  const columnResult    = compareColumns(left, right);
  const constraintDiffs = compareConstraints(left, right, leftSchema, rightSchema);
  const objectDiffs     = compareTableObjects(left, right, leftSchema, rightSchema);

  const changedSections = new Set<string>();
  if (columnResult.columnsOnlyInA.length > 0 || columnResult.columnsOnlyInB.length > 0 || columnResult.columnMatches.some((m) => m.changes.length > 0)) changedSections.add("Columns");
  if (constraintDiffs.some((d) => d.kind === "PRIMARY KEY"))   changedSections.add("Primary key");
  if (constraintDiffs.some((d) => d.kind === "UNIQUE"))        changedSections.add("Unique constraints");
  if (constraintDiffs.some((d) => d.kind === "FOREIGN KEY"))   changedSections.add("Foreign keys");
  if (constraintDiffs.some((d) => d.kind === "CHECK"))         changedSections.add("Check constraints");
  if (constraintDiffs.some((d) => d.kind === "EXCLUDE"))       changedSections.add("Exclude constraints");
  if (objectDiffs.some((d) => d.kind === "INDEX"))             changedSections.add("Indexes");
  if (objectDiffs.some((d) => d.kind === "TRIGGER"))           changedSections.add("Triggers");
  if (objectDiffs.some((d) => d.kind === "POLICY" || d.kind === "ROW SECURITY")) changedSections.add("Row security");
  if (objectDiffs.some((d) => d.kind === "PARTITIONING")) changedSections.add("Partitioning");
  if (!exact)                                                   changedSections.add("Similarity matched");

  return {
    left, right, score, exact, breakdown,
    columnMatches:        columnResult.columnMatches,
    columnsOnlyInA:       columnResult.columnsOnlyInA,
    columnsOnlyInB:       columnResult.columnsOnlyInB,
    possibleColumnMatches: columnResult.possibleColumnMatches,
    constraintDiffs,
    objectDiffs,
    changedSections: Array.from(changedSections),
    hasChanges:
      !exact ||
      columnResult.columnsOnlyInA.length > 0 ||
      columnResult.columnsOnlyInB.length > 0 ||
      columnResult.columnMatches.some((m) => m.changes.length > 0) ||
      constraintDiffs.length > 0 ||
      // Indexes and triggers count as drift. Nothing in Postgres creates either
      // behind your back — unlike planner statistics, which is why row counts
      // are deliberately kept out of this (see compare-data.ts).
      objectDiffs.length > 0,
  };
}

// ============================================================================
// Public API
// ============================================================================

export function compareSchemas(left: SchemaSnapshot, right: SchemaSnapshot): CompareReport {
  // Build the "who references me?" index once per schema. Every pairwise
  // table comparison below reuses these maps, so we don't pay O(n²) cost.
  const leftIncoming  = buildIncomingForeignKeyMap(left);
  const rightIncoming = buildIncomingForeignKeyMap(right);

  const rightByName       = new Map(right.tables.map((t) => [normalizeIdentifier(t.name), t]));
  const matchedRightNames = new Set<string>();
  const matchedTables: TableMatch[] = [];

  // 1. Exact name matches
  for (const leftTable of left.tables) {
    const rightTable = rightByName.get(normalizeIdentifier(leftTable.name));
    if (!rightTable) continue;

    const scoreResult = compareTablePair(leftTable, rightTable, leftIncoming, rightIncoming, left.schema, right.schema);
    matchedRightNames.add(normalizeIdentifier(rightTable.name));
    matchedTables.push(compareMatchedTables(leftTable, rightTable, scoreResult.score, true, scoreResult.breakdown, left.schema, right.schema));
  }

  // 2. Similarity matching on unmatched tables
  const leftForSimilarity  = left.tables.filter((t) => !rightByName.has(normalizeIdentifier(t.name)));
  const rightForSimilarity = right.tables.filter((t) => !matchedRightNames.has(normalizeIdentifier(t.name)));

  const similarityResults = getBestMatches(
    leftForSimilarity,
    rightForSimilarity,
    (leftTable, rightTable) => compareTablePair(leftTable, rightTable, leftIncoming, rightIncoming, left.schema, right.schema),
    TABLE_MATCH_ACCEPT_THRESHOLD,
    TABLE_MATCH_POSSIBLE_THRESHOLD,
    "table",
    (t) => t.name,
    (t) => t.name,
    // Auto-accept a rename only when the names are alike or one contains the
    // other; otherwise surface it as a review candidate (issue #7).
    (leftTable, rightTable) => tableNameRenameGuard(leftTable.name, rightTable.name)
  );

  for (const match of similarityResults.accepted) {
    matchedTables.push(compareMatchedTables(match.left, match.right, match.score, false, match.breakdown, left.schema, right.schema));
  }

  const changedTables        = matchedTables.filter((t) => t.hasChanges).length;
  const changedConstraints   = matchedTables.reduce((sum, t) => sum + t.constraintDiffs.length, 0);
  const likelyRenameCandidates =
    matchedTables.filter((t) => !t.exact).length + similarityResults.possible.length;

  // 3. Objects that belong to the schema rather than to one table.
  const schemaObjectDiffs = compareSchemaObjects(left, right);
  const changedObjects =
    schemaObjectDiffs.length +
    matchedTables.reduce((sum, t) => sum + t.objectDiffs.length, 0);

  return {
    left,
    right,
    matchedTables: matchedTables.sort((a, b) => a.left.name.localeCompare(b.left.name)),
    tablesOnlyInA: similarityResults.leftOnly.sort((a, b) => a.name.localeCompare(b.name)),
    tablesOnlyInB: similarityResults.rightOnly.sort((a, b) => a.name.localeCompare(b.name)),
    possibleTableMatches: similarityResults.possible.sort(
      (a, b) => b.score - a.score || a.leftName.localeCompare(b.leftName)
    ),
    objectDiffs: schemaObjectDiffs.sort(
      (a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name)
    ),
    comparedObjectCategories: comparedCategories(left, right, matchedTables),
    summary: {
      tablesOnlyInA: similarityResults.leftOnly.length,
      tablesOnlyInB: similarityResults.rightOnly.length,
      changedTables,
      changedConstraints,
      likelyRenameCandidates,
      identicalTables: matchedTables.filter((t) => !t.hasChanges).length,
      changedObjects,
    },
  };
}

// ============================================================================
// UI helper exports
// ============================================================================

export function describeConstraint(constraint: ConstraintLike): string {
  if (constraint.kind === "FOREIGN KEY") {
    return `${constraint.name}: (${constraint.columns.join(", ")}) -> ${constraint.referencedTable ?? "unknown"} (${constraint.referencedColumns.join(", ")})`;
  }
  if (constraint.columns.length > 0) {
    return `${constraint.name}: ${constraint.columns.join(", ")}`;
  }
  return `${constraint.name}: ${constraint.definition}`;
}
