/**
 * A phone's browser for the push tests: the keys it makes when it subscribes,
 * and reading a message the way it does. Not a test file itself, so
 * `npm test` runs only the tests that use it.
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";

import type { PushSubscriptionFields } from "../core/web-push";

export type Phone = { privateKey: Buffer; p256dh: Buffer; auth: Buffer };

/** A phone's keys, as its browser makes them when it subscribes. */
export function newPhone(): Phone {
  const ecdh = crypto.createECDH("prime256v1");
  const p256dh = ecdh.generateKeys();
  return { privateKey: ecdh.getPrivateKey(), p256dh, auth: crypto.randomBytes(16) };
}

/** What the phone app sends to turn drift alerts on: the endpoint, and the phone's two keys as base64url. */
export function subscriptionOf(phone: Phone, endpoint: string): PushSubscriptionFields {
  return { endpoint, p256dh: phone.p256dh.toString("base64url"), auth: phone.auth.toString("base64url") };
}

function label(text: string): Buffer {
  return Buffer.concat([Buffer.from(text, "utf8"), Buffer.from([0])]);
}

/** The keys a phone's browser works out for a message (RFC 8291, section 3.4, and RFC 8188, section 2.2). */
export function messageKeys(shared: Buffer, phone: Phone, senderPublic: Buffer, salt: Buffer): { ikm: Buffer; cek: Buffer; nonce: Buffer } {
  const keyInfo = Buffer.concat([label("WebPush: info"), phone.p256dh, senderPublic]);
  const ikm = Buffer.from(crypto.hkdfSync("sha256", shared, phone.auth, keyInfo, 32));
  return {
    ikm,
    cek: Buffer.from(crypto.hkdfSync("sha256", ikm, salt, label("Content-Encoding: aes128gcm"), 16)),
    nonce: Buffer.from(crypto.hkdfSync("sha256", ikm, salt, label("Content-Encoding: nonce"), 12)),
  };
}

/**
 * Reads a message the way the phone's browser does, with the phone's private
 * key, so the tests see what the phone would. It throws when the message was
 * not encrypted for this phone.
 */
export function decrypt(body: Buffer, phone: Phone): Buffer {
  const salt = body.subarray(0, 16);
  const recordSize = body.readUInt32BE(16);
  const idLength = body.readUInt8(20);
  const senderPublic = body.subarray(21, 21 + idLength);
  const record = body.subarray(21 + idLength);
  assert.ok(record.length <= recordSize, "the record fits its record size");
  const ecdh = crypto.createECDH("prime256v1");
  ecdh.setPrivateKey(phone.privateKey);
  const { cek, nonce } = messageKeys(ecdh.computeSecret(senderPublic), phone, senderPublic, salt);
  const decipher = crypto.createDecipheriv("aes-128-gcm", cek, nonce);
  decipher.setAuthTag(record.subarray(record.length - 16));
  const padded = Buffer.concat([decipher.update(record.subarray(0, record.length - 16)), decipher.final()]);
  // The last record ends with a 2, then any number of zeros.
  let end = padded.length - 1;
  while (end > 0 && padded[end] === 0) end--;
  assert.equal(padded[end], 2, "the message ends with the last-record mark");
  return padded.subarray(0, end);
}
