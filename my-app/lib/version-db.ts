import { metadataPool } from "./db/sequelize";

/**
 * The app's own database — the one place that hands out a connection to it.
 *
 * `pool` is not a `pg.Pool` any more: it is a thin, pg-shaped view over
 * Sequelize's pool (lib/db/sequelize.ts). Keeping the shape means the metadata
 * reads that are genuinely SQL — a recursive walk up a lineage, an advisory
 * lock, an aggregate feed — stay written as SQL and still run on the same
 * single pool as the model calls, instead of a second pool competing for the
 * same connection limit.
 *
 * The tables themselves are defined in lib/db/models.ts and created by
 * `syncMetadataTables()`, re-exported here so every caller reaches the metadata
 * store through one module.
 */
const pool = metadataPool;

export { syncMetadataTables } from "./db/bootstrap";

export default pool;
