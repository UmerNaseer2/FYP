/**
 * The computer's side of the phone link (src/main/phone-host.ts). A real
 * handshake and real encryption play the phone, through a fake relay that
 * hands the host's messages to the test, and a clock the tests move on by
 * hand.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

import { MAX_PAIRED_PHONES, type PairedPhone } from "../core/phone-link-file";
import type { Clock } from "../main/clock";
import { initLog, logFilePaths } from "../main/log";
import { ANSWER_TIMEOUT_MS, HANDSHAKE_WITHIN_MS, MAX_CHANNELS, PhoneHost, type PhoneHostOptions } from "../main/phone-host";
import { writeRefusal } from "../main/phone-requests";
import { toBase64Url, utf8, type Bytes } from "../shared/remote/bytes.js";
import { generateKeyPair, type KeyPair } from "../shared/remote/keys.js";
import { Link, MAX_LINK_MESSAGE_BYTES, PIECE_BYTES } from "../shared/remote/link.js";
import { Initiator } from "../shared/remote/noise.js";
import {
  PAIRING_LIFETIME_MS,
  PAIRING_SECRET_BYTES,
  PHONE_LINK_PROLOGUE,
  readOpeningAnswer,
  writeOpening,
  type Opening,
  type OpeningAnswer,
} from "../shared/remote/pairing.js";
import {
  ANSWER_WITHIN_MS,
  MAX_PENDING_REQUESTS,
  readAnswer,
  writeRequest,
  writeResult,
  type Answer,
  type Request,
} from "../shared/remote/rpc.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ss-phone-host-"));
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

/** Waits, in real time, until `check` is true: the encryption runs for real, so it takes a moment. */
async function until(check: () => boolean, what: string): Promise<void> {
  const giveUpAt = Date.now() + 5_000;
  while (!check()) {
    if (Date.now() > giveUpAt) throw new Error(`Gave up waiting for ${what}.`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Gives the host time to send anything it was going to send. */
function quiet(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 100));
}

/** The relay, as the host sees it. What the host sends waits in a queue for each channel. */
class Wire {
  /** The channels the host asked the relay to close, in order. */
  readonly closed: number[] = [];
  /** Runs after each message the host sends, as the relay can send a phone away while the host is sending to it. */
  onSend: ((channel: number) => void) | null = null;
  private readonly queues = new Map<number, Bytes[]>();

  send = (channel: number, message: Bytes): void => {
    this.queue(channel).push(message);
    this.onSend?.(channel);
  };

  close = (channel: number): void => {
    this.closed.push(channel);
  };

  /** The next message the host sent on this channel, once there is one. */
  async next(channel: number): Promise<Bytes> {
    const queue = this.queue(channel);
    await until(() => queue.length > 0, `a message on channel ${channel}`);
    const message = queue.shift();
    assert.ok(message);
    return message;
  }

  async waitClosed(channel: number): Promise<void> {
    await until(() => this.closed.includes(channel), `channel ${channel} to close`);
  }

  /** How many messages on this channel no phone has read. */
  waiting(channel: number): number {
    return this.queue(channel).length;
  }

  private queue(channel: number): Bytes[] {
    let queue = this.queues.get(channel);
    if (queue === undefined) {
      queue = [];
      this.queues.set(channel, queue);
    }
    return queue;
  }
}

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** A request the host passed on, with the answer the test gives it by hand. */
type Asked = { request: Request; signal: AbortSignal; answer: Deferred<Bytes> };

/** Answers that wait for the test to give each one. */
function fakeAnswers(): { asked: Asked[]; answer: PhoneHostOptions["answer"] } {
  const asked: Asked[] = [];
  return {
    asked,
    answer: (request, signal) => {
      const answer = deferred<Bytes>();
      asked.push({ request, signal, answer });
      return answer.promise;
    },
  };
}

/** The request with this number, once the host has passed it on. */
async function askedFor(asked: Asked[], id: number): Promise<Asked> {
  await until(() => asked.some((entry) => entry.request.id === id), `request ${id}`);
  const entry = asked.find((one) => one.request.id === id);
  assert.ok(entry);
  return entry;
}

/** A request for the schemas of connection 1. */
function schemasOf(id: number): Request {
  return { id, method: "schemas.list", params: { connectionId: 1 } };
}

function schemasAnswer(id: number, schemas: string[]): Bytes {
  return writeResult(id, "schemas.list", { schemas });
}

/** What a phone says to pair with a pairing link's secret. */
function pairWith(secret: Bytes, name = "Pixel 9"): Opening {
  return { kind: "pair", secret, name };
}

/** What a paired phone says. */
const SESSION: Opening = { kind: "session" };

const LET_IN = { ok: true, name: "Work laptop" };

/** The answer to request `id`, exactly `size` bytes long. */
function answerOfSize(id: number, size: number): Bytes {
  const head = `{"id":${id},"result":"`;
  return utf8(head + "x".repeat(size - head.length - 2) + '"}');
}

/** The computer's number at the relay. */
const DESKTOP_ID = toBase64Url(new Uint8Array(16).fill(3));

/** A phone, with a real handshake and a real link, on one channel of the fake relay. */
class TestPhone {
  link: Link | null = null;

  constructor(
    private readonly host: PhoneHost,
    private readonly wire: Wire,
    readonly channel: number,
    readonly key: KeyPair,
    private readonly computerKey: Bytes,
  ) {}

  /** The phone's key, as the host saves it. */
  get keyText(): string {
    return toBase64Url(this.key.publicKey);
  }

  /** Has the relay connect the phone, and opens with `opening`. Gives what the computer answered. */
  async connect(opening: Opening): Promise<OpeningAnswer | null> {
    this.host.opened(this.channel);
    const initiator = new Initiator({ prologue: PHONE_LINK_PROLOGUE, staticKey: this.key, remoteStaticKey: this.computerKey });
    this.host.received(this.channel, await initiator.writeFirstMessage(writeOpening(opening)));
    const { payload, session } = await initiator.readAnswer(await this.wire.next(this.channel));
    const answer = readOpeningAnswer(payload);
    if (answer?.ok === true) this.link = new Link(session, (sealed) => this.host.received(this.channel, sealed));
    return answer;
  }

  async send(message: Bytes): Promise<void> {
    const link = this.link;
    assert.ok(link, "the phone was let in");
    await link.send(message);
  }

  /** The next whole message from the computer. */
  async message(): Promise<Bytes> {
    const link = this.link;
    assert.ok(link, "the phone was let in");
    for (;;) {
      const whole = await link.receive(await this.wire.next(this.channel));
      if (whole !== null) return whole;
    }
  }

  async answer(): Promise<Answer | null> {
    return readAnswer(await this.message());
  }

  /** Sends a request, and gives the next answer. */
  async request(request: Request): Promise<Answer | null> {
    await this.send(writeRequest(request));
    return this.answer();
  }
}

async function setUp(options: { phones?: PairedPhone[]; answer?: PhoneHostOptions["answer"] } = {}) {
  const computerKey = await generateKeyPair("X25519", false);
  const wire = new Wire();
  const clock = new FakeClock();
  let saved: PairedPhone[] = options.phones ?? [];
  /** Each phone the host said was paired, in order. */
  const paired: PairedPhone[] = [];
  /** What host.connectedPhones() gave each time the host said the connected phones changed. */
  const connectedChanges: string[][] = [];
  const host = new PhoneHost({
    staticKey: computerKey,
    desktopId: DESKTOP_ID,
    computerName: "Work laptop",
    phones: () => saved,
    savePhones: (phones) => {
      saved = phones;
    },
    answer: options.answer ?? (async (request) => schemasAnswer(request.id, ["public"])),
    send: wire.send,
    close: wire.close,
    onPaired: (phone) => {
      paired.push(phone);
    },
    onConnectedChange: () => {
      connectedChanges.push(host.connectedPhones());
    },
    clock,
  });
  /** A phone with a new key, unless it is given one. */
  const newPhone = async (channel: number, key?: KeyPair): Promise<TestPhone> =>
    new TestPhone(host, wire, channel, key ?? (await generateKeyPair("X25519", false)), computerKey.publicKey);
  /** A phone paired with a new pairing link, and let in. */
  const pairedPhone = async (channel: number, key?: KeyPair, name?: string): Promise<TestPhone> => {
    const phone = await newPhone(channel, key);
    const { code } = host.startPairing();
    assert.deepEqual(await phone.connect(pairWith(code.secret, name)), LET_IN);
    return phone;
  };
  return { host, wire, clock, computerKey, paired, connectedChanges, saved: () => saved, newPhone, pairedPhone };
}

test("pairs one phone with the latest pairing link, and answers what it asks", async () => {
  const { host, wire, clock, paired, saved, newPhone } = await setUp();
  newLogLines();
  const { code } = host.startPairing();
  const phone = await newPhone(1);
  assert.deepEqual(await phone.connect(pairWith(code.secret)), LET_IN);
  const expected: PairedPhone[] = [{ key: phone.keyText, name: "Pixel 9", pairedAt: clock.time, lastSeenAt: clock.time }];
  assert.deepEqual(saved(), expected);
  assert.deepEqual(paired, expected);
  assert.deepEqual(host.connectedPhones(), [phone.keyText]);
  assert.deepEqual(await phone.request(schemasOf(1)), { id: 1, ok: true, result: { schemas: ["public"] } });

  // A link pairs one phone only.
  const second = await newPhone(2);
  assert.deepEqual(await second.connect(pairWith(code.secret, "Other")), { ok: false, reason: "expired-code" });
  await wire.waitClosed(2);
  assert.deepEqual(wire.closed, [2]);
  assert.deepEqual(saved(), expected);
  const log = newLogLines();
  assert.match(log, /Paired a phone named "Pixel 9"\./);
  assert.match(log, /Closed a phone's connection: it tried to pair with a pairing link that was out of date/);
});

test("pairs nothing with a link that was never made, ran out, was cancelled, or is not the latest", async () => {
  const { host, wire, clock, saved, newPhone } = await setUp();
  const expired = { ok: false, reason: "expired-code" };

  const never = await newPhone(1);
  assert.deepEqual(await never.connect(pairWith(new Uint8Array(PAIRING_SECRET_BYTES).fill(7))), expired);

  // A link stops pairing the moment it runs out.
  const ranOut = host.startPairing();
  clock.advance(PAIRING_LIFETIME_MS);
  assert.deepEqual(await (await newPhone(2)).connect(pairWith(ranOut.code.secret)), expired);

  const cancelled = host.startPairing();
  host.cancelPairing();
  assert.deepEqual(await (await newPhone(3)).connect(pairWith(cancelled.code.secret)), expired);

  const older = host.startPairing();
  const latest = host.startPairing();
  assert.deepEqual(await (await newPhone(4)).connect(pairWith(older.code.secret)), expired);
  clock.advance(PAIRING_LIFETIME_MS - 1);
  assert.deepEqual(await (await newPhone(5)).connect(pairWith(latest.code.secret)), LET_IN);

  assert.deepEqual(wire.closed, [1, 2, 3, 4]);
  assert.equal(saved().length, 1);
});

test("pairs no new phone while the computer has all it takes, but lets a paired phone pair again", async () => {
  const known = await generateKeyPair("X25519", false);
  const full: PairedPhone[] = Array.from({ length: MAX_PAIRED_PHONES }, (_, index) => ({
    key: index === 2 ? toBase64Url(known.publicKey) : toBase64Url(new Uint8Array(32).fill(index + 10)),
    name: `Phone ${index}`,
    pairedAt: 1000 + index,
    lastSeenAt: 2000 + index,
  }));
  const { host, clock, saved, paired, newPhone } = await setUp({ phones: full });
  const { code } = host.startPairing();
  assert.deepEqual(await (await newPhone(1)).connect(pairWith(code.secret)), { ok: false, reason: "too-many-phones" });
  assert.deepEqual(saved(), full);

  // The link was not used up, so a phone that is paired already can pair with it, under a new name.
  assert.deepEqual(await (await newPhone(2, known)).connect(pairWith(code.secret, "Renamed")), LET_IN);
  const renamed: PairedPhone = { key: toBase64Url(known.publicKey), name: "Renamed", pairedAt: 1002, lastSeenAt: clock.time };
  assert.deepEqual(
    saved(),
    full.map((phone, index) => (index === 2 ? renamed : phone)),
  );
  assert.deepEqual(paired, [renamed]);

  // That used the link up.
  assert.deepEqual(await (await newPhone(3)).connect(pairWith(code.secret)), { ok: false, reason: "expired-code" });
});

test("lets a paired phone in, and turns away one that is not paired", async () => {
  const known = await generateKeyPair("X25519", false);
  const phones: PairedPhone[] = [{ key: toBase64Url(known.publicKey), name: "Pixel 9", pairedAt: 1, lastSeenAt: 2 }];
  const { host, wire, clock, saved, paired, newPhone } = await setUp({ phones });
  newLogLines();
  clock.advance(60_000);
  const phone = await newPhone(1, known);
  assert.deepEqual(await phone.connect(SESSION), LET_IN);
  assert.deepEqual(saved(), [{ key: phone.keyText, name: "Pixel 9", pairedAt: 1, lastSeenAt: clock.time }]);
  assert.match(newLogLines(), /A paired phone connected: "Pixel 9"\./);

  const stranger = await newPhone(2);
  assert.deepEqual(await stranger.connect(SESSION), { ok: false, reason: "not-paired" });
  assert.deepEqual(wire.closed, [2]);
  assert.match(newLogLines(), /Closed a phone's connection: it is not paired with this computer\./);
  assert.deepEqual(paired, []);
  assert.deepEqual(host.connectedPhones(), [phone.keyText]);
  assert.deepEqual(await phone.request(schemasOf(1)), { id: 1, ok: true, result: { schemas: ["public"] } });
});

test("answers each phone on its own link, whatever order the answers are ready in", async () => {
  const fake = fakeAnswers();
  const { wire, pairedPhone } = await setUp({ answer: fake.answer });
  const a = await pairedPhone(1);
  const b = await pairedPhone(2);
  await a.send(writeRequest(schemasOf(1)));
  await b.send(writeRequest(schemasOf(2)));
  const forA = await askedFor(fake.asked, 1);
  const forB = await askedFor(fake.asked, 2);
  forB.answer.resolve(schemasAnswer(2, ["b"]));
  assert.deepEqual(await b.answer(), { id: 2, ok: true, result: { schemas: ["b"] } });
  forA.answer.resolve(schemasAnswer(1, ["a"]));
  assert.deepEqual(await a.answer(), { id: 1, ok: true, result: { schemas: ["a"] } });
  await quiet();
  assert.equal(wire.waiting(1) + wire.waiting(2), 0);
});

test("says why it cannot read a request, and sends away a phone whose request has no number", async () => {
  const fake = fakeAnswers();
  const { wire, pairedPhone } = await setUp({ answer: fake.answer });
  const phone = await pairedPhone(1);
  await phone.send(utf8(JSON.stringify({ id: 5, method: "drop.table" })));
  assert.deepEqual(await phone.answer(), readAnswer(writeRefusal(5, "unknown-method")));
  await phone.send(utf8(JSON.stringify({ id: 6, method: "schemas.list", params: { connectionId: 0 } })));
  assert.deepEqual(await phone.answer(), readAnswer(writeRefusal(6, "bad-request")));
  // Without a number, an answer could not say which request it is for.
  await phone.send(utf8(JSON.stringify({ method: "hello" })));
  await wire.waitClosed(1);
  assert.deepEqual(fake.asked, []);
});

test("works on four requests from a phone at a time, and sends away a phone that reuses a waiting number", async () => {
  const fake = fakeAnswers();
  const { wire, pairedPhone } = await setUp({ answer: fake.answer });
  const phone = await pairedPhone(1);
  newLogLines();
  for (let id = 1; id <= MAX_PENDING_REQUESTS; id += 1) await phone.send(writeRequest(schemasOf(id)));
  await askedFor(fake.asked, MAX_PENDING_REQUESTS);
  assert.deepEqual(await phone.request(schemasOf(5)), readAnswer(writeRefusal(5, "busy")));

  // An answer makes room for the next request.
  (await askedFor(fake.asked, 1)).answer.resolve(schemasAnswer(1, ["public"]));
  assert.deepEqual(await phone.answer(), { id: 1, ok: true, result: { schemas: ["public"] } });
  await phone.send(writeRequest(schemasOf(6)));
  await askedFor(fake.asked, 6);

  await phone.send(writeRequest(schemasOf(2)));
  await wire.waitClosed(1);
  assert.equal(fake.asked.length, 5);
  for (const id of [2, 3, 4, 6]) assert.equal((await askedFor(fake.asked, id)).signal.aborted, true, `request ${id} was stopped`);
  assert.match(newLogLines(), /it reused the number of a request still waiting\./);
});

test("tells a phone the computer took too long, a little before the phone would give up", async () => {
  assert.ok(ANSWER_TIMEOUT_MS < ANSWER_WITHIN_MS);
  const fake = fakeAnswers();
  const { wire, clock, pairedPhone } = await setUp({ answer: fake.answer });
  const phone = await pairedPhone(1);
  newLogLines();
  await phone.send(writeRequest(schemasOf(1)));
  const first = await askedFor(fake.asked, 1);
  clock.advance(ANSWER_TIMEOUT_MS - 1);
  await quiet();
  assert.equal(wire.waiting(1), 0);
  assert.equal(first.signal.aborted, false);
  clock.advance(1);
  assert.equal(first.signal.aborted, true);
  assert.deepEqual(await phone.answer(), readAnswer(writeRefusal(1, "too-slow")));
  assert.match(newLogLines(), /A phone's schemas\.list took longer than 110 seconds/);

  // An answer that comes after that is not sent, and its request takes up no room.
  first.answer.resolve(schemasAnswer(1, ["late"]));
  for (let id = 2; id <= MAX_PENDING_REQUESTS + 1; id += 1) await phone.send(writeRequest(schemasOf(id)));
  await askedFor(fake.asked, MAX_PENDING_REQUESTS + 1);
  await quiet();
  assert.equal(fake.asked.length, MAX_PENDING_REQUESTS + 1);
  assert.equal(wire.waiting(1), 0);
});

test("sends an answer as big as the link takes, and says when one is bigger or could not be made", async () => {
  const biggest = answerOfSize(1, MAX_LINK_MESSAGE_BYTES);
  const { pairedPhone } = await setUp({
    answer: async (request) => {
      if (request.id === 1) return biggest;
      if (request.id === 2) return answerOfSize(2, MAX_LINK_MESSAGE_BYTES + 1);
      throw new Error("The server stopped.");
    },
  });
  const phone = await pairedPhone(1);
  await phone.send(writeRequest(schemasOf(1)));
  const whole = await phone.message();
  assert.equal(whole.length, MAX_LINK_MESSAGE_BYTES);
  assert.equal(Buffer.compare(whole, biggest), 0);
  assert.deepEqual(await phone.request(schemasOf(2)), readAnswer(writeRefusal(2, "too-big")));
  newLogLines();
  assert.deepEqual(await phone.request(schemasOf(3)), readAnswer(writeRefusal(3, "failed")));
  assert.match(newLogLines(), /The phone link could not answer a phone's schemas\.list\./);
});

test("stops what a phone asked for once the relay says the phone went", async () => {
  const fake = fakeAnswers();
  const { host, wire, pairedPhone } = await setUp({ answer: fake.answer });
  const phone = await pairedPhone(1);
  await phone.send(writeRequest(schemasOf(1)));
  const first = await askedFor(fake.asked, 1);
  host.closed(1);
  assert.equal(first.signal.aborted, true);
  assert.deepEqual(host.connectedPhones(), []);
  first.answer.resolve(schemasAnswer(1, ["late"]));
  await quiet();
  assert.equal(wire.waiting(1), 0);
  // The relay closed that channel itself.
  assert.deepEqual(wire.closed, []);
});

test("stops sending an answer once the relay sends the phone away part way through it", async () => {
  const { host, wire, pairedPhone } = await setUp({ answer: async (request) => answerOfSize(request.id, 3 * PIECE_BYTES) });
  const phone = await pairedPhone(1);
  newLogLines();
  // The relay tells the host the phone went from inside the host's send, as the first piece of the answer goes.
  wire.onSend = (channel) => host.closed(channel);
  await phone.send(writeRequest(schemasOf(1)));
  await until(() => wire.waiting(1) > 0, "the first piece of the answer");
  await quiet();
  // The rest of the answer did not go to a phone that has gone, and the host did not close what the relay closed.
  assert.equal(wire.waiting(1), 1);
  assert.deepEqual(wire.closed, []);
  assert.deepEqual(host.connectedPhones(), []);
  assert.equal(newLogLines(), "");
});

test("sends away a phone that does not finish connecting in time, and only such a phone", async () => {
  const { host, wire, clock, pairedPhone } = await setUp();
  host.opened(1);
  clock.advance(HANDSHAKE_WITHIN_MS - 1);
  assert.deepEqual(wire.closed, []);
  clock.advance(1);
  assert.deepEqual(wire.closed, [1]);
  const phone = await pairedPhone(2);
  clock.advance(HANDSHAKE_WITHIN_MS * 10);
  assert.deepEqual(wire.closed, [1]);
  assert.deepEqual(await phone.request(schemasOf(1)), { id: 1, ok: true, result: { schemas: ["public"] } });
});

test("sends away a phone that speaks too soon, or whose first message is not a handshake for this computer", async () => {
  const { host, wire, computerKey, paired, newPhone } = await setUp();
  const { code } = host.startPairing();
  const phoneKey = await generateKeyPair("X25519", false);
  const firstMessage = (payload: Bytes, remoteStaticKey = computerKey.publicKey): Promise<Bytes> =>
    new Initiator({ prologue: PHONE_LINK_PROLOGUE, staticKey: phoneKey, remoteStaticKey }).writeFirstMessage(payload);

  // A phone waits for the computer's answer before it says more.
  host.opened(1);
  host.received(1, await firstMessage(writeOpening(pairWith(code.secret))));
  host.received(1, utf8("hello?"));
  assert.deepEqual(wire.closed, [1]);

  host.opened(2);
  host.received(2, new Uint8Array(10));
  await wire.waitClosed(2);

  // A handshake, but its opening is not one a phone sends.
  host.opened(3);
  host.received(3, await firstMessage(utf8("{}")));
  await wire.waitClosed(3);

  // A handshake for another computer's key.
  const other = await generateKeyPair("X25519", false);
  host.opened(4);
  host.received(4, await firstMessage(writeOpening(pairWith(code.secret)), other.publicKey));
  await wire.waitClosed(4);

  await quiet();
  assert.deepEqual(wire.closed, [1, 2, 3, 4]);
  for (const channel of [1, 2, 3, 4]) assert.equal(wire.waiting(channel), 0, `nothing was sent on channel ${channel}`);
  assert.deepEqual(paired, []);
  // None of them used the pairing link up.
  assert.deepEqual(await (await newPhone(5, phoneKey)).connect(pairWith(code.secret)), LET_IN);
});

test("forgetting a phone unpairs it, and sends away each connection it has", async () => {
  const { host, wire, saved, newPhone, pairedPhone } = await setUp();
  const a = await pairedPhone(1, undefined, "A");
  assert.deepEqual(await (await newPhone(2, a.key)).connect(SESSION), LET_IN);
  const b = await pairedPhone(3, undefined, "B");
  assert.deepEqual(host.connectedPhones(), [a.keyText, b.keyText]);
  host.forgetPhone(a.keyText);
  assert.deepEqual(wire.closed, [1, 2]);
  assert.deepEqual(
    saved().map((phone) => phone.name),
    ["B"],
  );
  assert.deepEqual(host.connectedPhones(), [b.keyText]);
  assert.deepEqual(await (await newPhone(4, a.key)).connect(SESSION), { ok: false, reason: "not-paired" });
  assert.deepEqual(await b.request(schemasOf(1)), { id: 1, ok: true, result: { schemas: ["public"] } });
});

test("lets go of every phone when the relay connection drops, and keeps the pairing link", async () => {
  const fake = fakeAnswers();
  const { host, wire, clock, newPhone, pairedPhone } = await setUp({ answer: fake.answer });
  const phone = await pairedPhone(1);
  await phone.send(writeRequest(schemasOf(1)));
  const first = await askedFor(fake.asked, 1);
  const { code } = host.startPairing();
  host.opened(2);
  host.dropAll();
  assert.equal(first.signal.aborted, true);
  assert.deepEqual(host.connectedPhones(), []);
  clock.advance(HANDSHAKE_WITHIN_MS);
  // The relay let the phones go itself.
  assert.deepEqual(wire.closed, []);

  // What still comes from the old phone is ignored, and the old answer is not sent.
  await phone.send(writeRequest(schemasOf(2)));
  first.answer.resolve(schemasAnswer(1, ["late"]));
  await quiet();
  assert.equal(fake.asked.length, 1);
  assert.equal(wire.waiting(1), 0);

  assert.deepEqual(await (await newPhone(1)).connect(pairWith(code.secret)), LET_IN);
});

test("says when a phone is let in and when a connected phone goes, and only then", async () => {
  const { host, wire, clock, connectedChanges, newPhone, pairedPhone } = await setUp();
  const first = await pairedPhone(1);
  assert.deepEqual(connectedChanges, [[first.keyText]]);

  // A phone that is turned away, or that never finishes connecting, was never connected.
  assert.deepEqual(await (await newPhone(2)).connect(SESSION), { ok: false, reason: "not-paired" });
  host.opened(3);
  clock.advance(HANDSHAKE_WITHIN_MS);
  assert.deepEqual(wire.closed, [2, 3]);
  assert.equal(connectedChanges.length, 1);

  // The relay says a phone went, and a phone is forgotten.
  const second = await pairedPhone(4);
  host.closed(1);
  host.forgetPhone(second.keyText);
  assert.deepEqual(connectedChanges.slice(1), [[first.keyText, second.keyText], [second.keyText], []]);

  // A paired phone comes back, and goes when the relay gives its channel to a new phone.
  assert.deepEqual(await (await newPhone(5, first.key)).connect(SESSION), LET_IN);
  host.opened(5);
  assert.deepEqual(connectedChanges.slice(4), [[first.keyText], []]);

  // The channel given again is not let in yet, so dropping it says nothing.
  const third = await pairedPhone(6);
  host.dropAll();
  assert.deepEqual(connectedChanges.slice(6), [[third.keyText], []]);
});

test("ignores a channel it never opened, and takes a channel opened again for a new phone", async () => {
  const fake = fakeAnswers();
  const { host, wire, pairedPhone } = await setUp({ answer: fake.answer });
  host.received(9, utf8("hello?"));
  host.closed(9);
  const old = await pairedPhone(1);
  await old.send(writeRequest(schemasOf(1)));
  const first = await askedFor(fake.asked, 1);
  const fresh = await pairedPhone(1, undefined, "Tablet");
  assert.equal(first.signal.aborted, true);
  assert.deepEqual(wire.closed, []);
  assert.deepEqual(host.connectedPhones(), [fresh.keyText]);
  first.answer.resolve(schemasAnswer(1, ["old"]));
  await quiet();
  assert.equal(wire.waiting(1), 0);
});

test("keeps no more phone connections than it should", async () => {
  const { host, wire, clock } = await setUp();
  newLogLines();
  for (let channel = 1; channel <= MAX_CHANNELS; channel += 1) host.opened(channel);
  assert.deepEqual(wire.closed, []);
  host.opened(MAX_CHANNELS + 1);
  assert.deepEqual(wire.closed, [MAX_CHANNELS + 1]);
  assert.match(newLogLines(), /more phones than the phone link keeps \(16\)/);
  clock.advance(HANDSHAKE_WITHIN_MS);
  assert.equal(wire.closed.length, MAX_CHANNELS + 1);
});

test("sends away a phone whose message cannot be opened, and ignores what it sends after", async () => {
  const fake = fakeAnswers();
  const { host, wire, pairedPhone } = await setUp({ answer: fake.answer });
  const phone = await pairedPhone(1);
  host.received(1, new Uint8Array(64));
  await wire.waitClosed(1);
  assert.deepEqual(host.connectedPhones(), []);
  await phone.send(writeRequest(schemasOf(1)));
  await quiet();
  assert.deepEqual(fake.asked, []);
});

test("makes a new secret for each pairing link, good for five minutes", async () => {
  const { host, clock, computerKey } = await setUp();
  const first = host.startPairing();
  assert.equal(first.code.desktopId, DESKTOP_ID);
  assert.deepEqual(first.code.desktopKey, computerKey.publicKey);
  assert.equal(first.code.secret.length, PAIRING_SECRET_BYTES);
  assert.equal(first.expiresAt, clock.time + PAIRING_LIFETIME_MS);
  assert.notDeepEqual(host.startPairing().code.secret, first.code.secret);
});
