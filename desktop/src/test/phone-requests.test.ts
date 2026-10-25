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
  type Refusal,
} from "../main/phone-requests";
import { readAnswer, type Answer, type CompareSummary, type Request } from "../shared/remote/rpc.js";
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
  options: { shared?: readonly number[]; alerts?: PhoneAlerts; approvals?: PhoneApprovalRequests; signal?: AbortSignal } = {},
): Promise<Answer> {
  const shared = options.shared ?? [1, 2, 3];
  const requestOptions = { call, sharedConnectionIds: () => shared, appVersion: "1.2.3", alerts: options.alerts ?? fakeAlerts(), approvals: options.approvals ?? fakeApprovals() };
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
  return { role: "viewer", roleLabel: "Viewer", permissions, bypass: false, viewingAs: null, accessUnavailable: false, ...fields };
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
  source: { connectionId: 1, name: "Dev", environment: "dev", schema: "public", error: null },
  targets: [
    {
      connectionId: 2,
      name: "Prod",
      environment: "prod",
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
    result: { signedIn: true, role: "Viewer", canCompare: true, canReadSchemas: true, appVersion: "1.2.3" },
  });
  assert.deepEqual(app.calls, [{ method: "GET", path: "/api/me", body: undefined }]);

  // Reading a schema takes the Visualizer, and one of the boxes that lists a connection's schemas.
  const cases: [string[], boolean, boolean][] = [
    [[], false, false],
    [["visualizer:read"], false, false],
    [["visualizer:read", "performance:read"], false, true],
    [["compare:read"], true, false],
    [["dashboard:read", "visualizer:read"], false, true],
  ];
  for (const [permissions, canCompare, canReadSchemas] of cases) {
    const read = await answer({ id: 2, method: "hello" }, fakeApp({ "GET /api/me": ok(me(permissions)) }).call);
    assert.deepEqual(
      read,
      { id: 2, ok: true, result: { signedIn: true, role: "Viewer", canCompare, canReadSchemas, appVersion: "1.2.3" } },
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
    result: { signedIn: false, role: null, canCompare: false, canReadSchemas: false, appVersion: "1.2.3" },
  });
  assert.equal(newLogLines(), "");
});

test("refuses hello when the server could not read what the role may do", async () => {
  const unknown = fakeApp({ "GET /api/me": ok(me(["compare:read"], { accessUnavailable: true })) });
  assert.deepEqual(await answer({ id: 4, method: "hello" }, unknown.call), refused(4, "access-unknown"));
  assert.equal(REFUSALS["access-unknown"].code, "failed");
});

test("lists the shared connections only, in the app's order, with only what a phone shows", async () => {
  const app = fakeApp({
    "GET /api/connections/phone": ok({
      connections: [
        { id: 5, name: "Billing", environment: "prod", database: "billing", host: HOST },
        { id: 2, name: "Orders", environment: "staging", database: "orders", host: HOST },
        { id: 9, name: "Search", environment: "dev", database: "search", host: HOST, port: 5432 },
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
        { id: 5, name: "Billing", environment: "prod", database: "billing" },
        { id: 9, name: "Search", environment: "dev", database: "search" },
      ],
    },
  });
  assert.ok(!JSON.stringify(read).includes(HOST));
  assert.deepEqual(app.calls, [{ method: "GET", path: "/api/connections/phone", body: undefined }]);
});

test("fails the list when the app describes a shared connection wrongly, and ignores the ones not shared", async () => {
  newLogLines();
  const wrong = fakeApp({ "GET /api/connections/phone": ok({ connections: [{ id: 1, name: "A", environment: "qa", database: "a" }] }) });
  assert.deepEqual(await answer({ id: 6, method: "connections.list" }, wrong.call), refused(6, "failed"));
  assert.match(newLogLines(), /answered with a connection the phone link cannot read/);

  const notList = fakeApp({ "GET /api/connections/phone": ok({ connections: null }) });
  assert.deepEqual(await answer({ id: 7, method: "connections.list" }, notList.call), refused(7, "failed"));
  assert.match(newLogLines(), /did not answer with a list of connections/);

  const unshared = fakeApp({
    "GET /api/connections/phone": ok({
      connections: [{ id: 1, name: "A", environment: "dev", database: "a" }, { id: 4, environment: "qa" }, "not a connection", null],
    }),
  });
  assert.deepEqual(await answer({ id: 8, method: "connections.list" }, unshared.call, { shared: [1] }), {
    id: 8,
    ok: true,
    result: { connections: [{ id: 1, name: "A", environment: "dev", database: "a" }] },
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
    [ok(me(["drift:read"], { accessUnavailable: true })), "access-unknown"],
    [ok({ role: "viewer" }), "failed"],
  ];
  newLogLines();
  for (const [mine, refusal] of cases) {
    const alerts = fakeAlerts();
    const read = await answer({ id: 4, method: "push.subscribe", params }, fakeApp({ "GET /api/me": mine }).call, { alerts });
    assert.deepEqual(read, refused(4, refusal), refusal);
    assert.deepEqual(alerts.saved, [], refusal);
  }
  // Only the answer that was not what GET /api/me gives is worth a line in the log.
  const lines = newLogLines();
  assert.match(lines, /could not answer a phone's push\.subscribe\.\n.*did not answer with a list of permissions/);
  assert.equal(lines.match(/could not answer/g)?.length, 1, lines);
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
    [ok(me(["drift:read"], { accessUnavailable: true })), "access-unknown"],
  ];
  newLogLines();
  for (const [mine, allowed] of cases) assert.equal(await driftAlertsAllowed(fakeApp({ "GET /api/me": mine }).call, signal), allowed, allowed);
  assert.equal(newLogLines(), "");

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

test("reads which connections are shared at every request, so a change in Settings counts at once", async () => {
  let shared: number[] = [1];
  const app = fakeApp({ "GET /api/lineage/schemas?connectionId=1": ok({ schemas: ["public"] }) });
  const options = { call: app.call, sharedConnectionIds: () => shared, appVersion: "1.2.3", alerts: fakeAlerts(), approvals: fakeApprovals() };
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
  // The computer's own five reasons go out with a code every phone knows, and a sentence that says more.
  for (const refusal of ["access-unknown", "no-answer", "too-slow"] as const) assert.equal(REFUSALS[refusal].code, "failed");
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
