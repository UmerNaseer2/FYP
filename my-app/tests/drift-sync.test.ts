// Drift results in the two-way sync (docs/two-way-sync-plan.md, step 2), the
// website's half: what each side accepts from the other, what the website
// sends a linked desktop, and that a desktop's copy of a website connection is
// checked on the website only.
//
// The metadata database and the gates are stand-ins. Nothing is dialled, and
// the values below are made up.
import { NextRequest, NextResponse } from "next/server";
import type { Principal } from "@/lib/auth-guard";

let mockPrincipal: Principal | null = null;
let mockLinked = true;
jest.mock("../lib/auth-guard", () => ({
  requirePermission: async () => ({ ok: true, principal: require("./helpers/principals").principalFor("editor") }),
  agentPrincipal: async () => mockPrincipal,
}));
jest.mock("../lib/agent-auth", () => ({
  requireAgent: async () =>
    mockLinked
      ? { ok: true, agent: { id: 41, orgId: 7, profileId: 22 } }
      : { ok: false, response: require("next/server").NextResponse.json({ error: "Not linked." }, { status: 401 }) },
}));
const mockPoolQuery = jest.fn<Promise<unknown>, [string, unknown[]?]>();
jest.mock("../lib/version-db", () => ({
  __esModule: true,
  default: { query: (text: string, values?: unknown[]) => mockPoolQuery(text, values) },
  syncMetadataTables: async () => undefined,
}));
const mockSnapshot = jest.fn();
jest.mock("../lib/postgres", () => ({ fetchSchemaSnapshot: (...args: unknown[]) => mockSnapshot(...args) }));
jest.mock("../lib/drift-scheduler", () => ({ requestImmediateCheck: () => undefined }));

import { GET as readDriftRoute } from "@/app/api/agent/sync/drift/route";
import { POST as track } from "@/app/api/lineage/track/route";
import { readDriftSync } from "@/lib/agent-sync";
import {
  DRIFT_HISTORY,
  LONGEST_DRIFT_SUMMARY,
  MOST_DRIFT_SCHEMAS,
  readDriftChecks,
  readDriftSchema,
  readDriftSchemas,
  toIsoTime,
} from "@/lib/agent-rules";
import { listOwnDrift } from "@/lib/drift-sync";
import { listTrackedSchemas } from "@/lib/lineage-db";
import { principalFor, TEST_ORG } from "./helpers/principals";

const AT = "2026-11-08T10:00:00.000Z";
const CHECK = { status: "drifted", summary: "1 table added", checkedAt: AT, source: "scheduled", acknowledged: false };
const ROW = {
  connection_id: 31,
  connection_name: "Shop",
  schema_name: "public",
  label: "Shop tables",
  interval_minutes: 60,
  last_checked_at: new Date(AT),
  checks: [CHECK],
};

let errorLog: jest.SpyInstance;
beforeEach(() => {
  mockPoolQuery.mockReset();
  mockPoolQuery.mockResolvedValue({ rows: [] });
  mockSnapshot.mockReset();
  mockPrincipal = principalFor("viewer");
  mockLinked = true;
  errorLog = jest.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => errorLog.mockRestore());

describe("reading drift results the other side sent", () => {
  it("reads a time from a string or a Date, and nothing else", () => {
    expect(toIsoTime(AT)).toBe(AT);
    expect(toIsoTime(new Date(AT))).toBe(AT);
    expect(toIsoTime("not a time")).toBeNull();
    expect(toIsoTime(1_700_000_000_000)).toBeNull();
    expect(toIsoTime(null)).toBeNull();
  });

  it("keeps the newest checks first, at most the history's length, and leaves out unreadable ones", () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ ...CHECK, checkedAt: `2026-11-0${i + 1}T00:00:00.000Z` }));
    const checks = readDriftChecks([{ ...CHECK, status: "on fire" }, { ...CHECK, checkedAt: "soon" }, "x", null, ...many]);
    expect(checks).toHaveLength(DRIFT_HISTORY);
    expect(checks[0].checkedAt).toBe("2026-11-08T00:00:00.000Z");
    expect(checks.at(-1)?.checkedAt).toBe("2026-11-04T00:00:00.000Z");
    expect(readDriftChecks("all")).toEqual([]);
  });

  it("cuts a long summary, reads an unknown source as unknown, and only true as acknowledged", () => {
    const [check] = readDriftChecks([{ ...CHECK, summary: "x".repeat(1000), source: "moon", acknowledged: "yes" }]);
    expect(check.summary.length).toBeLessThanOrEqual(LONGEST_DRIFT_SUMMARY);
    expect(check.source).not.toBe("moon");
    expect(check.acknowledged).toBe(false);
  });

  it("reads one schema, and turns away one without a name", () => {
    expect(
      readDriftSchema({ schema: " public ", label: "", intervalMinutes: 60, lastCheckedAt: AT, checks: [CHECK], extra: "dropped" })
    ).toEqual({ schema: "public", label: null, intervalMinutes: 60, lastCheckedAt: AT, checks: [CHECK] });
    expect(readDriftSchema({ schema: " " })).toBeNull();
    expect(readDriftSchema({ label: "x" })).toBeNull();
    expect(readDriftSchema("public")).toBeNull();
  });

  it("reads a nonsense interval as by hand only, and caps a huge one", () => {
    expect(readDriftSchema({ schema: "a", intervalMinutes: -5 })?.intervalMinutes).toBe(0);
    expect(readDriftSchema({ schema: "a", intervalMinutes: 1.5 })?.intervalMinutes).toBe(0);
    expect(readDriftSchema({ schema: "a", intervalMinutes: "60" })?.intervalMinutes).toBe(0);
    expect(readDriftSchema({ schema: "a", intervalMinutes: 10 ** 9 })?.intervalMinutes).toBeLessThan(10 ** 6);
  });

  it("keeps a list to the room it is given, skipping bad entries rather than refusing the list", () => {
    const list = [{ schema: "a" }, { schema: "" }, { schema: "b" }, { schema: "c" }];
    expect(readDriftSchemas(list).map((s) => s.schema)).toEqual(["a", "b", "c"]);
    expect(readDriftSchemas(list, 2).map((s) => s.schema)).toEqual(["a", "b"]);
    expect(readDriftSchemas(list, 0)).toEqual([]);
    expect(readDriftSchemas(new Array(MOST_DRIFT_SCHEMAS + 50).fill({ schema: "a" }))).toHaveLength(MOST_DRIFT_SCHEMAS);
    expect(readDriftSchemas({ schema: "a" })).toEqual([]);
  });
});

describe("listOwnDrift", () => {
  it("reads only this server's own connections, with capped history, and tidies each row", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [ROW, { ...ROW, schema_name: "" }] });
    const schemas = await listOwnDrift(TEST_ORG.id);
    const [text, values] = mockPoolQuery.mock.calls[0];
    expect(text).toMatch(/c\.site_id IS NULL/);
    expect(text).toMatch(/d\.org_id = t\.org_id/);
    expect(values).toEqual([TEST_ORG.id, LONGEST_DRIFT_SUMMARY, DRIFT_HISTORY, MOST_DRIFT_SCHEMAS]);
    expect(schemas).toEqual([
      {
        connectionId: 31,
        connectionName: "Shop",
        schema: "public",
        label: "Shop tables",
        intervalMinutes: 60,
        lastCheckedAt: AT,
        checks: [CHECK],
      },
    ]);
  });
});

describe("GET /api/agent/sync/drift", () => {
  const read = async (rev?: string) => {
    const response = await readDriftRoute(
      new NextRequest(`http://localhost:3000/api/agent/sync/drift${rev ? `?rev=${rev}` : ""}`, {
        headers: { authorization: "Bearer ssa_made-up" },
      })
    );
    return { status: response.status, body: await (response as NextResponse).json(), cache: response.headers.get("cache-control") };
  };

  it("answers an unlinked computer with the link's own refusal", async () => {
    mockLinked = false;
    expect((await read()).status).toBe(401);
    expect(mockPoolQuery).not.toHaveBeenCalled();
  });

  it("answers 503 when the computer's person is no longer a member", async () => {
    mockPrincipal = null;
    expect((await read()).status).toBe(503);
  });

  it("sends the organization's results, then says nothing changed for the same fingerprint", async () => {
    mockPoolQuery.mockResolvedValue({ rows: [ROW] });
    const first = await read();
    expect(first.status).toBe(200);
    expect(first.cache).toBe("no-store");
    expect(first.body).toMatchObject({ same: false, allowed: true, orgSlug: TEST_ORG.slug });
    expect(first.body.schemas).toHaveLength(1);
    expect(first.body.schemas[0]).toMatchObject({ connectionName: "Shop", schema: "public", checks: [CHECK] });
    const again = await read(first.body.rev);
    expect(again.body).toEqual({ same: true, rev: first.body.rev });
  });

  it("sends nothing, and reads nothing, for someone who may not see the Drift page", async () => {
    mockPrincipal = principalFor("viewer", { permissions: [] });
    const result = await read();
    expect(result.body).toMatchObject({ same: false, allowed: false, schemas: [] });
    expect(mockPoolQuery).not.toHaveBeenCalled();
  });

  it("gives a new fingerprint when a result changes", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [ROW] });
    const before = await readDriftSync(principalFor("viewer"), null);
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ ...ROW, checks: [{ ...CHECK, acknowledged: true }] }] });
    const after = await readDriftSync(principalFor("viewer"), before.rev);
    expect(after.same).toBe(false);
    expect(after.rev).not.toBe(before.rev);
  });

  it("answers 503 without the error's details when the read fails", async () => {
    mockPoolQuery.mockRejectedValueOnce(new Error("made-up failure at made-up-host"));
    const result = await read();
    expect(result.status).toBe(503);
    expect(JSON.stringify(result.body)).not.toMatch(/made-up-host/);
    expect(JSON.stringify(errorLog.mock.calls)).not.toMatch(/made-up-host/);
  });
});

describe("tracking a schema on a desktop's copy of a website connection", () => {
  it("is refused: the website tracks it, and nothing is dialled", async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [{ name: "Shop", host: "db.example.com", type: "PostgreSQL", site_id: 31 }],
    });
    const response = await track(
      new NextRequest("http://localhost:3000/api/lineage/track", {
        method: "POST",
        body: JSON.stringify({ connectionId: 5, schemaName: "public" }),
        headers: { "Content-Type": "application/json" },
      })
    );
    expect(response.status).toBe(409);
    expect((await response.json()).error).toMatch(/belongs to the website/);
    expect(mockSnapshot).not.toHaveBeenCalled();
    expect(mockPoolQuery).toHaveBeenCalledTimes(1);
  });
});

describe("the Drift page's list on a desktop", () => {
  it("marks a schema whose connection is a copy of the website's, and only that one", async () => {
    const base = { id: 1, connection_id: 5, schema_name: "public", drift_check_interval_minutes: 0 };
    mockPoolQuery.mockResolvedValueOnce({
      rows: [
        { ...base, connection_on_website: true },
        { ...base, id: 2, connection_on_website: false },
      ],
    });
    const [copy, own] = await listTrackedSchemas(TEST_ORG.id);
    expect(mockPoolQuery.mock.calls[0][0]).toMatch(/c\.site_id IS NOT NULL AS connection_on_website/);
    expect(copy.connectionOnWebsite).toBe(true);
    expect("connectionOnWebsite" in own).toBe(false);
  });
});
