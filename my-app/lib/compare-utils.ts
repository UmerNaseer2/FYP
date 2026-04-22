// ---------------------------------------------------------------------------
// compare-utils.ts
// Pure string and set math utilities used by the comparison algorithm.
// No database types, no scoring weights — just reusable maths.
// ---------------------------------------------------------------------------

// Lowercase and collapse whitespace for similarity comparisons.
export function normalizeSimilarityText(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

// Trim only — used for identifiers (table/column names) where case matters.
export function normalizeIdentifier(value: string): string {
  return value.trim();
}

// Classic Levenshtein edit-distance (not exported — only used by stringSimilarity).
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

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

// 0–1 string similarity based on Levenshtein distance.
// 1.0 = identical, 0.0 = completely different.
export function stringSimilarity(a: string, b: string): number {
  const left = normalizeSimilarityText(a);
  const right = normalizeSimilarityText(b);

  if (left === right) return 1;

  const length = Math.max(left.length, right.length);
  if (length === 0) return 1;

  return Math.max(0, 1 - levenshtein(left, right) / length);
}

// Round a score to one decimal place (e.g. 82.16… → 82.2).
export function roundScore(value: number): number {
  return Math.round(value * 10) / 10;
}

// Jaccard set similarity: |intersection| / |union|.
// Two empty sets count as identical (returns 1).
export function setSimilarity(left: string[], right: string[]): number {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  const union = new Set([...leftSet, ...rightSet]);

  if (union.size === 0) return 1;

  let intersection = 0;
  for (const value of leftSet) {
    if (rightSet.has(value)) intersection += 1;
  }

  return intersection / union.size;
}

// Like setSimilarity but counts duplicates — useful when two tables have
// multiple FKs to the same target and we want to reward that pattern matching.
export function multisetSimilarity(left: string[], right: string[]): number {
  if (left.length === 0 && right.length === 0) return 1;

  const leftCounts = new Map<string, number>();
  const rightCounts = new Map<string, number>();

  for (const value of left) {
    leftCounts.set(value, (leftCounts.get(value) ?? 0) + 1);
  }
  for (const value of right) {
    rightCounts.set(value, (rightCounts.get(value) ?? 0) + 1);
  }

  const allValues = new Set([...leftCounts.keys(), ...rightCounts.keys()]);
  let intersection = 0;
  let union = 0;

  for (const value of allValues) {
    const leftCount = leftCounts.get(value) ?? 0;
    const rightCount = rightCounts.get(value) ?? 0;
    intersection += Math.min(leftCount, rightCount);
    union += Math.max(leftCount, rightCount);
  }

  return union === 0 ? 1 : intersection / union;
}
