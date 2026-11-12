/**
 * Linking this computer to a web site and answering its questions
 * (src/main/cloud-agent.ts). A fake plays the site, another plays this
 * computer's own server, and time moves by hand, so these tests check what is
 * sent where and when, and that the site can only ever ask the two questions
 * that change nothing, about connections shared here.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

import type { CloudLinkState } from "../core/cloud-agent-file";
import {
  BACKOFF_MS,
  BUSY_FOR_MS,
  BUSY_POLL_MS,
  CloudAgent,
  DRIFT_EVERY_MS,
  DRIFT_FRESH_MS,
  IDLE_POLL_MS,
  MAX_ANSWER_BYTES,
  MOST_DRIFT_SCHEMAS,
  MOST_JOBS_AT_ONCE,
  NO_SYNC_RETRY_MS,
  PUBLISH_EVERY_MS,
  SYNC_EVERY_MS,
  readCloudJob,
  readDriftAnswer,
  readOwnConnections,
  readSiteRole,
  type CloudFetch,
  type CloudStore,
  type OwnConnection,
  type SiteRole,
  type SyncHost,
} from "../main/cloud-agent";
import type { Clock } from "../main/clock";
import { initLog, logFilePaths, logWarn } from "../main/log";
import type { AppAnswer, AppCaller } from "../main/phone-requests";
import type { LoadResult, Protection } from "../main/secrets";
import type { CompareSummary } from "../shared/remote/rpc";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ss-cloud-agent-"));
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

const ORIGIN = "https://site.example.test";
const TOKEN = `ssa_${"t".repeat(43)}`;
const DEVICE_CODE = "d".repeat(43);
const USER_CODE = "BCDF-GHJK";
/** A database host that the server's error messages name. It must never reach the site. */
const HOST = "dev-db.example.test";

const LINKED: CloudLinkState = { origin: ORIGIN, token: TOKEN, orgName: "Acme Data", orgSlug: "acme-data", linkedAt: 1_600_000_000_000 };
const SAVED: LoadResult<CloudLinkState> = { status: "values", values: LINKED, protection: "keyring", upgrade: false };

const START = "POST /api/agent/link";
const CLAIM = "POST /api/agent/link/claim";
const NEXT = "POST /api/agent/jobs/next";
const PUBLISH = "PUT /api/agent/connections";
const SELF = "DELETE /api/agent/self";

const SUMMARY: CompareSummary = {
  source: { connectionId: 1, name: "Dev", schema: "public", error: null },
  targets: [
    {
      connectionId: 2,
      name: "Prod",
      schema: "public",
      status: "compared",
      error: null,
      changes: 1,
      breaking: 1,
      manual: 0,
      lines: [{ category: "Column", table: "orders", object: "total", change: "dropped", severity: "breaking", detail: "numeric", manual: false }],
      moreLines: 0,
      history: null,
    },
  ],
};

const SCHEMAS_JOB = { id: 7, method: "schemas.list", params: { connectionId: 1 } };
const COMPARE_JOB = {
  id: 8,
  method: "compare.run",
  params: { source: { connectionId: 1, schema: "public" }, targets: [{ connectionId: 2, schema: "public" }] },
};

type Timer = { at: number; run: () => void; id: number };

class FakeClock implements Clock {
  time = 1_700_000_000_000;
  private timers: Timer[] = [];
  private lastId = 0;
  now = (): number => this.time;
  setTimeout = (run: () => void, ms: number): unknown => {
    this.lastId += 1;
    this.timers.push({ at: this.time + ms, run, id: this.lastId });
    return this.lastId;
  };
  clearTimeout = (timer: unknown): void => {
    this.timers = this.timers.filter((entry) => entry.id !== timer);
  };
  /** Runs the first timer due by this time, if there is one. */
  runOneBy(end: number): boolean {
    let due: Timer | undefined;
    for (const entry of this.timers) {
      if (entry.at > end) continue;
      if (due === undefined || entry.at < due.at || (entry.at === due.at && entry.id < due.id)) due = entry;
    }
    if (due === undefined) return false;
    const running = due;
    this.timers = this.timers.filter((entry) => entry !== running);
    this.time = Math.max(this.time, running.at);
    running.run();
    return true;
  }
}

/** Lets everything already under way finish, the reading of an answer's body included. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 12; turn += 1) await new Promise((done) => setImmediate(done));
}

/** A real wait, for the limits only real time can reach. */
function realWait(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

type SiteAnswer = { status: number; body?: unknown } | Error;
type SiteCall = { method: string; origin: string; path: string; body: unknown; init: RequestInit };

const STARTED = {
  deviceCode: DEVICE_CODE,
  userCode: USER_CODE,
  verifyPath: `/link-computer?code=${USER_CODE}`,
  intervalSeconds: 3,
  expiresInSeconds: 600,
};
const APPROVED: SiteAnswer = { status: 200, body: { token: TOKEN, org: { slug: "acme-data", name: "Acme Data" } } };

/** Plays the web site. It answers like the real one until a test sets a route to answer otherwise. */
class FakeSite {
  calls: SiteCall[] = [];
  /** Handed out one at a time by POST /api/agent/jobs/next. */
  jobs: unknown[] = [];
  private set_ = new Map<string, SiteAnswer | Promise<SiteAnswer>>();

  /** Makes a route give this answer until set again. Null puts the usual answer back. */
  set(route: string, answer: SiteAnswer | Promise<SiteAnswer> | null): void {
    if (answer === null) this.set_.delete(route);
    else this.set_.set(route, answer);
  }

  count(route: string): number {
    return this.of(route).length;
  }

  of(route: string): SiteCall[] {
    return this.calls.filter((call) => `${call.method} ${call.path}` === route);
  }

  /** The answers sent to questions, by the question's id. */
  answers(id: number): unknown[] {
    return this.of(`POST /api/agent/jobs/${id}`).map((call) => call.body);
  }

  fetch: CloudFetch = async (url, init) => {
    const parsed = new URL(url);
    const method = init.method ?? "GET";
    const target = parsed.pathname + parsed.search;
    this.calls.push({
      method,
      origin: parsed.origin,
      path: target,
      body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
      init,
    });
    const route = `${method} ${target}`;
    const answer = await (this.set_.get(route) ?? this.usual(route));
    if (answer instanceof Error) throw answer;
    return new Response(JSON.stringify(answer.body ?? {}), { status: answer.status });
  };

  private usual(route: string): SiteAnswer {
    if (route === START) return { status: 201, body: STARTED };
    if (route === CLAIM) return { status: 202, body: { waiting: true } };
    if (route === NEXT) return { status: 200, body: { job: this.jobs.shift() ?? null } };
    return { status: 200, body: { ok: true } };
  }
}

class FakeStore implements CloudStore {
  saved: CloudLinkState | null = null;
  removed = 0;
  failSave = false;
  failRemove = false;

  constructor(private loaded: LoadResult<CloudLinkState> | Error) {}

  load(): LoadResult<CloudLinkState> {
    if (this.loaded instanceof Error) throw this.loaded;
    return this.loaded;
  }

  save(values: CloudLinkState): Protection {
    if (this.failSave) throw new Error("The disk is full.");
    this.saved = values;
    return "keyring";
  }

  remove(): void {
    this.removed += 1;
    if (this.failRemove) throw new Error("The disk is read-only.");
  }
}

type Rows = { id: number; name: string; database: string; host?: string }[];

const CONNECTION_ROWS: Rows = [
  { id: 1, name: "Dev", database: "shop_dev", host: HOST },
  { id: 2, name: "Prod", database: "shop_prod", host: HOST },
  { id: 3, name: "Not shared", database: "shop_staging", host: HOST },
];

type AppCall = { method: string; path: string; body: unknown };

/** Plays this computer's own server. A path it does not list cannot be reached, as a server that is down cannot. */
function fakeApp(extra: Record<string, AppAnswer | Error> = {}): { call: AppCaller; calls: AppCall[]; routes: Record<string, AppAnswer | Error> } {
  const calls: AppCall[] = [];
  const routes: Record<string, AppAnswer | Error> = {
    "GET /api/connections/phone": { status: 200, json: { connections: CONNECTION_ROWS } },
    "GET /api/lineage/schemas?connectionId=1": { status: 200, json: { schemas: ["public", "shop"] } },
    "POST /api/compare/phone": { status: 200, json: SUMMARY },
    ...extra,
  };
  const call: AppCaller = async (method, target, body) => {
    calls.push({ method, path: target, body: structuredClone(body) });
    const answer = routes[`${method} ${target}`];
    if (answer === undefined) throw new Error(`The test app has no ${method} ${target}.`);
    if (answer instanceof Error) throw answer;
    return { status: answer.status, json: structuredClone(answer.json) };
  };
  return { call, calls, routes };
}

type RigOptions = {
  loaded?: LoadResult<CloudLinkState> | Error;
  shared?: readonly number[];
  app?: Record<string, AppAnswer | Error>;
  call?: AppCaller;
  jobLimitMs?: number;
  sync?: SyncHost;
};

function rig(options: RigOptions = {}) {
  const clock = new FakeClock();
  const site = new FakeSite();
  const store = new FakeStore(options.loaded ?? { status: "missing" });
  const app = fakeApp(options.app);
  const opened: string[] = [];
  const sharing = { ids: options.shared ?? [1, 2] };
  const changes = { count: 0 };
  const agent = new CloudAgent({
    store,
    fetch: site.fetch,
    clock,
    call: options.call ?? app.call,
    sharedConnectionIds: () => sharing.ids,
    computerName: "Test computer",
    openBrowser: (url) => opened.push(url),
    onChange: () => {
      changes.count += 1;
    },
    jobLimitMs: options.jobLimitMs,
    sync: options.sync,
  });
  /** Moves time on, letting each timer's work finish before the next timer runs. */
  async function pass(ms: number): Promise<void> {
    const end = clock.time + ms;
    await settle();
    while (clock.runOneBy(end)) await settle();
    clock.time = end;
    await settle();
  }
  return { agent, app, changes, clock, opened, pass, sharing, site, store };
}

/** Whatever answers a promise later, for an answer a test needs to hold back. */
function held<T>(): { promise: Promise<T>; release: (value: T) => void } {
  let release: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

// ----- Linking -----

test("a link goes from the address typed, through the person's browser, to asking for questions", async () => {
  const { agent, opened, pass, site, store } = rig();
  agent.start();
  assert.deepEqual(agent.view(), { state: "off", origin: null, notice: null });

  assert.deepEqual(await agent.startLink(`  ${ORIGIN}  `), { ok: true });
  assert.deepEqual(site.of(START)[0].body, { computerName: "Test computer" });
  assert.deepEqual(opened, [`${ORIGIN}/link-computer?code=${USER_CODE}`]);
  assert.deepEqual(agent.view(), { state: "linking", origin: ORIGIN, code: USER_CODE });

  await pass(2_999);
  assert.equal(site.count(CLAIM), 0, "the site said to wait 3 seconds between tries");
  await pass(1);
  assert.deepEqual(site.of(CLAIM)[0].body, { deviceCode: DEVICE_CODE });
  assert.equal(agent.view().state, "linking", "a 202 means not approved yet");
  assert.equal(site.count(NEXT), 0);

  site.set(CLAIM, APPROVED);
  await pass(3_000);
  const view = agent.view();
  assert.ok(view.state === "linked");
  assert.equal(view.origin, ORIGIN);
  assert.equal(view.orgName, "Acme Data");
  assert.equal(view.problem, null);
  assert.equal(store.saved?.token, TOKEN);
  assert.equal(store.saved?.orgSlug, "acme-data");
  assert.equal(site.count(NEXT), 1);
  assert.equal(site.count(PUBLISH), 1);

  // Linked, so no more claims.
  await pass(30_000);
  assert.equal(site.count(CLAIM), 2);
  agent.stop();
});

test("only the calls made once linked carry the token, and no call follows a redirect or uses a cache", async () => {
  const { agent, pass, site } = rig();
  agent.start();
  await agent.startLink(ORIGIN);
  site.set(CLAIM, APPROVED);
  await pass(3_000);
  site.jobs.push(SCHEMAS_JOB);
  await pass(IDLE_POLL_MS);
  agent.unlink();
  await settle();

  for (const route of [START, CLAIM, NEXT, PUBLISH, SELF, "POST /api/agent/jobs/7"]) {
    assert.ok(site.count(route) > 0, `${route} was called`);
  }
  for (const call of site.calls) {
    const route = `${call.method} ${call.path}`;
    const headers = call.init.headers as Record<string, string>;
    assert.equal(call.init.redirect, "error", route);
    assert.equal(call.init.cache, "no-store", route);
    assert.equal(call.origin, ORIGIN, route);
    assert.ok(call.init.signal, route);
    if (route === START || route === CLAIM) assert.equal(headers.Authorization, undefined, route);
    else assert.equal(headers.Authorization, `Bearer ${TOKEN}`, route);
  }
});

test("an address that is not a site's own is refused before anything is sent", async () => {
  const { agent, opened, site } = rig();
  agent.start();
  for (const text of [
    "",
    "site.example.test",
    "http://site.example.test",
    "https://site.example.test/path",
    "https://person:word@site.example.test",
    "ftp://site.example.test",
  ]) {
    const result = await agent.startLink(text);
    assert.ok(!result.ok, text);
    assert.match(result.message, /not a web address/, text);
  }
  assert.equal(site.calls.length, 0);
  assert.deepEqual(opened, []);
});

test("a site on this computer may use plain http, for trying it out", async () => {
  const { agent, opened } = rig();
  agent.start();
  assert.deepEqual(await agent.startLink("http://localhost:3000"), { ok: true });
  assert.deepEqual(opened, [`http://localhost:3000/link-computer?code=${USER_CODE}`]);
  agent.stop();
});

test("a site that is busy, down or not Schema Studio is put in words, and nothing starts", async () => {
  const cases: [SiteAnswer, RegExp][] = [
    [{ status: 429 }, /Too many computers/],
    [new TypeError("fetch failed"), /Could not reach that site/],
    [{ status: 200, body: STARTED }, /did not answer like Schema Studio/],
    [{ status: 404 }, /did not answer like Schema Studio/],
    [{ status: 500 }, /did not answer like Schema Studio/],
  ];
  for (const [answer, sentence] of cases) {
    const { agent, opened, pass, site } = rig();
    agent.start();
    site.set(START, answer);
    const result = await agent.startLink(ORIGIN);
    assert.ok(!result.ok);
    assert.match(result.message, sentence);
    assert.deepEqual(opened, []);
    assert.equal(agent.view().state, "off");
    await pass(30_000);
    assert.equal(site.count(CLAIM), 0);
  }
});

test("an answer that would send the browser anywhere else is refused, and the browser never opens", async () => {
  const bad = [
    { ...STARTED, verifyPath: "https://other.example.test/" },
    { ...STARTED, verifyPath: "//other.example.test/link-computer" },
    { ...STARTED, verifyPath: "/login?next=https://other.example.test" },
    { ...STARTED, verifyPath: "/link-computer?code=ZZZZ-ZZZZ" },
    { ...STARTED, verifyPath: `/link-computer?code=${USER_CODE}&next=1` },
    { ...STARTED, userCode: "not a code", verifyPath: "/link-computer?code=not a code" },
    { ...STARTED, deviceCode: "short" },
    { ...STARTED, deviceCode: "d".repeat(201) },
    { ...STARTED, intervalSeconds: 0 },
    { ...STARTED, intervalSeconds: 61 },
    { ...STARTED, expiresInSeconds: 0 },
    { ...STARTED, expiresInSeconds: 3_601 },
    { ...STARTED, expiresInSeconds: "soon" },
    "text",
    null,
  ];
  for (const body of bad) {
    const { agent, opened, pass, site } = rig();
    agent.start();
    site.set(START, { status: 201, body });
    const result = await agent.startLink(ORIGIN);
    assert.ok(!result.ok, JSON.stringify(body));
    assert.match(result.message, /did not answer like Schema Studio/);
    assert.deepEqual(opened, [], JSON.stringify(body));
    await pass(30_000);
    assert.equal(site.count(CLAIM), 0);
  }
});

test("a computer already linked is told to unlink first", async () => {
  const { agent, site } = rig({ loaded: SAVED });
  agent.start();
  const result = await agent.startLink(ORIGIN);
  assert.ok(!result.ok);
  assert.match(result.message, /already linked/);
  assert.equal(site.count(START), 0);
  agent.stop();
});

test("a code the person turned away ends with a notice, and no more claims", async () => {
  const { agent, pass, site, store } = rig();
  agent.start();
  await agent.startLink(ORIGIN);
  site.set(CLAIM, { status: 410, body: { error: "gone" } });
  await pass(3_000);
  const view = agent.view();
  assert.ok(view.state === "off");
  assert.match(view.notice ?? "", /turned this link away/);
  assert.equal(view.origin, ORIGIN, "the address stays filled in");
  assert.equal(store.saved, null);
  await pass(30_000);
  assert.equal(site.count(CLAIM), 1);
});

test("a code that runs out ends with a notice, without asking the site", async () => {
  const { agent, pass, site } = rig();
  agent.start();
  site.set(START, { status: 201, body: { ...STARTED, expiresInSeconds: 5 } });
  await agent.startLink(ORIGIN);
  await pass(3_000);
  assert.equal(site.count(CLAIM), 1);
  await pass(3_000);
  assert.equal(site.count(CLAIM), 1);
  const view = agent.view();
  assert.ok(view.state === "off");
  assert.match(view.notice ?? "", /ran out/);
});

test("a hiccup while waiting for approval is tried again", async () => {
  const { agent, pass, site } = rig();
  agent.start();
  await agent.startLink(ORIGIN);
  site.set(CLAIM, { status: 500 });
  await pass(3_000);
  site.set(CLAIM, new TypeError("fetch failed"));
  await pass(3_000);
  assert.equal(agent.view().state, "linking");
  site.set(CLAIM, APPROVED);
  await pass(3_000);
  assert.equal(agent.view().state, "linked");
  assert.equal(site.count(CLAIM), 3);
  agent.stop();
});

test("cancelling stops the claims, and drops a claim already under way", async () => {
  const { agent, pass, site, store } = rig();
  agent.start();
  await agent.startLink(ORIGIN);
  await pass(3_000);
  const late = held<SiteAnswer>();
  site.set(CLAIM, late.promise);
  await pass(3_000);
  assert.equal(site.count(CLAIM), 2);

  agent.cancelLink();
  assert.equal(agent.view().state, "off");
  late.release(APPROVED);
  await pass(30_000);
  assert.equal(site.count(CLAIM), 2);
  assert.equal(agent.view().state, "off");
  assert.equal(store.saved, null);
});

test("linking again leaves only the newer code in play", async () => {
  const { agent, pass, site } = rig();
  agent.start();
  await agent.startLink(ORIGIN);
  const newer = "n".repeat(43);
  site.set(START, { status: 201, body: { ...STARTED, deviceCode: newer } });
  await agent.startLink(ORIGIN);
  await pass(3_000);
  assert.deepEqual(site.of(CLAIM).map((call) => call.body), [{ deviceCode: newer }]);
  agent.stop();
});

test("an approval that holds no good token links nothing", async () => {
  for (const body of [
    { token: "not-one-of-ours", org: { slug: "acme-data", name: "Acme Data" } },
    { token: TOKEN },
    { token: TOKEN, org: { slug: "", name: "Acme Data" } },
    {},
  ]) {
    const { agent, pass, site, store } = rig();
    agent.start();
    await agent.startLink(ORIGIN);
    site.set(CLAIM, { status: 200, body });
    await pass(3_000);
    const view = agent.view();
    assert.ok(view.state === "off", JSON.stringify(body));
    assert.match(view.notice ?? "", /did not answer like Schema Studio/);
    assert.equal(store.saved, null);
    assert.equal(site.count(NEXT), 0);
  }
});

test("a link that could not be saved is not used, so it cannot vanish at the next start", async () => {
  const { agent, pass, site, store } = rig();
  agent.start();
  await agent.startLink(ORIGIN);
  store.failSave = true;
  site.set(CLAIM, APPROVED);
  await pass(3_000);
  const view = agent.view();
  assert.ok(view.state === "off");
  assert.match(view.notice ?? "", /could not be saved/);
  assert.equal(site.count(NEXT), 0);
});

// ----- Starting -----

test("with no saved link nothing is sent", async () => {
  const { agent, changes, pass, site } = rig();
  agent.start();
  await pass(60_000);
  assert.deepEqual(agent.view(), { state: "off", origin: null, notice: null });
  assert.equal(site.calls.length, 0);
  assert.equal(changes.count, 1);
});

test("a saved link starts asking at once", async () => {
  const { agent, changes, pass, site } = rig({ loaded: SAVED });
  agent.start();
  await pass(0);
  // No sync host in this rig, so no sync line either.
  assert.deepEqual(agent.view(), { state: "linked", origin: ORIGIN, orgName: "Acme Data", linkedAt: LINKED.linkedAt, problem: null, sync: null });
  assert.equal(site.count(NEXT), 1);
  assert.equal(site.count(PUBLISH), 1);
  assert.ok(changes.count >= 1);
  agent.stop();
});

test("a link saved before the keyring worked moves into it, and goes on working if that fails", async () => {
  const moved = rig({ loaded: { ...SAVED, upgrade: true } as LoadResult<CloudLinkState> });
  moved.agent.start();
  assert.deepEqual(moved.store.saved, LINKED);
  assert.equal(moved.agent.view().state, "linked");
  moved.agent.stop();

  const stuck = rig({ loaded: { ...SAVED, upgrade: true } as LoadResult<CloudLinkState> });
  stuck.store.failSave = true;
  stuck.agent.start();
  assert.equal(stuck.agent.view().state, "linked");
  stuck.agent.stop();
});

test("a locked keyring says so, and sends nothing", async () => {
  const { agent, pass, site } = rig({ loaded: { status: "locked", message: "The keyring is locked." } });
  agent.start();
  await pass(60_000);
  const view = agent.view();
  assert.ok(view.state === "unavailable");
  assert.match(view.message, /keyring is locked/);
  assert.equal(view.canClear, false);
  assert.equal(site.calls.length, 0);
  const result = await agent.startLink(ORIGIN);
  assert.ok(!result.ok);
  assert.equal(site.calls.length, 0);
});

test("a saved link that cannot be read can be cleared, without calling anyone", async () => {
  const { agent, pass, site, store } = rig({ loaded: { status: "damaged", message: "The file is damaged." } });
  agent.start();
  const view = agent.view();
  assert.ok(view.state === "unavailable");
  assert.match(view.message, /could not be read/);
  assert.equal(view.canClear, true);

  agent.unlink();
  assert.equal(store.removed, 1);
  assert.equal(agent.view().state, "off");
  await pass(60_000);
  assert.equal(site.calls.length, 0);
});

test("a store that fails while opening is put in words", async () => {
  const { agent } = rig({ loaded: new Error("The disk went away.") });
  agent.start();
  const view = agent.view();
  assert.ok(view.state === "unavailable");
  assert.match(view.message, /could not start/);
  assert.equal(view.canClear, false);
});

// ----- Asking -----

test("it asks every 15 seconds when nothing is happening", async () => {
  const { agent, pass, site } = rig({ loaded: SAVED });
  agent.start();
  await pass(0);
  assert.equal(site.count(NEXT), 1);
  await pass(IDLE_POLL_MS - 1);
  assert.equal(site.count(NEXT), 1);
  await pass(1);
  assert.equal(site.count(NEXT), 2);
  await pass(IDLE_POLL_MS * 10);
  assert.equal(site.count(NEXT), 12);
  agent.stop();
});

test("after a question it asks again at once, then every 2 seconds for 2 minutes, then goes back to 15", async () => {
  const { agent, pass, site } = rig({ loaded: SAVED });
  site.jobs.push(SCHEMAS_JOB);
  agent.start();
  await pass(0);
  assert.equal(site.count(NEXT), 2, "the question, then at once in case another is waiting");

  await pass(BUSY_POLL_MS - 1);
  assert.equal(site.count(NEXT), 2);
  await pass(1);
  assert.equal(site.count(NEXT), 3);

  await pass(BUSY_FOR_MS - BUSY_POLL_MS);
  const atTheEnd = site.count(NEXT);
  assert.equal(atTheEnd, 2 + BUSY_FOR_MS / BUSY_POLL_MS);
  await pass(IDLE_POLL_MS - 1);
  assert.equal(site.count(NEXT), atTheEnd);
  await pass(1);
  assert.equal(site.count(NEXT), atTheEnd + 1);
  agent.stop();
});

test("a site that is down is tried less and less often, says so, and never ends the link", async () => {
  const { agent, changes, pass, site, store } = rig({ loaded: SAVED });
  newLogLines();
  site.set(NEXT, { status: 503, body: { error: "down" } });
  agent.start();
  await pass(0);
  let asked = 1;
  assert.equal(site.count(NEXT), asked);
  let view = agent.view();
  assert.ok(view.state === "linked");
  assert.match(view.problem ?? "", /Cannot reach the site/);

  for (const wait of [...BACKOFF_MS, BACKOFF_MS[BACKOFF_MS.length - 1]]) {
    site.set(NEXT, asked % 2 === 0 ? new TypeError("fetch failed") : { status: 503, body: { error: "down" } });
    await pass(wait - 1);
    assert.equal(site.count(NEXT), asked, `not before ${wait}`);
    await pass(1);
    asked += 1;
    assert.equal(site.count(NEXT), asked, `at ${wait}`);
  }
  assert.equal(store.removed, 0);
  assert.equal(agent.view().state, "linked");
  const failures = newLogLines().split("Could not ask the site for questions").length - 1;
  assert.equal(failures, 1, "an outage does not fill the log");

  const changesBefore = changes.count;
  site.set(NEXT, null);
  await pass(BACKOFF_MS[BACKOFF_MS.length - 1]);
  view = agent.view();
  assert.ok(view.state === "linked");
  assert.equal(view.problem, null, "the problem clears with the first good answer");
  assert.ok(changes.count > changesBefore);
  const back = site.count(NEXT);
  await pass(IDLE_POLL_MS);
  assert.equal(site.count(NEXT), back + 1, "back to the usual pace");
  agent.stop();
});

test("a 401 means the site forgot this computer, which ends the link with a notice", async () => {
  const { agent, pass, site, store } = rig({ loaded: SAVED });
  agent.start();
  await pass(0);
  site.set(NEXT, { status: 401, body: { error: "not linked" } });
  await pass(IDLE_POLL_MS);
  const view = agent.view();
  assert.ok(view.state === "off");
  assert.match(view.notice ?? "", /no longer knows this computer/);
  assert.equal(store.removed, 1);

  const asked = site.count(NEXT);
  await pass(PUBLISH_EVERY_MS * 2);
  assert.equal(site.count(NEXT), asked, "no more asking");
});

test("a 401 to an answer or to the shared list also ends the link", async () => {
  const answered = rig({ loaded: SAVED });
  answered.site.jobs.push(SCHEMAS_JOB);
  answered.site.set("POST /api/agent/jobs/7", { status: 401 });
  answered.agent.start();
  await answered.pass(0);
  assert.equal(answered.agent.view().state, "off");
  assert.equal(answered.store.removed, 1);

  const published = rig({ loaded: SAVED });
  published.site.set(PUBLISH, { status: 401 });
  published.agent.start();
  await published.pass(0);
  assert.equal(published.agent.view().state, "off");
  assert.equal(published.store.removed, 1);
});

// ----- Answering -----

test("it answers schemas.list from this computer's own server", async () => {
  const { agent, app, pass, site } = rig({ loaded: SAVED });
  site.jobs.push(SCHEMAS_JOB);
  agent.start();
  await pass(0);
  assert.ok(app.calls.some((call) => call.path === "/api/lineage/schemas?connectionId=1"));
  assert.deepEqual(site.answers(7), [{ result: { schemas: ["public", "shop"] } }]);
  agent.stop();
});

test("it answers compare.run from this computer's own server", async () => {
  const { agent, app, pass, site } = rig({ loaded: SAVED });
  site.jobs.push(COMPARE_JOB);
  agent.start();
  await pass(0);
  const asked = app.calls.find((call) => call.path === "/api/compare/phone");
  assert.deepEqual(asked?.body, COMPARE_JOB.params);
  assert.deepEqual(site.answers(8), [{ result: SUMMARY }]);
  agent.stop();
});

test("a database's name stays on this computer", async () => {
  const withDatabases = {
    ...SUMMARY,
    source: { ...SUMMARY.source, name: "Dev (shop_dev)" },
    targets: [
      { ...SUMMARY.targets[0], name: "Prod (shop_prod)" },
      { ...SUMMARY.targets[0], connectionId: null, name: "Gone (shop_gone)", status: "failed" },
      { ...SUMMARY.targets[0], connectionId: 9, name: "Removed meanwhile (shop_removed)" },
    ],
  };
  const { agent, pass, site } = rig({
    loaded: SAVED,
    app: { "POST /api/compare/phone": { status: 200, json: withDatabases } },
  });
  site.jobs.push(COMPARE_JOB);
  agent.start();
  await pass(0);
  const [answer] = site.answers(8) as [{ result: typeof SUMMARY }];
  assert.equal(answer.result.source.name, "Dev");
  assert.deepEqual(
    answer.result.targets.map((target) => target.name),
    ["Prod", "A connection", "A connection"]
  );
  assert.doesNotMatch(JSON.stringify(answer), /shop_/);
  agent.stop();
});

test("a connection that is not shared is refused without asking the server", async () => {
  const { agent, app, pass, site } = rig({ loaded: SAVED, shared: [2] });
  site.jobs.push(SCHEMAS_JOB, COMPARE_JOB);
  agent.start();
  await pass(0);
  assert.deepEqual(site.answers(7), [{ refusal: "not-shared" }]);
  assert.deepEqual(site.answers(8), [{ refusal: "not-shared" }], "one side not shared is enough");
  assert.ok(!app.calls.some((call) => call.path.startsWith("/api/lineage") || call.path.startsWith("/api/compare")));
  agent.stop();
});

test("sharing is read for each question, so unsharing counts at once", async () => {
  const { agent, pass, sharing, site } = rig({ loaded: SAVED });
  agent.start();
  await pass(0);
  sharing.ids = [];
  site.jobs.push(SCHEMAS_JOB);
  await pass(IDLE_POLL_MS);
  assert.deepEqual(site.answers(7), [{ refusal: "not-shared" }]);
  agent.stop();
});

test("nothing from the site can make this computer do anything else", async () => {
  const jobs = [
    { id: 20, method: "deploy.start", params: { connectionId: 1 } },
    { id: 21, method: "session.cancel", params: { connectionId: 1, pid: 7 } },
    { id: 22, method: "drift.check", params: { trackedSchemaId: 1 } },
    { id: 23, method: "drift.acknowledge", params: { trackedSchemaId: 1 } },
    { id: 24, method: "approvals.decide", params: {} },
    { id: 25, method: "connections.list" },
    { id: 26, method: "schema.read", params: { connectionId: 1, schema: "public" } },
    { id: 27, method: "live.read", params: { connectionId: 1 } },
    { id: 28, method: "hello" },
    { id: 29, method: "no-such-method" },
    { id: 30 },
    { id: 31, method: "schemas.list" },
    { id: 32, method: "schemas.list", params: { connectionId: "1" } },
    { id: 33, method: "compare.run", params: { source: { connectionId: 1 }, targets: [] } },
  ];
  const { agent, app, pass, site } = rig({ loaded: SAVED, shared: [1, 2] });
  site.jobs.push(...jobs);
  agent.start();
  // A few at a time, since a slow one must not stop the asking.
  await pass(BUSY_POLL_MS * jobs.length);
  for (const job of jobs) assert.deepEqual(site.answers(job.id), [{ refusal: "bad-request" }], String(job.method));
  assert.deepEqual(
    app.calls.map((call) => call.path),
    ["/api/connections/phone"],
    "only the list of what is shared, and no question reached the server"
  );
  agent.stop();
});

test("readCloudJob lets through only the two questions, and copies only what they hold", () => {
  assert.deepEqual(readCloudJob("schemas.list", { connectionId: 1 }), { id: 1, method: "schemas.list", params: { connectionId: 1 } });
  assert.deepEqual(readCloudJob("compare.run", COMPARE_JOB.params), { id: 1, method: "compare.run", params: COMPARE_JOB.params });
  for (const [method, params] of [
    ["connections.list", undefined],
    ["deploy.start", { connectionId: 1 }],
    [undefined, undefined],
    [7, {}],
    ["schemas.list", { connectionId: -1 }],
    ["compare.run", { source: { connectionId: 1, schema: "public" }, targets: new Array(50).fill({ connectionId: 2, schema: "public" }) }],
    ["compare.run", { source: { connectionId: 1, schema: "x".repeat(20_000) }, targets: [] }],
  ] as const) {
    assert.equal(readCloudJob(method, params), null, String(method));
  }
});

test("a refusal is one word, and the server's own words stay on this computer", async () => {
  const cases: [AppAnswer | Error, string][] = [
    [{ status: 401, json: { error: `Sign in at ${HOST}` } }, "signed-out"],
    [{ status: 403, json: { error: `No access to ${HOST}` } }, "forbidden"],
    [{ status: 404, json: { error: `Nothing at ${HOST}` } }, "not-found"],
    [{ status: 502, json: { error: `Could not reach ${HOST}` } }, "unreachable"],
    [{ status: 500, json: { error: `Stack trace naming ${HOST}` } }, "failed"],
    [new Error(`connect ECONNREFUSED ${HOST}`), "no-answer"],
    // Comes back in a shape the phone link cannot read.
    [{ status: 200, json: { source: `postgres://${HOST}` } }, "failed"],
  ];
  for (const [answer, word] of cases) {
    const { agent, pass, site } = rig({ loaded: SAVED, app: { "POST /api/compare/phone": answer } });
    site.jobs.push(COMPARE_JOB);
    agent.start();
    await pass(0);
    assert.deepEqual(site.answers(8), [{ refusal: word }]);
    assert.ok(!JSON.stringify(site.calls.map((call) => call.body)).includes(HOST), word);
    agent.stop();
  }
});

test("an answer too big to send is refused here, rather than turned away by the site", async () => {
  const name = "s".repeat(128);
  const count = Math.ceil(MAX_ANSWER_BYTES / name.length) + 1;
  const schemas = Array.from({ length: count }, (_, index) => `${String(index).padStart(8, "0")}${name.slice(8)}`);
  const { agent, pass, site } = rig({
    loaded: SAVED,
    app: { "GET /api/lineage/schemas?connectionId=1": { status: 200, json: { schemas } } },
  });
  site.jobs.push(SCHEMAS_JOB);
  agent.start();
  await pass(0);
  assert.deepEqual(site.answers(7), [{ refusal: "too-big" }]);
  agent.stop();
});

test("a question that takes too long gets its own word, so the person hears why", async () => {
  const app = fakeApp();
  const call: AppCaller = (method, target, body, signal) => {
    if (target === "/api/connections/phone") return app.call(method, target, body, signal);
    return new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("Stopped."))));
  };
  const { agent, pass, site } = rig({ loaded: SAVED, call, jobLimitMs: 5 });
  site.jobs.push(COMPARE_JOB);
  agent.start();
  await pass(0);
  // This limit runs on a real timer, so a busy machine can reach it at any point
  // from here on. The word it answers with is the proof that it was the limit.
  for (let tries = 0; tries < 200 && site.answers(8).length === 0; tries += 1) {
    await realWait(10);
    await settle();
  }
  assert.deepEqual(site.answers(8), [{ refusal: "too-slow" }]);
  agent.stop();
});

test(`no more than ${MOST_JOBS_AT_ONCE} questions run at once, and the asking picks up when one finishes`, async () => {
  const app = fakeApp();
  const waiting: (() => void)[] = [];
  const call: AppCaller = (method, target, body, signal) => {
    if (target === "/api/connections/phone") return app.call(method, target, body, signal);
    return new Promise((resolve) => waiting.push(() => resolve({ status: 200, json: { schemas: ["public"] } })));
  };
  const { agent, pass, site } = rig({ loaded: SAVED, call });
  const count = MOST_JOBS_AT_ONCE + 2;
  site.jobs.push(...Array.from({ length: count }, (_, index) => ({ ...SCHEMAS_JOB, id: 100 + index })));
  agent.start();
  await pass(0);
  assert.equal(waiting.length, MOST_JOBS_AT_ONCE);
  assert.equal(site.count(NEXT), MOST_JOBS_AT_ONCE);

  await pass(BUSY_POLL_MS * 5);
  assert.equal(site.count(NEXT), MOST_JOBS_AT_ONCE, "full up, so nothing more is picked up");

  waiting.shift()?.();
  await pass(BUSY_POLL_MS);
  assert.deepEqual(site.answers(100), [{ result: { schemas: ["public"] } }]);
  assert.equal(waiting.length, MOST_JOBS_AT_ONCE);
  assert.equal(site.count(NEXT), MOST_JOBS_AT_ONCE + 1);
  agent.stop();
  waiting.forEach((release) => release());
});

test("stopping drops an answer still being worked out, and stops the asking", async () => {
  const app = fakeApp();
  const late = held<AppAnswer>();
  const call: AppCaller = (method, target, body, signal) => {
    if (target === "/api/connections/phone") return app.call(method, target, body, signal);
    return late.promise;
  };
  const { agent, pass, site, store } = rig({ loaded: SAVED, call });
  site.jobs.push(SCHEMAS_JOB);
  agent.start();
  await pass(0);
  agent.stop();
  late.release({ status: 200, json: { schemas: ["public"] } });
  const asked = site.count(NEXT);
  await pass(IDLE_POLL_MS * 4);
  assert.deepEqual(site.answers(7), []);
  assert.equal(site.count(NEXT), asked);
  assert.equal(store.removed, 0, "the saved link stays for the next start");
});

// ----- The shared list -----

test("the site hears only each shared connection's id and name", async () => {
  const { agent, pass, site } = rig({ loaded: SAVED });
  agent.start();
  await pass(0);
  assert.deepEqual(site.of(PUBLISH)[0].body, {
    connections: [
      { id: 1, name: "Dev" },
      { id: 2, name: "Prod" },
    ],
  });
  const sent = JSON.stringify(site.calls.map((call) => call.body));
  for (const secret of ["shop_dev", "shop_prod", "shop_staging", HOST, "Not shared"]) assert.ok(!sent.includes(secret), secret);
  agent.stop();
});

test("with nothing shared the site hears that without asking the server, so it works with nobody signed in", async () => {
  const { agent, app, pass, site } = rig({ loaded: SAVED, shared: [] });
  agent.start();
  await pass(0);
  assert.deepEqual(site.of(PUBLISH)[0].body, { connections: [] });
  assert.deepEqual(app.calls, []);
  agent.stop();
});

test("the list goes again every 5 minutes, so a renamed connection catches up", async () => {
  const { agent, app, pass, site } = rig({ loaded: SAVED });
  agent.start();
  await pass(0);
  app.routes["GET /api/connections/phone"] = {
    status: 200,
    json: { connections: [{ id: 1, name: "Renamed", database: "shop_dev" }] },
  };
  await pass(PUBLISH_EVERY_MS);
  assert.equal(site.count(PUBLISH), 2);
  assert.deepEqual(site.of(PUBLISH)[1].body, { connections: [{ id: 1, name: "Renamed" }] });
  agent.stop();
});

test("a change to what is shared goes at once, and no change sends nothing", async () => {
  const { agent, pass, sharing, site } = rig({ loaded: SAVED, shared: [2, 1] });
  agent.start();
  await pass(0);
  assert.equal(site.count(PUBLISH), 1);

  agent.sharedChanged();
  await settle();
  assert.equal(site.count(PUBLISH), 1, "the same ids in another order are no change");

  sharing.ids = [1];
  agent.sharedChanged();
  await settle();
  assert.equal(site.count(PUBLISH), 2);
  assert.deepEqual(site.of(PUBLISH)[1].body, { connections: [{ id: 1, name: "Dev" }] });
  agent.stop();
});

test("a change while the list is on its way sends the list again after", async () => {
  const { agent, pass, sharing, site } = rig({ loaded: SAVED });
  const slow = held<SiteAnswer>();
  site.set(PUBLISH, slow.promise);
  agent.start();
  await pass(0);
  assert.equal(site.count(PUBLISH), 1);

  sharing.ids = [2];
  agent.sharedChanged();
  site.set(PUBLISH, null);
  slow.release({ status: 200, body: { ok: true } });
  await settle();
  assert.equal(site.count(PUBLISH), 2);
  assert.deepEqual(site.of(PUBLISH)[1].body, { connections: [{ id: 2, name: "Prod" }] });
  agent.stop();
});

test("sharedChanged does nothing until linked", async () => {
  const { agent, pass, site } = rig();
  agent.start();
  agent.sharedChanged();
  await pass(0);
  assert.equal(site.calls.length, 0);
});

test("with nobody signed in here the site keeps the list it has, until someone signs in", async () => {
  const { agent, app, pass, site, store } = rig({
    loaded: SAVED,
    app: { "GET /api/connections/phone": { status: 401, json: { error: "Sign in." } } },
  });
  newLogLines();
  agent.start();
  await pass(0);
  assert.equal(site.count(PUBLISH), 0);
  assert.equal(agent.view().state, "linked");
  assert.equal(store.removed, 0);
  assert.ok(!newLogLines().includes("which connections are shared"), "being signed out is ordinary");

  app.routes["GET /api/connections/phone"] = { status: 200, json: { connections: CONNECTION_ROWS } };
  await pass(PUBLISH_EVERY_MS);
  assert.equal(site.count(PUBLISH), 1);
  agent.stop();
});

test("a site that fails to take the list does not end the link, and hears again later", async () => {
  const { agent, pass, site, store } = rig({ loaded: SAVED });
  site.set(PUBLISH, { status: 500 });
  agent.start();
  await pass(0);
  assert.equal(site.count(PUBLISH), 1);
  assert.equal(agent.view().state, "linked");
  site.set(PUBLISH, null);
  agent.sharedChanged();
  await settle();
  assert.equal(site.count(PUBLISH), 2, "the site never heard, so it is told");
  assert.equal(store.removed, 0);
  agent.stop();
});

// ----- Unlinking -----

test("unlinking tells the site, removes the saved link, and stops the asking", async () => {
  const { agent, pass, site, store } = rig({ loaded: SAVED });
  agent.start();
  await pass(0);
  agent.unlink();
  await settle();
  assert.equal(site.count(SELF), 1);
  assert.equal(store.removed, 1);
  const view = agent.view();
  assert.ok(view.state === "off");
  assert.equal(view.notice, null);
  assert.equal(view.origin, ORIGIN, "the address stays filled in");

  const asked = site.count(NEXT);
  const published = site.count(PUBLISH);
  await pass(PUBLISH_EVERY_MS * 2);
  assert.equal(site.count(NEXT), asked);
  assert.equal(site.count(PUBLISH), published);
});

test("unlinking works with the site out of reach or the file stuck", async () => {
  const { agent, pass, site, store } = rig({ loaded: SAVED });
  agent.start();
  await pass(0);
  site.set(SELF, new TypeError("fetch failed"));
  store.failRemove = true;
  agent.unlink();
  await settle();
  assert.equal(agent.view().state, "off");
});

test("a computer can link again after unlinking", async () => {
  const { agent, pass, site } = rig({ loaded: SAVED });
  agent.start();
  await pass(0);
  agent.unlink();
  await settle();
  assert.deepEqual(await agent.startLink(ORIGIN), { ok: true });
  site.set(CLAIM, APPROVED);
  await pass(3_000);
  assert.equal(agent.view().state, "linked");
  agent.stop();
});

// ----- The two-way sync -----

const SYNC = "GET /api/agent/sync";
const SYNC_AFTER = `${SYNC}?rev=r1`;
const WRITE = "/api/agent/sync/connections";
/** A connection the site keeps. Made up, and with no password: the repo is public. */
const SITE_ROW = { id: 31, name: "Shop", host: "db.example.com", version: 4 };
/** The person's role on the site, as it comes with each changed list. */
const SITE_ROLE: SiteRole = { role: "editor", label: "Editor", permissions: ["connections:read", "connections:update"] };
const LISTED: SiteAnswer = {
  status: 200,
  body: { same: false, rev: "r1", withSecrets: true, connections: [SITE_ROW], role: SITE_ROLE },
};
const SAME: SiteAnswer = { status: 200, body: { same: true, rev: "r1" } };
/** A new connection whose database is out on the internet, so the site decides. */
const OUT_THERE = { name: "Shop", host: "db.example.com", port: 5432, database_name: "shop", username: "shop_owner" };
const AT_HOME = { ...OUT_THERE, host: "localhost" };

/** Plays this computer's server's side of the sync. */
function fakeSync(own: OwnConnection[] = [
  { id: 1, name: "Dev" },
  { id: 3, name: "Laptop" },
]) {
  const applied: unknown[][] = [];
  const roles: (SiteRole | null)[] = [];
  const adopted: [number, number, number][] = [];
  const state = { own, exported: new Map<number, Record<string, unknown>>(), failApply: false };
  const host: SyncHost = {
    apply: async (connections, role) => {
      if (state.failApply) throw new Error("The disk is full.");
      applied.push([...connections]);
      roles.push(role);
    },
    local: async () => state.own.map((row) => ({ ...row })),
    export: async (id) => state.exported.get(id) ?? null,
    adopt: async (id, siteId, siteVersion) => {
      adopted.push([id, siteId, siteVersion]);
      return true;
    },
  };
  return { host, applied, roles, adopted, state };
}

/** A linked computer with the sync, its first sync done. */
async function synced() {
  const sync = fakeSync();
  const r = rig({ loaded: SAVED, sync: sync.host });
  r.site.set(SYNC, LISTED);
  r.site.set(SYNC_AFTER, SAME);
  r.agent.start();
  await r.pass(0);
  return { ...r, sync };
}

test("the site's connections come down after a poll, and later asks carry the site's mark", async () => {
  const { agent, clock, pass, site, sync } = await synced();
  assert.deepEqual(sync.applied, [[SITE_ROW]]);
  const status = agent.syncStatus();
  assert.ok(status.linked);
  assert.equal(status.online, true);
  assert.equal(status.orgName, "Acme Data");
  assert.equal(status.lastSyncedAt, clock.time);
  const changedAt = status.changedAt;
  assert.equal(changedAt, clock.time);
  // The site now hears of every connection here, each marked shared or not, through this computer's own token.
  assert.deepEqual(site.of(PUBLISH).at(-1)?.body, {
    connections: [
      { id: 1, name: "Dev", shared: true },
      { id: 3, name: "Laptop", shared: false },
    ],
  });
  assert.equal(site.of(SYNC)[0].init.redirect, "error");
  assert.equal((site.of(SYNC)[0].init.headers as Record<string, string>).Authorization, `Bearer ${TOKEN}`);

  await pass(SYNC_EVERY_MS - 1);
  assert.equal(site.count(SYNC_AFTER), 0, "not more often than every 15 seconds");
  await pass(IDLE_POLL_MS);
  assert.equal(site.count(SYNC_AFTER), 1);
  assert.equal(sync.applied.length, 1, "an unchanged list is not applied again");
  assert.equal(agent.syncStatus().changedAt, changedAt);
  agent.stop();
});

test("a connection added, renamed or deleted here reaches the site's list at the next sync, and nothing goes when nothing changed", async () => {
  const { agent, pass, site, sync } = await synced();
  const before = site.count(PUBLISH);
  await pass(IDLE_POLL_MS);
  assert.equal(site.count(PUBLISH), before);
  sync.state.own = [...sync.state.own, { id: 4, name: "Scratch" }];
  await pass(IDLE_POLL_MS);
  assert.equal(site.count(PUBLISH), before + 1);
  assert.equal((site.of(PUBLISH).at(-1)?.body as { connections: unknown[] }).connections.length, 3);
  agent.stop();
});

test("a site without the sync keeps everything here, and is asked again only after half an hour", async () => {
  const sync = fakeSync();
  const { agent, pass, site } = rig({ loaded: SAVED, sync: sync.host });
  site.set(SYNC, { status: 404 });
  agent.start();
  await pass(0);
  assert.equal(site.count(SYNC), 1);
  assert.deepEqual(agent.syncStatus(), { linked: false, changedAt: null });
  assert.deepEqual(await agent.syncCreate(OUT_THERE), {
    kind: "local",
    reason: "The linked website does not share connections yet, so this was saved on this computer only.",
  });
  assert.equal(site.count(`POST ${WRITE}`), 0);
  assert.equal(sync.applied.length, 0);
  // The old list, of shared connections only, still goes.
  assert.deepEqual((site.of(PUBLISH).at(-1)?.body as { connections: unknown[] }).connections, [
    { id: 1, name: "Dev" },
    { id: 2, name: "Prod" },
  ]);
  await pass(NO_SYNC_RETRY_MS - 1);
  assert.equal(site.count(SYNC), 1);
  await pass(IDLE_POLL_MS);
  assert.equal(site.count(SYNC), 2);
  agent.stop();
});

test("a 401 to the sync ends the link and clears the site's connections from this computer", async () => {
  const sync = fakeSync();
  const { agent, pass, site, store } = rig({ loaded: SAVED, sync: sync.host });
  site.set(SYNC, { status: 401 });
  agent.start();
  await pass(0);
  assert.equal(agent.view().state, "off");
  assert.equal(store.removed, 1);
  assert.deepEqual(sync.applied, [[]]);
  assert.deepEqual(sync.roles, [null], "the website role goes with the link");
  assert.deepEqual(agent.syncStatus(), { linked: false, changedAt: agent.syncStatus().changedAt });
  assert.notEqual(agent.syncStatus().changedAt, null);
});

test("a list from the site that cannot be read changes nothing here", async () => {
  const sync = fakeSync();
  const { agent, pass, site } = rig({ loaded: SAVED, sync: sync.host });
  newLogLines();
  site.set(SYNC, { status: 200, body: { same: false, rev: "r1", connections: "everything" } });
  agent.start();
  await pass(0);
  assert.equal(sync.applied.length, 0);
  assert.equal(agent.syncStatus().changedAt, null);
  assert.match(newLogLines(), /Could not bring the site's connections up to date: Error\./);
  agent.stop();
});

test("the person's website role comes down with the list, and Settings shows how the sync stands", async () => {
  const { agent, changes, clock, pass, site, sync } = await synced();
  assert.deepEqual(sync.roles, [SITE_ROLE]);
  const view = agent.view();
  assert.equal(view.state, "linked");
  assert.deepEqual(view.state === "linked" && view.sync, { role: "Editor", lastSyncedAt: clock.time, website: 1, here: 2 });
  // A new role comes with the next changed list; an unchanged one sends nothing.
  const before = changes.count;
  const viewer: SiteRole = { role: "viewer", label: "Viewer", permissions: ["connections:read"] };
  site.set(SYNC_AFTER, { status: 200, body: { same: false, rev: "r2", connections: [], role: viewer } });
  await pass(IDLE_POLL_MS);
  assert.deepEqual(sync.roles, [SITE_ROLE, viewer]);
  const later = agent.view();
  assert.deepEqual(later.state === "linked" && later.sync, { role: "Viewer", lastSyncedAt: clock.time, website: 0, here: 2 });
  assert.ok(changes.count > before, "Settings hears of each sync");
  agent.stop();
});

test("a changed list without the person's website role, or with one that cannot be read, changes nothing here", async () => {
  for (const role of [undefined, null, "editor", { role: "", label: "Editor", permissions: [] }, { ...SITE_ROLE, permissions: "all" }]) {
    const sync = fakeSync();
    const { agent, pass, site } = rig({ loaded: SAVED, sync: sync.host });
    newLogLines();
    site.set(SYNC, { status: 200, body: { same: false, rev: "r1", connections: [SITE_ROW], role } });
    agent.start();
    await pass(0);
    assert.equal(sync.applied.length, 0, JSON.stringify(role));
    assert.equal(agent.syncStatus().changedAt, null);
    const view = agent.view();
    assert.deepEqual(view.state === "linked" && view.sync, { role: null, lastSyncedAt: null, website: null, here: null });
    assert.match(newLogLines(), /Could not bring the site's connections up to date/);
    agent.stop();
  }
});

test("a start with no saved link clears any copies, and website role, an earlier unlink left behind", async () => {
  const sync = fakeSync();
  const { agent, pass, site } = rig({ sync: sync.host });
  agent.start();
  await pass(0);
  assert.deepEqual(sync.applied, [[]]);
  assert.deepEqual(sync.roles, [null]);
  assert.equal(site.calls.length, 0);
  // When this computer's server cannot do it, the next start tries again, with no warning.
  const failing = fakeSync();
  failing.state.failApply = true;
  const second = rig({ sync: failing.host });
  newLogLines();
  second.agent.start();
  await second.pass(0);
  const lines = newLogLines();
  assert.match(lines, /Trying again at the next start/);
  assert.match(lines, /\] info Could not check this computer/);
  assert.doesNotMatch(lines, /\] warn /);
});

test("readSiteRole takes the site's role and turns away anything else", () => {
  assert.deepEqual(readSiteRole({ role: " editor ", label: " ", permissions: ["a"] }), { role: "editor", label: "editor", permissions: ["a"] });
  assert.deepEqual(readSiteRole(SITE_ROLE), SITE_ROLE);
  for (const bad of [
    null,
    [],
    "editor",
    { role: "", label: "x", permissions: [] },
    { role: "x".repeat(65), label: "x", permissions: [] },
    { role: "editor", label: 4, permissions: [] },
    { role: "editor", label: "x".repeat(101), permissions: [] },
    { role: "editor", label: "x", permissions: "all" },
    { role: "editor", label: "x", permissions: Array.from({ length: 201 }, () => "a") },
    { role: "editor", label: "x", permissions: [7] },
    { role: "editor", label: "x", permissions: ["x".repeat(65)] },
  ]) {
    assert.equal(readSiteRole(bad), null, JSON.stringify(bad));
  }
});

test("unlinking clears the site's connections from this computer", async () => {
  const { agent, site, sync } = await synced();
  agent.unlink();
  await settle();
  assert.equal(site.count(SELF), 1);
  assert.deepEqual(sync.applied.at(-1), []);
  assert.equal(sync.roles.at(-1), null, "the website role goes with the link");
  assert.equal(agent.view().state, "off");
  assert.deepEqual(agent.syncStatus(), { linked: false, changedAt: agent.syncStatus().changedAt });
});

test("a new connection at a home address stays here without the site hearing of it", async () => {
  const { agent, site } = await synced();
  const before = site.calls.length;
  assert.deepEqual(await agent.syncCreate(AT_HOME), {
    kind: "local",
    reason: "Its address only works on this computer, so it stays here, password and all.",
  });
  assert.deepEqual(await agent.syncCreate({ ...OUT_THERE, connection_string: "postgres://u@127.0.0.1/app" }), {
    kind: "local",
    reason: "Its address only works on this computer, so it stays here, password and all.",
  });
  assert.equal(site.calls.length, before);
  agent.stop();
});

test("a new connection the site can reach is kept there, and comes down at once", async () => {
  const { agent, site, sync } = await synced();
  site.set(`POST ${WRITE}`, { status: 200, body: { saved: true, connection: { id: 40, version: 1 } } });
  site.set(SYNC_AFTER, { status: 200, body: { same: false, rev: "r2", connections: [SITE_ROW, { id: 40 }], role: SITE_ROLE } });
  assert.deepEqual(await agent.syncCreate(OUT_THERE), { kind: "saved", body: { id: 40, version: 1 } });
  assert.deepEqual(site.of(`POST ${WRITE}`)[0].body, OUT_THERE);
  assert.deepEqual(sync.applied.at(-1), [SITE_ROW, { id: 40 }]);
  agent.stop();
});

test("a new connection the site cannot reach stays here, with the site's words", async () => {
  const { agent, site } = await synced();
  site.set(`POST ${WRITE}`, { status: 200, body: { saved: false, reason: "The website could not reach that database." } });
  assert.deepEqual(await agent.syncCreate(OUT_THERE), { kind: "local", reason: "The website could not reach that database." });
  agent.stop();
});

test("a refusal from the site is passed on as it is, so the screen can say why", async () => {
  const { agent, site } = await synced();
  site.set(`POST ${WRITE}`, { status: 403, body: { error: "Viewers cannot add connections." } });
  assert.deepEqual(await agent.syncCreate(OUT_THERE), { kind: "refused", status: 403, body: { error: "Viewers cannot add connections." } });
  agent.stop();
});

test("with the site out of reach, a new connection is saved here only, and changes to the site's are not made", async () => {
  const { agent, site } = await synced();
  site.set(`POST ${WRITE}`, new TypeError("fetch failed"));
  const added = await agent.syncCreate(OUT_THERE);
  assert.equal(added.kind, "local");
  assert.match(added.kind === "local" ? added.reason : "", /Send to website/);
  const status = agent.syncStatus();
  assert.ok(status.linked);
  assert.equal(status.online, false);

  // Once the site is known to be down, a new connection does not even try.
  const tries = site.count(`POST ${WRITE}`);
  assert.equal((await agent.syncCreate(OUT_THERE)).kind, "local");
  assert.equal(site.count(`POST ${WRITE}`), tries);

  site.set(`PUT ${WRITE}`, new TypeError("fetch failed"));
  assert.deepEqual(await agent.syncUpdate(31, { name: "Shop 2", base_version: 4 }), {
    kind: "offline",
    message: "The website cannot be reached right now, so nothing was changed. Try again once it is back.",
  });
  agent.stop();
});

test("a host's error page counts as the site being out of reach, not as its answer", async () => {
  const { agent, site } = await synced();
  site.set(`PUT ${WRITE}`, { status: 502, body: "Bad gateway" });
  assert.equal((await agent.syncUpdate(31, { name: "Shop 2", base_version: 4 })).kind, "offline");
  site.set(`PUT ${WRITE}`, { status: 503, body: { error: "Could not check your access." } });
  assert.deepEqual(await agent.syncUpdate(31, { name: "Shop 2", base_version: 4 }), {
    kind: "refused",
    status: 503,
    body: { error: "Could not check your access." },
  });
  agent.stop();
});

test("a change to one of the site's connections goes to the site with its number, and a stale one comes back as a conflict", async () => {
  const { agent, site, sync } = await synced();
  site.set(SYNC_AFTER, { status: 200, body: { same: false, rev: "r2", connections: [{ ...SITE_ROW, name: "Shop 2", version: 5 }], role: SITE_ROLE } });
  const saved = await agent.syncUpdate(31, { name: "Shop 2", base_version: 4, id: 99 });
  assert.equal(saved.kind, "saved");
  assert.deepEqual(site.of(`PUT ${WRITE}`)[0].body, { name: "Shop 2", base_version: 4, id: 31 });
  assert.deepEqual(sync.applied.at(-1), [{ ...SITE_ROW, name: "Shop 2", version: 5 }]);

  const current = { ...SITE_ROW, name: "Shop 3", version: 6 };
  site.set(`PUT ${WRITE}`, { status: 409, body: { error: "Someone else changed it.", conflict: true, current } });
  assert.deepEqual(await agent.syncUpdate(31, { name: "Shop 2b", base_version: 5 }), {
    kind: "refused",
    status: 409,
    body: { error: "Someone else changed it.", conflict: true, current },
  });
  agent.stop();
});

test("deleting one of the site's connections sends only its number, version and the confirmation", async () => {
  const { agent, site } = await synced();
  assert.equal((await agent.syncRemove(31, 4, true)).kind, "saved");
  assert.deepEqual(site.of(`DELETE ${WRITE}`)[0].body, { id: 31, base_version: 4, confirm: true });
  agent.stop();
});

test("Send to website moves one of this computer's connections up, and the row here becomes the site's copy", async () => {
  const { agent, site, sync } = await synced();
  sync.state.exported.set(3, OUT_THERE);
  site.set(`POST ${WRITE}`, { status: 200, body: { saved: true, connection: { id: 40, version: 1 } } });
  const before = site.count(PUBLISH);
  assert.deepEqual(await agent.syncSendUp(3), { kind: "saved", body: { id: 40, version: 1 } });
  await settle();
  assert.deepEqual(site.of(`POST ${WRITE}`)[0].body, OUT_THERE);
  assert.deepEqual(sync.adopted, [[3, 40, 1]]);
  assert.ok(site.count(PUBLISH) > before);
  agent.stop();
});

test("Send to website keeps a home connection here, and says so for one that is gone", async () => {
  const { agent, site, sync } = await synced();
  sync.state.exported.set(3, AT_HOME);
  assert.equal((await agent.syncSendUp(3)).kind, "local");
  assert.deepEqual(await agent.syncSendUp(9), {
    kind: "refused",
    status: 404,
    body: { error: "That connection is no longer on this computer." },
  });
  assert.equal(site.count(`POST ${WRITE}`), 0);
  assert.deepEqual(sync.adopted, []);
  agent.stop();
});

test("Send to website leaves the row here as it was when the site cannot reach the database", async () => {
  const { agent, site, sync } = await synced();
  sync.state.exported.set(3, OUT_THERE);
  site.set(`POST ${WRITE}`, { status: 200, body: { saved: false, reason: "The website could not reach that database." } });
  assert.deepEqual(await agent.syncSendUp(3), { kind: "local", reason: "The website could not reach that database." });
  assert.deepEqual(sync.adopted, []);
  agent.stop();
});

test("with no link, or no sync, everything stays on this computer", async () => {
  const sync = fakeSync();
  const off = rig({ sync: sync.host });
  off.agent.start();
  assert.deepEqual(off.agent.syncStatus(), { linked: false, changedAt: null });
  assert.deepEqual(await off.agent.syncCreate(OUT_THERE), { kind: "not-linked" });
  assert.deepEqual(await off.agent.syncUpdate(31, {}), { kind: "not-linked" });
  assert.deepEqual(await off.agent.syncRemove(31, 4, true), { kind: "not-linked" });
  assert.deepEqual(await off.agent.syncSendUp(3), { kind: "not-linked" });
  assert.equal(off.site.calls.length, 0);

  const without = rig({ loaded: SAVED });
  without.agent.start();
  await without.pass(0);
  assert.deepEqual(without.agent.syncStatus(), { linked: false, changedAt: null });
  assert.equal(without.site.count(SYNC), 0);
  without.agent.stop();
});

test("changes run one at a time, in the order they were asked for", async () => {
  const { agent, site } = await synced();
  const first = held<SiteAnswer>();
  site.set(`PUT ${WRITE}`, first.promise);
  const one = agent.syncUpdate(31, { name: "A", base_version: 4 });
  const two = agent.syncRemove(31, 5, true);
  await settle();
  assert.equal(site.count(`DELETE ${WRITE}`), 0, "the delete waits for the change before it");
  first.release({ status: 200, body: { saved: true } });
  assert.equal((await one).kind, "saved");
  assert.equal((await two).kind, "saved");
  assert.equal(site.count(`DELETE ${WRITE}`), 1);
  agent.stop();
});

test("readOwnConnections keeps only well-formed rows, cut to size, and throws on anything else", () => {
  assert.deepEqual(
    readOwnConnections({
      connections: [
        { id: 1, name: "Dev", host: "kept out" },
        { id: "2", name: "Bad" },
        { id: 3, name: "x".repeat(300) },
        null,
      ],
    }),
    [
      { id: 1, name: "Dev" },
      { id: 3, name: "x".repeat(200) },
    ],
  );
  assert.throws(() => readOwnConnections({ connections: "all" }));
  assert.throws(() => readOwnConnections(null));
});

// ----- Drift results in the sync -----

const DRIFT = "GET /api/agent/sync/drift";
const DRIFT_AFTER = `${DRIFT}?rev=d1`;
const AT = "2026-11-08T10:00:00.000Z";
const CHECK = { status: "drifted", summary: "1 table added", checkedAt: AT, source: "scheduled", acknowledged: false };
/** One schema the site watches. Made up. */
const SITE_DRIFT = {
  connectionId: 31,
  connectionName: "Shop",
  schema: "public",
  label: null,
  intervalMinutes: 60,
  lastCheckedAt: AT,
  checks: [CHECK],
};
const DRIFT_LISTED: SiteAnswer = {
  status: 200,
  body: { same: false, rev: "d1", allowed: true, orgSlug: "acme-data", schemas: [SITE_DRIFT] },
};
const DRIFT_SAME: SiteAnswer = { status: 200, body: { same: true, rev: "d1" } };

/** A linked computer with the sync, its first sync done, and a site that keeps drift results. */
async function syncedWithDrift(sync = fakeSync()) {
  const r = rig({ loaded: SAVED, sync: sync.host });
  r.site.set(SYNC, LISTED);
  r.site.set(SYNC_AFTER, SAME);
  r.site.set(DRIFT, DRIFT_LISTED);
  r.site.set(DRIFT_AFTER, DRIFT_SAME);
  r.agent.start();
  await r.pass(0);
  return { ...r, sync };
}

test("the site's drift results come down once the site has shown it syncs, then every minute with the site's mark", async () => {
  const { agent, clock, pass, site } = await syncedWithDrift();
  // Not with the very first sync: a site from before the sync would be asked for something it does not have.
  assert.equal(site.count(DRIFT), 0);
  assert.deepEqual(agent.driftStatus(), {
    linked: true,
    origin: ORIGIN,
    orgName: "Acme Data",
    orgSlug: "acme-data",
    online: true,
    syncedAt: null,
    allowed: false,
    schemas: null,
  });

  await pass(IDLE_POLL_MS);
  assert.equal(site.count(DRIFT), 1);
  assert.equal((site.of(DRIFT)[0].init.headers as Record<string, string>).Authorization, `Bearer ${TOKEN}`);
  const status = agent.driftStatus();
  assert.ok(status.linked);
  assert.equal(status.allowed, true);
  assert.equal(status.syncedAt, clock.time);
  assert.deepEqual(status.schemas, [SITE_DRIFT]);

  await pass(IDLE_POLL_MS * 2);
  assert.equal(site.count(DRIFT_AFTER), 0, "not more often than every minute");
  await pass(DRIFT_EVERY_MS);
  assert.equal(site.count(DRIFT_AFTER), 1);
  const later = agent.driftStatus();
  assert.ok(later.linked);
  assert.deepEqual(later.schemas, [SITE_DRIFT], "an unchanged answer keeps the results");
  const firstSyncedAt = status.syncedAt ?? 0;
  assert.ok((later.syncedAt ?? 0) >= firstSyncedAt + DRIFT_EVERY_MS, "moved on by the answer that said nothing changed");
  assert.ok((later.syncedAt ?? 0) <= clock.time);
  agent.stop();
});

test("the Drift page asks again when the results are more than a few seconds old, and two asks at once share one call", async () => {
  const { agent, pass, site } = await syncedWithDrift();
  const [first, second] = await Promise.all([agent.websiteDrift(), agent.websiteDrift()]);
  assert.equal(site.count(DRIFT), 1);
  assert.ok(first.linked && second.linked);
  assert.deepEqual(first.schemas, [SITE_DRIFT]);
  assert.deepEqual(second.schemas, [SITE_DRIFT]);
  await agent.websiteDrift();
  assert.equal(site.count(DRIFT_AFTER), 0, "fresh results are not asked for again");
  await pass(DRIFT_FRESH_MS);
  await agent.websiteDrift();
  assert.equal(site.count(DRIFT_AFTER), 1);
  agent.stop();
});

test("someone whose website role may not see drift gets none, whatever the site sends", async () => {
  const { agent, site } = await syncedWithDrift();
  site.set(DRIFT, { status: 200, body: { same: false, rev: "d1", allowed: false, orgSlug: "acme-data", schemas: [SITE_DRIFT] } });
  const status = await agent.websiteDrift();
  assert.ok(status.linked);
  assert.equal(status.allowed, false);
  assert.deepEqual(status.schemas, []);
  agent.stop();
});

test("a site without the drift sync is asked again only after half an hour, and a failing one is logged once", async () => {
  const { agent, pass, site } = await syncedWithDrift();
  site.set(DRIFT, { status: 404 });
  await pass(IDLE_POLL_MS);
  assert.equal(site.count(DRIFT), 1);
  const status = agent.driftStatus();
  assert.ok(status.linked, "the connections still sync");
  assert.equal(status.schemas, null);
  assert.equal((await agent.websiteDrift()).linked, true);
  await pass(NO_SYNC_RETRY_MS - IDLE_POLL_MS);
  assert.equal(site.count(DRIFT), 1);

  newLogLines();
  site.set(DRIFT, { status: 503, body: { error: "made-up trouble" } });
  await pass(IDLE_POLL_MS * 2);
  assert.equal(site.count(DRIFT), 2);
  await pass(DRIFT_EVERY_MS);
  assert.equal(site.count(DRIFT), 3);
  const logged = newLogLines();
  const lines = logged.match(/Could not bring the site's drift results up to date: Error\./g) ?? [];
  assert.equal(lines.length, 1);
  assert.doesNotMatch(logged, /made-up trouble/);
  agent.stop();
});

test("a 401 to the drift ask ends the link, and unlinking forgets the site's drift results", async () => {
  const first = await syncedWithDrift();
  await first.agent.websiteDrift();
  first.agent.unlink();
  await settle();
  assert.deepEqual(first.agent.driftStatus(), { linked: false });

  const second = await syncedWithDrift();
  second.site.set(DRIFT, { status: 401 });
  await second.agent.websiteDrift();
  assert.equal(second.agent.view().state, "off");
  assert.deepEqual(second.agent.driftStatus(), { linked: false });
});

test("with no link, or no sync, there are no website drift results and nothing is asked", async () => {
  const unlinked = rig({ sync: fakeSync().host });
  assert.deepEqual(await unlinked.agent.websiteDrift(), { linked: false });
  const noSync = rig({ loaded: SAVED });
  noSync.agent.start();
  await noSync.pass(IDLE_POLL_MS * 5);
  assert.deepEqual(await noSync.agent.websiteDrift(), { linked: false });
  assert.equal(noSync.site.count(DRIFT), 0);
  noSync.agent.stop();
});

test("this computer's own drift results go to the site with its list, and a new result sends the list again", async () => {
  const OWN_DRIFT = [{ schema: "public", label: null, intervalMinutes: 0, lastCheckedAt: AT, checks: [CHECK] }];
  const sync = fakeSync([
    { id: 1, name: "Dev", drift: OWN_DRIFT },
    { id: 3, name: "Laptop" },
  ]);
  const { agent, pass, site } = await syncedWithDrift(sync);
  assert.deepEqual(site.of(PUBLISH).at(-1)?.body, {
    connections: [
      { id: 1, name: "Dev", shared: true, drift: OWN_DRIFT },
      { id: 3, name: "Laptop", shared: false },
    ],
  });
  const before = site.count(PUBLISH);
  await pass(IDLE_POLL_MS);
  assert.equal(site.count(PUBLISH), before, "nothing new, nothing sent");
  sync.state.own = [{ ...sync.state.own[0], drift: [{ ...OWN_DRIFT[0], checks: [{ ...CHECK, acknowledged: true }] }] }, sync.state.own[1]];
  await pass(IDLE_POLL_MS);
  assert.equal(site.count(PUBLISH), before + 1);
  agent.stop();
});

test("readOwnConnections passes a connection's drift list on, cut to size, and leaves out anything that is not a list", () => {
  const many = new Array(MOST_DRIFT_SCHEMAS + 10).fill({ schema: "a" });
  assert.deepEqual(
    readOwnConnections({
      connections: [
        { id: 1, name: "Dev", drift: [{ schema: "public" }] },
        { id: 2, name: "Bad", drift: "all of it" },
      ],
    }),
    [
      { id: 1, name: "Dev", drift: [{ schema: "public" }] },
      { id: 2, name: "Bad" },
    ],
  );
  assert.equal(readOwnConnections({ connections: [{ id: 1, name: "Dev", drift: many }] })[0].drift?.length, MOST_DRIFT_SCHEMAS);
});

test("readDriftAnswer keeps only well-formed schemas and checks, cut to size", () => {
  const answer = readDriftAnswer({
    same: false,
    rev: "d1",
    allowed: true,
    orgSlug: "acme-data",
    schemas: [
      { ...SITE_DRIFT, extra: "dropped", summary: "dropped" },
      { ...SITE_DRIFT, connectionId: "31" },
      { ...SITE_DRIFT, schema: "" },
      {
        ...SITE_DRIFT,
        label: "",
        intervalMinutes: -1,
        lastCheckedAt: "soon",
        checks: [{ ...CHECK, status: "on fire" }, { ...CHECK, checkedAt: "soon" }, { ...CHECK, summary: "x".repeat(1000), acknowledged: "yes" }, "x"],
      },
      "x",
    ],
  });
  assert.ok(answer?.results);
  assert.deepEqual(answer.results.schemas[0], SITE_DRIFT);
  assert.equal(answer.results.schemas.length, 2);
  const tidied = answer.results.schemas[1];
  assert.equal(tidied.label, null);
  assert.equal(tidied.intervalMinutes, 0);
  assert.equal(tidied.lastCheckedAt, null);
  assert.equal(tidied.checks.length, 1);
  assert.equal(tidied.checks[0].summary.length, 300);
  assert.equal(tidied.checks[0].acknowledged, false);

  assert.equal(readDriftAnswer({ same: false, rev: "d1", allowed: true, orgSlug: "../admin", schemas: [] })?.results?.orgSlug, null);
  assert.deepEqual(readDriftAnswer({ same: true, rev: "d1" }), { rev: "d1", results: null });
  assert.equal(readDriftAnswer({ same: false, rev: "d1", schemas: [] }), null);
  assert.equal(readDriftAnswer({ same: false, rev: "", allowed: true, schemas: [] }), null);
  assert.equal(readDriftAnswer("everything"), null);
});

// ----- The log -----

// The log's list of secrets lasts as long as the process, so each of these uses
// values no other test has used, or a line missing here would go unnoticed.

test("the token and the codes never reach the log, even from text that holds them by accident", async () => {
  newLogLines();
  const token = `ssa_${"a".repeat(43)}`;
  const deviceCode = "b".repeat(43);
  const { agent, pass, site } = rig();
  agent.start();
  site.set(START, { status: 201, body: { ...STARTED, deviceCode } });
  await agent.startLink(ORIGIN);
  site.set(CLAIM, new TypeError(`fetch failed for ${deviceCode}`));
  await pass(3_000);
  site.set(CLAIM, { status: 200, body: { token, org: { slug: "acme-data", name: "Acme Data" } } });
  await pass(3_000);
  assert.equal(agent.view().state, "linked");
  site.set(NEXT, new TypeError(`fetch failed for ${token}`));
  site.set(PUBLISH, new TypeError(`fetch failed for ${token}`));
  agent.sharedChanged();
  await pass(IDLE_POLL_MS);
  // A stray mistake elsewhere in the app.
  logWarn(`A stray line holding ${token} and ${deviceCode}.`);
  agent.stop();

  const lines = newLogLines();
  assert.match(lines, /A stray line/);
  for (const secret of [token, deviceCode, USER_CODE]) assert.ok(!lines.includes(secret), secret.slice(0, 6));
});

test("a token read back from the saved file is kept out of the log too", async () => {
  newLogLines();
  const token = `ssa_${"c".repeat(43)}`;
  const { agent } = rig({ loaded: { ...SAVED, values: { ...LINKED, token } } as LoadResult<CloudLinkState> });
  agent.start();
  logWarn(`A stray line holding ${token}.`);
  agent.stop();

  const lines = newLogLines();
  assert.match(lines, /A stray line/);
  assert.ok(!lines.includes(token));
});
