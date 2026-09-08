import type {
  ColumnSnapshot,
  ConstraintSnapshot,
  ForeignKeySnapshot,
  SchemaSnapshot,
  TableSnapshot,
} from "./postgres";

import type {
  ColumnMatch,
  CompareReport,
  ConstraintDiff,
  MatchCandidate,
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
  CompareReport,
  ConstraintDiff,
  MatchCandidate,
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

// Exported so the UI can display each dimension as a % of its maximum.
// If you change WEIGHTS.table above, this updates automatically.
export const TABLE_DIMENSION_MAX = {
  name:          WEIGHTS.table.name,
  constraints:   WEIGHTS.table.constraints,
  columns:       WEIGHTS.table.columns,
  relationships: WEIGHTS.table.relationships,
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
type MatchDecision = "accepted" | "possible";

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

function matchDecision(score: number, acceptedThreshold: number): MatchDecision {
  return score >= acceptedThreshold ? "accepted" : "possible";
}

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

function compareColumnPair(
  leftTable: TableSnapshot,
  leftColumn: ColumnSnapshot,
  rightTable: TableSnapshot,
  rightColumn: ColumnSnapshot
): {
  score: number;
  breakdown: ScoreBreakdown;
  changes: string[];
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

  const changes: string[] = [];

  if (normalizeType(leftColumn.typeDisplay) !== normalizeType(rightColumn.typeDisplay)) {
    changes.push(typeChangeDescription(leftColumn.typeDisplay, rightColumn.typeDisplay));
  }
  if (leftColumn.nullable !== rightColumn.nullable) {
    changes.push(
      `Nullability changed from ${leftColumn.nullable ? "nullable" : "not null"} to ${rightColumn.nullable ? "nullable" : "not null"}`
    );
  }
  // Column default drift. Defaults are already schema-relative (own-schema
  // qualifier stripped at snapshot time), so a plain text compare is safe. Skip
  // ONLY when BOTH sides are serial/identity nextval defaults — that pair is pure
  // sequence-name noise. When exactly one side is serial, it IS a real change
  // (e.g. source is serial, target has no default) and must be reported.
  if (!(isNextvalDefault(leftColumn.columnDefault) && isNextvalDefault(rightColumn.columnDefault))) {
    const leftDefault = leftColumn.columnDefault?.trim() || null;
    const rightDefault = rightColumn.columnDefault?.trim() || null;
    if (leftDefault !== rightDefault) {
      // left→right, matching the nullability/type wording in this same list.
      changes.push(`Default changed from ${leftDefault ?? "none"} to ${rightDefault ?? "none"}`);
    }
  }
  // NOTE: column ORDER is deliberately NOT recorded as a change. PostgreSQL
  // cannot reorder columns in place, so no migration statement can resolve it —
  // counting it as a change made a table report differences forever even after a
  // full sync (phantom drift, issue #18). Order still influences the match SCORE
  // via columnOrderSimilarity; it just isn't a reported, "fixable" change.
  if (leftColumn.isPrimaryKey !== rightColumn.isPrimaryKey) {
    changes.push("Primary key participation changed");
  }
  if (Math.sign(leftColumn.uniqueConstraintNames.length) !== Math.sign(rightColumn.uniqueConstraintNames.length)) {
    changes.push("Unique constraint participation changed");
  }
  if (Math.sign(leftColumn.foreignKeyConstraintNames.length) !== Math.sign(rightColumn.foreignKeyConstraintNames.length)) {
    changes.push("Foreign key participation changed");
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

  const changedSections = new Set<string>();
  if (columnResult.columnsOnlyInA.length > 0 || columnResult.columnsOnlyInB.length > 0 || columnResult.columnMatches.some((m) => m.changes.length > 0)) changedSections.add("Columns");
  if (constraintDiffs.some((d) => d.kind === "PRIMARY KEY"))   changedSections.add("Primary key");
  if (constraintDiffs.some((d) => d.kind === "UNIQUE"))        changedSections.add("Unique constraints");
  if (constraintDiffs.some((d) => d.kind === "FOREIGN KEY"))   changedSections.add("Foreign keys");
  if (constraintDiffs.some((d) => d.kind === "CHECK"))         changedSections.add("Check constraints");
  if (constraintDiffs.some((d) => d.kind === "EXCLUDE"))       changedSections.add("Exclude constraints");
  if (!exact)                                                   changedSections.add("Similarity matched");

  return {
    left, right, score, exact, breakdown,
    columnMatches:        columnResult.columnMatches,
    columnsOnlyInA:       columnResult.columnsOnlyInA,
    columnsOnlyInB:       columnResult.columnsOnlyInB,
    possibleColumnMatches: columnResult.possibleColumnMatches,
    constraintDiffs,
    changedSections: Array.from(changedSections),
    hasChanges:
      !exact ||
      columnResult.columnsOnlyInA.length > 0 ||
      columnResult.columnsOnlyInB.length > 0 ||
      columnResult.columnMatches.some((m) => m.changes.length > 0) ||
      constraintDiffs.length > 0,
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

  return {
    left,
    right,
    matchedTables: matchedTables.sort((a, b) => a.left.name.localeCompare(b.left.name)),
    tablesOnlyInA: similarityResults.leftOnly.sort((a, b) => a.name.localeCompare(b.name)),
    tablesOnlyInB: similarityResults.rightOnly.sort((a, b) => a.name.localeCompare(b.name)),
    possibleTableMatches: similarityResults.possible.sort(
      (a, b) => b.score - a.score || a.leftName.localeCompare(b.leftName)
    ),
    summary: {
      tablesOnlyInA: similarityResults.leftOnly.length,
      tablesOnlyInB: similarityResults.rightOnly.length,
      changedTables,
      changedConstraints,
      likelyRenameCandidates,
      identicalTables: matchedTables.filter((t) => !t.hasChanges).length,
    },
  };
}

// ============================================================================
// UI helper exports (used by page.tsx)
// ============================================================================

export function summarizeColumns(columns: ColumnSnapshot[]): string {
  if (columns.length === 0) return "None";
  return columns.map((col) => `${col.name} (${col.typeDisplay})`).join(", ");
}

export function describeConstraint(constraint: ConstraintLike): string {
  if (constraint.kind === "FOREIGN KEY") {
    return `${constraint.name}: (${constraint.columns.join(", ")}) -> ${constraint.referencedTable ?? "unknown"} (${constraint.referencedColumns.join(", ")})`;
  }
  if (constraint.columns.length > 0) {
    return `${constraint.name}: ${constraint.columns.join(", ")}`;
  }
  return `${constraint.name}: ${constraint.definition}`;
}

export function describeTableMatch(tableMatch: TableMatch): string {
  if (tableMatch.exact) {
    if (!tableMatch.hasChanges && tableMatch.score === 100) {
      return "Exact table name match with identical structure.";
    }
    return `Matched by exact table name. Structural similarity score: ${tableMatch.score}%.`;
  }

  const decision  = matchDecision(tableMatch.score, TABLE_MATCH_ACCEPT_THRESHOLD);
  const qualifier = decision === "accepted" ? "Accepted similarity match" : "Possible similarity match";
  return `${qualifier} at ${tableMatch.score}%.`;
}
