import { Sequelize } from "sequelize";
import * as pg from "pg";
import type { PoolClient, QueryResult, QueryResultRow } from "pg";
import { metadataWantsSsl } from "./metadata-ssl";

/**
 * The app's own metadata database, as Sequelize sees it.
 *
 * Two very different kinds of database work happen in this project, and only
 * one of them belongs to an ORM:
 *
 *   • This database — connections, snapshots, lineage, drift, comparison sets,
 *     approvals, profiles. A fixed schema the app owns. Sequelize defines those
 *     tables (lib/db/models.ts), creates them, and owns the connection pool.
 *
 *   • The databases being COMPARED and DEPLOYED to. Arbitrary schemas the app
 *     has never seen, read out of pg_catalog and changed with generated DDL.
 *     There is nothing for an ORM to model there, so lib/postgres.ts keeps
 *     talking to them with the driver directly.
 *
 * The reading and writing of those tables is not done through the models. Every
 * read and write is parameterised SQL (`$1` placeholders, never values pasted
 * into the text) run through `metadataPool` below, which borrows a connection
 * from this same Sequelize pool. One pool, one place that knows the connection
 * string.
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
 * Time limits for this pool. Without them a database that is paused, or a
 * network that drops packets, leaves every page waiting: the driver has no
 * limit of its own on a connect or on a statement.
 *
 *  - CONNECT: how long opening one connection may take.
 *  - QUERY: how long one statement may take. The driver counts this itself
 *    rather than asking the server to (statement_timeout), because a server-side
 *    setting sent at connect time is refused by some connection poolers.
 *  - ACQUIRE: how long a caller waits for one of the pool's connections.
 *    Longer than CONNECT, so a failed connect is reported as what it is.
 */
export const METADATA_CONNECT_TIMEOUT_MS = 10_000;
export const METADATA_QUERY_TIMEOUT_MS = 60_000;
export const METADATA_ACQUIRE_TIMEOUT_MS = 15_000;

/**
 * Hosted Postgres (Supabase, Neon, RDS) requires SSL but commonly presents a
 * cert chain the runtime doesn't trust, so when SSL is on, accept the cert
 * without local CA verification, the same thing lib/connection-config.ts does
 * for target DBs. Whether SSL is on at all (it is off for localhost, and for a
 * URL with sslmode=disable such as the one docker-compose.yml builds) is
 * decided in ./metadata-ssl.
 */
function createSequelize(): Sequelize {
  return new Sequelize(connectionString!, {
    dialect: "postgres",
    // The driver is passed in rather than resolved by name so the bundler can
    // see it — Sequelize's own `require("pg")` is invisible to Turbopack.
    dialectModule: pg,
    logging: false,
    dialectOptions: {
      ...(metadataWantsSsl(connectionString!)
        ? { ssl: { require: true, rejectUnauthorized: false } }
        : {}),
      connectionTimeoutMillis: METADATA_CONNECT_TIMEOUT_MS,
      query_timeout: METADATA_QUERY_TIMEOUT_MS,
      // Lets the operating system notice a server that has gone silent.
      keepAlive: true,
    },
    pool: { max: 5, idle: 10_000, acquire: METADATA_ACQUIRE_TIMEOUT_MS },
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

/** The driver's error when a statement outlives METADATA_QUERY_TIMEOUT_MS. */
function isQueryTimeout(error: unknown): boolean {
  return error instanceof Error && error.message === "Query read timeout";
}

/**
 * Close a connection instead of handing it back.
 *
 * For a connection whose statement timed out. The driver stops waiting, but the
 * server may still be running the statement, and the connection can carry
 * nothing else until it ends. Handed back, it would make the next caller wait
 * behind it and time out too. Closing it lets the pool open a fresh one.
 */
async function closeStuck(connection: PoolClient): Promise<void> {
  try {
    await sequelize.connectionManager.destroyConnection(connection as unknown as object);
  } catch (error) {
    console.error(
      "Metadata database: could not close a timed-out connection:",
      error instanceof Error ? error.message : error
    );
  }
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
    let timedOut = false;
    try {
      return await connection.query<R>(text, values as unknown[] | undefined);
    } catch (error) {
      timedOut = isQueryTimeout(error);
      throw error;
    } finally {
      if (timedOut) await closeStuck(connection);
      else giveBack(connection);
    }
  },

  /**
   * One connection held across several statements — what BEGIN/COMMIT needs.
   * The caller releases it.
   */
  async connect(): Promise<MetadataClient> {
    const connection = await borrow();
    let released = false;
    let timedOut = false;
    return {
      query: async (text, values) => {
        try {
          return await connection.query(text, values as unknown[] | undefined);
        } catch (error) {
          if (isQueryTimeout(error)) timedOut = true;
          throw error;
        }
      },
      release: () => {
        // Releasing twice would return someone else's connection to the pool.
        if (released) return;
        released = true;
        // closeStuck never rejects, so there is nothing to wait for here.
        if (timedOut) void closeStuck(connection);
        else giveBack(connection);
      },
    };
  },
};
