/**
 * What the desktop app, the phone and the relay say to each other.
 *
 * The relay is a small service on the internet that passes messages between
 * a phone and the computer, so neither has to accept connections from the
 * internet: both open a WebSocket out to it. It cannot read what it passes
 * (noise.ts encrypts it end to end); it knows only which computer a message
 * is for, by the computer's ID (relay-auth.ts).
 *
 * Each computer has a room at the relay, with two doors:
 *  - /v1/desktop/<id> for the computer itself, which signs in there to prove
 *    the room is its own before anything is passed to it;
 *  - /v1/phone/<id> for any number of phones.
 *
 * The link's encrypted messages travel as binary WebSocket messages:
 *  - between a phone and the relay, each is one Noise message as it is,
 *    because a phone's connection carries only that phone's link;
 *  - between the computer and the relay, each starts with a channel number
 *    (4 bytes, big-endian), then the Noise message. The relay gives every
 *    phone that connects a channel of its own, so the computer can tell its
 *    phones apart over its one connection.
 *
 * Everything else is a short JSON text message, called a control message
 * here. By direction:
 *  - relay to computer: challenge (sign in by signing this), ready (signed
 *    in), open (a phone connected, on this channel), close (that phone
 *    left), pong;
 *  - computer to relay: auth (the signed challenge), close (send that phone
 *    away), ping;
 *  - relay to phone: online (the computer is there), offline (it is not),
 *    pong;
 *  - phone to relay: ping.
 * "online" always means the computer has just connected and knows nothing of
 * this phone yet, so the phone starts a new handshake. Pings keep idle
 * connections from being dropped along the way; the relay answers them
 * without waking the room. Both apps send their first ping as soon as the
 * connection opens: the Workers runtime may hold on to a connection that has
 * sent nothing yet for some seconds after the relay closes it (until its room
 * next sleeps), and the app would hear of the close only then.
 *
 * Reading is strict: anything that is not exactly one of these messages is
 * refused, so the relay and both apps always agree on what a message means.
 */
import { fromBase64UrlOfLength, toBase64Url, type Bytes } from "./bytes.js";
import { KEY_BYTES } from "./keys.js";
import { CHALLENGE_BYTES, isDesktopId, SIGNATURE_BYTES } from "./relay-auth.js";

export type Role = "desktop" | "phone";

/** The address of one of a room's doors, after the relay's own address. */
export function relayPath(role: Role, desktopId: string): string {
  if (!isDesktopId(desktopId)) throw new Error("That is not a computer's ID.");
  return `/v1/${role}/${desktopId}`;
}

/** Which door an address is, or null when it is none. */
export function readRelayPath(pathname: string): { role: Role; desktopId: string } | null {
  const match = /^\/v1\/(desktop|phone)\/([^/]+)$/.exec(pathname);
  if (match === null || !isDesktopId(match[2])) return null;
  return { role: match[1] === "desktop" ? "desktop" : "phone", desktopId: match[2] };
}

/**
 * The relay's own address, such as https://relay.example.com, written the one
 * way a browser writes it, or null when the text is not an address the apps
 * may use. It must be https, except for a relay on the same machine, which is
 * how one is tried out (`npm run dev` puts it at http://localhost:8787), and
 * nothing may follow the host and port.
 */
export function readRelayOrigin(text: string): string | null {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  const onThisMachine = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && onThisMachine)) return null;
  // No user name or password, path, query or fragment, not even an empty one.
  return url.href === `${url.origin}/` ? url.origin : null;
}

/** The WebSocket address of one of a room's doors, at the relay with this address. */
export function relaySocketUrl(relayOrigin: string, role: Role, desktopId: string): string {
  const origin = readRelayOrigin(relayOrigin);
  if (origin === null) throw new Error("That is not a relay's address.");
  return origin.replace(/^http/, "ws") + relayPath(role, desktopId);
}

/** The size of the channel number in front of each binary message between the computer and the relay. */
export const CHANNEL_BYTES = 4;
/** The biggest message the relay passes on. Any Noise message fits (noise.ts). */
export const MAX_RELAY_MESSAGE_BYTES = 64 * 1024;
/** The biggest binary message between the computer and the relay: a channel number and the biggest message. */
export const MAX_FRAME_BYTES = CHANNEL_BYTES + MAX_RELAY_MESSAGE_BYTES;
/** The longest control message. The longest real one, auth, is under 200 characters. */
export const MAX_CONTROL_LENGTH = 512;
/** The highest channel number. Channels start at 1. */
export const MAX_CHANNEL = 0xffffffff;

export function isChannel(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= MAX_CHANNEL;
}

/** A binary message between the computer and the relay: the phone's channel, then the message for or from it. */
export function addChannel(channel: number, message: Bytes): Bytes {
  if (!isChannel(channel)) throw new Error("That is not a channel number.");
  if (message.length === 0 || message.length > MAX_RELAY_MESSAGE_BYTES) throw new Error("A message for the relay is the wrong size.");
  const frame = new Uint8Array(CHANNEL_BYTES + message.length);
  new DataView(frame.buffer).setUint32(0, channel, false);
  frame.set(message, CHANNEL_BYTES);
  return frame;
}

/** The channel and the message in a binary message addChannel made, or null when it is not one. */
export function readChannel(frame: Bytes): { channel: number; message: Bytes } | null {
  if (frame.length <= CHANNEL_BYTES || frame.length > MAX_FRAME_BYTES) return null;
  const channel = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(0, false);
  if (channel === 0) return null;
  return { channel, message: frame.subarray(CHANNEL_BYTES) };
}

export type Control =
  | { type: "challenge"; challenge: Bytes }
  | { type: "auth"; publicKey: Bytes; signature: Bytes }
  | { type: "ready" }
  | { type: "open"; channel: number }
  | { type: "close"; channel: number }
  | { type: "online" }
  | { type: "offline" }
  | { type: "ping" }
  | { type: "pong" };

/**
 * A ping and its answer as they are written. The relay has its platform
 * answer pings without waking it, which works by matching the text exactly,
 * so it needs them spelled out.
 */
export const PING = '{"t":"ping"}';
export const PONG = '{"t":"pong"}';

export function writeControl(control: Control): string {
  switch (control.type) {
    case "challenge":
      return JSON.stringify({ t: "challenge", n: toBase64Url(control.challenge) });
    case "auth":
      return JSON.stringify({ t: "auth", key: toBase64Url(control.publicKey), sig: toBase64Url(control.signature) });
    case "open":
    case "close":
      return JSON.stringify({ t: control.type, c: control.channel });
    default:
      return JSON.stringify({ t: control.type });
  }
}

/** Reads a control message, or gives null for anything that is not exactly one. */
export function readControl(text: string): Control | null {
  if (text.length > MAX_CONTROL_LENGTH) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  // Just checked to be a plain object, so its fields can be looked at.
  const fields = value as Record<string, unknown>;
  // Each kind has exactly its own fields, and no others.
  const names = Object.keys(fields).sort().join(",");
  const type = fields.t;
  switch (type) {
    case "challenge": {
      const challenge = names === "n,t" ? fromBase64UrlOfLength(fields.n, CHALLENGE_BYTES) : null;
      return challenge === null ? null : { type, challenge };
    }
    case "auth": {
      if (names !== "key,sig,t") return null;
      const publicKey = fromBase64UrlOfLength(fields.key, KEY_BYTES);
      const signature = fromBase64UrlOfLength(fields.sig, SIGNATURE_BYTES);
      return publicKey === null || signature === null ? null : { type, publicKey, signature };
    }
    case "open":
    case "close": {
      const channel = fields.c;
      return names === "c,t" && isChannel(channel) ? { type, channel } : null;
    }
    case "ready":
    case "online":
    case "offline":
    case "ping":
    case "pong":
      return names === "t" ? { type } : null;
    default:
      return null;
  }
}

// Why the relay closed a connection. WebSocket leaves the codes from 4000 up
// to each application.

/** The computer connected again, and the new connection took this one's place. */
export const CLOSE_REPLACED = 4000;
/** The computer did not prove the room was its own. */
export const CLOSE_SIGN_IN_FAILED = 4001;
/** The computer sent this phone away. */
export const CLOSE_SENT_AWAY = 4002;
/** The room already has as many connections of this kind as it takes. */
export const CLOSE_FULL = 4003;
/** A message that was not one of the ones above, or came at the wrong time. */
export const CLOSE_BROKEN = 4004;
/** Too many messages, too quickly. */
export const CLOSE_TOO_FAST = 4005;
/** A message over the size limit. */
export const CLOSE_TOO_BIG = 4006;
