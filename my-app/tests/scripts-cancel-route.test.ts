// scripts-cancel-route: POST /api/scripts/cancel, the Stop button on the
// Deploy page (app/api/scripts/cancel/route.ts).
//
// The metadata database and the target database are stand-ins. The list of
// runs going is the real one from lib/deploy/run-limits.ts, so a run "going in this
// server" is one a test registers itself, holding a pool of fake clients of
// its own. These tests check who may stop a run, that another organization's
// run stays out of reach, that a run already saving its changes is left to
// finish, and that a run on another instance of the app is reached through
// the target database by its session name, and only by someone who may run
// scripts there.
import { NextRequest } from "next/server";
import type { Pool } from "pg";
import type { Gate } from "@/lib/auth/guard";
import {
  REAL_RUN_LIMITS,
  beginCommit,
  findRun,
  registerRun,
  runApplicationName,
  unregisterRun,
  type CancelOutcome,
  type RunDetails,
  type RunEntry,
} from "@/lib/deploy/run-limits";
import { UNREADABLE_CREDENTIALS_MESSAGE } from "@/lib/connections/secret-store";
import { createFakeClient, type FakeClient, type FakeStep } from "./helpers/fake-pg";
import { principalFor, TEST_ORG } from "./helpers/principals";

let mockGate: Gate;
let mockAskedFor: string[][] = [];
/** The saved connection the metadata database answers with, if any. */
let mockConnection: Record<string, unknown> | null;
/** The values sent with each query to the metadata database, in order. */
let mockMetaValues: unknown[][] = [];
/** An error the metadata database throws instead of answering. */
let mockMetaError: Error | null;
/** An error reading the saved connection's credentials throws. */
let mockConfigError: Error | null;
/** The pool the route is handed for the target database. */
let mockTargetPool: Pool;

jest.mock("../lib/auth/guard", () => ({
  requirePermission: async (...keys: string[]) => {
    mockAskedFor.push(keys);
    return mockGate;
  },
}));

// Relative paths on purpose: next/jest rewrites the @/ alias inside import
// statements only, so jest.mock("@/...") would not resolve.
jest.mock("../lib/db/version-db", () => ({
  __esModule: true,
  default: {
    query: async (_text: string, values: unknown[]) => {
      mockMetaValues.push(values);
      if (mockMetaError) throw mockMetaError;
      return { rows: mockConnection === null ? [] : [mockConnection] };
    },
  },
  syncMetadataTables: async () => undefined,
}));

jest.mock("../lib/connections/config", () => ({
  buildPgConfig: () => {
    if (mockConfigError) throw mockConfigError;
    return {};
  },
}));

jest.mock("../lib/postgres", () => ({
  getPoolForConfig: () => mockTargetPool,
}));

import { POST } from "../app/api/scripts/cancel/route";

const RUN = "3f2a6c1e-8b4d-4e5f-9a7b-1c2d3e4f5a6b";
const GOOD = { runId: RUN, connectionId: 5 };

const NOT_RUNNING = "That run is not going any more. It may have just finished.";
const TOO_LATE = "Too late to stop: the run is already saving its changes.";
const NOT_ALLOWED =
  "Only the person who started this run, an Admin, or someone who may run scripts on this connection can stop it.";

/** What a cancel's look at pg_stat_activity finds, for each outcome. */
const ACTIVITY: Record<CancelOutcome, Record<string, unknown>[]> = {
  cancelled: [{ pid: 4242, state: "active", committing: false, cancelled: true }],
  idle: [{ pid: 4242, state: "idle in transaction", committing: false, cancelled: false }],
  committing: [{ pid: 4242, state: "active", committing: true, cancelled: false }],
  not_found: [],
};

/** A stand-in pool: each connect() hands out a new fake client. */
function fakePool(steps: FakeStep[]) {
  const clients: FakeClient[] = [];
  const connect = jest.fn(async () => {
    const client = createFakeClient(steps);
    clients.push(client);
    return client;
  });
  return { pool: { connect } as unknown as Pool, connect, clients };
}

const poolFinding = (outcome: CancelOutcome) =>
  fakePool([{ match: /FROM pg_stat_activity/, rows: ACTIVITY[outcome] }]);

/** The pool a run going in this server holds. */
let local: ReturnType<typeof fakePool>;
/** The pool the route opens on the target database itself. */
let target: ReturnType<typeof fakePool>;
let errorSpy: jest.SpyInstance;

function useTarget(pool: ReturnType<typeof fakePool>) {
  target = pool;
  mockTargetPool = pool.pool;
}

function post(body: unknown): Promise<Response> {
  return POST(
    new NextRequest("http://localhost/api/scripts/cancel", {
      method: "POST",
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

/** A deploy going in this server, started by the editor on connection 5. */
function startRun(over: Partial<RunDetails> = {}): RunEntry {
  const entry = registerRun(
    {
      runId: RUN,
      orgId: TEST_ORG.id,
      connectionId: 5,
      actor: "editor@test",
      kind: "deploy",
      pool: local.pool,
      ...over,
    },
    REAL_RUN_LIMITS,
  );
  if (typeof entry === "string") throw new Error(`registerRun answered "${entry}"`);
  return entry;
}

/** Lets the cancel that a stop starts in the background send its queries. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

beforeEach(() => {
  mockGate = { ok: true, principal: principalFor("editor") };
  mockAskedFor = [];
  mockConnection = { name: "Shop", type: "PostgreSQL", execute_role: "editor" };
  mockMetaValues = [];
  mockMetaError = null;
  mockConfigError = null;
  local = poolFinding("cancelled");
  useTarget(poolFinding("cancelled"));
  errorSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  for (const entry of [...(globalThis.__schemaStudioRuns?.values() ?? [])]) unregisterRun(entry);
  globalThis.__schemaStudioRuns = undefined;
  jest.restoreAllMocks();
});

describe("POST /api/scripts/cancel", () => {
  it("asks only to see the Deploy page, and answers the gate's refusal", async () => {
    const refusal = Response.json({ error: "no" }, { status: 403 });
    mockGate = { ok: false, response: refusal } as unknown as Gate;
    const entry = startRun();
    expect((await post(GOOD)).status).toBe(403);
    expect(mockAskedFor).toEqual([["deploy:read"]]);
    expect(mockMetaValues).toEqual([]);
    expect(entry.stopReason).toBeNull();
  });

  it.each<[string, unknown]>([
    ["an unreadable body", "{"],
    ["a body of null", null],
    ["a list", [RUN, 5]],
    ["no run", { connectionId: 5 }],
    ["a run id that is not a UUID", { runId: "run-1", connectionId: 5 }],
    ["a run id that is a number", { runId: 42, connectionId: 5 }],
    ["SQL for a run id", { runId: "x'); SELECT pg_sleep(100000); --", connectionId: 5 }],
    ["no connection", { runId: RUN }],
    ["a text connection", { runId: RUN, connectionId: "5" }],
    ["a connection of zero", { runId: RUN, connectionId: 0 }],
    ["a negative connection", { runId: RUN, connectionId: -1 }],
    ["a fractional connection", { runId: RUN, connectionId: 1.5 }],
  ])("refuses %s before touching any database", async (_label, body) => {
    const answer = await post(body);
    expect(answer.status).toBe(400);
    expect(await answer.json()).toEqual({ ok: false, error: "The request could not be read." });
    expect(mockMetaValues).toEqual([]);
    expect(target.connect).not.toHaveBeenCalled();
  });

  it("only looks inside the caller's organization", async () => {
    mockConnection = null;
    const entry = startRun();
    const answer = await post(GOOD);
    expect(answer.status).toBe(404);
    expect(await answer.json()).toEqual({ ok: false, error: "No saved connection found with id 5." });
    expect(mockMetaValues).toEqual([[5, TEST_ORG.id]]);
    expect(entry.stopReason).toBeNull();
  });

  it("answers 500, and stops nothing, when the app database cannot be read", async () => {
    mockMetaError = new Error("connect ECONNREFUSED 127.0.0.1:5433");
    const entry = startRun();
    const answer = await post(GOOD);
    expect(answer.status).toBe(500);
    expect((await answer.json()).error).toBe("Could not read the saved connection. Is the app database reachable?");
    expect(entry.stopReason).toBeNull();
    expect(errorSpy).toHaveBeenCalledWith("Stop: failed to read connection:", "connect ECONNREFUSED 127.0.0.1:5433");
  });

  it("refuses a connection that is not PostgreSQL", async () => {
    mockConnection = { name: "Shop", type: "MySQL", execute_role: "editor" };
    const entry = startRun();
    expect((await post(GOOD)).status).toBe(400);
    expect(entry.stopReason).toBeNull();
    expect(target.connect).not.toHaveBeenCalled();
  });

  describe("for a run going in this server", () => {
    it("stops the caller's own run, through the run's own connection pool", async () => {
      const entry = startRun();
      entry.pid = 4242;
      const answer = await post(GOOD);
      expect(answer.status).toBe(200);
      expect(await answer.json()).toEqual({ status: "stopping" });
      expect(entry.stopReason).toBe("cancelled");
      await settle();
      expect(local.connect).toHaveBeenCalledTimes(1);
      const select = local.clients[0].queries.find((query) => /FROM pg_stat_activity/.test(query.text));
      expect(select?.values).toEqual([runApplicationName(RUN), 4242]);
      expect(target.connect).not.toHaveBeenCalled();
    });

    it("finds the run whatever the case of its id", async () => {
      const entry = startRun();
      expect((await post({ ...GOOD, runId: RUN.toUpperCase() })).status).toBe(200);
      expect(entry.stopReason).toBe("cancelled");
    });

    it.each<[string, Partial<RunDetails>]>([
      ["another organization's run", { orgId: TEST_ORG.id + 1 }],
      ["a run on another connection", { connectionId: 6 }],
    ])("answers %s as if there were none", async (_label, over) => {
      const entry = startRun(over);
      const answer = await post(GOOD);
      expect(answer.status).toBe(404);
      expect(await answer.json()).toEqual({ ok: false, code: "not_running", error: NOT_RUNNING });
      expect(entry.stopReason).toBeNull();
      expect(local.connect).not.toHaveBeenCalled();
      expect(target.connect).not.toHaveBeenCalled();
    });

    it.each<[string, "viewer" | "editor" | "admin", string, number]>([
      ["a viewer", "viewer", "editor", 403],
      ["an editor, where editors may run scripts", "editor", "editor", 200],
      ["an editor, where only Admins may run scripts", "editor", "admin", 403],
      ["an editor, where nobody may run scripts", "editor", "none", 403],
      ["an Admin, where only Admins may run scripts", "admin", "admin", 200],
      ["an Admin, where nobody may run scripts", "admin", "none", 200],
    ])("lets %s stop someone else's run only if they may run scripts there", async (_label, role, executeRole, status) => {
      mockGate = { ok: true, principal: principalFor(role) };
      mockConnection = { name: "Shop", type: "PostgreSQL", execute_role: executeRole };
      const entry = startRun({ actor: "someone@test" });
      const answer = await post(GOOD);
      expect(answer.status).toBe(status);
      if (status === 403) {
        expect(await answer.json()).toEqual({ ok: false, error: NOT_ALLOWED });
        expect(entry.stopReason).toBeNull();
      } else {
        expect(entry.stopReason).toBe("cancelled");
      }
    });

    it("lets whoever started a run stop it, even after the connection was closed to scripts", async () => {
      mockConnection = { name: "Shop", type: "PostgreSQL", execute_role: "none" };
      const entry = startRun();
      expect((await post(GOOD)).status).toBe(200);
      expect(entry.stopReason).toBe("cancelled");
    });

    it("leaves a run that is already saving its changes to finish", async () => {
      const entry = startRun();
      beginCommit(entry);
      const answer = await post(GOOD);
      expect(answer.status).toBe(409);
      expect(await answer.json()).toEqual({ ok: false, code: "too_late", error: TOO_LATE });
      expect(entry.stopReason).toBeNull();
      expect(local.connect).not.toHaveBeenCalled();
    });

    it("answers not_running for a run that has just ended", async () => {
      const entry = startRun();
      entry.done = true;
      const answer = await post(GOOD);
      expect(answer.status).toBe(404);
      expect((await answer.json()).code).toBe("not_running");
      expect(entry.stopReason).toBeNull();
    });

    it("is the same pressed twice as once", async () => {
      const entry = startRun();
      expect((await post(GOOD)).status).toBe(200);
      expect((await post(GOOD)).status).toBe(200);
      await settle();
      expect(entry.stopReason).toBe("cancelled");
      expect(local.connect).toHaveBeenCalledTimes(1);
    });
  });

  describe("for a run going on another instance of the app, or none", () => {
    it("cancels it by its session name on the target database", async () => {
      const answer = await post(GOOD);
      expect(answer.status).toBe(200);
      expect(await answer.json()).toEqual({ status: "stopping" });
      expect(target.connect).toHaveBeenCalledTimes(1);
      const [client] = target.clients;
      const select = client.queries.find((query) => /FROM pg_stat_activity/.test(query.text));
      expect(select?.values).toEqual([runApplicationName(RUN), null]);
      expect(client.releaseCount).toBe(1);
      expect(client.releasedWith).toBeUndefined();
    });

    it("looks for a run that has just ended here in the database, and finds none", async () => {
      useTarget(poolFinding("not_found"));
      unregisterRun(startRun());
      expect(findRun(RUN)).toBeNull();
      const answer = await post(GOOD);
      expect(answer.status).toBe(404);
      expect(await answer.json()).toEqual({ ok: false, code: "not_running", error: NOT_RUNNING });
      expect(local.connect).not.toHaveBeenCalled();
    });

    it.each<[string, "viewer" | "editor" | "admin", string]>([
      ["a viewer", "viewer", "editor"],
      ["an editor, where only Admins may run scripts", "editor", "admin"],
      ["an editor, where nobody may run scripts", "editor", "none"],
    ])("refuses %s without touching the database, since who started it is not known here", async (_label, role, executeRole) => {
      mockGate = { ok: true, principal: principalFor(role) };
      mockConnection = { name: "Shop", type: "PostgreSQL", execute_role: executeRole };
      const answer = await post(GOOD);
      expect(answer.status).toBe(403);
      expect(await answer.json()).toEqual({ ok: false, error: NOT_ALLOWED });
      expect(target.connect).not.toHaveBeenCalled();
    });

    it("lets an Admin stop it where only Admins may run scripts", async () => {
      mockGate = { ok: true, principal: principalFor("admin") };
      mockConnection = { name: "Shop", type: "PostgreSQL", execute_role: "admin" };
      expect((await post(GOOD)).status).toBe(200);
      expect(target.connect).toHaveBeenCalledTimes(1);
    });

    it("leaves it to finish when it is already saving its changes", async () => {
      useTarget(poolFinding("committing"));
      const answer = await post(GOOD);
      expect(answer.status).toBe(409);
      expect(await answer.json()).toEqual({ ok: false, code: "too_late", error: TOO_LATE });
    });

    it("answers not_running when no such run is going anywhere", async () => {
      useTarget(poolFinding("not_found"));
      const answer = await post(GOOD);
      expect(answer.status).toBe(404);
      expect((await answer.json()).code).toBe("not_running");
    });

    it("says so when the run stayed between two statements for every try", async () => {
      useTarget(poolFinding("idle"));
      const answer = await post(GOOD);
      expect(answer.status).toBe(409);
      expect(await answer.json()).toEqual({
        ok: false,
        code: "between_steps",
        error:
          "The run is between two steps and could not be stopped just now. Try again, or let its time limit end it.",
      });
      expect(target.connect).toHaveBeenCalledTimes(8);
    });

    it("says when the database would not let this login cancel it", async () => {
      useTarget(
        fakePool([
          { match: /FROM pg_stat_activity/, error: { code: "42501", message: "permission denied to cancel query" } },
        ]),
      );
      const answer = await post(GOOD);
      expect(answer.status).toBe(409);
      expect(await answer.json()).toEqual({
        ok: false,
        code: "database_refused",
        error: "This connection's login may not cancel that query.",
      });
      expect(target.clients[0].releasedWith).toBe(true);
    });

    it("answers 502 with no detail when the database cannot be reached", async () => {
      const connect = jest.fn(async () => {
        throw new Error("connect ECONNREFUSED db.internal.example:5432");
      });
      mockTargetPool = { connect } as unknown as Pool;
      const answer = await post(GOOD);
      expect(answer.status).toBe(502);
      const body = await answer.json();
      expect(body).toEqual({ ok: false, error: "Could not reach that database." });
      expect(JSON.stringify(body)).not.toContain("db.internal");
      expect(errorSpy).toHaveBeenCalledWith(
        "Stop: the database did not answer:",
        "connect ECONNREFUSED db.internal.example:5432",
      );
    });

    it("answers 500 when the saved connection's password cannot be read on this server", async () => {
      mockConfigError = new Error("Unsupported state or unable to authenticate data");
      const answer = await post(GOOD);
      expect(answer.status).toBe(500);
      expect(await answer.json()).toEqual({ ok: false, error: UNREADABLE_CREDENTIALS_MESSAGE });
      expect(target.connect).not.toHaveBeenCalled();
    });
  });
});
