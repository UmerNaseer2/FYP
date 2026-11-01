/**
 * An end-to-end run of the phone app: two phones pair with a computer through
 * the relay, one by link and one with its camera, then read a schema, watch a
 * database's live status, compare two, set up approvals with a passkey,
 * approve and reject requests, turn drift alerts on and off, and forget the
 * computer. A laptop's browser then pairs by typing a short code, which the
 * computer refuses once and allows once, and shows its screens at that width.
 * The first phone then checks and acknowledges drift under Allow control, and
 * is refused once it is turned off. With a passkey it then cancels a query,
 * starts a deploy and a rollback, asks for approval on production and runs what
 * was approved, and is refused again once Allow control is off.
 *
 * The computer is the desktop app's real phone-link code (desktop/out), with
 * a fake web app server and a fake push service. The relay and the phone app
 * run under wrangler's test harness, and the phone is headless Chrome at a
 * phone's size, with a virtual passkey authenticator, a stand-in for the
 * browser's push service (so nothing reaches a real one), and a fake camera
 * that shows a pairing code for the second phone.
 *
 * It is not part of `npm test`, because it needs Google Chrome and the
 * desktop app's compiled code. To run it, with the desktop app's packages
 * installed (npm ci in desktop/):
 *
 *   cd desktop && npm run build:ts
 *   cd ../relay && npm run e2e:phone
 *
 * Set CHROME to Chrome's path when it is somewhere unusual. A picture of each
 * screen, light and dark, goes to relay/out/phone-e2e.
 *
 * It never prints pairing links, short codes, keys, push addresses or the
 * approver hash.
 */
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

// The repository's folder, from where this file is (relay/scripts).
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const CHROME = findChrome();
if (!CHROME) {
  console.error("Google Chrome was not found. Install it, or set CHROME to where it is.");
  process.exit(1);
}
if (!fs.existsSync(path.join(ROOT, "desktop", "out", "main", "phone-link.js"))) {
  console.error("The desktop app's code is not compiled yet. In desktop/, run npm ci and then npm run build:ts.");
  process.exit(1);
}

// Chrome's profile, the fake camera's video and the computer's log go in a
// folder of their own, which is removed at the end. The screenshots stay.
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "phone-e2e-"));
const PROFILE = path.join(WORK, "chrome");
const VIDEO = path.join(WORK, "qr.y4m");
const LOGS = path.join(WORK, "log");
const SHOTS = path.join(ROOT, "relay", "out", "phone-e2e");

/** Where Google Chrome is: CHROME when it is set, or else the usual places on a Mac and on Linux. */
function findChrome() {
  const places = [
    process.env.CHROME,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ];
  return places.find((place) => place && fs.existsSync(place)) ?? null;
}

process.env.WRANGLER_SEND_METRICS = "false";
const relayRequire = createRequire(path.join(ROOT, "relay", "package.json"));
const desktopRequire = createRequire(path.join(ROOT, "desktop", "package.json"));
const { createTestHarness } = relayRequire("wrangler");
const qrModule = relayRequire("qrcode-generator");
const qrcode = typeof qrModule === "function" ? qrModule : qrModule.default;
const { openPhoneLink } = desktopRequire("./out/main/phone-link.js");
const { codeBoxSenderFor } = desktopRequire("./out/main/code-box-sender.js");
const { initLog } = desktopRequire("./out/main/log.js");
const { approvalFingerprint } = desktopRequire("./out/shared/remote/approval.js");
const { showShortCode } = desktopRequire("./out/shared/remote/short-code.js");
const { decrypt } = desktopRequire("./out/test/push-phone.js");
const { driftNotification } = desktopRequire("./out/core/drift-alerts.js");

// ---------------------------------------------------------------- output

const SECRETS = new Set();
function hide(text) {
  let out = String(text);
  for (const secret of SECRETS) if (typeof secret === "string" && secret.length >= 8) out = out.split(secret).join("<hidden>");
  return out.replace(/#pair=[^\s"'<>)]*/g, "#pair=<hidden>");
}
const say = (line) => console.log(hide(line));
const results = [];
function pass(name) {
  results.push(true);
  say(`PASS ${name}`);
}
function fail(name, why) {
  results.push(false);
  say(`FAIL ${name}: ${why}`);
}
function expect(condition, name, why = "not as expected") {
  if (condition) pass(name);
  else fail(name, why);
  return condition;
}
function same(actual, wanted, name) {
  try {
    assert.deepStrictEqual(actual, wanted);
    pass(name);
  } catch {
    fail(name, `got ${JSON.stringify(actual)}, wanted ${JSON.stringify(wanted)}`);
  }
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(test, ms, label) {
  const end = Date.now() + ms;
  for (;;) {
    let value;
    try {
      value = await test();
    } catch {
      value = undefined;
    }
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${label}`);
    await sleep(100);
  }
}

// ---------------------------------------------------------------- the fake web app server

const CONNECTIONS = [
  { id: 1, name: "Bookshop dev", environment: "dev", database: "bookshop" },
  { id: 2, name: "Bookshop production", environment: "prod", database: "bookshop" },
  { id: 3, name: "Bookshop staging", environment: "staging", database: "bookshop" },
];
const ME = { role: "admin", roleLabel: "Admin", permissions: ["dashboard:read", "compare:read", "visualizer:read", "drift:read", "deploy:read", "performance:read"] };
const approver = crypto.randomBytes(32).toString("hex");
SECRETS.add(approver);
const hoursAgo = (hours) => new Date(Date.now() - hours * 3600_000).toISOString();
const DEPLOY_SCRIPTS = [
  { name: "add_orders", version: "2", sql: "CREATE TABLE orders (id integer PRIMARY KEY);" },
  { name: "add_order_total", version: "3", sql: "ALTER TABLE orders ADD COLUMN total numeric;" },
];
const ROLLBACK_SCRIPTS = [{ name: "add_order_total", version: "3", sql: "ALTER TABLE orders DROP COLUMN total;" }];

// What a phone can start. Its SQL reaches a phone to be read, and never a log.
const QUERY_BEGAN = "2026-11-01T10:00:00.000Z";
const RUN_SQL = "CREATE TABLE phone_run_audit (id integer PRIMARY KEY);";
const UNDO_SQL = "DROP TABLE phone_run_audit;";
SECRETS.add(RUN_SQL);
SECRETS.add(UNDO_SQL);
const FAMILIES = [
  { schemaName: "public", scriptName: "orders_migration", newestVersion: "3.0.0", versionCount: 3 },
  { schemaName: "public", scriptName: "reports_migration", newestVersion: "3.0.0", versionCount: 3 },
  { schemaName: "public", scriptName: "mismatch_migration", newestVersion: "3.0.0", versionCount: 3 },
];

/** One run's plan, as my-app/app/api/deploy/phone/route.ts answers. Connection 2 is production, where reports_migration has been approved. */
async function deployPlan({ connectionId, schemaName, scriptName, action, targetVersion }) {
  const production = connectionId === 2;
  const next = !production ? "run" : scriptName === "reports_migration" ? "run-approved" : "ask-approval";
  const scripts = [{ scriptName, version: targetVersion, sqlContent: action === "deploy" ? RUN_SQL : UNDO_SQL }];
  const hashed = scripts.map(({ scriptName: name, version, sqlContent: sql }) => ({ name, version, sql }));
  return {
    action,
    connectionId,
    schemaName,
    scriptName,
    targetVersion,
    environment: production ? "prod" : "dev",
    partial: false,
    fingerprint: scriptName === "mismatch_migration" ? "0".repeat(64) : await approvalFingerprint(hashed, action),
    scripts,
    risks: {
      production,
      breaking: [],
      dataLoss: !production && action === "deploy" ? [`${scriptName} v${targetVersion}`] : [],
      otherScripts: !production && action === "revert" ? ["users_migration v2.0.0"] : [],
      drift: null,
    },
    next,
    blockedReason: null,
    run: next === "ask-approval" ? null : { path: action === "deploy" ? "/api/scripts/apply" : "/api/scripts/revert", body: { connectionId, schemaName, scriptName, targetVersion } },
    approvalRequest: next === "ask-approval" ? { connectionId, schemaName, scriptName, action, targetVersion } : null,
  };
}

// A word that may show on a phone only once query text is turned on for the connection.
const LIVE_SQL_WORD = "customer_card_number";
const LIVE_SQL = `SELECT c.id, c.${LIVE_SQL_WORD}, o.total FROM customers c JOIN orders o ON o.customer_id = c.id WHERE o.status = 'open' AND c.created_at > now() - interval '30 days' ORDER BY o.total DESC`;
// What the window sees but a phone never should.
const LIVE_PRIVATE = ["db.internal.example.test", "bookshop_app_user", "10.20.30.40", "PostgreSQL said something private"];
const TRACKED = [
  { id: 11, connectionId: 1, schemaName: "public", label: null, environment: "dev", connectionHost: LIVE_PRIVATE[0], headVersion: "3", driftStatus: "drifted", driftSummary: LIVE_PRIVATE[3], driftCheckedAt: hoursAgo(2), lastCheckedAt: hoursAgo(0.2), driftAcknowledgedAt: null },
  { id: 12, connectionId: 1, schemaName: "sales", label: null, environment: "dev", connectionHost: LIVE_PRIVATE[0], headVersion: "7", driftStatus: "in_sync", driftSummary: null, driftCheckedAt: hoursAgo(26), lastCheckedAt: hoursAgo(26), driftAcknowledgedAt: null },
  { id: 13, connectionId: 2, schemaName: "public", label: null, environment: "prod", connectionHost: LIVE_PRIVATE[0], headVersion: null, driftStatus: null, driftSummary: null, driftCheckedAt: null, lastCheckedAt: null, driftAcknowledgedAt: null },
];
const liveSession = (fields) => ({ queryStart: QUERY_BEGAN, querySeconds: null, xactSeconds: null, username: LIVE_PRIVATE[1], applicationName: "bookshop-web", clientAddr: LIVE_PRIVATE[2], state: "active", waitingOn: null, query: LIVE_SQL, queryHidden: false, ...fields });
const activity = () => ({
  connectionName: "Bookshop dev",
  database: "bookshop",
  takenAt: new Date().toISOString(),
  longRunningSeconds: 60,
  thresholdConfigured: true,
  sessions: [
    liveSession({ pid: 4101, kind: "blocked", querySeconds: 42.5, xactSeconds: 310, waitingOn: "Lock: transactionid" }),
    liveSession({ pid: 4102, kind: "idle-in-transaction", querySeconds: 185, xactSeconds: 190, applicationName: "psql", query: "BEGIN" }),
    liveSession({ pid: 4103, kind: "long-running", querySeconds: 7600, xactSeconds: 7600, applicationName: null }),
    liveSession({ pid: 4104, kind: "running", querySeconds: 0.4, xactSeconds: 0.4 }),
  ],
  summary: { total: 4, blocked: 1, idleInTransaction: 1, longRunning: 1, anyHidden: false },
  health: {
    database: "bookshop",
    since: hoursAgo(72),
    metrics: [
      { key: "cache_hit_ratio", label: "Cache hit ratio", display: "99.2%", value: 99.2, level: "good", note: "How often PostgreSQL found what it needed in memory." },
      { key: "connections", label: "Connections", display: "88 of 100", value: 88, level: "watch", note: "How close this server is to refusing new connections." },
      { key: "deadlocks", label: "Deadlocks", display: "12", value: 12, level: "bad", note: "Transactions PostgreSQL had to stop because they were waiting on each other." },
      { key: "temp_files", label: "Temp files", display: null, value: null, level: "unknown", note: "This role can't read the figure." },
    ],
  },
  breaches: [],
  emptyMessage: "",
  hiddenNote: null,
});

async function request(id, fields, scripts, hashed = scripts) {
  const fingerprint = await approvalFingerprint(hashed, fields.action);
  const summary = {
    id,
    connectionId: 2,
    schemaName: "public",
    scriptName: "orders",
    targetVersion: "3",
    migrationCount: 2,
    breakingCount: 0,
    requestedBy: "sam@example.com",
    requestedAt: hoursAgo(2),
    note: null,
    fingerprint,
    sql: scripts === null ? "missing" : "kept",
    ownRequest: false,
    ...fields,
  };
  return { summary, scripts };
}
const queue = new Map();
for (const item of [
  await request(7, { action: "deploy", note: "Adds orders for the checkout work." }, DEPLOY_SCRIPTS),
  await request(8, { action: "revert", connectionId: 1, targetVersion: "3", migrationCount: 1, breakingCount: 1, requestedBy: "kai@example.com", requestedAt: hoursAgo(26) }, ROLLBACK_SCRIPTS),
  await request(9, { action: "deploy", targetVersion: "4", migrationCount: 1, requestedBy: "lee@example.com" }, null, DEPLOY_SCRIPTS),
  await request(10, { action: "deploy", connectionId: 3, requestedBy: "ana@example.com" }, DEPLOY_SCRIPTS),
]) {
  queue.set(item.summary.id, item);
}
const decided = [];
const served = [];

function snapshotOf(schema) {
  const column = (name, typeDisplay, nullable = false, columnDefault = null) => ({ name, typeDisplay, nullable, columnDefault });
  return {
    database: "bookshop",
    schema,
    tables: [
      { name: "authors", columns: [column("id", "integer"), column("name", "text")], primaryKey: { columns: ["id"] }, foreignKeys: [] },
      {
        name: "books",
        columns: [column("id", "integer"), column("title", "text"), column("author_id", "integer", true), column("price", "numeric(10,2)", true, "0")],
        primaryKey: { columns: ["id"] },
        foreignKeys: [{ columns: ["author_id"], referencedSchema: schema, referencedTable: "authors", referencedColumns: ["id"] }],
      },
    ],
    views: [{ name: "book_titles", materialized: false }],
  };
}

function compareSummary(body) {
  const side = (ref) => {
    const connection = CONNECTIONS.find((row) => row.id === ref.connectionId);
    return { connectionId: connection.id, name: connection.name, environment: connection.environment, schema: ref.schema };
  };
  return {
    source: { ...side(body.source), error: null },
    targets: body.targets.map((ref) => ({
      ...side(ref),
      status: "compared",
      error: null,
      changes: 3,
      breaking: 1,
      manual: 1,
      lines: [
        { category: "Column", table: "books", object: "price", change: "dropped", severity: "breaking", detail: "The target has no column price.", manual: false },
        { category: "Table", table: "orders", object: "orders", change: "added", severity: "safe", detail: "Only the target has this table.", manual: false },
        { category: "Index", table: "books", object: "books_title_idx", change: "changed", severity: "info", detail: "The index is defined differently.", manual: true },
      ],
      moreLines: 0,
      history: "One more change than the last time these were compared.",
    })),
  };
}

async function call(method, target, body) {
  const url = new URL(target, "http://app.invalid");
  const route = `${method} ${url.pathname}`;
  served.push({ route, search: url.search, body });
  const answer = (status, json) => ({ status, json });
  switch (route) {
    case "GET /api/me":
      return answer(200, ME);
    case "GET /api/connections/phone":
      return answer(200, { connections: CONNECTIONS });
    case "GET /api/lineage":
      return answer(200, TRACKED);
    case "GET /api/performance/activity":
      return answer(200, activity());
    case "POST /api/lineage/drift": {
      const row = TRACKED.find((tracked) => tracked.id === body?.trackedSchemaId);
      if (row === undefined) return answer(404, { error: "Not found" });
      row.lastCheckedAt = row.driftCheckedAt = new Date().toISOString();
      return answer(200, { recorded: false, status: row.driftStatus, summary: LIVE_PRIVATE[3] });
    }
    case "POST /api/lineage/acknowledge": {
      const row = TRACKED.find((tracked) => tracked.id === body?.trackedSchemaId);
      if (row === undefined) return answer(404, { error: "Not found" });
      row.driftAcknowledgedAt = new Date().toISOString();
      return answer(200, { success: true, trackedSchemaId: row.id, status: row.driftStatus, acknowledgedAt: row.driftAcknowledgedAt });
    }
    case "GET /api/lineage/schemas":
      return answer(200, { schemas: ["public", "sales"] });
    case "GET /api/schema/snapshot":
      return answer(200, { snapshot: snapshotOf(url.searchParams.get("schema")) });
    case "POST /api/compare/phone":
      return answer(200, compareSummary(body));
    case "GET /api/deploy/approvals/phone":
      return answer(200, { approver, canApprove: true, approvals: [...queue.values()].map((item) => item.summary) });
    case "GET /api/me/approver":
      return answer(200, { approver, canApprove: true, canControl: true });
    case "GET /api/deploy/phone":
      return answer(200, { registry: "ok", partial: false, families: FAMILIES });
    case "POST /api/deploy/phone":
      return answer(200, body.action === undefined ? { currentVersion: "2.0.0", waiting: ["3.0.0"], undo: [{ target: "1.0.0", undoCount: 1 }], partial: false } : await deployPlan(body));
    case "POST /api/scripts/apply":
    case "POST /api/scripts/revert":
      return answer(200, { success: true });
    case "POST /api/deploy/approvals":
      return answer(200, { approval: { id: 20 } });
    case "POST /api/performance/cancel":
      return answer(200, { status: "cancelled" });
  }
  const read = /^\/api\/deploy\/approvals\/([0-9]+)\/phone$/.exec(url.pathname);
  if (method === "GET" && read !== null) {
    const item = queue.get(Number(read[1]));
    if (item === undefined) return answer(404, { error: "Not found" });
    return answer(200, { scripts: item.scripts === null ? null : item.scripts.map((s) => ({ scriptName: s.name, version: s.version, sqlContent: s.sql })) });
  }
  const decide = /^\/api\/deploy\/approvals\/([0-9]+)$/.exec(url.pathname);
  if (method === "POST" && decide !== null) {
    const item = queue.get(Number(decide[1]));
    if (item === undefined) return answer(404, { error: "Not found" });
    const keys = Object.keys(body ?? {}).sort().join(",");
    const good =
      keys === "decision,expectedApprover,expectedFingerprint" &&
      (body.decision === "approve" || body.decision === "reject") &&
      body.expectedFingerprint === item.summary.fingerprint &&
      body.expectedApprover === approver;
    if (!good) return answer(400, { error: "Bad request" });
    queue.delete(item.summary.id);
    decided.push({ id: item.summary.id, decision: body.decision });
    return answer(200, { approval: { id: item.summary.id, status: body.decision === "approve" ? "approved" : "rejected" } });
  }
  return answer(404, { error: "Not found" });
}

// ---------------------------------------------------------------- the fake push service

const pushes = [];
async function pushTransport(pushRequest) {
  pushes.push(pushRequest);
  return { status: 201, retryAfter: null };
}

// ---------------------------------------------------------------- the fake camera

/** Writes the fake camera's video: a pairing code in the middle of a white frame, or a blank frame for null. */
function writeVideo(text) {
  const W = 640;
  const H = 480;
  const luma = Buffer.alloc(W * H, 255);
  if (text !== null) {
    const qr = qrcode(0, "M");
    qr.addData(text);
    qr.make();
    const count = qr.getModuleCount();
    const size = Math.floor(440 / (count + 8));
    const left = Math.floor((W - size * count) / 2);
    const top = Math.floor((H - size * count) / 2);
    for (let row = 0; row < count; row++) {
      for (let col = 0; col < count; col++) {
        if (!qr.isDark(row, col)) continue;
        for (let dy = 0; dy < size; dy++) {
          const start = (top + row * size + dy) * W + left + col * size;
          luma.fill(0, start, start + size);
        }
      }
    }
  }
  const chroma = Buffer.alloc((W / 2) * (H / 2), 128);
  const frame = Buffer.concat([Buffer.from("FRAME\n"), luma, chroma, chroma]);
  fs.writeFileSync(VIDEO, Buffer.concat([Buffer.from(`YUV4MPEG2 W${W} H${H} F30:1 Ip A1:1 C420jpeg\n`), frame, frame, frame, frame, frame]));
}

// ---------------------------------------------------------------- Chrome

/** Runs in the phone app's pages before their own scripts: a stand-in for the browser's push service, which keeps a real key pair in localStorage. */
function pushStub() {
  if (typeof PushManager === "undefined") return;
  const KEY = "e2e-push";
  const toText = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const fromText = (text) => Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
  const wrap = (saved) => ({
    endpoint: saved.endpoint,
    expirationTime: null,
    options: { userVisibleOnly: true, applicationServerKey: fromText(saved.serverKey).buffer },
    getKey: (name) => (name === "p256dh" ? fromText(saved.p256dh).buffer : name === "auth" ? fromText(saved.auth).buffer : null),
    unsubscribe: async () => {
      localStorage.removeItem(KEY);
      return true;
    },
    toJSON: () => ({ endpoint: saved.endpoint, expirationTime: null, keys: { p256dh: saved.p256dh, auth: saved.auth } }),
  });
  PushManager.prototype.getSubscription = async function () {
    const text = localStorage.getItem(KEY);
    return text === null ? null : wrap(JSON.parse(text));
  };
  PushManager.prototype.subscribe = async function (options) {
    const key = options.applicationServerKey;
    const serverKey = typeof key === "string" ? fromText(key) : key instanceof ArrayBuffer ? new Uint8Array(key) : new Uint8Array(key.buffer, key.byteOffset, key.byteLength);
    const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
    const saved = {
      endpoint: `https://fcm.googleapis.com/fcm/send/e2e-${crypto.randomUUID()}`,
      p256dh: toText(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey))),
      auth: toText(crypto.getRandomValues(new Uint8Array(16))),
      d: (await crypto.subtle.exportKey("jwk", pair.privateKey)).d,
      serverKey: toText(serverKey),
    };
    localStorage.setItem(KEY, JSON.stringify(saved));
    return wrap(saved);
  };
}

class Cdp {
  constructor(socket) {
    this.socket = socket;
    this.next = 0;
    this.pending = new Map();
    this.listeners = [];
    socket.addEventListener("message", (event) => this.receive(JSON.parse(event.data)));
  }
  receive(message) {
    if (message.id !== undefined) {
      const waiting = this.pending.get(message.id);
      if (waiting === undefined) return;
      this.pending.delete(message.id);
      if (message.error) waiting.reject(new Error(`${waiting.method}: ${message.error.message}`));
      else waiting.resolve(message.result);
      return;
    }
    for (const listener of this.listeners) listener(message);
  }
  send(method, params = {}, sessionId = undefined) {
    const id = ++this.next;
    this.socket.send(JSON.stringify(sessionId === undefined ? { id, method, params } : { id, method, params, sessionId }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject, method }));
  }
}

const pages = new Map();
class Page {
  constructor(cdp, sessionId, label) {
    this.cdp = cdp;
    this.sessionId = sessionId;
    this.label = label;
    this.problems = [];
    this.console = [];
    this.registrations = new Map();
    this.shots = 0;
  }
  send(method, params = {}) {
    return this.cdp.send(method, params, this.sessionId);
  }
  event({ method, params }) {
    if (method === "Runtime.exceptionThrown") {
      this.problems.push(`uncaught: ${params.exceptionDetails.exception?.description ?? params.exceptionDetails.text}`);
    } else if (method === "Runtime.consoleAPICalled") {
      const text = params.args.map((arg) => arg.value ?? arg.description ?? "").join(" ");
      this.console.push(text);
      if (params.type === "error" || params.type === "warning" || params.type === "assert") this.problems.push(`console.${params.type}: ${text}`);
    } else if (method === "Log.entryAdded") {
      this.console.push(params.entry.text);
      if (params.entry.level === "error" || params.entry.level === "warning") this.problems.push(`${params.entry.source} ${params.entry.level}: ${params.entry.text}`);
    } else if (method === "ServiceWorker.workerRegistrationUpdated") {
      for (const registration of params.registrations) this.registrations.set(registration.registrationId, registration);
    }
  }
  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  }
  async waitFor(expression, label, ms = 15000) {
    try {
      return await until(() => this.evaluate(expression), ms, label);
    } catch (error) {
      await this.shot(`timeout`).catch(() => {});
      const text = await this.evaluate("document.body ? document.body.innerText.slice(0, 600) : ''").catch(() => "");
      throw new Error(`${error.message}. The page said: ${JSON.stringify(text)}`);
    }
  }
  /** Waits until the page has not changed for 300 ms (at most 3 s), so a tap lands where the button ends up. */
  async settle() {
    await this.evaluate(`new Promise((resolve) => {
      const end = Date.now() + 3000;
      let timer = setTimeout(done, 300);
      const observer = new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(done, Date.now() > end ? 0 : 300); });
      function done() { observer.disconnect(); resolve(true); }
      observer.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
    })`);
  }
  async tap(selector, text = null) {
    await this.settle();
    const find = text === null ? "all[0]" : `all.find((node) => node.textContent.includes(${JSON.stringify(text)}))`;
    const box = await this.evaluate(`(() => {
      const all = [...document.querySelectorAll(${JSON.stringify(selector)})];
      const el = ${find};
      if (!el) return { missing: true };
      el.scrollIntoView({ block: "center", behavior: "instant" });
      const r = el.getBoundingClientRect();
      const x = r.left + r.width / 2, y = r.top + r.height / 2;
      const hit = document.elementFromPoint(x, y);
      return { x, y, disabled: el.disabled === true, covered: !(hit && (hit === el || el.contains(hit))) };
    })()`);
    const name = text === null ? selector : `${selector} "${text}"`;
    if (box.missing) throw new Error(`nothing on the page matches ${name}`);
    if (box.disabled) throw new Error(`${name} is turned off`);
    if (box.covered) throw new Error(`${name} is covered by something else`);
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x, y: box.y });
    await this.send("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button: "left", clickCount: 1 });
    await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x, y: box.y, button: "left", clickCount: 1 });
  }
  async type(selector, text) {
    await this.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); el.focus(); el.select(); })()`);
    await this.send("Input.insertText", { text });
  }
  async shot(name) {
    const { data } = await this.send("Page.captureScreenshot", { format: "png" });
    this.shots += 1;
    fs.writeFileSync(path.join(SHOTS, `${this.label}-${String(this.shots).padStart(2, "0")}-${name}.png`), Buffer.from(data, "base64"));
  }
  text() {
    return this.evaluate("document.body.innerText");
  }
}

const EXPECTED = /pubKeyCredParams is missing at least one of the default algorithm identifiers/;
const unexpected = (page) => {
  const problems = page.problems.filter((text) => !/favicon/i.test(text));
  if (problems.some((text) => EXPECTED.test(text))) note(`phone ${page.label}: Chrome advised offering RS256 passkeys too, which is expected (the computer checks ES256 only)`);
  return problems.filter((text) => !EXPECTED.test(text));
};
const note = (line) => say(`NOTE ${line}`);
const has = (selector) => `document.querySelector(${JSON.stringify(selector)}) !== null`;
const lacks = (selector) => `document.querySelector(${JSON.stringify(selector)}) === null`;
const hasText = (text) => `document.body !== null && document.body.innerText.includes(${JSON.stringify(text)})`;

// ---------------------------------------------------------------- the run

const started = Date.now();
let chrome = null;
let harness = null;
let link = null;

async function cleanUp() {
  try {
    link?.stop();
  } catch {}
  try {
    if (chrome && chrome.exitCode === null) {
      const exited = new Promise((resolve) => chrome.once("exit", resolve));
      chrome.kill("SIGTERM");
      // Chrome writes to its profile as it closes, so wait for it before
      // removing the folder, but not for ever.
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5000))]);
    }
  } catch {}
  try {
    await harness?.close();
  } catch {}
  fs.rmSync(WORK, { recursive: true, force: true, maxRetries: 5 });
}

const watchdog = setTimeout(async () => {
  fail("the whole run", "took longer than 6 minutes");
  await cleanUp();
  process.exit(1);
}, 360_000);

try {
  fs.rmSync(SHOTS, { recursive: true, force: true });
  fs.mkdirSync(SHOTS, { recursive: true });
  fs.mkdirSync(LOGS, { recursive: true });
  writeVideo(null);

  // The relay and the phone app.
  harness = createTestHarness({ root: path.join(ROOT, "relay"), workers: [{ configPath: "wrangler.jsonc" }] });
  const listening = new URL(String((await harness.listen()).url));
  const origin = `http://localhost:${listening.port}`;
  const home = await fetch(`${origin}/`);
  expect(home.status === 200 && (await home.text()).includes("<title>"), "the relay serves the phone app's page");

  // The computer.
  initLog(LOGS, { echo: false });
  const paired = [];
  const store = {
    state: null,
    load() {
      return this.state === null ? { status: "missing" } : { status: "values", values: this.state, protection: "plain", upgrade: false };
    },
    save(state) {
      this.state = state;
      return "plain";
    },
  };
  // Who the computer asked about for a typed code, and its answer: No until a test wants to hold it or say Yes.
  const asked = [];
  let answerAsked = async () => false;
  const opened = await openPhoneLink({
    store,
    fileLabel: "~/.config/schema-studio/phone-link.json",
    call,
    appVersion: "0.0.0-e2e",
    computerName: "Test computer",
    pushTransport,
    sendCodeBox: codeBoxSenderFor((url, init) => fetch(url, init)),
    askToPair: (name) => {
      asked.push(name);
      return answerAsked();
    },
    onPaired: (phone) => paired.push(phone.name),
  });
  if (!opened.ok) throw new Error(`the phone link did not open: ${opened.reason}`);
  link = opened.link;
  expect(link.setRelayOrigin(origin), "the computer takes the local relay's address");
  link.setEnabled(true);
  link.setSharedConnections([1, 2]);
  link.start();
  await until(() => link.status().state === "connected", 20000, "the computer to connect to the relay");
  pass("the computer connects to the relay");

  // Chrome.
  chrome = spawn(
    CHROME,
    [
      "--headless=new",
      "--remote-debugging-port=0",
      `--user-data-dir=${PROFILE}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-sync",
      "--disable-extensions",
      "--disable-background-networking",
      "--disable-component-update",
      "--mute-audio",
      "--use-fake-device-for-media-stream",
      `--use-file-for-fake-video-capture=${VIDEO}`,
      "--use-fake-ui-for-media-stream",
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  const portFile = path.join(PROFILE, "DevToolsActivePort");
  const [port, browserPath] = await until(() => {
    const lines = fs.existsSync(portFile) ? fs.readFileSync(portFile, "utf8").trim().split("\n") : [];
    return lines.length >= 2 ? lines : null;
  }, 20000, "Chrome to start");
  const socket = new WebSocket(`ws://127.0.0.1:${port}${browserPath}`);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", () => reject(new Error("could not reach Chrome's DevTools")), { once: true });
  });
  const cdp = new Cdp(socket);
  cdp.listeners.push((message) => pages.get(message.sessionId)?.event(message));

  async function openPage(label, browserContextId) {
    const { targetId } = await cdp.send("Target.createTarget", browserContextId === undefined ? { url: "about:blank" } : { url: "about:blank", browserContextId });
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
    const page = new Page(cdp, sessionId, label);
    pages.set(sessionId, page);
    await page.send("Page.enable");
    await page.send("Runtime.enable");
    await page.send("Log.enable");
    await page.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await page.send("Emulation.setFocusEmulationEnabled", { enabled: true });
    // Headless Chrome follows the computer's own appearance, so pin the light
    // theme here; the dark shots switch to dark on purpose later.
    await page.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
    await page.send("Page.addScriptToEvaluateOnNewDocument", { source: `(${pushStub.toString()})();` });
    return page;
  }

  // ------------------------------------------------------------ phase A: a phone pairs from the link

  const A = await openPage("a");
  try {
    await cdp.send("Browser.grantPermissions", { origin, permissions: ["notifications"] });
    await A.send("WebAuthn.enable", { enableUI: false });
    const { authenticatorId } = await A.send("WebAuthn.addVirtualAuthenticator", {
      options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
    });

    const first = link.newPairingLink();
    if (first === null) throw new Error("the computer gave no pairing link");
    SECRETS.add(first.link);
    expect(first.link.startsWith(`${origin}/`) && first.link.includes("#pair="), "the pairing link opens the phone app on the relay");
    await A.send("Page.navigate", { url: first.link });
    await A.waitFor(has("#phone-name"), "the pairing screen");
    expect(!(await A.evaluate("location.href")).includes("pair="), "the phone app takes the pairing code out of its address at once");
    await A.shot("pairing");
    await A.type("#phone-name", "Test phone");
    await A.tap("#pair");
    await A.waitFor(has("#connection-1"), "the home screen after pairing", 25000);
    same(paired, ["Test phone"], "the computer saves the phone under the name it was given");
    const homeText = await A.text();
    expect(homeText.includes("Test computer"), "the home screen names the computer");
    expect((await A.evaluate(has("#connection-2"))) && (await A.evaluate(lacks("#connection-3"))), "the home screen lists the shared connections and not the other one");
    await A.shot("home");

    // A schema.
    await A.tap("#connection-1");
    await A.waitFor(`${has("#schema-public")} && ${has("#schema-sales")}`, "the connection's schemas");
    await A.shot("connection");

    // Live status.
    const asksForLive = () => served.filter(({ route }) => route === "GET /api/performance/activity").length;
    await A.tap("#live-status");
    await A.waitFor(has("#live-updated"), "the live status screen");
    const liveText = await A.text();
    expect(liveText.includes("Waiting for a lock") && liveText.includes("Idle in a transaction") && liveText.includes("Drifted") && liveText.includes("Cache hit ratio"), "the live status screen shows sessions, health and drift");
    expect(liveText.includes("The SQL is hidden") && !liveText.includes(LIVE_SQL_WORD) && (await A.evaluate(lacks(".session-sql"))), "a session's SQL stays hidden until it is turned on");
    same(LIVE_PRIVATE.filter((word) => liveText.includes(word)), [], "the live status screen shows no address, user name or server words");
    await A.shot("live");
    await A.evaluate("document.querySelector('.live-row')?.scrollIntoView({ block: 'center' })");
    await A.shot("live-health");
    await A.evaluate("window.scrollTo(0, 0)");
    const liveAsked = asksForLive();
    await until(() => asksForLive() > liveAsked, 12000, "the live status screen to ask again");
    pass("the live status screen refreshes by itself while it is open");
    link.setQueryTextConnections([1]);
    await A.waitFor(has(".session-sql"), "the SQL to reach the phone", 12000);
    await A.tap("details.session-sql > summary");
    await A.waitFor(hasText(LIVE_SQL_WORD), "the opened SQL");
    await A.shot("live-sql");
    const liveShown = asksForLive();
    await until(() => asksForLive() > liveShown, 12000, "the live status screen to ask again");
    await A.settle();
    expect(await A.evaluate(`document.querySelector("details.session-sql").open`), "an opened session's SQL stays open through a refresh");
    link.setQueryTextConnections([]);
    await A.waitFor(lacks(".session-sql"), "the SQL to leave the phone once it is turned off", 12000);
    pass("turning query text off takes the SQL away from the phone");
    link.setEnabled(false);
    await A.waitFor(hasText("Computer offline"), "the phone to say the computer has gone", 20000);
    const awayText = await A.text();
    expect(awayText.includes("Waiting for a lock") && awayText.includes("These numbers are old"), "with the computer away, the live screen keeps the last numbers and says they are old");
    await A.shot("live-offline");
    link.setEnabled(true);
    await until(() => link.status().state === "connected", 20000, "the computer to connect again");
    await A.waitFor(hasText("Refreshes every 5 seconds"), "the live screen to come back with the computer", 40000);
    pass("the live status screen comes back by itself with the computer");
    await A.tap("#back");
    await A.waitFor(has("#schema-public"), "the connection screen");
    await A.tap("#schema-public");
    await A.waitFor(has('[data-name="books"]'), "the schema's tables");
    const names = await A.evaluate(`[...document.querySelectorAll("[data-name]")].map((node) => node.dataset.name)`);
    expect(names.includes("authors") && names.includes("books"), "the schema screen lists its tables", JSON.stringify(names));
    expect((await A.text()).includes("book_titles"), "the schema screen lists its view");
    await A.tap('details[data-name="books"] > summary');
    await A.waitFor(hasText("author_id"), "the books table's columns");
    expect((await A.text()).includes("authors"), "an open table shows where its foreign key points");
    await A.shot("schema");
    await A.type("#filter", "titles");
    await sleep(300);
    const visible = await A.evaluate(`[...document.querySelectorAll("[data-name]")].filter((node) => node.offsetParent !== null).map((node) => node.dataset.name)`);
    expect(!visible.includes("authors") && !visible.includes("books"), "the filter hides the tables that do not match", JSON.stringify(visible));
    expect((await A.text()).includes("book_titles"), "the filter keeps the view that matches");
    await A.shot("filter");
    await A.evaluate(`(() => { const el = document.querySelector("#filter"); el.value = ""; el.dispatchEvent(new Event("input", { bubbles: true })); })()`);

    // Compare.
    await A.tap("#compare-schema");
    await A.waitFor(has("#run"), "the compare screen");
    same(await A.evaluate(`[document.querySelector("#source")?.value, document.querySelector("#schema")?.value]`), ["1", "public"], "Compare starts from the schema it was opened from");
    expect(await A.evaluate(lacks("#target-1")), "Compare does not offer the source as a target");
    await A.tap("label:has(#target-2)");
    expect(await A.evaluate(`document.querySelector("#target-2").checked`), "a target can be ticked");
    await A.tap("#run");
    await A.waitFor(hasText("price"), "the comparison's changes", 20000);
    const comparePost = served.filter((item) => item.route === "POST /api/compare/phone").at(-1);
    same(comparePost?.body, { source: { connectionId: 1, schema: "public" }, targets: [{ connectionId: 2, schema: "public" }] }, "the computer asks the app to compare what the phone chose");
    await A.shot("compare");

    // A reload keeps the pairing.
    await A.send("Page.reload");
    await A.waitFor(`${has("button.tab")} && ${lacks("#phone-name")}`, "the app after a reload", 20000);
    await until(() => link.view().phones[0]?.connected === true, 15000, "the phone to connect again after the reload");
    pass("the phone stays paired and connects again after a reload");

    // Requests.
    await A.tap("button.tab", "Requests");
    await A.waitFor(has("#check-passkey"), "the approvals setup guidance");
    await A.shot("requests-no-passkey");
    const phoneKey = link.view().phones[0].key;
    link.allowApprovals(phoneKey);
    await A.tap("#check-passkey");
    await A.waitFor(has("#set-up"), "the Set up approvals button");
    await A.shot("requests-allowed");
    await A.tap("#set-up");
    await A.waitFor(`${lacks("#set-up")} && ${has("#approval-7")}`, "approvals to be set up", 25000);
    expect(link.view().phones[0].approvals === true, "the computer keeps the phone's passkey");
    const { credentials } = await A.send("WebAuthn.getCredentials", { authenticatorId });
    expect(credentials.length === 1 && credentials[0].rpId === "localhost", "the phone made one passkey, for the relay's own address");
    expect((await A.evaluate(has("#approval-8"))) && (await A.evaluate(has("#approval-9"))), "the list shows every waiting request on a shared connection");
    expect(await A.evaluate(lacks("#approval-10")), "the list leaves out a request on a connection that is not shared");
    await A.shot("requests");

    await A.tap("#approval-7");
    await A.waitFor(`${has("#approve")} && ${hasText("CREATE TABLE orders")}`, "request 7 with its SQL");
    expect((await A.text()).includes("Run migrations through v3"), "the request is named by what it runs");
    await A.shot("request-7");
    await A.tap("#approve");
    await A.waitFor(hasText("Approved. The person who asked can run it from the Deploy screen in Schema Studio."), "the approval to be recorded", 20000);
    same(decided.at(-1), { id: 7, decision: "approve" }, "the computer records the approval with the app, checked against the fingerprint and approver");
    await A.shot("approved");

    expect(await A.evaluate(`location.hash === "#/approvals"`), "after a decision the phone goes back to the list, saying what was decided");
    await A.waitFor(`${has("#approval-8")} && ${lacks("#approval-7")}`, "the list without request 7");
    await A.tap("#approval-8");
    await A.waitFor(`${has("#reject")} && ${hasText("DROP COLUMN total")}`, "request 8 with its SQL");
    expect((await A.text()).includes("Roll back through v3"), "a rollback is named as one");
    await A.tap("#reject");
    await A.waitFor(hasText("Rejected. It will not run unless someone asks for approval again."), "the rejection to be recorded", 20000);
    same(decided.at(-1), { id: 8, decision: "reject" }, "the computer records the rejection with the app");

    await A.waitFor(`${has("#approval-9")} && ${lacks("#approval-8")}`, "the list without request 8");
    await A.tap("#approval-9");
    await A.waitFor(has("#reject"), "request 9");
    const approveOffered = await A.evaluate(`(() => { const el = document.querySelector("#approve"); return el !== null && !el.disabled && el.offsetParent !== null; })()`);
    expect(!approveOffered && (await A.text()).includes("cannot show the SQL this request runs"), "a request whose SQL is missing can only be rejected");
    await A.shot("request-9");

    // Drift alerts.
    await A.tap("button.tab", "Settings");
    await A.waitFor(has("#alerts-on"), "the Turn on drift alerts button");
    await A.shot("settings");
    await A.tap("#alerts-on");
    await A.waitFor(has("#alerts-off"), "drift alerts to turn on", 20000);
    await until(() => link.view().phones[0].alerts === true, 10000, "the computer to keep the phone's alerts");
    pass("turning on drift alerts reaches the computer");
    const subscription = await A.evaluate(`JSON.parse(localStorage.getItem("e2e-push"))`);
    for (const value of Object.values(subscription)) SECRETS.add(value);
    await A.shot("alerts-on");

    const alert = (eventId, trackedSchemaId, connectionId, connectionName) => ({
      kind: "drifted",
      eventId,
      trackedSchemaId,
      name: "public",
      connectionId,
      connectionName,
      counts: { tablesAdded: 1, tablesRemoved: 0, tablesChanged: 2, constraintsChanged: 0, objectsChanged: 0 },
      drifted: true,
    });
    const shared = alert(41, 5, 1, "Bookshop dev");
    const unshared = alert(42, 6, 3, "Bookshop staging");
    await link.pushDrift([shared, unshared]);
    await until(() => pushes.length >= 1, 10000, "a push to the phone");
    await sleep(500);
    expect(pushes.length === 1, "one alert goes to the one phone with alerts on", `${pushes.length} pushes`);
    const sent = pushes[0];
    expect(sent.url === subscription.endpoint, "the push goes to the phone's own push address");
    const headerList = sent.headers instanceof Headers ? [...sent.headers] : Object.entries(sent.headers);
    const header = (name) => headerList.find(([key]) => key.toLowerCase() === name)?.[1];
    expect(String(header("content-encoding")) === "aes128gcm" && Number(header("ttl")) === 86400, "the push is encrypted for the phone and kept for a day");
    const plaintext = decrypt(sent.body, {
      privateKey: Buffer.from(subscription.d, "base64url"),
      p256dh: Buffer.from(subscription.p256dh, "base64url"),
      auth: Buffer.from(subscription.auth, "base64url"),
    }).toString("utf8");
    const words = driftNotification([shared], { markup: false });
    same(JSON.parse(plaintext), { v: 1, kind: "drift", title: words.title, body: words.body }, "the phone can read the alert, and it names only the shared connection's drift");
    await link.pushDrift([alert(43, 6, 3, "Bookshop staging")]);
    await sleep(800);
    expect(pushes.length === 1, "an alert for a connection that is not shared goes to no phone");

    // The service worker shows what arrives.
    await A.send("ServiceWorker.enable");
    const registration = await until(() => [...A.registrations.values()].find((item) => item.scopeURL === `${origin}/` && !item.isDeleted), 10000, "the service worker's registration");
    const { targetInfos } = await cdp.send("Target.getTargets");
    const worker = targetInfos.find((info) => info.type === "service_worker" && info.url === `${origin}/sw.js`);
    if (worker === undefined) throw new Error("the service worker is not running");
    const { sessionId: workerSession } = await cdp.send("Target.attachToTarget", { targetId: worker.targetId, flatten: true });
    const inWorker = async (expression) => (await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, workerSession)).result.value;
    await inWorker(`self.__shown = []; self.registration.showNotification = (title, options) => { self.__shown.push({ title, body: options.body, icon: options.icon, badge: options.badge }); return Promise.resolve(); }; true`);
    await A.send("ServiceWorker.deliverPushMessage", { origin, registrationId: registration.registrationId, data: plaintext });
    await until(() => inWorker("self.__shown.length >= 1"), 10000, "the service worker to show the alert");
    same(await inWorker("self.__shown[0]"), { title: words.title, body: words.body, icon: "/icons/icon-192.png", badge: "/icons/badge-96.png" }, "the service worker shows the alert's words with the app's icons");
    await A.send("ServiceWorker.deliverPushMessage", { origin, registrationId: registration.registrationId, data: "not an alert" });
    await until(() => inWorker("self.__shown.length >= 2"), 10000, "the service worker to show the second alert");
    same(await inWorker("[self.__shown[1].title, self.__shown[1].body]"), ["Schema Studio", "The computer sent an alert this phone app cannot read. Open the app to update it."], "an alert the app cannot read still shows a notice");

    await A.tap("#alerts-off");
    await A.waitFor(has("#alerts-on"), "drift alerts to turn off", 20000);
    await until(() => link.view().phones[0].alerts === false, 10000, "the computer to drop the phone's alerts");
    expect((await A.evaluate(`localStorage.getItem("e2e-push")`)) === null, "turning alerts off also ends the browser's push subscription");
    pass("turning off drift alerts reaches the computer");

    // Dark mode.
    await A.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
    await A.shot("dark-settings");
    await A.tap("button.tab", "Schemas");
    await A.waitFor(has("#connection-1"), "the home screen");
    await A.shot("dark-home");
    await A.tap("#connection-1");
    await A.waitFor(has("#live-status"), "the connection screen");
    await A.tap("#live-status");
    await A.waitFor(has("#live-updated"), "the live status screen");
    await A.shot("dark-live");
    await A.tap("button.tab", "Schemas");
    await A.waitFor(has("#connection-1"), "the home screen");
    await A.tap("#connection-2");
    await A.waitFor(has("#schema-public"), "connection 2's schemas");
    await A.tap("#schema-public");
    await A.waitFor(has('[data-name="books"]'), "the schema's tables");
    await A.tap('details[data-name="authors"] > summary');
    await A.shot("dark-schema");
    await A.tap("button.tab", "Requests");
    await A.waitFor(has("#approval-9"), "the list");
    await A.shot("dark-requests");
    await A.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
  } catch (error) {
    fail("phase A", error.message);
    await A.shot("failed").catch(() => {});
  }

  // ------------------------------------------------------------ phase B: a second phone pairs with its camera

  const B_NAME = "Second phone";
  try {
    const second = link.newPairingLink();
    if (second === null) throw new Error("the computer gave no second pairing link");
    SECRETS.add(second.link);
    writeVideo(second.link);
    const { browserContextId } = await cdp.send("Target.createBrowserContext", {});
    await cdp.send("Browser.grantPermissions", { origin, browserContextId, permissions: ["videoCapture"] });
    const B = await openPage("b", browserContextId);
    await B.send("Page.navigate", { url: `${origin}/` });
    await B.waitFor(hasText("Scan the code"), "the unpaired start screen");
    await B.shot("start");
    await B.tap("button", "Scan the code");
    // No screenshot while the camera shows the code: the code is the pairing secret.
    await B.waitFor(has("#phone-name"), "the camera to read the pairing code", 30000);
    writeVideo(null);
    pass("the in-app scanner reads a pairing code from the camera");
    await B.type("#phone-name", B_NAME);
    await B.tap("#pair");
    await B.waitFor(has("#connection-1"), "the second phone's home screen", 25000);
    expect(paired.at(-1) === B_NAME && link.view().phones.length === 2, "the computer keeps both phones");
    await B.shot("home");
    await B.tap("button.tab", "Settings");
    await B.waitFor(`${has("#forget")} && ${hasText("Alerts are blocked")}`, "the settings, with alerts blocked");
    expect(await B.evaluate(lacks("#alerts-on")), "a phone that blocked notifications is told how to allow them, with no button that cannot work");
    await B.tap("#forget");
    await B.waitFor(has("#forget-yes"), "the Forget question");
    await B.shot("forget");
    await B.tap("#forget-yes");
    await B.waitFor(hasText("Scan the code"), "the start screen after forgetting", 15000);
    pass("a phone can forget the computer");
    const secondKey = link.view().phones.find((phone) => phone.name === B_NAME)?.key;
    link.forgetPhone(secondKey);
    expect(link.view().phones.length === 1, "the computer can forget a phone too");
    for (const page of [B]) {
      const problems = unexpected(page);
      expect(problems.length === 0, `phone ${page.label} logged no errors`, problems.slice(0, 8).join(" | "));
    }
  } catch (error) {
    fail("phase B", error.message);
  } finally {
    fs.rmSync(VIDEO, { force: true });
  }

  // ------------------------------------------------------------ a laptop's browser, with a typed code

  const C_NAME = "Laptop browser";
  try {
    const { browserContextId } = await cdp.send("Target.createBrowserContext", {});
    const C = await openPage("c", browserContextId);
    await C.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    await C.send("Page.navigate", { url: `${origin}/` });
    await C.waitFor(has("#enter-code"), "the unpaired start screen");
    expect(await C.evaluate(`document.querySelector("#enter-code").previousElementSibling === null`), "with a mouse or trackpad, typing a code comes first");
    await C.shot("start");
    await C.tap("#enter-code");
    await C.waitFor(has("#short-code"), "the box for a code");
    await C.shot("code");

    // Mistakes, which use nothing up. These are not real codes, so pictures may show them.
    await C.type("#short-code", "ABC");
    await C.tap("#code-continue");
    await C.waitFor(hasText("A code has 8 letters and numbers"), "the answer to a code that is too short");
    await C.type("#short-code", "2222-2222");
    const tried = Date.now();
    for (const type of ["keyDown", "keyUp"]) {
      await C.send("Input.dispatchKeyEvent", { type, key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, ...(type === "keyDown" ? { text: "\r" } : {}) });
    }
    await C.waitFor(hasText("That code is not right"), "the answer to a code nobody made", 30000);
    note(`one try of a typed code took about ${Date.now() - tried} ms in this browser`);
    pass("the Enter key sends a typed code");
    same(await C.evaluate("document.activeElement.id"), "short-code", "after a wrong code, the cursor is back in the box");
    await C.shot("code-wrong");

    // A new code from the computer, as Settings asks for one. It goes on the secrets list before anything else can see it.
    const newTypedCode = async () => {
      const made = await link.newPairing();
      if (made === null || made.shortCode === null) throw new Error("the computer gave no code to type");
      for (const form of [made.link, made.shortCode, made.shortCode.toLowerCase(), showShortCode(made.shortCode)]) SECRETS.add(form);
      return made.shortCode;
    };

    // No picture from typing a real code until the pairing screen: the code is a pairing secret. The computer says no.
    const refused = await newTypedCode();
    expect(link.view().typedCodeLive, "the computer says a code is waiting to be typed");
    await C.type("#short-code", refused.toLowerCase());
    await C.tap("#code-continue");
    await C.waitFor(hasText("Pair this browser"), "the pairing screen after a typed code", 30000);
    pass("a typed code is taken in small letters and with no hyphen");
    expect(/ on (Mac|Linux|Windows)$/.test(await C.evaluate(`document.querySelector("#phone-name").value`)), "a laptop's browser is named after the browser and the system");
    await C.shot("pairing");
    await C.type("#phone-name", C_NAME);
    await C.tap("#pair");
    await C.waitFor(hasText("did not allow this"), "the answer after No on the computer", 30000);
    same(asked, [C_NAME], "the computer asks about the name the browser gave");
    expect(link.view().phones.length === 1, "a browser the computer said no to is not paired");
    expect(!link.view().typedCodeLive, "the computer knows the code has been used");
    await C.shot("denied");
    await C.tap("#code-again");
    await C.waitFor(has("#short-code"), "the box for a code, again");
    await C.type("#short-code", refused);
    await C.tap("#code-continue");
    await C.waitFor(hasText("That code is not right"), "the answer to a used code", 30000);
    pass("a typed code works once, even when the answer was no");

    // The computer says yes, and the browser waits until it does.
    let allow = () => {};
    answerAsked = () => new Promise((resolve) => (allow = resolve));
    const allowed = await newTypedCode();
    await C.type("#short-code", showShortCode(allowed));
    await C.tap("#code-continue");
    await C.waitFor(hasText("Pair this browser"), "the pairing screen after a second typed code", 30000);
    await C.type("#phone-name", C_NAME);
    await C.tap("#pair");
    await C.waitFor(hasText("is asking whether to allow this"), "the browser to say the computer is asking", 30000);
    await C.shot("asking");
    expect(link.view().phones.length === 1, "nothing pairs before the computer's answer");
    allow(true);
    await C.waitFor(has("#connection-1"), "the home screen after Allow", 25000);
    expect(paired.at(-1) === C_NAME && link.view().phones.length === 2, "the computer keeps the browser it allowed");

    // At this width the tabs are a rail down the left, and nothing sits under them.
    const railed = async (label) => {
      const layout = await C.evaluate(`(() => {
        const box = (selector) => { const { left, right, top, bottom } = document.querySelector(selector).getBoundingClientRect(); return { left, right, top, bottom }; };
        return { tabs: box(".tabs"), main: box(".app"), bar: box(".top"), wide: document.documentElement.scrollWidth, width: innerWidth, height: innerHeight };
      })()`);
      const { tabs, main, bar, wide, width, height } = layout;
      expect(tabs.left === 0 && tabs.right < 300 && tabs.bottom - tabs.top === height, `${label}: the tabs run down the side`, JSON.stringify(layout));
      expect(main.left >= tabs.right && bar.left >= tabs.right, `${label}: nothing sits under the tabs`, JSON.stringify(layout));
      expect(wide <= width, `${label}: the page does not scroll sideways`, JSON.stringify(layout));
    };
    await railed("the home screen");
    await C.shot("home");
    await C.tap("#connection-1");
    await C.waitFor(has("#live-status"), "the connection screen");
    await C.tap("#live-status");
    await C.waitFor(has("#live-updated"), "the live status screen");
    await railed("the live status screen");
    await C.shot("live");
    link.setEnabled(false);
    await C.waitFor(hasText("Computer offline"), "the browser to say the computer has gone", 20000);
    await railed("the live status screen with the computer away");
    await C.shot("live-offline");
    link.setEnabled(true);
    await until(() => link.status().state === "connected", 20000, "the computer to connect again");
    await C.waitFor(hasText("Refreshes every 5 seconds"), "the live screen to come back with the computer", 40000);
    await C.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
    await C.shot("live-dark");
    await C.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
    await C.tap("button.tab", "Settings");
    await C.waitFor(has("#forget"), "the settings");
    await railed("the settings");
    await C.shot("settings");
    await C.tap("#forget");
    await C.waitFor(has("#forget-yes"), "the Forget question");
    await C.tap("#forget-yes");
    await C.waitFor(has("#enter-code"), "the start screen after forgetting", 15000);
    link.forgetPhone(link.view().phones.find((phone) => phone.name === C_NAME)?.key);
    expect(link.view().phones.length === 1, "the computer can forget the browser too");
    // A wrong code is answered 404, which Chrome notes in the console by itself.
    const problems = unexpected(C).filter((text) => !/status of 404/.test(text));
    expect(problems.length === 0, `phone ${C.label} logged no errors`, problems.slice(0, 8).join(" | "));
  } catch (error) {
    fail("phase C", error.message);
  }

  // ------------------------------------------------------------ allow control: check and acknowledge drift

  try {
    await until(() => link.view().phones[0]?.connected === true, 20000, "the first phone to be connected again");
    const key = link.view().phones[0].key;
    const row = TRACKED.find((tracked) => tracked.id === 11);
    const changes = () => served.filter(({ route }) => route === "POST /api/lineage/drift" || route === "POST /api/lineage/acknowledge");
    const CHECK = "#check-drift-11";
    const ACKNOWLEDGE = "#ack-drift-11";

    await A.tap("button.tab", "Schemas");
    await A.waitFor(has("#connection-1"), "the home screen");
    await A.tap("#connection-1");
    await A.waitFor(has("#live-status"), "the connection screen");
    await A.tap("#live-status");
    await A.waitFor(has("#live-updated"), "the live status screen");

    // Off until Settings on the computer turns it on.
    expect(link.view().phones[0].control === false, "Allow control starts off for a paired phone");
    await A.waitFor(hasText("turn on Allow control"), "the phone to say where Allow control is");
    expect((await A.evaluate(lacks(CHECK))) && (await A.evaluate(lacks(ACKNOWLEDGE))), "with Allow control off the phone shows no button that changes anything");
    await A.shot("control-off");

    // On, for a role that may not do this.
    link.allowControl(key);
    expect(link.view().phones[0].control === true, "Settings can turn Allow control on");
    await A.waitFor(hasText("may not check or acknowledge drift"), "the phone to say the role may not", 12000);
    expect(await A.evaluate(lacks(CHECK)), "a role without the permission gets no button either");

    // On, for a role that may.
    ME.permissions.push("drift:run", "drift:update");
    await A.waitFor(`${has(CHECK)} && ${has(ACKNOWLEDGE)}`, "the two buttons", 12000);
    await A.shot("control-on");
    same(changes().length, 0, "nothing has been changed yet");

    await A.tap(CHECK);
    await A.waitFor(hasText("no longer matches its baseline"), "the check's result");
    same(changes().at(-1), { route: "POST /api/lineage/drift", search: "", body: { trackedSchemaId: 11 } }, "Check now goes through the app's own route, with only the schema's number");
    same(link.view().actions[0].action, "drift-check", "the computer logs the check");
    same(link.view().actions[0].outcome, "done", "the computer logs that the check worked");

    // Acknowledging takes two taps, and Cancel backs out.
    await A.tap(ACKNOWLEDGE);
    await A.waitFor(has("#ack-yes-11"), "the Acknowledge question");
    expect((await A.text()).includes("The schema stays drifted"), "the question says what acknowledging does not do");
    await A.shot("control-confirm");
    await A.tap(".drift-confirm button.secondary", "Cancel");
    await A.waitFor(has(ACKNOWLEDGE), "the buttons to come back after Cancel");
    same(changes().length, 1, "cancelling asks the computer nothing");
    await A.tap(ACKNOWLEDGE);
    await A.waitFor(has("#ack-yes-11"), "the Acknowledge question again");
    await A.tap("#ack-yes-11");
    await A.waitFor(hasText("still shows as drifted"), "the acknowledgement's result");
    same(changes().at(-1), { route: "POST /api/lineage/acknowledge", search: "", body: { trackedSchemaId: 11 } }, "Acknowledge goes through the app's own route, with only the schema's number");
    await A.waitFor(`${lacks(ACKNOWLEDGE)} && ${has(CHECK)}`, "the Acknowledge button to leave once it is done", 12000);
    await A.shot("control-done");
    same(link.view().actions.slice(0, 2).map((action) => [action.action, action.outcome, action.schema]), [["drift-acknowledge", "done", "public"], ["drift-check", "done", "public"]], "the log has both, newest first");
    await A.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
    await A.shot("control-dark");
    await A.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });

    // Turned off with a button still on the phone's screen: the computer is
    // what decides, so the tap is refused and nothing reaches the app. In one
    // evaluate, since the screen would take the button away at its next refresh.
    const before = changes().length;
    link.turnOffControl(key);
    await A.evaluate(`document.querySelector(${JSON.stringify(CHECK)}).click()`);
    await A.waitFor(hasText("Allow control is off for this device"), "the refusal");
    same(changes().length, before, "the computer refuses once Allow control is off, and the app hears nothing");
    same(link.view().actions[0].outcome, "control-off", "the computer logs the refused try");
    await A.waitFor(`${hasText("turn on Allow control")} && ${lacks(CHECK)}`, "the phone to take the button away", 12000);
    await A.shot("control-refused");
    const text = await A.text();
    same(LIVE_PRIVATE.filter((word) => text.includes(word)), [], "the screens with buttons show no address, user name or server words");
  } catch (error) {
    fail("allow control", error.message);
  }

  // ------------------------------------------------------------ allow control: a passkey starts a run or cancels a query

  try {
    const key = link.view().phones[0].key;
    const runs = () => served.filter(({ route }) => ["POST /api/scripts/apply", "POST /api/scripts/revert", "POST /api/deploy/approvals", "POST /api/performance/cancel"].includes(route));
    const latest = () => [link.view().actions[0].action, link.view().actions[0].outcome];
    const openFamily = async (connectionId, index) => {
      await A.tap("button.tab", "Schemas");
      await A.waitFor(has(`#connection-${connectionId}`), "the home screen");
      await A.tap(`#connection-${connectionId}`);
      await A.waitFor(has("#live-status"), "the connection screen");
      await A.tap("#live-status");
      await A.waitFor(has("#open-deploy"), "the way in to deploying", 12000);
      await A.tap("#open-deploy");
      await A.waitFor(has(`#family-${index}`), "the script families");
      await A.tap(`#family-${index}`);
      await A.waitFor(`${has("#deploy-0")} && ${has("#undo-0")}`, "where the script stands");
    };

    // The phone is still on connection 1's live status, where control was turned off.
    ME.permissions.push("deploy:run", "approvals:create", "performance:update");
    link.allowControl(key);
    await A.waitFor(has("#open-deploy"), "the way in to deploying", 12000);

    // This phone set up its passkey for approvals, so take it away to come to one as a new person would.
    link.turnOffApprovals(key);
    await A.waitFor(hasText("choose Set up passkey for it"), "the device to say where a passkey comes from", 12000);
    expect(await A.evaluate(lacks("#cancel-4103")), "without a passkey the phone shows no Cancel query");
    await A.shot("control-no-passkey");
    link.allowApprovals(key);
    await A.tap("#check-passkey");
    await A.waitFor(has("#set-up:not([disabled])"), "the Set up passkey button");
    await A.shot("control-set-up-passkey");
    await A.tap("#set-up");
    await A.waitFor(`${lacks("#set-up")} && ${has("#cancel-4103")}`, "the passkey to be set up", 25000);
    expect(link.view().phones[0].approvals === true, "the computer keeps the new passkey");

    // Cancel a stuck query.
    same(
      await A.evaluate(`[...document.querySelectorAll("button[id^='cancel-']")].map((node) => node.id).sort().join(" ")`),
      "cancel-4101 cancel-4103 cancel-4104",
      "only a running query has Cancel query, not a session idle in a transaction",
    );
    await A.tap("#cancel-4103");
    await A.waitFor(`${hasText("undoes what it had changed so far")} && ${has("#cancel-yes-4103:not([disabled])")}`, "the question, ready to sign");
    await A.shot("cancel-question");
    same(runs().length, 0, "asking before a cancel changes nothing");
    await A.tap("#cancel-yes-4103");
    await A.waitFor(hasText("told to cancel"), "the cancel's result", 25000);
    same(runs().at(-1), { route: "POST /api/performance/cancel", search: "", body: { connectionId: 1, pid: 4103, queryStart: QUERY_BEGAN } }, "the passkey cancels exactly that query, named by when it began");
    same(latest(), ["cancel-query", "done"], "the computer logs the cancel");
    await A.shot("cancel-done");

    // Deploy, ticking the risk it runs.
    await A.tap("#open-deploy");
    await A.waitFor(has("#family-0"), "the script families");
    await A.shot("deploy-list");
    await A.tap("#family-0");
    await A.waitFor(`${has("#deploy-0")} && ${has("#undo-0")}`, "where the script stands");
    expect((await A.text()).includes("On v2.0.0, 1 waiting"), "the script says where it stands");
    await A.shot("deploy-family");
    await A.tap("#deploy-0");
    await A.waitFor(`${has("#risk-data-loss")} && ${hasText(RUN_SQL)} && ${has("#start-run")}`, "the plan with its SQL and its risk");
    await A.shot("deploy-plan");
    expect(await A.evaluate(has("#start-run[disabled]")), "the passkey button waits for the risk to be ticked");
    same(runs().length, 1, "reading a plan starts nothing");
    await A.tap("#risk-data-loss");
    await A.waitFor(has("#start-run:not([disabled])"), "the passkey button");
    await A.tap("#start-run");
    await A.waitFor(hasText("Deployed."), "the deploy's result", 25000);
    same(
      runs().at(-1),
      { route: "POST /api/scripts/apply", search: "", body: { connectionId: 1, schemaName: "public", scriptName: "orders_migration", targetVersion: "3.0.0", acknowledgeProduction: false, acknowledgeBreaking: false, acknowledgeDataLoss: true, acknowledgeDrift: false } },
      "the deploy goes through the app's own route, with only the risk that was signed",
    );
    same(link.view().actions.slice(0, 2).map(({ action, outcome }) => [action, outcome]), [["deploy", "done"], ["deploy", "started"]], "the computer logs the start and how it ended");
    await A.shot("deploy-done");

    // Roll it back.
    await A.tap("#back-to-family");
    await A.waitFor(`${has("#undo-0")} && ${hasText("The last run from a paired device finished")}`, "the script again, with how its last run ended");
    await A.tap("#undo-0");
    await A.waitFor(`${has("#risk-other-scripts")} && ${hasText(UNDO_SQL)} && ${hasText("users_migration v2.0.0")}`, "the rollback's plan");
    await A.tap("#risk-other-scripts");
    await A.waitFor(has("#start-run:not([disabled])"), "the passkey button");
    await A.tap("#start-run");
    await A.waitFor(hasText("Rolled back."), "the rollback's result", 25000);
    same(
      runs().at(-1),
      { route: "POST /api/scripts/revert", search: "", body: { connectionId: 1, schemaName: "public", scriptName: "orders_migration", targetVersion: "1.0.0", acknowledgeProduction: false, acknowledgeOtherScripts: true, acknowledgeDataLoss: false } },
      "the rollback goes through the app's own route, with only the risk that was signed",
    );
    same(latest(), ["rollback", "done"], "the computer logs the rollback");
    await A.shot("rollback-done");

    // SQL that does not match its fingerprint cannot be signed.
    await openFamily(1, 2);
    await A.tap("#deploy-0");
    await A.waitFor(hasText("does not match its own fingerprint"), "the refusal to sign");
    expect(await A.evaluate(lacks("#start-run")), "a plan whose SQL does not match its fingerprint has no passkey button");
    await A.shot("deploy-mismatch");

    // Production: asking changes nothing but the queue, so it takes no ticks.
    await openFamily(2, 0);
    await A.tap("#deploy-0");
    await A.waitFor(`${hasText("This runs on production.")} && ${has("#start-run:not([disabled])")}`, "a production request, ready to sign");
    expect(await A.evaluate(lacks("#risk-production")), "asking accepts no risk, so the list has no boxes");
    await A.shot("deploy-ask");
    const beforeAsk = runs().length;
    await A.tap("#start-run");
    await A.waitFor(hasText("Sent for approval"), "the request's result", 25000);
    same(runs().slice(beforeAsk), [{ route: "POST /api/deploy/approvals", search: "", body: { connectionId: 2, schemaName: "public", scriptName: "orders_migration", action: "deploy", targetVersion: "3.0.0" } }], "the request goes to the queue, and nothing runs");
    same(latest(), ["deploy", "sent-for-approval"], "the computer logs the request");
    await A.shot("deploy-asked");

    // Once approved, the run still takes production's tick, since the route reads it first.
    await openFamily(2, 1);
    await A.tap("#deploy-0");
    await A.waitFor(`${has("#risk-production")} && ${has("#start-run")}`, "an approved run, ready to tick");
    expect(await A.evaluate(has("#start-run[disabled]")), "an approved run on production still waits for its tick");
    await A.tap("#risk-production");
    await A.waitFor(has("#start-run:not([disabled])"), "the passkey button");
    await A.tap("#start-run");
    await A.waitFor(hasText("Deployed."), "the approved run's result", 25000);
    same(
      runs().at(-1),
      { route: "POST /api/scripts/apply", search: "", body: { connectionId: 2, schemaName: "public", scriptName: "reports_migration", targetVersion: "3.0.0", acknowledgeProduction: true, acknowledgeBreaking: false, acknowledgeDataLoss: false, acknowledgeDrift: false } },
      "an approved run on production carries the tick",
    );

    // Refused once Allow control is off, with the button still on the screen.
    await openFamily(1, 0);
    await A.tap("#deploy-0");
    await A.waitFor(has("#risk-data-loss"), "the plan");
    await A.tap("#risk-data-loss");
    await A.waitFor(has("#start-run:not([disabled])"), "the passkey button");
    const beforeOff = runs().length;
    link.turnOffControl(key);
    await A.evaluate(`document.querySelector("#start-run").click()`);
    await A.waitFor(hasText("Allow control is off for this device"), "the refusal", 25000);
    same(runs().length, beforeOff, "the computer refuses a signed run once Allow control is off, and the app hears nothing");
    same(latest(), ["deploy", "control-off"], "the computer logs the refused run");
    await A.shot("deploy-refused");
    const text = await A.text();
    same(LIVE_PRIVATE.filter((word) => text.includes(word)), [], "the deploy screens show no address, user name or server words");
  } catch (error) {
    fail("a passkey starts a run", error.message);
  }

  // ------------------------------------------------------------ what nobody should see

  const problemsA = unexpected(A);
  expect(problemsA.length === 0, "phone a logged no errors", problemsA.slice(0, 8).join(" | "));
  const consoleText = [...pages.values()].flatMap((page) => page.console).join("\n");
  const logText = fs.readdirSync(LOGS).map((name) => fs.readFileSync(path.join(LOGS, name), "utf8")).join("\n");
  const leaked = (text) => [...SECRETS].filter((secret) => typeof secret === "string" && secret.length >= 8 && text.includes(secret)).length;
  expect(leaked(consoleText) === 0 && !consoleText.includes("#pair="), "the phone app's console holds no pairing link, key, push address or approver");
  expect(leaked(logText) === 0 && !logText.includes("#pair="), "the computer's log holds no pairing link, key, push address or approver");
  expect(/The phone "Test phone" approved approval request 7\./.test(logText), "the computer's log records the approval");
  const warnings = logText.split("\n").filter((line) => /^\[[^\]]+\] \S*(warn|error)/i.test(line));
  expect(warnings.length === 0, "the computer logged no warnings or errors", warnings.slice(0, 6).join(" | "));
} catch (error) {
  fail("the run", error.message);
} finally {
  clearTimeout(watchdog);
  await cleanUp();
  const failed = results.filter((ok) => !ok).length;
  say(`Pictures of each screen are in ${path.relative(process.cwd(), SHOTS) || "."}.`);
  say(`# ${results.length - failed} passed, ${failed} failed, in ${Math.round((Date.now() - started) / 1000)} s`);
  process.exit(failed === 0 ? 0 : 1);
}
