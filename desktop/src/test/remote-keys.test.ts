/**
 * Making the phone link's keys and reading them back
 * (src/shared/remote/keys.ts).
 *
 * Two published values tie the keys to what other implementations agree on,
 * not only to this code's own output: an X25519 key from the cacophony Noise
 * test vectors (see remote-noise.test.ts), and the Ed25519 key and signature
 * of RFC 8032, section 7.1, TEST 1.
 */
import assert from "node:assert/strict";
import test from "node:test";

import type { Bytes } from "../shared/remote/bytes.js";
import { exportPrivateKey, generateKeyPair, importKeyPair, KEY_BYTES, type KeyKind } from "../shared/remote/keys.js";

function hex(text: string): Bytes {
  return new Uint8Array(Buffer.from(text, "hex"));
}

function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

const KINDS: KeyKind[] = ["X25519", "Ed25519"];

for (const kind of KINDS) {
  test(`makes an ${kind} key pair whose private key reads back in as the same pair, and not extractable`, async () => {
    const pair = await generateKeyPair(kind, true);
    assert.equal(pair.publicKey.length, KEY_BYTES);
    const privateKey = await exportPrivateKey(pair.privateKey);
    assert.equal(privateKey.length, KEY_BYTES);
    const imported = await importKeyPair(kind, privateKey);
    assert.deepEqual(imported.publicKey, pair.publicKey);
    assert.equal(imported.privateKey.type, "private");
    assert.equal(imported.privateKey.algorithm.name, kind);
    assert.equal(imported.privateKey.extractable, false);
    await assert.rejects(exportPrivateKey(imported.privateKey));
  });

  test(`reads an ${kind} private key in as extractable when asked to`, async () => {
    const privateKey = await exportPrivateKey((await generateKeyPair(kind, true)).privateKey);
    const imported = await importKeyPair(kind, privateKey, true);
    assert.equal(imported.privateKey.extractable, true);
    assert.deepEqual(await exportPrivateKey(imported.privateKey), privateKey);
  });

  test(`never gives out the bytes of an ${kind} key made not extractable`, async () => {
    const pair = await generateKeyPair(kind, false);
    assert.equal(pair.privateKey.extractable, false);
    assert.equal(pair.publicKey.length, KEY_BYTES);
    await assert.rejects(exportPrivateKey(pair.privateKey));
  });

  test(`refuses an ${kind} private key that is not 32 bytes`, async () => {
    for (const length of [31, 33]) {
      await assert.rejects(importKeyPair(kind, new Uint8Array(length)), /must be 32 bytes/, String(length));
    }
  });
}

test("works out the public key of the published X25519 test key", async () => {
  // The computer's key in the cacophony vector that remote-noise.test.ts replays.
  const pair = await importKeyPair("X25519", hex("4a3acbfdb163dec651dfa3194dece676d437029c62a408b4c5ea9114246e4893"));
  assert.equal(toHex(pair.publicKey), "31e0303fd6418d2f8c0e78b91f22e8caed0fbe48656dcf4767e4834f701b8f62");
});

test("gives the public key and the signature RFC 8032 publishes for its first Ed25519 test", async () => {
  // RFC 8032, section 7.1, TEST 1, which signs an empty message.
  const pair = await importKeyPair("Ed25519", hex("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60"));
  assert.equal(toHex(pair.publicKey), "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a");
  const signature = new Uint8Array(await crypto.subtle.sign("Ed25519", pair.privateKey, new Uint8Array(0)));
  assert.equal(
    toHex(signature),
    "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b",
  );
});
