import type {
  ColumnSnapshot,
  ConstraintSnapshot,
  ForeignKeySnapshot,
  SchemaSnapshot,
  TableSnapshot,
} from "./postgres";

type ColumnConstraintState = {
  nullable: boolean;
  primaryKey: boolean;
  uniqueCount: number;
  foreignKeyCount: number;
};

export type ScoreBreakdown = {
  name: number;
  constraints: number;
  columns?: number;
  type?: number;
  order?: number;
};

export type MatchCandidate = {
  kind: "table" | "column";
  leftName: string;
  rightName: string;
  score: number;
  accepted: boolean;
  breakdown: ScoreBreakdown;
};

export type ColumnMatch = {
  left: ColumnSnapshot;
  right: ColumnSnapshot;
  score: number;
  exact: boolean;
  breakdown: ScoreBreakdown;
  changes: string[];
};

export type ConstraintDiff = {
  kind:
    | "PRIMARY KEY"
    | "UNIQUE"
    | "FOREIGN KEY"
    | "CHECK"
    | "EXCLUDE";
  status: "onlyA" | "onlyB" | "changedDefinition";
  summary: string;
  leftName?: string;
  rightName?: string;
};

export type TableMatch = {
  left: TableSnapshot;
  right: TableSnapshot;
  score: number;
  exact: boolean;
  breakdown: ScoreBreakdown;
  columnMatches: ColumnMatch[];
  columnsOnlyInA: ColumnSnapshot[];
  columnsOnlyInB: ColumnSnapshot[];
  possibleColumnMatches: MatchCandidate[];
  constraintDiffs: ConstraintDiff[];
  changedSections: string[];
  hasChanges: boolean;
};

export type CompareReport = {
  left: SchemaSnapshot;
  right: SchemaSnapshot;
  matchedTables: TableMatch[];
  tablesOnlyInA: TableSnapshot[];
  tablesOnlyInB: TableSnapshot[];
  possibleTableMatches: MatchCandidate[];
  summary: {
    tablesOnlyInA: number;
    tablesOnlyInB: number;
    changedTables: number;
    changedConstraints: number;
    likelyRenameCandidates: number;
    identicalTables: number;
  };
};

type ConstraintLike = ConstraintSnapshot | ForeignKeySnapshot;
type MatchDecision = "accepted" | "possible";

const TABLE_MATCH_ACCEPT_THRESHOLD = 70;
const TABLE_MATCH_POSSIBLE_THRESHOLD = 55;
const COLUMN_MATCH_ACCEPT_THRESHOLD = 50;
const COLUMN_MATCH_POSSIBLE_THRESHOLD = 40;

function normalizeSimilarityText(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function normalizeIdentifier(value: string): string {
  return value.trim();
}

function levenshtein(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  if (a.length === 0) {
    return b.length;
  }
  if (b.length === 0) {
    return a.length;
  }

  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);

  for (let i = 0; i < a.length; i += 1) {
    let diagonal = previous[0];
    previous[0] = i + 1;

    for (let j = 0; j < b.length; j += 1) {
      const temp = previous[j + 1];
      const cost = a[i] === b[j] ? 0 : 1;
      previous[j + 1] = Math.min(
        previous[j + 1] + 1,
        previous[j] + 1,
        diagonal + cost
      );
      diagonal = temp;
    }
  }

  return previous[b.length];
}

function stringSimilarity(a: string, b: string): number {
  const left = normalizeSimilarityText(a);
  const right = normalizeSimilarityText(b);

  if (left === right) {
    return 1;
  }

  const length = Math.max(left.length, right.length);
  if (length === 0) {
    return 1;
  }

  return Math.max(0, 1 - levenshtein(left, right) / length);
}

function roundScore(value: number): number {
  return Math.round(value * 10) / 10;
}

function setSimilarity(left: string[], right: string[]): number {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  const union = new Set([...leftSet, ...rightSet]);

  if (union.size === 0) {
    return 1;
  }

  let intersection = 0;
  for (const value of leftSet) {
    if (rightSet.has(value)) {
      intersection += 1;
    }
  }

  return intersection / union.size;
}

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
  if (parenIndex === -1) {
    return normalized;
  }
  return normalized.slice(0, parenIndex).trim();
}

// Scores how similar two PostgreSQL column types are, out of 20 points.
//   20 pts  —  exact same type including size/precision  (varchar(100) vs varchar(100))
//   12 pts  —  same base type, different size or precision (varchar(100) vs varchar(200))
//    0 pts  —  completely different types                 (integer vs text)
//
// Giving partial credit for same-family types avoids flagging a varchar(100)→varchar(200)
// change the same way as an integer→text change, which is far more serious.
export function typeScore(leftTypeDisplay: string, rightTypeDisplay: string): number {
  const leftNorm  = normalizeType(leftTypeDisplay);
  const rightNorm = normalizeType(rightTypeDisplay);

  if (leftNorm === rightNorm) {
    return 20;
  }

  const leftBase  = extractBaseType(leftNorm);
  const rightBase = extractBaseType(rightNorm);

  if (leftBase === rightBase) {
    return 12;
  }

  return 0;
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

function foreignKeyLogicalSignature(foreignKey: ForeignKeySnapshot): string {
  return [
    columnsAsOrderedSignature(foreignKey.columns),
    normalizeIdentifier(foreignKey.referencedSchema ?? ""),
    normalizeIdentifier(foreignKey.referencedTable ?? ""),
    columnsAsOrderedSignature(foreignKey.referencedColumns),
    normalizeIdentifier(foreignKey.onUpdate),
    normalizeIdentifier(foreignKey.onDelete),
  ].join("->");
}

function definitionSignature(constraint: ConstraintSnapshot): string {
  return constraint.normalizedDefinition;
}

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

  if (left.nullable === right.nullable) {
    points += 5;
  }
  if (left.primaryKey === right.primaryKey) {
    points += 5;
  }
  if (Math.sign(left.uniqueCount) === Math.sign(right.uniqueCount)) {
    points += 2.5;
  }
  if (Math.sign(left.foreignKeyCount) === Math.sign(right.foreignKeyCount)) {
    points += 2.5;
  }

  return points / 15;
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
  // Column similarity is scored out of 60 total, split across four categories:
  //
  //   name:        0–15   how similar are the column names? (Levenshtein)
  //   type:        0–20   exact=20, same family different size=12, different=0
  //   constraints: 0–15   nullable, PK, unique, FK participation
  //   order:       0–10   relative position in the table (not the raw column number)
  //
  // Type is the heaviest single category (20) because changing a type is usually
  // a breaking database change. Order is the lightest (10) because column reordering
  // is usually cosmetic and should not drag down the overall match score.
  const name        = stringSimilarity(leftColumn.name, rightColumn.name) * 15;
  const type        = typeScore(leftColumn.typeDisplay, rightColumn.typeDisplay);
  const constraints = columnConstraintSimilarity(leftTable, leftColumn, rightTable, rightColumn) * 15;
  const order       = columnOrderSimilarity(leftTable, leftColumn, rightTable, rightColumn) * 10;

  const changes: string[] = [];

  if (normalizeType(leftColumn.typeDisplay) !== normalizeType(rightColumn.typeDisplay)) {
    // typeChangeDescription tells us whether it's a real type change (integer → text)
    // or just a size/precision tweak (varchar(100) → varchar(200)).
    changes.push(typeChangeDescription(leftColumn.typeDisplay, rightColumn.typeDisplay));
  }
  if (leftColumn.nullable !== rightColumn.nullable) {
    changes.push(
      `Nullability changed from ${
        leftColumn.nullable ? "nullable" : "not null"
      } to ${rightColumn.nullable ? "nullable" : "not null"}`
    );
  }
  if (leftColumn.ordinalPosition !== rightColumn.ordinalPosition) {
    changes.push(
      `Order changed from #${leftColumn.ordinalPosition} to #${rightColumn.ordinalPosition}`
    );
  }
  if (leftColumn.isPrimaryKey !== rightColumn.isPrimaryKey) {
    changes.push("Primary key participation changed");
  }
  if (
    Math.sign(leftColumn.uniqueConstraintNames.length) !==
    Math.sign(rightColumn.uniqueConstraintNames.length)
  ) {
    changes.push("Unique constraint participation changed");
  }
  if (
    Math.sign(leftColumn.foreignKeyConstraintNames.length) !==
    Math.sign(rightColumn.foreignKeyConstraintNames.length)
  ) {
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
  if (values.length === 0) {
    return 1;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function pairwiseAverageBestScore(
  leftTable: TableSnapshot,
  rightTable: TableSnapshot
): number {
  if (leftTable.columns.length === 0 && rightTable.columns.length === 0) {
    return 1;
  }

  const leftScores = leftTable.columns.map((leftColumn) =>
    Math.max(
      0,
      ...rightTable.columns.map((rightColumn) =>
        compareColumnPair(leftTable, leftColumn, rightTable, rightColumn).score / 60
      )
    )
  );

  const rightScores = rightTable.columns.map((rightColumn) =>
    Math.max(
      0,
      ...leftTable.columns.map((leftColumn) =>
        compareColumnPair(leftTable, leftColumn, rightTable, rightColumn).score / 60
      )
    )
  );

  return average([...leftScores, ...rightScores]);
}

function constraintFamilySimilarity(
  leftTable: TableSnapshot,
  rightTable: TableSnapshot
): number {
  const primaryKeySimilarity = (() => {
    if (!leftTable.primaryKey && !rightTable.primaryKey) {
      return 1;
    }
    if (!leftTable.primaryKey || !rightTable.primaryKey) {
      return 0;
    }
    return setSimilarity(leftTable.primaryKey.columns, rightTable.primaryKey.columns);
  })();

  const uniqueSimilarity = setSimilarity(
    leftTable.uniqueConstraints.map(uniqueConstraintSignature),
    rightTable.uniqueConstraints.map(uniqueConstraintSignature)
  );

  const foreignKeySimilarity = setSimilarity(
    leftTable.foreignKeys.map(foreignKeyLogicalSignature),
    rightTable.foreignKeys.map(foreignKeyLogicalSignature)
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

function compareTablePair(
  leftTable: TableSnapshot,
  rightTable: TableSnapshot
): {
  score: number;
  breakdown: ScoreBreakdown;
} {
  const name = stringSimilarity(leftTable.name, rightTable.name) * 20;
  const constraints = constraintFamilySimilarity(leftTable, rightTable) * 20;
  const columns = pairwiseAverageBestScore(leftTable, rightTable) * 60;

  return {
    score: roundScore(name + constraints + columns),
    breakdown: {
      name: roundScore(name),
      constraints: roundScore(constraints),
      columns: roundScore(columns),
    },
  };
}

function getBestMatches<TLeft, TRight>(
  leftItems: TLeft[],
  rightItems: TRight[],
  computeScore: (
    left: TLeft,
    right: TRight
  ) => { score: number; breakdown: ScoreBreakdown },
  acceptThreshold: number,
  possibleThreshold: number,
  kind: "table" | "column",
  getLeftName: (value: TLeft) => string,
  getRightName: (value: TRight) => string
): {
  accepted: Array<{
    left: TLeft;
    right: TRight;
    score: number;
    breakdown: ScoreBreakdown;
  }>;
  possible: MatchCandidate[];
  leftOnly: TLeft[];
  rightOnly: TRight[];
} {
  const leftBest = new Map<number, { index: number; score: number; breakdown: ScoreBreakdown }>();
  const rightBest = new Map<number, { index: number; score: number; breakdown: ScoreBreakdown }>();
  const matrix = new Map<string, { score: number; breakdown: ScoreBreakdown }>();

  for (let leftIndex = 0; leftIndex < leftItems.length; leftIndex += 1) {
    for (let rightIndex = 0; rightIndex < rightItems.length; rightIndex += 1) {
      const result = computeScore(leftItems[leftIndex], rightItems[rightIndex]);
      matrix.set(`${leftIndex}:${rightIndex}`, result);

      const currentLeft = leftBest.get(leftIndex);
      if (!currentLeft || result.score > currentLeft.score) {
        leftBest.set(leftIndex, {
          index: rightIndex,
          score: result.score,
          breakdown: result.breakdown,
        });
      }

      const currentRight = rightBest.get(rightIndex);
      if (!currentRight || result.score > currentRight.score) {
        rightBest.set(rightIndex, {
          index: leftIndex,
          score: result.score,
          breakdown: result.breakdown,
        });
      }
    }
  }

  const accepted: Array<{
    left: TLeft;
    right: TRight;
    score: number;
    breakdown: ScoreBreakdown;
  }> = [];
  const possible: MatchCandidate[] = [];
  const matchedLeft = new Set<number>();
  const matchedRight = new Set<number>();

  for (const [leftIndex, match] of leftBest.entries()) {
    const reverse = rightBest.get(match.index);
    if (!reverse || reverse.index !== leftIndex) {
      continue;
    }

    if (match.score >= acceptThreshold) {
      accepted.push({
        left: leftItems[leftIndex],
        right: rightItems[match.index],
        score: match.score,
        breakdown: match.breakdown,
      });
      matchedLeft.add(leftIndex);
      matchedRight.add(match.index);
      continue;
    }

    if (match.score >= possibleThreshold) {
      possible.push({
        kind,
        leftName: getLeftName(leftItems[leftIndex]),
        rightName: getRightName(rightItems[match.index]),
        score: match.score,
        accepted: false,
        breakdown: match.breakdown,
      });
    }
  }

  return {
    accepted,
    possible,
    leftOnly: leftItems.filter((_, index) => !matchedLeft.has(index)),
    rightOnly: rightItems.filter((_, index) => !matchedRight.has(index)),
  };
}

function compareColumns(
  leftTable: TableSnapshot,
  rightTable: TableSnapshot
): {
  columnMatches: ColumnMatch[];
  columnsOnlyInA: ColumnSnapshot[];
  columnsOnlyInB: ColumnSnapshot[];
  possibleColumnMatches: MatchCandidate[];
} {
  const leftByName = new Map(
    leftTable.columns.map((column) => [normalizeIdentifier(column.name), column])
  );
  const rightByName = new Map(
    rightTable.columns.map((column) => [normalizeIdentifier(column.name), column])
  );

  const matchedRightNames = new Set<string>();
  const columnMatches: ColumnMatch[] = [];

  for (const [name, leftColumn] of leftByName.entries()) {
    const rightColumn = rightByName.get(name);
    if (!rightColumn) {
      continue;
    }

    matchedRightNames.add(name);
    const result = compareColumnPair(leftTable, leftColumn, rightTable, rightColumn);
    columnMatches.push({
      left: leftColumn,
      right: rightColumn,
      score: result.score,
      exact: true,
      breakdown: result.breakdown,
      changes: result.changes,
    });
  }

  const leftOnlyForSimilarity = leftTable.columns.filter(
    (column) => !rightByName.has(normalizeIdentifier(column.name))
  );
  const rightOnlyForSimilarity = rightTable.columns.filter(
    (column) => !matchedRightNames.has(normalizeIdentifier(column.name))
  );

  const similarityResults = getBestMatches(
    leftOnlyForSimilarity,
    rightOnlyForSimilarity,
    (leftColumn, rightColumn) => {
      const result = compareColumnPair(leftTable, leftColumn, rightTable, rightColumn);
      return { score: result.score, breakdown: result.breakdown };
    },
    COLUMN_MATCH_ACCEPT_THRESHOLD,
    COLUMN_MATCH_POSSIBLE_THRESHOLD,
    "column",
    (column) => column.name,
    (column) => column.name
  );

  for (const match of similarityResults.accepted) {
    const result = compareColumnPair(leftTable, match.left, rightTable, match.right);
    columnMatches.push({
      left: match.left,
      right: match.right,
      score: match.score,
      exact: false,
      breakdown: match.breakdown,
      changes: result.changes,
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

function comparePrimaryKey(
  left: TableSnapshot,
  right: TableSnapshot
): ConstraintDiff[] {
  if (!left.primaryKey && !right.primaryKey) {
    return [];
  }
  if (left.primaryKey && !right.primaryKey) {
    return [
      {
        kind: "PRIMARY KEY",
        status: "onlyA",
        summary: `Primary key ${left.primaryKey.name} exists only in ${left.name}.`,
        leftName: left.primaryKey.name,
      },
    ];
  }
  if (!left.primaryKey && right.primaryKey) {
    return [
      {
        kind: "PRIMARY KEY",
        status: "onlyB",
        summary: `Primary key ${right.primaryKey.name} exists only in ${right.name}.`,
        rightName: right.primaryKey.name,
      },
    ];
  }
  if (
    primaryKeySignature(left.primaryKey) !== primaryKeySignature(right.primaryKey) ||
    left.primaryKey?.normalizedDefinition !== right.primaryKey?.normalizedDefinition
  ) {
    return [
      {
        kind: "PRIMARY KEY",
        status: "changedDefinition",
        summary: `Primary key changed from (${left.primaryKey?.columns.join(", ")}) to (${right.primaryKey?.columns.join(", ")}).`,
        leftName: left.primaryKey?.name,
        rightName: right.primaryKey?.name,
      },
    ];
  }
  return [];
}

function compareUniqueConstraints(
  left: TableSnapshot,
  right: TableSnapshot
): ConstraintDiff[] {
  const diffs: ConstraintDiff[] = [];
  const rightByName = new Map(
    right.uniqueConstraints.map((constraint) => [normalizeIdentifier(constraint.name), constraint])
  );
  const rightBySignature = new Map(
    right.uniqueConstraints.map((constraint) => [
      uniqueConstraintSignature(constraint),
      constraint,
    ])
  );
  const matchedRight = new Set<string>();

  for (const constraint of left.uniqueConstraints) {
    const byName = rightByName.get(normalizeIdentifier(constraint.name));
    if (byName) {
      matchedRight.add(byName.name);
      if (
        uniqueConstraintSignature(constraint) !== uniqueConstraintSignature(byName) ||
        constraint.normalizedDefinition !== byName.normalizedDefinition
      ) {
        diffs.push({
          kind: "UNIQUE",
          status: "changedDefinition",
          summary: `Unique constraint ${constraint.name} changed definition.`,
          leftName: constraint.name,
          rightName: byName.name,
        });
      }
      continue;
    }

    const bySignature = rightBySignature.get(uniqueConstraintSignature(constraint));
    if (bySignature) {
      matchedRight.add(bySignature.name);
      continue;
    }

    diffs.push({
      kind: "UNIQUE",
      status: "onlyA",
      summary: `Unique constraint ${constraint.name} exists only in ${left.name}.`,
      leftName: constraint.name,
    });
  }

  for (const constraint of right.uniqueConstraints) {
    if (matchedRight.has(constraint.name)) {
      continue;
    }
    diffs.push({
      kind: "UNIQUE",
      status: "onlyB",
      summary: `Unique constraint ${constraint.name} exists only in ${right.name}.`,
      rightName: constraint.name,
    });
  }

  return diffs;
}

function compareForeignKeys(
  left: TableSnapshot,
  right: TableSnapshot
): ConstraintDiff[] {
  const diffs: ConstraintDiff[] = [];
  const rightByName = new Map(
    right.foreignKeys.map((foreignKey) => [normalizeIdentifier(foreignKey.name), foreignKey])
  );
  const rightBySignature = new Map(
    right.foreignKeys.map((foreignKey) => [
      foreignKeyLogicalSignature(foreignKey),
      foreignKey,
    ])
  );
  const matchedRight = new Set<string>();

  for (const foreignKey of left.foreignKeys) {
    const byName = rightByName.get(normalizeIdentifier(foreignKey.name));
    if (byName) {
      matchedRight.add(byName.name);
      if (
        foreignKeyLogicalSignature(foreignKey) !== foreignKeyLogicalSignature(byName) ||
        foreignKey.normalizedDefinition !== byName.normalizedDefinition
      ) {
        diffs.push({
          kind: "FOREIGN KEY",
          status: "changedDefinition",
          summary: `Foreign key ${foreignKey.name} changed definition.`,
          leftName: foreignKey.name,
          rightName: byName.name,
        });
      }
      continue;
    }

    const bySignature = rightBySignature.get(foreignKeyLogicalSignature(foreignKey));
    if (bySignature) {
      matchedRight.add(bySignature.name);
      continue;
    }

    diffs.push({
      kind: "FOREIGN KEY",
      status: "onlyA",
      summary: `Foreign key ${foreignKey.name} exists only in ${left.name}.`,
      leftName: foreignKey.name,
    });
  }

  for (const foreignKey of right.foreignKeys) {
    if (matchedRight.has(foreignKey.name)) {
      continue;
    }
    diffs.push({
      kind: "FOREIGN KEY",
      status: "onlyB",
      summary: `Foreign key ${foreignKey.name} exists only in ${right.name}.`,
      rightName: foreignKey.name,
    });
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
  const rightByName = new Map(
    rightConstraints.map((constraint) => [normalizeIdentifier(constraint.name), constraint])
  );
  const rightByDefinition = new Map(
    rightConstraints.map((constraint) => [constraint.normalizedDefinition, constraint])
  );
  const matchedRight = new Set<string>();

  for (const constraint of leftConstraints) {
    const byName = rightByName.get(normalizeIdentifier(constraint.name));
    if (byName) {
      matchedRight.add(byName.name);
      if (constraint.normalizedDefinition !== byName.normalizedDefinition) {
        diffs.push({
          kind,
          status: "changedDefinition",
          summary: `${kind} constraint ${constraint.name} changed definition.`,
          leftName: constraint.name,
          rightName: byName.name,
        });
      }
      continue;
    }

    const byDefinition = rightByDefinition.get(constraint.normalizedDefinition);
    if (byDefinition) {
      matchedRight.add(byDefinition.name);
      continue;
    }

    diffs.push({
      kind,
      status: "onlyA",
      summary: `${kind} constraint ${constraint.name} exists only in ${leftTableName}.`,
      leftName: constraint.name,
    });
  }

  for (const constraint of rightConstraints) {
    if (matchedRight.has(constraint.name)) {
      continue;
    }
    diffs.push({
      kind,
      status: "onlyB",
      summary: `${kind} constraint ${constraint.name} exists only in ${rightTableName}.`,
      rightName: constraint.name,
    });
  }

  return diffs;
}

function compareConstraints(
  left: TableSnapshot,
  right: TableSnapshot
): ConstraintDiff[] {
  return [
    ...comparePrimaryKey(left, right),
    ...compareUniqueConstraints(left, right),
    ...compareForeignKeys(left, right),
    ...compareDefinitionConstraints(
      "CHECK",
      left.checkConstraints,
      right.checkConstraints,
      left.name,
      right.name
    ),
    ...compareDefinitionConstraints(
      "EXCLUDE",
      left.excludeConstraints,
      right.excludeConstraints,
      left.name,
      right.name
    ),
  ];
}

function compareMatchedTables(
  left: TableSnapshot,
  right: TableSnapshot,
  score: number,
  exact: boolean,
  breakdown: ScoreBreakdown
): TableMatch {
  const columnResult = compareColumns(left, right);
  const constraintDiffs = compareConstraints(left, right);

  const changedSections = new Set<string>();
  if (
    columnResult.columnsOnlyInA.length > 0 ||
    columnResult.columnsOnlyInB.length > 0 ||
    columnResult.columnMatches.some((match) => match.changes.length > 0)
  ) {
    changedSections.add("Columns");
  }
  if (constraintDiffs.some((diff) => diff.kind === "PRIMARY KEY")) {
    changedSections.add("Primary key");
  }
  if (constraintDiffs.some((diff) => diff.kind === "UNIQUE")) {
    changedSections.add("Unique constraints");
  }
  if (constraintDiffs.some((diff) => diff.kind === "FOREIGN KEY")) {
    changedSections.add("Foreign keys");
  }
  if (constraintDiffs.some((diff) => diff.kind === "CHECK")) {
    changedSections.add("Check constraints");
  }
  if (constraintDiffs.some((diff) => diff.kind === "EXCLUDE")) {
    changedSections.add("Exclude constraints");
  }
  if (!exact) {
    changedSections.add("Similarity matched");
  }

  return {
    left,
    right,
    score,
    exact,
    breakdown,
    columnMatches: columnResult.columnMatches,
    columnsOnlyInA: columnResult.columnsOnlyInA,
    columnsOnlyInB: columnResult.columnsOnlyInB,
    possibleColumnMatches: columnResult.possibleColumnMatches,
    constraintDiffs,
    changedSections: Array.from(changedSections),
    hasChanges:
      !exact ||
      columnResult.columnsOnlyInA.length > 0 ||
      columnResult.columnsOnlyInB.length > 0 ||
      columnResult.columnMatches.some((match) => match.changes.length > 0) ||
      constraintDiffs.length > 0,
  };
}

export function compareSchemas(
  left: SchemaSnapshot,
  right: SchemaSnapshot
): CompareReport {
  const rightByName = new Map(
    right.tables.map((table) => [normalizeIdentifier(table.name), table])
  );
  const matchedRightNames = new Set<string>();
  const matchedTables: TableMatch[] = [];

  for (const leftTable of left.tables) {
    const rightTable = rightByName.get(normalizeIdentifier(leftTable.name));
    if (!rightTable) {
      continue;
    }

    const scoreResult = compareTablePair(leftTable, rightTable);
    matchedRightNames.add(normalizeIdentifier(rightTable.name));
    matchedTables.push(
      compareMatchedTables(
        leftTable,
        rightTable,
        scoreResult.score,
        true,
        scoreResult.breakdown
      )
    );
  }

  const leftForSimilarity = left.tables.filter(
    (table) => !rightByName.has(normalizeIdentifier(table.name))
  );
  const rightForSimilarity = right.tables.filter(
    (table) => !matchedRightNames.has(normalizeIdentifier(table.name))
  );

  const similarityResults = getBestMatches(
    leftForSimilarity,
    rightForSimilarity,
    compareTablePair,
    TABLE_MATCH_ACCEPT_THRESHOLD,
    TABLE_MATCH_POSSIBLE_THRESHOLD,
    "table",
    (table) => table.name,
    (table) => table.name
  );

  for (const match of similarityResults.accepted) {
    matchedTables.push(
      compareMatchedTables(
        match.left,
        match.right,
        match.score,
        false,
        match.breakdown
      )
    );
  }

  const changedTables = matchedTables.filter((table) => table.hasChanges).length;
  const changedConstraints = matchedTables.reduce((sum, table) => {
    return sum + table.constraintDiffs.length;
  }, 0);
  const likelyRenameCandidates =
    matchedTables.filter((table) => !table.exact).length +
    similarityResults.possible.length;

  return {
    left,
    right,
    matchedTables: matchedTables.sort((a, b) => a.left.name.localeCompare(b.left.name)),
    tablesOnlyInA: similarityResults.leftOnly.sort((a, b) =>
      a.name.localeCompare(b.name)
    ),
    tablesOnlyInB: similarityResults.rightOnly.sort((a, b) =>
      a.name.localeCompare(b.name)
    ),
    possibleTableMatches: similarityResults.possible.sort(
      (a, b) => b.score - a.score || a.leftName.localeCompare(b.leftName)
    ),
    summary: {
      tablesOnlyInA: similarityResults.leftOnly.length,
      tablesOnlyInB: similarityResults.rightOnly.length,
      changedTables,
      changedConstraints,
      likelyRenameCandidates,
      identicalTables: matchedTables.filter((table) => !table.hasChanges).length,
    },
  };
}

export function summarizeColumns(columns: ColumnSnapshot[]): string {
  if (columns.length === 0) {
    return "None";
  }

  return columns
    .map((column) => `${column.name} (${column.typeDisplay})`)
    .join(", ");
}

export function describeConstraint(constraint: ConstraintLike): string {
  if (constraint.kind === "FOREIGN KEY") {
    return `${constraint.name}: (${constraint.columns.join(", ")}) -> ${
      constraint.referencedTable ?? "unknown"
    } (${constraint.referencedColumns.join(", ")})`;
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

  const decision = matchDecision(tableMatch.score, TABLE_MATCH_ACCEPT_THRESHOLD);
  const qualifier =
    decision === "accepted" ? "Accepted similarity match" : "Possible similarity match";

  return `${qualifier} at ${tableMatch.score}%.`;
}
