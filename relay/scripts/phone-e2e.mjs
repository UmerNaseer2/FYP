/**
 * An end-to-end run of the phone app: two phones pair with a computer through
 * the relay, one by link and one with its camera, then read a schema, compare
 * two, set up approvals with a passkey, approve and reject requests, turn
 * drift alerts on and off, and forget the computer.
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
 * It never prints pairing links, keys, push addresses or the approver hash.
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
const { initLog } = desktopRequire("./out/main/log.js");
const { approvalFingerprint } = desktopRequire("./out/shared/remote/approval.js");
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
const ME = { role: "admin", roleLabel: "Admin", permissions: ["dashboard:read", "compare:read", "visualizer:read", "drift:read", "deploy:read"] };
const approver = crypto.randomBytes(32).toString("hex");
SECRETS.add(approver);
const hoursAgo = (hours) => new Date(Date.now() - hours * 3600_000).toISOString();
const DEPLOY_SCRIPTS = [
  { name: "add_orders", version: "2", sql: "CREATE TABLE orders (id integer PRIMARY KEY);" },
  { name: "add_order_total", version: "3", sql: "ALTER TABLE orders ADD COLUMN total numeric;" },
];
const ROLLBACK_SCRIPTS = [{ name: "add_order_total", version: "3", sql: "ALTER TABLE orders DROP COLUMN total;" }];

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
    case "GET /api/lineage/schemas":
      return answer(200, { schemas: ["public", "sales"] });
    case "GET /api/schema/snapshot":
      return answer(200, { snapshot: snapshotOf(url.searchParams.get("schema")) });
    case "POST /api/compare/phone":
      return answer(200, compareSummary(body));
    case "GET /api/deploy/approvals/phone":
      return answer(200, { approver, canApprove: true, approvals: [...queue.values()].map((item) => item.summary) });
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
  const opened = await openPhoneLink({
    store,
    fileLabel: "~/.config/schema-studio/phone-link.json",
    call,
    appVersion: "0.0.0-e2e",
    computerName: "Test computer",
    pushTransport,
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
