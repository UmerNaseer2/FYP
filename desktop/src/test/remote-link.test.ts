/**
 * Cutting messages into pieces and sending them whole over a link
 * (src/shared/remote/link.ts).
 */
import assert from "node:assert/strict";
import test from "node:test";

import { utf8, type Bytes } from "../shared/remote/bytes.js";
import { generateKeyPair } from "../shared/remote/keys.js";
import { cutIntoPieces, Link, MAX_LINK_MESSAGE_BYTES, PIECE_BYTES, PieceJoiner } from "../shared/remote/link.js";
import { Initiator, MAX_MESSAGE_BYTES, MAX_PLAINTEXT_BYTES, NoiseError, Responder, type Session } from "../shared/remote/noise.js";
import { MAX_RELAY_MESSAGE_BYTES } from "../shared/remote/relay-protocol.js";

const PROLOGUE = utf8("Schema Studio phone link test");

/** Bytes that differ from place to place, of any length (Web Crypto's random bytes stop at 64 KiB). */
function sample(length: number): Bytes {
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i++) bytes[i] = i % 251;
  return bytes;
}

/** A full piece with this first byte. */
function fullPiece(flag: number): Bytes {
  const piece = new Uint8Array(PIECE_BYTES);
  piece[0] = flag;
  return piece;
}

/** What a link refuses with: a LinkError whose message matches. */
function refused(message: RegExp) {
  return { name: "LinkError", message };
}

/** Both sessions of a finished handshake between fresh keys. */
async function sessions(): Promise<{ phone: Session; computer: Session }> {
  const computerKey = await generateKeyPair("X25519", false);
  const initiator = new Initiator({ prologue: PROLOGUE, staticKey: await generateKeyPair("X25519", false), remoteStaticKey: computerKey.publicKey });
  const responder = new Responder({ prologue: PROLOGUE, staticKey: computerKey });
  await responder.readFirstMessage(await initiator.writeFirstMessage(new Uint8Array(0)));
  const answer = await responder.writeAnswer(new Uint8Array(0));
  const opened = await initiator.readAnswer(answer.message);
  return { phone: opened.session, computer: answer.session };
}

/**
 * A link on each side of a fresh handshake. What each side sends waits on
 * its own wire, in order, until deliver hands it over.
 */
async function linkPair() {
  const { phone, computer } = await sessions();
  const toComputer: Bytes[] = [];
  const toPhone: Bytes[] = [];
  return {
    toComputer,
    toPhone,
    phone: new Link(phone, (sealed) => toComputer.push(sealed)),
    computer: new Link(computer, (sealed) => toPhone.push(sealed)),
  };
}

/** Hands everything waiting on a wire to the link at its other end, and gives the whole messages that came out. */
async function deliver(wire: Bytes[], link: Link): Promise<Bytes[]> {
  const messages: Bytes[] = [];
  for (const sealed of wire.splice(0)) {
    const message = await link.receive(sealed);
    if (message !== null) messages.push(message);
  }
  return messages;
}

test("fits a full piece in one sealed message, and one sealed message in what the relay passes on", () => {
  assert.ok(PIECE_BYTES <= MAX_PLAINTEXT_BYTES);
  assert.ok(MAX_MESSAGE_BYTES <= MAX_RELAY_MESSAGE_BYTES);
});

test("cuts a message into full pieces and one last piece, each saying whether more follow", () => {
  const cases: [length: number, sizes: number[], flags: number[]][] = [
    [0, [1], [0]],
    [1, [2], [0]],
    [PIECE_BYTES - 1, [PIECE_BYTES], [0]],
    [PIECE_BYTES, [PIECE_BYTES, 2], [1, 0]],
    [2 * (PIECE_BYTES - 1), [PIECE_BYTES, PIECE_BYTES], [1, 0]],
  ];
  for (const [length, sizes, flags] of cases) {
    const pieces = cutIntoPieces(sample(length));
    assert.deepEqual(
      pieces.map((piece) => piece.length),
      sizes,
      String(length),
    );
    assert.deepEqual(
      pieces.map((piece) => piece[0]),
      flags,
      String(length),
    );
  }
});

test("joins the pieces back into the message, and is then ready for the next one", () => {
  const joiner = new PieceJoiner();
  const message = sample(3 * PIECE_BYTES);
  const pieces = cutIntoPieces(message);
  assert.equal(pieces.length, 4);
  for (const piece of pieces.slice(0, -1)) assert.equal(joiner.add(piece), null);
  assert.deepEqual(joiner.add(pieces[pieces.length - 1]), message);
  assert.deepEqual(joiner.add(cutIntoPieces(sample(10))[0]), sample(10));
  assert.deepEqual(joiner.add(Uint8Array.of(0)), new Uint8Array(0));
});

test("refuses any piece that cutting a message would never make", () => {
  assert.throws(() => new PieceJoiner().add(new Uint8Array(0)), refused(/wrong size/));
  assert.throws(() => new PieceJoiner().add(new Uint8Array(PIECE_BYTES + 1)), refused(/wrong size/));
  assert.throws(() => new PieceJoiner().add(Uint8Array.of(2, 7)), refused(/whether more follow/));
  // More is to follow, but the piece is not full.
  assert.throws(() => new PieceJoiner().add(Uint8Array.of(1, 7)), refused(/wrong size/));
  const joiner = new PieceJoiner();
  joiner.add(fullPiece(1));
  assert.throws(() => joiner.add(Uint8Array.of(0)), refused(/empty piece/));
});

test("refuses a message that grows past the biggest a link takes", () => {
  const joiner = new PieceJoiner();
  const fits = Math.floor(MAX_LINK_MESSAGE_BYTES / (PIECE_BYTES - 1));
  for (let i = 0; i < fits; i++) assert.equal(joiner.add(fullPiece(1)), null);
  assert.throws(() => joiner.add(fullPiece(1)), refused(/too big/));
});

test("cuts a message of the biggest size a link takes, and refuses one byte more", () => {
  assert.throws(() => cutIntoPieces(new Uint8Array(MAX_LINK_MESSAGE_BYTES + 1)), refused(/too big to send/));
  const biggest = sample(MAX_LINK_MESSAGE_BYTES);
  const pieces = cutIntoPieces(biggest);
  assert.equal(pieces.length, Math.ceil(MAX_LINK_MESSAGE_BYTES / (PIECE_BYTES - 1)));
  const joiner = new PieceJoiner();
  let joined: Bytes | null = null;
  for (const piece of pieces) joined = joiner.add(piece);
  assert.deepEqual(joined, biggest);
});

test("sends messages of every size over a link, one after another or overlapping, and they arrive whole and in order", async () => {
  const { toComputer, toPhone, phone, computer } = await linkPair();
  const messages = [0, 5, PIECE_BYTES - 1, PIECE_BYTES, 100000].map((length) => sample(length));
  for (const message of messages) await phone.send(message);
  assert.deepEqual(await deliver(toComputer, computer), messages);
  await Promise.all(messages.map((message) => computer.send(message)));
  assert.deepEqual(await deliver(toPhone, phone), messages);
});

test("closes the link when a piece is lost on the way", async () => {
  const { toComputer, phone, computer } = await linkPair();
  await phone.send(sample(2 * PIECE_BYTES));
  assert.equal(toComputer.length, 3);
  const [first, , last] = toComputer;
  assert.equal(await computer.receive(first), null);
  await assert.rejects(computer.receive(last), NoiseError);
  await assert.rejects(computer.receive(first), refused(/closed/));
  await assert.rejects(computer.send(sample(1)), refused(/closed/));
});

test("refuses a message too big to send before anything goes out, and the link still works", async () => {
  const { toComputer, phone, computer } = await linkPair();
  await assert.rejects(phone.send(new Uint8Array(MAX_LINK_MESSAGE_BYTES + 1)), refused(/too big to send/));
  assert.equal(toComputer.length, 0);
  await phone.send(sample(5));
  assert.deepEqual(await deliver(toComputer, computer), [sample(5)]);
});

test("closes the link when the connection under it fails", async () => {
  const { phone } = await sessions();
  let calls = 0;
  const link = new Link(phone, () => {
    calls += 1;
    throw new Error("The connection dropped.");
  });
  await assert.rejects(link.send(sample(5)), /connection dropped/);
  await assert.rejects(link.send(sample(5)), refused(/closed/));
  assert.equal(calls, 1);
});
