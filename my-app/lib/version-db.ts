import { metadataPool } from "./db/sequelize";

/**
 * The app's own database — the one place that hands out a connection to it.
 *
 * `pool` is not a `pg.Pool` any more: it is a thin, pg-shaped view over
 * Sequelize's pool (lib/db/sequelize.ts). Every read and write of the metadata
 * tables is parameterised SQL run through it. Sequelize itself only defines and
 * creates the tables and owns the pool, so there is one pool and no second one
 * competing for the same connection limit.
 *
 * The tables themselves are defined in lib/db/models.ts and created by
 * `syncMetadataTables()`, re-exported here so every caller reaches the metadata
 * store through one module.
 */
const pool = metadataPool;

export { syncMetadataTables } from "./db/bootstrap";

export default pool;
