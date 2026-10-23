/**
 * Pairing a phone with the computer, and how each connection between them
 * opens.
 *
 * To pair, the computer shows a link, as a QR code and as text to copy:
 *
 *   https://<relay>/#pair=v1.<computer's ID>.<computer's key>.<one-time secret>
 *
 * Opening it loads the phone app from the relay and gives it what it needs:
 * which room at the relay to knock at (the computer's ID, relay-auth.ts), the
 * computer's Noise key, so the phone can tell it is talking to that computer
 * and no other, and a secret that shows the computer the phone saw the link.
 * All of that comes after "#", the part of a link that browsers never send
 * anywhere, so the relay never learns the key or the secret.
 *
 * Every connection then starts with a Noise IK handshake (noise.ts), the
 * phone first, and the first message carries the phone's opening, one of:
 *  - pair: the secret from the link, and a name for the phone that the
 *    computer shows in its list of paired phones;
 *  - session: the phone is paired already and wants to use the link.
 * Neither needs to say which phone it is: the handshake proves that by the
 * phone's own key. The computer's answer travels in the handshake's second
 * message.
 *
 * Someone can record a first message and send it again. That gets them
 * nothing: a secret works once, for a few minutes, and only ever pairs the
 * key of the phone that sent it, and the keys of the session that follows
 * need the throwaway key that only the real phone holds.
 */
import { fromBase64UrlOfLength, toBase64Url, utf8, type Bytes } from "./bytes.js";
import { hasExactly, readJsonObject } from "./json.js";
import { KEY_BYTES } from "./keys.js";
import { isDesktopId } from "./relay-auth.js";
import { readRelayOrigin } from "./relay-protocol.js";

/** Bound into every handshake between a phone and the computer (noise.ts), so that one made for anything else can never pass for one. */
export const PHONE_LINK_PROLOGUE = utf8("Schema Studio phone link 1");

/** The size of a pairing link's one-time secret. */
export const PAIRING_SECRET_BYTES = 32;
/** How long a pairing link works for, from when the computer shows it. */
export const PAIRING_LIFETIME_MS = 5 * 60_000;
/** The longest name a phone or computer is shown with, in characters. */
export const MAX_DEVICE_NAME_LENGTH = 64;

/**
 * The longest name read from a message, in UTF-16 code units, before it is
 * cleaned and cut to MAX_DEVICE_NAME_LENGTH. A name the other side cleaned
 * already is at most 128 (an emoji takes two), so this leaves room to spare.
 */
const MAX_NAME_IN_MESSAGE = 256;
/** The longest text readPairingLink looks at. A real link is under 300 characters. */
const MAX_PAIRING_LINK_LENGTH = 1024;
/** The version of the messages below. The computer and the phone refuse any other. */
const VERSION = 1;

/** What a pairing link holds, besides the relay's address. */
export type PairingCode = {
  /** The computer's ID, which names its room at the relay. */
  desktopId: string;
  /** The computer's Noise public key. */
  desktopKey: Bytes;
  /** The one-time secret. */
  secret: Bytes;
};

/** The link the computer shows to pair a phone. */
export function writePairingLink(relayOrigin: string, code: PairingCode): string {
  const origin = readRelayOrigin(relayOrigin);
  if (origin === null) throw new Error("That is not a relay's address.");
  if (!isDesktopId(code.desktopId)) throw new Error("That is not a computer's ID.");
  if (code.desktopKey.length !== KEY_BYTES) throw new Error("A computer's key is the wrong size.");
  if (code.secret.length !== PAIRING_SECRET_BYTES) throw new Error("A pairing secret is the wrong size.");
  return `${origin}/#pair=v1.${code.desktopId}.${toBase64Url(code.desktopKey)}.${toBase64Url(code.secret)}`;
}

/**
 * Reads a pairing link, or gives null when the text is not exactly one.
 * Spaces and line breaks around it are ignored, since copying and pasting
 * often adds them. The phone app also checks that the relay in the link is
 * the one it was loaded from.
 */
export function readPairingLink(text: string): { relayOrigin: string; code: PairingCode } | null {
  const link = text.trim();
  if (link.length > MAX_PAIRING_LINK_LENGTH) return null;
  // An ID is 16 bytes and a key or secret 32, which base64url writes in 22 and 43 characters.
  const match = /^([^#]+)\/#pair=v1\.([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{43})$/.exec(link);
  if (match === null) return null;
  // The relay's address must be written exactly as writePairingLink writes it.
  const relayOrigin = match[1];
  const desktopId = match[2];
  if (readRelayOrigin(relayOrigin) !== relayOrigin || !isDesktopId(desktopId)) return null;
  const desktopKey = fromBase64UrlOfLength(match[3], KEY_BYTES);
  const secret = fromBase64UrlOfLength(match[4], PAIRING_SECRET_BYTES);
  if (desktopKey === null || secret === null) return null;
  return { relayOrigin, code: { desktopId, desktopKey, secret } };
}

/** What the phone says in the handshake's first message. */
export type Opening = { kind: "pair"; secret: Bytes; name: string } | { kind: "session" };

export function writeOpening(opening: Opening): Bytes {
  if (opening.kind === "session") return utf8(JSON.stringify({ v: VERSION, kind: "session" }));
  if (opening.secret.length !== PAIRING_SECRET_BYTES) throw new Error("A pairing secret is the wrong size.");
  const name = cleanDeviceName(opening.name, "Phone");
  return utf8(JSON.stringify({ v: VERSION, kind: "pair", secret: toBase64Url(opening.secret), name }));
}

/** Reads what writeOpening writes, or gives null for anything else. The phone's name comes back cleaned. */
export function readOpening(payload: Bytes): Opening | null {
  const fields = readJsonObject(payload);
  if (fields === null || fields.v !== VERSION) return null;
  if (fields.kind === "session") return hasExactly(fields, "v", "kind") ? { kind: "session" } : null;
  if (fields.kind !== "pair" || !hasExactly(fields, "v", "kind", "secret", "name")) return null;
  const secret = fromBase64UrlOfLength(fields.secret, PAIRING_SECRET_BYTES);
  const name = fields.name;
  if (secret === null || typeof name !== "string" || name.length > MAX_NAME_IN_MESSAGE) return null;
  return { kind: "pair", secret, name: cleanDeviceName(name, "Phone") };
}

/**
 * Why the computer turned a phone away. The phone app says each in its own
 * words.
 *  - expired-code: the pairing link is out of date, was used already, or is
 *    not the computer's latest one.
 *  - too-many-phones: the computer has as many paired phones as it takes.
 *  - not-paired: the computer does not know this phone, or it was removed.
 */
export type OpeningRefusal = "expired-code" | "too-many-phones" | "not-paired";
const REFUSALS: readonly OpeningRefusal[] = ["expired-code", "too-many-phones", "not-paired"];

/** The computer's answer to an opening: its own name when the phone may go on. */
export type OpeningAnswer = { ok: true; name: string } | { ok: false; reason: OpeningRefusal };

export function writeOpeningAnswer(answer: OpeningAnswer): Bytes {
  if (answer.ok) return utf8(JSON.stringify({ v: VERSION, ok: true, name: cleanDeviceName(answer.name, "Computer") }));
  if (!REFUSALS.includes(answer.reason)) throw new Error("That is not a reason the phone app knows.");
  return utf8(JSON.stringify({ v: VERSION, ok: false, reason: answer.reason }));
}

/** Reads what writeOpeningAnswer writes, or gives null for anything else. */
export function readOpeningAnswer(payload: Bytes): OpeningAnswer | null {
  const fields = readJsonObject(payload);
  if (fields === null || fields.v !== VERSION) return null;
  if (fields.ok === true) {
    const name = fields.name;
    if (!hasExactly(fields, "v", "ok", "name") || typeof name !== "string" || name.length > MAX_NAME_IN_MESSAGE) return null;
    return { ok: true, name: cleanDeviceName(name, "Computer") };
  }
  const reason = REFUSALS.find((known) => known === fields.reason);
  return fields.ok === false && hasExactly(fields, "v", "ok", "reason") && reason !== undefined ? { ok: false, reason } : null;
}

/**
 * Runs of spaces, line breaks and characters that show nothing: control and
 * format characters (which include the ones that turn text right to left),
 * and halves of a broken emoji. The two joiners, U+200C and U+200D, are left
 * alone, because many emoji and some languages need them.
 */
const INVISIBLE_RUN = /(?:(?![\u200c\u200d])[\s\p{Cc}\p{Cf}\p{Cs}])+/gu;

/**
 * A name as the other side's screens show it: each run of spaces becomes one
 * space, characters that show nothing are removed, and it is cut to
 * MAX_DEVICE_NAME_LENGTH characters. A name with nothing left to show
 * becomes the fallback.
 */
export function cleanDeviceName(name: string, fallback: string): string {
  const cleaned = name.replace(INVISIBLE_RUN, (run) => (/\s/u.test(run) ? " " : "")).trim();
  // Array.from splits by character, so the cut never leaves half an emoji.
  const cut = Array.from(cleaned).slice(0, MAX_DEVICE_NAME_LENGTH).join("").trim();
  return /[^\s\u200c\u200d]/u.test(cut) ? cut : fallback;
}
