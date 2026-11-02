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
  IDLE_POLL_MS,
  MAX_ANSWER_BYTES,
  MOST_JOBS_AT_ONCE,
  PUBLISH_EVERY_MS,
  readCloudJob,
  type CloudFetch,
  type CloudStore,
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
  source: { connectionId: 1, name: "Dev", environment: "dev", schema: "public", error: null },
  targets: [
    {
      connectionId: 2,
      name: "Prod",
      environment: "prod",
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

type Rows = { id: number; name: string; environment: string; database: string; host?: string }[];

const CONNECTION_ROWS: Rows = [
  { id: 1, name: "Dev", environment: "dev", database: "shop_dev", host: HOST },
  { id: 2, name: "Prod", environment: "prod", database: "shop_prod", host: HOST },
  { id: 3, name: "Not shared", environment: "staging", database: "shop_staging", host: HOST },
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
  assert.deepEqual(agent.view(), { state: "linked", origin: ORIGIN, orgName: "Acme Data", linkedAt: LINKED.linkedAt, problem: null });
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

test("the site hears only each shared connection's id, name and environment", async () => {
  const { agent, pass, site } = rig({ loaded: SAVED });
  agent.start();
  await pass(0);
  assert.deepEqual(site.of(PUBLISH)[0].body, {
    connections: [
      { id: 1, name: "Dev", environment: "dev" },
      { id: 2, name: "Prod", environment: "prod" },
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
    json: { connections: [{ id: 1, name: "Renamed", environment: "staging", database: "shop_dev" }] },
  };
  await pass(PUBLISH_EVERY_MS);
  assert.equal(site.count(PUBLISH), 2);
  assert.deepEqual(site.of(PUBLISH)[1].body, { connections: [{ id: 1, name: "Renamed", environment: "staging" }] });
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
  assert.deepEqual(site.of(PUBLISH)[1].body, { connections: [{ id: 1, name: "Dev", environment: "dev" }] });
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
  assert.deepEqual(site.of(PUBLISH)[1].body, { connections: [{ id: 2, name: "Prod", environment: "prod" }] });
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
