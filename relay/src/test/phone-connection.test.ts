/**
 * The phone's connection to the computer through the relay
 * (src/phone/connection.ts). A fake socket plays the relay, a fake computer
 * answers the handshake with real keys, and a clock the tests move on by hand
 * drives the pings, the waits and the time limits.
 */
import assert from "node:assert/strict";
import test from "node:test";

import type { Clock } from "../phone/clock.js";
import {
  CONNECT_WITHIN_MS,
  END_MESSAGES,
  FIRST_WAIT_MS,
  HANDSHAKE_WITHIN_MS,
  MAX_WAIT_MS,
  PhoneConnection,
  PING_EVERY_MS,
  PROBE_WITHIN_MS,
  RpcError,
  STEADY_MS,
  type ConnectionState,
  type Pairing,
  type PhoneConnectionOptions,
  type PhoneSocket,
  type SocketEvents,
} from "../phone/connection.js";
import { randomBytes, sameBytes, toBase64Url, utf8, type Bytes } from "../shared/remote/bytes.js";
import { generateKeyPair, KEY_BYTES } from "../shared/remote/keys.js";
import { Link } from "../shared/remote/link.js";
import { Responder } from "../shared/remote/noise.js";
import {
  PAIRING_LIFETIME_MS,
  PAIRING_SECRET_BYTES,
  PHONE_LINK_PROLOGUE,
  readOpening,
  writeOpeningAnswer,
  type Opening,
  type OpeningAnswer,
} from "../shared/remote/pairing.js";
import { DESKTOP_ID_BYTES } from "../shared/remote/relay-auth.js";
import {
  CLOSE_BROKEN,
  CLOSE_FULL,
  CLOSE_SENT_AWAY,
  CLOSE_TOO_BIG,
  CLOSE_TOO_FAST,
  PING,
  PONG,
  relaySocketUrl,
  writeControl,
} from "../shared/remote/relay-protocol.js";
import {
  ANSWER_WITHIN_MS,
  MAX_REQUEST_BYTES,
  readRequest,
  writeError,
  writeResult,
  type ConnectionList,
  type HelloResult,
  type Request,
} from "../shared/remote/rpc.js";

const RELAY = "https://relay.example.com";
const COMPUTER_KEY = await generateKeyPair("X25519", false);
const PHONE_KEY = await generateKeyPair("X25519", false);
const DESKTOP_ID = toBase64Url(randomBytes(DESKTOP_ID_BYTES));
const SECRET = randomBytes(PAIRING_SECRET_BYTES);
const COMPUTER_NAME = "Test computer";
/** When each test starts, on its own clock. */
const START = 1_700_000_000_000;

// The messages the relay sends that say nothing more than their kind.
const ONLINE = writeControl({ type: "online" });
const OFFLINE = writeControl({ type: "offline" });

const HELLO: HelloResult = { signedIn: true, role: "Admin", canCompare: true, canReadSchemas: true, appVersion: "1.0.0" };
const CONNECTIONS: ConnectionList = { connections: [{ id: 1, name: "Shop", environment: "prod", database: "shop" }] };
const NOT_SHARED = "That connection is not shared with phones. Share it in Schema Studio's Settings on the computer.";
const WELCOME: OpeningAnswer = { ok: true, name: COMPUTER_NAME };

// What the phone says when it cannot reach the relay, and when it cannot read an answer. connection.ts keeps them to itself.
const UNREACHABLE = "The relay could not be reached. Check the phone's internet connection.";
const VERSION_MISMATCH =
  "This phone app and Schema Studio on the computer are different versions, so the phone could not read the computer's answer. Update Schema Studio on the computer.";

type Timer = { at: number; run: () => void; id: number };

/** A clock that moves only when a test moves it on. */
class FakeClock implements Clock {
  time = START;
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

  /** How many timers are set and have not run yet. */
  get pending(): number {
    return this.timers.length;
  }

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

/** Waits, in real time, until `check` is true: the handshake and the encryption run for real, so it takes a moment. */
async function until(check: () => boolean, what: string): Promise<void> {
  const giveUpAt = Date.now() + 5_000;
  while (!check()) {
    if (Date.now() > giveUpAt) throw new Error(`Gave up waiting for ${what}.`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Gives the phone time to send anything it was going to send. */
function quiet(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 100));
}

/** A socket the test plays the relay through. It fires no event by itself: the test fires each one. */
class FakeSocket implements PhoneSocket {
  /** What the phone sent, in order. */
  readonly sent: (string | Bytes)[] = [];
  stage: "connecting" | "open" | "closed" = "connecting";
  /** The code the phone closed it with, or null while the phone has not closed it. */
  closedWith: number | null = null;
  /** Set to make every send throw, as a socket that has gone might. */
  broken = false;

  constructor(
    readonly url: string,
    readonly events: SocketEvents,
  ) {}

  send(data: string | Bytes): void {
    if (this.stage === "connecting" || this.broken) throw new Error("The socket cannot send.");
    // Like a browser's WebSocket, a socket that has closed drops what it is given.
    if (this.stage === "open") this.sent.push(data);
  }

  close(code: number): void {
    if (this.stage !== "closed") this.closedWith = code;
    this.stage = "closed";
  }

  /** The relay takes the connection. */
  accept(): void {
    this.stage = "open";
    this.events.opened();
  }

  /** The relay says something. */
  say(text: string): void {
    this.events.text(text);
  }

  /** The relay closes the connection. */
  drop(code: number): void {
    this.stage = "closed";
    this.events.closed(code);
  }
}

/** The computer's end of an open link, and how many of the phone's binary messages it has read. */
type Computer = { socket: FakeSocket; link: Link; read: number };
/** How the computer answers an opening. "garbage" is an answer the phone cannot read. */
type Decision = OpeningAnswer | "garbage";
type Setup = { phone: PhoneConnection; clock: FakeClock; sockets: FakeSocket[]; states: ConnectionState[]; paired: string[] };

/** The binary messages the phone sent: the handshake and the sealed requests. */
function binaries(socket: FakeSocket): Bytes[] {
  return socket.sent.filter((data): data is Bytes => typeof data !== "string");
}

/** How many pings the phone sent the relay. */
function pings(socket: FakeSocket): number {
  return socket.sent.filter((data) => data === PING).length;
}

/** The socket the phone opened last. */
function latest(sockets: FakeSocket[]): FakeSocket {
  const socket = sockets.at(-1);
  assert.ok(socket !== undefined, "The phone has not opened a socket.");
  return socket;
}

/** The phone's state, read through a call so that TypeScript does not carry what one check found over to the next. */
function stateOf(phone: PhoneConnection): ConnectionState {
  return phone.state;
}

/** How long the phone will wait before it tries again, and why. */
function retrying(phone: PhoneConnection, clock: FakeClock): { wait: number; reason: string } {
  const state = phone.state;
  if (state.kind !== "retrying") throw new Error(`Expected the phone to be waiting to try again, but it is ${state.kind}.`);
  return { wait: state.retryAt - clock.now(), reason: state.reason };
}

/** The error a request fails with. Called as the request is made, so that its failure is never left unhandled. */
async function failure(request: Promise<unknown>): Promise<RpcError> {
  try {
    await request;
  } catch (error) {
    assert.ok(error instanceof RpcError, `Expected an RpcError, but the request failed with ${String(error)}.`);
    return error;
  }
  throw new Error("The request succeeded, but it should have failed.");
}

/** The pairing code the phone was given, running out at `until`. */
function pairingUntil(until: number): Pairing {
  return { secret: SECRET, name: "Test phone", until };
}

/** Lets the phone in after checking it sent the code it was given and its own key. */
function welcomePairing(opening: Opening, phoneKey: Bytes): Decision {
  if (opening.kind !== "pair") throw new Error(`Expected the phone to pair, but it asked to open a ${opening.kind}.`);
  assert.ok(sameBytes(opening.secret, SECRET), "The phone sent a pairing secret it was not given.");
  assert.equal(opening.name, "Test phone");
  assert.ok(sameBytes(phoneKey, PHONE_KEY.publicKey), "The phone sent a key that is not its own.");
  return WELCOME;
}

/** Lets the phone in after checking it asked to open a session: a paired phone never sends its code again. */
function welcomeSession(opening: Opening): Decision {
  assert.deepEqual(opening, { kind: "session" });
  return WELCOME;
}

/**
 * Plays the computer's side of the handshake: reads the phone's opening (the
 * binary message at `from`), lets `decide` choose the answer, and sends it.
 * Gives the computer's end of the link when it lets the phone in.
 */
async function computerAnswers(
  socket: FakeSocket,
  decide: (opening: Opening, phoneKey: Bytes) => Decision,
  { from = 0, thenClose }: { from?: number; thenClose?: number } = {},
): Promise<Computer | null> {
  await until(() => binaries(socket).length > from, "the phone's opening");
  const responder = new Responder({ prologue: PHONE_LINK_PROLOGUE, staticKey: COMPUTER_KEY });
  const first = await responder.readFirstMessage(binaries(socket)[from]);
  const opening = readOpening(first.payload);
  assert.ok(opening !== null, "The phone's opening could not be read.");
  const decision = decide(opening, first.remoteStaticKey);
  const { message, session } = await responder.writeAnswer(decision === "garbage" ? utf8("not an answer") : writeOpeningAnswer(decision));
  socket.events.binary(message);
  // As when the computer turns a phone away: the relay closes the phone's connection straight after the answer.
  if (thenClose !== undefined) socket.drop(thenClose);
  if (decision === "garbage" || !decision.ok) return null;
  return { socket, link: new Link(session, (sealed) => socket.events.binary(sealed)), read: from + 1 };
}

/** Reads the next request the phone sent. They are read in the order they were sent, as the link's encryption needs. */
async function nextRequest(computer: Computer): Promise<Request> {
  await until(() => binaries(computer.socket).length > computer.read, "a request from the phone");
  const piece = binaries(computer.socket)[computer.read];
  computer.read += 1;
  const message = await computer.link.receive(piece);
  assert.ok(message !== null, "A request came in more than one piece.");
  const reading = readRequest(message);
  if (!reading.ok) throw new Error("The computer could not read the phone's request.");
  return reading.request;
}

/** Moves time on in steps of ten seconds, with the relay answering each ping the phone sends on the way. */
function advanceAnswering(clock: FakeClock, socket: FakeSocket, ms: number): void {
  let answered = pings(socket);
  for (let left = ms; left > 0; left -= 10_000) {
    clock.advance(Math.min(left, 10_000));
    for (const sent = pings(socket); answered < sent; answered += 1) socket.say(PONG);
  }
}

/** A phone that is pairing, unless `overrides` says otherwise, on a clock and sockets the test controls. */
function setUp(overrides: Partial<PhoneConnectionOptions> = {}): Setup {
  const clock = new FakeClock();
  const sockets: FakeSocket[] = [];
  const states: ConnectionState[] = [];
  const paired: string[] = [];
  const phone = new PhoneConnection({
    relayOrigin: RELAY,
    desktopId: DESKTOP_ID,
    desktopKey: COMPUTER_KEY.publicKey,
    staticKey: PHONE_KEY,
    pairing: pairingUntil(START + PAIRING_LIFETIME_MS),
    onPaired: async (name) => {
      paired.push(name);
    },
    onState: (state) => {
      states.push(state);
    },
    openSocket: (url, events) => {
      const socket = new FakeSocket(url, events);
      sockets.push(socket);
      return socket;
    },
    clock,
    // The longest wait every time, so that each wait is exact.
    random: () => 1,
    ...overrides,
  });
  return { phone, clock, sockets, states, paired };
}

/** Starts the phone, has the relay say the computer is there, and has the computer let the phone in. */
async function connectPhone({ phone, sockets }: Setup): Promise<Computer> {
  phone.start();
  const socket = latest(sockets);
  socket.accept();
  socket.say(ONLINE);
  const computer = await computerAnswers(socket, () => WELCOME);
  assert.ok(computer !== null, "The computer did not let the phone in.");
  await until(() => stateOf(phone).kind === "ready", "the link to open");
  return computer;
}

/**
 * Pairs as far as the phone's opening, then has the relay drop the
 * connection before the computer's answer gets through, and has the computer
 * turn the code away when the phone tries it again, as it would if it had
 * used the code on the answer that was lost. Gives the socket the phone opens
 * next.
 */
async function loseThePairingAnswer({ phone, clock, sockets }: Setup): Promise<FakeSocket> {
  phone.start();
  const first = latest(sockets);
  first.accept();
  first.say(ONLINE);
  await until(() => binaries(first).length > 0, "the phone's opening");
  first.drop(1006);
  assert.deepEqual(retrying(phone, clock), { wait: FIRST_WAIT_MS, reason: "The connection to the relay closed." });
  clock.advance(FIRST_WAIT_MS);
  const second = latest(sockets);
  second.accept();
  second.say(ONLINE);
  const refusal = (opening: Opening): Decision => {
    assert.equal(opening.kind, "pair");
    return { ok: false, reason: "expired-code" };
  };
  assert.equal(await computerAnswers(second, refusal, { thenClose: CLOSE_SENT_AWAY }), null);
  // No time passes: the phone asks straight away whether the lost answer paired it.
  await until(() => sockets.length > 2, "the phone to ask whether it was paired");
  const third = latest(sockets);
  third.accept();
  third.say(ONLINE);
  return third;
}

test("pairs, and asks the computer nothing until the pairing is saved", async () => {
  const names: string[] = [];
  let saved: () => void = () => {
    throw new Error("The phone has not started saving the pairing.");
  };
  const { phone, clock, sockets, states } = setUp({
    onPaired: (name) =>
      new Promise<void>((resolve) => {
        names.push(name);
        saved = () => resolve();
      }),
  });
  const hello = phone.request({ method: "hello" });
  phone.start();
  const socket = latest(sockets);
  assert.equal(socket.url, relaySocketUrl(RELAY, "phone", DESKTOP_ID));
  socket.accept();
  socket.say(ONLINE);
  const computer = await computerAnswers(socket, welcomePairing);
  assert.ok(computer !== null, "The computer did not let the phone in.");
  await until(() => names.length > 0, "the phone to save the pairing");
  await quiet();
  // Only the opening has gone: the request waits until the pairing is saved.
  assert.equal(binaries(socket).length, 1);
  assert.equal(stateOf(phone).kind, "opening");
  saved();
  await until(() => stateOf(phone).kind === "ready", "the link to open");
  assert.deepEqual(await nextRequest(computer), { id: 1, method: "hello" });
  await computer.link.send(writeResult(1, "hello", HELLO));
  assert.deepEqual(await hello, HELLO);
  assert.deepEqual(names, [COMPUTER_NAME]);
  assert.deepEqual(
    states.map((state) => state.kind),
    ["connecting", "opening", "ready"],
  );
  // Only the ping is left to come: the code's time limit went once the computer let the phone in.
  assert.equal(clock.pending, 1);
});

test("waits on the open connection while the computer is away, and opens a session when it comes", async () => {
  const { phone, clock, sockets, paired } = setUp({ pairing: undefined });
  phone.start();
  phone.start();
  assert.equal(sockets.length, 1);
  const socket = latest(sockets);
  socket.accept();
  socket.say(OFFLINE);
  assert.equal(stateOf(phone).kind, "waiting");
  assert.equal(clock.pending, 1);
  advanceAnswering(clock, socket, 10 * 60_000);
  assert.equal(stateOf(phone).kind, "waiting");
  assert.equal(latest(sockets), socket);
  const list = phone.request({ method: "connections.list" });
  socket.say(ONLINE);
  const computer = await computerAnswers(socket, welcomeSession);
  assert.ok(computer !== null, "The computer did not let the phone in.");
  await until(() => stateOf(phone).kind === "ready", "the link to open");
  assert.deepEqual(await nextRequest(computer), { id: 1, method: "connections.list" });
  await computer.link.send(writeResult(1, "connections.list", CONNECTIONS));
  assert.deepEqual(await list, CONNECTIONS);
  assert.deepEqual(paired, []);
});

test("has at most four requests at the computer at once, and sends the next as each is answered", async () => {
  const setup = setUp();
  const computer = await connectPhone(setup);
  const { phone } = setup;
  const hello = phone.request({ method: "hello" });
  const list = phone.request({ method: "connections.list" });
  const schemas = [1, 2, 3, 4].map((connectionId) => phone.request({ method: "schemas.list", params: { connectionId } }));
  const first: Request[] = [];
  for (let i = 0; i < 4; i += 1) first.push(await nextRequest(computer));
  assert.deepEqual(
    first.map((request) => request.id),
    [1, 2, 3, 4],
  );
  await quiet();
  // The opening and the first four requests: the other two wait their turn.
  assert.equal(binaries(computer.socket).length, 5);
  await computer.link.send(writeResult(3, "schemas.list", { schemas: ["schema_1"] }));
  assert.deepEqual(await nextRequest(computer), { id: 5, method: "schemas.list", params: { connectionId: 3 } });
  await quiet();
  assert.equal(binaries(computer.socket).length, 6);
  await computer.link.send(writeResult(1, "hello", HELLO));
  assert.deepEqual(await nextRequest(computer), { id: 6, method: "schemas.list", params: { connectionId: 4 } });
  await computer.link.send(writeResult(2, "connections.list", CONNECTIONS));
  for (const id of [4, 5, 6]) await computer.link.send(writeResult(id, "schemas.list", { schemas: [`schema_${id - 2}`] }));
  assert.deepEqual(await hello, HELLO);
  assert.deepEqual(await list, CONNECTIONS);
  assert.deepEqual(
    await Promise.all(schemas),
    [1, 2, 3, 4].map((n) => ({ schemas: [`schema_${n}`] })),
  );
});

for (const [why, pairing] of [
  ["expired-code", true],
  ["too-many-phones", true],
  ["not-paired", false],
] as const) {
  for (const thenClose of [undefined, CLOSE_SENT_AWAY]) {
    const how = thenClose === undefined ? "" : ", even when the relay closes the connection first";
    test(`stops for good when the computer turns it away with ${why}${how}`, async () => {
      const { phone, clock, sockets } = setUp(pairing ? {} : { pairing: undefined });
      const asked = failure(phone.request({ method: "hello" }));
      phone.start();
      const socket = latest(sockets);
      socket.accept();
      socket.say(ONLINE);
      assert.equal(await computerAnswers(socket, () => ({ ok: false, reason: why }), { thenClose }), null);
      await until(() => stateOf(phone).kind === "ended", "the phone to stop");
      assert.deepEqual(stateOf(phone), { kind: "ended", why, message: END_MESSAGES[why] });
      const error = await asked;
      assert.equal(error.code, "ended");
      assert.equal(error.message, END_MESSAGES[why]);
      assert.equal(clock.pending, 0);
      assert.equal(sockets.length, 1);
      assert.equal(socket.stage, "closed");
      // The phone closes the connection itself unless the relay got there first.
      assert.equal(socket.closedWith, thenClose === undefined ? 1000 : null);
      assert.equal((await failure(phone.request({ method: "hello" }))).code, "ended");
      clock.advance(3_600_000);
      phone.wake();
      assert.equal(latest(sockets), socket);
    });
  }
}

test("asks whether it was paired when the answer to its pairing may have been lost", async () => {
  const setup = setUp();
  const { phone, clock, paired } = setup;
  const third = await loseThePairingAnswer(setup);
  const computer = await computerAnswers(third, welcomeSession);
  assert.ok(computer !== null, "The computer did not let the phone in.");
  await until(() => stateOf(phone).kind === "ready", "the link to open");
  assert.deepEqual(paired, [COMPUTER_NAME]);
  assert.equal(clock.pending, 1);
});

test("stops with the code's refusal when the computer turns out not to know the phone", async () => {
  const setup = setUp();
  const { phone, paired } = setup;
  const third = await loseThePairingAnswer(setup);
  const refusal = (opening: Opening): Decision => {
    assert.deepEqual(opening, { kind: "session" });
    return { ok: false, reason: "not-paired" };
  };
  assert.equal(await computerAnswers(third, refusal, { thenClose: CLOSE_SENT_AWAY }), null);
  await until(() => stateOf(phone).kind === "ended", "the phone to stop");
  assert.deepEqual(stateOf(phone), { kind: "ended", why: "expired-code", message: END_MESSAGES["expired-code"] });
  assert.deepEqual(paired, []);
});

test("stops pairing when the code runs out before the relay takes the connection", () => {
  const { phone, clock, sockets } = setUp({ pairing: pairingUntil(START + 10_000) });
  phone.start();
  clock.advance(10_000);
  assert.deepEqual(stateOf(phone), { kind: "ended", why: "pairing-timed-out", message: END_MESSAGES["pairing-timed-out"] });
  assert.equal(latest(sockets).closedWith, 1000);
  assert.equal(clock.pending, 0);
});

test("still waits for the answer when the code runs out after its opening went, and asks for a session if none comes", async () => {
  const { phone, clock, sockets, paired } = setUp({ pairing: pairingUntil(START + 10_000) });
  phone.start();
  const first = latest(sockets);
  first.accept();
  first.say(ONLINE);
  await until(() => binaries(first).length > 0, "the phone's opening");
  clock.advance(10_000);
  assert.equal(stateOf(phone).kind, "opening");
  clock.advance(25_000);
  assert.equal(pings(first), 1);
  assert.deepEqual(retrying(phone, clock), { wait: FIRST_WAIT_MS, reason: "The computer did not answer." });
  assert.equal(first.closedWith, 1000);
  clock.advance(FIRST_WAIT_MS);
  const second = latest(sockets);
  second.accept();
  second.say(ONLINE);
  // The code has run out, so the phone does not send it again: it asks whether the computer paired it before.
  const computer = await computerAnswers(second, welcomeSession);
  assert.ok(computer !== null, "The computer did not let the phone in.");
  await until(() => stateOf(phone).kind === "ready", "the link to open");
  assert.deepEqual(paired, [COMPUTER_NAME]);
});

test("does not start pairing with a code that has already run out", async () => {
  const { phone, clock, sockets } = setUp({ pairing: pairingUntil(START) });
  const asked = failure(phone.request({ method: "hello" }));
  phone.start();
  assert.deepEqual(stateOf(phone), { kind: "ended", why: "pairing-timed-out", message: END_MESSAGES["pairing-timed-out"] });
  assert.equal(sockets.length, 0);
  assert.equal(clock.pending, 0);
  const error = await asked;
  assert.equal(error.code, "ended");
  assert.equal(error.message, END_MESSAGES["pairing-timed-out"]);
});

const FAILING_SAVES: [string, (computerName: string) => Promise<void>][] = [
  ["fails", () => Promise.reject(new Error("The disk is full."))],
  [
    "throws",
    () => {
      throw new Error("The disk is full.");
    },
  ],
];

for (const [how, onPaired] of FAILING_SAVES) {
  test(`stops, and does not stay paired, when saving the pairing ${how}`, async () => {
    const { phone, clock, sockets } = setUp({ onPaired });
    const asked = failure(phone.request({ method: "hello" }));
    phone.start();
    const socket = latest(sockets);
    socket.accept();
    socket.say(ONLINE);
    assert.ok((await computerAnswers(socket, welcomePairing)) !== null, "The computer did not let the phone in.");
    await until(() => stateOf(phone).kind === "ended", "the phone to stop");
    assert.deepEqual(stateOf(phone), { kind: "ended", why: "save-failed", message: END_MESSAGES["save-failed"] });
    const error = await asked;
    assert.equal(error.code, "ended");
    assert.equal(error.message, END_MESSAGES["save-failed"]);
    assert.equal(socket.closedWith, 1000);
    assert.equal(clock.pending, 0);
  });
}

test("waits twice as long after each try that fails, up to its longest wait, and starts again once a connection has held", () => {
  const { phone, clock, sockets } = setUp({ pairing: undefined });
  phone.start();
  const waits: number[] = [];
  for (let i = 0; i < 7; i += 1) {
    latest(sockets).drop(1006);
    const { wait, reason } = retrying(phone, clock);
    assert.equal(reason, UNREACHABLE);
    waits.push(wait);
    clock.advance(wait);
  }
  assert.deepEqual(waits, [FIRST_WAIT_MS, 2_000, 4_000, 8_000, 16_000, MAX_WAIT_MS, MAX_WAIT_MS]);
  assert.equal(sockets.length, 8);
  const socket = latest(sockets);
  socket.accept();
  socket.say(OFFLINE);
  advanceAnswering(clock, socket, STEADY_MS);
  socket.drop(1006);
  assert.deepEqual(retrying(phone, clock), { wait: FIRST_WAIT_MS, reason: "The connection to the relay closed." });
});

test("waits a random part of each wait, never less than half of it", () => {
  const { phone, clock, sockets } = setUp({ pairing: undefined, random: () => 0 });
  phone.start();
  latest(sockets).drop(1006);
  assert.equal(retrying(phone, clock).wait, FIRST_WAIT_MS / 2);
});

const CLOSES: [number, string, number][] = [
  [CLOSE_SENT_AWAY, "The computer ended the connection.", FIRST_WAIT_MS],
  [CLOSE_FULL, "Too many phones are connected to the computer right now.", MAX_WAIT_MS],
  [CLOSE_BROKEN, "The relay could not read what this phone sent.", FIRST_WAIT_MS],
  [CLOSE_TOO_BIG, "The relay could not read what this phone sent.", FIRST_WAIT_MS],
  [CLOSE_TOO_FAST, "The relay said this phone sent too much at once.", MAX_WAIT_MS],
  [1006, "The connection to the relay closed.", FIRST_WAIT_MS],
];

for (const [code, reason, wait] of CLOSES) {
  test(`says why, and waits ${wait} ms, when the relay closes the connection with code ${code}`, () => {
    const { phone, clock, sockets } = setUp({ pairing: undefined });
    phone.start();
    const socket = latest(sockets);
    socket.accept();
    socket.drop(code);
    assert.deepEqual(retrying(phone, clock), { wait, reason });
    clock.advance(wait);
    assert.equal(sockets.length, 2);
  });
}

test("fails the requests at the computer when the connection is lost, and sends the others once it is back", async () => {
  const setup = setUp();
  const { phone, clock, sockets, paired } = setup;
  const computer = await connectPhone(setup);
  const lost = [1, 2, 3, 4].map((connectionId) => failure(phone.request({ method: "schemas.list", params: { connectionId } })));
  const hello = phone.request({ method: "hello" });
  const list = phone.request({ method: "connections.list" });
  await until(() => binaries(computer.socket).length >= 5, "the first four requests");
  computer.socket.drop(1006);
  for (const error of await Promise.all(lost)) {
    assert.equal(error.code, "lost");
    assert.equal(error.message, "The connection to the computer was lost before it answered.");
  }
  assert.equal(stateOf(phone).kind, "retrying");
  clock.advance(FIRST_WAIT_MS);
  const second = latest(sockets);
  second.accept();
  second.say(ONLINE);
  const back = await computerAnswers(second, welcomeSession);
  assert.ok(back !== null, "The computer did not let the phone in again.");
  await until(() => stateOf(phone).kind === "ready", "the link to open again");
  assert.deepEqual(await nextRequest(back), { id: 5, method: "hello" });
  assert.deepEqual(await nextRequest(back), { id: 6, method: "connections.list" });
  await back.link.send(writeResult(5, "hello", HELLO));
  await back.link.send(writeResult(6, "connections.list", CONNECTIONS));
  assert.deepEqual(await hello, HELLO);
  assert.deepEqual(await list, CONNECTIONS);
  assert.deepEqual(paired, [COMPUTER_NAME]);
});

test("fails a request the computer takes too long to answer, and lets a late answer go", async () => {
  const setup = setUp();
  const { phone, clock } = setup;
  const computer = await connectPhone(setup);
  const slow = [1, 2, 3, 4].map((connectionId) => failure(phone.request({ method: "schemas.list", params: { connectionId } })));
  const hello = phone.request({ method: "hello" });
  for (let id = 1; id <= 4; id += 1) assert.equal((await nextRequest(computer)).id, id);
  advanceAnswering(clock, computer.socket, ANSWER_WITHIN_MS);
  for (const error of await Promise.all(slow)) {
    assert.equal(error.code, "failed");
    assert.equal(error.message, "The computer took too long to answer.");
  }
  assert.deepEqual(await nextRequest(computer), { id: 5, method: "hello" });
  await computer.link.send(writeResult(1, "schemas.list", { schemas: ["late"] }));
  await quiet();
  assert.equal(stateOf(phone).kind, "ready");
  await computer.link.send(writeResult(5, "hello", HELLO));
  assert.deepEqual(await hello, HELLO);
});

test("tells an answer it cannot use apart from an error the computer sent", async () => {
  const setup = setUp();
  const { phone } = setup;
  const computer = await connectPhone(setup);
  const hello = failure(phone.request({ method: "hello" }));
  const schemas = failure(phone.request({ method: "schemas.list", params: { connectionId: 9 } }));
  assert.equal((await nextRequest(computer)).id, 1);
  assert.equal((await nextRequest(computer)).id, 2);
  await computer.link.send(utf8(JSON.stringify({ id: 1, result: { signedIn: "yes" } })));
  const unusable = await hello;
  assert.equal(unusable.code, "version");
  assert.equal(unusable.message, VERSION_MISMATCH);
  await computer.link.send(writeError(2, "not-shared", NOT_SHARED));
  const refused = await schemas;
  assert.equal(refused.code, "not-shared");
  assert.equal(refused.message, NOT_SHARED);
  assert.equal(stateOf(phone).kind, "ready");
});

test("pings the relay while it waits, and closes the connection when the relay stops answering", () => {
  const { phone, clock, sockets } = setUp({ pairing: undefined });
  phone.start();
  const socket = latest(sockets);
  socket.accept();
  socket.say(OFFLINE);
  clock.advance(PING_EVERY_MS);
  assert.equal(pings(socket), 1);
  clock.advance(PING_EVERY_MS);
  assert.equal(pings(socket), 2);
  assert.equal(stateOf(phone).kind, "waiting");
  clock.advance(PING_EVERY_MS);
  assert.deepEqual(retrying(phone, clock), { wait: FIRST_WAIT_MS, reason: "The relay stopped answering." });
  assert.equal(socket.closedWith, 1000);
  assert.equal(pings(socket), 2);
});

test("keeps a quiet connection open for as long as the relay answers its pings", () => {
  const { phone, clock, sockets } = setUp({ pairing: undefined });
  phone.start();
  const socket = latest(sockets);
  socket.accept();
  socket.say(OFFLINE);
  advanceAnswering(clock, socket, 10 * 60_000);
  assert.equal(pings(socket), 20);
  assert.equal(stateOf(phone).kind, "waiting");
  assert.equal(sockets.length, 1);
});

test("tries again when a ping cannot be sent", () => {
  const { phone, clock, sockets } = setUp({ pairing: undefined });
  phone.start();
  const socket = latest(sockets);
  socket.accept();
  socket.say(OFFLINE);
  socket.broken = true;
  clock.advance(PING_EVERY_MS);
  assert.deepEqual(retrying(phone, clock), { wait: FIRST_WAIT_MS, reason: "The connection to the relay closed." });
  assert.equal(socket.closedWith, 1000);
  assert.equal(clock.pending, 1);
});

test("tries again at once when woken while it waits to try again, and starts its waits over", () => {
  const { phone, clock, sockets } = setUp({ pairing: undefined });
  phone.start();
  clock.advance(CONNECT_WITHIN_MS);
  assert.deepEqual(retrying(phone, clock), { wait: FIRST_WAIT_MS, reason: UNREACHABLE });
  phone.wake();
  assert.equal(sockets.length, 2);
  assert.equal(stateOf(phone).kind, "connecting");
  latest(sockets).drop(1006);
  assert.deepEqual(retrying(phone, clock), { wait: FIRST_WAIT_MS, reason: UNREACHABLE });
});

test("checks the relay is still there when woken on an open connection, one check at a time", () => {
  const { phone, clock, sockets } = setUp({ pairing: undefined });
  phone.start();
  const socket = latest(sockets);
  socket.accept();
  socket.say(OFFLINE);
  phone.wake();
  phone.wake();
  assert.equal(pings(socket), 1);
  socket.say(PONG);
  clock.advance(PROBE_WITHIN_MS);
  assert.equal(stateOf(phone).kind, "waiting");
  phone.wake();
  assert.equal(pings(socket), 2);
  clock.advance(PROBE_WITHIN_MS);
  assert.deepEqual(retrying(phone, clock), { wait: FIRST_WAIT_MS, reason: "The relay stopped answering." });
  assert.equal(socket.closedWith, 1000);
});

test("lets a connection that is still opening carry on when woken", () => {
  const { phone, sockets } = setUp({ pairing: undefined });
  phone.start();
  phone.wake();
  assert.equal(sockets.length, 1);
  assert.deepEqual(latest(sockets).sent, []);
  assert.equal(stateOf(phone).kind, "connecting");
});

test("stays off when woken after it was stopped", () => {
  const { phone, sockets } = setUp({ pairing: undefined });
  phone.start();
  phone.stop();
  phone.wake();
  assert.equal(sockets.length, 1);
  assert.deepEqual(stateOf(phone), { kind: "off" });
});

test("fails every request and closes the connection when stopped, and does not start again", async () => {
  const setup = setUp();
  const { phone, clock, sockets } = setup;
  const computer = await connectPhone(setup);
  const asked = [1, 2, 3, 4, 5].map((connectionId) => failure(phone.request({ method: "schemas.list", params: { connectionId } })));
  phone.stop();
  assert.deepEqual(stateOf(phone), { kind: "off" });
  for (const error of await Promise.all(asked)) {
    assert.equal(error.code, "ended");
    assert.equal(error.message, "The phone link was stopped.");
  }
  assert.equal(computer.socket.closedWith, 1000);
  assert.equal(clock.pending, 0);
  assert.equal((await failure(phone.request({ method: "hello" }))).code, "ended");
  clock.advance(3_600_000);
  phone.start();
  assert.equal(sockets.length, 1);
});

test("tries again when the computer's answer to the handshake cannot be read", async () => {
  const { phone, clock, sockets, paired } = setUp();
  phone.start();
  const first = latest(sockets);
  first.accept();
  first.say(ONLINE);
  await until(() => binaries(first).length > 0, "the phone's opening");
  first.events.binary(randomBytes(48));
  await until(() => stateOf(phone).kind === "retrying", "the phone to try again");
  assert.deepEqual(retrying(phone, clock), { wait: FIRST_WAIT_MS, reason: "The computer's answer could not be read." });
  clock.advance(FIRST_WAIT_MS);
  const second = latest(sockets);
  second.accept();
  second.say(ONLINE);
  assert.ok((await computerAnswers(second, welcomePairing)) !== null, "The computer did not let the phone in.");
  await until(() => stateOf(phone).kind === "ready", "the link to open");
  assert.deepEqual(paired, [COMPUTER_NAME]);
});

test("stops when it can open the computer's answer to its opening but not understand it", async () => {
  const { phone, sockets } = setUp();
  phone.start();
  const socket = latest(sockets);
  socket.accept();
  socket.say(ONLINE);
  assert.equal(await computerAnswers(socket, () => "garbage"), null);
  await until(() => stateOf(phone).kind === "ended", "the phone to stop");
  assert.deepEqual(stateOf(phone), { kind: "ended", why: "version", message: END_MESSAGES.version });
  assert.equal(socket.closedWith, 1000);
});

test("gives the relay a time limit to take the connection", () => {
  const { phone, clock, sockets } = setUp({ pairing: undefined });
  phone.start();
  clock.advance(CONNECT_WITHIN_MS);
  assert.deepEqual(retrying(phone, clock), { wait: FIRST_WAIT_MS, reason: UNREACHABLE });
  assert.equal(latest(sockets).closedWith, 1000);
});

test("gives the relay a time limit to say whether the computer is there", () => {
  const { phone, clock, sockets } = setUp({ pairing: undefined });
  phone.start();
  const socket = latest(sockets);
  socket.accept();
  clock.advance(CONNECT_WITHIN_MS);
  assert.deepEqual(retrying(phone, clock), { wait: FIRST_WAIT_MS, reason: "The relay did not say whether the computer is there." });
  assert.equal(pings(socket), 0);
});

test("gives the computer a time limit to answer the handshake", async () => {
  const { phone, clock, sockets } = setUp({ pairing: undefined });
  phone.start();
  const socket = latest(sockets);
  socket.accept();
  socket.say(ONLINE);
  await until(() => binaries(socket).length > 0, "the phone's opening");
  clock.advance(HANDSHAKE_WITHIN_MS);
  assert.deepEqual(retrying(phone, clock), { wait: FIRST_WAIT_MS, reason: "The computer did not answer." });
});

test("tries again later when the browser will not open a connection at all", () => {
  const { phone, clock, states } = setUp({
    pairing: undefined,
    openSocket: () => {
      throw new Error("No sockets here.");
    },
  });
  phone.start();
  assert.deepEqual(states, [{ kind: "retrying", retryAt: START + FIRST_WAIT_MS, reason: UNREACHABLE }]);
  clock.advance(FIRST_WAIT_MS);
  assert.equal(retrying(phone, clock).wait, 2_000);
});

test("fails what the computer was asked when it goes, and opens a new session on the same connection when it is back", async () => {
  const setup = setUp();
  const { phone, sockets, paired } = setup;
  const computer = await connectPhone(setup);
  const before = failure(phone.request({ method: "hello" }));
  assert.equal((await nextRequest(computer)).id, 1);
  computer.socket.say(OFFLINE);
  assert.equal((await before).code, "lost");
  assert.equal(stateOf(phone).kind, "waiting");
  computer.socket.say(ONLINE);
  const back = await computerAnswers(computer.socket, welcomeSession, { from: computer.read });
  assert.ok(back !== null, "The computer did not let the phone in again.");
  await until(() => stateOf(phone).kind === "ready", "the new session to open");
  const hello = phone.request({ method: "hello" });
  assert.deepEqual(await nextRequest(back), { id: 2, method: "hello" });
  await back.link.send(writeResult(2, "hello", HELLO));
  assert.deepEqual(await hello, HELLO);
  const during = failure(phone.request({ method: "connections.list" }));
  assert.equal((await nextRequest(back)).id, 3);
  // The computer is there again with no word that it went: it went and came back, and the session it had went with it.
  computer.socket.say(ONLINE);
  assert.equal((await during).code, "lost");
  const again = await computerAnswers(computer.socket, welcomeSession, { from: back.read });
  assert.ok(again !== null, "The computer did not let the phone in again.");
  await until(() => stateOf(phone).kind === "ready", "the next session to open");
  assert.deepEqual(paired, [COMPUTER_NAME]);
  assert.equal(sockets.length, 1);
});

test("turns down a request too big to send, and goes on with the next", async () => {
  const setup = setUp();
  const { phone } = setup;
  const computer = await connectPhone(setup);
  const big = await failure(phone.request({ method: "schema.read", params: { connectionId: 1, schema: "x".repeat(MAX_REQUEST_BYTES) } }));
  assert.equal(big.code, "too-big");
  assert.equal(big.message, "This request is too big to send to the computer.");
  await quiet();
  assert.equal(binaries(computer.socket).length, 1);
  const hello = phone.request({ method: "hello" });
  assert.deepEqual(await nextRequest(computer), { id: 2, method: "hello" });
  await computer.link.send(writeResult(2, "hello", HELLO));
  assert.deepEqual(await hello, HELLO);
});

test("stops when the computer sends something that is not an answer", async () => {
  const setup = setUp();
  const { phone } = setup;
  const computer = await connectPhone(setup);
  const hello = failure(phone.request({ method: "hello" }));
  assert.equal((await nextRequest(computer)).id, 1);
  await computer.link.send(utf8("hello there"));
  const error = await hello;
  assert.equal(error.code, "ended");
  assert.equal(error.message, END_MESSAGES.version);
  assert.deepEqual(stateOf(phone), { kind: "ended", why: "version", message: END_MESSAGES.version });
});

test("stays paired when the relay closes the connection straight after the computer lets it in", async () => {
  const { phone, clock, sockets, states, paired } = setUp();
  phone.start();
  const first = latest(sockets);
  first.accept();
  first.say(ONLINE);
  assert.ok((await computerAnswers(first, welcomePairing, { thenClose: 1006 })) !== null, "The computer did not let the phone in.");
  await until(() => stateOf(phone).kind === "retrying" && paired.length > 0, "the phone to save the pairing and try again");
  assert.deepEqual(retrying(phone, clock), { wait: FIRST_WAIT_MS, reason: "The connection to the relay closed." });
  assert.deepEqual(paired, [COMPUTER_NAME]);
  assert.ok(!states.some((state) => state.kind === "ready"), "The phone said it was connected on a connection that had closed.");
  clock.advance(FIRST_WAIT_MS);
  const second = latest(sockets);
  second.accept();
  second.say(ONLINE);
  assert.ok((await computerAnswers(second, welcomeSession)) !== null, "The computer did not let the phone in.");
  await until(() => stateOf(phone).kind === "ready", "the link to open");
  assert.deepEqual(paired, [COMPUTER_NAME]);
});

test("closes the connection when the relay passes on a message before the computer is there", () => {
  const { phone, clock, sockets } = setUp({ pairing: undefined });
  phone.start();
  const socket = latest(sockets);
  socket.accept();
  socket.say(OFFLINE);
  socket.events.binary(randomBytes(40));
  assert.deepEqual(retrying(phone, clock), { wait: FIRST_WAIT_MS, reason: "The relay passed on a message at the wrong time." });
  assert.equal(socket.closedWith, 1000);
});

test("tries again when a message from the computer cannot be opened", async () => {
  const setup = setUp();
  const { phone, clock } = setup;
  const computer = await connectPhone(setup);
  computer.socket.events.binary(randomBytes(40));
  await until(() => stateOf(phone).kind === "retrying", "the phone to try again");
  assert.deepEqual(retrying(phone, clock), { wait: FIRST_WAIT_MS, reason: "A message from the computer could not be opened." });
});

test("checks the relay's address, the computer's ID and the computer's key before it starts", () => {
  assert.throws(() => setUp({ relayOrigin: "ftp://relay.example.com" }), { message: "That is not a relay's address." });
  assert.throws(() => setUp({ desktopId: "not an id" }), { message: "That is not a computer's ID." });
  assert.throws(() => setUp({ desktopKey: randomBytes(KEY_BYTES - 1) }), { message: "The computer's key must be 32 bytes." });
});
