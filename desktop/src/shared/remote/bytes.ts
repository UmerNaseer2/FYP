/**
 * Small helpers for the bytes the phone link sends: joining them, writing them
 * as text for links and JSON, and comparing them.
 *
 * The files in this folder are shared by three programs: the desktop app, the
 * relay that passes messages between a phone and the computer, and the phone
 * app. So they use only what all three have, the language itself and the Web
 * Crypto API, and never Node's Buffer or a web page's DOM. relay/src/shared/
 * remote holds exact copies (src/test/remote-copy.test.ts keeps them the
 * same), and every import names its file with ".js", which is what a browser
 * needs and what TypeScript understands everywhere.
 */

/**
 * Bytes, always backed by an ordinary ArrayBuffer. TypeScript's definitions of
 * Web Crypto accept only that kind (never a SharedArrayBuffer), so every
 * function in this folder takes and returns it.
 */
export type Bytes = Uint8Array<ArrayBuffer>;

export function concatBytes(...parts: Bytes[]): Bytes {
  let length = 0;
  for (const part of parts) length += part.length;
  const joined = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.length;
  }
  return joined;
}

/**
 * True when both hold the same bytes. It looks at every byte whatever it
 * finds, so how long it takes says nothing about where they differ, which
 * matters when one of them is a secret.
 */
export function sameBytes(a: Bytes, b: Bytes): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i];
  return difference === 0;
}

/** Fresh random bytes from the system's secure generator, at most 64 KiB at a time (a limit of Web Crypto). */
export function randomBytes(length: number): Bytes {
  return crypto.getRandomValues(new Uint8Array(length));
}

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/**
 * Writes bytes as base64url without padding (RFC 4648, section 5): letters,
 * digits, "-" and "_" only, so the text is safe in links, file names and JSON.
 */
export function toBase64Url(bytes: Bytes): string {
  let text = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    text += ALPHABET[n >> 18] + ALPHABET[(n >> 12) & 63] + ALPHABET[(n >> 6) & 63] + ALPHABET[n & 63];
  }
  if (bytes.length - i === 1) {
    const n = bytes[i] << 16;
    text += ALPHABET[n >> 18] + ALPHABET[(n >> 12) & 63];
  } else if (bytes.length - i === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    text += ALPHABET[n >> 18] + ALPHABET[(n >> 12) & 63] + ALPHABET[(n >> 6) & 63];
  }
  return text;
}

/**
 * Reads what toBase64Url writes, or gives null. It refuses padding, any other
 * character, and a last character with unused bits set: those bits would let
 * the same bytes be written in more than one way, and a key or an ID must have
 * exactly one written form.
 */
export function fromBase64Url(text: string): Bytes | null {
  if (text.length % 4 === 1) return null;
  const bytes = new Uint8Array(Math.floor((text.length * 3) / 4));
  let value = 0;
  let bits = 0;
  let next = 0;
  for (let i = 0; i < text.length; i++) {
    const digit = ALPHABET.indexOf(text[i]);
    if (digit < 0) return null;
    value = (value << 6) | digit;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[next++] = value >> bits;
      value &= (1 << bits) - 1;
    }
  }
  return value === 0 ? bytes : null;
}

/** Reads base64url that must hold exactly `length` bytes, or gives null. */
export function fromBase64UrlOfLength(text: unknown, length: number): Bytes | null {
  if (typeof text !== "string") return null;
  const bytes = fromBase64Url(text);
  return bytes !== null && bytes.length === length ? bytes : null;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export function utf8(text: string): Bytes {
  // TextEncoder always gives bytes in an ordinary ArrayBuffer, but Cloudflare's
  // type definitions do not promise it, so the relay would not compile without
  // this copy, which costs little next to the encoding itself.
  return new Uint8Array(encoder.encode(text));
}

/** Reads UTF-8 text, or gives null when the bytes are not valid UTF-8. */
export function readUtf8(bytes: Bytes): string | null {
  try {
    return decoder.decode(bytes);
  } catch {
    return null;
  }
}
