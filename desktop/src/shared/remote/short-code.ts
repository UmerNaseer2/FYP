/**
 * The short pairing code: eight letters and numbers that a person reads off the
 * computer's screen and types into a browser, for a laptop that has no camera
 * to scan the QR code with.
 *
 * A pairing link (pairing.ts) holds about 108 characters, far too many to type,
 * and it must stay out of the relay's reach, because a relay that could change
 * the computer's key inside one could listen in. So the computer locks the
 * whole link in a box with a key made from the code, and the relay keeps the box
 * for a few minutes under a label also made from the code. The browser works
 * out the same label and key from what the person typed, takes the box, opens
 * it, and carries on exactly as if it had scanned the QR code.
 *
 * Eight symbols out of 32 make about a trillion codes, which is few for a
 * secret, so three things stand behind them:
 * - A browser's guess costs a request, and the relay limits those (src/worker.ts
 *   in relay/). A box also goes to the first one to take it.
 * - The relay sees the label, so a hacked relay could try codes by itself. Each
 *   try costs CODE_ROUNDS rounds of PBKDF2, and a box lasts PAIRING_LIFETIME_MS.
 *   All the codes would take far longer than that on any plausible hardware.
 * - Opening a box pairs nothing. The computer still asks its person to Allow or
 *   Deny (main/phone-host.ts in desktop/), naming the browser that asked.
 *
 * A code is a secret until it is used or runs out, like the link it opens, so
 * never log or print it, nor its label or its key.
 */
import { concatBytes, randomBytes, readUtf8, toBase64Url, utf8, type Bytes } from "./bytes.js";
import type { Key } from "./keys.js";

/** How many symbols a code has. */
export const SHORT_CODE_LENGTH = 8;
/**
 * Rounds of PBKDF2 for each try at a code. On the Mac this was built on, which
 * has an M3, it took about a third of a second. An older phone may take a few
 * seconds, which a person who has just typed a code can wait for once.
 */
export const CODE_ROUNDS = 2_000_000;
/** The biggest box the relay keeps. A box holds one pairing link, which is far smaller than this. */
export const MAX_CODE_BOX_BYTES = 2048;

/**
 * The symbols a code may use: the digits and capital letters without 0, O, 1
 * and I, which look alike on a screen. Exactly 32 of them, so that the low five
 * bits of a random byte choose among them evenly.
 */
const SYMBOLS = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const SALT = "Schema Studio pairing code 1";
const BOX = utf8("Schema Studio pairing box 1");
const IV_BYTES = 12;

/** What a code gives both ends: where its box is kept, and what locks it. */
export type CodeKeys = { label: string; key: Key };

/** A new random code, as readShortCode gives it. */
export function makeShortCode(): string {
  let code = "";
  for (const byte of randomBytes(SHORT_CODE_LENGTH)) code += SYMBOLS[byte & 31];
  return code;
}

/** A code from what a person typed, in either case and with or without spaces and a hyphen, or null when it cannot be one. */
export function readShortCode(typed: string): string | null {
  const code = typed.toUpperCase().replace(/[\s-]/g, "");
  if (code.length !== SHORT_CODE_LENGTH) return null;
  for (const symbol of code) {
    if (!SYMBOLS.includes(symbol)) return null;
  }
  return code;
}

/** A code as a screen shows it, split in two so a person can hold each half in mind. */
export function showShortCode(code: string): string {
  return `${code.slice(0, SHORT_CODE_LENGTH / 2)}-${code.slice(SHORT_CODE_LENGTH / 2)}`;
}

/**
 * The label and the key a code makes. It is slow on purpose (CODE_ROUNDS).
 *
 * The salt cannot be random, because the browser has to work out the label
 * before it has anything from the computer. It holds the relay's address, so a
 * table of labels worked out for one relay is no use against another.
 *
 * PBKDF2 makes one output, which is then split: asking it for two outputs would
 * make an honest device pay for both, while an attacker testing a guess would
 * need only the first.
 */
export async function makeCodeKeys(code: string, relayOrigin: string): Promise<CodeKeys> {
  const password = await crypto.subtle.importKey("raw", utf8(code), "PBKDF2", false, ["deriveBits"]);
  const made = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: utf8(`${SALT} ${relayOrigin}`), iterations: CODE_ROUNDS },
    password,
    256,
  );
  const base = await crypto.subtle.importKey("raw", made, "HKDF", false, ["deriveBits"]);
  const part = async (name: string): Promise<Bytes> =>
    new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: utf8(name) }, base, 256));
  const key = await crypto.subtle.importKey("raw", await part("lock"), "AES-GCM", false, ["encrypt", "decrypt"]);
  return { label: toBase64Url(await part("label")), key };
}

/** A box holding this text, which only the same code can open. */
export async function lockCodeBox(keys: CodeKeys, text: string): Promise<Bytes> {
  const iv = randomBytes(IV_BYTES);
  const sealed = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: BOX }, keys.key, utf8(text));
  return concatBytes(iv, new Uint8Array(sealed));
}

/** The text in a box, or null when this code does not open it, or something changed it. */
export async function openCodeBox(keys: CodeKeys, box: Bytes): Promise<string | null> {
  if (box.length <= IV_BYTES || box.length > MAX_CODE_BOX_BYTES) return null;
  try {
    const opened = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: box.slice(0, IV_BYTES), additionalData: BOX },
      keys.key,
      box.slice(IV_BYTES),
    );
    return readUtf8(new Uint8Array(opened));
  } catch {
    return null;
  }
}
