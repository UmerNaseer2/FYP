/**
 * The phone link's encryption (src/shared/remote/noise.ts).
 *
 * The first test replays a published test vector for exactly this protocol,
 * Noise_IK_25519_AESGCM_SHA256, from the cacophony project
 * (github.com/haskell-cryptography/cacophony, vectors/cacophony.txt, released
 * into the public domain under the Unlicense). The vector fixes every key,
 * the throwaway ones too, so every message must match byte for byte: code
 * that only agrees with itself could pass every other test here and still
 * not be Noise. The other tests check what a vector cannot: that a message
 * changed, replayed, reordered or of the wrong size is refused, and that the
 * handshake's steps run once each, in order.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { readUtf8, utf8, type Bytes } from "../shared/remote/bytes.js";
import { generateKeyPair, importKeyPair, KEY_BYTES, type KeyPair } from "../shared/remote/keys.js";
import {
  Initiator,
  MAX_MESSAGE_BYTES,
  MAX_PLAINTEXT_BYTES,
  NoiseError,
  PROTOCOL_NAME,
  Responder,
  TAG_BYTES,
} from "../shared/remote/noise.js";

/**
 * The vector as published, in hex. Its messages take turns, the phone's
 * first, through the handshake and on after it. respStaticPublic is the
 * computer's public key, which the phone already knows (the vector's
 * init_remote_static).
 */
const VECTOR = {
  prologue: "4a6f686e2047616c74",
  initStatic: "e61ef9919cde45dd5f82166404bd08e38bceb5dfdfded0a34c8df7ed542214d1",
  initEphemeral: "893e28b9dc6ca8d611ab664754b8ceb7bac5117349a4439a6b0569da977c464a",
  respStatic: "4a3acbfdb163dec651dfa3194dece676d437029c62a408b4c5ea9114246e4893",
  respEphemeral: "bbdb4cdbd309f1a1f2e1456967fe288cadd6f712d65dc7b7793d5e63da6b375b",
  respStaticPublic: "31e0303fd6418d2f8c0e78b91f22e8caed0fbe48656dcf4767e4834f701b8f62",
  handshakeHash: "669c8640d9e42a3cda2f232f78597ceefb01daa6e3df81181ccce6fc6b5026bf",
  messages: [
    {
      payload: "4c756477696720766f6e204d69736573",
      ciphertext:
        "ca35def5ae56cec33dc2036731ab14896bc4c75dbb07a61f879f8e3afa4c79444e417bc55c7a8166c993356c1be41ef67818a292426f301556c7f26b21d25ddb097153891a9a956cff47b83e63ad8d701c1342c209cff1ca5ecd43402762ac249e3bd3a4c0a145fe07cb5dae28ea13a3",
    },
    {
      payload: "4d757272617920526f746862617264",
      ciphertext: "95ebc60d2b1fa672c1f46a8aa265ef51bfe38e7ccb39ec5be34069f144808843af2ccf9972e22afc67aeafcd25162f7f98c363b7762e3e4cb7d272e39f27a5",
    },
    { payload: "462e20412e20486179656b", ciphertext: "66acfc92e3197de166809e6d4d5d003dcc819a84bc3522ca53c9d9" },
    { payload: "4361726c204d656e676572", ciphertext: "71f89aa6533a6de70b0826864dd75f60806ee40170c16290189eb3" },
    { payload: "4a65616e2d426170746973746520536179", ciphertext: "4795a3423550c8bf00386bd496a3e2c76c10669d2a75ab8f79b5094c5412a25705" },
    { payload: "457567656e2042f6686d20766f6e2042617765726b", ciphertext: "aa0bb39097555c918e40be82abc2b909eb79d9eb87adb07e268fc37323a6cf904fd01fb391" },
  ],
};

const PROLOGUE = utf8("Schema Studio phone link test");
const EMPTY = new Uint8Array(0);

/**
 * What the handshake adds to its payloads. The first message carries the
 * phone's throwaway key, then its own key with a tag, then the payload's tag;
 * the answer carries the computer's throwaway key and the payload's tag.
 */
const FIRST_MESSAGE_OVERHEAD = KEY_BYTES + KEY_BYTES + TAG_BYTES + TAG_BYTES;
const ANSWER_OVERHEAD = KEY_BYTES + TAG_BYTES;

function hex(text: string): Bytes {
  return new Uint8Array(Buffer.from(text, "hex"));
}

function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

/** Bytes that differ from place to place, of any length (Web Crypto's random bytes stop at 64 KiB). */
function sample(length: number): Bytes {
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i++) bytes[i] = i % 251;
  return bytes;
}

/** A copy of the message with one bit changed, counting from its end when the index is below 0. */
function flipped(message: Bytes, index: number): Bytes {
  const copy = message.slice();
  copy[index < 0 ? copy.length + index : index] ^= 1;
  return copy;
}

/** Both sides of a handshake between these keys, before either has said anything. */
function between(phoneKey: KeyPair, computerKey: KeyPair) {
  return {
    phone: new Initiator({ prologue: PROLOGUE, staticKey: phoneKey, remoteStaticKey: computerKey.publicKey }),
    computer: new Responder({ prologue: PROLOGUE, staticKey: computerKey }),
  };
}

/** The same, between fresh keys. */
async function sides() {
  const phoneKey = await generateKeyPair("X25519", false);
  return { phoneKey, ...between(phoneKey, await generateKeyPair("X25519", false)) };
}

/** Takes a handshake through both steps with empty payloads, and gives each side's session. */
async function finish({ phone, computer }: { phone: Initiator; computer: Responder }) {
  await computer.readFirstMessage(await phone.writeFirstMessage(EMPTY));
  const answer = await computer.writeAnswer(EMPTY);
  return { phone: (await phone.readAnswer(answer.message)).session, computer: answer.session };
}

/** An open link between fresh keys. */
async function pair() {
  return finish(await sides());
}

test("matches the published test vector byte for byte", async () => {
  assert.equal(PROTOCOL_NAME, "Noise_IK_25519_AESGCM_SHA256");
  const prologue = hex(VECTOR.prologue);
  const phoneKey = await importKeyPair("X25519", hex(VECTOR.initStatic));
  const phone = new Initiator({
    prologue,
    staticKey: phoneKey,
    remoteStaticKey: hex(VECTOR.respStaticPublic),
    ephemeralKeyForTests: await importKeyPair("X25519", hex(VECTOR.initEphemeral)),
  });
  const computer = new Responder({
    prologue,
    staticKey: await importKeyPair("X25519", hex(VECTOR.respStatic)),
    ephemeralKeyForTests: await importKeyPair("X25519", hex(VECTOR.respEphemeral)),
  });
  const [first, answer, ...after] = VECTOR.messages;

  const firstMessage = await phone.writeFirstMessage(hex(first.payload));
  assert.equal(toHex(firstMessage), first.ciphertext);
  const read = await computer.readFirstMessage(firstMessage);
  assert.equal(toHex(read.payload), first.payload);
  assert.deepEqual(read.remoteStaticKey, phoneKey.publicKey);

  const written = await computer.writeAnswer(hex(answer.payload));
  assert.equal(toHex(written.message), answer.ciphertext);
  const opened = await phone.readAnswer(written.message);
  assert.equal(toHex(opened.payload), answer.payload);
  assert.equal(toHex(opened.session.handshakeHash), VECTOR.handshakeHash);
  assert.equal(toHex(written.session.handshakeHash), VECTOR.handshakeHash);

  for (const [i, message] of after.entries()) {
    const [sender, receiver] = i % 2 === 0 ? [opened.session, written.session] : [written.session, opened.session];
    const sealed = await sender.seal(hex(message.payload));
    assert.equal(toHex(sealed), message.ciphertext, `message ${i + 2}`);
    assert.equal(toHex(await receiver.open(sealed)), message.payload, `message ${i + 2}`);
  }
});

test("opens a link between fresh keys, carrying both payloads and the phone's key", async () => {
  const { phoneKey, phone, computer } = await sides();
  const read = await computer.readFirstMessage(await phone.writeFirstMessage(utf8("pair me")));
  assert.equal(readUtf8(read.payload), "pair me");
  assert.deepEqual(read.remoteStaticKey, phoneKey.publicKey);
  const answer = await computer.writeAnswer(utf8("paired"));
  const opened = await phone.readAnswer(answer.message);
  assert.equal(readUtf8(opened.payload), "paired");
  assert.deepEqual(opened.session.handshakeHash, answer.session.handshakeHash);
  assert.equal(readUtf8(await answer.session.open(await opened.session.seal(utf8("to the computer")))), "to the computer");
  assert.equal(readUtf8(await opened.session.open(await answer.session.seal(utf8("to the phone")))), "to the phone");
});

test("makes new keys for every handshake, even between the same two keys", async () => {
  const phoneKey = await generateKeyPair("X25519", false);
  const computerKey = await generateKeyPair("X25519", false);
  const first = await finish(between(phoneKey, computerKey));
  const second = await finish(between(phoneKey, computerKey));
  assert.notDeepEqual(first.phone.handshakeHash, second.phone.handshakeHash);
  await assert.rejects(second.computer.open(await first.phone.seal(utf8("hello"))), NoiseError);
});

test("fails when the phone has the wrong key for the computer", async () => {
  const { phone } = await sides();
  const { computer } = await sides();
  await assert.rejects(computer.readFirstMessage(await phone.writeFirstMessage(EMPTY)), NoiseError);
});

test("fails when the two sides start from different prologues", async () => {
  const computerKey = await generateKeyPair("X25519", false);
  const phone = new Initiator({
    prologue: utf8("Schema Studio phone link 0"),
    staticKey: await generateKeyPair("X25519", false),
    remoteStaticKey: computerKey.publicKey,
  });
  const computer = new Responder({ prologue: PROLOGUE, staticKey: computerKey });
  await assert.rejects(computer.readFirstMessage(await phone.writeFirstMessage(EMPTY)), NoiseError);
});

test("refuses a first message with any part changed", async () => {
  // The phone's throwaway key, its own encrypted key, and the payload's tag.
  for (const index of [0, 40, -1]) {
    const { phone, computer } = await sides();
    const message = await phone.writeFirstMessage(utf8("pair me"));
    await assert.rejects(computer.readFirstMessage(flipped(message, index)), NoiseError, String(index));
  }
});

test("refuses an answer with any part changed", async () => {
  // The computer's throwaway key, and the payload's tag.
  for (const index of [0, -1]) {
    const { phone, computer } = await sides();
    await computer.readFirstMessage(await phone.writeFirstMessage(EMPTY));
    const { message } = await computer.writeAnswer(utf8("paired"));
    await assert.rejects(phone.readAnswer(flipped(message, index)), NoiseError, String(index));
  }
});

test("refuses a changed message, and every message after it", async () => {
  const { phone, computer } = await pair();
  const changed = flipped(await phone.seal(utf8("first")), 0);
  const next = await phone.seal(utf8("second"));
  await assert.rejects(computer.open(changed), NoiseError);
  await assert.rejects(computer.open(next), /closed after a message failed/);
});

test("refuses a message that arrives a second time", async () => {
  const { phone, computer } = await pair();
  const sealed = await phone.seal(utf8("once"));
  assert.equal(readUtf8(await computer.open(sealed)), "once");
  await assert.rejects(computer.open(sealed), NoiseError);
});

test("refuses a message that arrives before the one sent ahead of it", async () => {
  const { phone, computer } = await pair();
  await phone.seal(utf8("first"));
  const second = await phone.seal(utf8("second"));
  await assert.rejects(computer.open(second), NoiseError);
});

test("seals and opens overlapping messages in the order of the calls", async () => {
  const { phone, computer } = await pair();
  const words = ["one", "two", "three", "four"];
  const sealed = await Promise.all(words.map((word) => phone.seal(utf8(word))));
  const opened = await Promise.all(sealed.map((message) => computer.open(message)));
  assert.deepEqual(
    opened.map((bytes) => readUtf8(bytes)),
    words,
  );
});

test("seals a message as big as Noise allows, and refuses a bigger one without breaking the link", async () => {
  const { phone, computer } = await pair();
  await assert.rejects(phone.seal(new Uint8Array(MAX_PLAINTEXT_BYTES + 1)), /too big to seal/);
  const biggest = sample(MAX_PLAINTEXT_BYTES);
  const sealed = await phone.seal(biggest);
  assert.equal(sealed.length, MAX_MESSAGE_BYTES);
  // It opens, so the refused message did not use up a counter.
  assert.deepEqual(await computer.open(sealed), biggest);
});

test("carries handshake payloads as big as one message holds, and refuses bigger ones", async () => {
  const { phone, computer } = await sides();
  const first = await phone.writeFirstMessage(new Uint8Array(MAX_MESSAGE_BYTES - FIRST_MESSAGE_OVERHEAD));
  assert.equal(first.length, MAX_MESSAGE_BYTES);
  await computer.readFirstMessage(first);
  const answer = await computer.writeAnswer(new Uint8Array(MAX_MESSAGE_BYTES - ANSWER_OVERHEAD));
  assert.equal(answer.message.length, MAX_MESSAGE_BYTES);
  await phone.readAnswer(answer.message);

  const tooBig = await sides();
  await assert.rejects(tooBig.phone.writeFirstMessage(new Uint8Array(MAX_MESSAGE_BYTES - FIRST_MESSAGE_OVERHEAD + 1)), /payload is too big/);
  const answering = await sides();
  await answering.computer.readFirstMessage(await answering.phone.writeFirstMessage(EMPTY));
  await assert.rejects(answering.computer.writeAnswer(new Uint8Array(MAX_MESSAGE_BYTES - ANSWER_OVERHEAD + 1)), /payload is too big/);
});

test("refuses a first message of a size the phone never sends", async () => {
  for (const length of [FIRST_MESSAGE_OVERHEAD - 1, MAX_MESSAGE_BYTES + 1]) {
    const { computer } = await sides();
    await assert.rejects(computer.readFirstMessage(new Uint8Array(length)), /wrong size/, String(length));
  }
});

test("refuses an answer too short to be one", async () => {
  const { phone } = await sides();
  await phone.writeFirstMessage(EMPTY);
  await assert.rejects(phone.readAnswer(new Uint8Array(ANSWER_OVERHEAD - 1)), /wrong size/);
});

test("refuses a message too short to have been sealed, and closes the link", async () => {
  const { phone, computer } = await pair();
  await assert.rejects(computer.open(new Uint8Array(TAG_BYTES - 1)), /wrong size/);
  await assert.rejects(computer.open(await phone.seal(utf8("after"))), /closed after a message failed/);
});

test("refuses a first message whose key would agree on no secret at all", async () => {
  // All zeros: the phone's throwaway key is then a point that gives the same
  // secret, zero, whatever key the computer has.
  const { computer } = await sides();
  await assert.rejects(computer.readFirstMessage(new Uint8Array(FIRST_MESSAGE_OVERHEAD)), /cannot be used/);
});

test("refuses each step of the handshake out of order, and the handshake still finishes", async () => {
  const { phone, computer } = await sides();
  await assert.rejects(phone.readAnswer(new Uint8Array(ANSWER_OVERHEAD)), /out of order/);
  await assert.rejects(computer.writeAnswer(EMPTY), /out of order/);
  const first = await phone.writeFirstMessage(EMPTY);
  await assert.rejects(phone.writeFirstMessage(EMPTY), /out of order/);
  await computer.readFirstMessage(first);
  await assert.rejects(computer.readFirstMessage(first), /out of order/);
  const answer = await computer.writeAnswer(EMPTY);
  const opened = await phone.readAnswer(answer.message);
  assert.deepEqual(opened.session.handshakeHash, answer.session.handshakeHash);
  // Both sides are done now, so neither step may run again.
  await assert.rejects(phone.readAnswer(answer.message), /out of order/);
  await assert.rejects(computer.writeAnswer(EMPTY), /out of order/);
});

test("refuses a step while another is still running", async () => {
  const { phone } = await sides();
  const first = phone.writeFirstMessage(EMPTY);
  await assert.rejects(phone.writeFirstMessage(EMPTY), /out of order/);
  assert.equal((await first).length, FIRST_MESSAGE_OVERHEAD);
});

test("refuses every step after one has failed", async () => {
  const { phone, computer } = await sides();
  await assert.rejects(computer.readFirstMessage(new Uint8Array(FIRST_MESSAGE_OVERHEAD - 1)), /wrong size/);
  await assert.rejects(computer.readFirstMessage(await phone.writeFirstMessage(EMPTY)), /already failed/);
  await assert.rejects(computer.writeAnswer(EMPTY), /already failed/);
});
