// POST /api/lineage/rebaseline: a reading that went stale while it was taken.
//
// Re-baseline reads the live schema off another server — which takes as long as
// that server takes — and then writes what it read as the newest version of the
// lineage. A deploy finishing inside that window writes its own snapshot first,
// so the reading in hand is now older than the head it would be saved on top of.
// Saving it anyway records the pre-deploy picture as the newer version, and the
// next drift check reports the deploy's own new table as an unexplained change.
//
// The advisory lock does not catch this. It serialises the two writers, which is
// a different question from whether one of them is holding stale data: this
// request waits its turn, gets the lock, and writes its out-of-date reading
// perfectly safely. So the head is noted before the read and checked again once
// the lock is held.
//
// Nothing here reaches a database: the metadata pool and the live-schema read
// are both stand-ins.
import { NextRequest } from "next/server";
import { createFakeClient, queryTexts, type FakeClient, type FakeStep } from "./helpers/fake-pg";

/** The lineage head each of the two reads reports, and the order they ran in. */
let headBeforeRead: number | null = null;
let headUnderLock: number | null = null;
let callOrder: string[] = [];
let client: FakeClient;

// Relative paths on purpose: next/jest rewrites the @/ alias inside import
// statements only, so jest.mock("@/...") would not resolve.
jest.mock("../lib/auth-guard", () => ({
  requireEditor: async () => ({ ok: true, principal: null }),
}));

jest.mock("../lib/connection-config", () => ({
  buildPgConfig: () => ({ host: "db.test", port: 5432, database: "app" }),
}));

// Only the one function that opens a connection to the tracked server is
// replaced. Listing this module's exports by hand would silently stub out
// withoutToolTables and the rest, which lineage-db imports.
jest.mock("../lib/postgres", () => ({
  ...jest.requireActual("../lib/postgres"),
  fetchSchemaSnapshot: async () => {
    mockRecord("read the live schema");
    return { ok: true, data: { database: "app", schema: "public", tables: [] } };
  },
}));

jest.mock("../lib/version-db", () => ({
  __esModule: true,
  default: {
    query: async (text: string) => {
      if (/FROM tracked_schemas/.test(text)) return { rows: [mockTracked], rowCount: 1 };
      if (/FROM lineage_migrations/.test(text)) {
        mockRecord("noted the head");
        const seq = mockHeads.beforeRead;
        return { rows: seq === null ? [] : [{ seq }], rowCount: seq === null ? 0 : 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    connect: async () => mockClient(),
  },
  syncMetadataTables: async () => undefined,
}));

// The factories above run before the module body, so they cannot close over an
// ordinary const — a `mock`-prefixed name is the exception jest allows.
const mockTracked = {
  schema_name: "public",
  connection_name: "Sales dev",
  host: "db.test",
  port: 5432,
  database_name: "app",
  type: "PostgreSQL",
  username: "app",
  password: "not-a-real-password",
  connection_string: null,
  ssl: false,
  ssl_mode: "disable",
};
const mockHeads = {
  get beforeRead() {
    return headBeforeRead;
  },
};
function mockRecord(step: string) {
  callOrder.push(step);
}
function mockClient(): FakeClient {
  const steps: FakeStep[] = [
    {
      match: /FROM lineage_migrations lm/,
      rows:
        headUnderLock === null
          ? []
          : [{ version: `1.${headUnderLock}.0`, seq: headUnderLock, snapshot: null }],
    },
    { match: /INSERT INTO snapshots/, rows: [{ id: 99 }] },
  ];
  client = createFakeClient(steps);
  return client;
}

type RouteModule = typeof import("../app/api/lineage/rebaseline/route");
let POST: RouteModule["POST"];

beforeAll(async () => {
  ({ POST } = await import("../app/api/lineage/rebaseline/route"));
});

beforeEach(() => {
  callOrder = [];
});

/** Re-baseline tracked schema 7, with the two head reads answering as set. */
async function rebaseline(before: number | null, underLock: number | null) {
  headBeforeRead = before;
  headUnderLock = underLock;
  const res = await POST(
    new NextRequest("http://localhost/api/lineage/rebaseline", {
      method: "POST",
      body: JSON.stringify({ trackedSchemaId: 7 }),
    })
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("a deploy that lands while the schema is being read", () => {
  it("is refused instead of being overwritten by the older reading", async () => {
    const { status, body } = await rebaseline(3, 4);

    expect(status).toBe(409);
    // The reader has to know their own request did nothing, or they will not
    // re-run it — and the stale version would stand.
    expect(String(body.error)).toContain("Nothing was saved");
    expect(String(body.error)).toContain("out of date");
  });

  it("writes nothing on the way out", async () => {
    await rebaseline(3, 4);
    const sent = queryTexts(client);

    // The whole point of stopping here rather than later: no snapshot row, no
    // lineage row, no drift event, and the transaction is given back unused.
    expect(sent.filter((q) => /^INSERT/.test(q))).toHaveLength(0);
    expect(sent).toContain("ROLLBACK");
    expect(sent).not.toContain("COMMIT");
    expect(client.releaseCount).toBe(1);
  });

  it("is caught when the lineage was created from nothing while reading", async () => {
    // No lineage at all when the head was noted, and a first baseline written
    // by somebody else before the lock was granted. Both reads have an answer
    // here — "none" and "seq 2" — and they still disagree.
    const { status, body } = await rebaseline(null, 2);

    expect(status).toBe(409);
    expect(String(body.error)).toContain("Nothing was saved");
  });

  it("notes the head before reading the schema, not after", async () => {
    // Reading it afterwards would compare the head against itself and let
    // every one of these races through. This ordering IS the fix.
    await rebaseline(3, 3);

    expect(callOrder).toEqual(["noted the head", "read the live schema"]);
  });
});

describe("a re-baseline nobody raced", () => {
  it("commits the new version on top of the head it expected", async () => {
    const { status, body } = await rebaseline(3, 3);

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.seq).toBe(4);
    // No previous snapshot to diff against, so the bump is the additive one.
    expect(body.version).toBe("1.4.0");
    expect(queryTexts(client)).toContain("COMMIT");
  });

  it("still works for a schema with no lineage yet", async () => {
    // Nothing to be stale against. A check that treated "no rows" as a missing
    // answer rather than as seq 0 would refuse every first baseline.
    const { status, body } = await rebaseline(null, null);

    expect(status).toBe(200);
    expect(body.seq).toBe(1);
    expect(queryTexts(client)).toContain("COMMIT");
  });

  it("writes the snapshot, the lineage row and the drift event", async () => {
    await rebaseline(3, 3);
    const sent = queryTexts(client);

    // The guard sits directly above these three writes, so a version of it that
    // was slightly too eager would show up as a re-baseline that does nothing.
    expect(sent.some((q) => /INSERT INTO snapshots/.test(q))).toBe(true);
    expect(sent.some((q) => /INSERT INTO lineage_migrations/.test(q))).toBe(true);
    expect(sent.some((q) => /INSERT INTO drift_events/.test(q))).toBe(true);
  });
});
