/**
 * Sending drift alerts to a phone through its browser's push service (Web
 * Push), so that a phone hears about drift even while the phone app is closed.
 *
 * When a phone turns drift alerts on, its browser gives the phone app a
 * subscription: an address at the browser maker's push service (Google's for
 * Chrome, Mozilla's for Firefox, Apple's for Safari) and two keys. The computer
 * sends each alert to that address, and the push service passes it on to the
 * phone. Three standards say how:
 *  - RFC 8291 encrypts each message for the phone's keys, in RFC 8188's
 *    "aes128gcm" format, so the push service carries it without being able to
 *    read it.
 *  - RFC 8292 (VAPID) signs each message with the computer's push key. A
 *    browser subscribes with the public half, so its push service takes
 *    messages for that subscription only from this computer.
 *  - RFC 8030 says what the push service answers.
 *
 * The address comes from the phone, so the computer sends only to the push
 * services of the browsers the phone app works in. Otherwise a phone could have
 * the computer send requests anywhere, even to machines on its own network.
 *
 * Nothing here touches the network: src/main/phone-push.ts sends, through
 * src/main/push-transport.ts.
 *
 * Tested in src/test/web-push.test.ts.
 */
import crypto from "node:crypto";

import { fromBase64UrlOfLength } from "../shared/remote/bytes";

/** A push key is a P-256 private key: a number, written as 32 bytes. */
export const PUSH_KEY_BYTES = 32;

/**
 * The number of points on the P-256 curve. A private key must be at least 1
 * and less than this; almost every 32 random bytes are.
 */
const P256_ORDER = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;

/** A P-256 public key written out in full: 4, then its two 32-byte coordinates. */
const P256_POINT_BYTES = 65;

/** The phone browser's authentication secret, a second key only the phone and the computer know. */
const AUTH_SECRET_BYTES = 16;

const SALT_BYTES = 16;

/**
 * The size of the one encrypted record each message is (RFC 8188). A push
 * service need not take a message bigger than 4096 bytes, and this one size
 * covers every message that fits.
 */
const RECORD_SIZE = 4096;

/**
 * The most a message can hold. Of the 4096 bytes, 86 are the header (the salt,
 * the record size and the computer's one-off public key), 16 are the check
 * AES-GCM adds, and 1 marks the end of the message (RFC 8291, section 4).
 */
export const MAX_PUSH_PAYLOAD_BYTES = RECORD_SIZE - (SALT_BYTES + 4 + 1 + P256_POINT_BYTES) - 16 - 1;

/** The longest subscription address taken. Real ones are a few hundred characters. */
export const MAX_PUSH_ENDPOINT_LENGTH = 2048;

/**
 * The push services of the browsers the phone app works in. Chrome, Edge,
 * Samsung Internet and most others on Android use Google's (the second name is
 * Google's older one). Firefox uses Mozilla's, Safari uses Apple's, and Edge on
 * Windows uses Microsoft's. An ending stands for every name under it, so
 * "web.push.apple.com" is allowed but "push.apple.com.example.com" is not.
 */
const PUSH_HOSTS = ["fcm.googleapis.com", "android.googleapis.com"];
const PUSH_HOST_ENDINGS = [".push.services.mozilla.com", ".push.apple.com", ".notify.windows.com"];

/**
 * How long a signature stays good, in seconds. RFC 8292 allows at most a day;
 * half a day leaves room for a computer whose clock is a little off.
 */
const VAPID_VALID_SECONDS = 12 * 60 * 60;

/** How long a push service keeps a message for a phone that is off, in seconds. After a day an alert is old news. */
const PUSH_TTL_SECONDS = 24 * 60 * 60;

/** How long to wait after "slow down" (429) when the push service does not say. */
const SLOW_DOWN_MS = 60_000;
const MIN_WAIT_MS = 1000;
const MAX_WAIT_MS = 24 * 60 * 60 * 1000;

/** An HTTP date, as "Retry-After" may give one: "Sun, 06 Nov 1994 08:49:37 GMT". */
const HTTP_DATE = /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/;

/** A phone's subscription, as its browser gives it, after every check here. */
export type PushSubscriptionFields = {
  /** The push service's address for this one phone: https, at one of the push services above. */
  endpoint: string;
  /** The phone browser's public key (P-256, written out in full), as base64url. */
  p256dh: string;
  /** The phone browser's authentication secret, as base64url. */
  auth: string;
};

/** The computer's push key, ready to sign with. */
export type PushKey = {
  privateKey: crypto.KeyObject;
  /** The public half, written out in full (65 bytes). Browsers subscribe with it, and push services check signatures with it. */
  publicKey: Buffer;
};

/** One POST to a push service. */
export type PushRequest = { url: string; headers: Record<string, string>; body: Buffer };

/** What the push service answered: its status, and its "Retry-After" header when it sent one. */
export type PushResponse = { status: number; retryAfter: string | null };

/**
 * Sends one request and gives the answer (src/main/push-transport.ts). It
 * throws when no answer came at all. Tests pass in a fake push service.
 */
export type PushTransport = (request: PushRequest) => Promise<PushResponse>;

/**
 * What became of one message:
 *  - sent: the push service took it.
 *  - gone: the subscription has ended, as when the phone turned alerts off in
 *    its browser's settings. It never works again, so it is forgotten.
 *  - too-big: the push service would not take a message this size.
 *  - refused: the push service would not take it for another reason, such as
 *    a signature it did not accept.
 *  - slow-down: the push service has had too many messages; send nothing more
 *    to this phone until `until`.
 *  - unavailable: the push service had a problem of its own. The next message
 *    is sent as usual, or from `until` when it said how long to wait.
 */
export type PushOutcome =
  | { kind: "sent" }
  | { kind: "gone" }
  | { kind: "too-big" }
  | { kind: "refused"; status: number }
  | { kind: "slow-down"; until: number }
  | { kind: "unavailable"; until: number };

/** True when the text is a push key: 32 bytes as base64url, holding a number from 1 to just under P256_ORDER. */
export function isPushKey(value: unknown): value is string {
  const bytes = fromBase64UrlOfLength(value, PUSH_KEY_BYTES);
  if (bytes === null) return false;
  const number = BigInt(`0x${Buffer.from(bytes).toString("hex")}`);
  return number > 0n && number < P256_ORDER;
}

/**
 * A new push key, as phone-link.json keeps it. `random` is crypto.randomBytes,
 * passed in so tests can fix it.
 */
export function newPushKey(random: (size: number) => Buffer): string {
  // About 1 in 4 billion sets of random bytes is not a key, so a second try is
  // already all but certain to be enough. The limit only stops a broken
  // generator from looping for ever.
  for (let tries = 0; tries < 64; tries++) {
    const text = random(PUSH_KEY_BYTES).toString("base64url");
    if (isPushKey(text)) return text;
  }
  throw new Error("Expected random bytes that make a push key, but 64 tries made none.");
}

/** The push key in phone-link.json, ready to sign with, or null when it is not one. */
export function readPushKey(text: unknown): PushKey | null {
  if (!isPushKey(text)) return null;
  const ecdh = crypto.createECDH("prime256v1");
  ecdh.setPrivateKey(Buffer.from(text, "base64url"));
  const publicKey = ecdh.getPublicKey();
  const privateKey = crypto.createPrivateKey({
    key: {
      kty: "EC",
      crv: "P-256",
      d: text,
      x: publicKey.subarray(1, 33).toString("base64url"),
      y: publicKey.subarray(33).toString("base64url"),
    },
    format: "jwk",
  });
  return { privateKey, publicKey };
}

function isPushHost(host: string): boolean {
  return PUSH_HOSTS.includes(host) || PUSH_HOST_ENDINGS.some((ending) => host.length > ending.length && host.endsWith(ending));
}

/**
 * A subscription address the computer may send to, written the one way the
 * URL standard writes it, or null. It must be https on the usual port, at one
 * of the push services above, with no user name or password in it.
 */
export function readPushEndpoint(value: unknown): string | null {
  if (typeof value !== "string" || value.length > MAX_PUSH_ENDPOINT_LENGTH) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.port !== "" || url.hash !== "") {
    return null;
  }
  // A name ending in a dot ("fcm.googleapis.com.") matches nothing here, so
  // only the exact names get through.
  if (!isPushHost(url.hostname)) return null;
  // Writing it the URL standard's way can make it longer (spaces become %20).
  return url.href.length <= MAX_PUSH_ENDPOINT_LENGTH ? url.href : null;
}

/** True when the bytes are a P-256 public key: the right size, and a point that is really on the curve. */
function isP256Point(bytes: Uint8Array): boolean {
  if (bytes.length !== P256_POINT_BYTES || bytes[0] !== 4) return false;
  try {
    // Node checks the point as it makes the key, and throws when it is not on the curve.
    crypto.createPublicKey({
      key: {
        kty: "EC",
        crv: "P-256",
        x: Buffer.from(bytes.subarray(1, 33)).toString("base64url"),
        y: Buffer.from(bytes.subarray(33)).toString("base64url"),
      },
      format: "jwk",
    });
    return true;
  } catch {
    return false;
  }
}

function isPhonePublicKey(value: unknown): value is string {
  const bytes = fromBase64UrlOfLength(value, P256_POINT_BYTES);
  return bytes !== null && isP256Point(bytes);
}

function isAuthSecret(value: unknown): value is string {
  return fromBase64UrlOfLength(value, AUTH_SECRET_BYTES) !== null;
}

/**
 * A phone's subscription, as the phone app sends it (its endpoint and its two
 * keys from PushSubscription.toJSON()), after every check, or null.
 */
export function readPushSubscription(value: { endpoint: unknown; p256dh: unknown; auth: unknown }): PushSubscriptionFields | null {
  const endpoint = readPushEndpoint(value.endpoint);
  const { p256dh, auth } = value;
  if (endpoint === null || !isPhonePublicKey(p256dh) || !isAuthSecret(auth)) return null;
  return { endpoint, p256dh, auth };
}

function hkdf(secret: Uint8Array, salt: Uint8Array, info: Uint8Array, length: number): Buffer {
  return Buffer.from(crypto.hkdfSync("sha256", secret, salt, info, length));
}

/** A label for HKDF, which the standards end with a zero byte. */
function label(text: string): Buffer {
  return Buffer.concat([Buffer.from(text, "utf8"), Buffer.from([0])]);
}

/**
 * The message encrypted for one phone (RFC 8291, with RFC 8188's aes128gcm):
 * the header, then the one encrypted record.
 *
 * Every message gets a new salt and a new one-off key pair for the computer,
 * so no two messages are encrypted alike. Tests pass in the RFC example's
 * `salt` and `senderKey` (a private key) to check the result byte for byte.
 */
export function encryptPushMessage(
  payload: Uint8Array,
  phone: { p256dh: Uint8Array; auth: Uint8Array },
  chosen: { salt?: Uint8Array; senderKey?: Uint8Array } = {},
): Buffer {
  if (payload.length > MAX_PUSH_PAYLOAD_BYTES) {
    throw new Error(`Expected a push message of at most ${MAX_PUSH_PAYLOAD_BYTES} bytes, but it has ${payload.length}.`);
  }
  const salt = chosen.salt ?? crypto.randomBytes(SALT_BYTES);
  if (salt.length !== SALT_BYTES) throw new Error(`Expected a salt of ${SALT_BYTES} bytes, but it has ${salt.length}.`);

  const ecdh = crypto.createECDH("prime256v1");
  if (chosen.senderKey === undefined) ecdh.generateKeys();
  else ecdh.setPrivateKey(chosen.senderKey);
  const senderPublic = ecdh.getPublicKey();
  // Throws when the phone's key is not a point on the curve.
  const shared = ecdh.computeSecret(phone.p256dh);

  // Mixing in the authentication secret means that someone who knows only
  // the phone's public key (the push service, say) still cannot read it.
  const keyInfo = Buffer.concat([label("WebPush: info"), phone.p256dh, senderPublic]);
  const ikm = hkdf(shared, phone.auth, keyInfo, 32);
  const contentKey = hkdf(ikm, salt, label("Content-Encoding: aes128gcm"), 16);
  const nonce = hkdf(ikm, salt, label("Content-Encoding: nonce"), 12);

  const cipher = crypto.createCipheriv("aes-128-gcm", contentKey, nonce);
  // The 2 after the message says this record is the last one, with no
  // padding after it.
  const record = Buffer.concat([cipher.update(payload), cipher.update(Buffer.from([2])), cipher.final(), cipher.getAuthTag()]);

  const recordSize = Buffer.alloc(4);
  recordSize.writeUInt32BE(RECORD_SIZE);
  return Buffer.concat([salt, recordSize, Buffer.from([senderPublic.length]), senderPublic, record]);
}

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

/**
 * Who the push services may contact about this computer's messages: the
 * relay's address, when it is https. RFC 8292 asks for a contact address, and
 * Apple's push service refuses a message without one. It is never a person's
 * email address, which would tell Google, Mozilla and Apple who sends them.
 */
export function pushSubject(relayOrigin: string | null): string | null {
  return relayOrigin !== null && relayOrigin.startsWith("https://") ? relayOrigin : null;
}

/**
 * The Authorization header for one message (RFC 8292): a short-lived token
 * that names the push service it is for and is signed with the computer's
 * push key, then the public half of that key, so the push service can check
 * it is the key the phone subscribed with.
 */
export function vapidAuthorization(endpoint: string, key: PushKey, subject: string | null, now: number): string {
  const claims: Record<string, string | number> = {
    aud: new URL(endpoint).origin,
    exp: Math.floor(now / 1000) + VAPID_VALID_SECONDS,
  };
  if (subject !== null) claims.sub = subject;
  const unsigned = `${base64UrlJson({ typ: "JWT", alg: "ES256" })}.${base64UrlJson(claims)}`;
  // A JSON Web Token's ES256 signature is the two 32-byte numbers side by
  // side, not the DER form Node gives by default.
  const signature = crypto.sign("sha256", Buffer.from(unsigned, "utf8"), { key: key.privateKey, dsaEncoding: "ieee-p1363" });
  return `vapid t=${unsigned}.${signature.toString("base64url")}, k=${key.publicKey.toString("base64url")}`;
}

/** The request that sends `payload` to one phone, encrypted for it and signed by this computer. */
export function pushRequest(
  subscription: PushSubscriptionFields,
  payload: Uint8Array,
  sender: { key: PushKey; subject: string | null },
  now: number,
): PushRequest {
  const p256dh = fromBase64UrlOfLength(subscription.p256dh, P256_POINT_BYTES);
  const auth = fromBase64UrlOfLength(subscription.auth, AUTH_SECRET_BYTES);
  if (p256dh === null || auth === null) {
    throw new Error("Expected a subscription that readPushSubscription accepted, but its keys could not be read.");
  }
  return {
    url: subscription.endpoint,
    headers: {
      Authorization: vapidAuthorization(subscription.endpoint, sender.key, sender.subject, now),
      TTL: String(PUSH_TTL_SECONDS),
      // Drift can wait for the phone to wake up; "high" is for things like calls.
      Urgency: "normal",
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
    },
    body: encryptPushMessage(payload, { p256dh, auth }),
  };
}

/**
 * When to send again after an answer with "Retry-After", which gives seconds
 * or an HTTP date. A value that cannot be read counts as `fallback`, and the
 * wait is kept between a second and a day, so a strange answer can neither
 * hurry the computer nor silence a phone for long.
 */
function retryTime(retryAfter: string | null, now: number, fallback: number): number {
  const text = retryAfter?.trim() ?? "";
  let wait = fallback;
  if (/^\d{1,10}$/.test(text)) wait = Number(text) * 1000;
  else if (HTTP_DATE.test(text)) {
    const date = Date.parse(text);
    if (Number.isFinite(date)) wait = date - now;
  }
  return now + Math.min(Math.max(wait, MIN_WAIT_MS), MAX_WAIT_MS);
}

/** What a push service's answer means (RFC 8030, section 5, and the push services' own pages). */
export function pushOutcome(response: PushResponse, now: number): PushOutcome {
  const { status, retryAfter } = response;
  if (status >= 200 && status < 300) return { kind: "sent" };
  if (status === 404 || status === 410) return { kind: "gone" };
  if (status === 413) return { kind: "too-big" };
  if (status === 429) return { kind: "slow-down", until: retryTime(retryAfter, now, SLOW_DOWN_MS) };
  if (status >= 400 && status < 500) return { kind: "refused", status };
  return { kind: "unavailable", until: retryAfter === null ? now : retryTime(retryAfter, now, MIN_WAIT_MS) };
}
