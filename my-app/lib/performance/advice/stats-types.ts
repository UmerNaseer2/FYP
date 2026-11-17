// Performance advice: the rows PostgreSQL's statistics views hand back.
//
// Holds the TableStats, WaitingPartition and IndexStats types the statistics
// rules read.

/**
 * One row of PostgreSQL's own per-table statistics.
 *
 * Field names follow pg_stat_user_tables rather than this project's camelCase,
 * because the whole point of these numbers is that they came from the server —
 * renaming them would make the rule harder to check against the catalog.
 */
export type TableStats = {
  table_name: string;
  seq_scan: number;
  /** Rows read by all those sequential scans together. */
  seq_tup_read: number;
  idx_scan: number;
  n_live_tup: number;
  n_dead_tup: number;
  /**
   * When ANALYZE last ran on it, by hand or by autovacuum. Null when the
   * counters hold no record of one: never run, or not since they last started.
   */
  last_analyzed: string | null;
  /**
   * Whether pg_stats holds anything for this table's columns: what ANALYZE
   * collects, and what a statistics reset or a crash leaves in place.
   */
  has_statistics: boolean;
  /** Heap pages served from cache and read from disk, for the hit ratio. */
  heap_blks_hit: number;
  heap_blks_read: number;
};

/**
 * A partition that a partitioned table's index is still waiting for: no
 * finished copy of the index is attached for it.
 */
export type WaitingPartition = {
  schema: string;
  table: string;
  /** Partitioned itself, so CREATE INDEX CONCURRENTLY is refused on it. */
  partitioned: boolean;
  /** A foreign table, which PostgreSQL cannot build an index on at all. */
  foreign: boolean;
  /**
   * Partitioned, with a foreign table somewhere among its own partitions. A
   * unique index cannot cover a foreign table, so that one has to go first.
   */
  foreign_below: boolean;
  /** The copy attached for it that is not finished (in its schema), or null. */
  attached: string | null;
};

/**
 * One index for the statistics rules: a row of pg_stat_user_indexes, joined
 * to what the index is for. A partitioned table's own index is never in that
 * view, so the route reads an unfinished one from pg_index and adds it here.
 */
export type IndexStats = {
  table_name: string;
  index_name: string;
  idx_scan: number;
  /** Unique indexes are enforcing something, so an unused one is not waste. */
  is_unique: boolean;
  is_primary: boolean;
  /**
   * False after a CREATE INDEX CONCURRENTLY or REINDEX CONCURRENTLY failed
   * part-way, and for a partitioned table's index until every partition has a
   * finished copy attached.
   */
  is_valid: boolean;
  /** A constraint (primary key, unique, exclusion) owns this index. */
  backs_constraint: boolean;
  /**
   * One partition's piece of a partitioned table's index. The index of a
   * partition that is partitioned itself is this and is_partitioned both.
   */
  is_partition_child: boolean;
  /**
   * The index of a partitioned table. It holds no rows itself: each partition
   * has its own copy, attached to it.
   */
  is_partitioned: boolean;
  size_bytes: number;
  /** pg_get_indexdef, read with nothing on the search_path, so fully qualified. */
  definition: string;
  /**
   * For an unfinished partitioned index: the partitions one level down that
   * have no finished copy attached, in name order.
   */
  waiting_on?: WaitingPartition[];
  /** For an unfinished partitioned index: one of its attached copies, or null when it has none. */
  attached_example?: { schema: string; name: string } | null;
  /** For a partitioned index that is a partition's copy: the index at the top of its tree. */
  top_index?: { schema: string; table: string; name: string } | null;
  /** pg_get_constraintdef of the constraint that owns the index, or null when none does. */
  constraint_definition?: string | null;
};
