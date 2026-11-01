// lineage-acknowledge-route: POST /api/lineage/acknowledge, which marks a drift
// as seen (app/api/lineage/acknowledge/route.ts).
//
// The real route runs over a replaced metadata database and a replaced
// comparison. These tests check who it lets in, that a row can only land in the
// caller's organization, and that the row keeps what was acknowledged: without
// that fingerprint the next scheduled check, finding the same differences,
// writes a new row and the acknowledgement is gone.
import { NextRequest, NextResponse } from "next/server";
import type { Gate } from "@/lib/auth-guard";
import { driftFingerprint } from "@/lib/drift-fingerprint";
import { principalFor, TEST_ORG } from "./helpers/principals";

let mockGate: Gate;
/** The keys each call to requirePermission asked for, in order. */
let mockAskedFor: string[][] = [];
/** The values sent with each query to the metadata database, in order. */
let mockValues: unknown[][] = [];
/** How many rows the insert lands. */
let mockRowCount = 1;
/** What the comparison answers with, or an error to throw. */
let mockComparison: unknown;

jest.mock("../lib/auth-guard", () => ({
  requirePermission: async (...keys: string[]) => {
    mockAskedFor.push(keys);
    return mockGate;
  },
}));

// Relative paths on purpose: next/jest rewrites the @/ alias inside import
// statements only, so jest.mock("@/...") would not resolve.
jest.mock("../lib/version-db", () => ({
  __esModule: true,
  default: {
    query: async (_text: string, values: unknown[]) => {
      mockValues.push(values);
      return { rowCount: mockRowCount, rows: [] };
    },
  },
}));

jest.mock("../lib/lineage-db", () => ({
  computeDriftDetail: async () => {
    if (mockComparison instanceof Error) throw mockComparison;
    return mockComparison;
  },
}));

import { POST } from "../app/api/lineage/acknowledge/route";

// Only the parts the fingerprint reads.
const REPORT = {
  tablesOnlyInA: [{ name: "orders" }],
  tablesOnlyInB: [],
  matchedTables: [],
  objectDiffs: [],
};

function drifted(): unknown {
  return {
    kind: "ok",
    status: "drifted",
    summary: "1 change from the baseline",
    counts: { added: 1 },
    report: REPORT,
    expected: { snapshotId: 44 },
  };
}

function request(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/lineage/acknowledge", {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  mockGate = { ok: true, principal: principalFor("editor") };
  mockAskedFor = [];
  mockValues = [];
  mockRowCount = 1;
  mockComparison = drifted();
  jest.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => jest.restoreAllMocks());

describe("POST /api/lineage/acknowledge", () => {
  it("asks for drift:update and writes nothing when the gate says no", async () => {
    mockGate = { ok: false, response: NextResponse.json({ error: "No." }, { status: 403 }) };
    const answer = await POST(request({ trackedSchemaId: 9 }));
    expect(answer.status).toBe(403);
    expect(mockAskedFor).toEqual([["drift:update"]]);
    expect(mockValues).toEqual([]);
  });

  it("keeps the fingerprint of what was acknowledged, so the next check can tell it is the same drift", async () => {
    const answer = await POST(request({ trackedSchemaId: 9 }));
    expect(answer.status).toBe(200);
    expect(await answer.json()).toEqual(expect.objectContaining({ success: true, trackedSchemaId: 9, status: "drifted" }));
    const values = mockValues.at(-1) ?? [];
    expect(values[6]).toBe(driftFingerprint(REPORT as never));
    expect(values[6]).toEqual(expect.any(String));
  });

  it("writes the row only for a tracked schema in the caller's organization", async () => {
    await POST(request({ trackedSchemaId: 9 }));
    const values = mockValues.at(-1) ?? [];
    expect(values[0]).toBe(9);
    expect(values[5]).toBe(TEST_ORG.id);
  });

  it("answers not found when the schema is no longer tracked in this organization", async () => {
    mockRowCount = 0;
    expect((await POST(request({ trackedSchemaId: 9 }))).status).toBe(404);
  });

  it("has no fingerprint for a database that could not be reached, since nothing was compared", async () => {
    mockComparison = { kind: "unreachable", summary: "Could not reach it.", expected: { snapshotId: 44 } };
    const answer = await POST(request({ trackedSchemaId: 9 }));
    expect(answer.status).toBe(200);
    expect((mockValues.at(-1) ?? [])[6]).toBeNull();
  });

  it("refuses a schema with no baseline, and writes nothing", async () => {
    mockComparison = { kind: "no_baseline" };
    expect((await POST(request({ trackedSchemaId: 9 }))).status).toBe(409);
    expect(mockValues).toEqual([]);
  });

  it("refuses a body it cannot read or one with no schema, and writes nothing", async () => {
    expect((await POST(request("not json"))).status).toBe(400);
    expect((await POST(request({}))).status).toBe(400);
    expect(mockValues).toEqual([]);
  });

  it("repeats nothing the database said when writing the row fails", async () => {
    jest.spyOn(jest.requireMock("../lib/version-db").default, "query").mockRejectedValue(new Error("secret host down"));
    const answer = await POST(request({ trackedSchemaId: 9 }));
    expect(answer.status).toBe(500);
    expect(JSON.stringify(await answer.json())).not.toContain("secret host");
  });
});
