import { Sequelize } from "sequelize";
import * as pg from "pg";
import { parse as parseConnectionString } from "pg-connection-string";
import type { PoolClient, QueryResult, QueryResultRow } from "pg";

/**
 * The app's own metadata database, as Sequelize sees it.
 *
 * Two very different kinds of database work happen in this project, and only
 * one of them belongs to an ORM:
 *
 *   • This database — connections, snapshots, lineage, drift, comparison sets,
 *     approvals, profiles. A fixed schema the app owns. Sequelize defines those
 *     tables (lib/db/models.ts), creates them, and does the reading and writing.
 *
 *   • The databases being COMPARED and DEPLOYED to. Arbitrary schemas the app
 *     has never seen, read out of pg_catalog and changed with generated DDL.
 *     There is nothing for an ORM to model there, so lib/postgres.ts keeps
 *     talking to them with the driver directly.
 *
 * A handful of metadata reads are genuinely SQL — a recursive walk up a lineage,
 * an advisory lock, an aggregate feed. Those stay as SQL and run through
 * `metadataPool` below, which borrows a connection from this same Sequelize
 * pool. One pool, one place that knows the connection string.
 */

declare global {
  // Next reloads modules on every edit in dev. Without this the app would open
  // a new pool per reload and exhaust the server's connection slots.
  var __metadataSequelize: Sequelize | undefined;
}

const connectionString = process.env.DATABASE_URL_A;

if (!connectionString) {
  // DATABASE_URL_A is the app's own metadata store. Without it the app can't
  // function, so fail loudly with a message that names where to set it in both
  // environments.
  throw new Error(
    "DATABASE_URL_A is not set. Add it to your environment — .env.local for local dev, or your Vercel project's Environment Variables for deployment."
  );
}

/**
 * Hosted Postgres (Supabase, Neon, RDS) requires SSL but commonly presents a
 * cert chain the runtime doesn't trust, so accept the cert without local CA
 * verification — the same thing lib/connection-config.ts does for target DBs.
 * Local Postgres (localhost) speaks no SSL, so leave it off there.
 */
function isLocal(url: string): boolean {
  let host = "";
  try {
    host = parseConnectionString(url).host ?? "";
  } catch {
    host = "";
  }
  return host === "" || host === "localhost" || host === "127.0.0.1" || host === "::1";
}

function createSequelize(): Sequelize {
  return new Sequelize(connectionString!, {
    dialect: "postgres",
    // The driver is passed in rather than resolved by name so the bundler can
    // see it — Sequelize's own `require("pg")` is invisible to Turbopack.
    dialectModule: pg,
    logging: false,
    dialectOptions: isLocal(connectionString!)
      ? {}
      : { ssl: { require: true, rejectUnauthorized: false } },
    pool: { max: 5, idle: 10_000 },
    define: {
      // The tables predate this file and are named the way SQL names things.
      // Sequelize would otherwise pluralise and camel-case them out from under
      // the queries that still read them directly.
      freezeTableName: true,
      underscored: true,
      timestamps: false,
    },
  });
}

export const sequelize: Sequelize =
  globalThis.__metadataSequelize ?? createSequelize();

if (process.env.NODE_ENV !== "production") {
  globalThis.__metadataSequelize = sequelize;
}

// ---------------------------------------------------------------------------
// The SQL escape hatch.
// ---------------------------------------------------------------------------

/**
 * A borrowed connection, with the two methods the SQL callers use.
 *
 * `release()` hands it back to Sequelize's pool. Forgetting to call it leaks a
 * connection, exactly as it would with the driver's own pool, so every caller
 * releases in a `finally`.
 */
export type MetadataClient = {
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
  query<R extends QueryResultRow = any>(
    text: string,
    values?: unknown[]
  ): Promise<QueryResult<R>>;
  release(): void;
};

/**
 * Sequelize hands out the driver's own client here, which is why the SQL that
 * needs to stay SQL can keep its `$1` placeholders and its `result.rows`.
 */
async function borrow(): Promise<PoolClient> {
  // "write" because there are no read replicas here — every statement, SELECT
  // included, goes to the one database.
  const connection = await sequelize.connectionManager.getConnection({ type: "write" });
  return connection as unknown as PoolClient;
}

function giveBack(connection: PoolClient): void {
  sequelize.connectionManager.releaseConnection(connection as unknown as object);
}

/**
 * Drop-in for a `pg.Pool`: the shape the metadata SQL was written against, over
 * Sequelize's pool. Kept deliberately small — `query` for one statement and
 * `connect` for a transaction — so there is no third way to reach the database.
 *
 * The row type defaults to `any` because that is what `pg` itself defaults to,
 * and a good half of the metadata queries pass no type argument at all.
 * Tightening the default here would not make those queries safer — it would
 * only make them stop compiling.
 */
export const metadataPool = {
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
  async query<R extends QueryResultRow = any>(
    text: string,
    values?: unknown[]
  ): Promise<QueryResult<R>> {
    const connection = await borrow();
    try {
      return await connection.query<R>(text, values as unknown[] | undefined);
    } finally {
      giveBack(connection);
    }
  },

  /**
   * One connection held across several statements — what BEGIN/COMMIT needs.
   * The caller releases it.
   */
  async connect(): Promise<MetadataClient> {
    const connection = await borrow();
    let released = false;
    return {
      query: (text, values) => connection.query(text, values as unknown[] | undefined),
      release: () => {
        // Releasing twice would return someone else's connection to the pool.
        if (released) return;
        released = true;
        giveBack(connection);
      },
    };
  },
};
