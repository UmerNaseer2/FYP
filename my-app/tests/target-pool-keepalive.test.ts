// The pools that reach other people's databases notice one that went away.
//
// A drift check against a database that stopped answering (its network
// dropped, its server frozen) used to wait on the socket for ever:
// statement_timeout is enforced by the server, so a server that is gone never
// sends the error, and pg sets no limit of its own. TCP keepalive lets the
// operating system notice the silence and close the socket, which pg then
// reports as an ordinary error.
//
// Nothing here reaches a real database: the pg module is a stand-in that
// records what each pool was built with.
import { getPoolForConfig } from "@/lib/postgres";

const mockPoolsBuilt: Record<string, unknown>[] = [];
jest.mock("pg", () => ({
  Pool: jest.fn((config: Record<string, unknown>) => {
    mockPoolsBuilt.push(config);
    return { on: jest.fn(), connect: jest.fn(), query: jest.fn(), end: jest.fn() };
  }),
}));

beforeEach(() => {
  mockPoolsBuilt.length = 0;
});

describe("a pool for a target database", () => {
  it("asks the operating system to check on a quiet connection", () => {
    getPoolForConfig({ host: "db.example.com", port: 5432, database: "app" });
    expect(mockPoolsBuilt).toHaveLength(1);
    expect(mockPoolsBuilt[0]).toMatchObject({
      keepAlive: true,
      keepAliveInitialDelayMillis: 10_000,
    });
  });

  it("puts no time limit on every query", () => {
    // The same pools run migrations (app/api/scripts/apply), and a migration
    // that rewrites a big table can honestly take longer than any limit set here.
    getPoolForConfig({ host: "other.example.com", port: 5432, database: "app" });
    expect(mockPoolsBuilt).toHaveLength(1);
    expect(mockPoolsBuilt[0]).not.toHaveProperty("query_timeout");
    expect(mockPoolsBuilt[0]).not.toHaveProperty("statement_timeout");
  });
});
