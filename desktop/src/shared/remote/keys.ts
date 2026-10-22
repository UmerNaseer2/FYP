/**
 * The phone link's key pairs, made and read back the same way in all three
 * programs.
 *
 * There are two kinds:
 *  - X25519 keys agree on secrets in the Noise handshake (noise.ts). The
 *    computer has one, each phone has one, and every handshake makes two more
 *    that are thrown away after it.
 *  - Ed25519 keys sign. The computer has one, used only to prove to the relay
 *    that its room there is its own (relay-auth.ts).
 *
 * Inside Web Crypto a private key is a CryptoKey: an object whose bytes a
 * script can read only if the key was made "extractable". The phone keeps its
 * key as such an object in the browser's own storage and never makes it
 * extractable. The desktop app keeps its keys in its keyring-protected secrets
 * file, so it makes them extractable once, stores their 32 bytes, and from
 * then on reads them back in as keys that are not.
 */
import { concatBytes, fromBase64UrlOfLength, type Bytes } from "./bytes.js";

export type KeyKind = "X25519" | "Ed25519";

/**
 * A key held by Web Crypto (a CryptoKey). Written this way because Node.js's
 * type definitions have no name for the type.
 */
export type Key = Awaited<ReturnType<typeof crypto.subtle.importKey>>;

/** A private key, and the bytes of the public key that goes with it. */
export type KeyPair = { privateKey: Key; publicKey: Bytes };

/** Both kinds of key are 32 bytes, private and public alike. */
export const KEY_BYTES = 32;

/** What each kind of private key is for. */
const PRIVATE_KEY_USE = { X25519: "deriveBits", Ed25519: "sign" } as const;

/**
 * How each kind of private key starts in PKCS #8 form (RFC 8410); the two
 * differ only in the last byte of the algorithm's ID. Web Crypto reads a lone
 * private key only inside a wrapping like this, and the key's 32 bytes simply
 * follow it.
 */
const PKCS8_PREFIX: Record<KeyKind, Bytes> = {
  X25519: Uint8Array.of(0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x04, 0x22, 0x04, 0x20),
  Ed25519: Uint8Array.of(0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20),
};

/**
 * Makes a new key pair. `extractable` says whether exportPrivateKey may read
 * the private key's bytes.
 */
export async function generateKeyPair(kind: KeyKind, extractable: boolean): Promise<KeyPair> {
  // The kind is given by name alone because Node.js's type definitions take
  // `{ name }` for a kind that makes a single key, not a key pair.
  const pair = await crypto.subtle.generateKey(kind, extractable, [PRIVATE_KEY_USE[kind]]);
  if (!("privateKey" in pair)) throw new Error(`Web Crypto did not make an ${kind} key pair.`);
  // Cloudflare's type definitions say an export can give either form, so
  // each export checks it got the one it asked for.
  const raw = await crypto.subtle.exportKey("raw", pair.publicKey);
  if (!(raw instanceof ArrayBuffer)) throw new Error(`Web Crypto did not give the ${kind} public key.`);
  return { privateKey: pair.privateKey, publicKey: new Uint8Array(raw) };
}

/**
 * A key pair from a private key's 32 bytes. The public key is worked out from
 * the private key rather than stored next to it, so the two can never
 * disagree.
 */
export async function importKeyPair(kind: KeyKind, privateKey: Bytes, extractable = false): Promise<KeyPair> {
  if (privateKey.length !== KEY_BYTES) throw new Error(`An ${kind} private key must be ${KEY_BYTES} bytes.`);
  const pkcs8 = concatBytes(PKCS8_PREFIX[kind], privateKey);
  // Web Crypto shows the public half only of a key it may export, so a key
  // that must not be exportable is read in twice.
  const readable = await crypto.subtle.importKey("pkcs8", pkcs8, { name: kind }, true, [PRIVATE_KEY_USE[kind]]);
  const publicKey = fromBase64UrlOfLength((await exportJwk(readable)).x, KEY_BYTES);
  if (publicKey === null) throw new Error(`The ${kind} public key could not be worked out.`);
  const key = extractable
    ? readable
    : await crypto.subtle.importKey("pkcs8", pkcs8, { name: kind }, false, [PRIVATE_KEY_USE[kind]]);
  return { privateKey: key, publicKey };
}

/** The 32 bytes of a private key that was made extractable. */
export async function exportPrivateKey(privateKey: Key): Promise<Bytes> {
  const bytes = fromBase64UrlOfLength((await exportJwk(privateKey)).d, KEY_BYTES);
  if (bytes === null) throw new Error("The private key could not be read.");
  return bytes;
}

/**
 * A key as a JSON Web Key, where `d` holds a private key's bytes and `x` the
 * public key's. It is read this way rather than as PKCS #8 because PKCS #8
 * may be written more than one way, and JSON Web Keys only one.
 */
async function exportJwk(key: Key) {
  const jwk = await crypto.subtle.exportKey("jwk", key);
  if (jwk instanceof ArrayBuffer) throw new Error("Web Crypto did not give the key as a JSON Web Key.");
  return jwk;
}
