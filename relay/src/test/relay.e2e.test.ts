/**
 * The whole relay (src/worker.ts and src/room.ts), run on this machine by
 * wrangler the way Cloudflare runs it, with real WebSocket connections from
 * pretend computers and phones.
 */
import assert from "node:assert/strict";
import test, { after, afterEach, before } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { createTestHarness } from "wrangler";

import { MAX_PHONES, SIGN_IN_MS } from "../room-logic.js";
import type { Bytes } from "../shared/remote/bytes.js";
import { generateKeyPair, type KeyPair } from "../shared/remote/keys.js";
import { desktopIdFor, signChallenge } from "../shared/remote/relay-auth.js";
import {
  addChannel,
  CLOSE_BROKEN,
  CLOSE_FULL,
  CLOSE_REPLACED,
  CLOSE_SENT_AWAY,
  CLOSE_SIGN_IN_FAILED,
  CLOSE_TOO_BIG,
  MAX_RELAY_MESSAGE_BYTES,
  PING,
  PONG,
  readControl,
  relayPath,
  writeControl,
  type Control,
  type Role,
} from "../shared/remote/relay-protocol.js";

/** The relay as wrangler.jsonc describes it. This file runs from out/test, two folders below relay/. */
const harness = createTestHarness({ root: fileURLToPath(new URL("../..", import.meta.url)), workers: [{ configPath: "wrangler.jsonc" }] });
/** Where the relay listens, once it has started. */
let base: URL;
/** How long to wait for something the relay should do at once. */
const PATIENCE_MS = 5000;
/** Every connection the current test opened. */
const clients: Client[] = [];

before(async () => {
  base = (await harness.listen()).url;
});

// So a test that fails leaves no connections behind.
afterEach(() => {
  for (const client of clients.splice(0)) client.close();
});

after(async () => {
  await harness.close();
});

/** Waits until check gives something, and gives that. */
async function waitFor<T>(what: string, check: () => T | undefined, patience = PATIENCE_MS): Promise<T> {
  const giveUpAt = Date.now() + patience;
  while (true) {
    const value = check();
    if (value !== undefined) return value;
    if (Date.now() > giveUpAt) throw new Error(`Waited ${patience / 1000} seconds for ${what}.`);
    await sleep(10);
  }
}

/** How a connection was closed. */
type Closed = { code: number; reason: string };

/**
 * A real WebSocket connection to one of a room's doors, which keeps what the
 * relay sends it until the test asks for it.
 */
class Client {
  readonly name: string;
  private readonly socket: WebSocket;
  private readonly received: (string | Bytes)[] = [];
  /** How the connection was closed, or null while it is open. */
  private closed: Closed | null = null;
  /** Whether the relay has answered the ping this end sends as soon as it connects. */
  private helloAnswered = false;

  /**
   * Connects to the door for this role. origin is the web site a browser
   * would say opened the connection; the desktop app says none.
   */
  constructor(name: string, role: Role, desktopId: string, origin?: string) {
    this.name = name;
    const url = new URL(relayPath(role, desktopId), base);
    url.protocol = "ws:";
    this.socket = new WebSocket(url, { headers: origin === undefined ? {} : { Origin: origin } });
    this.socket.binaryType = "arraybuffer";
    // As the desktop app and the phone app do (see relay-protocol.ts), so the
    // relay's closes reach this end at once.
    this.socket.addEventListener("open", () => {
      this.socket.send(PING);
    });
    this.socket.addEventListener("message", (event) => {
      // A text message arrives as a string, and binaryType makes a binary one an ArrayBuffer.
      const message = typeof event.data === "string" ? event.data : new Uint8Array(event.data as ArrayBuffer);
      // The relay answers pings in order, so the first pong answers that first ping, which no test asked for.
      if (message === PONG && !this.helloAnswered) {
        this.helloAnswered = true;
        return;
      }
      this.received.push(message);
    });
    this.socket.addEventListener("close", (event) => {
      this.closed = { code: event.code, reason: event.reason };
    });
    clients.push(this);
  }

  /** The next message the relay sends, once it comes. */
  next(): Promise<string | Bytes> {
    return waitFor(`a message to ${this.name}`, () => {
      const message = this.received.shift();
      if (message === undefined && this.closed !== null) {
        throw new Error(`${this.name} was closed with code ${this.closed.code} while waiting for a message.`);
      }
      return message;
    });
  }

  /** The next message, which must be a control message. */
  async nextControl(): Promise<Control> {
    const message = await this.next();
    const control = typeof message === "string" ? readControl(message) : null;
    if (control === null) throw new Error(`Expected a control message at ${this.name}, but the relay sent ${String(message)}.`);
    return control;
  }

  /** The challenge the relay sends a computer when it connects. */
  async challenge(): Promise<Bytes> {
    const control = await this.nextControl();
    if (control.type !== "challenge") throw new Error(`Expected a challenge at ${this.name}, but the relay sent ${control.type}.`);
    return control.challenge;
  }

  /** Answers a challenge, signing it with this key. */
  async answer(challenge: Bytes, key: KeyPair): Promise<void> {
    this.send(writeControl({ type: "auth", publicKey: key.publicKey, signature: await signChallenge(key, challenge) }));
  }

  /** Signs in as the computer with this key. */
  async signIn(key: KeyPair): Promise<void> {
    await this.answer(await this.challenge(), key);
    assert.deepEqual(await this.nextControl(), { type: "ready" }, `${this.name} did not sign in.`);
  }

  /** Sends a message. The connection must be open, which it is once the relay has sent it something. */
  send(message: string | Bytes): void {
    this.socket.send(message);
  }

  /** Whether either end has started to close the connection, which may be a while before it has gone. */
  get closing(): boolean {
    return this.socket.readyState >= WebSocket.CLOSING;
  }

  /** How the connection was closed, once it has been. */
  whenClosed(patience = PATIENCE_MS): Promise<Closed> {
    return waitFor(`${this.name} to be closed`, () => this.closed ?? undefined, patience);
  }

  /** Closes the connection from this end. */
  close(): void {
    this.socket.close();
  }
}

/** A pretend computer: its signing key, and the ID of its room. */
type Computer = { key: KeyPair; id: string };

/** A new computer, so that no two tests share a room. */
async function newComputer(): Promise<Computer> {
  const key = await generateKeyPair("Ed25519", false);
  return { key, id: await desktopIdFor(key.publicKey) };
}

/** Connects a computer to its room and signs it in. */
async function signedIn(computer: Computer, name = "desktop"): Promise<Client> {
  const desktop = new Client(name, "desktop", computer.id);
  await desktop.signIn(computer.key);
  return desktop;
}

/** Connects a phone while its computer is signed in, and gives the channel the relay opened for it. */
async function connectPhone(computer: Computer, desktop: Client, name = "phone"): Promise<{ phone: Client; channel: number }> {
  const phone = new Client(name, "phone", computer.id);
  assert.deepEqual(await phone.nextControl(), { type: "online" }, name);
  const opened = await desktop.nextControl();
  if (opened.type !== "open") throw new Error(`Expected an open at ${desktop.name}, but the relay sent ${opened.type}.`);
  return { phone, channel: opened.channel };
}

/** Connects a phone while its computer is not there. */
async function waitingPhone(computer: Computer, name = "phone"): Promise<Client> {
  const phone = new Client(name, "phone", computer.id);
  assert.deepEqual(await phone.nextControl(), { type: "offline" }, name);
  return phone;
}

/** Bytes of this length that are not all the same, so one out of place would show. */
function sample(length: number): Bytes {
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i++) bytes[i] = i % 251;
  return bytes;
}

test("lets in only WebSocket connections to a room's doors, and none from other web sites", async () => {
  const computer = await newComputer();
  // "/" is the phone app now, so an address with nothing at it stands in for it.
  for (const path of ["/nothing-here", "/v1/phone/short", `/v1/laptop/${computer.id}`, `/v1/phone/${computer.id}/more`]) {
    const response = await harness.fetch(path);
    assert.equal(response.status, 404, path);
    await response.text();
  }
  const plain = await harness.fetch(relayPath("phone", computer.id));
  assert.equal(plain.status, 426);
  await plain.text();
  const elsewhere = await harness.fetch(relayPath("phone", computer.id), { headers: { Upgrade: "websocket", Origin: "https://example.com" } });
  assert.equal(elsewhere.status, 403);
  await elsewhere.text();
  // The phone app is served from the relay itself, so it connects from the relay's own web site.
  const phoneApp = new Client("phone app", "phone", computer.id, base.origin);
  assert.deepEqual(await phoneApp.nextControl(), { type: "offline" });
});

test("serves the phone app from the relay's own address, with its security headers", async () => {
  const page = await harness.fetch("/");
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type") ?? "", /^text\/html/);
  assert.match(page.headers.get("content-security-policy") ?? "", /connect-src 'self'/);
  assert.equal(page.headers.get("x-content-type-options"), "nosniff");
  assert.equal(page.headers.get("referrer-policy"), "no-referrer");
  assert.equal(page.headers.get("cross-origin-opener-policy"), "same-origin");
  await page.text();
});

test("tells a waiting phone when its computer signs in, and the computer about the phone", async () => {
  const computer = await newComputer();
  const phone = await waitingPhone(computer);
  const desktop = await signedIn(computer);
  assert.deepEqual(await phone.nextControl(), { type: "online" });
  assert.equal((await desktop.nextControl()).type, "open");
});

test("sends away a connection that cannot prove the room is its own, and keeps the computer that did", async () => {
  const computer = await newComputer();
  const desktop = await signedIn(computer);
  const stranger = new Client("stranger", "desktop", computer.id);
  await stranger.answer(await stranger.challenge(), (await newComputer()).key);
  const closed = await stranger.whenClosed();
  assert.equal(closed.code, CLOSE_SIGN_IN_FAILED);
  assert.match(closed.reason, /did not prove/);
  // The room is still the computer's: a phone that comes now is put through to it.
  await connectPhone(computer, desktop);
});

test("passes messages between a phone and its computer exactly as they were sent", async () => {
  const computer = await newComputer();
  const desktop = await signedIn(computer);
  const { phone, channel } = await connectPhone(computer, desktop);
  // The biggest message the relay passes on, and the smallest.
  for (const message of [sample(MAX_RELAY_MESSAGE_BYTES), sample(1)]) {
    phone.send(message);
    assert.deepEqual(await desktop.next(), addChannel(channel, message), `${message.length} bytes from the phone`);
    desktop.send(addChannel(channel, message));
    assert.deepEqual(await phone.next(), message, `${message.length} bytes to the phone`);
  }
});

test("answers pings from a computer before and after it signs in, and from a phone", async () => {
  const computer = await newComputer();
  const desktop = new Client("desktop", "desktop", computer.id);
  const challenge = await desktop.challenge();
  desktop.send(PING);
  assert.equal(await desktop.next(), PONG);
  await desktop.answer(challenge, computer.key);
  assert.deepEqual(await desktop.nextControl(), { type: "ready" });
  desktop.send(PING);
  assert.equal(await desktop.next(), PONG);
  const { phone } = await connectPhone(computer, desktop);
  phone.send(PING);
  assert.equal(await phone.next(), PONG);
});

test("tells the computer when a phone leaves, and sends a phone away when the computer asks", async () => {
  const computer = await newComputer();
  const desktop = await signedIn(computer);
  const leaving = await connectPhone(computer, desktop, "leaving phone");
  const sentAway = await connectPhone(computer, desktop, "phone sent away");
  leaving.phone.close();
  assert.deepEqual(await desktop.nextControl(), { type: "close", channel: leaving.channel });
  desktop.send(writeControl({ type: "close", channel: sentAway.channel }));
  assert.equal((await sentAway.phone.whenClosed()).code, CLOSE_SENT_AWAY);
});

test("tells the phones when their computer leaves", async () => {
  const computer = await newComputer();
  const desktop = await signedIn(computer);
  const { phone } = await connectPhone(computer, desktop);
  desktop.close();
  assert.deepEqual(await phone.nextControl(), { type: "offline" });
});

test("hands the room to the computer's new connection, and starts its phones again with it", async () => {
  const computer = await newComputer();
  const old = await signedIn(computer, "old desktop");
  const { phone } = await connectPhone(computer, old);
  const fresh = await signedIn(computer, "new desktop");
  assert.equal((await old.whenClosed()).code, CLOSE_REPLACED);
  assert.deepEqual(await phone.nextControl(), { type: "offline" });
  assert.deepEqual(await phone.nextControl(), { type: "online" });
  assert.equal((await fresh.nextControl()).type, "open");
});

test("carries on as before after its room has slept", async () => {
  const computer = await newComputer();
  const desktop = await signedIn(computer);
  const { phone, channel } = await connectPhone(computer, desktop);
  // What Cloudflare does with a room that has nothing to do: it takes the
  // room out of memory, but keeps its connections open.
  await harness.getWorker().evictDurableObject("Room", { name: computer.id, webSockets: "hibernate" });
  const message = sample(100);
  phone.send(message);
  assert.deepEqual(await desktop.next(), addChannel(channel, message));
  desktop.send(addChannel(channel, message));
  assert.deepEqual(await phone.next(), message);
  await connectPhone(computer, desktop, "second phone");
});

test("sends away a connection that sends what it should not", async () => {
  const computer = await newComputer();
  const big = await waitingPhone(computer, "phone with too big a message");
  big.send(new Uint8Array(MAX_RELAY_MESSAGE_BYTES + 1));
  assert.equal((await big.whenClosed()).code, CLOSE_TOO_BIG);
  const broken = await waitingPhone(computer, "phone that says hello");
  broken.send("hello");
  assert.equal((await broken.whenClosed()).code, CLOSE_BROKEN);
});

test("lets only so many phones connect to a computer at once", async () => {
  const computer = await newComputer();
  for (let i = 0; i < MAX_PHONES; i++) await waitingPhone(computer, `phone ${i}`);
  const extra = new Client("extra phone", "phone", computer.id);
  // The room closes the extra phone before it can send its first ping, and
  // the Workers runtime then holds on to the connection until the room next
  // sleeps (see relay-protocol.ts). Putting the room to sleep lets it go now.
  await waitFor("the relay to close the extra phone", () => (extra.closing ? true : undefined));
  await harness.getWorker().evictDurableObject("Room", { name: computer.id, webSockets: "hibernate" });
  assert.equal((await extra.whenClosed()).code, CLOSE_FULL);
});

// Last, as it waits for a whole sign-in's time to run out.
test("sends away a connection that does not sign in in time", async () => {
  const computer = await newComputer();
  const slow = new Client("slow desktop", "desktop", computer.id);
  await slow.challenge();
  const closed = await slow.whenClosed(SIGN_IN_MS + PATIENCE_MS);
  assert.equal(closed.code, CLOSE_SIGN_IN_FAILED);
  assert.match(closed.reason, /in time/);
});
