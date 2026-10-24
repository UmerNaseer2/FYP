/**
 * The requests a phone sends the computer, and the computer's answers
 * (src/shared/remote/rpc.ts).
 */
import assert from "node:assert/strict";
import test from "node:test";

import { readUtf8, toBase64Url, utf8, type Bytes } from "../shared/remote/bytes.js";
import {
  MAX_COMPARE_TARGETS,
  MAX_PUSH_FIELD_LENGTH,
  MAX_REQUEST_BYTES,
  MAX_SCHEMA_NAME_LENGTH,
  isSchemaName,
  readAnswer,
  readRequest,
  readResult,
  writeError,
  writeRequest,
  writeResult,
  type ChangeLine,
  type ColumnOverview,
  type CompareSummary,
  type ErrorCode,
  type ForeignKeyOverview,
  type Method,
  type PushSubscriptionParams,
  type Request,
  type Results,
  type SchemaOverview,
  type SchemaRef,
  type SharedConnection,
  type TableOverview,
  type TargetSummary,
} from "../shared/remote/rpc.js";

/** Sends a value as a message, the way the other side's JSON would arrive. */
function message(value: unknown): Bytes {
  return utf8(JSON.stringify(value));
}

/** What a message says, as plain JSON. */
function json(bytes: Bytes): unknown {
  const text = readUtf8(bytes);
  if (text === null) throw new Error("Expected UTF-8.");
  return JSON.parse(text);
}

/** Every kind of request, in the order rpc.ts lists them. */
const METHODS: Method[] = ["hello", "connections.list", "schemas.list", "schema.read", "compare.run", "push.status", "push.subscribe", "push.unsubscribe"];

/** A schema in one of the computer's saved connections. */
const REF: SchemaRef = { connectionId: 7, schema: "public" };

/** A push subscription, as a phone's browser gives it. rpc.ts checks only that each field is a string of a length a request takes. */
const SUBSCRIPTION: PushSubscriptionParams = { endpoint: "https://push.example.com/send/a1b2c3", p256dh: "B".repeat(87), auth: "A".repeat(22) };

/** The computer's public push key: a P-256 point written out whole, which starts with the byte 4. */
const PUSH_KEY = toBase64Url(Uint8Array.from({ length: 65 }, (_, index) => (index === 0 ? 4 : index)));

/** One of each request a phone may send. */
const REQUESTS: Request[] = [
  { id: 1, method: "hello" },
  { id: 2, method: "connections.list" },
  { id: 3, method: "schemas.list", params: { connectionId: 7 } },
  { id: 4, method: "schema.read", params: REF },
  // The biggest number JSON carries exactly.
  { id: Number.MAX_SAFE_INTEGER, method: "compare.run", params: { source: REF, targets: [{ connectionId: 8, schema: "public" }, { connectionId: 7, schema: "archive" }] } },
  { id: 5, method: "push.status" },
  { id: 6, method: "push.subscribe", params: SUBSCRIPTION },
  { id: 7, method: "push.unsubscribe" },
];

/** A column, as the computer describes it. */
const NOTE_COLUMN: ColumnOverview = { name: "note", type: "character varying(80)", nullable: true, default: null };

/** A foreign key, as the computer describes it. */
const CUSTOMER_KEY: ForeignKeyOverview = { columns: ["customer_id"], referencedSchema: "public", referencedTable: "customers", referencedColumns: ["id"] };

/** A table, as the computer describes it. */
const ORDERS: TableOverview = {
  name: "orders",
  columns: [
    { name: "id", type: "integer", nullable: false, default: "nextval('orders_id_seq'::regclass)" },
    { name: "customer_id", type: "integer", nullable: false, default: null },
    NOTE_COLUMN,
  ],
  primaryKey: ["id"],
  foreignKeys: [CUSTOMER_KEY],
};

/** One schema's tables and views, as the computer describes them. */
const OVERVIEW: SchemaOverview = { database: "shop", schema: "public", tables: [ORDERS], views: [{ name: "order_totals", materialized: true }] };

/** A change that would break something. */
const NOTE_LINE: ChangeLine = {
  category: "Column",
  table: "orders",
  object: "note",
  change: "changed",
  severity: "breaking",
  detail: "Type changed from text to character varying(80).",
  manual: false,
};

/** A target that was compared, with its changes. */
const STAGING: TargetSummary = {
  connectionId: 8,
  name: "Staging",
  environment: "staging",
  schema: "public",
  status: "compared",
  error: null,
  changes: 3,
  breaking: 1,
  manual: 1,
  lines: [
    NOTE_LINE,
    // A function belongs to the whole schema, not to a table.
    { category: "Function", table: "", object: "order_total(integer)", change: "added", severity: "safe", detail: "Added.", manual: false },
    { category: "Column", table: "customers", object: "email", change: "rename-suggested", severity: "info", detail: "May have been renamed from mail.", manual: true },
  ],
  moreLines: 0,
  history: "2 changes since these were last compared.",
};

/** A comparison of one schema with three others, as the computer describes it. */
const SUMMARY: CompareSummary = {
  source: { connectionId: 7, name: "Production", environment: "prod", schema: "public", error: null },
  targets: [
    STAGING,
    // A target with no saved connection chosen for it.
    { connectionId: null, name: "Target 2", environment: "unset", schema: "public", status: "no-connection", error: "Choose a connection.", changes: 0, breaking: 0, manual: 0, lines: [], moreLines: 0, history: null },
    { connectionId: 9, name: "Dev", environment: "dev", schema: "public", status: "unreachable", error: "Could not reach that database from the computer.", changes: 0, breaking: 0, manual: 0, lines: [], moreLines: 0, history: null },
  ],
};

/** A successful answer to each request, as the computer sends it. */
const RESULTS: { [M in Method]: Results[M] } = {
  hello: { signedIn: true, role: "Viewer", canCompare: false, canReadSchemas: true, appVersion: "1.0.0" },
  "connections.list": {
    connections: [
      { id: 7, name: "Production", environment: "prod", database: "shop" },
      { id: 8, name: "Staging", environment: "staging", database: "shop" },
    ],
  },
  "schemas.list": { schemas: ["public", "archive"] },
  "schema.read": OVERVIEW,
  "compare.run": SUMMARY,
  "push.status": { key: PUSH_KEY, subscribed: false },
  "push.subscribe": { key: PUSH_KEY, subscribed: true },
  "push.unsubscribe": { key: PUSH_KEY, subscribed: false },
};

/** OVERVIEW with its table changed. */
function overviewWith(table: object): unknown {
  return { ...OVERVIEW, tables: [{ ...ORDERS, ...table }] };
}

/** SUMMARY with its first target changed. */
function summaryWith(target: object): unknown {
  return { ...SUMMARY, targets: [{ ...STAGING, ...target }] };
}

test("writes each request and reads it back the same", () => {
  for (const request of REQUESTS) {
    assert.deepEqual(readRequest(writeRequest(request)), { ok: true, request }, request.method);
  }
});

test("writes only a request's own fields", () => {
  // A schema as the phone app holds it, with its connection's name to show beside it.
  const shown = { connectionId: 7, schema: "public", name: "Production" };
  assert.deepEqual(json(writeRequest({ id: 1, method: "schema.read", params: shown })), { id: 1, method: "schema.read", params: REF });
  const compare = json(writeRequest({ id: 2, method: "compare.run", params: { source: shown, targets: [shown, shown] } }));
  assert.deepEqual(compare, { id: 2, method: "compare.run", params: { source: REF, targets: [REF, REF] } });
  // A subscription with more than the computer needs, such as when it ends.
  const fromBrowser = { ...SUBSCRIPTION, expirationTime: null };
  assert.deepEqual(json(writeRequest({ id: 3, method: "push.subscribe", params: fromBrowser })), { id: 3, method: "push.subscribe", params: SUBSCRIPTION });
});

test("cannot answer a message that does not say which request it is", () => {
  const noId = { ok: false, id: null, code: "bad-request" };
  for (const text of [
    "",
    "[]",
    "null",
    "{}",
    '{"method":"hello"}',
    '{"id":0,"method":"hello"}',
    '{"id":-1,"method":"hello"}',
    '{"id":1.5,"method":"hello"}',
    '{"id":"1","method":"hello"}',
    // Too big for JSON to carry exactly.
    `{"id":${2 ** 53},"method":"hello"}`,
  ]) {
    assert.deepEqual(readRequest(utf8(text)), noId, text);
  }
  assert.deepEqual(readRequest(Uint8Array.of(0x7b, 0xff, 0x7d)), noId);
  // The biggest message it reads, and one byte more.
  const biggest = '{"id":1,"method":"hello"}'.padEnd(MAX_REQUEST_BYTES, " ");
  assert.deepEqual(readRequest(utf8(biggest)), { ok: true, request: { id: 1, method: "hello" } });
  assert.deepEqual(readRequest(utf8(`${biggest} `)), noId);
});

test("refuses a request that is not exactly one it knows, and says which one it refused", () => {
  const named = { ...REF, name: "Production" };
  const tooMany = Array.from({ length: MAX_COMPARE_TARGETS + 1 }, () => REF);
  for (const value of [
    { id: 5 },
    { id: 5, method: 7 },
    { id: 5, method: null },
    { id: 5, method: "hello", params: {} },
    { id: 5, method: "hello", x: 1 },
    { id: 5, method: "connections.list", params: null },
    { id: 5, method: "schemas.list" },
    { id: 5, method: "schemas.list", params: {} },
    { id: 5, method: "schemas.list", params: [] },
    { id: 5, method: "schemas.list", params: { connectionId: 0 } },
    { id: 5, method: "schemas.list", params: { connectionId: "7" } },
    { id: 5, method: "schemas.list", params: REF },
    { id: 5, method: "schemas.list", params: { connectionId: 7 }, x: 1 },
    { id: 5, method: "schema.read", params: { connectionId: 7 } },
    { id: 5, method: "schema.read", params: { connectionId: 7, schema: "" } },
    { id: 5, method: "schema.read", params: { connectionId: 7, schema: "a".repeat(MAX_SCHEMA_NAME_LENGTH + 1) } },
    // The app would trim these and read a different schema.
    { id: 5, method: "schema.read", params: { connectionId: 7, schema: " public" } },
    { id: 5, method: "schema.read", params: { connectionId: 7, schema: "public " } },
    { id: 5, method: "schema.read", params: named },
    { id: 5, method: "compare.run", params: { source: REF } },
    { id: 5, method: "compare.run", params: { source: REF, targets: [] } },
    { id: 5, method: "compare.run", params: { source: REF, targets: tooMany } },
    { id: 5, method: "compare.run", params: { source: REF, targets: REF } },
    { id: 5, method: "compare.run", params: { source: REF, targets: [null] } },
    { id: 5, method: "compare.run", params: { source: null, targets: [REF] } },
    { id: 5, method: "compare.run", params: { source: REF, targets: [REF], x: 1 } },
    { id: 5, method: "compare.run", params: { source: named, targets: [REF] } },
    { id: 5, method: "compare.run", params: { source: REF, targets: [REF, named] } },
    { id: 5, method: "compare.run", params: { source: { connectionId: 7, schema: "public\n" }, targets: [REF] } },
    { id: 5, method: "compare.run", params: { source: REF, targets: [REF, { connectionId: 8, schema: "\tpublic" }] } },
    { id: 5, method: "push.status", params: {} },
    { id: 5, method: "push.unsubscribe", x: 1 },
    { id: 5, method: "push.subscribe" },
    { id: 5, method: "push.subscribe", params: { endpoint: SUBSCRIPTION.endpoint, p256dh: SUBSCRIPTION.p256dh } },
    { id: 5, method: "push.subscribe", params: { ...SUBSCRIPTION, expirationTime: null } },
    { id: 5, method: "push.subscribe", params: { ...SUBSCRIPTION, auth: "" } },
    { id: 5, method: "push.subscribe", params: { ...SUBSCRIPTION, p256dh: null } },
    { id: 5, method: "push.subscribe", params: { ...SUBSCRIPTION, endpoint: "a".repeat(MAX_PUSH_FIELD_LENGTH + 1) } },
    // How a browser writes a whole subscription, with the phone's two keys inside another object.
    { id: 5, method: "push.subscribe", params: { endpoint: SUBSCRIPTION.endpoint, expirationTime: null, keys: { p256dh: SUBSCRIPTION.p256dh, auth: SUBSCRIPTION.auth } } },
  ]) {
    assert.deepEqual(readRequest(message(value)), { ok: false, id: 5, code: "bad-request" }, JSON.stringify(value));
  }
});

test("says when a request asks for something this version does not know", () => {
  for (const method of ["deploy.run", "HELLO", "", "toString", "constructor", "__proto__"]) {
    assert.deepEqual(readRequest(message({ id: 9, method })), { ok: false, id: 9, code: "unknown-method" }, JSON.stringify(method));
  }
  assert.deepEqual(readRequest(message({ id: 9, method: "deploy.run", params: REF })), { ok: false, id: 9, code: "unknown-method" });
});

test("reads a comparison with one target or the most it takes, and the longest schema name", () => {
  // The same as the app's own limit (my-app/lib/comparison-set-rules.ts).
  assert.equal(MAX_COMPARE_TARGETS, 6);
  const longest: SchemaRef = { connectionId: 7, schema: "a".repeat(MAX_SCHEMA_NAME_LENGTH) };
  const requests: Request[] = [
    { id: 1, method: "compare.run", params: { source: REF, targets: [longest] } },
    { id: 2, method: "compare.run", params: { source: longest, targets: Array.from({ length: MAX_COMPARE_TARGETS }, () => REF) } },
    { id: 3, method: "schema.read", params: longest },
  ];
  for (const request of requests) {
    assert.deepEqual(readRequest(writeRequest(request)), { ok: true, request }, String(request.id));
  }
});

test("reads a push subscription whose fields are as long as a request takes", () => {
  const longest = "a".repeat(MAX_PUSH_FIELD_LENGTH);
  const request: Request = { id: 1, method: "push.subscribe", params: { endpoint: longest, p256dh: longest, auth: longest } };
  assert.deepEqual(readRequest(writeRequest(request)), { ok: true, request });
});

test("takes a schema name the app reads exactly as it is written", () => {
  for (const name of ["public", "Public", "my schema", "a".repeat(MAX_SCHEMA_NAME_LENGTH)]) {
    assert.equal(isSchemaName(name), true, name);
  }
  const noBreakSpace = String.fromCharCode(0xa0);
  for (const name of ["", " ", " public", "public ", "\tpublic", "public\n", `${noBreakSpace}public`, "a".repeat(MAX_SCHEMA_NAME_LENGTH + 1), 7, null]) {
    assert.equal(isSchemaName(name), false, JSON.stringify(name));
  }
});

test("writes each kind of result and reads it back the same", () => {
  for (const method of METHODS) {
    const answer = readAnswer(writeResult(1, method, RESULTS[method]));
    if (answer?.ok !== true) throw new Error(`Expected the answer to ${method} to be read.`);
    assert.equal(answer.id, 1);
    assert.deepEqual(readResult(method, answer.result), RESULTS[method], method);
  }
  // Nobody signed in, so there is no role.
  const signedOut = { signedIn: false, role: null, canCompare: false, canReadSchemas: false, appVersion: "1.0.0" };
  assert.deepEqual(readResult("hello", signedOut), signedOut);
});

test("writes each error and reads it back", () => {
  const codes: ErrorCode[] = ["signed-out", "forbidden", "not-shared", "not-found", "unreachable", "too-big", "busy", "bad-request", "unknown-method", "failed"];
  for (const code of codes) {
    const error = { code, message: "The computer could not do this." };
    assert.deepEqual(readAnswer(writeError(4, code, error.message)), { id: 4, ok: false, error }, code);
  }
});

test("reads an error code it does not know as a failure, and cuts a long message", () => {
  const newer = message({ id: 4, error: { code: "rate-limited", message: "Try again in a minute." } });
  assert.deepEqual(readAnswer(newer), { id: 4, ok: false, error: { code: "failed", message: "Try again in a minute." } });
  // Cut by character, so that no emoji is cut in half.
  const long = readAnswer(writeError(4, "failed", "\u{1f600}".repeat(600)));
  assert.deepEqual(long, { id: 4, ok: false, error: { code: "failed", message: "\u{1f600}".repeat(500) } });
});

test("refuses anything that is not exactly an answer", () => {
  for (const value of [
    null,
    [],
    {},
    { id: 1 },
    { result: {} },
    { id: 0, result: {} },
    { id: "1", result: {} },
    { id: 1, result: {}, x: 1 },
    { id: 1, result: {}, error: { code: "failed", message: "No." } },
    { id: 1, error: null },
    { id: 1, error: "failed" },
    { id: 1, error: { code: "failed" } },
    { id: 1, error: { code: "failed", message: "No.", detail: "More." } },
    { id: 1, error: { code: 7, message: "No." } },
    { id: 1, error: { code: "failed", message: null } },
  ]) {
    assert.equal(readAnswer(message(value)), null, JSON.stringify(value));
  }
  assert.equal(readAnswer(Uint8Array.of(0x7b, 0xff, 0x7d)), null);
});

test("sends only the fields this file lists, however much more the app's server said", () => {
  // A connection as the app's server describes it, with where its database is.
  const fromServer = { id: 7, name: "Production", environment: "prod" as const, database: "shop", host: "db.internal.example", port: 5432, user: "app" };
  assert.deepEqual(json(writeResult(1, "connections.list", { connections: [fromServer] })), {
    id: 1,
    result: { connections: [{ id: 7, name: "Production", environment: "prod", database: "shop" }] },
  });
  const hello = { ...RESULTS.hello, email: "someone@example.com" };
  assert.deepEqual(json(writeResult(2, "hello", hello)), { id: 2, result: RESULTS.hello });
});

test("will not send a result that is not what the request asks for", () => {
  // An environment the phone app does not know, which only a mistake on the computer could give.
  const connection: SharedConnection = JSON.parse('{"id":7,"name":"Production","environment":"production","database":"shop"}');
  assert.throws(() => writeResult(1, "connections.list", { connections: [connection] }), /does not have the fields/);
});

test("reads a result with fields it does not know, and leaves them out", () => {
  // What a newer computer might add.
  const overview = {
    ...OVERVIEW,
    owner: "app",
    tables: [{ ...ORDERS, comment: "Every order.", columns: ORDERS.columns.map((column, index) => ({ ...column, position: index + 1 })) }],
  };
  assert.deepEqual(readResult("schema.read", overview), OVERVIEW);
  const summary = {
    ...SUMMARY,
    sql: "ALTER TABLE orders ALTER COLUMN note TYPE character varying(80);",
    source: { ...SUMMARY.source, host: "db.internal.example" },
    targets: SUMMARY.targets.map((target) => ({ ...target, lines: target.lines.map((line) => ({ ...line, risk: "high" })) })),
  };
  assert.deepEqual(readResult("compare.run", summary), SUMMARY);
  assert.deepEqual(readResult("push.status", { ...RESULTS["push.status"], since: 1_640_000_000_000 }), RESULTS["push.status"]);
});

test("refuses a result whose fields are the wrong kind", () => {
  const cases: [Method, unknown][] = [
    ["hello", { ...RESULTS.hello, role: 7 }],
    ["hello", { signedIn: true, role: "Viewer", canCompare: true, canReadSchemas: true }],
    ["connections.list", {}],
    ["connections.list", { connections: [{ id: 0, name: "Production", environment: "prod", database: "shop" }] }],
    ["connections.list", { connections: [{ id: 7, name: "Production", environment: "qa", database: "shop" }] }],
    ["schemas.list", { schemas: ["public", 7] }],
    ["schemas.list", null],
    ["schema.read", { database: "shop", schema: "public", tables: [ORDERS] }],
    ["schema.read", overviewWith({ columns: [{ ...NOTE_COLUMN, nullable: "YES" }] })],
    ["schema.read", overviewWith({ primaryKey: "id" })],
    ["schema.read", overviewWith({ foreignKeys: [{ ...CUSTOMER_KEY, referencedTable: 7 }] })],
    ["compare.run", { source: SUMMARY.source }],
    ["compare.run", { ...SUMMARY, source: { ...SUMMARY.source, connectionId: 0 } }],
    ["compare.run", summaryWith({ status: "skipped" })],
    ["compare.run", summaryWith({ changes: -1 })],
    ["compare.run", summaryWith({ breaking: 1.5 })],
    ["compare.run", summaryWith({ history: 7 })],
    ["compare.run", summaryWith({ lines: [{ ...NOTE_LINE, severity: "warning" }] })],
    ["compare.run", summaryWith({ lines: [{ ...NOTE_LINE, change: "moved" }] })],
    ["push.status", { subscribed: true }],
    ["push.status", { key: PUSH_KEY, subscribed: "yes" }],
    ["push.subscribe", { key: PUSH_KEY, subscribed: null }],
    // A key a byte short, and one written with padding.
    ["push.subscribe", { key: toBase64Url(new Uint8Array(64)), subscribed: true }],
    ["push.unsubscribe", { key: `${PUSH_KEY}=`, subscribed: false }],
    ["push.unsubscribe", null],
  ];
  for (const [method, value] of cases) {
    assert.equal(readResult(method, value), null, `${method}: ${JSON.stringify(value)}`);
  }
});
