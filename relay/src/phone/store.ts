/**
 * What the phone remembers about the computer it is paired with, and the
 * check that a record read back from the browser's storage is whole.
 *
 * There is one record, kept in the browser's database for this page
 * (idb-store.ts) and nowhere else. It holds the phone's private key as a
 * CryptoKey that was made not extractable: the page can use it in a
 * handshake, but no script can read its bytes, and the browser stores the key
 * itself rather than bytes a script could copy. Clearing this site's data in
 * the browser forgets the computer, and the phone has to be paired again.
 *
 * Pure, so the tests (src/test/phone-store.test.ts) can run it in Node.
 */
import type { Bytes } from "../shared/remote/bytes.js";
import { KEY_BYTES, type Key, type KeyPair } from "../shared/remote/keys.js";
import { cleanDeviceName } from "../shared/remote/pairing.js";
import { isDesktopId } from "../shared/remote/relay-auth.js";
import { readRelayOrigin } from "../shared/remote/relay-protocol.js";

export type PairedComputer = {
  /** How the record is laid out, so a later version of the app can tell this one apart. */
  version: 1;
  /** The relay's address, which is also where this app was opened from. */
  relayOrigin: string;
  /** The computer's room at the relay. */
  desktopId: string;
  /** The computer's public key, which every handshake checks the computer against. */
  desktopKey: Bytes;
  /** The computer's name, as it last gave it. */
  computerName: string;
  /** The name this phone gave itself, which the computer's Settings show. */
  phoneName: string;
  /** When the phone was paired, in milliseconds since 1970. */
  pairedAt: number;
  /** This phone's own key pair. The computer knows the phone by its public key. */
  phoneKey: KeyPair;
};

/**
 * A record read back from storage, or null when it is not one this app
 * wrote: missing, from a later version, or damaged. The app then shows the
 * pairing screen, as it does on a phone that was never paired.
 */
export function readPairedComputer(value: unknown): PairedComputer | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const { relayOrigin, desktopId, desktopKey, computerName, phoneName, pairedAt } = record;
  if (record.version !== 1) return null;
  if (typeof relayOrigin !== "string" || readRelayOrigin(relayOrigin) !== relayOrigin) return null;
  if (!isDesktopId(desktopId) || !isKeyBytes(desktopKey)) return null;
  if (!isCleanName(computerName) || !isCleanName(phoneName)) return null;
  if (typeof pairedAt !== "number" || !Number.isFinite(pairedAt)) return null;
  const phoneKey = readKeyPair(record.phoneKey);
  if (phoneKey === null) return null;
  return { version: 1, relayOrigin, desktopId, desktopKey, computerName, phoneName, pairedAt, phoneKey };
}

/** A key pair from the record, or null when either half is missing or of the wrong kind. */
function readKeyPair(value: unknown): KeyPair | null {
  if (typeof value !== "object" || value === null) return null;
  const { privateKey, publicKey } = value as Record<string, unknown>;
  return isPrivateX25519Key(privateKey) && isKeyBytes(publicKey) ? { privateKey, publicKey } : null;
}

/**
 * A private X25519 key held by Web Crypto, told by what it says it is,
 * because Node.js's type definitions have no CryptoKey class to check it
 * against.
 */
function isPrivateX25519Key(value: unknown): value is Key {
  if (typeof value !== "object" || value === null) return false;
  const key = value as { type?: unknown; algorithm?: { name?: unknown }; usages?: unknown };
  return key.type === "private" && key.algorithm?.name === "X25519" && Array.isArray(key.usages) && key.usages.includes("deriveBits");
}

function isKeyBytes(value: unknown): value is Bytes {
  return value instanceof Uint8Array && value.buffer instanceof ArrayBuffer && value.length === KEY_BYTES;
}

/** A name as cleanDeviceName leaves it, which is how the app saves each one. */
function isCleanName(value: unknown): value is string {
  return typeof value === "string" && value !== "" && cleanDeviceName(value, "") === value;
}
