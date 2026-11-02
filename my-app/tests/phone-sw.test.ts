// The phone app's service worker, run as the browser would run it: the script
// itself, with a stand-in for `self`.
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";

type Listener = (event: Record<string, unknown>) => void;

const SOURCE = readFileSync(path.join(__dirname, "..", "public", "sw.js"), "utf8");
const ORIGIN = "https://fyp.example.test";

function load() {
  const listeners: Record<string, Listener> = {};
  const shown: { title: string; options: { body: string; data: { url: string } } }[] = [];
  const windows: { url: string; focus: jest.Mock; navigate: jest.Mock }[] = [];
  const opened: string[] = [];
  const self = {
    location: { origin: ORIGIN },
    addEventListener: (name: string, listener: Listener) => {
      listeners[name] = listener;
    },
    skipWaiting: jest.fn(),
    registration: {
      showNotification: async (title: string, options: never) => {
        shown.push({ title, options });
      },
    },
    clients: {
      claim: jest.fn(async () => undefined),
      matchAll: jest.fn(async () => windows),
      openWindow: async (url: string) => {
        opened.push(url);
      },
    },
  };
  vm.runInNewContext(SOURCE, { self, URL });

  /** Sends an event, and waits for what it asked to wait for. */
  async function fire(name: string, event: Record<string, unknown> = {}): Promise<void> {
    let waited: Promise<unknown> = Promise.resolve();
    listeners[name]({ ...event, waitUntil: (work: Promise<unknown>) => (waited = work) });
    await waited;
  }
  const push = (value: unknown) => fire("push", { data: { json: () => value } });
  const tap = (url: unknown) =>
    fire("notificationclick", { notification: { close: jest.fn(), data: { url } } });
  return { listeners, shown, windows, opened, self, fire, push, tap };
}

const GOOD = { v: 1, kind: "drift", title: "Drift found", body: "shop no longer matches.", url: "/org/phone?tab=approvals" };

describe("the phone app's service worker", () => {
  it("shows what the server sent", async () => {
    const worker = load();
    await worker.push(GOOD);
    expect(worker.shown).toHaveLength(1);
    expect(worker.shown[0].title).toBe("Drift found");
    expect(worker.shown[0].options.body).toBe("shop no longer matches.");
    expect(worker.shown[0].options.data.url).toBe("/org/phone?tab=approvals");
  });

  it.each([
    ["no data at all", () => undefined],
    ["a version it does not know", () => ({ data: { json: () => ({ ...GOOD, v: 2 }) } })],
    ["no title", () => ({ data: { json: () => ({ ...GOOD, title: " " }) } })],
    ["something else entirely", () => ({ data: { json: () => "hello" } })],
    ["text that is not JSON", () => ({ data: { json: () => { throw new Error("no"); } } })],
  ])("still shows something for %s", async (_name, event) => {
    const worker = load();
    await worker.fire("push", event() ?? { data: null });
    expect(worker.shown).toHaveLength(1);
    expect(worker.shown[0].title).toBe("Schema Studio");
    expect(worker.shown[0].options.data.url).toBe("/phone");
  });

  it.each([
    "https://elsewhere.example.test/phone",
    "//elsewhere.example.test/phone",
    "/\\elsewhere.example.test/phone",
    "javascript:alert(1)",
    "phone",
    42,
  ])("never leads anywhere but this site: %s", async (url) => {
    const worker = load();
    await worker.push({ ...GOOD, url });
    expect(worker.shown[0].options.data.url).toBe("/phone");
    await worker.tap(url);
    expect(worker.opened).toEqual(["/phone"]);
  });

  it("opens the place in a new window when none is open", async () => {
    const worker = load();
    await worker.tap("/org/phone?tab=approvals");
    expect(worker.opened).toEqual(["/org/phone?tab=approvals"]);
  });

  it("uses a window the app already has open", async () => {
    const worker = load();
    const open = { url: `${ORIGIN}/org/phone`, focus: jest.fn(async () => undefined), navigate: jest.fn(async () => undefined) };
    worker.windows.push(open);
    await worker.tap("/org/phone?tab=approvals");
    expect(open.focus).toHaveBeenCalled();
    expect(open.navigate).toHaveBeenCalledWith("/org/phone?tab=approvals");
    expect(worker.opened).toEqual([]);
  });

  it("is happy in front even if the browser will not move the window", async () => {
    const worker = load();
    const open = { url: `${ORIGIN}/org/phone`, focus: jest.fn(async () => undefined), navigate: jest.fn(async () => { throw new Error("no"); }) };
    worker.windows.push(open);
    await expect(worker.tap("/org/phone")).resolves.toBeUndefined();
  });

  it("takes over straight away, so that a fix reaches a phone without a wait", async () => {
    const worker = load();
    worker.listeners.install({});
    expect(worker.self.skipWaiting).toHaveBeenCalled();
    await worker.fire("activate");
    expect(worker.self.clients.claim).toHaveBeenCalled();
  });

  it("keeps no copy of anything, so a signed-out phone cannot show old screens", () => {
    const worker = load();
    expect(worker.listeners.fetch).toBeUndefined();
    expect(SOURCE).not.toMatch(/caches\./);
  });
});
