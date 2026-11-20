/**
 * SHA-256 in the browser, on any page the app is served from.
 *
 * Approvals are matched by the hash of the run they cover: the server hashes
 * the text with node:crypto and the page hashes the same text, so the two hex
 * strings agree and the page can tell whether the run in front of the user is
 * the approved one.
 *
 * The page's usual tool for that is crypto.subtle, which browsers only offer
 * in a secure context (https, or localhost). The handover runs the app over
 * plain http at a LAN address, where crypto.subtle is missing altogether, and
 * every approval check failed there. So sha256Hex tries crypto.subtle first
 * and falls back to sha256HexSync, a plain TypeScript version of the same
 * algorithm (FIPS 180-4) that gives the same answer everywhere.
 */

/** The first 32 bits of the fractional parts of the cube roots of the first 64 primes. */
const ROUND_CONSTANTS = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** The first 32 bits of the fractional parts of the square roots of the first 8 primes. */
const INITIAL_HASH = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
];

function rotateRight(word: number, bits: number): number {
  return (word >>> bits) | (word << (32 - bits));
}

/** Lowercase hex of a list of bytes. */
function toHex(bytes: Uint8Array): string {
  let hex = "";
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, "0");
  return hex;
}

/**
 * SHA-256 of the UTF-8 bytes of a string, as lowercase hex, with no Web Crypto.
 *
 * Slower than crypto.subtle, but a run's text is a few kilobytes, which this
 * hashes in well under a millisecond.
 */
export function sha256HexSync(text: string): string {
  const message = new TextEncoder().encode(text);
  const length = message.length;
  // The message, a single 1 bit, zeros, then the length in bits as a 64-bit
  // number, padded out to a whole number of 64-byte blocks.
  const paddedLength = Math.ceil((length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(message);
  padded[length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 8, Math.floor(length / 0x20000000));
  view.setUint32(paddedLength - 4, (length * 8) >>> 0);

  const hash = new Uint32Array(INITIAL_HASH);
  const schedule = new Uint32Array(64);
  for (let block = 0; block < paddedLength; block += 64) {
    for (let i = 0; i < 16; i++) schedule[i] = view.getUint32(block + i * 4);
    for (let i = 16; i < 64; i++) {
      const early = schedule[i - 15];
      const late = schedule[i - 2];
      const sigma0 = rotateRight(early, 7) ^ rotateRight(early, 18) ^ (early >>> 3);
      const sigma1 = rotateRight(late, 17) ^ rotateRight(late, 19) ^ (late >>> 10);
      // A Uint32Array keeps the sum modulo 2^32 on its own.
      schedule[i] = schedule[i - 16] + sigma0 + schedule[i - 7] + sigma1;
    }

    let a = hash[0];
    let b = hash[1];
    let c = hash[2];
    let d = hash[3];
    let e = hash[4];
    let f = hash[5];
    let g = hash[6];
    let h = hash[7];
    for (let i = 0; i < 64; i++) {
      const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choose = (e & f) ^ (~e & g);
      const first = (h + sum1 + choose + ROUND_CONSTANTS[i] + schedule[i]) | 0;
      const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const second = (sum0 + majority) | 0;
      h = g;
      g = f;
      f = e;
      e = (d + first) | 0;
      d = c;
      c = b;
      b = a;
      a = (first + second) | 0;
    }
    hash[0] += a;
    hash[1] += b;
    hash[2] += c;
    hash[3] += d;
    hash[4] += e;
    hash[5] += f;
    hash[6] += g;
    hash[7] += h;
  }

  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) outView.setUint32(i * 4, hash[i]);
  return toHex(out);
}

/**
 * Hash the text of a run the same way the server does.
 *
 * Uses crypto.subtle where the browser offers it and the plain version
 * otherwise (see the top of this file), so a plain http address still checks
 * approvals.
 */
export async function sha256Hex(text: string): Promise<string> {
  const subtle = typeof crypto === "undefined" ? undefined : crypto.subtle;
  if (subtle) {
    try {
      const digest = await subtle.digest("SHA-256", new TextEncoder().encode(text));
      return toHex(new Uint8Array(digest));
    } catch {
      // Refused for some other reason: the plain version still answers.
    }
  }
  return sha256HexSync(text);
}
