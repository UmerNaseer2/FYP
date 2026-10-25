/**
 * The phone's record of the computer it is paired with (src/phone/store.ts):
 * a record the app saved reads back as it was, and one with any part
 * missing, damaged or of the wrong kind reads as no record, so the app asks
 * to pair again.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { readPairedComputer, type PairedComputer } from "../phone/store.js";
import { randomBytes, toBase64Url } from "../shared/remote/bytes.js";
import { generateKeyPair, KEY_BYTES } from "../shared/remote/keys.js";
import { DESKTOP_ID_BYTES } from "../shared/remote/relay-auth.js";

/** A record as the app saves one, with a new key pair for the phone. */
async function savedRecord(): Promise<PairedComputer> {
  return {
    version: 1,
    relayOrigin: "https://relay.example.com",
    desktopId: toBase64Url(randomBytes(DESKTOP_ID_BYTES)),
    desktopKey: randomBytes(KEY_BYTES),
    computerName: "build-box",
    phoneName: "iPhone",
    pairedAt: Date.UTC(2026, 9, 23, 9, 30),
    phoneKey: await generateKeyPair("X25519", false),
  };
}

/** Whether the record reads back once `changes` are made to it. */
async function readsWith(changes: Record<string, unknown>): Promise<boolean> {
  return readPairedComputer({ ...(await savedRecord()), ...changes }) !== null;
}

/** Whether the record reads back once `changes` are made to the phone's key pair. */
async function readsWithKey(changes: Record<string, unknown>): Promise<boolean> {
  const record = await savedRecord();
  return readPairedComputer({ ...record, phoneKey: { ...record.phoneKey, ...changes } }) !== null;
}

test("reads back a record the app saved, as a copy with every part as it was", async () => {
  const saved = await savedRecord();
  const read = readPairedComputer(saved);
  assert.ok(read !== null, "The record the app saved did not read back.");
  assert.notEqual(read, saved);
  assert.notEqual(read.phoneKey, saved.phoneKey);
  assert.equal(read.version, 1);
  assert.equal(read.relayOrigin, saved.relayOrigin);
  assert.equal(read.desktopId, saved.desktopId);
  assert.equal(read.desktopKey, saved.desktopKey);
  assert.equal(read.computerName, saved.computerName);
  assert.equal(read.phoneName, saved.phoneName);
  assert.equal(read.pairedAt, saved.pairedAt);
  assert.equal(read.phoneKey.privateKey, saved.phoneKey.privateKey);
  assert.equal(read.phoneKey.publicKey, saved.phoneKey.publicKey);
});

test("leaves out anything else stored with the record", async () => {
  const read = readPairedComputer({ ...(await savedRecord()), note: "kept by a later version" });
  assert.ok(read !== null, "The record did not read back.");
  assert.equal(Object.hasOwn(read, "note"), false);
});

test("reads a record for a relay on this machine, which `npm run dev` serves over plain http", async () => {
  assert.equal(await readsWith({ relayOrigin: "http://localhost:8787" }), true);
  assert.equal(await readsWith({ relayOrigin: "http://127.0.0.1:8787" }), true);
});

test("reads no record from nothing, or from something that is not a record", () => {
  for (const value of [undefined, null, "build-box", 1, true, []]) {
    assert.equal(readPairedComputer(value), null, `${JSON.stringify(value)} read as a record.`);
  }
});

test("reads no record that a later version of the app wrote", async () => {
  assert.equal(await readsWith({ version: 2 }), false);
  assert.equal(await readsWith({ version: "1" }), false);
  assert.equal(await readsWith({ version: undefined }), false);
});

test("reads no record whose relay address is not one this app could have been opened from", async () => {
  const origins = [
    "http://relay.example.com",
    "https://relay.example.com/",
    "https://relay.example.com/app",
    "https://relay.example.com?room=1",
    "https://someone@relay.example.com",
    "HTTPS://RELAY.EXAMPLE.COM",
    "relay.example.com",
    "",
    42,
  ];
  for (const relayOrigin of origins) assert.equal(await readsWith({ relayOrigin }), false, `${String(relayOrigin)} was taken for a relay.`);
});

test("reads no record whose computer ID is damaged", async () => {
  for (const desktopId of ["", "short", toBase64Url(randomBytes(DESKTOP_ID_BYTES - 1)), `${toBase64Url(randomBytes(DESKTOP_ID_BYTES))}=`, 42]) {
    assert.equal(await readsWith({ desktopId }), false, `${String(desktopId)} was taken for a computer's ID.`);
  }
});

test("reads no record whose copy of the computer's key is the wrong size or kind", async () => {
  assert.equal(await readsWith({ desktopKey: randomBytes(KEY_BYTES - 1) }), false);
  assert.equal(await readsWith({ desktopKey: randomBytes(KEY_BYTES + 1) }), false);
  assert.equal(await readsWith({ desktopKey: Array.from(randomBytes(KEY_BYTES)) }), false);
  assert.equal(await readsWith({ desktopKey: new Uint16Array(KEY_BYTES) }), false);
  assert.equal(await readsWith({ desktopKey: new Uint8Array(new SharedArrayBuffer(KEY_BYTES)) }), false);
  assert.equal(await readsWith({ desktopKey: toBase64Url(randomBytes(KEY_BYTES)) }), false);
});

test("reads no record with a name that is empty or not as the app cleans names", async () => {
  const names = [
    "",
    " build-box",
    "build-box ",
    "build  box",
    "build\nbox",
    // A zero-width space, which shows nothing.
    `build${String.fromCharCode(0x200b)}box`,
    // A mark that turns the text after it right to left.
    `${String.fromCharCode(0x202e)}build-box`,
    "x".repeat(65),
    42,
    null,
  ];
  for (const name of names) {
    assert.equal(await readsWith({ computerName: name }), false, `${JSON.stringify(name)} was taken for a computer's name.`);
    assert.equal(await readsWith({ phoneName: name }), false, `${JSON.stringify(name)} was taken for a phone's name.`);
  }
});

test("reads a record with names as long as the app keeps, counted in characters", async () => {
  // 64 characters, the last of them an emoji, which JavaScript counts as 2.
  const longest = `${"x".repeat(63)}\u{1F4F1}`;
  assert.equal(await readsWith({ computerName: longest, phoneName: longest }), true);
  assert.equal(await readsWith({ computerName: "Ops laptop (3rd floor)", phoneName: "Sam's phone" }), true);
});

test("reads no record without a time it was paired", async () => {
  for (const pairedAt of [Number.NaN, Number.POSITIVE_INFINITY, "2026-10-23", null, undefined]) {
    assert.equal(await readsWith({ pairedAt }), false, `${String(pairedAt)} was taken for a time.`);
  }
});

test("reads no record without the phone's own key pair", async () => {
  assert.equal(await readsWith({ phoneKey: undefined }), false);
  assert.equal(await readsWith({ phoneKey: null }), false);
  assert.equal(await readsWith({ phoneKey: "key" }), false);
  assert.equal(await readsWithKey({ privateKey: undefined }), false);
  assert.equal(await readsWithKey({ publicKey: undefined }), false);
  assert.equal(await readsWithKey({ publicKey: randomBytes(KEY_BYTES - 1) }), false);
});

test("reads no record whose private key is not a private X25519 key that can make shared secrets", async () => {
  const pair = await generateKeyPair("X25519", false);
  const publicKey = await crypto.subtle.importKey("raw", pair.publicKey, { name: "X25519" }, true, []);
  const signingKey = (await generateKeyPair("Ed25519", false)).privateKey;
  // Named alone, as src/shared/remote/keys.ts explains, to get a key pair.
  const pairForOtherUses = await crypto.subtle.generateKey("X25519", false, ["deriveKey"]);
  if (!("privateKey" in pairForOtherUses)) throw new Error("Web Crypto did not make an X25519 key pair.");
  // A key that can make shared secrets too, but on another curve.
  const { privateKey: otherCurveKey } = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  for (const privateKey of [publicKey, signingKey, pairForOtherUses.privateKey, otherCurveKey, randomBytes(KEY_BYTES)]) {
    assert.equal(await readsWithKey({ privateKey }), false);
  }
});
