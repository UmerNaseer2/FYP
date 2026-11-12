/**
 * Answering a phone's requests through the app's own server
 * (src/main/phone-requests.ts). A fake plays the server, so these tests check
 * which routes are asked, that only shared connections are asked about, that
 * an answer carries nothing the phone was not meant to see, and that every
 * refusal is one of the fixed sentences. The approval requests are passed on
 * to src/main/phone-approvals.ts, which src/test/phone-approvals.test.ts
 * tests on its own, so a fake stands in for it here.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

import type { PhoneAction } from "../core/phone-link-file";
import type { PushSubscriptionFields } from "../core/web-push";
import { initLog, logFilePaths } from "../main/log";
import {
  REFUSALS,
  Refused,
  answerRequest,
  ask,
  driftAlertsAllowed,
  writeRefusal,
  type AppAnswer,
  type AppCaller,
  type PhoneAlerts,
  type PhoneApprovalRequests,
  type PhoneControlRequests,
  type Refusal,
  type PhoneControl,
} from "../main/phone-requests";
import { MAX_LIVE_QUERY_LENGTH, MAX_LIVE_SESSIONS, readAnswer, type Answer, type CompareSummary, type LiveStatus, type Request } from "../shared/remote/rpc.js";
import { newPhone, subscriptionOf } from "./push-phone";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ss-phone-requests-"));
initLog(path.join(root, "logs"), { echo: false });
after(() => fs.rmSync(root, { recursive: true, force: true }));

/** How much of the log the tests have read so far. */
let logRead = 0;

/** What has been logged since the last call. */
function newLogLines(): string {
  const file = logFilePaths()?.main;
  assert.ok(file, "the log has a folder");
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    // Nothing logged yet.
  }
  const fresh = text.slice(logRead);
  logRead = text.length;
  return fresh;
}

/** A database host that the server's error messages name. It must never reach a phone. */
const HOST = "dev-db.example.test";

type Call = { method: string; path: string; body: unknown };

/**
 * Plays the app's server: answers each "METHOD path" listed, copying what it
 * gives the way a trip through JSON would. It throws for an Error, and for a
 * path it does not list, as a server that could not be reached would.
 */
function fakeApp(routes: Record<string, AppAnswer | Error>): { call: AppCaller; calls: Call[] } {
  const calls: Call[] = [];
  const call: AppCaller = async (method, target, body) => {
    calls.push({ method, path: target, body: structuredClone(body) });
    const answer = routes[`${method} ${target}`];
    if (answer === undefined) throw new Error(`The test app has no ${method} ${target}.`);
    if (answer instanceof Error) throw answer;
    return { status: answer.status, json: structuredClone(answer.json) };
  };
  return { call, calls };
}

function ok(json: unknown): AppAnswer {
  return { status: 200, json };
}

/** The computer's public push key. Any P-256 public key will do, so a test phone's keys make one. */
const PUSH_KEY = newPhone().p256dh.toString("base64url");

/** Where a phone's browser takes its drift alerts: an address at one of the push services the computer sends to. */
const ENDPOINT = "https://fcm.googleapis.com/fcm/send/a1b2c3";

/** A phone's drift alerts as the phone link keeps them, with each subscription it was told to save, or null for off. */
function fakeAlerts(subscription: PushSubscriptionFields | null = null): PhoneAlerts & { saved: (PushSubscriptionFields | null)[] } {
  let current = subscription;
  const saved: (PushSubscriptionFields | null)[] = [];
  return {
    key: PUSH_KEY,
    on: () => current !== null,
    set: (next) => {
      current = next;
      saved.push(next);
    },
    saved,
  };
}

/** A phone's Allow control switch, noting what goes in the action log. */
function fakeControl(allowed = false): PhoneControl & { entries: Omit<PhoneAction, "at" | "phone">[] } {
  const entries: Omit<PhoneAction, "at" | "phone">[] = [];
  return {
    allowed: () => allowed,
    record: (entry) => {
      entries.push(entry);
    },
    entries,
  };
}

/** A phone's deploys and cancels, answering each with a fixed result and noting what it was asked with. */
function fakeControlRequests(overrides: Partial<PhoneControlRequests> = {}): PhoneControlRequests & { asked: unknown[][] } {
  const asked: unknown[][] = [];
  return {
    deployList: async (connectionId, signal) => {
      asked.push(["deployList", connectionId, signal]);
      return { registry: "ok", partial: false, families: [], passkey: "none" };
    },
    deployFamily: async (params, signal) => {
      asked.push(["deployFamily", params, signal]);
      return { currentVersion: null, waiting: [], undo: [], partial: false, run: null };
    },
    deployPlan: async (params, signal) => {
      asked.push(["deployPlan", params, signal]);
      throw new Refused("not-found");
    },
    begin: () => {
      asked.push(["begin"]);
      return { nonce: "bm9uY2U", credentialId: "Y3JlZA" };
    },
    deployStart: async (params, signal) => {
      asked.push(["deployStart", params, signal]);
      return { status: "running" };
    },
    cancelSession: async (params, signal) => {
      asked.push(["cancelSession", params, signal]);
      return { status: "cancelled" };
    },
    passkey: async (signal) => {
      asked.push(["passkey", signal]);
      return "none";
    },
    ...overrides,
    asked,
  };
}

/** A live status's switch while Allow control is off. */
const NO_CONTROL = { allowed: false, canCheck: false, canAcknowledge: false, canDeploy: false, canCancel: false, passkey: "none" };

/** A fingerprint of a request's SQL, as the app's server writes one. */
const FINGERPRINT = "ab".repeat(32);

/** A phone's approval requests, answering each with a fixed result and noting what it was asked with. */
function fakeApprovals(overrides: Partial<PhoneApprovalRequests> = {}): PhoneApprovalRequests & { asked: unknown[][] } {
  const asked: unknown[][] = [];
  return {
    list: async (signal) => {
      asked.push(["list", signal]);
      return { approvals: [], passkey: "none", canApprove: false };
    },
    read: async (approvalId, signal) => {
      asked.push(["read", approvalId, signal]);
      return { id: approvalId, action: "deploy", fingerprint: FINGERPRINT, scripts: [{ name: "orders", version: "1.1.0", sql: "SELECT 1;" }] };
    },
    beginPasskey: () => {
      asked.push(["beginPasskey"]);
      return { challenge: "Y2hhbGxlbmdl", userId: "dXNlcg" };
    },
    finishPasskey: async (params, signal) => {
      asked.push(["finishPasskey", params, signal]);
      return { passkey: "ready" };
    },
    beginDecision: () => {
      asked.push(["beginDecision"]);
      return { nonce: "bm9uY2U", credentialId: "Y3JlZA" };
    },
    decide: async (params, signal) => {
      asked.push(["decide", params, signal]);
      return { status: "rejected" };
    },
    ...overrides,
    asked,
  };
}

/**
 * Answers `request` as the computer would, with these connections shared and
 * these drift alerts and approvals for the phone, and reads the answer as a
 * phone would.
 */
async function answer(
  request: Request,
  call: AppCaller,
  options: { shared?: readonly number[]; queryText?: readonly number[]; alerts?: PhoneAlerts; approvals?: PhoneApprovalRequests; controlRequests?: PhoneControlRequests; control?: PhoneControl; signal?: AbortSignal } = {},
): Promise<Answer> {
  const shared = options.shared ?? [1, 2, 3];
  const requestOptions = { call, control: options.control ?? fakeControl(), controlRequests: options.controlRequests ?? fakeControlRequests(), sharedConnectionIds: () => shared, queryTextConnectionIds: () => options.queryText ?? [], appVersion: "1.2.3", alerts: options.alerts ?? fakeAlerts(), approvals: options.approvals ?? fakeApprovals() };
  const sent = await answerRequest(request, requestOptions, options.signal ?? new AbortController().signal);
  const read = readAnswer(sent);
  assert.ok(read, "a phone can read the answer");
  assert.equal(read.id, request.id);
  return read;
}

/** The answer that refuses request `id` for this reason, as a phone reads it. */
function refused(id: number, refusal: Refusal): Answer {
  return { id, ok: false, error: { code: REFUSALS[refusal].code, message: REFUSALS[refusal].message } };
}

/** What GET /api/me answers with for a role holding these permissions. */
function me(permissions: string[], fields: Record<string, unknown> = {}): Record<string, unknown> {
  return { role: "viewer", roleLabel: "Viewer", permissions, bypass: false, viewingAs: null, org: { slug: "personal", name: "Personal" }, ...fields };
}

/** A capture as GET /api/schema/snapshot answers with one (SchemaSnapshot in my-app/lib/postgres.ts), with more than a phone is shown. */
const SNAPSHOT = {
  formatVersion: 3,
  database: "shop",
  schema: "my schema&x",
  tables: [
    {
      name: "orders",
      columns: [
        { name: "id", ordinalPosition: 1, typeDisplay: "integer", nullable: false, columnDefault: "nextval('orders_id_seq'::regclass)", generated: null },
        { name: "customer_id", ordinalPosition: 2, typeDisplay: "integer", nullable: true, columnDefault: null },
      ],
      primaryKey: { name: "orders_pkey", kind: "PRIMARY KEY", columns: ["id"], definition: "PRIMARY KEY (id)", normalizedDefinition: "PRIMARY KEY (id)" },
      uniqueConstraints: [],
      foreignKeys: [
        {
          name: "orders_customer_fk",
          kind: "FOREIGN KEY",
          columns: ["customer_id"],
          definition: "FOREIGN KEY (customer_id) REFERENCES crm.customers(id)",
          normalizedDefinition: "FOREIGN KEY (customer_id) REFERENCES crm.customers(id)",
          referencedSchema: "crm",
          referencedTable: "customers",
          referencedColumns: ["id"],
          onUpdate: "NO ACTION",
          onDelete: "CASCADE",
        },
        {
          name: "orders_unknown_fk",
          kind: "FOREIGN KEY",
          columns: ["customer_id"],
          definition: "",
          normalizedDefinition: "",
          referencedSchema: null,
          referencedTable: null,
          referencedColumns: [],
          onUpdate: "NO ACTION",
          onDelete: "NO ACTION",
        },
      ],
      checkConstraints: [],
      excludeConstraints: [],
      indexes: [{ name: "orders_pkey", definition: "CREATE UNIQUE INDEX orders_pkey ON orders USING btree (id)" }],
      triggers: [],
    },
    {
      name: "audit_log",
      columns: [{ name: "at", ordinalPosition: 1, typeDisplay: "timestamp with time zone", nullable: false, columnDefault: "now()" }],
      primaryKey: null,
      uniqueConstraints: [],
      foreignKeys: [],
      checkConstraints: [],
      excludeConstraints: [],
    },
  ],
  views: [
    { name: "recent_orders", materialized: false, definition: "SELECT * FROM orders", normalizedDefinition: "SELECT * FROM orders", columns: [] },
    { name: "daily_totals", materialized: true, definition: "SELECT 1", normalizedDefinition: "SELECT 1", columns: [] },
  ],
};

/** What a phone is shown of SNAPSHOT. */
const OVERVIEW = {
  database: "shop",
  schema: "my schema&x",
  tables: [
    {
      name: "orders",
      columns: [
        { name: "id", type: "integer", nullable: false, default: "nextval('orders_id_seq'::regclass)" },
        { name: "customer_id", type: "integer", nullable: true, default: null },
      ],
      primaryKey: ["id"],
      foreignKeys: [
        { columns: ["customer_id"], referencedSchema: "crm", referencedTable: "customers", referencedColumns: ["id"] },
        { columns: ["customer_id"], referencedSchema: null, referencedTable: null, referencedColumns: [] },
      ],
    },
    {
      name: "audit_log",
      columns: [{ name: "at", type: "timestamp with time zone", nullable: false, default: "now()" }],
      primaryKey: [],
      foreignKeys: [],
    },
  ],
  views: [
    { name: "recent_orders", materialized: false },
    { name: "daily_totals", materialized: true },
  ],
};

const SNAPSHOT_PATH = "GET /api/schema/snapshot?connectionId=3&schema=my%20schema%26x";
const READ_SCHEMA: Request = { id: 8, method: "schema.read", params: { connectionId: 3, schema: "my schema&x" } };

/** A comparison as POST /api/compare/phone answers with one. */
const SUMMARY: CompareSummary = {
  source: { connectionId: 1, name: "Dev", schema: "public", error: null },
  targets: [
    {
      connectionId: 2,
      name: "Prod",
      schema: "public",
      status: "compared",
      error: null,
      changes: 2,
      breaking: 1,
      manual: 0,
      lines: [
        { category: "Column", table: "orders", object: "total", change: "dropped", severity: "breaking", detail: "numeric(10,2)", manual: false },
        { category: "Table", table: "", object: "audit_log", change: "added", severity: "safe", detail: "", manual: false },
      ],
      moreLines: 0,
      history: null,
    },
  ],
};

test("says who is signed in on the computer, and what their role lets a phone do", async () => {
  const app = fakeApp({ "GET /api/me": ok(me(["dashboard:read", "compare:read", "visualizer:read"])) });
  assert.deepEqual(await answer({ id: 1, method: "hello" }, app.call), {
    id: 1,
    ok: true,
    result: { signedIn: true, role: "Viewer", canCompare: true, canReadSchemas: true, canSeeLive: true, appVersion: "1.2.3" },
  });
  assert.deepEqual(app.calls, [{ method: "GET", path: "/api/me", body: undefined }]);

  // Reading a schema takes the Visualizer, and one of the boxes that lists a connection's schemas.
  const cases: [string[], boolean, boolean, boolean][] = [
    [[], false, false, false],
    [["visualizer:read"], false, false, false],
    [["visualizer:read", "performance:read"], false, true, true],
    [["compare:read"], true, false, false],
    [["dashboard:read", "visualizer:read"], false, true, true],
    [["drift:read"], false, false, true],
  ];
  for (const [permissions, canCompare, canReadSchemas, canSeeLive] of cases) {
    const read = await answer({ id: 2, method: "hello" }, fakeApp({ "GET /api/me": ok(me(permissions)) }).call);
    assert.deepEqual(
      read,
      { id: 2, ok: true, result: { signedIn: true, role: "Viewer", canCompare, canReadSchemas, canSeeLive, appVersion: "1.2.3" } },
      permissions.join(" ") || "no permissions",
    );
  }
});

test("names the role by its key when it has no name to show, and by nothing when it has neither", async () => {
  const byKey = await answer({ id: 1, method: "hello" }, fakeApp({ "GET /api/me": ok({ role: "auditor", permissions: [] }) }).call);
  assert.equal(byKey.ok && (byKey.result as { role: unknown }).role, "auditor");
  const unnamed = await answer({ id: 2, method: "hello" }, fakeApp({ "GET /api/me": ok({ permissions: [] }) }).call);
  assert.equal(unnamed.ok && (unnamed.result as { role: unknown }).role, null);
});

test("answers hello with nobody signed in, rather than refusing it, and logs nothing", async () => {
  newLogLines();
  const app = fakeApp({ "GET /api/me": { status: 401, json: { error: "Sign in to continue." } } });
  assert.deepEqual(await answer({ id: 3, method: "hello" }, app.call), {
    id: 3,
    ok: true,
    result: { signedIn: false, role: null, canCompare: false, canReadSchemas: false, canSeeLive: false, appVersion: "1.2.3" },
  });
  assert.equal(newLogLines(), "");
});

test("refuses hello when the server could not read what the role may do", async () => {
  newLogLines();
  const unknown = fakeApp({ "GET /api/me": { status: 503, json: { error: "Could not check what your role can do, because the app's database did not answer." } } });
  assert.deepEqual(await answer({ id: 4, method: "hello" }, unknown.call), refused(4, "access-unknown"));
  assert.equal(REFUSALS["access-unknown"].code, "failed");
  assert.match(newLogLines(), /answered the phone link's GET \/api\/me with 503: Could not check what your role can do/);
});

test("refuses hello with what to do about it when the person signed in is no longer a member, and logs nothing", async () => {
  newLogLines();
  const removed = fakeApp({ "GET /api/me": { status: 404, json: { error: "This organization does not exist, or you are not a member." } } });
  assert.deepEqual(await answer({ id: 4, method: "hello" }, removed.call), refused(4, "not-member"));
  assert.equal(REFUSALS["not-member"].code, "signed-out");
  assert.equal(newLogLines(), "");
});

test("lists the shared connections only, in the app's order, with only what a phone shows", async () => {
  const app = fakeApp({
    "GET /api/connections/phone": ok({
      connections: [
        { id: 5, name: "Billing", database: "billing", host: HOST },
        { id: 2, name: "Orders", database: "orders", host: HOST },
        { id: 9, name: "Search", database: "search", host: HOST, port: 5432 },
      ],
    }),
  });
  // 77 is shared but has been deleted on the computer since.
  const read = await answer({ id: 5, method: "connections.list" }, app.call, { shared: [9, 5, 77] });
  assert.deepEqual(read, {
    id: 5,
    ok: true,
    result: {
      connections: [
        { id: 5, name: "Billing", database: "billing" },
        { id: 9, name: "Search", database: "search" },
      ],
    },
  });
  assert.ok(!JSON.stringify(read).includes(HOST));
  assert.deepEqual(app.calls, [{ method: "GET", path: "/api/connections/phone", body: undefined }]);
});

test("fails the list when the app describes a shared connection wrongly, and ignores the ones not shared", async () => {
  newLogLines();
  const wrong = fakeApp({ "GET /api/connections/phone": ok({ connections: [{ id: 1, name: "A", database: 7 }] }) });
  assert.deepEqual(await answer({ id: 6, method: "connections.list" }, wrong.call), refused(6, "failed"));
  assert.match(newLogLines(), /answered with a connection the phone link cannot read/);

  const notList = fakeApp({ "GET /api/connections/phone": ok({ connections: null }) });
  assert.deepEqual(await answer({ id: 7, method: "connections.list" }, notList.call), refused(7, "failed"));
  assert.match(newLogLines(), /did not answer with a list of connections/);

  const unshared = fakeApp({
    "GET /api/connections/phone": ok({
      connections: [{ id: 1, name: "A", database: "a" }, { id: 4, database: 7 }, "not a connection", null],
    }),
  });
  assert.deepEqual(await answer({ id: 8, method: "connections.list" }, unshared.call, { shared: [1] }), {
    id: 8,
    ok: true,
    result: { connections: [{ id: 1, name: "A", database: "a" }] },
  });
});

test("lists a shared connection's schemas, leaving out any name a request could not hold", async () => {
  const app = fakeApp({
    "GET /api/lineage/schemas?connectionId=2": ok({ schemas: ["public", " padded", "", "a".repeat(129), 5, "sales", "b".repeat(128)] }),
  });
  newLogLines();
  assert.deepEqual(await answer({ id: 9, method: "schemas.list", params: { connectionId: 4 } }, app.call), refused(9, "not-shared"));
  assert.deepEqual(app.calls, [], "a connection that is not shared is never asked about");
  assert.equal(newLogLines(), "");

  assert.deepEqual(await answer({ id: 10, method: "schemas.list", params: { connectionId: 2 } }, app.call), {
    id: 10,
    ok: true,
    result: { schemas: ["public", "sales", "b".repeat(128)] },
  });
  assert.deepEqual(app.calls, [{ method: "GET", path: "/api/lineage/schemas?connectionId=2", body: undefined }]);
});

test("reads a shared schema's tables and views, and nothing more of the capture", async () => {
  const app = fakeApp({ [SNAPSHOT_PATH]: ok({ snapshot: SNAPSHOT }) });
  assert.deepEqual(await answer(READ_SCHEMA, app.call), { id: 8, ok: true, result: OVERVIEW });
  // The schema's name is written into the query so that its space and & survive.
  assert.deepEqual(app.calls, [{ method: "GET", path: SNAPSHOT_PATH.slice("GET ".length), body: undefined }]);
  assert.deepEqual(await answer(READ_SCHEMA, app.call, { shared: [1, 2] }), refused(8, "not-shared"));
  assert.equal(app.calls.length, 1);
});

test("shows no views for a capture that did not record them", async () => {
  // Through JSON, as the server sends it, a capture without views has no views field at all.
  const withoutViews: unknown = JSON.parse(JSON.stringify({ ...SNAPSHOT, views: undefined }));
  const read = await answer(READ_SCHEMA, fakeApp({ [SNAPSHOT_PATH]: ok({ snapshot: withoutViews }) }).call);
  assert.deepEqual(read, { id: 8, ok: true, result: { ...OVERVIEW, views: [] } });
});

test("fails a schema read when the capture is not one the phone link can read, and logs why", async () => {
  newLogLines();
  const [orders, auditLog] = SNAPSHOT.tables;
  const noType = { ...orders, columns: [{ name: "id", nullable: false, columnDefault: null }] };
  for (const snapshot of [{ ...SNAPSHOT, tables: [noType, auditLog] }, { ...SNAPSHOT, tables: null }, { ...SNAPSHOT, views: [null] }, null]) {
    const read = await answer(READ_SCHEMA, fakeApp({ [SNAPSHOT_PATH]: ok({ snapshot }) }).call);
    assert.deepEqual(read, refused(8, "failed"));
    assert.match(newLogLines(), /answered with a schema the phone link cannot read/);
  }
});

test("compares only shared schemas, and passes on the summary with only the fields a phone reads", async () => {
  const source = { connectionId: 1, schema: "public" };
  const app = fakeApp({
    "POST /api/compare/phone": ok({ ...SUMMARY, targets: [{ ...SUMMARY.targets[0], host: HOST }], hosts: [HOST] }),
  });
  const unshared: Request = { id: 11, method: "compare.run", params: { source, targets: [{ connectionId: 2, schema: "public" }, { connectionId: 4, schema: "public" }] } };
  assert.deepEqual(await answer(unshared, app.call), refused(11, "not-shared"));
  assert.deepEqual(await answer({ ...unshared, params: { ...unshared.params, source: { connectionId: 4, schema: "public" } } }, app.call, { shared: [2] }), refused(11, "not-shared"));
  assert.deepEqual(app.calls, []);

  const shared: Request = { id: 12, method: "compare.run", params: { source, targets: [{ connectionId: 2, schema: "public" }] } };
  const read = await answer(shared, app.call);
  assert.deepEqual(read, { id: 12, ok: true, result: SUMMARY });
  assert.ok(!JSON.stringify(read).includes(HOST));
  assert.deepEqual(app.calls, [{ method: "POST", path: "/api/compare/phone", body: { source, targets: [{ connectionId: 2, schema: "public" }] } }]);
});

test("fails a comparison whose summary is not one the phone link can read, and logs why", async () => {
  newLogLines();
  const broken = { ...SUMMARY, targets: [{ ...SUMMARY.targets[0], status: "maybe" }] };
  const request: Request = { id: 13, method: "compare.run", params: { source: { connectionId: 1, schema: "public" }, targets: [{ connectionId: 2, schema: "public" }] } };
  assert.deepEqual(await answer(request, fakeApp({ "POST /api/compare/phone": ok(broken) }).call), refused(13, "failed"));
  assert.match(newLogLines(), /answered with a summary the phone link cannot read/);
});

/** What the Performance screen's route answers, with fields no phone should get beside the ones it should. */
function activityAnswer(sessions: unknown[] = [liveSession()], summary: Record<string, unknown> = {}): AppAnswer {
  return ok({
    connectionName: "Secret name",
    database: "shop",
    takenAt: "2026-10-30T10:00:00.000Z",
    longRunningSeconds: 60,
    thresholdConfigured: true,
    sessions,
    summary: { total: sessions.length, blocked: 1, idleInTransaction: 0, longRunning: 0, anyHidden: false, ...summary },
    emptyMessage: "Nothing",
    hiddenNote: null,
    health: {
      database: "shop",
      since: "2026-10-01T00:00:00.000Z",
      metrics: [{ key: "cache_hit_ratio", label: "Cache hit ratio", display: "99.1%", value: 99.1, level: "good", note: "Most reads come from memory." }],
    },
    breaches: [{ server: HOST }],
    connectionHost: HOST,
  });
}

function liveSession(changes: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    pid: 4242,
    kind: "blocked",
    querySeconds: 12.5,
    xactSeconds: 40,
    username: "secret_user",
    applicationName: "report-runner",
    clientAddr: "10.1.2.3",
    state: "active",
    waitingOn: "Lock: transactionid",
    query: "SELECT secret FROM orders",
    queryHidden: false,
    ...changes,
  };
}

const TRACKED = [
  {
    id: 9,
    connectionId: 2,
    schemaName: "sales",
    label: null,
    connectionHost: HOST,
    driftStatus: "drifted",
    driftSummary: `Could not reach ${HOST}`,
    driftCheckedAt: "2026-10-30T09:00:00.000Z",
    lastCheckedAt: "2026-10-30T09:59:00.000Z",
    headVersion: "20261001",
  },
  { id: 10, connectionId: 7, schemaName: "other", driftStatus: "in_sync", driftCheckedAt: null, lastCheckedAt: null, headVersion: null },
  { id: 11, connectionId: 2, schemaName: "public", driftStatus: null, driftCheckedAt: "2026-10-30T08:00:00.000Z", lastCheckedAt: null, headVersion: null },
];
const ACTIVITY_PATH = "GET /api/performance/activity?connectionId=2&schema=sales";
const LIVE_REQUEST: Request = { id: 30, method: "live.read", params: { connectionId: 2 } };

test("refuses live status for a connection that is not shared, without asking the app", async () => {
  const app = fakeApp({});
  assert.deepEqual(await answer({ id: 30, method: "live.read", params: { connectionId: 4 } }, app.call), refused(30, "not-shared"));
  assert.deepEqual(app.calls, []);
});

test("sends a phone live status with only the fields it shows, and only this connection's schemas", async () => {
  const app = fakeApp({ "GET /api/lineage": ok(TRACKED), [ACTIVITY_PATH]: activityAnswer() });
  const read = await answer(LIVE_REQUEST, app.call);
  assert.deepEqual(read, {
    id: 30,
    ok: true,
    result: {
      activity: {
        takenAt: "2026-10-30T10:00:00.000Z",
        longRunningSeconds: 60,
        total: 1,
        blocked: 1,
        idleInTransaction: 0,
        longRunning: 0,
        sessions: [{ pid: 4242, queryStart: null, kind: "blocked", querySeconds: 12.5, xactSeconds: 40, applicationName: "report-runner", waitingOn: "Lock: transactionid", query: null }],
        queryText: false,
        someHidden: false,
      },
      activityProblem: null,
      health: { since: "2026-10-01T00:00:00.000Z", metrics: [{ label: "Cache hit ratio", display: "99.1%", level: "good", note: "Most reads come from memory." }] },
      drift: [
        { id: 9, schema: "sales", status: "drifted", checkedAt: "2026-10-30T09:59:00.000Z", headVersion: "20261001", acknowledgedAt: null },
        { id: 11, schema: "public", status: null, checkedAt: "2026-10-30T08:00:00.000Z", headVersion: null, acknowledgedAt: null },
      ],
      driftProblem: null,
      control: NO_CONTROL,
    },
  });
  const sent = JSON.stringify(read);
  for (const secret of [HOST, "secret_user", "10.1.2.3", "SELECT secret", "Secret name"]) assert.ok(!sent.includes(secret), secret);
});

test("shows a session's SQL only when it is turned on for that connection, and cuts it short", async () => {
  const long = "x".repeat(MAX_LIVE_QUERY_LENGTH + 5);
  const sessions = [liveSession({ query: long }), liveSession({ pid: 2, query: null, queryHidden: true })];
  const routes = { "GET /api/lineage": ok(TRACKED), [ACTIVITY_PATH]: activityAnswer(sessions, { anyHidden: true }) };
  const off = await answer(LIVE_REQUEST, fakeApp(routes).call, { queryText: [5] });
  assert.ok(off.ok && off.id === 30);
  const offStatus = off.result as LiveStatus;
  assert.equal(offStatus.activity?.queryText, false);
  assert.deepEqual(offStatus.activity?.sessions.map((session) => session.query), [null, null]);

  const on = await answer(LIVE_REQUEST, fakeApp(routes).call, { queryText: [2] });
  assert.ok(on.ok);
  const onStatus = on.result as LiveStatus;
  assert.equal(onStatus.activity?.queryText, true);
  assert.equal(onStatus.activity?.someHidden, true);
  assert.deepEqual(onStatus.activity?.sessions.map((session) => session.query), ["x".repeat(MAX_LIVE_QUERY_LENGTH), null]);
});

test("sends the worst sessions a message holds, and the counts of them all", async () => {
  const sessions = Array.from({ length: MAX_LIVE_SESSIONS + 3 }, (_, index) => liveSession({ pid: index + 1 }));
  const app = fakeApp({ "GET /api/lineage": ok(TRACKED), [ACTIVITY_PATH]: activityAnswer(sessions) });
  const read = await answer(LIVE_REQUEST, app.call);
  assert.ok(read.ok);
  const { activity } = read.result as LiveStatus;
  assert.equal(activity?.total, MAX_LIVE_SESSIONS + 3);
  assert.deepEqual(activity?.sessions.map((session) => session.pid), Array.from({ length: MAX_LIVE_SESSIONS }, (_, index) => index + 1));
});

test("asks about the public schema's rule when this connection tracks no schema, since the route needs a name", async () => {
  const app = fakeApp({ "GET /api/lineage": ok([TRACKED[1]]), "GET /api/performance/activity?connectionId=2&schema=public": activityAnswer([]) });
  const read = await answer(LIVE_REQUEST, app.call);
  assert.ok(read.ok);
  assert.deepEqual((read.result as LiveStatus).drift, []);
  assert.deepEqual(app.calls.map((call) => call.path), ["/api/lineage", "/api/performance/activity?connectionId=2&schema=public"]);
});

test("still shows the part it could read when another part of live status has a problem", async () => {
  const words = { error: `PostgreSQL reported: no route to ${HOST}` };
  const noServer = await answer(LIVE_REQUEST, fakeApp({ "GET /api/lineage": ok(TRACKED), [ACTIVITY_PATH]: { status: 502, json: words } }).call);
  assert.ok(noServer.ok);
  const unreachable = noServer.result as LiveStatus;
  assert.equal(unreachable.activity, null);
  assert.equal(unreachable.activityProblem, "unreachable");
  assert.equal(unreachable.health, null);
  assert.equal(unreachable.drift?.length, 2);
  assert.ok(!JSON.stringify(noServer).includes(HOST));

  const noPerformance = await answer(LIVE_REQUEST, fakeApp({ "GET /api/lineage": ok(TRACKED), [ACTIVITY_PATH]: { status: 403, json: words } }).call);
  assert.ok(noPerformance.ok);
  assert.equal((noPerformance.result as LiveStatus).activityProblem, "forbidden");
  assert.equal((noPerformance.result as LiveStatus).driftProblem, null);

  const noDrift = await answer(
    LIVE_REQUEST,
    fakeApp({ "GET /api/lineage": { status: 403, json: words }, "GET /api/performance/activity?connectionId=2&schema=public": activityAnswer() }).call,
  );
  assert.ok(noDrift.ok);
  assert.equal((noDrift.result as LiveStatus).driftProblem, "forbidden");
  assert.equal((noDrift.result as LiveStatus).activityProblem, null);

  // Health can be missing by itself: the route says so when it could not measure it.
  const bare = ok({ ...(activityAnswer().json as Record<string, unknown>), health: null });
  const noHealth = await answer(LIVE_REQUEST, fakeApp({ "GET /api/lineage": ok(TRACKED), [ACTIVITY_PATH]: bare }).call);
  assert.ok(noHealth.ok);
  assert.equal((noHealth.result as LiveStatus).health, null);
  assert.equal((noHealth.result as LiveStatus).activityProblem, null);
});

test("refuses live status as a whole when none of it may be seen, or the trouble is the whole request's", async () => {
  const no = { status: 403, json: {} };
  const both = fakeApp({ "GET /api/lineage": no, "GET /api/performance/activity?connectionId=2&schema=public": no });
  assert.deepEqual(await answer(LIVE_REQUEST, both.call), refused(30, "forbidden"));

  const signedOut = { status: 401, json: {} };
  assert.deepEqual(await answer(LIVE_REQUEST, fakeApp({ "GET /api/lineage": signedOut }).call), refused(30, "signed-out"));
  assert.deepEqual(await answer(LIVE_REQUEST, fakeApp({ "GET /api/lineage": ok(TRACKED), [ACTIVITY_PATH]: { status: 404, json: {} } }).call), refused(30, "not-found"));
  assert.deepEqual(await answer(LIVE_REQUEST, fakeApp({ "GET /api/lineage": new Error("down") }).call), refused(30, "no-answer"));
  newLogLines();
});

test("fails the part of live status the app describes wrongly, without sending what it said", async () => {
  const wrong = fakeApp({ "GET /api/lineage": ok({ tracked: [] }), "GET /api/performance/activity?connectionId=2&schema=public": activityAnswer() });
  const read = await answer(LIVE_REQUEST, wrong.call);
  assert.ok(read.ok);
  assert.equal((read.result as LiveStatus).driftProblem, "failed");
  assert.equal((read.result as LiveStatus).activityProblem, null);

  // A session of an unknown kind makes the whole answer one a phone could not read, so it is refused rather than sent.
  const odd = fakeApp({ "GET /api/lineage": ok(TRACKED), [ACTIVITY_PATH]: activityAnswer([liveSession({ kind: "sleeping" })]) });
  assert.deepEqual(await answer(LIVE_REQUEST, odd.call), refused(30, "failed"));
  newLogLines();
});

test("says whether the phone has drift alerts on, and the key its browser turns them on with, without asking the server", async () => {
  const app = fakeApp({});
  const off = fakeAlerts();
  assert.deepEqual(await answer({ id: 1, method: "push.status" }, app.call, { alerts: off }), { id: 1, ok: true, result: { key: PUSH_KEY, subscribed: false } });
  const on = fakeAlerts(subscriptionOf(newPhone(), ENDPOINT));
  assert.deepEqual(await answer({ id: 2, method: "push.status" }, app.call, { alerts: on }), { id: 2, ok: true, result: { key: PUSH_KEY, subscribed: true } });
  assert.deepEqual(app.calls, []);
  assert.deepEqual([...off.saved, ...on.saved], []);
});

test("turns drift alerts on for a role that may see drift, saving the subscription written the one way", async () => {
  const alerts = fakeAlerts();
  const app = fakeApp({ "GET /api/me": ok(me(["dashboard:read", "drift:read"])) });
  // The URL standard writes a host in lower case, without the usual port.
  const params = subscriptionOf(newPhone(), "https://FCM.googleapis.com:443/fcm/send/a1b2c3");
  assert.deepEqual(await answer({ id: 3, method: "push.subscribe", params }, app.call, { alerts }), {
    id: 3,
    ok: true,
    result: { key: PUSH_KEY, subscribed: true },
  });
  assert.deepEqual(alerts.saved, [{ ...params, endpoint: ENDPOINT }]);
  assert.deepEqual(app.calls, [{ method: "GET", path: "/api/me", body: undefined }]);
});

test("leaves drift alerts off for a role that may not see drift, or when nobody is signed in", async () => {
  const params = subscriptionOf(newPhone(), ENDPOINT);
  const cases: [AppAnswer, Refusal][] = [
    [ok(me(["dashboard:read", "compare:read", "visualizer:read"])), "forbidden"],
    [{ status: 401, json: { error: "Sign in to continue." } }, "signed-out"],
    [{ status: 404, json: { error: "This organization does not exist, or you are not a member." } }, "not-member"],
    [{ status: 503, json: { error: "Could not check what your role can do, because the app's database did not answer." } }, "access-unknown"],
    [ok({ role: "viewer" }), "failed"],
  ];
  newLogLines();
  for (const [mine, refusal] of cases) {
    const alerts = fakeAlerts();
    const read = await answer({ id: 4, method: "push.subscribe", params }, fakeApp({ "GET /api/me": mine }).call, { alerts });
    assert.deepEqual(read, refused(4, refusal), refusal);
    assert.deepEqual(alerts.saved, [], refusal);
  }
  // Only the server that could not read the role, and the answer that was not
  // what GET /api/me gives, are worth a line in the log.
  const lines = newLogLines();
  assert.match(lines, /answered the phone link's GET \/api\/me with 503/);
  assert.match(lines, /could not answer a phone's push\.subscribe\.\n.*did not answer with a list of permissions/);
  assert.equal(lines.match(/could not answer/g)?.length, 1, lines);
  assert.equal(lines.match(/answered the phone link's/g)?.length, 1, lines);
});

test("refuses a subscription the computer would not send alerts to, without asking the server", async () => {
  const good = subscriptionOf(newPhone(), ENDPOINT);
  const app = fakeApp({ "GET /api/me": ok(me(["drift:read"])) });
  const alerts = fakeAlerts();
  const cases: Record<string, PushSubscriptionFields> = {
    "an address that is not https": { ...good, endpoint: "http://fcm.googleapis.com/fcm/send/a1b2c3" },
    "an address at no push service the computer knows": { ...good, endpoint: "https://push.example.com/send/a1b2c3" },
    "a phone key that is not a P-256 point": { ...good, p256dh: good.auth },
    "a secret of the wrong length": { ...good, auth: good.p256dh },
  };
  for (const [what, params] of Object.entries(cases)) {
    assert.deepEqual(await answer({ id: 5, method: "push.subscribe", params }, app.call, { alerts }), refused(5, "bad-subscription"), what);
  }
  assert.deepEqual(app.calls, []);
  assert.deepEqual(alerts.saved, []);
});

test("leaves drift alerts off when the phone stops waiting before the server has answered", async () => {
  const stopped = new AbortController();
  const alerts = fakeAlerts();
  // The phone goes just as the server answers.
  const call: AppCaller = async () => {
    stopped.abort();
    return ok(me(["drift:read"]));
  };
  newLogLines();
  const request: Request = { id: 6, method: "push.subscribe", params: subscriptionOf(newPhone(), ENDPOINT) };
  assert.deepEqual(await answer(request, call, { alerts, signal: stopped.signal }), refused(6, "failed"));
  assert.deepEqual(alerts.saved, []);
  assert.equal(newLogLines(), "");
});

test("turns drift alerts off without asking the server, whatever the role may do", async () => {
  const alerts = fakeAlerts(subscriptionOf(newPhone(), ENDPOINT));
  const app = fakeApp({});
  assert.deepEqual(await answer({ id: 7, method: "push.unsubscribe" }, app.call, { alerts }), { id: 7, ok: true, result: { key: PUSH_KEY, subscribed: false } });
  assert.deepEqual(alerts.saved, [null]);
  assert.deepEqual(app.calls, []);
});

test("says whether drift alerts may go to phones from what the signed-in role may do, and logs only the unexpected", async () => {
  const signal = new AbortController().signal;
  const cases: [AppAnswer, "yes" | Refusal][] = [
    [ok(me(["drift:read"])), "yes"],
    [ok(me(["dashboard:read", "compare:read"])), "forbidden"],
    [{ status: 401, json: { error: "Sign in to continue." } }, "signed-out"],
    [{ status: 404, json: { error: "This organization does not exist, or you are not a member." } }, "not-member"],
  ];
  newLogLines();
  for (const [mine, allowed] of cases) assert.equal(await driftAlertsAllowed(fakeApp({ "GET /api/me": mine }).call, signal), allowed, allowed);
  assert.equal(newLogLines(), "");

  assert.equal(await driftAlertsAllowed(fakeApp({ "GET /api/me": { status: 503, json: { error: "Could not check what your role can do, because the app's database did not answer." } } }).call, signal), "access-unknown");
  assert.match(newLogLines(), /answered the phone link's GET \/api\/me with 503/);

  assert.equal(await driftAlertsAllowed(fakeApp({ "GET /api/me": ok(null) }).call, signal), "failed");
  assert.match(newLogLines(), /could not check whether drift alerts may go to phones\.\n.*did not answer with a list of permissions/);

  const down = fakeApp({ "GET /api/me": new Error("connect ECONNREFUSED 127.0.0.1:41234") });
  assert.equal(await driftAlertsAllowed(down.call, signal), "no-answer");
  assert.match(newLogLines(), /could not reach the app for GET \/api\/me\./);

  const stopped = new AbortController();
  stopped.abort();
  assert.equal(await driftAlertsAllowed(down.call, stopped.signal), "no-answer");
  assert.equal(newLogLines(), "");
});

test("refuses with a fixed sentence for each status, never with the server's words", async () => {
  const cases: [number, Refusal, boolean][] = [
    [401, "signed-out", false],
    [403, "forbidden", false],
    [404, "not-found", false],
    [502, "unreachable", false],
    [503, "access-unknown", true],
    [500, "failed", true],
    [400, "failed", true],
    [418, "failed", true],
  ];
  newLogLines();
  for (const [status, refusal, logged] of cases) {
    const app = fakeApp({ "GET /api/lineage/schemas?connectionId=1": { status, json: { error: `Could not connect to ${HOST}:5432 as reporting.` } } });
    const read = await answer({ id: 14, method: "schemas.list", params: { connectionId: 1 } }, app.call);
    assert.deepEqual(read, refused(14, refusal), String(status));
    assert.ok(!JSON.stringify(read).includes(HOST), String(status));
    const lines = newLogLines();
    if (logged) {
      // The server's words go to the computer's log, but not which connection was asked about.
      assert.ok(lines.includes(`GET /api/lineage/schemas with ${status}: Could not connect to`), lines);
      assert.ok(!lines.includes("connectionId"), lines);
    } else {
      assert.equal(lines, "", String(status));
    }
  }
});

test("says the app did not answer when it cannot be reached, and logs it unless the phone has stopped waiting", async () => {
  newLogLines();
  const down = fakeApp({ "GET /api/me": new Error("connect ECONNREFUSED 127.0.0.1:41234") });
  assert.deepEqual(await answer({ id: 15, method: "hello" }, down.call), refused(15, "no-answer"));
  assert.match(newLogLines(), /could not reach the app for GET \/api\/me\.\n.*ECONNREFUSED/);

  const stopped = new AbortController();
  stopped.abort();
  assert.deepEqual(await answer({ id: 16, method: "hello" }, down.call, { signal: stopped.signal }), refused(16, "no-answer"));
  assert.equal(newLogLines(), "");
});

test("fails a request when the app answers with something unexpected, and logs it unless the phone has stopped waiting", async () => {
  newLogLines();
  const app = fakeApp({ "GET /api/me": ok(null) });
  assert.deepEqual(await answer({ id: 17, method: "hello" }, app.call), refused(17, "failed"));
  assert.match(newLogLines(), /could not answer a phone's hello\.\n.*did not answer with a list of permissions/);

  const stopped = new AbortController();
  stopped.abort();
  assert.deepEqual(await answer({ id: 18, method: "hello" }, app.call, { signal: stopped.signal }), refused(18, "failed"));
  assert.equal(newLogLines(), "");
});

const CHECK_REQUEST: Request = { id: 40, method: "drift.check", params: { connectionId: 2, trackedSchemaId: 9 } };
const ACKNOWLEDGE_REQUEST: Request = { id: 41, method: "drift.acknowledge", params: { connectionId: 2, trackedSchemaId: 9 } };

/** Every drift request and the entry it leaves in the action log, for the schema those two name. */
const DRIFT_ACTIONS = [
  { request: CHECK_REQUEST, action: "drift-check", route: "POST /api/lineage/drift" },
  { request: ACKNOWLEDGE_REQUEST, action: "drift-acknowledge", route: "POST /api/lineage/acknowledge" },
] as const;

test("does a drift action through the route the app's own page uses, naming only the tracked schema, and logs it as done", async () => {
  for (const { request, action, route } of DRIFT_ACTIONS) {
    const control = fakeControl(true);
    const app = fakeApp({ "GET /api/lineage": ok(TRACKED), [route]: ok({ status: "drifted", summary: "Secret name", report: { secret: true } }) });
    const read = await answer(request, app.call, { control });
    assert.deepEqual(read, { id: request.id, ok: true, result: { status: "drifted" } });
    assert.deepEqual(app.calls.at(-1), { method: "POST", path: route.split(" ")[1], body: { trackedSchemaId: 9 } });
    assert.deepEqual(control.entries, [{ action, connectionId: 2, schema: "sales", outcome: "done" }]);
  }
});

test("asks the app nothing for a drift action while Allow control is off, and logs the try", async () => {
  for (const { request, action } of DRIFT_ACTIONS) {
    const control = fakeControl(false);
    const app = fakeApp({});
    assert.deepEqual(await answer(request, app.call, { control }), refused(request.id, "control-off"));
    assert.deepEqual(app.calls, []);
    assert.deepEqual(control.entries, [{ action, connectionId: 2, schema: null, outcome: "control-off" }]);
  }
});

test("reads Allow control at every drift action, so turning it off counts at once", async () => {
  let allowed = true;
  const entries: unknown[] = [];
  const app = fakeApp({ "GET /api/lineage": ok(TRACKED), "POST /api/lineage/drift": ok({ status: "in_sync" }) });
  const control: PhoneControl = { allowed: () => allowed, record: (entry) => void entries.push(entry) };
  assert.equal((await answer(CHECK_REQUEST, app.call, { control })).ok, true);
  allowed = false;
  assert.deepEqual(await answer(CHECK_REQUEST, app.call, { control }), refused(40, "control-off"));
  assert.equal(entries.length, 2);
});

test("refuses a drift action on a connection that is not shared before reading anything", async () => {
  for (const { request, action } of DRIFT_ACTIONS) {
    const control = fakeControl(true);
    const app = fakeApp({});
    assert.deepEqual(await answer(request, app.call, { control, shared: [1, 3] }), refused(request.id, "not-shared"));
    assert.deepEqual(app.calls, []);
    assert.deepEqual(control.entries, [{ action, connectionId: 2, schema: null, outcome: "not-shared" }]);
  }
});

test("refuses a tracked schema of another connection, so sharing one connection cannot reach a schema of another", async () => {
  for (const trackedSchemaId of [10, 99]) {
    const control = fakeControl(true);
    const app = fakeApp({ "GET /api/lineage": ok(TRACKED) });
    const request: Request = { id: 42, method: "drift.check", params: { connectionId: 2, trackedSchemaId } };
    assert.deepEqual(await answer(request, app.call, { control }), refused(42, "not-found"));
    assert.deepEqual(app.calls.map((call) => call.method), ["GET"]);
    assert.deepEqual(control.entries, [{ action: "drift-check", connectionId: 2, schema: null, outcome: "not-found" }]);
  }
});

test("refuses a drift action with the fixed sentence for each thing the app can answer, and logs each one", async () => {
  const cases: [AppAnswer | Error, Refusal, string][] = [
    [{ status: 401, json: { error: "Secret name" } }, "signed-out", "signed-out"],
    [{ status: 403, json: { error: "Secret name" } }, "forbidden", "forbidden"],
    [{ status: 404, json: { error: "Secret name" } }, "not-found", "not-found"],
    [{ status: 409, json: { error: "Secret name" } }, "no-baseline", "no-baseline"],
    [{ status: 500, json: { error: "Secret name" } }, "failed", "failed"],
    [{ status: 200, json: { summary: "Secret name" } }, "failed", "failed"],
    [{ status: 502, json: { error: "Secret name" } }, "unreachable", "unreachable"],
    [new Error("Secret name"), "no-answer", "failed"],
  ];
  for (const [routeAnswer, refusal, outcome] of cases) {
    const control = fakeControl(true);
    const app = fakeApp({ "GET /api/lineage": ok(TRACKED), "POST /api/lineage/acknowledge": routeAnswer });
    const read = await answer(ACKNOWLEDGE_REQUEST, app.call, { control });
    assert.deepEqual(read, refused(41, refusal), outcome);
    assert.ok(!JSON.stringify(read).includes("Secret name"));
    assert.deepEqual(control.entries, [{ action: "drift-acknowledge", connectionId: 2, schema: "sales", outcome }]);
  }
});

test("logs a check whose database could not be reached as that, not as done, and still answers its status", async () => {
  const control = fakeControl(true);
  const app = fakeApp({ "GET /api/lineage": ok(TRACKED), "POST /api/lineage/drift": ok({ status: "unreachable" }) });
  assert.deepEqual(await answer(CHECK_REQUEST, app.call, { control }), { id: 40, ok: true, result: { status: "unreachable" } });
  assert.deepEqual(control.entries, [{ action: "drift-check", connectionId: 2, schema: "sales", outcome: "unreachable" }]);
});

test("tells a phone what it may do in a live status only when Allow control is on, from what the role may do", async () => {
  const nothing = { canCheck: false, canAcknowledge: false, canDeploy: false, canCancel: false };
  const cases: [string[], typeof nothing][] = [
    [[], nothing],
    [["drift:run"], { ...nothing, canCheck: true }],
    [["deploy:run"], { ...nothing, canCheck: true }],
    [["drift:update"], { ...nothing, canAcknowledge: true }],
    [["drift:run", "drift:update"], { ...nothing, canCheck: true, canAcknowledge: true }],
    [["deploy:read"], nothing],
    [["deploy:read", "deploy:run"], { ...nothing, canCheck: true, canDeploy: true }],
    [["deploy:read", "approvals:create"], { ...nothing, canDeploy: true }],
    [["approvals:create"], nothing],
    [["performance:update"], { ...nothing, canCancel: true }],
  ];
  for (const [permissions, may] of cases) {
    const app = fakeApp({ "GET /api/lineage": ok(TRACKED), [ACTIVITY_PATH]: activityAnswer(), "GET /api/me": ok(me(permissions)) });
    const read = await answer(LIVE_REQUEST, app.call, { control: fakeControl(true) });
    assert.ok(read.ok);
    assert.deepEqual((read.result as LiveStatus).control, { allowed: true, ...may, passkey: "none" }, permissions.join());
  }
});

test("says in a live status whether this phone's passkey can sign, and shows no buttons when that cannot be read", async () => {
  const routes = { "GET /api/lineage": ok(TRACKED), [ACTIVITY_PATH]: activityAnswer(), "GET /api/me": ok(me(["performance:update"])) };
  const ready = await answer(LIVE_REQUEST, fakeApp(routes).call, { control: fakeControl(true), controlRequests: fakeControlRequests({ passkey: async () => "ready" }) });
  assert.ok(ready.ok);
  assert.deepEqual((ready.result as LiveStatus).control, { ...NO_CONTROL, allowed: true, canCancel: true, passkey: "ready" });

  const failing = fakeControlRequests({
    passkey: async () => {
      throw new Refused("failed");
    },
  });
  const read = await answer(LIVE_REQUEST, fakeApp(routes).call, { control: fakeControl(true), controlRequests: failing });
  assert.ok(read.ok);
  assert.deepEqual((read.result as LiveStatus).control, { ...NO_CONTROL, allowed: true });
});

test("tells a phone when a running query began, which is what its cancel names", async () => {
  const began = "2026-10-30T09:59:47.500Z";
  const app = fakeApp({ "GET /api/lineage": ok(TRACKED), [ACTIVITY_PATH]: activityAnswer([liveSession({ queryStart: began })]) });
  const read = await answer(LIVE_REQUEST, app.call);
  assert.ok(read.ok);
  assert.equal((read.result as LiveStatus).activity?.sessions[0]?.queryStart, began);
});

const SIGNATURE = { credentialId: "Y3JlZA", authenticatorData: "YXV0aA", clientDataJSON: "Y2xpZW50", signature: "c2ln" };
const FAMILY_PARAMS = { connectionId: 2, schemaName: "sales", scriptName: "users_migration" };
const PLAN_PARAMS = { ...FAMILY_PARAMS, action: "deploy" as const, targetVersion: "2.0.0" };
const START_PARAMS = { ...PLAN_PARAMS, fingerprint: "ab".repeat(32), step: "run" as const, ticks: [], assertion: SIGNATURE };
const CANCEL_PARAMS = { connectionId: 2, pid: 4242, queryStart: "2026-10-30T09:59:47.500Z", assertion: SIGNATURE };

test("passes a phone's deploys and cancels on with the request's signal, and sends back what they answer", async () => {
  const { signal } = new AbortController();
  const control = fakeControl(true);
  const requests = fakeControlRequests();
  const app = fakeApp({});
  const asked = async (request: Request): Promise<Answer> => answer(request, app.call, { control, controlRequests: requests, signal });

  assert.deepEqual(await asked({ id: 50, method: "deploy.list", params: { connectionId: 2 } }), {
    id: 50,
    ok: true,
    result: { registry: "ok", partial: false, families: [], passkey: "none" },
  });
  assert.deepEqual(await asked({ id: 51, method: "deploy.family", params: FAMILY_PARAMS }), {
    id: 51,
    ok: true,
    result: { currentVersion: null, waiting: [], undo: [], partial: false, run: null },
  });
  assert.deepEqual(await asked({ id: 52, method: "control.begin" }), { id: 52, ok: true, result: { nonce: "bm9uY2U", credentialId: "Y3JlZA" } });
  assert.deepEqual(await asked({ id: 53, method: "deploy.start", params: START_PARAMS }), { id: 53, ok: true, result: { status: "running" } });
  assert.deepEqual(await asked({ id: 54, method: "session.cancel", params: CANCEL_PARAMS }), { id: 54, ok: true, result: { status: "cancelled" } });

  assert.deepEqual(requests.asked, [
    ["deployList", 2, signal],
    ["deployFamily", FAMILY_PARAMS, signal],
    ["begin"],
    ["deployStart", START_PARAMS, signal],
    ["cancelSession", CANCEL_PARAMS, signal],
  ]);
  assert.equal(app.calls.length, 0);
});

test("turns a refusal from a deploy or a cancel into its fixed sentence", async () => {
  const refuses = (refusal: Refusal): PhoneControlRequests =>
    fakeControlRequests({
      deployStart: async () => {
        throw new Refused(refusal);
      },
    });
  const request: Request = { id: 55, method: "deploy.start", params: START_PARAMS };
  const refusals: Refusal[] = ["control-off", "control-no-passkey", "control-other-person", "control-changed", "control-expired", "already-running", "no-registry"];
  for (const refusal of refusals) {
    assert.deepEqual(await answer(request, fakeApp({}).call, { controlRequests: refuses(refusal) }), refused(55, refusal));
  }
  // The plan's default in the fake refuses too, which is the same way out.
  assert.deepEqual(await answer({ id: 56, method: "deploy.plan", params: PLAN_PARAMS }, fakeApp({}).call), refused(56, "not-found"));
  const cancel = fakeControlRequests({
    cancelSession: async () => {
      throw new Refused("database-refused");
    },
  });
  assert.deepEqual(await answer({ id: 57, method: "session.cancel", params: CANCEL_PARAMS }, fakeApp({}).call, { controlRequests: cancel }), refused(57, "database-refused"));
});

test("asks the app nothing about the role in a live status while Allow control is off", async () => {
  const app = fakeApp({ "GET /api/lineage": ok(TRACKED), [ACTIVITY_PATH]: activityAnswer() });
  const read = await answer(LIVE_REQUEST, app.call, { control: fakeControl(false) });
  assert.ok(read.ok);
  assert.deepEqual((read.result as LiveStatus).control, NO_CONTROL);
  assert.ok(!app.calls.some((call) => call.path === "/api/me"));
});

test("shows no buttons in a live status when the role cannot be read, and the rest of it still arrives", async () => {
  for (const failure of [new Error("down"), { status: 500, json: {} }, { status: 200, json: { role: 7 } }]) {
    const app = fakeApp({ "GET /api/lineage": ok(TRACKED), [ACTIVITY_PATH]: activityAnswer(), "GET /api/me": failure });
    const read = await answer(LIVE_REQUEST, app.call, { control: fakeControl(true) });
    assert.ok(read.ok);
    const live = read.result as LiveStatus;
    assert.deepEqual(live.control, { ...NO_CONTROL, allowed: true });
    assert.equal(live.drift?.length, 2);
  }
});

test("sends when a drift was acknowledged, and nothing else the app records about it", async () => {
  const tracked = TRACKED.map((item) => (item.id === 9 ? { ...item, driftAcknowledgedAt: "2026-10-30T09:59:30.000Z", driftSummary: "Secret name" } : item));
  const app = fakeApp({ "GET /api/lineage": ok(tracked), [ACTIVITY_PATH]: activityAnswer() });
  const read = await answer(LIVE_REQUEST, app.call);
  assert.ok(read.ok);
  assert.equal((read.result as LiveStatus).drift?.[0]?.acknowledgedAt, "2026-10-30T09:59:30.000Z");
  assert.ok(!JSON.stringify(read).includes("Secret name"));
});

test("reads which connections are shared at every request, so a change in Settings counts at once", async () => {
  let shared: number[] = [1];
  const app = fakeApp({ "GET /api/lineage/schemas?connectionId=1": ok({ schemas: ["public"] }) });
  const options = { call: app.call, control: fakeControl(), controlRequests: fakeControlRequests(), sharedConnectionIds: () => shared, queryTextConnectionIds: () => [], appVersion: "1.2.3", alerts: fakeAlerts(), approvals: fakeApprovals() };
  const ask = async (id: number) => readAnswer(await answerRequest({ id, method: "schemas.list", params: { connectionId: 1 } }, options, new AbortController().signal));
  assert.deepEqual(await ask(1), { id: 1, ok: true, result: { schemas: ["public"] } });
  shared = [];
  assert.deepEqual(await ask(2), refused(2, "not-shared"));
  shared = [1];
  assert.deepEqual(await ask(3), { id: 3, ok: true, result: { schemas: ["public"] } });
  assert.equal(app.calls.length, 2);
});

test("refuses only with short plain sentences, each one a code every phone knows", () => {
  for (const [refusal, { code, message }] of Object.entries(REFUSALS)) {
    assert.match(message, /^[ -~]+\.$/, refusal);
    assert.deepEqual(readAnswer(writeRefusal(7, refusal as Refusal)), { id: 7, ok: false, error: { code, message } }, refusal);
  }
  // The computer's own six reasons go out with a code every phone knows, and a sentence that says more.
  for (const refusal of ["access-unknown", "no-answer", "too-slow"] as const) assert.equal(REFUSALS[refusal].code, "failed");
  assert.equal(REFUSALS["not-member"].code, "signed-out");
  assert.equal(REFUSALS["bad-subscription"].code, "bad-request");
  assert.equal(REFUSALS["sql-missing"].code, "forbidden");
});

test("passes each approval request on to the phone's approvals, with what the phone sent", async () => {
  const approvals = fakeApprovals();
  // The approvals ask the app themselves, so the request handler asks it nothing.
  const app = fakeApp({});
  const signal = new AbortController().signal;
  const finish = { clientDataJSON: "Y2xpZW50", attestationObject: "YXR0ZXN0" };
  const decide = {
    approvalId: 4,
    decision: "reject" as const,
    fingerprint: FINGERPRINT,
    assertion: { credentialId: "Y3JlZA", authenticatorData: "YXV0aA", clientDataJSON: "Y2xpZW50", signature: "c2ln" },
  };
  const results = [
    [{ id: 1, method: "approvals.list" }, { approvals: [], passkey: "none", canApprove: false }],
    [{ id: 2, method: "approvals.read", params: { approvalId: 4 } }, { id: 4, action: "deploy", fingerprint: FINGERPRINT, scripts: [{ name: "orders", version: "1.1.0", sql: "SELECT 1;" }] }],
    [{ id: 3, method: "passkey.begin" }, { challenge: "Y2hhbGxlbmdl", userId: "dXNlcg" }],
    [{ id: 4, method: "passkey.finish", params: finish }, { passkey: "ready" }],
    [{ id: 5, method: "approvals.begin" }, { nonce: "bm9uY2U", credentialId: "Y3JlZA" }],
    [{ id: 6, method: "approvals.decide", params: decide }, { status: "rejected" }],
  ] as const;
  for (const [request, result] of results) {
    assert.deepEqual(await answer(request, app.call, { approvals, signal }), { id: request.id, ok: true, result }, request.method);
  }
  assert.deepEqual(approvals.asked, [["list", signal], ["read", 4, signal], ["beginPasskey"], ["finishPasskey", finish, signal], ["beginDecision"], ["decide", decide, signal]]);
  assert.equal(app.calls.length, 0);
});

test("answers an approval request the approvals refuse with that refusal, and fails one they cannot answer", async () => {
  const app = fakeApp({});
  newLogLines();
  const refusing = fakeApprovals({
    list: async () => {
      throw new Refused("other-person");
    },
    beginDecision: () => {
      throw new Refused("no-passkey");
    },
  });
  assert.deepEqual(await answer({ id: 7, method: "approvals.list" }, app.call, { approvals: refusing }), refused(7, "other-person"));
  assert.deepEqual(await answer({ id: 8, method: "approvals.begin" }, app.call, { approvals: refusing }), refused(8, "no-passkey"));
  assert.equal(newLogLines(), "", "a refusal is an answer, not something gone wrong");

  // Anything else is logged, with what went wrong, and the phone hears only that it failed.
  const broken = fakeApprovals({
    read: async () => {
      throw new Error(`The test approvals could not reach ${HOST}.`);
    },
    beginPasskey: () => {
      throw new Error("The test approvals could not make a challenge.");
    },
  });
  const read = await answer({ id: 9, method: "approvals.read", params: { approvalId: 1 } }, app.call, { approvals: broken });
  assert.deepEqual(read, refused(9, "failed"));
  assert.ok(!JSON.stringify(read).includes(HOST));
  assert.match(newLogLines(), /could not answer a phone's approvals\.read\.\n.*could not reach/);
  assert.deepEqual(await answer({ id: 10, method: "passkey.begin" }, app.call, { approvals: broken }), refused(10, "failed"));
  assert.match(newLogLines(), /could not answer a phone's passkey\.begin\.\n.*could not make a challenge/);

  const stopped = new AbortController();
  stopped.abort();
  assert.deepEqual(await answer({ id: 11, method: "approvals.read", params: { approvalId: 1 } }, app.call, { approvals: broken, signal: stopped.signal }), refused(11, "failed"));
  assert.equal(newLogLines(), "");
});

test("asks the app with the refusals a route gives its own meaning to, and the usual ones for the rest", async () => {
  const app = fakeApp({
    "POST /api/deploy/approvals/3": { status: 409, json: { error: "This request has already been decided." } },
    "POST /api/deploy/approvals/4": { status: 404, json: { error: "Not found." } },
    "POST /api/deploy/approvals/5": { status: 403, json: { error: "Not allowed." } },
    "GET /api/deploy/approvals/phone": ok({ approvals: [] }),
  });
  const signal = new AbortController().signal;
  const special = { 404: "already-decided", 409: "already-decided", 412: "changed" } as const;
  const refusalOf = async (path: string): Promise<Refusal | null> => {
    try {
      await ask({ call: app.call }, "POST", path, { decision: "reject" }, signal, special);
      return null;
    } catch (error) {
      assert.ok(error instanceof Refused);
      return error.refusal;
    }
  };
  assert.equal(await refusalOf("/api/deploy/approvals/3"), "already-decided");
  assert.equal(await refusalOf("/api/deploy/approvals/4"), "already-decided");
  assert.equal(await refusalOf("/api/deploy/approvals/5"), "forbidden");
  assert.deepEqual(await ask({ call: app.call }, "GET", "/api/deploy/approvals/phone", undefined, signal), { approvals: [] });
  assert.deepEqual(app.calls[0], { method: "POST", path: "/api/deploy/approvals/3", body: { decision: "reject" } });
});
