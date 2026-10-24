/**
 * Sending drift alerts through a phone browser's push service
 * (src/core/web-push.ts): the encryption, checked byte for byte against the
 * worked example in RFC 8291 (appendix A), the push key, the VAPID signature,
 * the checks on what a phone sends, and what a push service's answers mean.
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import {
  MAX_PUSH_ENDPOINT_LENGTH,
  MAX_PUSH_PAYLOAD_BYTES,
  PUSH_KEY_BYTES,
  encryptPushMessage,
  isPushKey,
  newPushKey,
  pushOutcome,
  pushRequest,
  pushSubject,
  readPushEndpoint,
  readPushKey,
  readPushSubscription,
  vapidAuthorization,
  type PushKey,
} from "../core/web-push";
import { decrypt, messageKeys, newPhone, subscriptionOf, type Phone } from "./push-phone";

/**
 * The worked example in RFC 8291, appendix A, as base64url: a computer (the
 * "application server", as) sends a message to a browser (the "user agent", ua).
 */
const RFC = {
  plaintext: "V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24",
  asPublic: "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  uaPublic: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  uaPrivate: "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  auth: "BTBZMqHH6r4Tts7J_aSIgg",
  ecdhSecret: "kyrL1jIIOHEzg3sM2ZWRHDRB62YACZhhSlknJ672kSs",
  ikm: "S4lYMb_L0FxCeq0WhDx813KgSYqU26kOyzWUdsXYyrg",
  cek: "oIhVW04MRdy2XN9CiKLxTg",
  nonce: "4h_95klXJ5E_qnoN",
  header: "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  body:
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
};

/** The number of points on the P-256 curve; a private key must be less. */
const ORDER = "ffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551";

const ENDPOINT = "https://fcm.googleapis.com/fcm/send/dGVzdA";
const NOW = Date.UTC(2026, 9, 24, 12, 0, 0);

function raw(base64Url: string): Buffer {
  return Buffer.from(base64Url, "base64url");
}

function keyText(hex: string): string {
  return Buffer.from(hex, "hex").toString("base64url");
}

const RFC_PHONE: Phone = { privateKey: raw(RFC.uaPrivate), p256dh: raw(RFC.uaPublic), auth: raw(RFC.auth) };

/** 4, then two coordinates that are not a point on the curve. */
function offCurve(): Buffer {
  return Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 1)]);
}

function publicKeyOf(point: Buffer): crypto.KeyObject {
  return crypto.createPublicKey({
    key: { kty: "EC", crv: "P-256", x: point.subarray(1, 33).toString("base64url"), y: point.subarray(33).toString("base64url") },
    format: "jwk",
  });
}

function rfcPushKey(): PushKey {
  const key = readPushKey(RFC.asPrivate);
  assert.ok(key);
  return key;
}

/** The parts of a VAPID Authorization header: the token's three parts and the public key. */
function vapidParts(header: string): { head: string; claims: string; signature: string; key: string } {
  const match = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(header);
  assert.ok(match, "a VAPID Authorization header");
  const [, head, claims, signature, key] = match;
  return { head, claims, signature, key };
}

function decodeJson(part: string): unknown {
  return JSON.parse(raw(part).toString("utf8"));
}

test("encrypts the RFC 8291 example byte for byte", () => {
  const body = encryptPushMessage(raw(RFC.plaintext), RFC_PHONE, { salt: raw(RFC.salt), senderKey: raw(RFC.asPrivate) });
  assert.equal(body.subarray(0, 86).toString("base64url"), RFC.header);
  assert.equal(body.toString("base64url"), RFC.body);
});

test("reads messages in these tests as a browser does, by the RFC's own numbers", () => {
  const ecdh = crypto.createECDH("prime256v1");
  ecdh.setPrivateKey(RFC_PHONE.privateKey);
  assert.equal(ecdh.getPublicKey().toString("base64url"), RFC.uaPublic);
  const shared = ecdh.computeSecret(raw(RFC.asPublic));
  assert.equal(shared.toString("base64url"), RFC.ecdhSecret);
  const keys = messageKeys(shared, RFC_PHONE, raw(RFC.asPublic), raw(RFC.salt));
  assert.equal(keys.ikm.toString("base64url"), RFC.ikm);
  assert.equal(keys.cek.toString("base64url"), RFC.cek);
  assert.equal(keys.nonce.toString("base64url"), RFC.nonce);
  assert.equal(decrypt(raw(RFC.body), RFC_PHONE).toString("utf8"), "When I grow up, I want to be a watermelon");
});

test("encrypts every message afresh, and only the phone it is for can read it", () => {
  const phone = newPhone();
  const message = Buffer.from('{"v":1,"kind":"drift"}', "utf8");
  const first = encryptPushMessage(message, phone);
  const second = encryptPushMessage(message, phone);
  assert.notDeepEqual(first.subarray(0, 16), second.subarray(0, 16), "a new salt each time");
  assert.notDeepEqual(first.subarray(21, 86), second.subarray(21, 86), "a new one-off key each time");
  assert.equal(first.readUInt32BE(16), 4096);
  assert.equal(first.readUInt8(20), 65);
  assert.deepEqual(decrypt(first, phone), message);
  assert.deepEqual(decrypt(second, phone), message);
  // Not another phone, and not this one without its authentication secret.
  assert.throws(() => decrypt(first, newPhone()));
  assert.throws(() => decrypt(first, { ...phone, auth: crypto.randomBytes(16) }));
});

test("takes a message of up to 3993 bytes, which fills one 4096-byte record exactly", () => {
  const phone = newPhone();
  assert.equal(MAX_PUSH_PAYLOAD_BYTES, 3993);
  const biggest = crypto.randomBytes(3993);
  const body = encryptPushMessage(biggest, phone);
  assert.equal(body.length, 4096);
  assert.deepEqual(decrypt(body, phone), biggest);
  assert.throws(() => encryptPushMessage(crypto.randomBytes(3994), phone), {
    message: "Expected a push message of at most 3993 bytes, but it has 3994.",
  });
  assert.deepEqual(decrypt(encryptPushMessage(Buffer.alloc(0), phone), phone), Buffer.alloc(0));
});

test("refuses a phone key that is not on the curve, and a salt of the wrong size", () => {
  const phone = newPhone();
  assert.throws(() => encryptPushMessage(Buffer.from("drift"), { ...phone, p256dh: offCurve() }));
  assert.throws(() => encryptPushMessage(Buffer.from("drift"), phone, { salt: Buffer.alloc(15) }), {
    message: "Expected a salt of 16 bytes, but it has 15.",
  });
});

test("counts as a push key only a number from 1 to just under the size of the curve", () => {
  const justUnder = keyText(`${ORDER.slice(0, -2)}50`);
  assert.equal(isPushKey(RFC.asPrivate), true);
  assert.equal(isPushKey(keyText(`${"00".repeat(31)}01`)), true);
  assert.equal(isPushKey(justUnder), true);
  for (const value of [
    keyText(ORDER),
    keyText("ff".repeat(32)),
    keyText("00".repeat(32)),
    keyText("01".repeat(31)),
    keyText("01".repeat(33)),
    `${RFC.asPrivate}=`,
    RFC.asPrivate.replace("-", "+"),
    42,
    null,
    undefined,
  ]) {
    assert.equal(isPushKey(value), false, String(value));
  }
  assert.equal(readPushKey(keyText(ORDER)), null);
  assert.equal(readPushKey(42), null);
  assert.notEqual(readPushKey(justUnder), null);
});

test("reads a push key and works out its public half", () => {
  const key = rfcPushKey();
  assert.equal(key.publicKey.toString("base64url"), RFC.asPublic);
  assert.equal(key.privateKey.type, "private");
  const signature = crypto.sign("sha256", Buffer.from("drift"), key.privateKey);
  assert.equal(crypto.verify("sha256", Buffer.from("drift"), publicKeyOf(key.publicKey), signature), true);
});

test("makes a push key from random bytes, trying again when they make none", () => {
  assert.equal(PUSH_KEY_BYTES, 32);
  const sizes: number[] = [];
  const tries = [Buffer.alloc(32, 0xff), Buffer.alloc(32), Buffer.alloc(32, 7)];
  const key = newPushKey((size) => {
    sizes.push(size);
    return tries.shift() ?? Buffer.alloc(size, 9);
  });
  assert.equal(key, Buffer.alloc(32, 7).toString("base64url"));
  assert.deepEqual(sizes, [32, 32, 32]);

  let calls = 0;
  assert.throws(
    () =>
      newPushKey((size) => {
        calls++;
        return Buffer.alloc(size, 0xff);
      }),
    { message: "Expected random bytes that make a push key, but 64 tries made none." },
  );
  assert.equal(calls, 64);
  assert.equal(isPushKey(newPushKey((size) => crypto.randomBytes(size))), true);
});

test("signs a short-lived VAPID token for the push service, with the computer's public key", () => {
  const header = vapidAuthorization(`${ENDPOINT}?x=1`, rfcPushKey(), "https://relay.example.com", NOW + 999);
  const { head, claims, signature, key } = vapidParts(header);
  assert.deepEqual(decodeJson(head), { typ: "JWT", alg: "ES256" });
  assert.deepEqual(decodeJson(claims), { aud: "https://fcm.googleapis.com", exp: NOW / 1000 + 12 * 60 * 60, sub: "https://relay.example.com" });
  assert.equal(key, RFC.asPublic);
  // What the push service does: check the signature with the key in the header.
  const signed = raw(signature);
  assert.equal(signed.length, 64);
  assert.equal(crypto.verify("sha256", Buffer.from(`${head}.${claims}`), { key: publicKeyOf(raw(key)), dsaEncoding: "ieee-p1363" }, signed), true);
});

test("leaves the contact out of the token when there is none", () => {
  const header = vapidAuthorization("https://updates.push.services.mozilla.com/wpush/v2/gAAAA", rfcPushKey(), null, NOW);
  assert.deepEqual(decodeJson(vapidParts(header).claims), { aud: "https://updates.push.services.mozilla.com", exp: NOW / 1000 + 12 * 60 * 60 });
  assert.equal(pushSubject("https://relay.example.com"), "https://relay.example.com");
  assert.equal(pushSubject("http://localhost:8787"), null);
  assert.equal(pushSubject(null), null);
});

test("sends only to the push services of the browsers the phone app works in", () => {
  for (const endpoint of [
    "https://fcm.googleapis.com/fcm/send/dGVzdA:APA91b",
    "https://android.googleapis.com/gcm/send/dGVzdA",
    "https://updates.push.services.mozilla.com/wpush/v2/gAAAAABm",
    "https://web.push.apple.com/QGxpZ2h0",
    "https://wns2-par02p.notify.windows.com/w/?token=BQYAAAB",
  ]) {
    assert.equal(readPushEndpoint(endpoint), endpoint, endpoint);
  }
  for (const endpoint of [
    "http://fcm.googleapis.com/fcm/send/abc",
    "wss://fcm.googleapis.com/fcm/send/abc",
    "https://fcm.googleapis.com.example.test/fcm/send/abc",
    "https://evil-fcm.googleapis.com/fcm/send/abc",
    "https://push.apple.com/abc",
    "https://evilpush.apple.com/abc",
    "https://web.push.apple.com.example.test/abc",
    "https://fcm.googleapis.com./fcm/send/abc",
    "https://someone@fcm.googleapis.com/fcm/send/abc",
    "https://:x@fcm.googleapis.com/fcm/send/abc",
    "https://fcm.googleapis.com:8443/fcm/send/abc",
    "https://fcm.googleapis.com/fcm/send/abc#part",
    "https://localhost/abc",
    "https://127.0.0.1/abc",
    "https://[::1]/abc",
    "https://192.168.1.10/abc",
    "fcm.googleapis.com/fcm/send/abc",
    "",
  ]) {
    assert.equal(readPushEndpoint(endpoint), null, endpoint);
  }
  for (const value of [42, null, undefined, {}, [ENDPOINT]]) {
    assert.equal(readPushEndpoint(value), null);
  }
});

test("takes an address of up to 2048 characters, written the URL standard's way", () => {
  const start = "https://fcm.googleapis.com/fcm/send/";
  const longest = start + "a".repeat(MAX_PUSH_ENDPOINT_LENGTH - start.length);
  assert.equal(readPushEndpoint(longest), longest);
  assert.equal(readPushEndpoint(`${longest}a`), null);
  assert.equal(readPushEndpoint("https://FCM.googleapis.com:443/fcm/send/a b"), "https://fcm.googleapis.com/fcm/send/a%20b");
  // Written out, each space takes three characters, which takes this one over.
  assert.equal(readPushEndpoint(`${start}${" ".repeat(700)}a`), null);
});

test("takes a subscription with a real public key and a 16-byte secret", () => {
  const subscription = { endpoint: ENDPOINT, p256dh: RFC.uaPublic, auth: RFC.auth };
  assert.deepEqual(readPushSubscription(subscription), subscription);
  assert.equal(readPushSubscription({ ...subscription, endpoint: "https://FCM.googleapis.com/fcm/send/dGVzdA" })?.endpoint, ENDPOINT);
});

test("refuses a subscription whose keys are not keys", () => {
  const good = { endpoint: ENDPOINT, p256dh: RFC.uaPublic, auth: RFC.auth };
  const wrongStart = Buffer.from(raw(RFC.uaPublic));
  wrongStart[0] = 5;
  for (const change of [
    { p256dh: offCurve().toString("base64url") },
    { p256dh: wrongStart.toString("base64url") },
    { p256dh: raw(RFC.uaPublic).subarray(0, 64).toString("base64url") },
    { p256dh: `${RFC.uaPublic}=` },
    { p256dh: 65 },
    { auth: crypto.randomBytes(15).toString("base64url") },
    { auth: crypto.randomBytes(17).toString("base64url") },
    { auth: null },
    { endpoint: "https://example.com/push" },
  ]) {
    assert.equal(readPushSubscription({ ...good, ...change }), null, JSON.stringify(change));
  }
});

test("builds the request that sends a message to one phone", () => {
  const phone = newPhone();
  const subscription = subscriptionOf(phone, ENDPOINT);
  const message = Buffer.from('{"v":1,"kind":"drift","title":"Drift found","body":"public"}', "utf8");
  const request = pushRequest(subscription, message, { key: rfcPushKey(), subject: null }, NOW);
  assert.equal(request.url, ENDPOINT);
  const { Authorization, ...others } = request.headers;
  assert.deepEqual(others, { TTL: "86400", Urgency: "normal", "Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream" });
  const parts = vapidParts(Authorization);
  assert.deepEqual(decodeJson(parts.claims), { aud: "https://fcm.googleapis.com", exp: NOW / 1000 + 12 * 60 * 60 });
  assert.equal(parts.key, RFC.asPublic);
  assert.deepEqual(decrypt(request.body, phone), message);
  assert.throws(() => pushRequest({ ...subscription, auth: "short" }, message, { key: rfcPushKey(), subject: null }, NOW), {
    message: /readPushSubscription/,
  });
});

test("says what a push service's answer means", () => {
  const outcome = (status: number, retryAfter: string | null = null) => pushOutcome({ status, retryAfter }, NOW);
  assert.deepEqual(outcome(201), { kind: "sent" });
  assert.deepEqual(outcome(200), { kind: "sent" });
  assert.deepEqual(outcome(404), { kind: "gone" });
  assert.deepEqual(outcome(410), { kind: "gone" });
  assert.deepEqual(outcome(413), { kind: "too-big" });
  assert.deepEqual(outcome(400), { kind: "refused", status: 400 });
  assert.deepEqual(outcome(401), { kind: "refused", status: 401 });
  assert.deepEqual(outcome(403), { kind: "refused", status: 403 });
  assert.deepEqual(outcome(500), { kind: "unavailable", until: NOW });
  assert.deepEqual(outcome(503, "30"), { kind: "unavailable", until: NOW + 30_000 });
  assert.deepEqual(outcome(503, "soon"), { kind: "unavailable", until: NOW + 1000 });
  assert.deepEqual(outcome(302), { kind: "unavailable", until: NOW });
});

test("waits as long as the push service asks after too many messages, within limits", () => {
  const wait = (retryAfter: string | null): number => {
    const outcome = pushOutcome({ status: 429, retryAfter }, NOW);
    assert.equal(outcome.kind, "slow-down");
    return outcome.kind === "slow-down" ? outcome.until - NOW : Number.NaN;
  };
  assert.equal(wait("120"), 120_000);
  assert.equal(wait(" 120 "), 120_000);
  assert.equal(wait(null), 60_000);
  assert.equal(wait(new Date(NOW + 90_000).toUTCString()), 90_000);
  assert.equal(wait("0"), 1000);
  assert.equal(wait(new Date(NOW - 90_000).toUTCString()), 1000);
  assert.equal(wait("9999999999"), 24 * 60 * 60 * 1000);
  for (const strange of ["soon", "-5", "1.5", "1e3", "", "Saturday"]) {
    assert.equal(wait(strange), 60_000, strange);
  }
});
