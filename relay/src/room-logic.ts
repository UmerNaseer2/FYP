/**
 * The rules of a room at the relay: who may connect, how the computer signs
 * in, and where each message goes.
 *
 * A room belongs to one computer (shared/remote/relay-auth.ts) and is where
 * its phones find it. The computer connects at the room's desktop door and
 * must sign in before anything is passed to it; phones connect at the phone
 * door, and each one gets a channel of its own on the computer's connection
 * (shared/remote/relay-protocol.ts). The relay cannot read what it passes, so
 * all it has to get right is where each message goes.
 *
 * The rules are kept apart from Cloudflare's Durable Object (room.ts) so the
 * tests can run them in Node with pretend connections. Everything the room
 * must remember about a connection is written to the connection itself
 * (serializeAttachment): Cloudflare puts an idle room to sleep while keeping
 * its connections open, and a room that wakes up is built again from them.
 */
import { fromBase64Url, randomBytes, toBase64Url, type Bytes } from "./shared/remote/bytes.js";
import { CHALLENGE_BYTES, checkChallenge } from "./shared/remote/relay-auth.js";
import {
  addChannel,
  CHANNEL_BYTES,
  CLOSE_BROKEN,
  CLOSE_FULL,
  CLOSE_REPLACED,
  CLOSE_SENT_AWAY,
  CLOSE_SIGN_IN_FAILED,
  CLOSE_TOO_BIG,
  CLOSE_TOO_FAST,
  MAX_CONTROL_LENGTH,
  MAX_FRAME_BYTES,
  MAX_RELAY_MESSAGE_BYTES,
  PONG,
  readChannel,
  readControl,
  writeControl,
} from "./shared/remote/relay-protocol.js";

/** What the rules need of a connection. Cloudflare's WebSocket has all of it. */
export interface Socket {
  send(message: string | Bytes): void;
  close(code?: number, reason?: string): void;
  serializeAttachment(value: unknown): void;
}

/** A connection at the desktop door that has been sent a challenge and has not signed in yet. */
type SigningIn = {
  role: "desktop";
  step: "signing-in";
  desktopId: string;
  /** The challenge it must sign, as base64url. */
  challenge: string;
  /** When its time to sign in runs out, in milliseconds since 1970. */
  deadline: number;
  /** True once it has answered, so a second answer is refused while the first is checked. */
  answered: boolean;
};
type SignedIn = { role: "desktop"; step: "ready" };
/** A phone's connection. Channel 0 means it has none, because the computer is not there. */
type PhoneState = { role: "phone"; channel: number };

/**
 * What the room remembers about a connection. A state is replaced, never
 * changed in place, so what the room holds in memory is always what it last
 * wrote to the connection.
 */
export type SocketState = SigningIn | SignedIn | PhoneState;

/** How long a computer has to sign in after it connects. */
export const SIGN_IN_MS = 10_000;
/**
 * How many connections may be signing in at once. A computer that connects
 * again may still have one signing in from before, so two are allowed; one
 * more sends the oldest away, so a stranger who opens many cannot pile them
 * up in the room.
 */
export const MAX_SIGNING_IN = 2;
/** How many phones may be connected to one computer at once. */
export const MAX_PHONES = 8;

// Each connection may send only so many messages. A message takes a token
// from the connection's bucket, which fills again steadily up to its limit,
// and a connection whose bucket is empty is sent away. The computer's limit
// is higher because it answers every phone over its one connection, and a
// long answer comes in many pieces (shared/remote/link.ts). The buckets are
// kept in memory only, so they are full again after the room has slept,
// which matters little: a room sleeps only when its connections are quiet.
export const PHONE_BURST = 100;
export const PHONE_PER_SECOND = 10;
export const DESKTOP_BURST = 2048;
export const DESKTOP_PER_SECOND = 256;

const READY = writeControl({ type: "ready" });
const ONLINE = writeControl({ type: "online" });
const OFFLINE = writeControl({ type: "offline" });

// Why a connection was closed, for whoever reads the desktop app's or the
// phone's logs. A close reason may be at most 123 bytes.
const REPLACED = "This computer connected again, and the new connection took over.";
const NOT_PROVEN = "The computer did not prove this room is its own.";
const TOO_LATE = "The computer did not sign in in time.";
const SENT_AWAY = "The computer ended this connection.";
const PHONES_FULL = "Too many phones are connected to this computer.";
const SIGNING_IN_FULL = "Too many connections are signing in to this room.";
const BROKEN = "The relay did not understand a message.";
const TOO_FAST = "Too many messages, too quickly.";
const TOO_BIG = "A message was too big.";

export class RoomLogic {
  private readonly sockets = new Map<Socket, SocketState>();
  /** Which phone is on each channel, while the computer is signed in. */
  private readonly channels = new Map<number, Socket>();
  private readonly buckets = new Map<Socket, { tokens: number; at: number }>();
  /** The computer's signed-in connection, or null when it is not there. */
  private desktop: Socket | null = null;

  /**
   * Builds the room from its open connections and what was written to each,
   * which is everything when the room has just woken up and nothing when it
   * is new.
   */
  constructor(sockets: Iterable<[Socket, SocketState]>) {
    for (const [socket, state] of sockets) {
      if (state.role === "desktop" && state.step === "ready" && this.desktop !== null) {
        // Never expected, because a computer's new connection sends the old
        // one away before it is signed in, but two must never be at once.
        this.sendAway(socket, CLOSE_REPLACED, REPLACED, false);
        continue;
      }
      this.sockets.set(socket, state);
      if (state.role === "desktop" && state.step === "ready") this.desktop = socket;
    }
    for (const [socket, state] of this.sockets) {
      if (state.role !== "phone") continue;
      if (this.desktop === null) {
        // A phone on a channel with no computer signed in is never expected
        // either, but if it happens the phone must hear the computer is gone.
        if (state.channel !== 0) {
          this.setState(socket, { role: "phone", channel: 0 });
          this.send(socket, OFFLINE);
        }
      } else if (state.channel !== 0 && !this.channels.has(state.channel)) {
        this.channels.set(state.channel, socket);
      } else {
        // Nor is a phone with no channel while the computer is signed in, or
        // one on another phone's channel. A fresh channel puts either right.
        this.connect(socket);
      }
    }
  }

  /** A connection at the desktop door: it is sent a challenge, and must sign in by SIGN_IN_MS from now. */
  addDesktop(socket: Socket, desktopId: string, now: number): void {
    let count = 0;
    let oldest: Socket | null = null;
    let oldestDeadline = Infinity;
    for (const [other, state] of this.sockets) {
      if (state.role !== "desktop" || state.step !== "signing-in") continue;
      count++;
      if (state.deadline < oldestDeadline) {
        oldest = other;
        oldestDeadline = state.deadline;
      }
    }
    if (count >= MAX_SIGNING_IN && oldest !== null) this.sendAway(oldest, CLOSE_FULL, SIGNING_IN_FULL);
    const challenge = randomBytes(CHALLENGE_BYTES);
    this.setState(socket, {
      role: "desktop",
      step: "signing-in",
      desktopId,
      challenge: toBase64Url(challenge),
      deadline: now + SIGN_IN_MS,
      answered: false,
    });
    this.send(socket, writeControl({ type: "challenge", challenge }));
  }

  /** A connection at the phone door: it is given a channel if the computer is there, and told it is offline if not. */
  addPhone(socket: Socket): void {
    let phones = 0;
    for (const state of this.sockets.values()) if (state.role === "phone") phones++;
    if (phones >= MAX_PHONES) {
      // Never remembered, so nothing is written to it and a waking room skips it.
      try {
        socket.close(CLOSE_FULL, PHONES_FULL);
      } catch {
        // Closed already.
      }
      return;
    }
    this.setState(socket, { role: "phone", channel: 0 });
    if (this.desktop !== null) this.connect(socket);
    else this.send(socket, OFFLINE);
  }

  /** A message from a connection. `now` is the time in milliseconds since 1970. */
  async receive(socket: Socket, data: string | Bytes, now: number): Promise<void> {
    const state = this.sockets.get(socket);
    // A connection the room has sent away may still have messages on their way.
    if (state === undefined) return;
    if (!this.take(socket, state, now)) {
      this.sendAway(socket, CLOSE_TOO_FAST, TOO_FAST);
      return;
    }
    if (state.role === "phone") this.fromPhone(socket, state, data);
    else if (state.step === "ready") this.fromDesktop(socket, data);
    else await this.signIn(socket, state, data);
  }

  /** A connection has closed, from either end. */
  closed(socket: Socket): void {
    if (!this.sockets.has(socket)) return;
    try {
      socket.serializeAttachment(null);
    } catch {
      // Closed already, so a waking room will not be handed it.
    }
    this.forget(socket, true);
  }

  /**
   * Sends away the connections whose time to sign in has run out, including
   * any whose answer is still being checked (signIn looks again when it is).
   */
  expire(now: number): void {
    for (const [socket, state] of [...this.sockets]) {
      if (state.role === "desktop" && state.step === "signing-in" && state.deadline <= now) {
        this.sendAway(socket, CLOSE_SIGN_IN_FAILED, TOO_LATE);
      }
    }
  }

  /** When the next connection's time to sign in runs out, or null when none is signing in. */
  nextDeadline(): number | null {
    let next: number | null = null;
    for (const state of this.sockets.values()) {
      if (state.role === "desktop" && state.step === "signing-in" && (next === null || state.deadline < next)) next = state.deadline;
    }
    return next;
  }

  private fromPhone(phone: Socket, state: PhoneState, data: string | Bytes): void {
    if (typeof data === "string") {
      if (data.length > MAX_CONTROL_LENGTH) this.sendAway(phone, CLOSE_TOO_BIG, TOO_BIG);
      else if (readControl(data)?.type === "ping") this.send(phone, PONG);
      else this.sendAway(phone, CLOSE_BROKEN, BROKEN);
      return;
    }
    if (data.length > MAX_RELAY_MESSAGE_BYTES) {
      this.sendAway(phone, CLOSE_TOO_BIG, TOO_BIG);
      return;
    }
    if (data.length === 0) {
      this.sendAway(phone, CLOSE_BROKEN, BROKEN);
      return;
    }
    // A phone with no channel has been told the computer is not there, so
    // what it sends was meant for a computer that has gone.
    if (state.channel === 0 || this.desktop === null) return;
    this.send(this.desktop, addChannel(state.channel, data));
  }

  private fromDesktop(desktop: Socket, data: string | Bytes): void {
    if (typeof data === "string") {
      if (data.length > MAX_CONTROL_LENGTH) {
        this.sendAway(desktop, CLOSE_TOO_BIG, TOO_BIG);
        return;
      }
      const control = readControl(data);
      if (control?.type === "ping") {
        this.send(desktop, PONG);
      } else if (control?.type === "close") {
        // A phone that has already left needs nothing more. One that has not
        // is sent away without the computer being told what it asked for.
        const phone = this.channels.get(control.channel);
        if (phone !== undefined) this.sendAway(phone, CLOSE_SENT_AWAY, SENT_AWAY, false);
      } else {
        this.sendAway(desktop, CLOSE_BROKEN, BROKEN);
      }
      return;
    }
    if (data.length > MAX_FRAME_BYTES) {
      this.sendAway(desktop, CLOSE_TOO_BIG, TOO_BIG);
      return;
    }
    const frame = readChannel(data);
    if (frame === null) {
      this.sendAway(desktop, CLOSE_BROKEN, BROKEN);
      return;
    }
    // A phone that has just left may still have messages on their way to it,
    // and they are dropped.
    const phone = this.channels.get(frame.channel);
    if (phone !== undefined) this.send(phone, frame.message);
  }

  private async signIn(socket: Socket, state: SigningIn, data: string | Bytes): Promise<void> {
    if (typeof data !== "string") {
      this.sendAway(socket, CLOSE_BROKEN, BROKEN);
      return;
    }
    if (data.length > MAX_CONTROL_LENGTH) {
      this.sendAway(socket, CLOSE_TOO_BIG, TOO_BIG);
      return;
    }
    const control = readControl(data);
    if (control?.type === "ping") {
      this.send(socket, PONG);
      return;
    }
    if (control?.type !== "auth" || state.answered) {
      this.sendAway(socket, CLOSE_BROKEN, BROKEN);
      return;
    }
    // Checking the signature waits on Web Crypto, and the room handles other
    // messages meanwhile. So the answer is noted first (a second one is
    // refused), and afterwards the room makes sure nothing happened to this
    // connection while it waited.
    const answered: SigningIn = { ...state, answered: true };
    this.setState(socket, answered);
    const challenge = fromBase64Url(state.challenge) ?? new Uint8Array(0);
    const good = await checkChallenge(state.desktopId, challenge, control.publicKey, control.signature);
    if (this.sockets.get(socket) !== answered) return;
    if (!good) {
      this.sendAway(socket, CLOSE_SIGN_IN_FAILED, NOT_PROVEN);
      return;
    }
    // The computer has connected again, so its new connection takes over.
    // Its phones hear "offline" and then "online", and start again with it.
    if (this.desktop !== null) this.sendAway(this.desktop, CLOSE_REPLACED, REPLACED);
    this.setState(socket, { role: "desktop", step: "ready" });
    this.desktop = socket;
    this.send(socket, READY);
    for (const [other, otherState] of this.sockets) if (otherState.role === "phone") this.connect(other);
  }

  /**
   * Gives a phone a fresh channel to the signed-in computer. The computer is
   * told ("open") before the phone ("online"), so the phone's first message,
   * which it sends as soon as it hears, never reaches a channel the computer
   * does not know.
   */
  private connect(phone: Socket): void {
    if (this.desktop === null) return;
    const state = this.sockets.get(phone);
    if (state?.role !== "phone") return;
    if (state.channel !== 0 && this.channels.get(state.channel) === phone) this.channels.delete(state.channel);
    const channel = this.newChannel();
    this.channels.set(channel, phone);
    this.setState(phone, { role: "phone", channel });
    this.send(this.desktop, writeControl({ type: "open", channel }));
    this.send(phone, ONLINE);
  }

  /**
   * A random channel number not in use. Random rather than counting up: a
   * room that has slept has forgotten the numbers it gave to phones that have
   * left, and counting again could give a new phone the number of one that
   * has just gone, while the computer's last messages to it are still on
   * their way.
   */
  private newChannel(): number {
    for (;;) {
      const channel = new DataView(randomBytes(CHANNEL_BYTES).buffer).getUint32(0);
      if (channel !== 0 && !this.channels.has(channel)) return channel;
    }
  }

  /** Takes a token from the connection's bucket, or gives false when it is empty. */
  private take(socket: Socket, state: SocketState, now: number): boolean {
    const [burst, perSecond] = state.role === "phone" ? [PHONE_BURST, PHONE_PER_SECOND] : [DESKTOP_BURST, DESKTOP_PER_SECOND];
    const bucket = this.buckets.get(socket) ?? { tokens: burst, at: now };
    bucket.tokens = Math.min(burst, bucket.tokens + (Math.max(0, now - bucket.at) / 1000) * perSecond);
    bucket.at = now;
    this.buckets.set(socket, bucket);
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  }

  /** Stops passing anything to or from a connection, and tells whoever needs to know it has gone. */
  private forget(socket: Socket, tellDesktop: boolean): void {
    const state = this.sockets.get(socket);
    if (state === undefined) return;
    this.sockets.delete(socket);
    this.buckets.delete(socket);
    if (state.role === "phone") {
      if (state.channel !== 0 && this.channels.get(state.channel) === socket) {
        this.channels.delete(state.channel);
        if (tellDesktop && this.desktop !== null) this.send(this.desktop, writeControl({ type: "close", channel: state.channel }));
      }
    } else if (socket === this.desktop) {
      this.desktop = null;
      this.channels.clear();
      for (const [other, otherState] of this.sockets) {
        if (otherState.role !== "phone") continue;
        this.setState(other, { role: "phone", channel: 0 });
        this.send(other, OFFLINE);
      }
    }
  }

  private setState(socket: Socket, state: SocketState): void {
    this.sockets.set(socket, state);
    try {
      socket.serializeAttachment(state);
    } catch {
      // Closed already; its close event tidies up.
    }
  }

  private send(socket: Socket, message: string | Bytes): void {
    try {
      socket.send(message);
    } catch {
      // Closed already; its close event tidies up.
    }
  }

  /**
   * Forgets a connection and closes it. What was written to it is cleared
   * first, because Cloudflare can still hand a closed connection back to a
   * room that wakes up, and the room must not take it for an open one.
   */
  private sendAway(socket: Socket, code: number, reason: string, tellDesktop = true): void {
    try {
      socket.serializeAttachment(null);
    } catch {
      // Closed already.
    }
    this.forget(socket, tellDesktop);
    try {
      socket.close(code, reason);
    } catch {
      // Closed already.
    }
  }
}
