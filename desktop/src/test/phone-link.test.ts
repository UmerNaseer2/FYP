/**
 * The phone link as a whole (src/main/phone-link.ts). A fake store plays
 * phone-link.json, a fake socket plays the relay, a real handshake plays a
 * phone, and a clock the tests move on by hand drives the timers.
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

import { newPhoneLinkState, type PairedPhone, type PhoneLinkState } from "../core/phone-link-file";
import type { Clock } from "../main/clock";
import { initLog, logFilePaths, logWarn } from "../main/log";
import {
  openPhoneLink,
  type PhoneLink,
  type PhoneLinkOpening,
  type PhoneLinkOptions,
  type PhoneLinkStore,
  type PhoneLinkView,
} from "../main/phone-link";
import { FIRST_WAIT_MS, type OpenSocket, type RelaySocket, type SocketEvents } from "../main/phone-relay";
import { writeRefusal, type AppAnswer, type AppCaller } from "../main/phone-requests";
import type { LoadResult, Protection } from "../main/secrets";
import { fromBase64Url, randomBytes, toBase64Url, type Bytes } from "../shared/remote/bytes.js";
import { generateKeyPair, importKeyPair, type KeyPair } from "../shared/remote/keys.js";
import { Link } from "../shared/remote/link.js";
import { Initiator } from "../shared/remote/noise.js";
import {
  PAIRING_LIFETIME_MS,
  PHONE_LINK_PROLOGUE,
  readOpeningAnswer,
  readPairingLink,
  writeOpening,
  type Opening,
  type OpeningAnswer,
} from "../shared/remote/pairing.js";
import { CHALLENGE_BYTES, desktopIdFor } from "../shared/remote/relay-auth.js";
import { CLOSE_REPLACED, addChannel, readChannel, readControl, relaySocketUrl, writeControl } from "../shared/remote/relay-protocol.js";
import { readAnswer, writeRequest, type Answer, type Request } from "../shared/remote/rpc.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ss-phone-link-"));
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

/** How many lines of this text match. */
function countLines(text: string, pattern: RegExp): number {
  return text.split("\n").filter((line) => pattern.test(line)).length;
}

type Timer = { at: number; run: () => void; id: number };

/** A clock that moves only when a test moves it on. */
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

  /** Moves time on, running each timer that comes due on the way, in the order they come due. */
  advance(ms: number): void {
    const end = this.time + ms;
    for (;;) {
      let due: Timer | undefined;
      for (const entry of this.timers) {
        if (entry.at > end) continue;
        if (due === undefined || entry.at < due.at || (entry.at === due.at && entry.id < due.id)) due = entry;
      }
      if (due === undefined) break;
      const running = due;
      this.timers = this.timers.filter((entry) => entry !== running);
      this.time = running.at;
      running.run();
    }
    this.time = end;
  }
}

/** Waits, in real time, until `check` is true: the signing and the handshake run for real, so they take a moment. */
async function until(check: () => boolean, what: string): Promise<void> {
  const giveUpAt = Date.now() + 5_000;
  while (!check()) {
    if (Date.now() > giveUpAt) throw new Error(`Gave up waiting for ${what}.`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Lets the news the phone link tells in a microtask run, and anything else already due. */
function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** A socket that a test plays the relay on. It notes what the computer sends, and how it closes the socket. */
class FakeSocket implements RelaySocket {
  state: "connecting" | "open" | "closing" | "closed" = "connecting";
  /**
   * What the computer has sent since the socket opened. It keeps even what
   * was sent once the socket was closing or closed, which a real socket
   * drops, so that a test can tell that nothing was sent at all.
   */
  sent: Array<string | Bytes> = [];
  /** The codes the computer closed the socket with. */
  closedWith: number[] = [];
  bufferedAmount = 0;

  constructor(
    readonly url: string,
    private readonly events: SocketEvents,
  ) {}

  send(data: string | Bytes): void {
    // Like a real socket, which throws until it has opened.
    if (this.state === "connecting") throw new Error("The socket is still connecting.");
    this.sent.push(data);
  }

  close(code: number): void {
    this.closedWith.push(code);
    if (this.state === "connecting") {
      // Like Node's own WebSocket, which reports the close from inside close() when the socket has not opened.
      this.state = "closed";
      this.events.closed(1006);
    } else if (this.state === "open") {
      this.state = "closing";
    }
  }

  /** The relay takes the connection. */
  open(): void {
    this.state = "open";
    this.events.opened();
  }

  /** The relay sends a message of its own. */
  text(text: string): void {
    this.events.text(text);
  }

  /** The relay passes on a phone's message. */
  binary(data: Bytes): void {
    this.events.binary(data);
  }

  /** The connection ends with this code. */
  end(code: number): void {
    this.state = "closed";
    this.events.closed(code);
  }

  /** What the computer has sent since the last call. */
  take(): Array<string | Bytes> {
    return this.sent.splice(0);
  }
}

/** Opens fake sockets, and keeps each one so that a test can play the relay on it. */
class FakeOpener {
  sockets: FakeSocket[] = [];

  open: OpenSocket = (url, events) => {
    const socket = new FakeSocket(url, events);
    this.sockets.push(socket);
    return socket;
  };

  /** The socket opened last. */
  get latest(): FakeSocket {
    const socket = this.sockets.at(-1);
    assert.ok(socket, "a socket was opened");
    return socket;
  }
}

/** The relay's challenge, as it asks a computer to sign in. */
function challengeMessage(): string {
  return writeControl({ type: "challenge", challenge: randomBytes(CHALLENGE_BYTES) });
}

/** Whether this is the computer answering the relay's challenge. */
function isAuth(data: string | Bytes): boolean {
  return typeof data === "string" && readControl(data)?.type === "auth";
}

/** Plays phone-link.json: gives what the test set, and keeps a copy of each save. */
class FakeStore implements PhoneLinkStore {
  /** A copy of each state saved, in order. */
  saved: PhoneLinkState[] = [];
  /** Makes each save throw, as it does when the disk is full. */
  failSaves = false;
  /** How each save says the state was kept. */
  protection: Protection = "plain";

  constructor(private readonly loaded: LoadResult<PhoneLinkState>) {}

  load(): LoadResult<PhoneLinkState> {
    return this.loaded;
  }

  save(state: PhoneLinkState): Protection {
    if (this.failSaves) throw new Error("The disk is full.");
    // A copy, so that a later change to the link's state cannot change what a test reads here.
    this.saved.push(structuredClone(state));
    return this.protection;
  }

  /** The state saved last. */
  get last(): PhoneLinkState {
    const state = this.saved.at(-1);
    assert.ok(state, "the state was saved");
    return state;
  }
}

/** Plays the app's server: notes each call, and gives the answer the test set for it, or a 404. */
class FakeCaller {
  calls: Array<{ method: string; path: string; body: unknown }> = [];
  /** The answers, by method and path, such as "GET /api/lineage/schemas?connectionId=3". */
  answers = new Map<string, AppAnswer>();

  call: AppCaller = async (method, route, body) => {
    this.calls.push({ method, path: route, body });
    return this.answers.get(`${method} ${route}`) ?? { status: 404, json: null };
  };
}

const RELAY_ORIGIN = "https://relay.example.com";
const FILE_LABEL = "~/.config/schema-studio/phone-link.json";

/** A first run's state, with new keys, changed as the test needs. */
function stateWith(changes: Partial<PhoneLinkState> = {}): PhoneLinkState {
  return { ...newPhoneLinkState((size) => crypto.randomBytes(size)), ...changes };
}

/** What the store gives for state saved before. */
function savedAs(state: PhoneLinkState): LoadResult<PhoneLinkState> {
  return { status: "values", values: state, protection: "plain", upgrade: false };
}

type Fakes = {
  store: FakeStore;
  caller: FakeCaller;
  opener: FakeOpener;
  clock: FakeClock;
  /** What view() gave each time onChange was told, in order. */
  views: PhoneLinkView[];
  /** Each phone onPaired was told of, in order. */
  paired: PairedPhone[];
};

/** Opens a phone link on this store, with fakes for everything else and any options the test changes. */
async function tryOpen(store: FakeStore, changes: Partial<PhoneLinkOptions> = {}): Promise<Fakes & { opening: PhoneLinkOpening }> {
  newLogLines();
  const caller = new FakeCaller();
  const opener = new FakeOpener();
  const clock = new FakeClock();
  const views: PhoneLinkView[] = [];
  const paired: PairedPhone[] = [];
  let link: PhoneLink | null = null;
  const opening = await openPhoneLink({
    store,
    fileLabel: FILE_LABEL,
    call: caller.call,
    appVersion: "0.0.0-test",
    computerName: "Test computer",
    onChange: () => {
      if (link !== null) views.push(link.view());
    },
    onPaired: (phone) => paired.push(phone),
    openSocket: opener.open,
    clock,
    // Each wait is cut by up to half at random: with 1, it is not cut at all.
    random: () => 1,
    ...changes,
  });
  if (opening.ok) link = opening.link;
  return { opening, store, caller, opener, clock, views, paired };
}

/** Opens a phone link on state saved before, which must open. */
async function openLink(state: PhoneLinkState, changes: Partial<PhoneLinkOptions> = {}): Promise<Fakes & { link: PhoneLink }> {
  const { opening, ...fakes } = await tryOpen(new FakeStore(savedAs(state)), changes);
  return { ...fakes, link: linkOf(opening) };
}

function linkOf(opening: PhoneLinkOpening): PhoneLink {
  if (!opening.ok) throw new Error(`The phone link did not open: ${opening.reason}`);
  return opening.link;
}

function reasonOf(opening: PhoneLinkOpening): string {
  if (opening.ok) throw new Error("The phone link opened.");
  return opening.reason;
}

/** The public half of a key the state holds. */
async function publicKeyOf(kind: "Ed25519" | "X25519", key: string): Promise<Bytes> {
  const privateKey = fromBase64Url(key);
  assert.ok(privateKey, "the key is base64url");
  return (await importKeyPair(kind, privateKey)).publicKey;
}

/** Plays the relay letting the computer in on the socket opened last. */
async function signIn(opener: FakeOpener, link: PhoneLink): Promise<FakeSocket> {
  const socket = opener.latest;
  socket.open();
  socket.text(challengeMessage());
  await until(() => socket.sent.some(isAuth), "the answer to the challenge");
  socket.text(writeControl({ type: "ready" }));
  assert.deepEqual(link.status(), { state: "connected" });
  socket.take();
  return socket;
}

/** Takes the computer's next message to the phone on this channel, waiting for it to be sent. */
async function nextMessage(socket: FakeSocket, channel: number): Promise<Bytes> {
  const found: Bytes[] = [];
  await until(() => {
    for (const [index, data] of socket.sent.entries()) {
      if (typeof data === "string") continue;
      const frame = readChannel(data);
      if (frame === null || frame.channel !== channel) continue;
      socket.sent.splice(index, 1);
      found.push(frame.message);
      return true;
    }
    return false;
  }, `a message on channel ${channel}`);
  const message = found[0];
  assert.ok(message, "a message was taken");
  return message;
}

/**
 * Has the relay connect a phone on this channel, which opens with `opening`.
 * Gives what the computer answered, and the phone's end of the link when it
 * was let in.
 */
async function connectPhone(
  socket: FakeSocket,
  channel: number,
  phoneKey: KeyPair,
  computerKey: Bytes,
  opening: Opening,
): Promise<{ answer: OpeningAnswer | null; link: Link | null }> {
  socket.text(writeControl({ type: "open", channel }));
  const initiator = new Initiator({ prologue: PHONE_LINK_PROLOGUE, staticKey: phoneKey, remoteStaticKey: computerKey });
  socket.binary(addChannel(channel, await initiator.writeFirstMessage(writeOpening(opening))));
  const { payload, session } = await initiator.readAnswer(await nextMessage(socket, channel));
  const answer = readOpeningAnswer(payload);
  const link = answer?.ok === true ? new Link(session, (sealed) => socket.binary(addChannel(channel, sealed))) : null;
  return { answer, link };
}

/** The phone sends a request, and gives the computer's answer. */
async function ask(link: Link, socket: FakeSocket, channel: number, request: Request): Promise<Answer | null> {
  await link.send(writeRequest(request));
  for (;;) {
    const whole = await link.receive(await nextMessage(socket, channel));
    if (whole !== null) return readAnswer(whole);
  }
}

test("makes new keys and saves them the first time, then keeps them out of the log", async () => {
  const store = new FakeStore({ status: "missing" });
  const link = linkOf((await tryOpen(store)).opening);
  assert.equal(store.saved.length, 1);
  const state = store.last;
  assert.deepEqual(
    { ...state, signingKey: "", staticKey: "" },
    { enabled: false, relayOrigin: null, sharedConnectionIds: [], phones: [], signingKey: "", staticKey: "" },
  );
  assert.equal(fromBase64Url(state.signingKey)?.length, 32);
  assert.equal(fromBase64Url(state.staticKey)?.length, 32);
  assert.notEqual(state.signingKey, state.staticKey);
  assert.equal(countLines(newLogLines(), /Made new keys for the phone link and kept them in a file only you can read\./), 1);

  logWarn(`A message with both keys in it: ${state.signingKey} ${state.staticKey}`);
  const logged = newLogLines();
  assert.match(logged, /A message with both keys in it/);
  assert.ok(!logged.includes(state.signingKey) && !logged.includes(state.staticKey), "the keys are not in the log");
  assert.deepEqual(link.view(), { status: { state: "off" }, enabled: false, relayOrigin: null, sharedConnectionIds: [], phones: [] });
});

test("makes new keys from the random bytes it is given", async () => {
  const store = new FakeStore({ status: "missing" });
  linkOf((await tryOpen(store, { randomBytes: (size) => Buffer.alloc(size, 7) })).opening);
  const key = Buffer.alloc(32, 7).toString("base64url");
  assert.equal(store.last.signingKey, key);
  assert.equal(store.last.staticKey, key);
});

test("says when new keys went into the login keyring", async () => {
  const store = new FakeStore({ status: "missing" });
  store.protection = "keyring";
  linkOf((await tryOpen(store)).opening);
  assert.equal(countLines(newLogLines(), /Made new keys for the phone link and locked them in the login keyring\./), 1);
});

test("opens saved keys without saving, keeps them out of the log, and connects as the computer they make", async () => {
  const state = stateWith({ enabled: true, relayOrigin: RELAY_ORIGIN });
  const { link, store, opener } = await openLink(state);
  assert.deepEqual(store.saved, []);
  logWarn(`A message with both keys in it: ${state.signingKey} ${state.staticKey}`);
  const logged = newLogLines();
  assert.ok(!logged.includes(state.signingKey) && !logged.includes(state.staticKey), "the keys are not in the log");

  link.start();
  const desktopId = await desktopIdFor(await publicKeyOf("Ed25519", state.signingKey));
  assert.deepEqual(
    opener.sockets.map((socket) => socket.url),
    [relaySocketUrl(RELAY_ORIGIN, "desktop", desktopId)],
  );
});

test("moves plain keys into the login keyring once there is one, and opens even when that fails", async () => {
  const state = stateWith();
  const store = new FakeStore({ status: "values", values: state, protection: "plain", upgrade: true });
  store.protection = "keyring";
  linkOf((await tryOpen(store)).opening);
  assert.deepEqual(store.saved, [state]);
  assert.equal(countLines(newLogLines(), /Moved the phone link's keys into the login keyring\./), 1);

  // A save that still keeps the keys in a plain file does not claim to have moved them.
  const plain = new FakeStore({ status: "values", values: state, protection: "plain", upgrade: true });
  linkOf((await tryOpen(plain)).opening);
  assert.equal(plain.saved.length, 1);
  assert.equal(countLines(newLogLines(), /Moved the phone link's keys/), 0);

  const failing = new FakeStore({ status: "values", values: state, protection: "plain", upgrade: true });
  failing.failSaves = true;
  linkOf((await tryOpen(failing)).opening);
  assert.equal(
    countLines(newLogLines(), /Could not move the phone link's keys into the login keyring, so they stay in a file only you can read\./),
    1,
  );
});

test("stays unavailable, and saves nothing, when the keys are locked or damaged", async () => {
  const locked = new FakeStore({ status: "locked", message: "The login keyring did not open for phone-link.json." });
  assert.match(reasonOf((await tryOpen(locked)).opening), /keyring did not open/);
  assert.equal(countLines(newLogLines(), /The login keyring did not open for phone-link\.json\./), 1);

  const damaged = new FakeStore({ status: "damaged", message: "phone-link.json is not JSON." });
  const reason = reasonOf((await tryOpen(damaged)).opening);
  assert.ok(reason.includes(FILE_LABEL), "the reason says where the file is");
  assert.match(reason, /each phone needs pairing again/);
  assert.equal(countLines(newLogLines(), /phone-link\.json is not JSON\./), 1);

  assert.deepEqual([...locked.saved, ...damaged.saved], []);
});

test("stays unavailable when a saved key cannot be opened", async () => {
  const store = new FakeStore(savedAs(stateWith({ signingKey: "short" })));
  assert.equal(reasonOf((await tryOpen(store)).opening), "The phone link could not open its keys. Schema Studio's log has the details.");
  assert.equal(countLines(newLogLines(), /The phone link could not open its keys\./), 1);
  assert.deepEqual(store.saved, []);
});

test("stays unavailable when new keys cannot be saved", async () => {
  const store = new FakeStore({ status: "missing" });
  store.failSaves = true;
  const reason = reasonOf((await tryOpen(store)).opening);
  assert.ok(reason.includes(FILE_LABEL), "the reason says where the file is");
  assert.match(reason, /space on the disk/);
  assert.equal(countLines(newLogLines(), /Could not save new keys for the phone link\./), 1);
});

test("connects to the relay only once started, turned on and given a relay", async () => {
  const { link, opener } = await openLink(stateWith({ enabled: true, relayOrigin: RELAY_ORIGIN }));
  assert.equal(opener.sockets.length, 0);
  link.start();
  link.start();
  assert.equal(opener.sockets.length, 1);
  assert.deepEqual(link.status(), { state: "connecting" });
  assert.equal(countLines(newLogLines(), /Connecting the phone link to the relay at https:\/\/relay\.example\.com\./), 1);

  const off = await openLink(stateWith({ relayOrigin: RELAY_ORIGIN }));
  off.link.start();
  assert.deepEqual(off.link.status(), { state: "off" });
  assert.equal(off.opener.sockets.length, 0);

  const noRelay = await openLink(stateWith({ enabled: true }));
  noRelay.link.start();
  assert.deepEqual(noRelay.link.status(), { state: "needs-relay" });
  assert.equal(noRelay.opener.sockets.length, 0);

  // Turned on and given a relay before it starts: both are saved, but it waits for the start to connect.
  const early = await openLink(stateWith());
  early.link.setEnabled(true);
  assert.equal(early.link.setRelayOrigin(RELAY_ORIGIN), true);
  assert.equal(early.store.last.enabled, true);
  assert.equal(early.store.last.relayOrigin, RELAY_ORIGIN);
  assert.equal(early.opener.sockets.length, 0);
  assert.deepEqual(early.link.status(), { state: "off" });
  early.link.start();
  assert.equal(early.opener.sockets.length, 1);
  assert.deepEqual(early.link.status(), { state: "connecting" });
});

test("turns the link off and on, letting go of the relay and connecting again", async () => {
  const { link, store, opener } = await openLink(stateWith({ enabled: true, relayOrigin: RELAY_ORIGIN }));
  link.start();
  const first = opener.latest;
  link.setEnabled(false);
  assert.deepEqual(first.closedWith, [1000]);
  assert.equal(store.last.enabled, false);
  assert.deepEqual(link.status(), { state: "off" });
  assert.equal(link.newPairingLink(), null);
  assert.equal(countLines(newLogLines(), /The phone link was turned off\./), 1);

  link.setEnabled(false);
  link.setEnabled("yes");
  link.setEnabled(1);
  assert.equal(store.saved.length, 1);

  link.setEnabled(true);
  assert.equal(store.saved.length, 2);
  assert.equal(store.last.enabled, true);
  assert.equal(opener.sockets.length, 2);
  assert.deepEqual(link.status(), { state: "connecting" });
  assert.equal(countLines(newLogLines(), /The phone link was turned on\./), 1);
});

test("moves to a new relay, and refuses an address that is not one", async () => {
  const { link, store, opener } = await openLink(stateWith({ enabled: true, relayOrigin: RELAY_ORIGIN }));
  link.start();
  const first = opener.latest;
  assert.equal(link.setRelayOrigin("https://other.example.com/"), true);
  assert.deepEqual(first.closedWith, [1000]);
  assert.equal(opener.sockets.length, 2);
  assert.ok(opener.latest.url.startsWith("wss://other.example.com/"), opener.latest.url);
  assert.equal(store.last.relayOrigin, "https://other.example.com");
  assert.equal(link.view().relayOrigin, "https://other.example.com");
  assert.equal(countLines(newLogLines(), /The phone link's relay is now https:\/\/other\.example\.com\./), 1);

  for (const text of ["http://relay.example.com", "not an address", "", 42, null]) {
    assert.equal(link.setRelayOrigin(text), false, String(text));
  }
  assert.equal(link.setRelayOrigin("https://other.example.com"), true);
  assert.equal(store.saved.length, 1);
  assert.equal(opener.sockets.length, 2);

  assert.equal(link.setRelayOrigin("http://localhost:8787"), true);
  assert.ok(opener.latest.url.startsWith("ws://localhost:8787/"), opener.latest.url);
});

test("makes a pairing link that names the relay and the computer, only while it has a relay to pair through", async () => {
  const state = stateWith({ enabled: true, relayOrigin: RELAY_ORIGIN });
  const { link, clock } = await openLink(state);
  assert.equal(link.newPairingLink(), null);
  link.start();
  const shown = link.newPairingLink();
  assert.ok(shown);
  assert.equal(shown.expiresAt, clock.now() + PAIRING_LIFETIME_MS);
  const read = readPairingLink(shown.link);
  assert.ok(read);
  assert.equal(read.relayOrigin, RELAY_ORIGIN);
  assert.equal(read.code.desktopId, await desktopIdFor(await publicKeyOf("Ed25519", state.signingKey)));
  assert.equal(toBase64Url(read.code.desktopKey), toBase64Url(await publicKeyOf("X25519", state.staticKey)));
  link.stop();
  assert.equal(link.newPairingLink(), null);
});

test("shares the saved connections it is given, each once, and saves only a change", async () => {
  const { link, store } = await openLink(stateWith());
  link.setSharedConnections([3, "4", 3, -1, 2.5, 7, 0]);
  assert.deepEqual(store.last.sharedConnectionIds, [3, 7]);
  assert.equal(countLines(newLogLines(), /Phones may now see 2 saved connections\./), 1);
  link.view().sharedConnectionIds.push(9);
  assert.deepEqual(link.view().sharedConnectionIds, [3, 7]);

  link.setSharedConnections([3, 7]);
  assert.equal(store.saved.length, 1);
  link.setSharedConnections([7]);
  assert.equal(countLines(newLogLines(), /Phones may now see 1 saved connection\./), 1);
  link.setSharedConnections([8]);
  assert.deepEqual(store.last.sharedConnectionIds, [8]);
  link.setSharedConnections("nope");
  assert.deepEqual(store.last.sharedConnectionIds, []);
  link.setSharedConnections("nope");
  assert.equal(store.saved.length, 4);
});

test("keeps a change that could not be saved until the app quits, and says so", async () => {
  const { link, store } = await openLink(stateWith());
  store.failSaves = true;
  link.setSharedConnections([5]);
  assert.deepEqual(link.view().sharedConnectionIds, [5]);
  assert.equal(
    countLines(newLogLines(), /Could not save the phone link's settings, so the change lasts only until Schema Studio quits\./),
    1,
  );
});

test("removes a paired phone by its key, and ignores anything else", async () => {
  const old: PairedPhone = { key: toBase64Url(randomBytes(32)), name: "Old phone", pairedAt: 1_600_000_000_000, lastSeenAt: 1_650_000_000_000 };
  const other: PairedPhone = { key: toBase64Url(randomBytes(32)), name: "Other phone", pairedAt: 1_600_000_000_000, lastSeenAt: 1_660_000_000_000 };
  const { link, store } = await openLink(stateWith({ phones: [old, other] }));
  link.forgetPhone("not a key");
  link.forgetPhone(42);
  assert.equal(store.saved.length, 0);
  link.forgetPhone(old.key);
  assert.deepEqual(store.last.phones, [other]);
  assert.deepEqual(link.view().phones, [{ ...other, connected: false }]);
  assert.equal(countLines(newLogLines(), /Removed the phone "Old phone" from the paired phones\./), 1);
});

test("lets go of the relay for good once stopped, while changes are still saved", async () => {
  const { link, store, opener } = await openLink(stateWith({ enabled: true, relayOrigin: RELAY_ORIGIN }));
  link.start();
  const socket = opener.latest;
  link.stop();
  assert.deepEqual(socket.closedWith, [1000]);
  assert.deepEqual(link.status(), { state: "off" });

  link.setEnabled(false);
  link.setEnabled(true);
  link.start();
  link.connectNow();
  assert.equal(opener.sockets.length, 1);
  assert.equal(store.saved.length, 2);
  assert.deepEqual(link.status(), { state: "off" });
  assert.equal(link.newPairingLink(), null);
});

test("connects at once for Connect now, and takes the place back after another connection took it", async () => {
  const { link, opener, clock } = await openLink(stateWith({ enabled: true, relayOrigin: RELAY_ORIGIN }));
  link.start();
  link.connectNow();
  assert.equal(opener.sockets.length, 1);

  opener.latest.end(1006);
  const status = link.status();
  assert.ok(status.state === "waiting", status.state);
  assert.equal(status.retryAt, clock.now() + FIRST_WAIT_MS);
  link.connectNow();
  assert.equal(opener.sockets.length, 2);
  assert.deepEqual(link.status(), { state: "connecting" });
  clock.advance(FIRST_WAIT_MS);
  assert.equal(opener.sockets.length, 2);

  const socket = await signIn(opener, link);
  socket.end(CLOSE_REPLACED);
  assert.deepEqual(link.status(), { state: "replaced" });
  clock.advance(600_000);
  assert.equal(opener.sockets.length, 2);
  link.connectNow();
  assert.equal(opener.sockets.length, 3);
  assert.deepEqual(link.status(), { state: "connecting" });
});

test("tells the app once a run of changes is done, never in the middle of one", async () => {
  const { link, opener, views } = await openLink(stateWith({ enabled: true, relayOrigin: RELAY_ORIGIN }));
  link.start();
  assert.equal(views.length, 0);
  await settle();
  assert.deepEqual(
    views.map((view) => view.status),
    [{ state: "connecting" }],
  );

  link.setEnabled(false);
  link.setSharedConnections([4]);
  await settle();
  assert.equal(views.length, 2);
  assert.deepEqual(views[1], { status: { state: "off" }, enabled: false, relayOrigin: RELAY_ORIGIN, sharedConnectionIds: [4], phones: [] });

  link.setEnabled(true);
  await signIn(opener, link);
  await settle();
  assert.deepEqual(views.at(-1)?.status, { state: "connected" });
});

test("logs a mistake in the app's onChange, and still tells it of the next change", async () => {
  let told = 0;
  const { link, store } = await openLink(stateWith(), {
    onChange: () => {
      told += 1;
      throw new Error("The app's code broke.");
    },
  });
  link.setSharedConnections([1]);
  await settle();
  assert.equal(countLines(newLogLines(), /The phone link could not pass news on to the app\./), 1);
  link.setSharedConnections([2]);
  await settle();
  assert.equal(told, 2);
  assert.equal(store.saved.length, 2);
  assert.equal(countLines(newLogLines(), /The phone link could not pass news on to the app\./), 1);
});

test("pairs a phone through the relay, answers it, and sends it away once it is removed", async () => {
  const { link, opener, store, caller, clock, views, paired } = await openLink(stateWith({ enabled: true, relayOrigin: RELAY_ORIGIN }));
  link.start();
  const socket = await signIn(opener, link);
  const shown = link.newPairingLink();
  assert.ok(shown);
  const read = readPairingLink(shown.link);
  assert.ok(read);

  const phoneKey = await generateKeyPair("X25519", false);
  const key = toBase64Url(phoneKey.publicKey);
  const opening: Opening = { kind: "pair", secret: read.code.secret, name: "Test phone" };
  const { answer, link: phone } = await connectPhone(socket, 1, phoneKey, read.code.desktopKey, opening);
  assert.deepEqual(answer, { ok: true, name: "Test computer" });
  assert.ok(phone);
  await settle();
  const saved: PairedPhone = { key, name: "Test phone", pairedAt: clock.now(), lastSeenAt: clock.now() };
  assert.deepEqual(paired, [saved]);
  assert.deepEqual(store.last.phones, [saved]);
  assert.deepEqual(link.view().phones, [{ ...saved, connected: true }]);
  assert.deepEqual(views.at(-1)?.phones, [{ ...saved, connected: true }]);

  // A phone sees only the connections shared with it, and the app is not asked about any other.
  const refused = await ask(phone, socket, 1, { id: 1, method: "schemas.list", params: { connectionId: 3 } });
  assert.deepEqual(refused, readAnswer(writeRefusal(1, "not-shared")));
  assert.deepEqual(caller.calls, []);

  link.setSharedConnections([3]);
  caller.answers.set("GET /api/lineage/schemas?connectionId=3", { status: 200, json: { schemas: ["public"] } });
  const listed = await ask(phone, socket, 1, { id: 2, method: "schemas.list", params: { connectionId: 3 } });
  assert.deepEqual(listed, { id: 2, ok: true, result: { schemas: ["public"] } });
  assert.deepEqual(caller.calls, [{ method: "GET", path: "/api/lineage/schemas?connectionId=3", body: undefined }]);

  link.forgetPhone(key);
  const controls = socket
    .take()
    .filter((data): data is string => typeof data === "string")
    .map((text) => readControl(text));
  assert.deepEqual(controls, [{ type: "close", channel: 1 }]);
  assert.deepEqual(store.last.phones, []);
  await settle();
  assert.deepEqual(views.at(-1)?.phones, []);
});

test("pairs a phone even when the app's onPaired throws, and logs the mistake", async () => {
  const { link, opener, store } = await openLink(stateWith({ enabled: true, relayOrigin: RELAY_ORIGIN }), {
    onPaired: () => {
      throw new Error("The app's code broke.");
    },
  });
  link.start();
  const socket = await signIn(opener, link);
  const shown = link.newPairingLink();
  assert.ok(shown);
  const read = readPairingLink(shown.link);
  assert.ok(read);
  const opening: Opening = { kind: "pair", secret: read.code.secret, name: "Test phone" };
  const { answer } = await connectPhone(socket, 1, await generateKeyPair("X25519", false), read.code.desktopKey, opening);
  assert.deepEqual(answer, { ok: true, name: "Test computer" });
  await settle();
  assert.deepEqual(
    store.last.phones.map((phone) => phone.name),
    ["Test phone"],
  );
  assert.equal(countLines(newLogLines(), /The phone link could not pass news on to the app\./), 1);
});

test("lets a phone paired before back in, notes when it was last seen, and shows only it as connected", async () => {
  const phoneKey = await generateKeyPair("X25519", false);
  const before: PairedPhone = { key: toBase64Url(phoneKey.publicKey), name: "Test phone", pairedAt: 1_600_000_000_000, lastSeenAt: 1_600_000_000_000 };
  const other: PairedPhone = { key: toBase64Url(randomBytes(32)), name: "Other phone", pairedAt: 1_600_000_000_000, lastSeenAt: 1_600_000_000_000 };
  const state = stateWith({ enabled: true, relayOrigin: RELAY_ORIGIN, phones: [before, other] });
  const { link, opener, store, clock, views } = await openLink(state);
  link.start();
  const socket = await signIn(opener, link);

  const { answer } = await connectPhone(socket, 5, phoneKey, await publicKeyOf("X25519", state.staticKey), { kind: "session" });
  assert.deepEqual(answer, { ok: true, name: "Test computer" });
  const seen: PairedPhone = { ...before, lastSeenAt: clock.now() };
  assert.deepEqual(store.last.phones, [seen, other]);
  await settle();
  assert.deepEqual(views.at(-1)?.phones, [
    { ...seen, connected: true },
    { ...other, connected: false },
  ]);
});

/** Each way a pairing link shown before is put away, so that it pairs nothing. */
const PUT_AWAY: Array<[string, (link: PhoneLink) => void]> = [
  ["Settings puts it away", (link) => link.cancelPairing()],
  [
    "the link is turned off and on again",
    (link) => {
      link.setEnabled(false);
      link.setEnabled(true);
    },
  ],
  ["the relay changes", (link) => link.setRelayOrigin("https://other.example.com")],
];

for (const [when, putAway] of PUT_AWAY) {
  test(`lets no phone pair with a pairing link once ${when}`, async () => {
    const { link, opener, paired } = await openLink(stateWith({ enabled: true, relayOrigin: RELAY_ORIGIN }));
    link.start();
    const first = await signIn(opener, link);
    const shown = link.newPairingLink();
    assert.ok(shown);
    const read = readPairingLink(shown.link);
    assert.ok(read);

    putAway(link);
    // Turning the link off and on, or moving it, makes a new connection to the relay, which the phone comes through.
    const socket = opener.latest === first ? first : await signIn(opener, link);
    const opening: Opening = { kind: "pair", secret: read.code.secret, name: "Test phone" };
    const { answer, link: phone } = await connectPhone(socket, 1, await generateKeyPair("X25519", false), read.code.desktopKey, opening);
    assert.deepEqual(answer, { ok: false, reason: "expired-code" });
    assert.equal(phone, null);
    await settle();
    assert.deepEqual(paired, []);
    assert.deepEqual(link.view().phones, []);
  });
}
