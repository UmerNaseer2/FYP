/**
 * The phone link as a whole (src/main/phone-link.ts). A fake store plays
 * phone-link.json, a fake socket plays the relay, a real handshake plays a
 * phone, a passkey made in software (software-passkey.ts) plays its passkey,
 * and a clock the tests move on by hand drives the timers.
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

import { driftNotification, type DriftAlert } from "../core/drift-alerts";
import { newPhoneLinkState, type PairedPhone, type PhoneLinkState, type PhonePasskey } from "../core/phone-link-file";
import { isPushKey, readPushKey, type PushRequest, type PushResponse, type PushTransport } from "../core/web-push";
import type { Clock } from "../main/clock";
import { initLog, logFilePaths, logWarn } from "../main/log";
import { ALLOW_MS } from "../main/phone-approvals";
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
import { approvalChallenge, approvalFingerprint, type ApprovalScript } from "../shared/remote/approval.js";
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
import { readAnswer, readResult, writeRequest, type Answer, type Request } from "../shared/remote/rpc.js";
import { decrypt, newPhone, subscriptionOf, type Phone } from "./push-phone";
import { assertion, newSoftwarePasskey, registration } from "./software-passkey";

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

/** Plays the phones' push services: notes each request, and gives the answer the test set, or takes the alert. */
class FakePushService {
  requests: PushRequest[] = [];
  answer: (request: PushRequest) => PushResponse | Promise<PushResponse> = () => ({ status: 201, retryAfter: null });

  transport: PushTransport = async (request) => {
    this.requests.push(request);
    return this.answer(request);
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

/** The private keys a state holds, none of which may reach the log. */
function keysIn(state: PhoneLinkState): string[] {
  assert.ok(state.pushKey !== null, "the state has a push key");
  return [state.signingKey, state.staticKey, state.pushKey];
}

/** A paired phone with no drift alerts, which paired and was last seen at the times given. */
function pairedPhone(name: string, pairedAt = 1_600_000_000_000, lastSeenAt = 1_650_000_000_000): PairedPhone {
  return { key: toBase64Url(randomBytes(32)), name, pairedAt, lastSeenAt };
}

/** Drift alerts turned on by a phone browser, a new one unless the test passes its own, through a push service at this endpoint. */
function alertsAt(endpoint: string, browser: Phone = newPhone()) {
  return { ...subscriptionOf(browser, endpoint), since: 1_640_000_000_000 };
}

/** A drift alert about the schema "orders" on connection 5, changed as the test needs. */
function alert(changes: Partial<DriftAlert> = {}): DriftAlert {
  return {
    kind: "drifted",
    eventId: 1,
    trackedSchemaId: 7,
    name: "orders",
    connectionId: 5,
    connectionName: "Production",
    counts: { tablesAdded: 1, tablesRemoved: 0, tablesChanged: 0, constraintsChanged: 0, objectsChanged: 0 },
    drifted: true,
    orgSlug: "acme",
    ...changes,
  };
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
  /** Plays the phones' push services. */
  push: FakePushService;
};

/** Opens a phone link on this store, with fakes for everything else and any options the test changes. */
async function tryOpen(store: FakeStore, changes: Partial<PhoneLinkOptions> = {}): Promise<Fakes & { opening: PhoneLinkOpening }> {
  newLogLines();
  const caller = new FakeCaller();
  const push = new FakePushService();
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
    pushTransport: push.transport,
    ...changes,
  });
  if (opening.ok) link = opening.link;
  return { opening, store, caller, opener, clock, views, paired, push };
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
    { ...state, signingKey: "", staticKey: "", pushKey: "" },
    { enabled: false, relayOrigin: null, sharedConnectionIds: [], phones: [], signingKey: "", staticKey: "", pushKey: "" },
  );
  assert.equal(fromBase64Url(state.signingKey)?.length, 32);
  assert.equal(fromBase64Url(state.staticKey)?.length, 32);
  assert.ok(isPushKey(state.pushKey), "the push key is a P-256 private key");
  assert.equal(new Set(keysIn(state)).size, 3, "the three keys differ");
  assert.equal(countLines(newLogLines(), /Made new keys for the phone link and kept them in a file only you can read\./), 1);

  logWarn(`A message with every key in it: ${keysIn(state).join(" ")}`);
  const logged = newLogLines();
  assert.match(logged, /A message with every key in it/);
  assert.ok(keysIn(state).every((key) => !logged.includes(key)), "the keys are not in the log");
  assert.deepEqual(link.view(), { status: { state: "off" }, enabled: false, relayOrigin: null, sharedConnectionIds: [], phones: [] });
});

test("makes new keys from the random bytes it is given", async () => {
  const store = new FakeStore({ status: "missing" });
  linkOf((await tryOpen(store, { randomBytes: (size) => Buffer.alloc(size, 7) })).opening);
  const key = Buffer.alloc(32, 7).toString("base64url");
  assert.equal(store.last.signingKey, key);
  assert.equal(store.last.staticKey, key);
  assert.equal(store.last.pushKey, key);
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
  logWarn(`A message with every key in it: ${keysIn(state).join(" ")}`);
  const logged = newLogLines();
  assert.ok(keysIn(state).every((key) => !logged.includes(key)), "the keys are not in the log");

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

test("makes a push key for a file with none, saved once, and turns every phone's drift alerts off with it", async () => {
  const alerted = pairedPhone("Alerts phone");
  const quiet = pairedPhone("Quiet phone", 1_600_000_000_000, 1_660_000_000_000);
  const state = stateWith({ pushKey: null, phones: [{ ...alerted, push: alertsAt("https://fcm.googleapis.com/fcm/send/old") }, quiet] });
  const { link, store } = await openLink(state);
  assert.equal(store.saved.length, 1);
  const saved = store.last;
  assert.ok(isPushKey(saved.pushKey), "the new push key is a P-256 private key");
  // Push services take alerts only with the key they were turned on with, so the old subscription goes.
  assert.deepEqual({ ...saved, pushKey: null }, { ...state, phones: [alerted, quiet] });
  assert.equal(
    countLines(newLogLines(), /Made a new key for sending drift alerts to phones, so each phone that had them on needs to turn them on again\./),
    1,
  );
  assert.deepEqual(link.view().phones, [
    { ...alerted, connected: false, alerts: false, approvals: false, approvalsAllowedUntil: null },
    { ...quiet, connected: false, alerts: false, approvals: false, approvalsAllowedUntil: null },
  ]);

  logWarn(`A message with every key in it: ${keysIn(saved).join(" ")}`);
  const logged = newLogLines();
  assert.ok(keysIn(saved).every((key) => !logged.includes(key)), "the new key is not in the log either");
});

test("moves the keys into the login keyring with the same save that keeps a new push key", async () => {
  const state = stateWith({ pushKey: null, phones: [pairedPhone("Quiet phone")] });
  const store = new FakeStore({ status: "values", values: state, protection: "plain", upgrade: true });
  store.protection = "keyring";
  linkOf((await tryOpen(store)).opening);
  assert.equal(store.saved.length, 1);
  assert.ok(isPushKey(store.last.pushKey));
  const logged = newLogLines();
  // With no phone that had alerts on, there is nothing for a phone to do.
  assert.equal(countLines(logged, /Made a new key for sending drift alerts to phones\.$/), 1);
  assert.equal(countLines(logged, /Moved the phone link's keys into the login keyring\./), 1);
});

test("opens with a new push key that cannot be saved, which lasts until Schema Studio quits", async () => {
  const store = new FakeStore(savedAs(stateWith({ pushKey: null })));
  store.failSaves = true;
  const link = linkOf((await tryOpen(store)).opening);
  assert.deepEqual(store.saved, []);
  assert.equal(
    countLines(newLogLines(), /Could not save the phone link's new key for drift alerts, so it lasts only until Schema Studio quits\./),
    1,
  );
  assert.deepEqual(link.view().phones, []);
});

test("shows which phones get drift alerts, and never where the alerts go", async () => {
  const alerted = pairedPhone("Alerts phone");
  const quiet = pairedPhone("Quiet phone");
  const push = alertsAt("https://fcm.googleapis.com/fcm/send/shown");
  const { link, store } = await openLink(stateWith({ phones: [{ ...alerted, push }, quiet] }));
  assert.deepEqual(store.saved, []);
  const view = link.view();
  assert.deepEqual(view.phones, [
    { ...alerted, connected: false, alerts: true, approvals: false, approvalsAllowedUntil: null },
    { ...quiet, connected: false, alerts: false, approvals: false, approvalsAllowedUntil: null },
  ]);
  const shown = JSON.stringify(view);
  assert.ok([push.endpoint, push.p256dh, push.auth].every((part) => !shown.includes(part)), "the view holds nothing of the subscription");
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
  assert.deepEqual(link.view().phones, [{ ...other, connected: false, alerts: false, approvals: false, approvalsAllowedUntil: null }]);
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
  // It shows as connected once a message from it opens.
  assert.deepEqual(link.view().phones, [{ ...saved, connected: false, alerts: false, approvals: false, approvalsAllowedUntil: null }]);
  assert.deepEqual(views.at(-1)?.phones, [{ ...saved, connected: false, alerts: false, approvals: false, approvalsAllowedUntil: null }]);

  // A phone sees only the connections shared with it, and the app is not asked about any other.
  const refused = await ask(phone, socket, 1, { id: 1, method: "schemas.list", params: { connectionId: 3 } });
  assert.deepEqual(refused, readAnswer(writeRefusal(1, "not-shared")));
  assert.deepEqual(caller.calls, []);
  await settle();
  assert.deepEqual(store.last.phones, [saved]);
  assert.deepEqual(link.view().phones, [{ ...saved, connected: true, alerts: false, approvals: false, approvalsAllowedUntil: null }]);
  assert.deepEqual(views.at(-1)?.phones, [{ ...saved, connected: true, alerts: false, approvals: false, approvalsAllowedUntil: null }]);

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

  const { answer, link: phone } = await connectPhone(socket, 5, phoneKey, await publicKeyOf("X25519", state.staticKey), { kind: "session" });
  assert.deepEqual(answer, { ok: true, name: "Test computer" });
  assert.ok(phone);
  // Seen, and connected, only once a message from it opens.
  assert.deepEqual(link.view().phones, [
    { ...before, connected: false, alerts: false, approvals: false, approvalsAllowedUntil: null },
    { ...other, connected: false, alerts: false, approvals: false, approvalsAllowedUntil: null },
  ]);
  const refused = await ask(phone, socket, 5, { id: 1, method: "schemas.list", params: { connectionId: 3 } });
  assert.deepEqual(refused, readAnswer(writeRefusal(1, "not-shared")));
  const seen: PairedPhone = { ...before, lastSeenAt: clock.now() };
  assert.deepEqual(store.last.phones, [seen, other]);
  await settle();
  assert.deepEqual(views.at(-1)?.phones, [
    { ...seen, connected: true, alerts: false, approvals: false, approvalsAllowedUntil: null },
    { ...other, connected: false, alerts: false, approvals: false, approvalsAllowedUntil: null },
  ]);
});

/** What GET /api/me answers with for a role that may see drift. */
const MAY_SEE_DRIFT: AppAnswer = {
  status: 200,
  json: { role: "viewer", roleLabel: "Viewer", permissions: ["drift:read"], bypass: false, viewingAs: null, org: { slug: "personal", name: "Personal" } },
};

test("turns a phone's own drift alerts on and off at its request, saves only a change, and never logs where they go", async () => {
  const phoneKey = await generateKeyPair("X25519", false);
  const before: PairedPhone = { key: toBase64Url(phoneKey.publicKey), name: "Test phone", pairedAt: 1_600_000_000_000, lastSeenAt: 1_600_000_000_000 };
  const other: PairedPhone = { ...pairedPhone("Other phone"), push: alertsAt("https://fcm.googleapis.com/fcm/send/other") };
  const state = stateWith({ enabled: true, relayOrigin: RELAY_ORIGIN, phones: [before, other] });
  const pushKey = readPushKey(state.pushKey)?.publicKey.toString("base64url");
  assert.ok(pushKey, "the state has a push key");
  const { link, opener, store, caller, clock } = await openLink(state);
  caller.answers.set("GET /api/me", MAY_SEE_DRIFT);
  link.start();
  const socket = await signIn(opener, link);
  const { link: phone } = await connectPhone(socket, 5, phoneKey, await publicKeyOf("X25519", state.staticKey), { kind: "session" });
  assert.ok(phone);
  const status = await ask(phone, socket, 5, { id: 1, method: "push.status" });
  assert.deepEqual(status, { id: 1, ok: true, result: { key: pushKey, subscribed: false } });
  const seen: PairedPhone = { ...before, lastSeenAt: clock.now() };

  const mine = subscriptionOf(newPhone(), "https://fcm.googleapis.com/fcm/send/mine");
  const turnedOn = await ask(phone, socket, 5, { id: 2, method: "push.subscribe", params: mine });
  assert.deepEqual(turnedOn, { id: 2, ok: true, result: { key: pushKey, subscribed: true } });
  // Only the phone that asked changes.
  assert.deepEqual(store.last.phones, [{ ...seen, push: { ...mine, since: clock.now() } }, other]);
  assert.deepEqual(
    link.view().phones.map((shown) => shown.alerts),
    [true, true],
  );

  // The same subscription again is no change, so nothing is saved.
  const saves = store.saved.length;
  const again = await ask(phone, socket, 5, { id: 3, method: "push.subscribe", params: mine });
  assert.deepEqual(again, { id: 3, ok: true, result: { key: pushKey, subscribed: true } });
  assert.equal(store.saved.length, saves);

  // A new subscription from the phone's browser takes the old one's place.
  const renewed = subscriptionOf(newPhone(), "https://fcm.googleapis.com/fcm/send/renewed");
  const renewing = await ask(phone, socket, 5, { id: 4, method: "push.subscribe", params: renewed });
  assert.deepEqual(renewing, { id: 4, ok: true, result: { key: pushKey, subscribed: true } });
  assert.deepEqual(store.last.phones, [{ ...seen, push: { ...renewed, since: clock.now() } }, other]);

  const turnedOff = await ask(phone, socket, 5, { id: 5, method: "push.unsubscribe" });
  assert.deepEqual(turnedOff, { id: 5, ok: true, result: { key: pushKey, subscribed: false } });
  // Saved as it was before it turned alerts on, with no push field at all.
  assert.deepEqual(store.last.phones, [seen, other]);
  assert.deepEqual(
    link.view().phones.map((shown) => shown.alerts),
    [false, true],
  );
  const offSaves = store.saved.length;
  const offAgain = await ask(phone, socket, 5, { id: 6, method: "push.unsubscribe" });
  assert.deepEqual(offAgain, { id: 6, ok: true, result: { key: pushKey, subscribed: false } });
  assert.equal(store.saved.length, offSaves);

  const lines = newLogLines();
  assert.equal(countLines(lines, /The phone "Test phone" turned drift alerts on\./), 1);
  assert.equal(countLines(lines, /The phone "Test phone" renewed its drift alerts\./), 1);
  assert.equal(countLines(lines, /The phone "Test phone" turned drift alerts off\./), 1);
  // Where the alerts go, and the keys that encrypt them, never reach the log.
  assert.ok(!lines.includes("fcm.googleapis.com"));
  for (const value of [mine.p256dh, mine.auth, renewed.p256dh, renewed.auth]) assert.ok(!lines.includes(value));
});

test("leaves a phone removed while its drift alerts were being turned on removed", async () => {
  const phoneKey = await generateKeyPair("X25519", false);
  const before: PairedPhone = { key: toBase64Url(phoneKey.publicKey), name: "Test phone", pairedAt: 1_600_000_000_000, lastSeenAt: 1_600_000_000_000 };
  const other = pairedPhone("Other phone");
  const state = stateWith({ enabled: true, relayOrigin: RELAY_ORIGIN, phones: [before, other] });
  // The check of the signed-in role waits until the test lets it answer.
  const roleCheck: { answer: ((answer: AppAnswer) => void) | null } = { answer: null };
  const call: AppCaller = () =>
    new Promise<AppAnswer>((resolve) => {
      roleCheck.answer = resolve;
    });
  const { link, opener, store } = await openLink(state, { call });
  link.start();
  const socket = await signIn(opener, link);
  const { link: phone } = await connectPhone(socket, 5, phoneKey, await publicKeyOf("X25519", state.staticKey), { kind: "session" });
  assert.ok(phone);
  const params = subscriptionOf(newPhone(), "https://fcm.googleapis.com/fcm/send/mine");
  await phone.send(writeRequest({ id: 1, method: "push.subscribe", params }));
  await until(() => roleCheck.answer !== null, "the check of the signed-in role");

  link.forgetPhone(before.key);
  roleCheck.answer?.(MAY_SEE_DRIFT);
  await settle();
  assert.deepEqual(store.last.phones, [other]);
  assert.equal(countLines(newLogLines(), /drift alerts/), 0);
});

/** A link that is turned on, through which phones may see connection 5, with these phones paired. */
function driftState(phones: PairedPhone[]): PhoneLinkState {
  return stateWith({ enabled: true, relayOrigin: RELAY_ORIGIN, sharedConnectionIds: [5], phones });
}

/** The claims in a request's VAPID token, and the public key sent with it. */
function vapidOf(request: PushRequest): { claims: Record<string, unknown>; key: string } {
  const match = /^vapid t=[\w-]+\.([\w-]+)\.[\w-]+, k=([\w-]+)$/.exec(request.headers.Authorization);
  assert.ok(match, "a VAPID Authorization header");
  return { claims: JSON.parse(Buffer.from(match[1], "base64url").toString("utf8")), key: match[2] };
}

test("sends drift alerts about shared connections to each phone that turned them on, and never logs where they go", async () => {
  const firstBrowser = newPhone();
  const secondBrowser = newPhone();
  const first = alertsAt("https://fcm.googleapis.com/fcm/send/first", firstBrowser);
  const second = alertsAt("https://web.push.apple.com/second", secondBrowser);
  const state = driftState([
    { ...pairedPhone("Test phone"), push: first },
    { ...pairedPhone("Other phone"), push: second },
    pairedPhone("Quiet phone"),
  ]);
  const { link, caller, push } = await openLink(state);
  caller.answers.set("GET /api/me", MAY_SEE_DRIFT);
  link.start();

  // Phones may not see connection 9, so that alert stays on the computer.
  await link.pushDrift([alert(), alert({ eventId: 2, trackedSchemaId: 8, connectionId: 9 })]);
  assert.equal(push.requests.length, 2);
  const expected = driftNotification([alert()], { markup: false });
  assert.ok(expected);
  const pushKey = readPushKey(state.pushKey)?.publicKey.toString("base64url");
  assert.ok(pushKey, "the state has a push key");
  const sentTo: Array<[Phone, string]> = [
    [firstBrowser, first.endpoint],
    [secondBrowser, second.endpoint],
  ];
  for (const [browser, endpoint] of sentTo) {
    const request = push.requests.find((sent) => sent.url === endpoint);
    assert.ok(request, "a request to each phone's push service");
    // Only that phone's browser can read it, and it says what the computer's own notification would, as plain text.
    assert.deepEqual(JSON.parse(decrypt(request.body, browser).toString("utf8")), { v: 1, kind: "drift", title: expected.title, body: expected.body });
    const { claims, key } = vapidOf(request);
    assert.equal(claims.sub, RELAY_ORIGIN);
    assert.equal(key, pushKey);
  }
  // The server is asked once whether the signed-in role may see drift, and nothing else.
  assert.deepEqual(caller.calls, [{ method: "GET", path: "/api/me", body: undefined }]);

  // Where the alerts go, and every key, stay out of the log.
  const lines = newLogLines();
  for (const value of ["fcm.googleapis.com", "web.push.apple.com", first.p256dh, first.auth, second.p256dh, second.auth, ...keysIn(state)]) {
    assert.ok(!lines.includes(value));
  }
});

/** Each time phones get no drift alerts, with how a test gets there, giving the alerts the drift watcher found. */
const KEPT_FROM_PHONES: Array<[string, (link: PhoneLink, phoneKey: string) => DriftAlert[]]> = [
  ["the app has not started the link yet", () => [alert()]],
  [
    "the app has stopped the link",
    (link) => {
      link.start();
      link.stop();
      return [alert()];
    },
  ],
  [
    "the link is turned off",
    (link) => {
      link.start();
      link.setEnabled(false);
      return [alert()];
    },
  ],
  [
    "phones may see no connections",
    (link) => {
      link.start();
      link.setSharedConnections([]);
      return [alert()];
    },
  ],
  [
    "the alerts are about connections phones may not see, or about none",
    (link) => {
      link.start();
      return [alert({ connectionId: 9 }), alert({ connectionId: null, connectionName: null })];
    },
  ],
  [
    "the only phone with alerts on is removed",
    (link, phoneKey) => {
      link.start();
      link.forgetPhone(phoneKey);
      return [alert()];
    },
  ],
];

for (const [when, prepare] of KEPT_FROM_PHONES) {
  test(`sends phones no drift alerts, and asks the app's server nothing, when ${when}`, async () => {
    const phone: PairedPhone = { ...pairedPhone("Test phone"), push: alertsAt("https://fcm.googleapis.com/fcm/send/mine") };
    const { link, caller, push } = await openLink(driftState([phone]));
    caller.answers.set("GET /api/me", MAY_SEE_DRIFT);
    await link.pushDrift(prepare(link, phone.key));
    assert.deepEqual(push.requests, []);
    assert.deepEqual(caller.calls, []);
  });
}

test("keeps drift alerts from phones while the signed-in role may not see drift, and says why once each time the reason changes", async () => {
  const phone: PairedPhone = { ...pairedPhone("Test phone"), push: alertsAt("https://fcm.googleapis.com/fcm/send/mine") };
  const { link, caller, push } = await openLink(driftState([phone]));
  link.start();
  const signedOut: AppAnswer = { status: 401, json: { error: "Sign in to use Schema Studio." } };
  const refusals: AppAnswer[] = [
    signedOut,
    signedOut,
    { status: 403, json: { error: "Your role may not do this." } },
    // A role without drift:read is refused for the same reason as a 403, so it is not logged again.
    {
      status: 200,
      json: { role: "viewer", roleLabel: "Viewer", permissions: [], bypass: false, viewingAs: null, org: { slug: "personal", name: "Personal" } },
    },
    { status: 503, json: { error: "The role could not be read." } },
  ];
  for (const answer of refusals) {
    caller.answers.set("GET /api/me", answer);
    await link.pushDrift([alert()]);
  }
  assert.deepEqual(push.requests, []);
  // The server is asked each time, since the role signed in can change at any time.
  assert.equal(caller.calls.length, 5);
  const lines = newLogLines();
  assert.equal(countLines(lines, /because nobody is signed in to Schema Studio\./), 1);
  assert.equal(countLines(lines, /because the signed-in role may not see drift\./), 1);
  assert.equal(countLines(lines, /could not say whether the signed-in role may see drift/), 1);

  caller.answers.set("GET /api/me", MAY_SEE_DRIFT);
  await link.pushDrift([alert()]);
  assert.equal(push.requests.length, 1);
  // Once alerts have gone again, a refusal is news again.
  caller.answers.set("GET /api/me", signedOut);
  await link.pushDrift([alert()]);
  assert.equal(push.requests.length, 1);
  assert.equal(countLines(newLogLines(), /because nobody is signed in to Schema Studio\./), 1);
});

test("turns a phone's drift alerts off once its push service says they have ended", async () => {
  const quiet = pairedPhone("Test phone");
  const mine = alertsAt("https://fcm.googleapis.com/fcm/send/mine");
  const theirs = alertsAt("https://fcm.googleapis.com/fcm/send/other");
  const other: PairedPhone = { ...pairedPhone("Other phone"), push: theirs };
  const { link, caller, push, store } = await openLink(driftState([{ ...quiet, push: mine }, other]));
  caller.answers.set("GET /api/me", MAY_SEE_DRIFT);
  link.start();
  // As when the phone's browser settings turned its alerts off.
  push.answer = (request) => ({ status: request.url === mine.endpoint ? 410 : 201, retryAfter: null });

  await link.pushDrift([alert()]);
  // Saved as it was before it turned alerts on, with no push field at all.
  assert.deepEqual(store.last.phones, [quiet, other]);
  assert.deepEqual(
    link.view().phones.map((shown) => shown.alerts),
    [false, true],
  );
  assert.equal(countLines(newLogLines(), /The push service of the phone "Test phone" says its drift alerts have ended/), 1);

  const sent = push.requests.length;
  await link.pushDrift([alert({ eventId: 2 })]);
  assert.deepEqual(
    push.requests.slice(sent).map((request) => request.url),
    [theirs.endpoint],
  );
});

test("keeps a phone's drift alerts on when it turned them on again while its old subscription was ending", async () => {
  const phoneKey = await generateKeyPair("X25519", false);
  const before: PairedPhone = {
    key: toBase64Url(phoneKey.publicKey),
    name: "Test phone",
    pairedAt: 1_600_000_000_000,
    lastSeenAt: 1_600_000_000_000,
    push: alertsAt("https://fcm.googleapis.com/fcm/send/old"),
  };
  const state = driftState([before]);
  const pushKey = readPushKey(state.pushKey)?.publicKey.toString("base64url");
  assert.ok(pushKey, "the state has a push key");
  const { link, opener, store, caller, push } = await openLink(state);
  caller.answers.set("GET /api/me", MAY_SEE_DRIFT);
  // The old subscription's push service answers only when the test lets it.
  const held: { answer: ((response: PushResponse) => void) | null } = { answer: null };
  push.answer = () =>
    new Promise<PushResponse>((resolve) => {
      held.answer = resolve;
    });
  link.start();
  const socket = await signIn(opener, link);
  const sending = link.pushDrift([alert()]);
  await until(() => held.answer !== null, "the alert to reach the old push service");

  const { link: phone } = await connectPhone(socket, 5, phoneKey, await publicKeyOf("X25519", state.staticKey), { kind: "session" });
  assert.ok(phone);
  const renewed = subscriptionOf(newPhone(), "https://fcm.googleapis.com/fcm/send/renewed");
  const answer = await ask(phone, socket, 5, { id: 1, method: "push.subscribe", params: renewed });
  assert.deepEqual(answer, { id: 1, ok: true, result: { key: pushKey, subscribed: true } });

  // Only the old subscription has ended, so the new one stays.
  held.answer?.({ status: 410, retryAfter: null });
  await sending;
  assert.deepEqual(
    store.last.phones.map((saved) => saved.push?.endpoint),
    [renewed.endpoint],
  );
  assert.deepEqual(
    link.view().phones.map((shown) => shown.alerts),
    [true],
  );
  assert.equal(countLines(newLogLines(), /says its drift alerts have ended/), 0);
});

test("sends drift alerts that come while others are still going in one message, once those have gone", async () => {
  const browser = newPhone();
  const phone: PairedPhone = { ...pairedPhone("Test phone"), push: alertsAt("https://fcm.googleapis.com/fcm/send/mine", browser) };
  const { link, caller, push } = await openLink(driftState([phone]));
  caller.answers.set("GET /api/me", MAY_SEE_DRIFT);
  // The push service answers each request only when the test lets it.
  const held: Array<(response: PushResponse) => void> = [];
  push.answer = () =>
    new Promise<PushResponse>((resolve) => {
      held.push(resolve);
    });
  link.start();

  const first = link.pushDrift([alert()]);
  await until(() => held.length === 1, "the first alert to reach the push service");
  const customers = alert({ eventId: 2, trackedSchemaId: 8, name: "customers" });
  const invoices = alert({ eventId: 3, trackedSchemaId: 9, name: "invoices" });
  const second = link.pushDrift([customers]);
  const third = link.pushDrift([invoices]);
  await settle();
  // Those wait for the first alert to go.
  assert.equal(push.requests.length, 1);

  held[0]({ status: 201, retryAfter: null });
  await until(() => held.length === 2, "the waiting alerts to reach the push service");
  held[1]({ status: 201, retryAfter: null });
  await Promise.all([first, second, third]);
  assert.equal(push.requests.length, 2);
  const merged = driftNotification([customers, invoices], { markup: false });
  assert.ok(merged);
  assert.equal(merged.title, "Drift alerts for 2 schemas");
  assert.deepEqual(JSON.parse(decrypt(push.requests[1].body, browser).toString("utf8")), { v: 1, kind: "drift", title: merged.title, body: merged.body });
  // The server is asked once for each message, not for each alert.
  assert.equal(caller.calls.length, 2);
});

test("gives up on the app's server when it does not say in time whether drift alerts may go to phones", async () => {
  const phone: PairedPhone = { ...pairedPhone("Test phone"), push: alertsAt("https://fcm.googleapis.com/fcm/send/mine") };
  // The server never answers, and stops only when it is told to, as fetch does.
  let asked = 0;
  const call: AppCaller = (_method, _path, _body, signal) =>
    new Promise<AppAnswer>((_resolve, reject) => {
      asked += 1;
      signal.addEventListener("abort", () => reject(signal.reason));
    });
  const { link, clock, push } = await openLink(driftState([phone]), { call });
  link.start();
  const sending = link.pushDrift([alert()]);
  let settled = false;
  void sending.then(() => {
    settled = true;
  });
  await until(() => asked === 1, "the check of the signed-in role");

  clock.advance(29_999);
  await settle();
  assert.equal(settled, false);
  clock.advance(1);
  await sending;
  assert.deepEqual(push.requests, []);
  const lines = newLogLines();
  assert.equal(countLines(lines, /could not say whether the signed-in role may see drift/), 1);
  // The phone link gave up itself, so the app is not said to have failed to answer.
  assert.equal(countLines(lines, /could not reach the app/), 0);
});

/** A passkey kept for a phone, made of random bytes: the phone link only keeps it, and phone-approvals.test.ts checks real ones. */
function keptPasskey(): PhonePasskey {
  return {
    credentialId: toBase64Url(randomBytes(16)),
    publicKey: { x: toBase64Url(randomBytes(32)), y: toBase64Url(randomBytes(32)) },
    signCount: 0,
    approver: "ab".repeat(32),
    addedAt: 1_640_000_000_000,
  };
}

/** When each phone's time to set up approvals ends, as Settings is shown it. */
function allowedUntil(view: PhoneLinkView | undefined): Array<number | null> | undefined {
  return view?.phones.map((phone) => phone.approvalsAllowedUntil);
}

test("lets a paired phone set up approvals for 5 minutes once Settings allows it, and ignores anything else", async () => {
  const phone = pairedPhone("Test phone");
  const other = pairedPhone("Other phone");
  const { link, store, clock, views } = await openLink(stateWith({ enabled: true, relayOrigin: RELAY_ORIGIN, phones: [phone, other] }));
  await settle();
  const shown = views.length;
  for (const key of ["not a key", 42, undefined]) link.allowApprovals(key);
  await settle();
  assert.equal(views.length, shown);
  assert.equal(countLines(newLogLines(), /Approvals may be set up/), 0);

  link.allowApprovals(phone.key);
  const endsAt = clock.now() + ALLOW_MS;
  assert.deepEqual(allowedUntil(link.view()), [endsAt, null]);
  assert.equal(countLines(newLogLines(), /Approvals may be set up on the phone "Test phone" for the next 5 minutes\./), 1);
  await settle();
  assert.deepEqual(allowedUntil(views.at(-1)), [endsAt, null]);
  // Kept in memory only: the time to set up approvals ends with the app.
  assert.deepEqual(store.saved, []);

  clock.advance(ALLOW_MS - 1);
  assert.deepEqual(allowedUntil(link.view()), [endsAt, null]);
  clock.advance(1);
  assert.deepEqual(allowedUntil(link.view()), [null, null]);
  await settle();
  assert.deepEqual(allowedUntil(views.at(-1)), [null, null]);

  // A phone cannot reach the computer while the link is off, so it is given no time then.
  link.setEnabled(false);
  newLogLines();
  link.allowApprovals(phone.key);
  assert.deepEqual(allowedUntil(link.view()), [null, null]);
  assert.equal(countLines(newLogLines(), /Approvals may be set up/), 0);
});

test("ends a phone's time to set up approvals when the link is turned off, moves to another relay or stops", async () => {
  const endings: Array<[string, (link: PhoneLink) => void]> = [
    [
      "turned off and on again",
      (link) => {
        link.setEnabled(false);
        link.setEnabled(true);
      },
    ],
    ["moved to another relay", (link) => assert.equal(link.setRelayOrigin("https://other.example.com"), true)],
    ["stopped", (link) => link.stop()],
  ];
  for (const [what, end] of endings) {
    const phone = pairedPhone("Test phone");
    const { link } = await openLink(stateWith({ enabled: true, relayOrigin: RELAY_ORIGIN, phones: [phone] }));
    link.allowApprovals(phone.key);
    assert.notDeepEqual(allowedUntil(link.view()), [null], what);
    end(link);
    assert.deepEqual(allowedUntil(link.view()), [null], what);
  }
});

test("ends a phone's time to set up approvals when the phone is removed", async () => {
  const phone = pairedPhone("Test phone");
  const { link, clock, views } = await openLink(stateWith({ enabled: true, relayOrigin: RELAY_ORIGIN, phones: [phone] }));
  link.allowApprovals(phone.key);
  link.forgetPhone(phone.key);
  await settle();
  const shown = views.length;
  // Were the time kept, the same phone pairing again within it could set up a passkey with no new Allow
  // approvals. Its timer, left behind, would then run out here and tell Settings.
  clock.advance(ALLOW_MS);
  await settle();
  assert.equal(views.length, shown);
});

test("turns approvals off on a phone from Settings, and shows only whether a phone has them, never its passkey", async () => {
  const paired = pairedPhone("Test phone");
  const passkey = keptPasskey();
  const other = pairedPhone("Other phone");
  const { link, store, views } = await openLink(stateWith({ enabled: true, relayOrigin: RELAY_ORIGIN, phones: [{ ...paired, passkey }, other] }));
  const view = link.view();
  assert.deepEqual(
    view.phones.map((shown) => [shown.approvals, shown.approvalsAllowedUntil]),
    [
      [true, null],
      [false, null],
    ],
  );
  assert.ok(
    view.phones.every((shown) => !("passkey" in shown)),
    "no phone is shown with its passkey",
  );
  const json = JSON.stringify(view);
  assert.ok(
    [passkey.credentialId, passkey.publicKey.x, passkey.publicKey.y, passkey.approver].every((part) => !json.includes(part)),
    "the view holds nothing of the passkey",
  );

  newLogLines();
  for (const key of ["not a key", 42]) link.turnOffApprovals(key);
  assert.deepEqual(store.saved, []);
  assert.equal(newLogLines(), "");

  link.allowApprovals(paired.key);
  link.turnOffApprovals(paired.key);
  // Saved as the phone was before approvals were set up on it, with no passkey field at all.
  assert.equal(store.saved.length, 1);
  assert.deepEqual(store.last.phones, [paired, other]);
  assert.deepEqual(
    link.view().phones.map((shown) => [shown.approvals, shown.approvalsAllowedUntil]),
    [
      [false, null],
      [false, null],
    ],
  );
  assert.equal(countLines(newLogLines(), /Approvals were turned off on the phone "Test phone"\./), 1);

  // A phone with no passkey yet only loses its time to set one up: nothing is saved, and Settings is told all the same.
  link.allowApprovals(other.key);
  await settle();
  const before = views.length;
  link.turnOffApprovals(other.key);
  await settle();
  assert.equal(store.saved.length, 1);
  assert.equal(views.length, before + 1);
  assert.deepEqual(allowedUntil(views.at(-1)), [null, null]);
  assert.equal(countLines(newLogLines(), /The phone "Other phone" may no longer set up approvals\./), 1);
});

test("turns approvals off on every phone when the relay moves, as a passkey signs for one relay only", async () => {
  const first = pairedPhone("First phone");
  const second: PairedPhone = { ...pairedPhone("Second phone"), push: alertsAt("https://fcm.googleapis.com/fcm/send/kept") };
  const third = pairedPhone("Third phone");
  const { link, store } = await openLink(
    stateWith({ enabled: true, relayOrigin: RELAY_ORIGIN, phones: [{ ...first, passkey: keptPasskey() }, { ...second, passkey: keptPasskey() }, third] }),
  );
  assert.equal(link.setRelayOrigin(RELAY_ORIGIN), true);
  assert.deepEqual(store.saved, []);

  assert.equal(link.setRelayOrigin("https://other.example.com"), true);
  // Drift alerts come through the phones' push services, not the relay, so they stay on.
  assert.deepEqual(store.last.phones, [first, second, third]);
  assert.deepEqual(
    link.view().phones.map((shown) => [shown.approvals, shown.alerts]),
    [
      [false, false],
      [false, true],
      [false, false],
    ],
  );
  assert.equal(countLines(newLogLines(), /Approvals were turned off on 2 phones, since their passkeys were made for the old relay\./), 1);

  const only = pairedPhone("Only phone");
  const { link: moved } = await openLink(stateWith({ enabled: true, relayOrigin: RELAY_ORIGIN, phones: [{ ...only, passkey: keptPasskey() }] }));
  assert.equal(moved.setRelayOrigin("https://other.example.com"), true);
  assert.equal(countLines(newLogLines(), /Approvals were turned off on 1 phone, since its passkey was made for the old relay\./), 1);
  assert.equal(moved.setRelayOrigin("https://third.example.com"), true);
  assert.equal(countLines(newLogLines(), /Approvals were turned off/), 0);
});

/** The SQL of the deploy request the phone decides on below. */
const APPROVAL_SCRIPTS: ApprovalScript[] = [{ name: "add_order_note", version: "1.1.0", sql: "ALTER TABLE orders ADD COLUMN note text;" }];

/** A deploy request of APPROVAL_SCRIPTS waiting on this connection, as the app's server lists it for phones. */
function approvalRequest(id: number, connectionId: number, fingerprint: string) {
  return {
    id,
    connectionId,
    schemaName: "public",
    scriptName: "add_order_note",
    targetVersion: "1.1.0",
    action: "deploy",
    migrationCount: 1,
    breakingCount: 0,
    requestedBy: "someone@example.com",
    requestedAt: "2026-10-20T09:30:00.000Z",
    note: null,
    fingerprint,
    sql: "kept",
    ownRequest: false,
  };
}

test("lets only the phone Settings allowed set up a passkey through the relay, then approve with it", async () => {
  const phoneKey = await generateKeyPair("X25519", false);
  const otherKey = await generateKeyPair("X25519", false);
  const phone: PairedPhone = { key: toBase64Url(phoneKey.publicKey), name: "Test phone", pairedAt: 1_600_000_000_000, lastSeenAt: 1_600_000_000_000 };
  const other: PairedPhone = { key: toBase64Url(otherKey.publicKey), name: "Other phone", pairedAt: 1_600_000_000_000, lastSeenAt: 1_600_000_000_000 };
  const state = stateWith({ enabled: true, relayOrigin: RELAY_ORIGIN, sharedConnectionIds: [5], phones: [phone, other] });
  const { link, opener, store, caller, clock } = await openLink(state);
  const approver = "ab".repeat(32);
  const fingerprint = await approvalFingerprint(APPROVAL_SCRIPTS, "deploy");
  caller.answers.set("GET /api/deploy/approvals/phone", {
    status: 200,
    json: { approver, canApprove: true, approvals: [approvalRequest(12, 5, fingerprint), approvalRequest(13, 9, fingerprint)] },
  });
  const kept = APPROVAL_SCRIPTS.map((script) => ({ scriptName: script.name, version: script.version, sqlContent: script.sql }));
  caller.answers.set("GET /api/deploy/approvals/12/phone", { status: 200, json: { id: 12, action: "deploy", fingerprint, scripts: kept } });
  caller.answers.set("POST /api/deploy/approvals/12", { status: 200, json: { approval: { id: 12, status: "approved" } } });
  link.start();
  const socket = await signIn(opener, link);
  const computerKey = await publicKeyOf("X25519", state.staticKey);
  const { link: first } = await connectPhone(socket, 5, phoneKey, computerKey, { kind: "session" });
  const { link: second } = await connectPhone(socket, 6, otherKey, computerKey, { kind: "session" });
  assert.ok(first && second);

  assert.deepEqual(await ask(first, socket, 5, { id: 1, method: "passkey.begin" }), readAnswer(writeRefusal(1, "not-allowed")));
  link.allowApprovals(phone.key);
  // Only the phone Settings named may set one up.
  assert.deepEqual(await ask(second, socket, 6, { id: 2, method: "passkey.begin" }), readAnswer(writeRefusal(2, "not-allowed")));
  const begun = await ask(first, socket, 5, { id: 3, method: "passkey.begin" });
  const challenge = begun?.ok === true ? readResult("passkey.begin", begun.result) : null;
  assert.ok(challenge, "the phone Settings allowed is given a challenge");
  const challengeBytes = fromBase64Url(challenge.challenge);
  assert.ok(challengeBytes);
  assert.equal(challengeBytes.length, 32);
  assert.equal(fromBase64Url(challenge.userId)?.length, 16);

  // Each phone sees the requests on the shared connections, and what it can do about them.
  assert.deepEqual(await ask(first, socket, 5, { id: 4, method: "approvals.list" }), {
    id: 4,
    ok: true,
    result: { approvals: [approvalRequest(12, 5, fingerprint)], passkey: "allowed", canApprove: true },
  });
  assert.deepEqual(await ask(second, socket, 6, { id: 5, method: "approvals.list" }), {
    id: 5,
    ok: true,
    result: { approvals: [approvalRequest(12, 5, fingerprint)], passkey: "none", canApprove: true },
  });

  // The passkey is made for the relay, which the phone app is served from.
  const onRelay = { origin: RELAY_ORIGIN, rpId: new URL(RELAY_ORIGIN).hostname };
  const passkey = newSoftwarePasskey(5);
  const made = registration(passkey, challengeBytes, onRelay);
  const finished = await ask(first, socket, 5, {
    id: 6,
    method: "passkey.finish",
    params: { clientDataJSON: made.clientDataJSON.toString("base64url"), attestationObject: made.attestationObject.toString("base64url") },
  });
  assert.deepEqual(finished, { id: 6, ok: true, result: { passkey: "ready" } });
  const now = clock.now();
  const setUp: PhonePasskey = {
    credentialId: passkey.credentialId.toString("base64url"),
    publicKey: { x: passkey.x.toString("base64url"), y: passkey.y.toString("base64url") },
    signCount: 5,
    approver,
    addedAt: now,
  };
  assert.deepEqual(store.last.phones, [
    { ...phone, lastSeenAt: now, passkey: setUp },
    { ...other, lastSeenAt: now },
  ]);
  assert.deepEqual(
    link.view().phones.map((shown) => [shown.approvals, shown.approvalsAllowedUntil]),
    [
      [true, null],
      [false, null],
    ],
  );

  // The phone reads the exact SQL, then signs its decision on it.
  assert.deepEqual(await ask(first, socket, 5, { id: 7, method: "approvals.read", params: { approvalId: 12 } }), {
    id: 7,
    ok: true,
    result: { id: 12, action: "deploy", fingerprint, scripts: APPROVAL_SCRIPTS },
  });
  const numbered = await ask(first, socket, 5, { id: 8, method: "approvals.begin" });
  const decision = numbered?.ok === true ? readResult("approvals.begin", numbered.result) : null;
  assert.ok(decision, "the phone with a passkey is given a one-time number");
  assert.equal(decision.credentialId, setUp.credentialId);
  const nonce = fromBase64Url(decision.nonce);
  assert.ok(nonce);
  const signed = assertion(passkey, await approvalChallenge(nonce, 12, "approve", fingerprint), onRelay);
  const signature = signed.signature.toString("base64url");
  const decided = await ask(first, socket, 5, {
    id: 9,
    method: "approvals.decide",
    params: {
      approvalId: 12,
      decision: "approve",
      fingerprint,
      assertion: {
        credentialId: setUp.credentialId,
        authenticatorData: signed.authenticatorData.toString("base64url"),
        clientDataJSON: signed.clientDataJSON.toString("base64url"),
        signature,
      },
    },
  });
  assert.deepEqual(decided, { id: 9, ok: true, result: { status: "approved" } });
  // The app is told what the phone signed, and who for, with no note.
  assert.deepEqual(
    caller.calls.filter((call) => call.method === "POST"),
    [{ method: "POST", path: "/api/deploy/approvals/12", body: { decision: "approve", expectedFingerprint: fingerprint, expectedApprover: approver } }],
  );
  // The passkey's counter went up, and is kept, so that a copy of the passkey would show.
  assert.deepEqual(store.last.phones[0]?.passkey, { ...setUp, signCount: 6 });

  // The other phone has no passkey to decide with.
  assert.deepEqual(await ask(second, socket, 6, { id: 10, method: "approvals.begin" }), readAnswer(writeRefusal(10, "no-passkey")));

  const lines = newLogLines();
  assert.equal(countLines(lines, /Approvals may be set up on the phone "Test phone" for the next 5 minutes\./), 1);
  assert.equal(countLines(lines, /The phone "Test phone" set up approvals\./), 1);
  assert.equal(countLines(lines, /The phone "Test phone" approved approval request 12\./), 1);
  // Nothing the phone was given to sign, nothing it signed, and nothing about whose passkey it is reaches the log.
  assert.ok(
    [challenge.challenge, challenge.userId, decision.nonce, setUp.credentialId, signature, approver].every((part) => !lines.includes(part)),
    "the log holds nothing of the passkey or the person",
  );
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
