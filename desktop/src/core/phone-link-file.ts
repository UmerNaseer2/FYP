/**
 * What phone-link.json holds: whether the phone link is on, the relay it goes
 * through, which saved connections phones may see, the phones paired with this
 * computer with the drift alerts each has asked for, and the phone link's own
 * keys.
 *
 *  - signingKey proves to the relay that this is the computer the phones
 *    paired with (src/shared/remote/relay-auth.ts). The relay knows the
 *    computer only by an ID made from its public half.
 *  - staticKey is the computer's end of every phone's encrypted link
 *    (src/shared/remote/noise.ts). A paired phone keeps its public half and
 *    refuses any computer that cannot prove it holds this one.
 *  - pushKey signs the drift alerts the computer sends through phones' push
 *    services (src/core/web-push.ts). A phone's browser turns alerts on with
 *    its public half.
 *
 * Each is 32 random bytes. That is all an Ed25519 or X25519 private key is, and
 * a P-256 one too, as long as the bytes make a number below the curve's order
 * (newPushKey tries again when they do not). The keys are checked exactly when
 * the file is read: a key that changed would make this a different computer to
 * every paired phone, so a damaged signing or static key leaves the phone link
 * off instead of quietly making a new one. The push key is the exception,
 * because losing it costs only drift alerts: when it cannot be read,
 * src/main/phone-link.ts makes a new one and turns every phone's alerts off,
 * since a push service takes alerts signed only with the key they were turned
 * on with, until each phone turns them on again. The other fields are checked
 * one by one, and one that cannot be read falls back to its default, as in
 * config.json. Every fallback gives phones less, never more: a phone, a shared
 * connection or a phone's alerts that cannot be read are left out.
 *
 * The file is kept the way secrets.json is (src/core/secrets-file.ts), locked
 * with a key from the login keyring where there is one.
 *
 * Pure: reading and writing the file is src/main/phone-link.ts.
 */
import { fromBase64UrlOfLength } from "../shared/remote/bytes";
import { KEY_BYTES } from "../shared/remote/keys";
import { cleanDeviceName } from "../shared/remote/pairing";
import { readRelayOrigin } from "../shared/remote/relay-protocol";
import { isPushKey, newPushKey, readPushSubscription, type PushSubscriptionFields } from "./web-push";

/** The most phones one computer pairs with. The relay lets the same number connect at once (relay/src/room-logic.ts). */
export const MAX_PAIRED_PHONES = 8;

/** Where a phone's browser takes drift alerts for it, and the keys to encrypt them for it (src/core/web-push.ts). */
export type PhoneSubscription = PushSubscriptionFields & {
  /** When the phone turned drift alerts on, in milliseconds since 1970. */
  since: number;
};

export type PairedPhone = {
  /** The phone's public key (X25519, as base64url). The phone proves it holds the private half each time it connects. */
  key: string;
  /** The name the phone gave itself when it paired, cleaned by cleanDeviceName. */
  name: string;
  /** When it paired, in milliseconds since 1970. */
  pairedAt: number;
  /** When it last connected, in milliseconds since 1970. When it pairs, that counts. */
  lastSeenAt: number;
  /** Where to send it drift alerts. Left out until the phone turns them on. */
  push?: PhoneSubscription;
};

export type PhoneLinkState = {
  /** Whether the computer stays connected to the relay so its phones can reach it. Off until the person turns it on. */
  enabled: boolean;
  /** The relay's address, such as "https://relay.example.com", or null until one is set. */
  relayOrigin: string | null;
  /** The saved connections phones may see, by their number in the app. None until the person shares some. */
  sharedConnectionIds: number[];
  phones: PairedPhone[];
  /** The Ed25519 private key the computer signs in to the relay with, as base64url. */
  signingKey: string;
  /** The X25519 private key at the computer's end of every phone's link, as base64url. */
  staticKey: string;
  /**
   * The P-256 private key that signs drift alerts to phones, as base64url, or
   * null when the file held none that could be read, until phone-link.ts makes one.
   */
  pushKey: string | null;
};

/** A first run's state: new keys, the link off, nothing shared and no phones. `random` is crypto.randomBytes, passed in so tests can fix it. */
export function newPhoneLinkState(random: (size: number) => Buffer): PhoneLinkState {
  return {
    enabled: false,
    relayOrigin: null,
    sharedConnectionIds: [],
    phones: [],
    signingKey: random(KEY_BYTES).toString("base64url"),
    staticKey: random(KEY_BYTES).toString("base64url"),
    pushKey: newPushKey(random),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isKey(value: unknown): value is string {
  return typeof value === "string" && fromBase64UrlOfLength(value, KEY_BYTES) !== null;
}

/** A time the app wrote: whole milliseconds since 1970. */
function isTime(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** The connection numbers that can be read, each once, in the order they were saved. */
export function readConnectionIds(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const ids = new Set<number>();
  for (const id of value) {
    if (typeof id === "number" && Number.isSafeInteger(id) && id > 0) ids.add(id);
  }
  return [...ids];
}

function readSubscription(value: unknown): PhoneSubscription | null {
  if (!isRecord(value)) return null;
  const { endpoint, p256dh, auth, since } = value;
  const subscription = readPushSubscription({ endpoint, p256dh, auth });
  return subscription !== null && isTime(since) ? { ...subscription, since } : null;
}

function readPhone(value: unknown): PairedPhone | null {
  if (!isRecord(value)) return null;
  const { key, name, pairedAt, lastSeenAt } = value;
  if (!isKey(key) || !isTime(pairedAt)) return null;
  // A subscription that cannot be read is left out, so that phone gets no
  // drift alerts until it turns them on again.
  const push = readSubscription(value.push);
  return {
    key,
    // "Phone" is also the name readOpening gives a phone that sent none.
    name: cleanDeviceName(typeof name === "string" ? name : "", "Phone"),
    pairedAt,
    lastSeenAt: isTime(lastSeenAt) ? lastSeenAt : pairedAt,
    ...(push === null ? {} : { push }),
  };
}

/** The paired phones that can be read, each key once, and no more than MAX_PAIRED_PHONES. */
function readPhones(value: unknown): PairedPhone[] {
  if (!Array.isArray(value)) return [];
  const phones: PairedPhone[] = [];
  for (const item of value) {
    const phone = readPhone(item);
    if (phone === null || phones.length === MAX_PAIRED_PHONES) continue;
    if (!phones.some((known) => known.key === phone.key)) phones.push(phone);
  }
  return phones;
}

/** The state read back from phone-link.json, or null when its keys are not what the app wrote. */
export function parsePhoneLinkState(value: unknown): PhoneLinkState | null {
  if (!isRecord(value)) return null;
  const { signingKey, staticKey, pushKey } = value;
  if (!isKey(signingKey) || !isKey(staticKey)) return null;
  return {
    enabled: value.enabled === true,
    relayOrigin: typeof value.relayOrigin === "string" ? readRelayOrigin(value.relayOrigin) : null,
    sharedConnectionIds: readConnectionIds(value.sharedConnectionIds),
    phones: readPhones(value.phones),
    signingKey,
    staticKey,
    pushKey: isPushKey(pushKey) ? pushKey : null,
  };
}

/**
 * The phones with one more paired, or null when MAX_PAIRED_PHONES are paired
 * already. A phone that pairs again keeps its place and its first pairing
 * time, and takes the name it gives now.
 */
export function withPairedPhone(phones: readonly PairedPhone[], key: string, name: string, now: number): PairedPhone[] | null {
  if (phones.some((phone) => phone.key === key)) {
    return phones.map((phone) => (phone.key === key ? { ...phone, name, lastSeenAt: now } : phone));
  }
  if (phones.length >= MAX_PAIRED_PHONES) return null;
  return [...phones, { key, name, pairedAt: now, lastSeenAt: now }];
}

/** The phones with this one's last connection set to now. */
export function withPhoneSeen(phones: readonly PairedPhone[], key: string, now: number): PairedPhone[] {
  return phones.map((phone) => (phone.key === key ? { ...phone, lastSeenAt: now } : phone));
}

/** The phones without this one. */
export function withoutPhone(phones: readonly PairedPhone[], key: string): PairedPhone[] {
  return phones.filter((phone) => phone.key !== key);
}

/** The phone as it is without drift alerts. */
function withoutPush({ key, name, pairedAt, lastSeenAt }: PairedPhone): PairedPhone {
  return { key, name, pairedAt, lastSeenAt };
}

/** The phones with this one's drift alerts turned on with `subscription`, or turned off when it is null. */
export function withPhoneSubscription(phones: readonly PairedPhone[], key: string, subscription: PhoneSubscription | null): PairedPhone[] {
  return phones.map((phone) => {
    if (phone.key !== key) return phone;
    return subscription === null ? withoutPush(phone) : { ...withoutPush(phone), push: subscription };
  });
}

/**
 * The state with a new push key made with `random`. Each phone turned drift
 * alerts on for the old key, and push services refuse alerts signed with any
 * other, so every phone's alerts are turned off with it.
 */
export function withNewPushKey(state: PhoneLinkState, random: (size: number) => Buffer): PhoneLinkState {
  return { ...state, pushKey: newPushKey(random), phones: state.phones.map(withoutPush) };
}
