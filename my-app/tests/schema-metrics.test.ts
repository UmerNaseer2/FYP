// Monitoring's size reading, and the connection it borrows to take it.
//
// The size query runs on a client from the same pool Deploy uses for the same
// saved connection. It used to run a plain `SET statement_timeout = 5000`, which
// stays on the connection after release: the next migration handed that client
// was cut off after five seconds. These tests pin the fix: the timeout is SET
// LOCAL inside a transaction, the transaction always ends, and a connection that
// cannot even roll back is closed instead of going back to the pool.
//
// Nothing reaches a real database: the metadata pool, the config builder and the
// target pool are all stand-ins.
import { createFakeClient, queryTexts, type FakeClient, type FakeStep } from "./helpers/fake-pg";
import { schema, table, column } from "./helpers/snapshots";

// The metadata database: the connection row for the tracked schema, then the
// INSERT of the reading.
const mockPoolQuery = jest.fn<Promise<unknown>, [string, unknown[]?]>();
jest.mock("../lib/version-db", () => ({
  __esModule: true,
  default: { query: (text: string, values?: unknown[]) => mockPoolQuery(text, values) },
}));

jest.mock("../lib/connection-config", () => ({
  buildPgConfig: () => ({ host: "target.example", database: "app" }),
}));

let mockClient: FakeClient;
jest.mock("../lib/postgres", () => ({
  getPoolForConfig: () => ({ connect: async () => mockClient }),
}));

import { recordSchemaMetrics } from "@/lib/schema-metrics";

const CONNECTION_ROW = {
  type: "PostgreSQL",
  host: "target.example",
  port: 5432,
  database_name: "app",
  username: "reader",
  password: null,
  connection_string: null,
  ssl: false,
  ssl_mode: null,
};

/** The values bound to the INSERT, or null when no reading was stored. */
function insertedValues(): unknown[] | null {
  const insert = mockPoolQuery.mock.calls.find(([text]) => /INSERT INTO schema_metrics/.test(text));
  return insert ? (insert[1] ?? null) : null;
}

function setUp(steps: FakeStep[]) {
  mockClient = createFakeClient(steps);
  mockPoolQuery.mockReset();
  mockPoolQuery.mockImplementation(async (text: string) =>
    /FROM tracked_schemas/.test(text) ? { rows: [CONNECTION_ROW] } : { rows: [] }
  );
}

const live = schema([table("orders", [column("id")])], { schema: "app" });

describe("recordSchemaMetrics — the borrowed connection", () => {
  it("sets the timeout with SET LOCAL inside a transaction that it commits", async () => {
    setUp([
      {
        match: /pg_total_relation_size/,
        rows: [{ total_bytes: "8192", index_bytes: "0", estimated_rows: "3" }],
      },
    ]);

    expect(await recordSchemaMetrics({ trackedSchemaId: 7, live, drifted: false })).toBe(true);

    const texts = queryTexts(mockClient);
    expect(texts[0]).toBe("BEGIN READ ONLY");
    expect(texts[1]).toMatch(/^SET LOCAL statement_timeout = \d+$/);
    expect(texts[texts.length - 1]).toBe("COMMIT");
    // No session-level SET anywhere: that is the setting that outlives release().
    expect(texts.some((text) => /^SET (?!LOCAL)/.test(text))).toBe(false);
    expect(mockClient.releaseCount).toBe(1);
    expect(mockClient.releasedWith).toBe(false);

    const values = insertedValues();
    expect(values).not.toBeNull();
    // total_bytes, index_bytes, estimated_rows are bound 8th to 10th.
    expect(values?.slice(7, 10)).toEqual([8192, 0, 3]);
  });

  it("rolls back when the size query times out, and still stores the counts", async () => {
    setUp([
      {
        match: /pg_total_relation_size/,
        error: { code: "57014", message: "canceling statement due to statement timeout" },
      },
    ]);
    const quiet = jest.spyOn(console, "error").mockImplementation(() => undefined);

    expect(await recordSchemaMetrics({ trackedSchemaId: 7, live, drifted: true })).toBe(true);
    quiet.mockRestore();

    const texts = queryTexts(mockClient);
    expect(texts).toContain("ROLLBACK");
    expect(texts).not.toContain("COMMIT");
    // The rollback worked, so the connection is healthy and goes back to the pool.
    expect(mockClient.releasedWith).toBe(false);
    // A size that could not be read is a gap: three nulls, never zeros.
    expect(insertedValues()?.slice(7, 10)).toEqual([null, null, null]);
  });

  it("closes the connection instead of pooling it when even ROLLBACK fails", async () => {
    setUp([
      { match: /pg_total_relation_size/, error: { message: "Connection terminated unexpectedly" } },
      { match: /^ROLLBACK$/, error: { message: "Client was closed and is not queryable" } },
    ]);
    const quiet = jest.spyOn(console, "error").mockImplementation(() => undefined);

    await recordSchemaMetrics({ trackedSchemaId: 7, live, drifted: false });
    quiet.mockRestore();

    expect(mockClient.releaseCount).toBe(1);
    expect(mockClient.releasedWith).toBe(true);
  });
});

describe("recordSchemaMetrics — what the size query counts", () => {
  it("leaves partitioned parents out and turns an unanalysed, non-empty table into unknown", async () => {
    setUp([
      {
        match: /pg_total_relation_size/,
        rows: [{ total_bytes: "16384", index_bytes: "8192", estimated_rows: null }],
      },
    ]);

    await recordSchemaMetrics({ trackedSchemaId: 7, live, drifted: false });

    const sizeQuery = mockClient.queries.find((query) => /pg_total_relation_size/.test(query.text));
    expect(sizeQuery?.text).toMatch(/c\.relkind IN \('r', 'm'\)/);
    expect(sizeQuery?.text).toMatch(/c\.reltuples < 0 AND pg_relation_size\(c\.oid\) > 0/);
    // The server said the estimate is unknown; the stored reading keeps it unknown.
    expect(insertedValues()?.slice(7, 10)).toEqual([16384, 8192, null]);
  });
});
