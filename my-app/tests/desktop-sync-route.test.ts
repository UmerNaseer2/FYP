// The desktop's own sync route (docs/two-way-sync-plan.md, step 1, the
// desktop's half): only the desktop app's main process may call it, and what it
// does to this computer's copies of the website's connections.
//
// The metadata database is a stand-in and the token and values are made up.
import { NextRequest } from "next/server";

const mockPoolQuery = jest.fn<Promise<unknown>, [string, unknown[]?]>();
jest.mock("../lib/version-db", () => ({
  __esModule: true,
  default: { query: (text: string, values?: unknown[]) => mockPoolQuery(text, values) },
  syncMetadataTables: async () => undefined,
}));
let mockOrg: { id: number } | null = { id: 7 };
jest.mock("../lib/orgs-db", () => ({
  findDefaultOrganization: async () => mockOrg,
}));
jest.mock("../lib/secret-store", () => ({
  encryptSecret: (value: string | null | undefined) => (value ? `enc:${value}` : (value ?? null)),
  decryptSecret: (value: string | null | undefined) =>
    typeof value === "string" ? value.replace(/^enc:/, "") : (value ?? null),
}));

import { POST } from "@/app/api/desktop/sync/route";
import { SYNC_HEADER, syncTokenMatches } from "@/lib/desktop-sync";

const TOKEN = "made-up-token-made-up-token-made-up-1234";

function call(body: unknown, token: string | null = TOKEN) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token !== null) headers[SYNC_HEADER] = token;
  return POST(
    new NextRequest("http://localhost/api/desktop/sync", { method: "POST", headers, body: JSON.stringify(body) })
  );
}

const COPY = {
  id: 31,
  name: "Shop",
  host: "db.example.com",
  port: 5432,
  database_name: "shop",
  type: "postgres",
  username: "shop_owner",
  password: "made-up-copy-password",
  connection_string: "",
  ssl_mode: "verify-full",
  environment: "prod",
  application_table: null,
  execute_role: "admin",
  version: 4,
  updated_at: "2026-11-08T10:00:00.000Z",
  updated_by: "someone@example.com",
};

const saved = { ...process.env };
beforeEach(() => {
  mockPoolQuery.mockReset();
  mockPoolQuery.mockResolvedValue({ rows: [], rowCount: 1 });
  mockOrg = { id: 7 };
  process.env.SCHEMA_STUDIO_DESKTOP = "1";
  process.env.SCHEMA_STUDIO_SYNC_TOKEN = TOKEN;
});
afterAll(() => {
  process.env = saved;
});

describe("who may call it", () => {
  it("answers 404 without the token, with a wrong one, or off the desktop", async () => {
    expect((await call({ action: "local" }, null)).status).toBe(404);
    expect((await call({ action: "local" }, "made-up-wrong-token")).status).toBe(404);
    expect((await call({ action: "local" }, `${TOKEN}x`)).status).toBe(404);
    delete process.env.SCHEMA_STUDIO_DESKTOP;
    expect((await call({ action: "local" })).status).toBe(404);
    expect(mockPoolQuery).not.toHaveBeenCalled();
  });

  it("refuses everything when the desktop has no token of its own", () => {
    delete process.env.SCHEMA_STUDIO_SYNC_TOKEN;
    expect(syncTokenMatches("")).toBe(false);
    expect(syncTokenMatches(TOKEN)).toBe(false);
    process.env.SCHEMA_STUDIO_SYNC_TOKEN = "short";
    expect(syncTokenMatches("short")).toBe(false);
  });

  it("answers the main process's own token", async () => {
    expect(syncTokenMatches(TOKEN)).toBe(true);
    expect((await call({ action: "local" })).status).toBe(200);
  });

  it("says when the computer has no organization yet", async () => {
    mockOrg = null;
    expect((await call({ action: "local" })).status).toBe(503);
  });

  it("turns away an unknown action and a body that is not an object", async () => {
    expect((await call({ action: "drop-everything" })).status).toBe(400);
    expect((await call([1, 2])).status).toBe(400);
  });
});

describe("apply", () => {
  it("writes each copy over its row, encrypts its secrets, and deletes copies the website no longer has", async () => {
    const response = await call({ action: "apply", connections: [COPY] });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ kept: 1, skipped: 0 });
    const [update, remove] = mockPoolQuery.mock.calls;
    expect(update[0]).toMatch(/UPDATE connections SET/);
    expect(update[0]).toMatch(/WHERE site_id = \$17 AND org_id = \$18/);
    const values = update[1] as unknown[];
    expect(values).toContain("enc:made-up-copy-password");
    expect(values).not.toContain("made-up-copy-password");
    expect(values[7]).toBeNull();
    expect(values.slice(-2)).toEqual([31, 7]);
    // Only copies go; the computer's own connections have no site_id.
    expect(remove[0]).toMatch(/DELETE FROM connections WHERE org_id = \$1 AND site_id IS NOT NULL/);
    expect(remove[1]).toEqual([7, [31]]);
  });

  it("adds a copy it did not have yet", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await call({ action: "apply", connections: [COPY] });
    expect(mockPoolQuery.mock.calls[1][0]).toMatch(/INSERT INTO connections/);
    expect(mockPoolQuery.mock.calls[1][0]).toMatch(/site_id, org_id/);
  });

  it("an empty list deletes every copy", async () => {
    await call({ action: "apply", connections: [] });
    expect(mockPoolQuery).toHaveBeenCalledTimes(1);
    expect(mockPoolQuery.mock.calls[0][1]).toEqual([7, []]);
  });

  it("leaves out a row that is not a connection, and one at an address this server never dials", async () => {
    const response = await call({
      action: "apply",
      connections: [COPY, { ...COPY, id: "32" }, { ...COPY, id: 33, name: "" }, { ...COPY, id: 34, host: "169.254.169.254" }],
    });
    expect(await response.json()).toEqual({ kept: 1, skipped: 3 });
    expect(mockPoolQuery.mock.calls.at(-1)?.[1]).toEqual([7, [31]]);
  });

  it("falls back to the defaults for values it does not know", async () => {
    await call({ action: "apply", connections: [{ ...COPY, ssl_mode: "sometimes", environment: "moon", execute_role: "king" }] });
    const values = mockPoolQuery.mock.calls[0][1] as unknown[];
    expect(values).not.toContain("sometimes");
    expect(values).not.toContain("moon");
    expect(values).not.toContain("king");
  });

  it("keeps the website role first, and clears it with null", async () => {
    const role = { role: "viewer", label: "Viewer", permissions: ["dashboard:read", "not-a-key"] };
    expect((await call({ action: "apply", connections: [], role })).status).toBe(200);
    const [save, remove] = mockPoolQuery.mock.calls;
    expect(save[0]).toMatch(/UPDATE organizations SET site_role = \$2::jsonb WHERE id = \$1/);
    expect(save[1]?.[0]).toBe(7);
    // A key this version does not know is left out.
    expect(JSON.parse(save[1]?.[1] as string)).toEqual({ role: "viewer", label: "Viewer", permissions: ["dashboard:read"] });
    expect(remove[0]).toMatch(/DELETE FROM connections/);

    mockPoolQuery.mockClear();
    await call({ action: "apply", connections: [], role: null });
    expect(mockPoolQuery.mock.calls[0][1]).toEqual([7, null]);
  });

  it("leaves the kept role alone when none is sent", async () => {
    await call({ action: "apply", connections: [] });
    expect(mockPoolQuery.mock.calls.some(([text]) => /site_role/.test(text))).toBe(false);
  });

  it("turns away a role it cannot read, and changes nothing", async () => {
    for (const role of ["viewer", { role: "", label: "x", permissions: [] }, { role: "viewer", label: "Viewer", permissions: "all" }]) {
      expect((await call({ action: "apply", connections: [COPY], role })).status).toBe(400);
    }
    expect(mockPoolQuery).not.toHaveBeenCalled();
  });

  it("turns away a list that is not a list or is far too long", async () => {
    expect((await call({ action: "apply", connections: "all" })).status).toBe(400);
    expect((await call({ action: "apply", connections: new Array(2001).fill(COPY) })).status).toBe(400);
    expect(mockPoolQuery).not.toHaveBeenCalled();
  });
});

describe("the computer's own connections", () => {
  it("lists them by name only, each with its drift results", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ id: "5", name: "Laptop", environment: "dev" }] });
    mockPoolQuery.mockResolvedValueOnce({
      rows: [
        {
          connection_id: 5,
          connection_name: "Laptop",
          environment: "dev",
          schema_name: "public",
          label: null,
          interval_minutes: 60,
          last_checked_at: "2026-11-08T10:00:00.000Z",
          checks: [
            { status: "drifted", summary: "1 table added", checkedAt: "2026-11-08T10:00:00.000Z", source: "scheduled", acknowledged: false },
          ],
        },
      ],
    });
    const response = await call({ action: "local" });
    expect(await response.json()).toEqual({
      connections: [
        {
          id: 5,
          name: "Laptop",
          environment: "dev",
          drift: [
            {
              schema: "public",
              label: null,
              intervalMinutes: 60,
              lastCheckedAt: "2026-11-08T10:00:00.000Z",
              checks: [
                { status: "drifted", summary: "1 table added", checkedAt: "2026-11-08T10:00:00.000Z", source: "scheduled", acknowledged: false },
              ],
            },
          ],
        },
      ],
    });
    expect(mockPoolQuery.mock.calls[0][0]).toMatch(/site_id IS NULL/);
    // Drift is read from this computer's own connections only: copies are the website's to check.
    expect(mockPoolQuery.mock.calls[1][0]).toMatch(/c\.site_id IS NULL/);
    expect(mockPoolQuery.mock.calls[1][1]).toEqual([7, 300, 5, 200]);
  });

  it("still lists them when the drift results cannot be read", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ id: "5", name: "Laptop", environment: "dev" }] });
    mockPoolQuery.mockRejectedValueOnce(new Error("made-up failure"));
    const response = await call({ action: "local" });
    expect(await response.json()).toEqual({ connections: [{ id: 5, name: "Laptop", environment: "dev" }] });
    warn.mockRestore();
  });

  it("exports one in full, secrets opened, and only one of its own", async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [
        {
          name: "Laptop",
          host: "localhost",
          port: 5432,
          database_name: "app",
          type: "postgres",
          username: "me",
          password: "enc:made-up-local-password",
          connection_string: null,
          ssl_mode: "disable",
          environment: "dev",
          application_table: null,
          execute_role: "editor",
        },
      ],
    });
    const response = await call({ action: "export", id: 5 });
    const body = await response.json();
    expect(body.connection.password).toBe("made-up-local-password");
    expect(body.connection.connection_string).toBe("");
    expect(mockPoolQuery.mock.calls[0][0]).toMatch(/site_id IS NULL/);
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    expect((await call({ action: "export", id: 6 })).status).toBe(404);
    expect((await call({ action: "export", id: "5" })).status).toBe(400);
  });

  it("adopts one as a website connection, dropping a copy of it the sync added first", async () => {
    const response = await call({ action: "adopt", id: 5, siteId: 31, siteVersion: 1 });
    expect(await response.json()).toEqual({ adopted: true });
    expect(mockPoolQuery.mock.calls[0][0]).toMatch(/DELETE FROM connections WHERE org_id = \$1 AND site_id = \$2 AND id <> \$3/);
    expect(mockPoolQuery.mock.calls[0][1]).toEqual([7, 31, 5]);
    expect(mockPoolQuery.mock.calls[1][0]).toMatch(/WHERE id = \$1 AND org_id = \$2 AND site_id IS NULL/);
    expect((await call({ action: "adopt", id: 5, siteId: 31 })).status).toBe(400);
  });
});
