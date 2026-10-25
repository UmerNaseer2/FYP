/**
 * The phone app's service worker (src/phone/sw.ts), as the build writes it
 * out (public/sw.js): what it shows for a drift alert from the computer and
 * for a push it cannot read, where a tap on an alert goes, and how it keeps
 * and uses its copy of the app's files.
 *
 * It runs in a scope of its own (node:vm), with stand-ins for the parts of a
 * browser it uses. `npm test` builds the app first, so the worker tested here
 * is the one a phone would get.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const SOURCE = readFileSync(new URL("../../public/sw.js", import.meta.url), "utf8");
const ORIGIN = "https://relay.example";
const ICONS = { icon: "/icons/icon-192.png", badge: "/icons/badge-96.png" };
const UNREADABLE = {
  title: "Schema Studio",
  options: { body: "The computer sent an alert this phone app cannot read. Open the app to update it.", ...ICONS },
};

/** A stand-in for an answer from the network, or from the worker's copy. */
type Answer = { status: number; from: string };
/** A stand-in for a request from the page. */
type PageRequest = { method: string; url: string; mode: string };
/** A browser window, of the app or of another site, that notes when it is brought to the front. */
type Tab = { url: string; focused: boolean; focus(): Promise<void> };

type Setup = {
  /** The browser's open windows. */
  tabs?: Tab[];
  /** What the network gives back. */
  fetch?: (request: PageRequest) => Promise<Answer>;
  /** What the worker's copy has for any request. */
  copy?: Answer;
  /** The names of the copies the browser keeps, read each time the worker asks. */
  caches?: string[];
  /** True to make the worker give up on the network at once, as it does when the network is too slow. */
  slowNetwork?: boolean;
};

/**
 * Starts the built worker, and gives back what it did and a way to hand it
 * events. Everything it does is copied into this test's own objects, because
 * objects made inside node:vm are never deeply equal to the test's own.
 */
function start(setup: Setup = {}) {
  const listeners = new Map<string, (event: unknown) => void>();
  const seen = {
    shown: [] as { title: string; options: object }[],
    opened: [] as string[],
    windowQueries: [] as object[],
    cached: [] as { name: string; files: string[] }[],
    deleted: [] as string[],
    lookups: [] as { key: unknown; cacheName: unknown }[],
  };
  const scope = {
    location: { origin: ORIGIN },
    addEventListener: (type: string, listener: (event: unknown) => void) => void listeners.set(type, listener),
    skipWaiting: async () => {},
    registration: {
      showNotification: async (title: string, options: object) => void seen.shown.push({ title, options: { ...options } }),
    },
    clients: {
      matchAll: async (query: object) => {
        seen.windowQueries.push({ ...query });
        return setup.tabs ?? [];
      },
      openWindow: async (url: string) => void seen.opened.push(url),
      claim: async () => {},
    },
  };
  const caches = {
    open: async (name: string) => ({ addAll: async (files: string[]) => void seen.cached.push({ name, files: [...files] }) }),
    keys: async () => [...(setup.caches ?? [])],
    delete: async (name: string) => {
      seen.deleted.push(name);
      return true;
    },
    match: async (key: unknown, options: { cacheName?: unknown }) => {
      seen.lookups.push({ key, cacheName: options.cacheName });
      return setup.copy;
    },
  };
  // The worker gives the network 4 seconds. This timer never holds the tests
  // up: it runs out at once for a slow network, and never otherwise.
  const setTimeout = (callback: () => void) => {
    if (setup.slowNetwork) queueMicrotask(callback);
  };
  const fetch = setup.fetch ?? (async () => ({ status: 200, from: "network" }));
  vm.runInContext(SOURCE, vm.createContext({ self: scope, caches, fetch, setTimeout, URL }), { filename: "sw.js" });

  /** Hands the worker an event, waits for what it does, and gives back its answer to a fetch (undefined when it left one to the browser). */
  async function dispatch(type: string, event: object): Promise<unknown> {
    const listener = listeners.get(type);
    assert.ok(listener, `The worker listens for "${type}" events.`);
    let waited: Promise<unknown> = Promise.resolve();
    let answered: Promise<unknown> | undefined;
    listener({
      ...event,
      waitUntil: (promise: Promise<unknown>) => void (waited = promise),
      respondWith: (promise: Promise<unknown>) => void (answered = promise),
    });
    await waited;
    return answered === undefined ? undefined : await answered;
  }
  return { seen, dispatch };
}

/** A push's data, as the browser hands it to the worker. */
function pushed(text: string): { json(): unknown } {
  return { json: () => JSON.parse(text) };
}

function tab(url: string): Tab {
  const opened: Tab = {
    url,
    focused: false,
    focus: async () => {
      opened.focused = true;
    },
  };
  return opened;
}

function request(path: string, changes: Partial<PageRequest> = {}): PageRequest {
  return { method: "GET", url: `${ORIGIN}${path}`, mode: "no-cors", ...changes };
}

const offline = () => Promise.reject(new TypeError("Failed to fetch"));

test("shows a drift alert as the computer wrote it, with the app's icons", async () => {
  const worker = start();
  const alert = { v: 1, kind: "drift", title: "Bookshop (Production) changed", body: "2 tables no longer match its baseline." };
  await worker.dispatch("push", { data: pushed(JSON.stringify(alert)) });
  assert.deepEqual(worker.seen.shown, [{ title: alert.title, options: { body: alert.body, ...ICONS } }]);
});

test("shows a plain alert for a push it cannot read, so every push still shows one", async () => {
  const cases: [string, { json(): unknown } | null][] = [
    ["no data", null],
    ["data that is not JSON", pushed("not json")],
    ["JSON null", pushed("null")],
    ["a number", pushed("1")],
    ["a newer version", pushed(JSON.stringify({ v: 2, kind: "drift", title: "T", body: "B" }))],
    ["another kind", pushed(JSON.stringify({ v: 1, kind: "approval", title: "T", body: "B" }))],
    ["a title that is not text", pushed(JSON.stringify({ v: 1, kind: "drift", title: 3, body: "B" }))],
    ["an empty title", pushed(JSON.stringify({ v: 1, kind: "drift", title: "  ", body: "B" }))],
    ["no body", pushed(JSON.stringify({ v: 1, kind: "drift", title: "T" }))],
  ];
  for (const [label, data] of cases) {
    const worker = start();
    await worker.dispatch("push", { data });
    assert.deepEqual(worker.seen.shown, [UNREADABLE], label);
  }
});

test("a tap on an alert closes it and brings the app's open window to the front", async () => {
  const other = tab("https://other.example/");
  const app = tab(`${ORIGIN}/#/approvals`);
  const worker = start({ tabs: [other, app] });
  let closed = false;
  await worker.dispatch("notificationclick", { notification: { close: () => void (closed = true) } });
  assert.equal(closed, true);
  assert.equal(app.focused, true);
  assert.equal(other.focused, false);
  assert.deepEqual(worker.seen.opened, []);
  // A window the worker does not control yet, as just after an update, counts too.
  assert.deepEqual(worker.seen.windowQueries, [{ type: "window", includeUncontrolled: true }]);
});

test("a tap on an alert opens the app when it has no window open", async () => {
  const other = tab("https://other.example/");
  const worker = start({ tabs: [other] });
  await worker.dispatch("notificationclick", { notification: { close: () => {} } });
  assert.equal(other.focused, false);
  assert.deepEqual(worker.seen.opened, ["/"]);
});

test("keeps one build's files in full, and drops every other copy once it takes over", async () => {
  const kept = ["phone-0123456789ab", "something-else"];
  const worker = start({ caches: kept });
  await worker.dispatch("install", {});
  assert.equal(worker.seen.cached.length, 1);
  const [{ name, files }] = worker.seen.cached;
  assert.match(name, /^phone-[0-9a-f]{12}$/);
  for (const file of ["/", "/app.css", "/manifest.webmanifest", "/js/phone/main.js", "/js/shared/remote/rpc.js", "/js/vendor/jsQR.js", "/icons/icon-192.png"]) {
    assert.ok(files.includes(file), `The copy has ${file}.`);
  }
  // The page is kept as "/", the address the app opens at. The worker itself
  // and the page's rules are never part of the copy.
  for (const file of ["/index.html", "/sw.js", "/_headers"]) assert.ok(!files.includes(file), `The copy leaves out ${file}.`);

  kept.push(name);
  await worker.dispatch("activate", {});
  assert.deepEqual(worker.seen.deleted, ["phone-0123456789ab", "something-else"]);
});

test("answers from the network when it can", async () => {
  const worker = start({ copy: { status: 200, from: "copy" } });
  assert.deepEqual(await worker.dispatch("fetch", { request: request("/app.css") }), { status: 200, from: "network" });
  assert.deepEqual(worker.seen.lookups, []);
});

test("answers from its copy when the network fails, is too slow, or has a server error", async () => {
  const copy = { status: 200, from: "copy" };
  const cases: [string, Setup][] = [
    ["no network", { fetch: offline }],
    ["a slow network", { fetch: () => new Promise<Answer>(() => {}), slowNetwork: true }],
    ["a server error", { fetch: async () => ({ status: 502, from: "network" }) }],
  ];
  for (const [label, setup] of cases) {
    const worker = start({ ...setup, copy });
    assert.equal(await worker.dispatch("fetch", { request: request("/app.css") }), copy, label);
    assert.equal(worker.seen.lookups.length, 1, label);
    assert.match(String(worker.seen.lookups[0].cacheName), /^phone-[0-9a-f]{12}$/, label);
  }
});

test("opens the app from its copy of the page, whatever screen the address names", async () => {
  const copy = { status: 200, from: "copy" };
  const worker = start({ fetch: offline, copy });
  assert.equal(await worker.dispatch("fetch", { request: request("/#/approvals", { mode: "navigate" }) }), copy);
  assert.deepEqual(
    worker.seen.lookups.map((lookup) => lookup.key),
    ["/"],
  );
});

test("passes on the network's own answer when its copy has nothing", async () => {
  const failing = start({ fetch: async () => ({ status: 503, from: "network" }) });
  assert.deepEqual(await failing.dispatch("fetch", { request: request("/app.css") }), { status: 503, from: "network" });
  const disconnected = start({ fetch: offline });
  await assert.rejects(disconnected.dispatch("fetch", { request: request("/app.css") }), TypeError);
});

test("leaves requests to other sites, and anything but GET, to the browser", async () => {
  const worker = start();
  assert.equal(await worker.dispatch("fetch", { request: request("/app.css", { method: "POST" }) }), undefined);
  assert.equal(await worker.dispatch("fetch", { request: { method: "GET", url: "https://other.example/app.js", mode: "no-cors" } }), undefined);
});
