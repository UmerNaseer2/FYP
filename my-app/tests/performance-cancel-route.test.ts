// performance-cancel-route: POST /api/performance/cancel, which stops one stuck
// query (app/api/performance/cancel/route.ts).
//
// The real route runs over a replaced metadata database and a replaced target
// database. These tests check who it lets in, what it refuses to read, what the
// connection's own rule says, and that it names the statement as well as the
// session, so a cancel can never land on a later statement.
import { NextRequest } from "next/server";
import type { Gate } from "@/lib/auth-guard";
import { CANCEL_SQL } from "@/lib/db-activity";
import { principalFor, TEST_ORG } from "./helpers/principals";

let mockGate: Gate;
let mockAskedFor: string[][] = [];
/** The saved connection the metadata database answers with, if any. */
let mockConnection: Record<string, unknown> | null;
/** The values sent with each query to the metadata database, in order. */
let mockMetaValues: unknown[][] = [];
/** What the cancel statement answers with, or an error to throw. */
let mockCancel: unknown;
/** Every statement the target database was sent, with its values. */
let mockStatements: { text: string; values?: unknown[] }[] = [];
let mockReleased = 0;

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
      mockMetaValues.push(values);
      return { rows: mockConnection === null ? [] : [mockConnection] };
    },
  },
  syncMetadataTables: async () => undefined,
}));

jest.mock("../lib/connection-config", () => ({ buildPgConfig: () => ({}) }));

jest.mock("../lib/postgres", () => ({
  getPoolForConfig: () => ({
    connect: async () => ({
      query: async (text: string, values?: unknown[]) => {
        mockStatements.push({ text, values });
        if (values === undefined) return { rows: [] };
        if (mockCancel instanceof Error) throw mockCancel;
        return mockCancel;
      },
      release: () => {
        mockReleased += 1;
      },
    }),
  }),
}));

import { POST } from "../app/api/performance/cancel/route";

const QUERY_START = "2026-11-01T09:30:15.123456Z";

function post(body: unknown): Promise<Response> {
  return POST(
    new NextRequest("http://localhost/api/performance/cancel", {
      method: "POST",
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

const GOOD = { connectionId: 5, pid: 4242, queryStart: QUERY_START };

beforeEach(() => {
  mockGate = { ok: true, principal: principalFor("editor") };
  mockAskedFor = [];
  mockConnection = { name: "Shop", type: "PostgreSQL", execute_role: "editor" };
  mockMetaValues = [];
  mockCancel = { rows: [{ cancelled: true }] };
  mockStatements = [];
  mockReleased = 0;
  jest.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => jest.restoreAllMocks());

describe("POST /api/performance/cancel", () => {
  it("asks for its own permission, and answers the gate's refusal", async () => {
    const refusal = Response.json({ error: "no" }, { status: 403 });
    mockGate = { ok: false, response: refusal } as unknown as Gate;
    const answer = await post(GOOD);
    expect(answer.status).toBe(403);
    expect(mockAskedFor).toEqual([["performance:update"]]);
    expect(mockStatements).toEqual([]);
  });

  it("cancels the statement named by its session and its start, and keeps the session", async () => {
    const answer = await post(GOOD);
    expect(answer.status).toBe(200);
    expect(await answer.json()).toEqual({ status: "cancelled" });
    const cancel = mockStatements.find((statement) => statement.text === CANCEL_SQL);
    expect(cancel?.values).toEqual([4242, QUERY_START]);
    expect(CANCEL_SQL).toContain("pg_cancel_backend");
    expect(CANCEL_SQL).not.toContain("pg_terminate_backend");
    expect(mockReleased).toBe(1);
  });

  it("answers gone when that statement is no longer running", async () => {
    mockCancel = { rows: [] };
    expect(await (await post(GOOD)).json()).toEqual({ status: "gone" });
    mockCancel = { rows: [{ cancelled: false }] };
    expect(await (await post(GOOD)).json()).toEqual({ status: "gone" });
  });

  it("only looks inside the caller's organization", async () => {
    mockConnection = null;
    const answer = await post(GOOD);
    expect(answer.status).toBe(404);
    expect(mockMetaValues).toEqual([[5, TEST_ORG.id]]);
    expect(mockStatements).toEqual([]);
  });

  it.each([
    ["unreadable", "{"],
    ["no connection", { pid: 1, queryStart: QUERY_START }],
    ["a text connection", { connectionId: "5", pid: 1, queryStart: QUERY_START }],
    ["no session", { connectionId: 5, queryStart: QUERY_START }],
    ["a session of zero", { connectionId: 5, pid: 0, queryStart: QUERY_START }],
    ["a negative session", { connectionId: 5, pid: -1, queryStart: QUERY_START }],
    ["a fractional session", { connectionId: 5, pid: 1.5, queryStart: QUERY_START }],
    ["a session too big for the column", { connectionId: 5, pid: 2_147_483_648, queryStart: QUERY_START }],
    ["no start", { connectionId: 5, pid: 1 }],
    ["a null start", { connectionId: 5, pid: 1, queryStart: null }],
    ["a start without a zone", { connectionId: 5, pid: 1, queryStart: "2026-11-01T09:30:15.123456" }],
    ["a start that is not a time", { connectionId: 5, pid: 1, queryStart: "2026-13-41T99:99:99Z" }],
    ["SQL for a start", { connectionId: 5, pid: 1, queryStart: "now()" }],
  ])("refuses %s before touching any database", async (_name, body) => {
    expect((await post(body)).status).toBe(400);
    expect(mockMetaValues).toEqual([]);
    expect(mockStatements).toEqual([]);
  });

  it("obeys the connection's own rule, with a status of its own", async () => {
    mockConnection = { name: "Shop", type: "PostgreSQL", execute_role: "none" };
    expect((await post(GOOD)).status).toBe(423);
    expect(mockStatements).toEqual([]);

    mockConnection = { name: "Shop", type: "PostgreSQL", execute_role: "admin" };
    expect((await post(GOOD)).status).toBe(423);
    expect(mockStatements).toEqual([]);

    mockGate = { ok: true, principal: principalFor("admin") };
    expect((await post(GOOD)).status).toBe(200);
  });

  it("does not need Deploy: Run, only the permission it asked for", async () => {
    const onlyCancel = { ...principalFor("viewer"), permissions: ["performance:update"] };
    mockGate = { ok: true, principal: onlyCancel } as unknown as Gate;
    expect((await post(GOOD)).status).toBe(200);
  });

  it("refuses a connection that is not PostgreSQL", async () => {
    mockConnection = { name: "Shop", type: "MySQL", execute_role: "editor" };
    expect((await post(GOOD)).status).toBe(400);
    expect(mockStatements).toEqual([]);
  });

  it("says when the database would not let this login cancel it", async () => {
    mockCancel = Object.assign(new Error("must be a member of the role"), { code: "42501" });
    const answer = await post(GOOD);
    expect(answer.status).toBe(409);
    expect((await answer.json()).code).toBe("database_refused");
    expect(mockStatements.some((statement) => statement.text === "ROLLBACK")).toBe(true);
    expect(mockReleased).toBe(1);
  });

  it("answers 502 with no detail when the database fails", async () => {
    mockCancel = new Error("connect failed at db.internal.example:5432");
    const answer = await post(GOOD);
    expect(answer.status).toBe(502);
    expect(JSON.stringify(await answer.json())).not.toContain("db.internal");
    expect(mockReleased).toBe(1);
  });
});
