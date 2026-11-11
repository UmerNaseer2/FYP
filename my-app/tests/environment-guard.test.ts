// environment-guard: who may take the Production label off, and which saved
// connections count as reaching a production database.
//
// The metadata database is a stand-in that answers the twin lookup with rows a
// test lists; buildPgConfig is the real one, so a saved connection string is
// read the same way the routes read it. Nothing is dialled.
import {
  configIdentity,
  databaseIdentity,
  findProductionTwin,
  lowersProduction,
  twinBlockReason,
  unlabelRefusal,
} from "@/lib/environment-guard";

const mockPoolQuery = jest.fn<Promise<unknown>, unknown[]>(async () => ({ rows: [] }));
jest.mock("../lib/version-db", () => ({
  __esModule: true,
  default: { query: (...args: unknown[]) => mockPoolQuery(...args) },
}));

function row(over: Record<string, unknown> = {}) {
  return {
    id: 8,
    name: "Sales (prod)",
    environment: "prod",
    host: "db.example.test",
    port: 5432,
    database_name: "sales",
    username: "app",
    password: null,
    connection_string: null,
    ssl: false,
    ssl_mode: "disable",
    ...over,
  };
}

describe("lowersProduction", () => {
  it("is true only when the label goes from prod to something else", () => {
    expect(lowersProduction("prod", "dev")).toBe(true);
    expect(lowersProduction("prod", "staging")).toBe(true);
    expect(lowersProduction("prod", "prod")).toBe(false);
    expect(lowersProduction("dev", "prod")).toBe(false);
    expect(lowersProduction("staging", "dev")).toBe(false);
  });
});

describe("the refusals", () => {
  it("name the target and the way to get it done", () => {
    expect(unlabelRefusal('connection "Sales"')).toMatch(/take the Production label off connection "Sales"/);
    expect(unlabelRefusal('connection "Sales"', "delete")).toMatch(/delete connection "Sales", which is labelled Production/);
    expect(twinBlockReason("Sales (prod)")).toMatch(/"Sales \(prod\)", reaches the same database/);
  });
});

describe("configIdentity", () => {
  it("compares the host in lower case and fills in the default port", () => {
    expect(configIdentity({ host: " DB.Example.TEST ", database: "sales" })).toBe("db.example.test:5432/sales");
    expect(configIdentity({ host: "db.example.test", port: "6543", database: "sales" })).toBe(
      "db.example.test:6543/sales"
    );
  });

  it("keeps two projects on Supabase's shared pooler apart", () => {
    // A dev project on the pooler must not be taken for a twin of production.
    const pooler = { host: "aws-0-ap-southeast-2.pooler.supabase.com", port: 6543, database: "postgres" };
    expect(configIdentity({ ...pooler, user: "postgres.devref" })).not.toBe(
      configIdentity({ ...pooler, user: "postgres.prodref" })
    );
    expect(configIdentity({ ...pooler, user: "app.prodref" })).toBe(
      configIdentity({ ...pooler, user: "postgres.prodref" })
    );
  });

  it("is null when the host or the database is missing", () => {
    expect(configIdentity({ host: "", database: "sales" })).toBeNull();
    expect(configIdentity({ host: "db.example.test", database: null })).toBeNull();
    expect(configIdentity({})).toBeNull();
  });
});

describe("databaseIdentity", () => {
  it("reads a saved connection string the way the routes do", () => {
    const fromString = databaseIdentity(
      row({ host: "", database_name: "", connection_string: "postgres://app:pw@DB.example.test:5432/sales" })
    );
    expect(fromString).toBe(databaseIdentity(row()));
  });
});

describe("findProductionTwin", () => {
  const TARGET = "db.example.test:5432/sales";

  beforeEach(() => {
    mockPoolQuery.mockReset();
    mockPoolQuery.mockResolvedValue({ rows: [] });
  });

  it("finds another production connection to the same database", async () => {
    mockPoolQuery.mockResolvedValue({ rows: [row({ host: "DB.EXAMPLE.TEST" })] });
    await expect(findProductionTwin(7, 3, TARGET)).resolves.toEqual({ id: 8, name: "Sales (prod)" });
    const [text, values] = mockPoolQuery.mock.calls[0] as [string, unknown[]];
    expect(text).toMatch(/org_id = \$1 AND id <> \$2 AND environment = 'prod'/);
    expect(values).toEqual([7, 3]);
  });

  it("ignores another database, another port, a row not labelled prod, and the target itself", async () => {
    mockPoolQuery.mockResolvedValue({
      rows: [
        row({ id: 9, database_name: "billing" }),
        row({ id: 10, port: 6543 }),
        row({ id: 11, environment: "dev" }),
        row({ id: 3 }),
      ],
    });
    await expect(findProductionTwin(7, 3, TARGET)).resolves.toBeNull();
  });

  it("skips a row whose saved secret cannot be read, rather than failing the run", async () => {
    mockPoolQuery.mockResolvedValue({ rows: [row({ id: 9, connection_string: "not a url at all" }), row()] });
    await expect(findProductionTwin(7, 3, TARGET)).resolves.toEqual({ id: 8, name: "Sales (prod)" });
  });

  it("asks nothing when the target's own database cannot be told", async () => {
    await expect(findProductionTwin(7, 3, null)).resolves.toBeNull();
    expect(mockPoolQuery).not.toHaveBeenCalled();
  });
});
