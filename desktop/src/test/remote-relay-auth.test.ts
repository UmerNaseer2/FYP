/**
 * How the computer proves to the relay that its room there is its own
 * (src/shared/remote/relay-auth.ts).
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { randomBytes } from "../shared/remote/bytes.js";
import { generateKeyPair } from "../shared/remote/keys.js";
import { checkChallenge, desktopIdFor, isDesktopId, signChallenge } from "../shared/remote/relay-auth.js";

/** A computer's signing key and its ID. */
async function computer() {
  const key = await generateKeyPair("Ed25519", false);
  return { key, id: await desktopIdFor(key.publicKey) };
}

test("works out a computer's ID from the start of its signing key's SHA-256 hash", async () => {
  const { key, id } = await computer();
  assert.equal(id.length, 22);
  assert.equal(id, createHash("sha256").update(key.publicKey).digest().subarray(0, 16).toString("base64url"));
  assert.equal(isDesktopId(id), true);
});

test("refuses an ID written any other way", async () => {
  const { id } = await computer();
  for (const text of [id.slice(1), id + "A", id.slice(0, 21) + "B", id.slice(0, 21) + "+", "", 22, null, undefined]) {
    assert.equal(isDesktopId(text), false, String(text));
  }
});

test("signs the relay's challenge so the relay can tell it came from the room's own computer", async () => {
  const { key, id } = await computer();
  const challenge = randomBytes(32);
  const signature = await signChallenge(key, challenge);
  assert.equal(signature.length, 64);
  assert.equal(await checkChallenge(id, challenge, key.publicKey, signature), true);
});

test("refuses a signature for another challenge, another room or another key", async () => {
  const { key, id } = await computer();
  const other = await computer();
  const challenge = randomBytes(32);
  const signature = await signChallenge(key, challenge);

  // The signature, but over a different challenge.
  assert.equal(await checkChallenge(id, randomBytes(32), key.publicKey, signature), false);
  // The signature with one bit changed.
  const changed = signature.slice();
  changed[0] ^= 1;
  assert.equal(await checkChallenge(id, challenge, key.publicKey, changed), false);
  // Another computer signing in properly, but at this computer's room.
  assert.equal(await checkChallenge(id, challenge, other.key.publicKey, await signChallenge(other.key, challenge)), false);
  // This computer's signature, offered at another computer's room.
  assert.equal(await checkChallenge(other.id, challenge, key.publicKey, signature), false);
  // Another computer's room and key, with this computer's signature.
  assert.equal(await checkChallenge(other.id, challenge, other.key.publicKey, signature), false);
  // The key's signature over the challenge alone, as it might sign for some other purpose.
  const bare = new Uint8Array(await crypto.subtle.sign("Ed25519", key.privateKey, challenge));
  assert.equal(await checkChallenge(id, challenge, key.publicKey, bare), false);
});

test("refuses a challenge, key or signature of the wrong length", async () => {
  const { key, id } = await computer();
  const challenge = randomBytes(32);
  const signature = await signChallenge(key, challenge);
  assert.equal(await checkChallenge(id, challenge.subarray(1), key.publicKey, signature), false);
  assert.equal(await checkChallenge(id, challenge, key.publicKey.subarray(1), signature), false);
  assert.equal(await checkChallenge(id, challenge, key.publicKey, signature.subarray(1)), false);
  await assert.rejects(signChallenge(key, randomBytes(31)), /must be 32 bytes/);
});

test("gives false, rather than failing, for bytes that are no real public key", async () => {
  const publicKey = new Uint8Array(32).fill(0xff);
  assert.equal(await checkChallenge(await desktopIdFor(publicKey), randomBytes(32), publicKey, randomBytes(64)), false);
});
