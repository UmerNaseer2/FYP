// ---------------------------------------------------------------------------
// compare-sample.ts
// Which rows actually differ — the shape of that answer, and the pure rules
// behind it.
//
// Spec feature 04: "Compare all or selected table data (row counts, sample
// mismatched rows)." compare-data.ts answers the first two: how many rows each
// side holds, and whether a checksum over them agrees. That verdict is a single
// bit. A table that comes back "different" tells the reader something is wrong
// and nothing whatever about what — which row, which column, by how much. This
// module is the part that names them.
//
// Split out of compare-data.ts for the same reason compare-data-summary is:
// that file imports `pg`, and the screen rendering these rows must not pull a
// database driver into the browser bundle. Everything here is pure — no SQL, no
// connection, no React — so the rules below are unit-tested directly.
//
// The sampling is deliberately BOUNDED and says so. Finding every differing row
// in two tables on two different servers means reading both tables in full and
// holding them in memory, which is not something a page render may do. So a run
// reads a fixed number of rows per side, in key order, and reports both what it
// found and how far it got. A reader who is told "the first 2,000 rows by id"
// can act on that; one shown three rows with no bound stated would reasonably
// assume there were only three.
// ---------------------------------------------------------------------------

/** One column that disagrees, with both sides' value rendered as text. */
export type RowDifference = {
  column: string;
  /** Null means SQL NULL, which is why the values are text and not JSON. */
  left: string | null;
  right: string | null;
};

/** One row that is not the same on both sides. */
export type SampleRow = {
  /** The key values in keyColumns order, as text. */
  key: string[];
  kind:
    /** The key exists on both sides and at least one shared column differs. */
    | "changed"
    /** Only the source has this key — a sync would insert it. */
    | "sourceOnly"
    /** Only the target has this key — a sync would delete it. */
    | "targetOnly";
  /** The columns that differ. Empty unless kind is "changed". */
  differences: RowDifference[];
};

export type RowSample = {
  status:
    /** Rows were read; `rows` holds the differing ones this run found. */
    | "sampled"
    /** No key both sides share, so rows cannot be paired up. See pickSampleKey. */
    | "no-key"
    /** The read itself failed or was not attempted; `note` says which. */
    | "unavailable";
  /** The columns rows were paired by, named as the SOURCE calls them. */
  keyColumns: string[];
  rows: SampleRow[];
  /** True when more rows differed than `rows` holds. */
  more: boolean;
  /**
   * How many rows per side the scan was allowed to read. It is the BOUND, not
   * a count of what came back: a table of forty rows still reports the bound,
   * and `partial` below is what says whether the bound was actually reached.
   */
  scanned: number;
  /**
   * True when a side holds more rows than the scan covered, so rows past the
   * cut-off were never looked at. The difference between "these are the
   * differences" and "these are the differences in the part that was read".
   */
  partial: boolean;
  note: string | null;
};

/** How many rows per side one scan reads. See the header: bounded on purpose. */
export const SAMPLE_SCAN_ROWS = 2000;

/** How many differing rows are reported. Enough to see the pattern, not a dump. */
export const SAMPLE_ROW_LIMIT = 10;

/**
 * The columns to pair rows by, or null when there are none.
 *
 * Wanted: a key that (a) exists on both sides, so the same row can be found in
 * each, and (b) never holds NULL, because two NULLs are not equal in SQL and
 * pairing on them would report a row as missing from the other side when it is
 * sitting right there.
 *
 * The primary key satisfies both by definition and is tried first. A unique
 * constraint is the fallback, and only when every one of its columns is NOT
 * NULL — a UNIQUE column IS allowed to be null in PostgreSQL, and more than one
 * row may be null in it, so a nullable unique column is not a key at all here.
 *
 * `shared` is the columns the comparison actually matched up. A key column that
 * exists on one side only cannot identify anything on the other, so a key that
 * uses one is no key for this purpose even though the table has it.
 */
export function pickSampleKey(
  table: {
    primaryKey: { columns: string[] } | null;
    uniqueConstraints: { columns: string[] }[];
    columns: { name: string; nullable: boolean }[];
  },
  shared: ReadonlySet<string>,
): string[] | null {
  const notNull = new Set(
    table.columns.filter((column) => !column.nullable).map((column) => column.name),
  );
  const usable = (columns: string[], mustBeNotNull: boolean): boolean =>
    columns.length > 0 &&
    columns.every(
      (name) => shared.has(name) && (!mustBeNotNull || notNull.has(name)),
    );

  // The primary key's columns are NOT NULL whether or not this snapshot's
  // per-column flag says so, so they are not checked against `notNull`: a
  // snapshot old enough to have captured nullability differently would
  // otherwise throw away the one key that is always correct.
  if (table.primaryKey && usable(table.primaryKey.columns, false)) {
    return [...table.primaryKey.columns];
  }
  for (const unique of table.uniqueConstraints) {
    if (usable(unique.columns, true)) return [...unique.columns];
  }
  return null;
}

/** One row's key as read from the database, with a hash of its other columns. */
export type KeyedDigest = {
  key: string[];
  /** md5 of the row's shared non-key columns, or "" when it has none. */
  digest: string;
};

/**
 * A key rendered as one string, for use as a Map key.
 *
 * JSON rather than a join: joining ["a|b", "c"] and ["a", "b|c"] with a pipe
 * produces the same string for two different rows, and a composite key made of
 * free text is exactly where that happens.
 */
function keyId(key: string[]): string {
  return JSON.stringify(key);
}

/**
 * Pair up two sides' rows and return the ones that do not match.
 *
 * Both lists come back in key order, but this does not rely on that — it builds
 * a map from one side and walks the other. Sorting rules are a server setting
 * (a different collation orders text differently), and two servers that ordered
 * their rows differently would make a merge-walk report every row as one-sided.
 *
 * Source-only rows come first, then target-only, then changed. A row missing
 * from one side is the bigger fact, and a caller showing only the first few
 * should show those.
 */
export function findMismatchedRows(
  left: ReadonlyArray<KeyedDigest>,
  right: ReadonlyArray<KeyedDigest>,
  limit: number,
): { rows: { key: string[]; kind: SampleRow["kind"] }[]; more: boolean } {
  const rightById = new Map(right.map((row) => [keyId(row.key), row]));
  const sourceOnly: string[][] = [];
  const changed: string[][] = [];
  const seen = new Set<string>();

  for (const row of left) {
    const id = keyId(row.key);
    seen.add(id);
    const other = rightById.get(id);
    if (!other) sourceOnly.push(row.key);
    else if (other.digest !== row.digest) changed.push(row.key);
  }

  const targetOnly = right
    .filter((row) => !seen.has(keyId(row.key)))
    .map((row) => row.key);

  const all = [
    ...sourceOnly.map((key) => ({ key, kind: "sourceOnly" as const })),
    ...targetOnly.map((key) => ({ key, kind: "targetOnly" as const })),
    ...changed.map((key) => ({ key, kind: "changed" as const })),
  ];
  return { rows: all.slice(0, limit), more: all.length > limit };
}

/**
 * The columns whose values disagree between one row and its counterpart.
 *
 * `columns` pairs the two sides' names, because a column may be RENAMED between
 * them — the comparison matched `customer_id` to `client_id`, and reading the
 * target's row by the source's name would find nothing and report every such
 * column as a difference.
 *
 * Values are compared as the text the database rendered, which is the same
 * basis the checksum uses. Two servers rendering the same value differently is
 * a known caveat of both and is documented where the verdict is produced.
 */
export function differingColumns(
  leftRow: Record<string, string | null>,
  rightRow: Record<string, string | null>,
  columns: ReadonlyArray<{ left: string; right: string }>,
): RowDifference[] {
  const out: RowDifference[] = [];
  for (const pair of columns) {
    const left = leftRow[pair.left] ?? null;
    const right = rightRow[pair.right] ?? null;
    if (left !== right) out.push({ column: pair.left, left, right });
  }
  return out;
}

/**
 * The sentence above a table's sampled rows.
 *
 * It exists to bound the list. Everything it says is about what the scan did
 * NOT cover, because the rows themselves already say what it found.
 */
export function describeSample(sample: RowSample): string | null {
  if (sample.status === "no-key") {
    return (
      "This table has no primary key or non-null unique constraint that both sides share, " +
      "so its rows cannot be paired up to show which ones differ."
    );
  }
  if (sample.status === "unavailable") return sample.note;
  if (sample.rows.length === 0) {
    // Reachable: the checksum covers every row, the sample covers the first
    // SAMPLE_SCAN_ROWS of them. A difference past the cut-off makes the table
    // "different" with nothing to show, and saying so is the whole point.
    return sample.partial
      ? `The difference is past the first ${sample.scanned.toLocaleString()} rows, which is as ` +
          `far as this scan read.`
      : null;
  }
  const parts = [
    sample.more
      ? `More than ${sample.rows.length} rows differ; the first ${sample.rows.length} are shown.`
      : null,
    sample.partial
      ? `Read the first ${sample.scanned.toLocaleString()} rows per side by ` +
        `${sample.keyColumns.join(", ")} — rows past that were not checked.`
      : null,
  ].filter((part): part is string => part !== null);
  return parts.length > 0 ? parts.join(" ") : null;
}
