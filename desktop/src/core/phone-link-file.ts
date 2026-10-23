/**
 * What phone-link.json holds: whether the phone link is on, the relay it goes
 * through, which saved connections phones may see, the phones paired with this
 * computer, and the phone link's own two keys.
 *
 *  - signingKey proves to the relay that this is the computer the phones
 *    paired with (src/shared/remote/relay-auth.ts). The relay knows the
 *    computer only by an ID made from its public half.
 *  - staticKey is the computer's end of every phone's encrypted link
 *    (src/shared/remote/noise.ts). A paired phone keeps its public half and
 *    refuses any computer that cannot prove it holds this one.
 *
 * Each is 32 random bytes, which is all an Ed25519 or X25519 private key is.
 * They are checked exactly when the file is read: a key that changed would make
 * this a different computer to every paired phone, so a damaged key leaves the
 * phone link off instead of quietly making a new one. The other fields are
 * checked one by one, and one that cannot be read falls back to its default, as
 * in config.json. Every fallback gives phones less, never more: a phone or a
 * shared connection that cannot be read is left out.
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

/** The most phones one computer pairs with. The relay lets the same number connect at once (relay/src/room-logic.ts). */
export const MAX_PAIRED_PHONES = 8;

export type PairedPhone = {
  /** The phone's public key (X25519, as base64url). The phone proves it holds the private half each time it connects. */
  key: string;
  /** The name the phone gave itself when it paired, cleaned by cleanDeviceName. */
  name: string;
  /** When it paired, in milliseconds since 1970. */
  pairedAt: number;
  /** When it last connected, in milliseconds since 1970. When it pairs, that counts. */
  lastSeenAt: number;
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

function readPhone(value: unknown): PairedPhone | null {
  if (!isRecord(value)) return null;
  const { key, name, pairedAt, lastSeenAt } = value;
  if (!isKey(key) || !isTime(pairedAt)) return null;
  return {
    key,
    // "Phone" is also the name readOpening gives a phone that sent none.
    name: cleanDeviceName(typeof name === "string" ? name : "", "Phone"),
    pairedAt,
    lastSeenAt: isTime(lastSeenAt) ? lastSeenAt : pairedAt,
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
  const { signingKey, staticKey } = value;
  if (!isKey(signingKey) || !isKey(staticKey)) return null;
  return {
    enabled: value.enabled === true,
    relayOrigin: typeof value.relayOrigin === "string" ? readRelayOrigin(value.relayOrigin) : null,
    sharedConnectionIds: readConnectionIds(value.sharedConnectionIds),
    phones: readPhones(value.phones),
    signingKey,
    staticKey,
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
