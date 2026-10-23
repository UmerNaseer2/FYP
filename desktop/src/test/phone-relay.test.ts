/**
 * The computer's connection to the relay (src/main/phone-relay.ts). A fake
 * socket plays the relay, a real signing key answers its challenge, and a
 * clock the tests move on by hand drives the pings, the pacing and the waits.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

import type { Clock } from "../main/clock";
import { initLog, logFilePaths } from "../main/log";
import {
  BUFFER_CHECK_MS,
  FIRST_WAIT_MS,
  MAX_BUFFERED_BYTES,
  MAX_QUEUED_BYTES,
  MAX_WAIT_MS,
  PING_EVERY_MS,
  PhoneRelay,
  SEND_BURST,
  SEND_PER_SECOND,
  SIGN_IN_WITHIN_MS,
  SILENT_FOR_MS,
  STEADY_MS,
  type OpenSocket,
  type PhoneEvents,
  type PhoneRelayOptions,
  type RelaySocket,
  type RelayStatus,
  type SocketEvents,
} from "../main/phone-relay";
import { randomBytes, type Bytes } from "../shared/remote/bytes.js";
import { generateKeyPair, type KeyPair } from "../shared/remote/keys.js";
import { CHALLENGE_BYTES, checkChallenge, desktopIdFor } from "../shared/remote/relay-auth.js";
import {
  CHANNEL_BYTES,
  CLOSE_BROKEN,
  CLOSE_FULL,
  CLOSE_REPLACED,
  CLOSE_SIGN_IN_FAILED,
  CLOSE_TOO_BIG,
  CLOSE_TOO_FAST,
  MAX_RELAY_MESSAGE_BYTES,
  PING,
  PONG,
  addChannel,
  readChannel,
  readControl,
  writeControl,
} from "../shared/remote/relay-protocol.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ss-phone-relay-"));
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

/** Waits, in real time, until `check` is true: the signing runs for real, so it takes a moment. */
async function until(check: () => boolean, what: string): Promise<void> {
  const giveUpAt = Date.now() + 5_000;
  while (!check()) {
    if (Date.now() > giveUpAt) throw new Error(`Gave up waiting for ${what}.`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Gives the relay connection time to send anything it was going to send. */
function quiet(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 100));
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
  /** Makes each send throw, as it does on a socket that has failed. */
  failSends = false;

  constructor(
    readonly url: string,
    private readonly events: SocketEvents,
  ) {}

  send(data: string | Bytes): void {
    // Like a real socket, which throws until it has opened.
    if (this.state === "connecting") throw new Error("The socket is still connecting.");
    if (this.failSends) throw new Error("The socket has failed.");
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
  /** Makes the next open throw. */
  failNext = false;

  open: OpenSocket = (url, events) => {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("The socket could not be opened.");
    }
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

/** Plays the phone host, and notes what reaches it, in order. */
class Phones implements PhoneEvents {
  private events: string[] = [];

  opened = (channel: number): void => {
    this.events.push(`opened ${channel}`);
  };

  closed = (channel: number): void => {
    this.events.push(`closed ${channel}`);
  };

  received = (channel: number, message: Bytes): void => {
    this.events.push(`received ${channel} ${Buffer.from(message).toString("hex")}`);
  };

  dropAll = (): void => {
    this.events.push("dropAll");
  };

  /** What has reached the host since the last call. */
  take(): string[] {
    return this.events.splice(0);
  }
}

const RELAY_ORIGIN = "https://relay.example.com";

type SetUp = {
  relay: PhoneRelay;
  opener: FakeOpener;
  clock: FakeClock;
  phones: Phones;
  /** Each status the relay connection reported, in order. */
  statuses: RelayStatus[];
  signingKey: KeyPair;
  desktopId: string;
};

/** A relay connection on fake sockets and a fake clock, not started yet. */
async function setUp(overrides: Partial<Pick<PhoneRelayOptions, "relayOrigin" | "random" | "signingKey">> = {}): Promise<SetUp> {
  const signingKey = overrides.signingKey ?? (await generateKeyPair("Ed25519", false));
  const desktopId = await desktopIdFor(signingKey.publicKey);
  const opener = new FakeOpener();
  const clock = new FakeClock();
  const phones = new Phones();
  const statuses: RelayStatus[] = [];
  const relay = new PhoneRelay({
    relayOrigin: overrides.relayOrigin ?? RELAY_ORIGIN,
    desktopId,
    signingKey,
    phones,
    onStatus: (status) => statuses.push(status),
    openSocket: opener.open,
    clock,
    // Each wait is cut by up to half at random: with 1, it is not cut at all.
    random: overrides.random ?? (() => 1),
  });
  newLogLines();
  return { relay, opener, clock, phones, statuses, signingKey, desktopId };
}

/** The relay's challenge, as it asks a computer to sign in. */
function challengeMessage(): string {
  return writeControl({ type: "challenge", challenge: randomBytes(CHALLENGE_BYTES) });
}

/** Whether this is the computer answering the relay's challenge. */
function isAuth(data: string | Bytes): boolean {
  return typeof data === "string" && readControl(data)?.type === "auth";
}

/** A phone's message as it goes between the computer and the relay: the channel, then the bytes. */
function frame(channel: number, ...bytes: number[]): Bytes {
  return addChannel(channel, Uint8Array.of(...bytes));
}

/** Plays the relay letting the computer sign in on the socket opened last, and returns that socket with what was sent cleared. */
async function signIn(setup: SetUp): Promise<FakeSocket> {
  const socket = setup.opener.latest;
  socket.open();
  socket.text(challengeMessage());
  await until(() => socket.sent.some(isAuth), "the answer to the challenge");
  socket.text(writeControl({ type: "ready" }));
  assert.deepEqual(setup.relay.status(), { state: "connected" });
  socket.take();
  return socket;
}

test("signs in to the computer's room when the relay asks, and counts as connected once the relay says so", async () => {
  const { relay, opener, statuses, signingKey, desktopId } = await setUp();
  assert.deepEqual(relay.status(), { state: "off" });
  relay.start();
  relay.start();
  assert.equal(opener.sockets.length, 1);
  const socket = opener.latest;
  assert.equal(socket.url, `wss://relay.example.com/v1/desktop/${desktopId}`);
  assert.deepEqual(statuses, [{ state: "connecting" }]);

  // A ping goes as soon as the socket opens, so that the connection is never idle.
  socket.open();
  assert.deepEqual(socket.take(), [PING]);

  const challenge = randomBytes(CHALLENGE_BYTES);
  socket.text(writeControl({ type: "challenge", challenge }));
  await until(() => socket.sent.length > 0, "the answer to the challenge");
  const sent = socket.take();
  assert.equal(sent.length, 1);
  const first = sent[0];
  const answer = typeof first === "string" ? readControl(first) : null;
  assert.ok(answer?.type === "auth", "the computer answered with its key and a signature");
  assert.deepEqual(answer.publicKey, signingKey.publicKey);
  assert.equal(await checkChallenge(desktopId, challenge, answer.publicKey, answer.signature), true);
  assert.deepEqual(statuses, [{ state: "connecting" }]);

  socket.text(writeControl({ type: "ready" }));
  assert.deepEqual(statuses, [{ state: "connecting" }, { state: "connected" }]);
  assert.match(newLogLines(), /Connected to the relay\./);
});

test("passes on the phones' comings, goings and messages only once the computer is signed in", async () => {
  const setup = await setUp();
  const { relay, opener, phones } = setup;
  relay.start();
  const socket = opener.latest;
  socket.open();
  // Before the computer has even answered a challenge, "ready" means nothing.
  socket.text(writeControl({ type: "ready" }));
  socket.text(writeControl({ type: "open", channel: 7 }));
  socket.binary(frame(7, 1, 2, 3));
  socket.text(writeControl({ type: "close", channel: 7 }));
  assert.deepEqual(phones.take(), []);
  assert.deepEqual(relay.status(), { state: "connecting" });

  socket.text(challengeMessage());
  await until(() => socket.sent.some(isAuth), "the answer to the challenge");
  socket.text(writeControl({ type: "ready" }));
  assert.deepEqual(relay.status(), { state: "connected" });

  socket.text(writeControl({ type: "open", channel: 7 }));
  socket.binary(frame(7, 1, 2, 3));
  socket.text(writeControl({ type: "close", channel: 7 }));
  assert.deepEqual(phones.take(), ["opened 7", "received 7 010203", "closed 7"]);
  // Logged once for the connection, however many messages it could not use.
  assert.equal(countLines(newLogLines(), /could not use/), 1);
});

test("sends the phones' messages and closes in the order they were asked for, each with its channel in front", async () => {
  const setup = await setUp();
  setup.relay.start();
  const socket = await signIn(setup);
  setup.relay.send(7, Uint8Array.of(1));
  setup.relay.send(9, Uint8Array.of(2));
  setup.relay.close(7);
  assert.deepEqual(socket.take(), [frame(7, 1), frame(9, 2), writeControl({ type: "close", channel: 7 })]);

  // Channels run from 1 up to 2 ** 32 - 1, so the relay never gave out any of these.
  for (const channel of [0, -1, 1.5, 2 ** 32, Number.NaN]) {
    setup.relay.send(channel, Uint8Array.of(1));
    setup.relay.close(channel);
  }
  assert.deepEqual(socket.take(), []);
  assert.deepEqual(setup.phones.take(), []);
});

test("sends a phone away when a message for it is empty or too big to go through the relay", async () => {
  const setup = await setUp();
  setup.relay.start();
  const socket = await signIn(setup);
  setup.relay.send(7, new Uint8Array(MAX_RELAY_MESSAGE_BYTES + 1));
  setup.relay.send(9, new Uint8Array(0));
  assert.deepEqual(socket.take(), [writeControl({ type: "close", channel: 7 }), writeControl({ type: "close", channel: 9 })]);
  assert.deepEqual(setup.phones.take(), ["closed 7", "closed 9"]);
  assert.equal(countLines(newLogLines(), /could not send a message to a phone, so the phone was sent away/), 2);

  // The biggest message the relay passes on still goes.
  setup.relay.send(11, new Uint8Array(MAX_RELAY_MESSAGE_BYTES));
  assert.equal(socket.take().length, 1);
  assert.deepEqual(setup.phones.take(), []);
});

test("sends a burst at once, and paces what is left to stay inside the relay's limit", async () => {
  const setup = await setUp();
  setup.relay.start();
  const socket = await signIn(setup);
  // Time with nothing to send does not make the burst any bigger, as the relay's own allowance stops at its burst too.
  setup.clock.advance(10_000);
  for (let index = 0; index < SEND_BURST + 2; index += 1) setup.relay.send(7, Uint8Array.of(index % 256));
  assert.equal(socket.take().length, SEND_BURST);

  // A message may go every 1000 / SEND_PER_SECOND ms after the burst, and the pacing waits whole milliseconds.
  const tokenMs = Math.ceil(1000 / SEND_PER_SECOND);
  setup.clock.advance(tokenMs - 1);
  assert.deepEqual(socket.take(), []);
  setup.clock.advance(1);
  assert.deepEqual(socket.take(), [frame(7, SEND_BURST % 256)]);
  setup.clock.advance(tokenMs);
  assert.deepEqual(socket.take(), [frame(7, (SEND_BURST + 1) % 256)]);
  setup.clock.advance(10 * tokenMs);
  assert.deepEqual(socket.take(), []);
});

test("holds messages back while the socket has too much that it has not written yet", async () => {
  const setup = await setUp();
  setup.relay.start();
  const socket = await signIn(setup);
  socket.bufferedAmount = MAX_BUFFERED_BYTES;
  setup.relay.send(7, Uint8Array.of(1));
  assert.deepEqual(socket.take(), []);
  socket.bufferedAmount = MAX_BUFFERED_BYTES - 1;
  setup.clock.advance(BUFFER_CHECK_MS - 1);
  assert.deepEqual(socket.take(), []);
  setup.clock.advance(1);
  assert.deepEqual(socket.take(), [frame(7, 1)]);
});

test("sends a phone away when its message would not fit in what may wait to go", async () => {
  const setup = await setUp();
  const { relay, clock, phones } = setup;
  relay.start();
  const socket = await signIn(setup);
  // A socket that writes nothing for now, so that everything waits.
  socket.bufferedAmount = MAX_BUFFERED_BYTES;
  const frameBytes = CHANNEL_BYTES + MAX_RELAY_MESSAGE_BYTES;
  const fit = Math.floor(MAX_QUEUED_BYTES / frameBytes);
  const biggest = new Uint8Array(MAX_RELAY_MESSAGE_BYTES);

  // What waits for a phone that has gone no longer counts.
  for (let index = 0; index < fit; index += 1) relay.send(5, biggest);
  socket.text(writeControl({ type: "close", channel: 5 }));
  assert.deepEqual(phones.take(), ["closed 5"]);

  relay.send(9, Uint8Array.of(1));
  relay.send(11, Uint8Array.of(2));
  for (let index = 0; index < fit; index += 1) relay.send(7, biggest);
  // The last of channel 7's messages fills what is left exactly.
  const rest = MAX_QUEUED_BYTES - 2 * (CHANNEL_BYTES + 1) - fit * frameBytes - CHANNEL_BYTES;
  relay.send(7, new Uint8Array(rest));
  assert.deepEqual(phones.take(), []);
  // Not one more byte fits, so the phone it was for goes, and so does what was waiting for that phone.
  relay.send(11, Uint8Array.of(3));
  assert.deepEqual(phones.take(), ["closed 11"]);
  assert.match(newLogLines(), /the phone whose message did not fit was sent away/);

  socket.bufferedAmount = 0;
  // Long enough for a whole burst and what is paced after it.
  clock.advance(1_000);
  const sent = socket.take();
  assert.equal(sent.length, fit + 3);
  assert.deepEqual(sent[0], frame(9, 1));
  // Not compared whole: together they are 64 MB.
  assert.ok(sent.slice(1, fit + 1).every((data) => typeof data !== "string" && data.length === frameBytes && readChannel(data)?.channel === 7));
  const last = sent[fit + 1];
  assert.ok(typeof last !== "string" && last.length === CHANNEL_BYTES + rest && readChannel(last)?.channel === 7);
  assert.equal(sent[fit + 2], writeControl({ type: "close", channel: 11 }));

  // What has gone no longer counts either.
  relay.send(9, biggest);
  assert.deepEqual(phones.take(), []);
  const next = socket.take();
  assert.ok(next.length === 1 && typeof next[0] !== "string" && next[0].length === frameBytes);
});

test("pings the relay, and counts the connection as lost once the relay has been silent for too long", async () => {
  const setup = await setUp();
  const { relay, opener, clock, phones } = setup;
  relay.start();
  const socket = await signIn(setup);
  // Anything heard from the relay shows that it is still there: an answer to a ping, or a phone's message.
  for (let round = 0; round < 6; round += 1) {
    clock.advance(PING_EVERY_MS);
    assert.deepEqual(socket.take(), [PING], `ping ${round + 1}`);
    if (round < 3) socket.text(PONG);
    else socket.binary(frame(7, round));
  }
  assert.deepEqual(relay.status(), { state: "connected" });

  // Heard from part of the way to the next ping, so that the third ping after falls due exactly SILENT_FOR_MS later.
  const heardAfter = 3 * PING_EVERY_MS - SILENT_FOR_MS;
  assert.ok(heardAfter > 0 && heardAfter < PING_EVERY_MS);
  clock.advance(heardAfter);
  socket.text(PONG);
  clock.advance(PING_EVERY_MS - heardAfter);
  assert.deepEqual(socket.take(), [PING]);
  clock.advance(PING_EVERY_MS);
  assert.deepEqual(socket.take(), [PING]);
  assert.deepEqual(relay.status(), { state: "connected" });
  phones.take();

  clock.advance(PING_EVERY_MS);
  assert.deepEqual(socket.take(), []);
  assert.deepEqual(socket.closedWith, [1000]);
  assert.deepEqual(phones.take(), ["dropAll"]);
  assert.deepEqual(relay.status(), { state: "waiting", retryAt: clock.time + FIRST_WAIT_MS, reason: "The relay stopped answering." });
  assert.match(newLogLines(), /The relay stopped answering\. The phone link tries again in 1 second\./);
  clock.advance(FIRST_WAIT_MS);
  assert.equal(opener.sockets.length, 2);
});

test("gives up on a connection that is not signed in in time, and tries again", async () => {
  const { relay, opener, clock, statuses } = await setUp();
  relay.start();
  // A socket that never opens.
  const first = opener.latest;
  clock.advance(SIGN_IN_WITHIN_MS - 1);
  assert.equal(first.state, "connecting");
  clock.advance(1);
  assert.equal(first.state, "closed");
  assert.deepEqual(first.closedWith, [1000]);
  // Closing a socket that has not opened reports the close at once, and that does not count as a second failure.
  assert.deepEqual(statuses, [
    { state: "connecting" },
    { state: "waiting", retryAt: clock.time + FIRST_WAIT_MS, reason: "The relay could not be reached." },
  ]);

  // A socket that opens and answers the challenge, but is never let in.
  clock.advance(FIRST_WAIT_MS);
  const second = opener.latest;
  assert.notEqual(second, first);
  second.open();
  second.text(challengeMessage());
  await until(() => second.sent.some(isAuth), "the answer to the challenge");
  clock.advance(SIGN_IN_WITHIN_MS);
  assert.deepEqual(second.closedWith, [1000]);
  assert.deepEqual(relay.status(), {
    state: "waiting",
    retryAt: clock.time + 2 * FIRST_WAIT_MS,
    reason: "The relay did not let this computer sign in in time.",
  });

  // Opening a socket can fail outright, too.
  opener.failNext = true;
  clock.advance(2 * FIRST_WAIT_MS);
  assert.equal(opener.sockets.length, 2);
  assert.deepEqual(relay.status(), { state: "waiting", retryAt: clock.time + 4 * FIRST_WAIT_MS, reason: "The relay could not be reached." });
  const log = newLogLines();
  assert.match(log, /could not open a connection to the relay/);
  assert.equal(countLines(log, /The relay could not be reached\./), 2);
  clock.advance(4 * FIRST_WAIT_MS);
  assert.equal(opener.sockets.length, 3);
});

test("waits longer after each failure in a row, and from the shortest wait again after a steady connection", async () => {
  const setup = await setUp();
  const { relay, opener, clock } = setup;
  relay.start();
  const waits: number[] = [];
  for (let failure = 0; failure < 8; failure += 1) {
    opener.latest.end(1006);
    const status = relay.status();
    assert.ok(status.state === "waiting");
    waits.push(status.retryAt - clock.time);
    clock.advance(status.retryAt - clock.time);
  }
  assert.deepEqual(
    waits,
    [1, 2, 4, 8, 16, 32, 64, 128].map((times) => Math.min(times * FIRST_WAIT_MS, MAX_WAIT_MS)),
  );
  assert.equal(opener.sockets.length, 9);
  // Logged once, not once for each failure.
  assert.equal(countLines(newLogLines(), /The relay could not be reached\./), 1);

  await signIn(setup);
  clock.advance(STEADY_MS);
  opener.latest.end(1006);
  assert.deepEqual(relay.status(), { state: "waiting", retryAt: clock.time + FIRST_WAIT_MS, reason: "The connection to the relay closed." });

  // A connection that drops sooner is one more failure in the run.
  clock.advance(FIRST_WAIT_MS);
  await signIn(setup);
  clock.advance(STEADY_MS - 1);
  opener.latest.end(1006);
  assert.deepEqual(relay.status(), {
    state: "waiting",
    retryAt: clock.time + 2 * FIRST_WAIT_MS,
    reason: "The connection to the relay closed.",
  });
  // Logged again after each sign-in, even for the same reason.
  assert.equal(countLines(newLogLines(), /The connection to the relay closed\./), 2);

  // Starting again starts the waits again from the shortest.
  relay.stop();
  relay.start();
  opener.latest.end(1006);
  assert.deepEqual(relay.status(), { state: "waiting", retryAt: clock.time + FIRST_WAIT_MS, reason: "The relay could not be reached." });

  // And it logs the problem again, even when it is the same one as before.
  relay.stop();
  newLogLines();
  relay.start();
  opener.latest.end(1006);
  assert.equal(countLines(newLogLines(), /The relay could not be reached\./), 1);
});

test("cuts each wait by up to half at random, so that computers do not all come back at once", async () => {
  const { relay, opener, clock } = await setUp({ random: () => 0 });
  relay.start();
  opener.latest.end(1006);
  assert.deepEqual(relay.status(), { state: "waiting", retryAt: clock.time + FIRST_WAIT_MS / 2, reason: "The relay could not be reached." });
  // Rounded up to whole seconds for the log.
  assert.match(newLogLines(), /tries again in 1 second\./);
  clock.advance(FIRST_WAIT_MS / 2 - 1);
  assert.equal(opener.sockets.length, 1);
  clock.advance(1);
  assert.equal(opener.sockets.length, 2);
});

test("stops when another connection signs in as this computer, until it is started again", async () => {
  const setup = await setUp();
  const { relay, opener, clock, phones } = setup;
  relay.start();
  const socket = await signIn(setup);
  socket.end(CLOSE_REPLACED);
  assert.deepEqual(relay.status(), { state: "replaced" });
  assert.deepEqual(phones.take(), ["dropAll"]);
  assert.match(newLogLines(), /took its place, so the phone link stopped/);
  clock.advance(10 * MAX_WAIT_MS);
  assert.equal(opener.sockets.length, 1);

  relay.start();
  assert.equal(opener.sockets.length, 2);
  assert.deepEqual(relay.status(), { state: "connecting" });
});

test("connects at once when asked to while it waits, and starts the waits over", async () => {
  const setup = await setUp();
  const { relay, opener, clock } = setup;
  // Only while waiting: not before start(), and not while connecting.
  relay.retryNow();
  assert.equal(opener.sockets.length, 0);
  relay.start();
  relay.retryNow();
  assert.equal(opener.sockets.length, 1);

  // Two failures in a row, so the next wait is twice the shortest.
  opener.latest.end(1006);
  clock.advance(FIRST_WAIT_MS);
  opener.latest.end(1006);
  assert.deepEqual(relay.status(), { state: "waiting", retryAt: clock.time + 2 * FIRST_WAIT_MS, reason: "The relay could not be reached." });
  newLogLines();

  relay.retryNow();
  assert.equal(opener.sockets.length, 3);
  assert.deepEqual(relay.status(), { state: "connecting" });
  opener.latest.end(1006);
  assert.deepEqual(relay.status(), { state: "waiting", retryAt: clock.time + FIRST_WAIT_MS, reason: "The relay could not be reached." });
  // Asking to connect starts a new run of tries, so the same reason is logged again.
  assert.equal(countLines(newLogLines(), /The relay could not be reached\./), 1);
  // The wait that was cut short is gone: only the new one connects.
  clock.advance(2 * FIRST_WAIT_MS);
  assert.equal(opener.sockets.length, 4);

  // Not after another connection took this one's place, and not once stopped.
  const socket = await signIn(setup);
  socket.end(CLOSE_REPLACED);
  relay.retryNow();
  assert.equal(opener.sockets.length, 4);
  assert.deepEqual(relay.status(), { state: "replaced" });
  relay.start();
  opener.latest.end(1006);
  relay.stop();
  relay.retryNow();
  assert.equal(opener.sockets.length, 5);
  assert.deepEqual(relay.status(), { state: "off" });
});

test("waits longest after the relay refuses the sign-in or says that too much was sent", async () => {
  const cases: Array<[code: number, wait: number, reason: string]> = [
    [CLOSE_SIGN_IN_FAILED, MAX_WAIT_MS, "The relay did not accept this computer's sign-in."],
    [CLOSE_TOO_FAST, MAX_WAIT_MS, "The relay said this computer sent too much at once."],
    [CLOSE_FULL, FIRST_WAIT_MS, "Other connections were signing in as this computer at the same time."],
    [CLOSE_BROKEN, FIRST_WAIT_MS, "The relay could not read what this computer sent."],
    [CLOSE_TOO_BIG, FIRST_WAIT_MS, "The relay could not read what this computer sent."],
    [1001, FIRST_WAIT_MS, "The connection to the relay closed."],
  ];
  for (const [code, wait, reason] of cases) {
    const { relay, opener, clock } = await setUp();
    relay.start();
    opener.latest.open();
    opener.latest.end(code);
    assert.deepEqual(relay.status(), { state: "waiting", retryAt: clock.time + wait, reason }, `after close code ${code}`);
  }
});

test("stop() closes the connection, lets the phones go, and takes no notice of the old socket after", async () => {
  const setup = await setUp();
  const { relay, opener, clock, phones, statuses } = setup;
  relay.start();
  const socket = await signIn(setup);
  // A message that has to wait for room in the socket, so that a timer is set to send it.
  socket.bufferedAmount = MAX_BUFFERED_BYTES;
  relay.send(7, Uint8Array.of(1));
  relay.stop();
  assert.deepEqual(socket.closedWith, [1000]);
  assert.deepEqual(phones.take(), ["dropAll"]);
  assert.deepEqual(relay.status(), { state: "off" });
  // No timer is left to hold on to the connection that has gone.
  assert.equal(clock.pending, 0);

  // What the relay sends while the socket finishes closing, and what the host asks for after.
  socket.text(writeControl({ type: "open", channel: 7 }));
  socket.binary(frame(7, 1));
  socket.end(1000);
  relay.send(7, Uint8Array.of(1));
  relay.close(7);
  clock.advance(10 * MAX_WAIT_MS);
  assert.deepEqual(socket.take(), []);
  assert.deepEqual(phones.take(), []);
  assert.equal(opener.sockets.length, 1);

  // Stopping while waiting to try again stops the waiting too.
  relay.start();
  opener.latest.end(1006);
  relay.stop();
  assert.equal(clock.pending, 0);
  clock.advance(10 * MAX_WAIT_MS);
  assert.equal(opener.sockets.length, 2);
  assert.deepEqual(
    statuses.map((status) => status.state),
    ["connecting", "connected", "off", "connecting", "waiting", "off"],
  );
});

test("takes no notice of a socket that says it opened twice, or of what a socket says once it has been let go", async () => {
  const setup = await setUp();
  const { relay, opener, clock, phones } = setup;
  relay.start();
  const unopened = opener.latest;
  relay.stop();
  relay.start();
  // The socket that was let go before it opened opens after all, too late to be used.
  unopened.open();
  assert.deepEqual(unopened.take(), []);

  const lost = await signIn(setup);
  // A socket opens only once, so a second report of it sends no second ping.
  lost.open();
  assert.deepEqual(lost.take(), []);

  // The relay stops answering, so the connection is lost, and a new one signs in in its place.
  clock.advance(3 * PING_EVERY_MS);
  assert.equal(relay.status().state, "waiting");
  lost.take();
  clock.advance(FIRST_WAIT_MS);
  const current = await signIn(setup);
  // The phones went with each connection that was let go.
  assert.deepEqual(phones.take(), ["dropAll", "dropAll"]);
  newLogLines();

  // The lost connection's socket reports late. The relay closed it because a new connection signed in as this
  // computer, but that was this computer's own new connection, so the phone link carries on.
  lost.text(writeControl({ type: "open", channel: 7 }));
  lost.binary(frame(7, 1));
  lost.end(CLOSE_REPLACED);
  assert.deepEqual(phones.take(), []);
  assert.deepEqual(relay.status(), { state: "connected" });
  assert.deepEqual(lost.take(), []);
  assert.deepEqual(current.take(), []);
  assert.equal(opener.sockets.length, 3);
  assert.equal(newLogLines(), "");
});

test("drops what still waits to go to a phone once the relay says that phone has gone", async () => {
  const setup = await setUp();
  const { relay, clock, phones } = setup;
  relay.start();
  const socket = await signIn(setup);
  socket.text(writeControl({ type: "open", channel: 7 }));
  socket.text(writeControl({ type: "open", channel: 9 }));
  // A socket that writes nothing for now, so that everything waits.
  socket.bufferedAmount = MAX_BUFFERED_BYTES;
  relay.send(7, Uint8Array.of(1));
  relay.send(9, Uint8Array.of(2));
  relay.close(7);
  // The phone on channel 7 goes, and a new one comes on the same channel before anything was written.
  socket.text(writeControl({ type: "close", channel: 7 }));
  socket.text(writeControl({ type: "open", channel: 7 }));
  relay.send(7, Uint8Array.of(3));
  socket.bufferedAmount = 0;
  clock.advance(BUFFER_CHECK_MS);
  assert.deepEqual(socket.take(), [frame(9, 2), frame(7, 3)]);
  assert.deepEqual(phones.take(), ["opened 7", "opened 9", "closed 7", "opened 7"]);

  // The relay opening a channel again means the phone that had it has gone, too.
  socket.bufferedAmount = MAX_BUFFERED_BYTES;
  relay.send(9, Uint8Array.of(4));
  socket.text(writeControl({ type: "open", channel: 9 }));
  socket.bufferedAmount = 0;
  clock.advance(BUFFER_CHECK_MS);
  assert.deepEqual(socket.take(), []);
  assert.deepEqual(phones.take(), ["opened 9"]);
});

test("ignores messages from the relay that it cannot use, and logs that once for each connection", async () => {
  const setup = await setUp();
  const { relay, opener, clock, phones, statuses } = setup;
  relay.start();
  const socket = await signIn(setup);
  newLogLines();
  const reported = statuses.length;
  socket.text("not a message");
  // Not answered: the relay closes the connection of a computer that sends a pong.
  socket.text(PING);
  socket.text(writeControl({ type: "online" }));
  socket.text(writeControl({ type: "offline" }));
  socket.text(challengeMessage());
  socket.text(writeControl({ type: "ready" }));
  // Too short to hold a message after the channel, and a channel the relay never gives.
  socket.binary(Uint8Array.of(0, 0, 0, 7));
  socket.binary(Uint8Array.of(0, 0, 0, 0, 1));
  await quiet();
  assert.deepEqual(socket.take(), []);
  assert.deepEqual(phones.take(), []);
  assert.deepEqual(relay.status(), { state: "connected" });
  assert.equal(statuses.length, reported, "nothing changed the status");
  assert.equal(countLines(newLogLines(), /could not use/), 1);

  // A new connection logs it again.
  socket.end(1006);
  clock.advance(FIRST_WAIT_MS);
  const next = await signIn(setup);
  next.text("not a message");
  assert.equal(countLines(newLogLines(), /could not use/), 1);
  assert.equal(opener.sockets.length, 2);
});

test("needs a relay's address and a computer's ID, and reaches a relay on this computer without encryption", async () => {
  const { relay, opener, signingKey, desktopId } = await setUp({ relayOrigin: "http://localhost:8787" });
  relay.start();
  assert.equal(opener.latest.url, `ws://localhost:8787/v1/desktop/${desktopId}`);

  const options: PhoneRelayOptions = { relayOrigin: RELAY_ORIGIN, desktopId, signingKey, phones: new Phones() };
  for (const relayOrigin of ["http://relay.example.com", "https://relay.example.com/rooms", "relay.example.com"]) {
    assert.throws(() => new PhoneRelay({ ...options, relayOrigin }), /not a relay's address/, relayOrigin);
  }
  assert.throws(() => new PhoneRelay({ ...options, desktopId: "short" }), /not a computer's ID/);
});

test("sends nothing for the phones until the computer is signed in", async () => {
  const { relay, opener } = await setUp();
  relay.start();
  const socket = opener.latest;
  // A socket that is still connecting throws if it is sent anything.
  relay.send(7, Uint8Array.of(1));
  relay.close(7);
  socket.open();
  relay.send(7, Uint8Array.of(1));
  relay.close(7);
  socket.text(challengeMessage());
  await until(() => socket.sent.some(isAuth), "the answer to the challenge");
  relay.send(7, Uint8Array.of(1));
  relay.close(7);
  assert.equal(socket.take().length, 2, "only the ping and the answer to the challenge");

  socket.text(writeControl({ type: "ready" }));
  relay.send(7, Uint8Array.of(1));
  assert.deepEqual(socket.take(), [frame(7, 1)]);
});

test("sends nothing on a connection that was lost while the computer was signing the challenge", async () => {
  const { relay, opener } = await setUp();
  relay.start();
  const socket = opener.latest;
  socket.open();
  socket.text(challengeMessage());
  // Lost at once, before the signature is ready.
  socket.end(1006);
  await quiet();
  assert.deepEqual(socket.take(), [PING]);
  assert.equal(relay.status().state, "waiting");
});

test("counts the connection as lost when the socket will not take a message", async () => {
  const setup = await setUp();
  const { relay, clock, phones } = setup;
  relay.start();
  const socket = await signIn(setup);
  // Two messages wait, and the socket fails as they go.
  socket.bufferedAmount = MAX_BUFFERED_BYTES;
  relay.send(7, Uint8Array.of(1));
  relay.send(9, Uint8Array.of(2));
  socket.failSends = true;
  socket.bufferedAmount = 0;
  clock.advance(BUFFER_CHECK_MS);
  assert.deepEqual(socket.closedWith, [1000]);
  assert.deepEqual(phones.take(), ["dropAll"]);
  assert.deepEqual(relay.status(), { state: "waiting", retryAt: clock.time + FIRST_WAIT_MS, reason: "The connection to the relay closed." });
  // Once: the connection was let go after the first send failed.
  assert.equal(countLines(newLogLines(), /could not send to the relay/), 1);
});

test("waits longest when the computer cannot sign the relay's challenge", async () => {
  // An X25519 key cannot sign, so signing fails as it would with a damaged key.
  const { relay, opener, clock } = await setUp({ signingKey: await generateKeyPair("X25519", false) });
  relay.start();
  const socket = opener.latest;
  socket.open();
  socket.text(challengeMessage());
  await until(() => relay.status().state === "waiting", "the sign-in to fail");
  assert.deepEqual(relay.status(), {
    state: "waiting",
    retryAt: clock.time + MAX_WAIT_MS,
    reason: "This computer could not sign in to the relay.",
  });
  assert.deepEqual(socket.closedWith, [1000]);
  assert.deepEqual(socket.take(), [PING]);
  assert.match(newLogLines(), /could not sign in to the relay/);
});
