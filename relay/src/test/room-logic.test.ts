/**
 * The rules of a room at the relay, run with pretend connections: signing
 * in, phones coming and going, where messages go, the limits, and a room
 * built again after sleeping (src/room-logic.ts).
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  DESKTOP_BURST,
  MAX_PHONES,
  MAX_SIGNING_IN,
  PHONE_BURST,
  PHONE_PER_SECOND,
  RoomLogic,
  SIGN_IN_MS,
  type Socket,
  type SocketState,
} from "../room-logic.js";
import { toBase64Url, utf8, type Bytes } from "../shared/remote/bytes.js";
import { generateKeyPair, KEY_BYTES, type KeyPair } from "../shared/remote/keys.js";
import { desktopIdFor, SIGNATURE_BYTES, signChallenge } from "../shared/remote/relay-auth.js";
import {
  addChannel,
  CLOSE_BROKEN,
  CLOSE_FULL,
  CLOSE_REPLACED,
  CLOSE_SENT_AWAY,
  CLOSE_SIGN_IN_FAILED,
  CLOSE_TOO_BIG,
  CLOSE_TOO_FAST,
  MAX_CONTROL_LENGTH,
  MAX_FRAME_BYTES,
  MAX_RELAY_MESSAGE_BYTES,
  PING,
  PONG,
  readControl,
  writeControl,
  type Control,
} from "../shared/remote/relay-protocol.js";

/** A message the room sent, and the name of the connection it went to. */
type Sent = { to: string; message: string | Bytes };

/**
 * A pretend connection, which keeps what the room did with it. Once closed,
 * it throws whatever the room does with it, which is the most a real one
 * might do, and it refuses a close code or reason WebSocket does not allow.
 */
class FakeSocket implements Socket {
  readonly name: string;
  /** Shared by all of a test's connections, so it shows the order of everything the room sent. */
  private readonly log: Sent[];
  readonly sent: (string | Bytes)[] = [];
  /** How it was closed, by the room or by the other end (hangUp), or null while it is open. */
  closedWith: { code: number; reason: string } | null = null;
  /** What the room last wrote to the connection. */
  attachment: unknown = null;

  constructor(name: string, log: Sent[]) {
    this.name = name;
    this.log = log;
  }

  send(message: string | Bytes): void {
    this.mustBeOpen();
    // A copy of just the bytes in view, which is what a real connection sends.
    const copy = typeof message === "string" ? message : new Uint8Array(message);
    this.sent.push(copy);
    this.log.push({ to: this.name, message: copy });
  }

  close(code?: number, reason = ""): void {
    this.mustBeOpen();
    if (code !== undefined && code !== 1000 && !(code >= 3000 && code <= 4999)) {
      throw new Error(`A program may not close a connection with code ${code}.`);
    }
    if (utf8(reason).length > 123) throw new Error("A reason for closing may be at most 123 bytes.");
    this.closedWith = { code: code ?? 1005, reason };
  }

  serializeAttachment(value: unknown): void {
    this.mustBeOpen();
    this.attachment = structuredClone(value);
  }

  /** The other end closes the connection. The room hears of it later, when the test calls closed(). */
  hangUp(): void {
    this.closedWith = { code: 1000, reason: "" };
  }

  /** The last message the room sent to this connection. */
  last(): string | Bytes | undefined {
    return this.sent.at(-1);
  }

  private mustBeOpen(): void {
    if (this.closedWith !== null) throw new Error(`${this.name} is closed.`);
  }
}

/** The computer's signing key, and the ID of its room. */
const SIGNING_KEY = await generateKeyPair("Ed25519", false);
const ID = await desktopIdFor(SIGNING_KEY.publicKey);
/** Any time will do, as the room is told the time with each call. */
const NOW = 1_000_000;

// The messages the room sends that say nothing more than their kind.
const READY = writeControl({ type: "ready" });
const ONLINE = writeControl({ type: "online" });
const OFFLINE = writeControl({ type: "offline" });

/** A message the room should refuse, what to call it, and how the room should close the connection that sent it. */
type Refused = { name: string; message: string | Bytes; code: number; reason: RegExp };
// How the room closes a connection for each of the two kinds of refusal.
const BROKEN = { code: CLOSE_BROKEN, reason: /did not understand/ };
const TOO_BIG = { code: CLOSE_TOO_BIG, reason: /too big/ };

/** A new room, and a way to make connections that share one log of everything the room sends. */
function setUp() {
  const log: Sent[] = [];
  return { room: new RoomLogic([]), log, socket: (name: string) => new FakeSocket(name, log) };
}

/** Reads a control message the room sent, or fails the test when it is not one. */
function controlOf(message: string | Bytes | undefined): Control {
  const control = typeof message === "string" ? readControl(message) : null;
  if (control === null) throw new Error(`Expected a control message, but the room sent ${String(message)}.`);
  return control;
}

/** The challenge the room sent a connection at the desktop door. */
function challengeOf(desktop: FakeSocket): Bytes {
  const control = controlOf(desktop.sent[0]);
  if (control.type !== "challenge") throw new Error(`Expected a challenge, but the room sent ${control.type}.`);
  return control.challenge;
}

/** Checks that the room closed a connection with this code and reason, and cleared what it wrote to it. */
function assertSentAway(socket: FakeSocket, code: number, reason: RegExp): void {
  if (socket.closedWith === null) throw new Error(`${socket.name} is still open.`);
  assert.equal(socket.closedWith.code, code, socket.name);
  assert.match(socket.closedWith.reason, reason, socket.name);
  assert.equal(socket.attachment, null, socket.name);
}

/** The answer a computer with this key gives to the challenge the room sent it. */
async function answer(desktop: FakeSocket, key: KeyPair = SIGNING_KEY): Promise<Extract<Control, { type: "auth" }>> {
  return { type: "auth", publicKey: key.publicKey, signature: await signChallenge(key, challengeOf(desktop)) };
}

/** Connects a computer at the desktop door and signs it in. */
async function signIn(room: RoomLogic, desktop: FakeSocket, now = NOW): Promise<void> {
  room.addDesktop(desktop, ID, now);
  await room.receive(desktop, writeControl(await answer(desktop)), now);
  assert.equal(desktop.sent[1], READY, `${desktop.name} did not sign in.`);
}

/** The channel in an "open" the room sent the computer. */
function channelOpened(message: string | Bytes | undefined): number {
  const control = controlOf(message);
  if (control.type !== "open") throw new Error(`Expected an open, but the room sent ${control.type}.`);
  return control.channel;
}

/** Connects a phone while the computer is signed in, and gives the channel the room opened for it. */
function addPhone(room: RoomLogic, desktop: FakeSocket, phone: FakeSocket): number {
  room.addPhone(phone);
  assert.equal(phone.last(), ONLINE, phone.name);
  return channelOpened(desktop.last());
}

/** The room built again from its connections, as Cloudflare does when a sleeping room gets a message. */
function wake(sockets: FakeSocket[]): RoomLogic {
  const states: [Socket, SocketState][] = [];
  // Only ever what the room wrote, or what a test set to stand for it.
  for (const socket of sockets) if (socket.attachment !== null) states.push([socket, socket.attachment as SocketState]);
  return new RoomLogic(states);
}

test("sends each connection at the computer's door a fresh challenge to sign", () => {
  const { room, socket } = setUp();
  const first = socket("first");
  const second = socket("second");
  room.addDesktop(first, ID, NOW);
  room.addDesktop(second, ID, NOW + 1);
  assert.notDeepEqual(challengeOf(first), challengeOf(second));
  for (const [desktop, connectedAt] of [
    [first, NOW],
    [second, NOW + 1],
  ] as const) {
    assert.equal(desktop.sent.length, 1, desktop.name);
    assert.deepEqual(
      desktop.attachment,
      { role: "desktop", step: "signing-in", desktopId: ID, challenge: toBase64Url(challengeOf(desktop)), deadline: connectedAt + SIGN_IN_MS, answered: false },
      desktop.name,
    );
  }
  assert.equal(room.nextDeadline(), NOW + SIGN_IN_MS);
});

test("signs the computer in when it signs its challenge, and connects the phones that were waiting", async () => {
  const { room, log, socket } = setUp();
  const phone = socket("phone");
  const desktop = socket("desktop");
  room.addPhone(phone);
  room.addDesktop(desktop, ID, NOW);
  // Nothing reaches a computer before it has signed in.
  await room.receive(phone, new Uint8Array([1, 2, 3]), NOW);
  await room.receive(desktop, writeControl(await answer(desktop)), NOW);
  const channel = channelOpened(desktop.sent[2]);
  assert.deepEqual(log, [
    { to: "phone", message: OFFLINE },
    { to: "desktop", message: desktop.sent[0] },
    { to: "desktop", message: READY },
    { to: "desktop", message: writeControl({ type: "open", channel }) },
    { to: "phone", message: ONLINE },
  ]);
  assert.deepEqual(desktop.attachment, { role: "desktop", step: "ready" });
  assert.deepEqual(phone.attachment, { role: "phone", channel });
  assert.equal(room.nextDeadline(), null);
});

test("sends away a connection that does not prove the room is its own, and leaves the signed-in computer be", async () => {
  const { room, socket } = setUp();
  const desktop = socket("desktop");
  const phone = socket("phone");
  await signIn(room, desktop);
  addPhone(room, desktop, phone);
  const changed = socket("changed signature");
  room.addDesktop(changed, ID, NOW);
  const auth = await answer(changed);
  auth.signature[0] ^= 1;
  await room.receive(changed, writeControl(auth), NOW);
  // A good signature, but by another computer's key, which is not this room's.
  const stranger = socket("stranger");
  room.addDesktop(stranger, ID, NOW);
  await room.receive(stranger, writeControl(await answer(stranger, await generateKeyPair("Ed25519", false))), NOW);
  for (const refused of [changed, stranger]) assertSentAway(refused, CLOSE_SIGN_IN_FAILED, /did not prove/);
  assert.equal(desktop.closedWith, null);
  assert.equal(desktop.sent.length, 3);
  assert.deepEqual(phone.sent, [ONLINE]);
});

test("sends away a connection that says anything but its answer before signing in", async () => {
  const cases: Refused[] = [
    { name: "a binary message", message: new Uint8Array([0, 0, 0, 1, 1]), ...BROKEN },
    { name: "a control message of another kind", message: writeControl({ type: "close", channel: 1 }), ...BROKEN },
    { name: "text that is not a control message", message: "hello", ...BROKEN },
    { name: "an answer with nothing in it", message: '{"t":"auth"}', ...BROKEN },
    { name: "text over the limit", message: " ".repeat(MAX_CONTROL_LENGTH + 1), ...TOO_BIG },
  ];
  for (const { name, message, code, reason } of cases) {
    const { room, socket } = setUp();
    const desktop = socket(name);
    room.addDesktop(desktop, ID, NOW);
    await room.receive(desktop, message, NOW);
    assertSentAway(desktop, code, reason);
    assert.equal(room.nextDeadline(), null, name);
  }
});

test("refuses a second answer while the first is still being checked", async () => {
  const { room, socket } = setUp();
  const phone = socket("phone");
  const desktop = socket("desktop");
  room.addPhone(phone);
  room.addDesktop(desktop, ID, NOW);
  const auth = writeControl(await answer(desktop));
  await Promise.all([room.receive(desktop, auth, NOW), room.receive(desktop, auth, NOW)]);
  assertSentAway(desktop, CLOSE_BROKEN, /did not understand/);
  assert.deepEqual(phone.sent, [OFFLINE]);
  assert.equal(room.nextDeadline(), null);
});

test("sends away a connection that has not signed in by its deadline", async () => {
  const { room, socket } = setUp();
  const desktop = socket("desktop");
  const late = socket("late");
  await signIn(room, desktop);
  room.addDesktop(late, ID, NOW + 5);
  const deadline = NOW + 5 + SIGN_IN_MS;
  assert.equal(room.nextDeadline(), deadline);
  room.expire(deadline - 1);
  assert.equal(late.closedWith, null);
  room.expire(deadline);
  assertSentAway(late, CLOSE_SIGN_IN_FAILED, /in time/);
  assert.equal(desktop.closedWith, null);
  assert.equal(desktop.sent.length, 2);
  assert.equal(room.nextDeadline(), null);
});

test("sends away a connection whose time runs out while its answer is being checked", async () => {
  const { room, socket } = setUp();
  const phone = socket("phone");
  const desktop = socket("desktop");
  room.addPhone(phone);
  room.addDesktop(desktop, ID, NOW);
  const checking = room.receive(desktop, writeControl(await answer(desktop)), NOW + SIGN_IN_MS - 1);
  room.expire(NOW + SIGN_IN_MS);
  await checking;
  assertSentAway(desktop, CLOSE_SIGN_IN_FAILED, /in time/);
  // Had it signed in after all, the phone would have heard "online".
  assert.deepEqual(phone.sent, [OFFLINE]);
});

test("lets nothing in from a connection that closed while its answer was being checked", async () => {
  const { room, socket } = setUp();
  const phone = socket("phone");
  const desktop = socket("desktop");
  room.addPhone(phone);
  room.addDesktop(desktop, ID, NOW);
  const checking = room.receive(desktop, writeControl(await answer(desktop)), NOW);
  desktop.hangUp();
  room.closed(desktop);
  await checking;
  assert.deepEqual(phone.sent, [OFFLINE]);
  assert.equal(room.nextDeadline(), null);
  const later = socket("later phone");
  room.addPhone(later);
  assert.deepEqual(later.sent, [OFFLINE]);
});

test("lets only a few connections sign in at once, and sends the oldest away to make room", async () => {
  const { room, socket } = setUp();
  const desktops: FakeSocket[] = [];
  for (let i = 0; i < MAX_SIGNING_IN; i++) {
    const desktop = socket(`desktop ${i}`);
    room.addDesktop(desktop, ID, NOW + i);
    desktops.push(desktop);
  }
  const newest = socket("newest");
  room.addDesktop(newest, ID, NOW + MAX_SIGNING_IN);
  assertSentAway(desktops[0], CLOSE_FULL, /signing in/);
  for (const desktop of [...desktops.slice(1), newest]) assert.equal(desktop.closedWith, null, desktop.name);
  assert.equal(room.nextDeadline(), NOW + 1 + SIGN_IN_MS);
  // One that has signed in no longer counts.
  await room.receive(desktops[1], writeControl(await answer(desktops[1])), NOW + MAX_SIGNING_IN);
  assert.equal(desktops[1].sent[1], READY);
  room.addDesktop(socket("another"), ID, NOW + MAX_SIGNING_IN + 1);
  for (const desktop of [...desktops.slice(1), newest]) assert.equal(desktop.closedWith, null, desktop.name);
});

test("hands the room to the computer's new connection, and starts its phones again with it", async () => {
  const { room, log, socket } = setUp();
  const old = socket("old");
  const phone = socket("phone");
  const fresh = socket("new");
  await signIn(room, old);
  addPhone(room, old, phone);
  room.addDesktop(fresh, ID, NOW + 1);
  const auth = writeControl(await answer(fresh));
  log.length = 0;
  await room.receive(fresh, auth, NOW + 1);
  const channel = channelOpened(fresh.sent[2]);
  assert.deepEqual(log, [
    { to: "phone", message: OFFLINE },
    { to: "new", message: READY },
    { to: "new", message: writeControl({ type: "open", channel }) },
    { to: "phone", message: ONLINE },
  ]);
  assertSentAway(old, CLOSE_REPLACED, /connected again/);
  const message = new Uint8Array([1, 2, 3]);
  await room.receive(phone, message, NOW + 1);
  assert.deepEqual(fresh.last(), addChannel(channel, message));
});

test("lets only so many phones connect to a computer at once", () => {
  const { room, socket } = setUp();
  const phones: FakeSocket[] = [];
  for (let i = 0; i < MAX_PHONES; i++) {
    const phone = socket(`phone ${i}`);
    room.addPhone(phone);
    assert.deepEqual(phone.sent, [OFFLINE], phone.name);
    phones.push(phone);
  }
  const extra = socket("extra");
  room.addPhone(extra);
  assertSentAway(extra, CLOSE_FULL, /Too many phones/);
  assert.deepEqual(extra.sent, []);
  phones[0].hangUp();
  room.closed(phones[0]);
  const next = socket("next");
  room.addPhone(next);
  assert.deepEqual(next.sent, [OFFLINE]);
});

test("passes each phone's messages to the computer on its own channel, and the computer's to the right phone", async () => {
  const { room, socket } = setUp();
  const desktop = socket("desktop");
  const phoneA = socket("phone A");
  const phoneB = socket("phone B");
  await signIn(room, desktop);
  const a = addPhone(room, desktop, phoneA);
  const b = addPhone(room, desktop, phoneB);
  assert.notEqual(a, b);
  const fromA = new Uint8Array([1, 2, 3]);
  const fromB = new Uint8Array(MAX_RELAY_MESSAGE_BYTES).fill(7);
  await room.receive(phoneA, fromA, NOW);
  assert.deepEqual(desktop.last(), addChannel(a, fromA));
  await room.receive(phoneB, fromB, NOW);
  assert.deepEqual(desktop.last(), addChannel(b, fromB));
  const toA = new Uint8Array([4, 5]);
  const toB = new Uint8Array(MAX_RELAY_MESSAGE_BYTES).fill(6);
  await room.receive(desktop, addChannel(b, toB), NOW);
  await room.receive(desktop, addChannel(a, toA), NOW);
  assert.deepEqual(phoneA.sent, [ONLINE, toA]);
  assert.deepEqual(phoneB.sent, [ONLINE, toB]);
  // A channel no phone is on, such as one whose phone has just left, goes nowhere.
  let unused = 1;
  while (unused === a || unused === b) unused++;
  await room.receive(desktop, addChannel(unused, toA), NOW);
  assert.deepEqual(phoneA.sent, [ONLINE, toA]);
  assert.deepEqual(phoneB.sent, [ONLINE, toB]);
  assert.equal(desktop.closedWith, null);
});

test("tells the computer when a phone has left, once the room hears of it", async () => {
  const { room, socket } = setUp();
  const desktop = socket("desktop");
  const phone = socket("phone");
  await signIn(room, desktop);
  const channel = addPhone(room, desktop, phone);
  phone.hangUp();
  // Until the room hears, what the computer sends the phone is lost on the way.
  await room.receive(desktop, addChannel(channel, new Uint8Array([1])), NOW);
  room.closed(phone);
  assert.equal(desktop.last(), writeControl({ type: "close", channel }));
  const sentSoFar = desktop.sent.length;
  await room.receive(desktop, addChannel(channel, new Uint8Array([1])), NOW);
  room.closed(phone);
  assert.equal(desktop.sent.length, sentSoFar);
  assert.equal(desktop.closedWith, null);
});

test("sends a phone away when the computer asks, without telling the computer again", async () => {
  const { room, socket } = setUp();
  const desktop = socket("desktop");
  const phone = socket("phone");
  await signIn(room, desktop);
  const channel = addPhone(room, desktop, phone);
  const sentSoFar = desktop.sent.length;
  await room.receive(desktop, writeControl({ type: "close", channel }), NOW);
  assertSentAway(phone, CLOSE_SENT_AWAY, /ended this connection/);
  room.closed(phone);
  await room.receive(desktop, writeControl({ type: "close", channel }), NOW);
  assert.equal(desktop.sent.length, sentSoFar);
  assert.equal(desktop.closedWith, null);
});

test("tells the phones when the computer leaves, and connects them again when it is back", async () => {
  const { room, socket } = setUp();
  const desktop = socket("desktop");
  const phone = socket("phone");
  await signIn(room, desktop);
  addPhone(room, desktop, phone);
  desktop.hangUp();
  room.closed(desktop);
  assert.deepEqual(phone.sent, [ONLINE, OFFLINE]);
  assert.deepEqual(phone.attachment, { role: "phone", channel: 0 });
  // What the phone sends now was meant for the computer that has gone.
  await room.receive(phone, new Uint8Array([1]), NOW);
  assert.equal(phone.closedWith, null);
  const back = socket("back");
  await signIn(room, back, NOW + 1);
  const channel = channelOpened(back.sent[2]);
  assert.deepEqual(phone.sent, [ONLINE, OFFLINE, ONLINE]);
  assert.deepEqual(phone.attachment, { role: "phone", channel });
  assert.equal(back.sent.length, 3);
});

test("sends away a phone that sends what it should not, and tells the computer", async () => {
  const cases: Refused[] = [
    { name: "text that is not a control message", message: "hello", ...BROKEN },
    { name: "a control message of another kind", message: writeControl({ type: "online" }), ...BROKEN },
    { name: "text over the limit", message: " ".repeat(MAX_CONTROL_LENGTH + 1), ...TOO_BIG },
    { name: "an empty message", message: new Uint8Array(0), ...BROKEN },
    { name: "a message over the limit", message: new Uint8Array(MAX_RELAY_MESSAGE_BYTES + 1), ...TOO_BIG },
  ];
  for (const { name, message, code, reason } of cases) {
    const { room, socket } = setUp();
    const desktop = socket("desktop");
    const phone = socket(name);
    await signIn(room, desktop);
    const channel = addPhone(room, desktop, phone);
    await room.receive(phone, message, NOW);
    assertSentAway(phone, code, reason);
    assert.equal(desktop.last(), writeControl({ type: "close", channel }), name);
    // Anything more from it comes too late, and goes nowhere.
    await room.receive(phone, new Uint8Array([1]), NOW);
    assert.equal(desktop.last(), writeControl({ type: "close", channel }), name);
  }
});

test("sends away a computer that sends what it should not, and tells its phones", async () => {
  const cases: Refused[] = [
    { name: "text that is not a control message", message: "hello", ...BROKEN },
    { name: "a control message of another kind", message: writeControl({ type: "open", channel: 1 }), ...BROKEN },
    {
      name: "a second answer",
      message: writeControl({ type: "auth", publicKey: new Uint8Array(KEY_BYTES), signature: new Uint8Array(SIGNATURE_BYTES) }),
      ...BROKEN,
    },
    { name: "text over the limit", message: " ".repeat(MAX_CONTROL_LENGTH + 1), ...TOO_BIG },
    { name: "an empty message", message: new Uint8Array(0), ...BROKEN },
    { name: "a channel with no message", message: new Uint8Array([0, 0, 0, 1]), ...BROKEN },
    { name: "channel 0", message: new Uint8Array([0, 0, 0, 0, 1]), ...BROKEN },
    { name: "a message over the limit", message: new Uint8Array(MAX_FRAME_BYTES + 1), ...TOO_BIG },
  ];
  for (const { name, message, code, reason } of cases) {
    const { room, socket } = setUp();
    const desktop = socket(name);
    const phone = socket("phone");
    await signIn(room, desktop);
    const channel = addPhone(room, desktop, phone);
    await room.receive(desktop, message, NOW);
    assertSentAway(desktop, code, reason);
    assert.deepEqual(phone.sent, [ONLINE, OFFLINE], name);
    assert.deepEqual(phone.attachment, { role: "phone", channel: 0 }, name);
    // Anything more from it comes too late, and goes nowhere.
    await room.receive(desktop, addChannel(channel, new Uint8Array([1])), NOW);
    assert.deepEqual(phone.sent, [ONLINE, OFFLINE], name);
  }
});

test("sends away a connection that sends too many messages too quickly", async () => {
  const { room, socket } = setUp();
  const desktop = socket("desktop");
  const greedy = socket("greedy phone");
  const steady = socket("steady phone");
  await signIn(room, desktop);
  addPhone(room, desktop, greedy);
  addPhone(room, desktop, steady);
  // Signing in took one of the computer's tokens, and this is long enough after for its bucket to be full again.
  const now = NOW + 60_000;
  for (let i = 0; i < PHONE_BURST; i++) await room.receive(greedy, PING, now);
  assert.equal(greedy.last(), PONG);
  await room.receive(greedy, PING, now);
  assertSentAway(greedy, CLOSE_TOO_FAST, /too quickly/);
  // A bucket fills again steadily, so a phone that has used up its tokens
  // may send one more message once a token's worth of time has passed.
  for (let i = 0; i < PHONE_BURST; i++) await room.receive(steady, PING, now);
  const later = now + 1000 / PHONE_PER_SECOND;
  await room.receive(steady, PING, later);
  assert.equal(steady.closedWith, null);
  await room.receive(steady, PING, later);
  assertSentAway(steady, CLOSE_TOO_FAST, /too quickly/);
  for (let i = 0; i < DESKTOP_BURST; i++) await room.receive(desktop, PING, now);
  assert.equal(desktop.closedWith, null);
  await room.receive(desktop, PING, now);
  assertSentAway(desktop, CLOSE_TOO_FAST, /too quickly/);
});

test("answers pings from phones, and from the computer before and after it signs in", async () => {
  const { room, socket } = setUp();
  const phone = socket("phone");
  const desktop = socket("desktop");
  room.addPhone(phone);
  await room.receive(phone, PING, NOW);
  assert.deepEqual(phone.sent, [OFFLINE, PONG]);
  room.addDesktop(desktop, ID, NOW);
  await room.receive(desktop, PING, NOW);
  assert.equal(desktop.sent[1], PONG);
  await room.receive(desktop, writeControl(await answer(desktop)), NOW);
  assert.equal(desktop.sent[2], READY);
  await room.receive(desktop, PING, NOW);
  assert.equal(desktop.last(), PONG);
});

test("carries on as before after sleeping, even with a connection still signing in", async () => {
  const { room, socket } = setUp();
  const desktop = socket("desktop");
  const phone = socket("phone");
  const waiting = socket("waiting");
  await signIn(room, desktop);
  const channel = addPhone(room, desktop, phone);
  room.addDesktop(waiting, ID, NOW + 1);
  const woken = wake([desktop, phone, waiting]);
  assert.equal(woken.nextDeadline(), NOW + 1 + SIGN_IN_MS);
  const fromPhone = new Uint8Array([1, 2]);
  await woken.receive(phone, fromPhone, NOW + 2);
  assert.deepEqual(desktop.last(), addChannel(channel, fromPhone));
  const toPhone = new Uint8Array([3]);
  await woken.receive(desktop, addChannel(channel, toPhone), NOW + 2);
  assert.deepEqual(phone.last(), toPhone);
  // The computer's newer connection answers the challenge it was sent before the room slept.
  await woken.receive(waiting, writeControl(await answer(waiting)), NOW + 2);
  assertSentAway(desktop, CLOSE_REPLACED, /connected again/);
  const fresh = channelOpened(waiting.last());
  assert.deepEqual(phone.sent.slice(-2), [OFFLINE, ONLINE]);
  assert.deepEqual(phone.attachment, { role: "phone", channel: fresh });
});

test("puts right what it should never find when it wakes up", async () => {
  const { socket } = setUp();
  // A phone on a channel, with no computer signed in.
  const lonely = socket("lonely");
  lonely.attachment = { role: "phone", channel: 7 };
  wake([lonely]);
  assert.deepEqual(lonely.sent, [OFFLINE]);
  assert.deepEqual(lonely.attachment, { role: "phone", channel: 0 });
  // Two computers signed in, two phones on one channel, and a phone with no
  // channel while the computer is there.
  const first = socket("first");
  const second = socket("second");
  const phone = socket("phone");
  const twin = socket("twin");
  const lost = socket("lost");
  first.attachment = { role: "desktop", step: "ready" };
  second.attachment = { role: "desktop", step: "ready" };
  phone.attachment = { role: "phone", channel: 7 };
  twin.attachment = { role: "phone", channel: 7 };
  lost.attachment = { role: "phone", channel: 0 };
  const room = wake([first, second, phone, twin, lost]);
  assertSentAway(second, CLOSE_REPLACED, /connected again/);
  assert.deepEqual(phone.sent, []);
  assert.deepEqual(phone.attachment, { role: "phone", channel: 7 });
  assert.equal(first.sent.length, 2);
  const twinChannel = channelOpened(first.sent[0]);
  const lostChannel = channelOpened(first.sent[1]);
  assert.notEqual(twinChannel, 7);
  assert.notEqual(twinChannel, lostChannel);
  assert.deepEqual(twin.sent, [ONLINE]);
  assert.deepEqual(twin.attachment, { role: "phone", channel: twinChannel });
  assert.deepEqual(lost.sent, [ONLINE]);
  assert.deepEqual(lost.attachment, { role: "phone", channel: lostChannel });
  const message = new Uint8Array([1]);
  await room.receive(phone, message, NOW);
  assert.deepEqual(first.last(), addChannel(7, message));
});
