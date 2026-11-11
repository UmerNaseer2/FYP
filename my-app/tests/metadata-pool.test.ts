/**
 * @jest-environment node
 */
// The app's own database pool (lib/db/sequelize.ts) and its time limits.
//
// It used to have none: a paused database, or a network that drops packets, left
// every signed-in page waiting for a minute, and one statement stuck behind a
// lock held a connection for ever. Nothing here connects anywhere: Sequelize
// opens no connection until one is asked for, and the tests hand it a fake one.

import type { Options } from "sequelize";

type SequelizeModule = typeof import("../lib/db/sequelize");

/** A connection whose one statement ends the way the test says. */
function fakeConnection(outcome: { rows: unknown[] } | Error) {
  return {
    query: jest.fn(async () => {
      if (outcome instanceof Error) throw outcome;
      return outcome;
    }),
  };
}

describe("the metadata pool", () => {
  let db: SequelizeModule;
  let release: jest.SpyInstance;
  let destroy: jest.SpyInstance;

  beforeAll(async () => {
    // A hosted-looking address, so the SSL setting is switched on as well.
    process.env.DATABASE_URL_A = "postgres://user:secret@db.example.com:5432/app";
    db = await import("../lib/db/sequelize");
  });

  /** Make the pool hand out this connection, and watch where it goes afterwards. */
  function handOut(connection: object): void {
    const manager = db.sequelize.connectionManager;
    jest.spyOn(manager, "getConnection").mockResolvedValue(connection);
    release = jest.spyOn(manager, "releaseConnection").mockImplementation(() => {});
    destroy = jest.spyOn(manager, "destroyConnection").mockResolvedValue(undefined);
  }

  /** The options the pool was made with. Sequelize keeps them, but its types do not say so. */
  function poolOptions(): Options {
    return (db.sequelize as unknown as { options: Options }).options;
  }

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("limits how long a connect, a statement and a wait for a connection may take", () => {
    const options = poolOptions();
    expect(options.dialectOptions).toMatchObject({
      connectionTimeoutMillis: db.METADATA_CONNECT_TIMEOUT_MS,
      query_timeout: db.METADATA_QUERY_TIMEOUT_MS,
      keepAlive: true,
    });
    expect(options.pool?.acquire).toBe(db.METADATA_ACQUIRE_TIMEOUT_MS);

    expect(db.METADATA_CONNECT_TIMEOUT_MS).toBe(10_000);
    expect(db.METADATA_QUERY_TIMEOUT_MS).toBe(60_000);
    // A failed connect has to be reported before the wait for a slot gives up.
    expect(db.METADATA_ACQUIRE_TIMEOUT_MS).toBeGreaterThan(db.METADATA_CONNECT_TIMEOUT_MS);
  });

  it("keeps the SSL setting next to the limits", () => {
    expect(poolOptions().dialectOptions).toMatchObject({
      ssl: { require: true, rejectUnauthorized: false },
    });
  });

  it("hands a connection back after an ordinary statement", async () => {
    const connection = fakeConnection({ rows: [{ one: 1 }] });
    handOut(connection);

    const result = await db.metadataPool.query("SELECT 1 AS one");

    expect(result.rows).toEqual([{ one: 1 }]);
    expect(release).toHaveBeenCalledWith(connection);
    expect(destroy).not.toHaveBeenCalled();
  });

  it("hands a connection back after an ordinary error", async () => {
    const connection = fakeConnection(new Error('relation "nope" does not exist'));
    handOut(connection);

    await expect(db.metadataPool.query("SELECT * FROM nope")).rejects.toThrow("nope");

    expect(release).toHaveBeenCalledWith(connection);
    expect(destroy).not.toHaveBeenCalled();
  });

  it("closes a connection whose statement timed out instead of handing it back", async () => {
    // The server may still be running the statement, so the next caller to get
    // this connection would wait behind it and time out too.
    const connection = fakeConnection(new Error("Query read timeout"));
    handOut(connection);

    await expect(db.metadataPool.query("SELECT pg_sleep(600)")).rejects.toThrow(
      "Query read timeout"
    );

    expect(destroy).toHaveBeenCalledWith(connection);
    expect(release).not.toHaveBeenCalled();
  });

  it("does the same for a connection held across a transaction", async () => {
    const connection = fakeConnection(new Error("Query read timeout"));
    handOut(connection);

    const client = await db.metadataPool.connect();
    await expect(client.query("SELECT pg_sleep(600)")).rejects.toThrow("Query read timeout");
    client.release();
    client.release();

    expect(destroy).toHaveBeenCalledTimes(1);
    expect(destroy).toHaveBeenCalledWith(connection);
    expect(release).not.toHaveBeenCalled();
  });
});
