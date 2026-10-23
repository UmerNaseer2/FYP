/**
 * Pairing a phone with the computer, and how each connection between them
 * opens (src/shared/remote/pairing.ts).
 */
import assert from "node:assert/strict";
import test from "node:test";

import { randomBytes, toBase64Url, utf8 } from "../shared/remote/bytes.js";
import { generateKeyPair, KEY_BYTES } from "../shared/remote/keys.js";
import { Initiator, Responder } from "../shared/remote/noise.js";
import {
  cleanDeviceName,
  MAX_DEVICE_NAME_LENGTH,
  PAIRING_SECRET_BYTES,
  PHONE_LINK_PROLOGUE,
  readOpening,
  readOpeningAnswer,
  readPairingLink,
  writeOpening,
  writeOpeningAnswer,
  writePairingLink,
  type OpeningAnswer,
  type OpeningRefusal,
  type PairingCode,
} from "../shared/remote/pairing.js";
import { DESKTOP_ID_BYTES } from "../shared/remote/relay-auth.js";

/** A computer's ID: any 16 bytes, written as relay-auth.ts writes them. */
const ID = toBase64Url(randomBytes(DESKTOP_ID_BYTES));

/** A pairing code for that computer, with a random key and secret. */
function someCode(): PairingCode {
  return { desktopId: ID, desktopKey: randomBytes(KEY_BYTES), secret: randomBytes(PAIRING_SECRET_BYTES) };
}

/** Sends a value as a message, the way the other side's JSON would arrive. */
function message(value: unknown): Uint8Array<ArrayBuffer> {
  return utf8(JSON.stringify(value));
}

test("writes a pairing link and reads it back the same", () => {
  const code = someCode();
  const link = writePairingLink("https://relay.example.com", code);
  assert.ok(link.startsWith(`https://relay.example.com/#pair=v1.${ID}.`), link);
  assert.deepEqual(readPairingLink(link), { relayOrigin: "https://relay.example.com", code });
  // A relay's address is written the one way a browser writes it.
  assert.equal(writePairingLink("https://Relay.Example.com:443/", code), link);
  // A relay on the same machine, and the spaces and line breaks that copying a link can add.
  const local = writePairingLink("http://localhost:8787", code);
  assert.deepEqual(readPairingLink(` \n${local}\t\n`), { relayOrigin: "http://localhost:8787", code });
});

test("refuses anything that is not exactly a pairing link", () => {
  const key = toBase64Url(randomBytes(KEY_BYTES));
  const secret = toBase64Url(randomBytes(PAIRING_SECRET_BYTES));
  const good = `https://relay.example.com/#pair=v1.${ID}.${key}.${secret}`;
  assert.notEqual(readPairingLink(good), null);
  for (const text of [
    "",
    "https://relay.example.com/",
    good.replace("#pair=v1.", "#pair=v2."),
    good.replace("#pair=", "#join="),
    `${good}.`,
    `${good}x`,
    `https://relay.example.com/#pair=v1.${ID}.${key}`,
    `https://relay.example.com/#pair=v1.${key}.${secret}`,
    // A relay that is not https, a path, no slash, and addresses not written as a browser writes them.
    `http://relay.example.com/#pair=v1.${ID}.${key}.${secret}`,
    `https://relay.example.com/phone/#pair=v1.${ID}.${key}.${secret}`,
    `https://relay.example.com#pair=v1.${ID}.${key}.${secret}`,
    `https://Relay.example.com/#pair=v1.${ID}.${key}.${secret}`,
    `https://relay.example.com:443/#pair=v1.${ID}.${key}.${secret}`,
    // Parts of the wrong size.
    `https://relay.example.com/#pair=v1.${ID.slice(1)}.${key}.${secret}`,
    `https://relay.example.com/#pair=v1.${ID}.${key.slice(1)}.${secret}`,
    `https://relay.example.com/#pair=v1.${ID}.${key}.${secret}A`,
    // Parts of the right size, but with bits set that base64url leaves unused.
    `https://relay.example.com/#pair=v1.${ID.slice(0, 21)}B.${key}.${secret}`,
    `https://relay.example.com/#pair=v1.${ID}.${key.slice(0, 42)}B.${secret}`,
    `https://relay.example.com/#pair=v1.${ID}.${key}.${secret.slice(0, 42)}B`,
  ]) {
    assert.equal(readPairingLink(text), null, text);
  }
});

test("reads a link of up to 1,024 characters, and no longer", () => {
  // A relay with a very long name, which is the only part of a link that can grow.
  const tail = `.example.com/#pair=v1.${ID}.${toBase64Url(randomBytes(KEY_BYTES))}.${toBase64Url(randomBytes(PAIRING_SECRET_BYTES))}`;
  const longest = `https://${"a".repeat(884)}${tail}`;
  assert.equal(longest.length, 1024);
  assert.notEqual(readPairingLink(longest), null);
  assert.equal(readPairingLink(`https://${"a".repeat(885)}${tail}`), null);
});

test("will not write a pairing link it could not read back", () => {
  const code = someCode();
  assert.throws(() => writePairingLink("http://relay.example.com", code), /not a relay's address/);
  assert.throws(() => writePairingLink("https://relay.example.com/phone", code), /not a relay's address/);
  assert.throws(() => writePairingLink("https://relay.example.com", { ...code, desktopId: ID.slice(1) }), /not a computer's ID/);
  assert.throws(() => writePairingLink("https://relay.example.com", { ...code, desktopKey: randomBytes(KEY_BYTES - 1) }), /key is the wrong size/);
  assert.throws(() => writePairingLink("https://relay.example.com", { ...code, secret: randomBytes(16) }), /secret is the wrong size/);
});

test("writes each opening and reads it back, with the phone's name cleaned", () => {
  const secret = randomBytes(PAIRING_SECRET_BYTES);
  assert.deepEqual(readOpening(writeOpening({ kind: "session" })), { kind: "session" });
  assert.deepEqual(readOpening(writeOpening({ kind: "pair", secret, name: "Pixel 9" })), { kind: "pair", secret, name: "Pixel 9" });
  assert.deepEqual(readOpening(writeOpening({ kind: "pair", secret, name: " Pixel\n\n9\u202e " })), { kind: "pair", secret, name: "Pixel 9" });
  assert.deepEqual(readOpening(writeOpening({ kind: "pair", secret, name: "" })), { kind: "pair", secret, name: "Phone" });
  assert.throws(() => writeOpening({ kind: "pair", secret: randomBytes(PAIRING_SECRET_BYTES - 1), name: "Pixel 9" }), /wrong size/);
  // The computer cleans the name again, whatever the phone app did.
  const raw = message({ v: 1, kind: "pair", secret: toBase64Url(secret), name: "\u0007Pixel\u00a0\u00a09" });
  assert.deepEqual(readOpening(raw), { kind: "pair", secret, name: "Pixel 9" });
});

test("refuses anything that is not exactly an opening", () => {
  const secret = toBase64Url(randomBytes(PAIRING_SECRET_BYTES));
  for (const value of [
    null,
    [],
    {},
    { v: 1 },
    { kind: "session" },
    { v: 2, kind: "session" },
    { v: "1", kind: "session" },
    { v: 1, kind: "session", x: 1 },
    { v: 1, kind: "hello" },
    { v: 1, kind: "pair", secret },
    { v: 1, kind: "pair", name: "Pixel 9" },
    { v: 1, kind: "pair", secret, name: "Pixel 9", x: 1 },
    { v: 1, kind: "pair", secret: secret.slice(1), name: "Pixel 9" },
    { v: 1, kind: "pair", secret: `${secret.slice(0, 42)}B`, name: "Pixel 9" },
    { v: 1, kind: "pair", secret, name: 9 },
    { v: 1, kind: "pair", secret, name: null },
    { v: 1, kind: "pair", secret, name: "a".repeat(257) },
  ]) {
    assert.equal(readOpening(message(value)), null, JSON.stringify(value));
  }
  assert.equal(readOpening(Uint8Array.of(0xff)), null);
  // The longest name it reads, which it then cuts.
  const longest = readOpening(message({ v: 1, kind: "pair", secret, name: "a".repeat(256) }));
  if (longest?.kind !== "pair") throw new Error("Expected the opening to be read.");
  assert.equal(longest.name, "a".repeat(MAX_DEVICE_NAME_LENGTH));
});

test("writes each answer to an opening and reads it back", () => {
  const answers: OpeningAnswer[] = [
    { ok: true, name: "build-box" },
    { ok: false, reason: "expired-code" },
    { ok: false, reason: "too-many-phones" },
    { ok: false, reason: "not-paired" },
  ];
  for (const answer of answers) {
    assert.deepEqual(readOpeningAnswer(writeOpeningAnswer(answer)), answer, JSON.stringify(answer));
  }
  assert.deepEqual(readOpeningAnswer(writeOpeningAnswer({ ok: true, name: " \u200b" })), { ok: true, name: "Computer" });
  // A reason the phone app does not know, which only a mistake in the computer's code could give.
  const unknown = JSON.parse('"busy"') as OpeningRefusal;
  assert.throws(() => writeOpeningAnswer({ ok: false, reason: unknown }), /not a reason/);
});

test("refuses anything that is not exactly an answer to an opening", () => {
  for (const value of [
    null,
    {},
    { ok: false, reason: "not-paired" },
    { v: 2, ok: false, reason: "not-paired" },
    { v: 1, ok: "true", name: "build-box" },
    { v: 1, ok: true },
    { v: 1, ok: true, name: 9 },
    { v: 1, ok: true, name: "a".repeat(257) },
    { v: 1, ok: true, name: "build-box", reason: "not-paired" },
    { v: 1, ok: false },
    { v: 1, ok: false, reason: "busy" },
    { v: 1, ok: false, reason: "not-paired", name: "build-box" },
  ]) {
    assert.equal(readOpeningAnswer(message(value)), null, JSON.stringify(value));
  }
});

test("cleans a device's name as the other side's screens show it", () => {
  const cases: [string, string][] = [
    ["Pixel 9", "Pixel 9"],
    ["  Pixel \t\r\n 9  ", "Pixel 9"],
    // Control characters, a zero-width space, and the characters that turn text right to left.
    ["Pix\u0000el\u0007 9", "Pixel 9"],
    ["Pixel\u200b 9", "Pixel 9"],
    ["\u202ePixel 9\u202c", "Pixel 9"],
    // Half of a broken emoji.
    ["Pixel \ud83d9", "Pixel 9"],
    // The joiner inside an emoji stays, so it still shows as one picture.
    ["Pixel \u{1f469}\u200d\u{1f4bb}", "Pixel \u{1f469}\u200d\u{1f4bb}"],
    // Cut to 64 characters, never through an emoji, and with no space left at the end.
    ["\u{1f600}".repeat(70), "\u{1f600}".repeat(MAX_DEVICE_NAME_LENGTH)],
    [`${"a".repeat(MAX_DEVICE_NAME_LENGTH - 1)} b`, "a".repeat(MAX_DEVICE_NAME_LENGTH - 1)],
  ];
  for (const [name, cleaned] of cases) {
    assert.equal(cleanDeviceName(name, "Phone"), cleaned, JSON.stringify(name));
  }
  // A name with nothing left to show.
  for (const name of ["", "   ", "\u200b\u202e", "\u200d", "\u200c\u200d "]) {
    assert.equal(cleanDeviceName(name, "Phone"), "Phone", JSON.stringify(name));
  }
});

test("pairs a phone through a whole handshake", async () => {
  const computerKey = await generateKeyPair("X25519", false);
  const phoneKey = await generateKeyPair("X25519", false);
  const shown = writePairingLink("https://relay.example.com", { desktopId: ID, desktopKey: computerKey.publicKey, secret: randomBytes(PAIRING_SECRET_BYTES) });

  // The phone reads the link, and knows the computer by the key in it.
  const link = readPairingLink(shown);
  if (link === null) throw new Error("Expected the link to be read.");
  const phone = new Initiator({ prologue: PHONE_LINK_PROLOGUE, staticKey: phoneKey, remoteStaticKey: link.code.desktopKey });
  const computer = new Responder({ prologue: PHONE_LINK_PROLOGUE, staticKey: computerKey });

  const first = await computer.readFirstMessage(await phone.writeFirstMessage(writeOpening({ kind: "pair", secret: link.code.secret, name: "Pixel 9" })));
  assert.deepEqual(readOpening(first.payload), { kind: "pair", secret: link.code.secret, name: "Pixel 9" });
  assert.deepEqual(first.remoteStaticKey, phoneKey.publicKey);
  const answer = await computer.writeAnswer(writeOpeningAnswer({ ok: true, name: "build-box" }));
  const opened = await phone.readAnswer(answer.message);
  assert.deepEqual(readOpeningAnswer(opened.payload), { ok: true, name: "build-box" });
  assert.deepEqual(opened.session.handshakeHash, answer.session.handshakeHash);
});
