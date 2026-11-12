// lineage-db: grading a lineage bump from how the structure moved since HEAD.
//
// Re-baseline compared the stored HEAD (left) with the live database (right).
// compareSchemas describes the migration that makes its RIGHT side match its
// LEFT, so every change since HEAD was graded as its own undo: a column added
// on the live database read as one a sync would drop, and got a major bump,
// while a dropped table read as one a sync would create, and got a minor one.
//
// A rollback had a related problem. It reused the level stored on the version
// it undid, which describes the forward change: undoing "add a column" drops
// that column, which is breaking, and it was recorded as additive.
//
// Nothing here reaches a database: the metadata pool and the live-schema read
// are both stand-ins.
import type { SchemaSnapshot, ViewSnapshot } from "../lib/postgres";
import { createFakeClient, queriesMatching, type FakeClient } from "./helpers/fake-pg";
import { column, schema, table } from "./helpers/snapshots";

let client: FakeClient;

jest.mock("../lib/postgres", () => ({
  ...jest.requireActual("../lib/postgres"),
  fetchSchemaSnapshot: async () => ({ ok: true, data: mockShapes.live }),
}));

jest.mock("../lib/version-db", () => ({
  __esModule: true,
  default: {
    // The tracked-schema lookup: schema 7, last checked in sync.
    query: async (text: string) =>
      /FROM unnest/.test(text)
        ? {
            rows: [
              {
                connection_id: 3,
                schema_name: "public",
                id: 7,
                head_version: "1.3.0",
                drift_status: "in_sync",
              },
            ],
            rowCount: 1,
          }
        : { rows: [], rowCount: 0 },
    connect: async () => {
      client = createFakeClient([
        {
          match: /FROM lineage_migrations/,
          rows: [{ version: "1.3.0", seq: 3, snapshot: mockShapes.head }],
        },
        { match: /INSERT INTO snapshots/, rows: [{ id: 41 }] },
      ]);
      return client;
    },
  },
  syncMetadataTables: async () => undefined,
}));

// Read by the factories above at call time, which jest allows for a name
// starting with `mock`.
const mockShapes: { live: SchemaSnapshot; head: SchemaSnapshot | null } = {
  live: schema([]),
  head: null,
};

type LineageModule = typeof import("../lib/lineage-db");
let lineage: LineageModule;

beforeAll(async () => {
  lineage = await import("../lib/lineage-db");
});

const orders = (cols: string[]) => table("orders", cols.map((name) => column(name)));

function view(name: string): ViewSnapshot {
  return {
    name,
    materialized: false,
    dependsOn: ["orders"],
    definition: " SELECT id FROM orders;",
    normalizedDefinition: "select id from orders",
    columns: ["id"],
  };
}

describe("structuralChangeLevel(head, live)", () => {
  const level = (head: SchemaSnapshot, live: SchemaSnapshot) =>
    lineage.structuralChangeLevel(head, live);

  it("grades an added column or table as additive", () => {
    expect(level(schema([orders(["id"])]), schema([orders(["id", "note"])]))).toBe("additive");
    expect(
      level(schema([orders(["id"])]), schema([orders(["id"]), table("refunds", [column("id")])]))
    ).toBe("additive");
  });

  it("grades a dropped column or table as breaking", () => {
    // A dropped column used to grade as additive even the right way round: it
    // only showed up as a changed table.
    expect(level(schema([orders(["id", "note"])]), schema([orders(["id"])]))).toBe("breaking");
    expect(
      level(schema([orders(["id"]), table("refunds", [column("id")])]), schema([orders(["id"])]))
    ).toBe("breaking");
  });

  it("grades an added view as additive and a dropped one as breaking", () => {
    const plain = schema([orders(["id"])], { views: [] });
    const withView = schema([orders(["id"])], { views: [view("big_orders")] });

    expect(level(plain, withView)).toBe("additive");
    expect(level(withView, plain)).toBe("breaking");
  });

  it("grades no change as a patch", () => {
    expect(level(schema([orders(["id"])]), schema([orders(["id"])]))).toBe("patch");
  });
});

describe("recordAppliedMigrationToLineage", () => {
  const deploy = {
    orgId: 1,
    connectionId: 3,
    schemaName: "public",
    targetConfig: { host: "db.test" },
    name: "Revert orders_fix v1.3.0",
    sqlRef: null,
  };

  /** The level and version bound into the new lineage row ($4 and $5). */
  function recordedBump(): unknown[] | undefined {
    const [insert] = queriesMatching(client, /INSERT INTO lineage_migrations/);
    return insert.values?.slice(3, 5);
  }

  beforeEach(() => {
    mockShapes.head = schema([orders(["id", "note"])]);
    mockShapes.live = schema([orders(["id"])]);
  });

  it("grades from the structure when asked, not from the level passed in", async () => {
    // Undoing "add a column" drops it: breaking, whatever the forward level was.
    const result = await lineage.recordAppliedMigrationToLineage({
      ...deploy,
      changeLevel: "additive",
      levelFromStructure: true,
    });

    expect(result).toMatchObject({ advanced: true, version: "2.0.0" });
    expect(recordedBump()).toEqual(["breaking", "2.0.0"]);
  });

  it("falls back to the level passed in when HEAD has no snapshot", async () => {
    mockShapes.head = null;
    const result = await lineage.recordAppliedMigrationToLineage({
      ...deploy,
      changeLevel: "additive",
      levelFromStructure: true,
    });

    expect(result).toMatchObject({ advanced: true, version: "1.4.0" });
  });

  it("keeps the level passed in for a deploy, and does not read HEAD's snapshot", async () => {
    const result = await lineage.recordAppliedMigrationToLineage({ ...deploy, changeLevel: "additive" });

    expect(result).toMatchObject({ advanced: true, version: "1.4.0" });
    const [headRead] = queriesMatching(client, /FROM lineage_migrations/);
    expect(headRead.text).not.toMatch(/snapshots/);
  });
});
