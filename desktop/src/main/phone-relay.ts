/**
 * The computer's connection to the relay, which carries every phone's link
 * (src/shared/remote/relay-protocol.ts describes what goes over it). It signs
 * in to the computer's room on the relay with the signing key, pings so that
 * the connection is not dropped while it is idle, and connects again after a
 * wait whenever the connection is lost.
 *
 * It paces what it sends to stay well inside the relay's limits: the relay
 * closes a connection that sends too much too quickly, and every phone's link
 * would go with it. For the same reason it sends nothing the relay does not
 * expect from a computer. The relay never pings the computer, and it closes
 * the connection for anything from the computer but a ping, a close or a
 * phone's message, so the computer does not even answer a ping.
 *
 * Node's own WebSocket, which Electron's main process has too, does not go
 * through the system's proxy settings, so the phone link cannot reach the
 * relay on a network that lets the web through only by a proxy.
 *
 * Pure apart from the log. The socket, the clock and the random numbers for
 * the waits are passed in, so the tests can play the relay and move time on
 * by hand.
 */
import type { Bytes } from "../shared/remote/bytes";
import type { KeyPair } from "../shared/remote/keys";
import { signChallenge } from "../shared/remote/relay-auth";
import {
  CLOSE_BROKEN,
  CLOSE_FULL,
  CLOSE_REPLACED,
  CLOSE_SIGN_IN_FAILED,
  CLOSE_TOO_BIG,
  CLOSE_TOO_FAST,
  PING,
  addChannel,
  isChannel,
  readChannel,
  readControl,
  relaySocketUrl,
  writeControl,
} from "../shared/remote/relay-protocol";
import { SYSTEM_CLOCK, type Clock } from "./clock";
import { logInfo, logWarn } from "./log";

/** How often the computer pings the relay, so that an idle connection stays open and a lost one is noticed. */
export const PING_EVERY_MS = 30_000;

/**
 * How long the relay may stay silent before the connection counts as lost.
 * It is checked as each ping falls due, so it takes two pings that go
 * unanswered, and a lost connection is noticed within about a minute and a
 * half.
 */
export const SILENT_FOR_MS = 70_000;

/** How long the relay has to let the computer sign in, counted from when the connection starts. */
export const SIGN_IN_WITHIN_MS = 30_000;

/** The wait before the first try at connecting again. Each failure in a row doubles it, up to MAX_WAIT_MS. */
export const FIRST_WAIT_MS = 1_000;

/**
 * The longest wait before connecting again. It is also the wait after the
 * relay refuses the sign-in or says the computer sent too much, since trying
 * again at once would only end the same way.
 */
export const MAX_WAIT_MS = 60_000;

/** How long a connection must stay signed in for its loss to start the waits again from FIRST_WAIT_MS. */
export const STEADY_MS = 60_000;

/**
 * How many messages may go to the relay at once. Half of what the relay
 * allows a computer (DESKTOP_BURST in relay/src/room-logic.ts), so that the
 * pings and the sign-in, which are not counted here, can never tip it over.
 */
export const SEND_BURST = 1024;

/** How many more messages may go each second once the burst is used up: half of DESKTOP_PER_SECOND, for the same reason. */
export const SEND_PER_SECOND = 128;

/**
 * How much the socket may hold that it has not written yet before sending
 * waits. It keeps a slow network from piling every answer up inside the
 * socket, where it could no longer be dropped when its phone goes.
 */
export const MAX_BUFFERED_BYTES = 256 * 1024;

/** How soon to look again when the socket is too full to take more. */
export const BUFFER_CHECK_MS = 50;

/**
 * The most that may wait to go to the phones at once. A message that does
 * not fit sends its phone away, so that a network that cannot keep up does
 * not fill the computer's memory.
 */
export const MAX_QUEUED_BYTES = 64 * 1024 * 1024;

/** The close code for an ordinary close. It goes without a reason: a long one makes close() throw. */
const NORMAL_CLOSE = 1000;

/**
 * Where the connection to the relay stands, for Settings to show. "waiting"
 * means it was lost, or could not be made, for the reason given (written for
 * a person), and the phone link tries again at retryAt. "replaced" means
 * another connection signed in as this computer and took its place, and the
 * phone link waits until it is started again.
 */
export type RelayStatus =
  | { state: "off" }
  | { state: "connecting" }
  | { state: "connected" }
  | { state: "waiting"; retryAt: number; reason: string }
  | { state: "replaced" };

/** What a socket reports. "closed" always comes last, and it also comes when the connection could not be made. */
export type SocketEvents = {
  opened: () => void;
  text: (text: string) => void;
  binary: (data: Bytes) => void;
  closed: (code: number) => void;
};

/** A WebSocket to the relay, as the phone link uses it. */
export type RelaySocket = {
  /** Throws while the socket is still connecting. */
  send: (data: string | Bytes) => void;
  /** On a socket that is still connecting, the close is reported from inside this call. */
  close: (code: number) => void;
  /** How many bytes the socket has been given that it has not written yet. */
  readonly bufferedAmount: number;
};

/** Opens a socket to this address. None of its events fire from inside this call. */
export type OpenSocket = (url: string, events: SocketEvents) => RelaySocket;

/** Where the phones' comings, goings and messages go. A PhoneHost fits. None of them may throw. */
export type PhoneEvents = {
  opened: (channel: number) => void;
  closed: (channel: number) => void;
  received: (channel: number, message: Bytes) => void;
  dropAll: () => void;
};

export type PhoneRelayOptions = {
  /** The relay's address, such as https://relay.example.com. */
  relayOrigin: string;
  /** The computer's ID, which names its room on the relay. */
  desktopId: string;
  /** The key the computer signs in to the relay with. The ID comes from its public half. */
  signingKey: KeyPair;
  /** Where the phones' comings, goings and messages go. */
  phones: PhoneEvents;
  /** Told each time the status changes, so that Settings can show it. It must not throw. */
  onStatus?: (status: RelayStatus) => void;
  /** Opens the socket: a real WebSocket unless a test passes its own. */
  openSocket?: OpenSocket;
  /** The time and timers: the computer's own clock unless a test passes one. */
  clock?: Clock;
  /** A random number from 0 up to 1, to spread the waits out: Math.random unless a test passes one. */
  random?: () => number;
};

/** A message waiting to go to the relay, and the channel of the phone it is for. */
type Outgoing = { channel: number; data: string | Bytes };

/** One connection to the relay, from opening the socket until it is let go. */
type Connection = {
  socket: RelaySocket;
  /** Whether the socket has opened. */
  opened: boolean;
  /** Whether the relay's challenge has been answered. */
  answered: boolean;
  /** When the relay said the computer was signed in, or null before that. */
  signedInAt: number | null;
  /** When the relay was last heard from, for noticing a connection that has gone quiet. */
  heardAt: number;
  /** Whether a message the phone link could not use has been logged already. */
  ignored: boolean;
  /** Ends a connection that is not signed in within SIGN_IN_WITHIN_MS. */
  signInTimer: unknown;
  /** Sends the next ping. */
  pingTimer: unknown;
  /** Sends what is waiting once the pacing allows. Null while nothing waits for it. */
  pumpTimer: unknown;
  /** What is waiting to go, oldest first. */
  queue: Outgoing[];
  /** The size of everything in the queue. */
  queuedBytes: number;
  /** How many more messages may go before the pacing makes the rest wait. */
  tokens: number;
  /** When the tokens were last topped up. */
  refilledAt: number;
};

/** Opens a real WebSocket: the one built into Node, and so into Electron's main process. */
export const openWebSocket: OpenSocket = (url, events) => {
  const socket = new WebSocket(url);
  socket.binaryType = "arraybuffer";
  socket.addEventListener("open", () => events.opened());
  socket.addEventListener("message", (event) => {
    if (typeof event.data === "string") events.text(event.data);
    else if (event.data instanceof ArrayBuffer) events.binary(new Uint8Array(event.data));
  });
  // A connection that fails fires "error" and then "close", so "close" covers both.
  socket.addEventListener("close", (event) => events.closed(event.code));
  return {
    send: (data) => socket.send(data),
    close: (code) => socket.close(code),
    get bufferedAmount() {
      return socket.bufferedAmount;
    },
  };
};

/** Why the relay closed the connection with this code, as a person is told it. */
function closeReason(code: number, opened: boolean): string {
  switch (code) {
    case CLOSE_SIGN_IN_FAILED:
      return "The relay did not accept this computer's sign-in.";
    case CLOSE_FULL:
      return "Other connections were signing in as this computer at the same time.";
    case CLOSE_BROKEN:
    case CLOSE_TOO_BIG:
      return "The relay could not read what this computer sent.";
    case CLOSE_TOO_FAST:
      return "The relay said this computer sent too much at once.";
    default:
      return opened ? "The connection to the relay closed." : "The relay could not be reached.";
  }
}

/**
 * The computer's one connection to the relay. start() connects, and then
 * connects again each time the connection is lost, until stop(). The phone
 * host sends through send() and close().
 */
export class PhoneRelay {
  private readonly url: string;
  private readonly openSocket: OpenSocket;
  private readonly clock: Clock;
  private readonly random: () => number;
  /** The connection being made or in use, or null while there is none. */
  private connection: Connection | null = null;
  /** Whether the phone link wants a connection: from start() until stop(), or until another connection takes its place. */
  private running = false;
  /** Connects again when the wait is over. */
  private retryTimer: unknown = null;
  /** The wait after the next failure. */
  private nextWait = FIRST_WAIT_MS;
  /** Why the last connection was lost or could not be made, so that a reason is logged only once in a row. */
  private lastProblem: string | null = null;
  private current: RelayStatus = { state: "off" };

  constructor(private readonly options: PhoneRelayOptions) {
    // Throws for an address that is not a relay's, or an ID that is not a computer's, so a mistake shows at once.
    this.url = relaySocketUrl(options.relayOrigin, "desktop", options.desktopId);
    this.openSocket = options.openSocket ?? openWebSocket;
    this.clock = options.clock ?? SYSTEM_CLOCK;
    this.random = options.random ?? Math.random;
  }

  /** Where the connection to the relay stands. */
  status(): RelayStatus {
    return this.current;
  }

  /** Connects to the relay, and connects again whenever the connection is lost. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.nextWait = FIRST_WAIT_MS;
    this.lastProblem = null;
    this.connect();
  }

  /** Closes the connection, or stops waiting to make one. The phones go with it. */
  stop(): void {
    this.running = false;
    this.clock.clearTimeout(this.retryTimer);
    this.retryTimer = null;
    if (this.connection !== null) this.release(this.connection);
    this.setStatus({ state: "off" });
  }

  /**
   * Connects at once instead of when the wait is over, for Settings' "Connect
   * now", and starts the waits over from the shortest. It does nothing unless
   * waiting: after another connection took this one's place, start() is what
   * takes the place back.
   */
  retryNow(): void {
    if (this.current.state !== "waiting") return;
    this.clock.clearTimeout(this.retryTimer);
    this.nextWait = FIRST_WAIT_MS;
    // A new run of tries, so a reason for failing is logged again.
    this.lastProblem = null;
    this.connect();
  }

  /**
   * Sends a message to the phone on this channel, after whatever was sent
   * before it. Nothing goes while the computer is not signed in: its phones
   * went with the last connection.
   */
  send(channel: number, message: Bytes): void {
    const connection = this.connection;
    // A number the relay never gave cannot be named to it, not even to close it.
    if (connection === null || connection.signedInAt === null || !isChannel(channel)) return;
    let frame: Bytes;
    try {
      frame = addChannel(channel, message);
    } catch (error) {
      logWarn("The phone link could not send a message to a phone, so the phone was sent away.", error);
      this.sendAway(connection, channel);
      return;
    }
    if (connection.queuedBytes + frame.length > MAX_QUEUED_BYTES) {
      logWarn(
        `The messages waiting to go to the phones would have filled more than ${MAX_QUEUED_BYTES / (1024 * 1024)} MB, ` +
          "so the phone whose message did not fit was sent away.",
      );
      this.sendAway(connection, channel);
      return;
    }
    this.enqueue(connection, { channel, data: frame });
  }

  /** Asks the relay to send the phone on this channel away, once whatever was sent to it before has gone. */
  close(channel: number): void {
    const connection = this.connection;
    if (connection === null || connection.signedInAt === null || !isChannel(channel)) return;
    this.enqueue(connection, { channel, data: writeControl({ type: "close", channel }) });
  }

  /** Opens a new connection, and starts the clock on its sign-in. */
  private connect(): void {
    this.retryTimer = null;
    // The socket's events never fire from inside openSocket, so `connection` below is set before any of them runs.
    const events: SocketEvents = {
      opened: () => this.whenOpened(connection),
      text: (text) => this.whenText(connection, text),
      binary: (data) => this.whenBinary(connection, data),
      closed: (code) => this.whenClosed(connection, code),
    };
    let socket: RelaySocket;
    try {
      socket = this.openSocket(this.url, events);
    } catch (error) {
      logWarn("The phone link could not open a connection to the relay.", error);
      this.waitToRetry(null, "The relay could not be reached.", false);
      return;
    }
    const now = this.clock.now();
    const connection: Connection = {
      socket,
      opened: false,
      answered: false,
      signedInAt: null,
      heardAt: now,
      ignored: false,
      signInTimer: null,
      pingTimer: null,
      pumpTimer: null,
      queue: [],
      queuedBytes: 0,
      tokens: 0,
      refilledAt: now,
    };
    this.connection = connection;
    connection.signInTimer = this.clock.setTimeout(() => {
      this.lose(connection, connection.opened ? "The relay did not let this computer sign in in time." : "The relay could not be reached.");
    }, SIGN_IN_WITHIN_MS);
    this.setStatus({ state: "connecting" });
  }

  /** The socket opened. The relay sends its challenge next. */
  private whenOpened(connection: Connection): void {
    if (this.connection !== connection || connection.opened) return;
    connection.opened = true;
    connection.heardAt = this.clock.now();
    // Set before the first ping goes, so that a ping that fails clears the timer along with the connection.
    this.schedulePing(connection);
    this.transmit(connection, PING);
  }

  /** Sends the next ping when it falls due, unless the relay has been silent for too long by then. */
  private schedulePing(connection: Connection): void {
    connection.pingTimer = this.clock.setTimeout(() => {
      if (this.connection !== connection) return;
      if (this.clock.now() - connection.heardAt >= SILENT_FOR_MS) {
        this.lose(connection, "The relay stopped answering.");
        return;
      }
      this.schedulePing(connection);
      this.transmit(connection, PING);
    }, PING_EVERY_MS);
  }

  /** A message from the relay itself: the sign-in, or a phone coming or going. */
  private whenText(connection: Connection, text: string): void {
    if (this.connection !== connection) return;
    connection.heardAt = this.clock.now();
    const control = readControl(text);
    if (control === null) {
      this.ignore(connection);
      return;
    }
    switch (control.type) {
      case "challenge":
        if (connection.answered) {
          this.ignore(connection);
          return;
        }
        connection.answered = true;
        void this.answerChallenge(connection, control.challenge).catch((error: unknown) => {
          if (this.connection !== connection) return;
          logWarn("The phone link could not sign in to the relay.", error);
          this.lose(connection, "This computer could not sign in to the relay.", true);
        });
        return;
      case "ready":
        if (connection.answered && connection.signedInAt === null) this.signedIn(connection);
        else this.ignore(connection);
        return;
      case "open":
      case "close":
        if (connection.signedInAt === null) {
          this.ignore(connection);
          return;
        }
        // Whatever still waits to go on this channel was for a phone that has gone.
        this.unqueue(connection, control.channel);
        if (control.type === "open") this.options.phones.opened(control.channel);
        else this.options.phones.closed(control.channel);
        return;
      case "pong":
        // It only shows that the relay is still there, which heardAt has noted already.
        return;
      default:
        // The relay sends a computer nothing else. A ping is not answered either: the relay closes the
        // connection of a computer that sends a pong.
        this.ignore(connection);
        return;
    }
  }

  /** Signs the relay's challenge with the signing key, and sends the signature along with the key's public half. */
  private async answerChallenge(connection: Connection, challenge: Bytes): Promise<void> {
    const { signingKey } = this.options;
    const signature = await signChallenge(signingKey, challenge);
    if (this.connection !== connection) return;
    this.transmit(connection, writeControl({ type: "auth", publicKey: signingKey.publicKey, signature }));
  }

  /** The relay accepted the sign-in, so the computer's phones can reach it now. */
  private signedIn(connection: Connection): void {
    const now = this.clock.now();
    connection.signedInAt = now;
    // The relay counts for each connection afresh, so a new one may send a whole burst.
    connection.tokens = SEND_BURST;
    connection.refilledAt = now;
    this.clock.clearTimeout(connection.signInTimer);
    connection.signInTimer = null;
    this.lastProblem = null;
    logInfo("Connected to the relay.");
    this.setStatus({ state: "connected" });
  }

  /** A message from a phone, with its channel in front. */
  private whenBinary(connection: Connection, data: Bytes): void {
    if (this.connection !== connection) return;
    connection.heardAt = this.clock.now();
    const frame = connection.signedInAt === null ? null : readChannel(data);
    if (frame === null) this.ignore(connection);
    else this.options.phones.received(frame.channel, frame.message);
  }

  /**
   * Passes over a message from the relay that the phone link cannot use.
   * Ending the connection for it would end every phone's link as well, so it
   * is only logged, once for each connection.
   */
  private ignore(connection: Connection): void {
    if (connection.ignored) return;
    connection.ignored = true;
    logWarn("The relay sent a message the phone link could not use, so it was ignored.");
  }

  /** The socket closed, or it could not open. */
  private whenClosed(connection: Connection, code: number): void {
    if (this.connection !== connection) return;
    if (code === CLOSE_REPLACED) {
      // Connecting again would take the place back, and the two connections would take turns forever.
      this.release(connection);
      this.running = false;
      logWarn(
        "Another connection signed in to the relay as this computer and took its place, so the phone link stopped. " +
          "Starting the phone link again takes the place back.",
      );
      this.setStatus({ state: "replaced" });
      return;
    }
    // A refused sign-in, or too much sent at once, would only happen again straight away, so those wait longest.
    this.lose(connection, closeReason(code, connection.opened), code === CLOSE_SIGN_IN_FAILED || code === CLOSE_TOO_FAST);
  }

  /** Lets go of the connection: stops its timers, drops what was waiting to go, and closes the socket. */
  private release(connection: Connection): void {
    if (this.connection !== connection) return;
    // Cleared first, because closing a socket that is still connecting reports the close from inside close().
    this.connection = null;
    this.clock.clearTimeout(connection.signInTimer);
    this.clock.clearTimeout(connection.pingTimer);
    this.clock.clearTimeout(connection.pumpTimer);
    connection.queue = [];
    connection.queuedBytes = 0;
    // The relay lets the computer's phones go along with the connection.
    this.options.phones.dropAll();
    try {
      // Closing a socket that has closed already does nothing.
      connection.socket.close(NORMAL_CLOSE);
    } catch (error) {
      logWarn("The phone link could not close its connection to the relay.", error);
    }
  }

  /** Lets go of a connection that was lost, or never made, and connects again after a wait. */
  private lose(connection: Connection, reason: string, longWait = false): void {
    if (this.connection !== connection) return;
    this.release(connection);
    this.waitToRetry(connection.signedInAt, reason, longWait);
  }

  /**
   * Connects again after a wait that doubles with each failure in a row, up to
   * MAX_WAIT_MS. Each wait is cut by up to half at random, so that computers
   * that lost the relay together do not all come back at the same moment.
   */
  private waitToRetry(signedInAt: number | null, reason: string, longWait: boolean): void {
    if (!this.running) return;
    const now = this.clock.now();
    // A connection that stayed up for a while was not part of a run of failures.
    if (signedInAt !== null && now - signedInAt >= STEADY_MS) this.nextWait = FIRST_WAIT_MS;
    const wait = longWait ? MAX_WAIT_MS : this.nextWait;
    this.nextWait = Math.min(this.nextWait * 2, MAX_WAIT_MS);
    const delay = Math.round(wait * (0.5 + this.random() / 2));
    this.retryTimer = this.clock.setTimeout(() => this.connect(), delay);
    if (reason !== this.lastProblem) {
      this.lastProblem = reason;
      const seconds = Math.ceil(delay / 1000);
      logWarn(`${reason} The phone link tries again in ${seconds} ${seconds === 1 ? "second" : "seconds"}.`);
    }
    this.setStatus({ state: "waiting", retryAt: now + delay, reason });
  }

  /** Sends the phone on this channel away, and tells the host that it has gone. */
  private sendAway(connection: Connection, channel: number): void {
    this.unqueue(connection, channel);
    this.enqueue(connection, { channel, data: writeControl({ type: "close", channel }) });
    this.options.phones.closed(channel);
  }

  /** Puts a message in line to go, and sends what the pacing allows now. */
  private enqueue(connection: Connection, item: Outgoing): void {
    connection.queue.push(item);
    connection.queuedBytes += item.data.length;
    // While a timer is set, it sends the message in its turn.
    if (connection.pumpTimer === null) this.pump(connection);
  }

  /** Drops whatever is waiting to go to the phone on this channel. */
  private unqueue(connection: Connection, channel: number): void {
    connection.queue = connection.queue.filter((item) => item.channel !== channel);
    connection.queuedBytes = connection.queue.reduce((total, item) => total + item.data.length, 0);
  }

  /**
   * Sends what is waiting, as fast as the pacing allows: one message for each
   * token, which refill at SEND_PER_SECOND up to SEND_BURST, and only while
   * the socket holds less than MAX_BUFFERED_BYTES that it has not written.
   * Whatever is left goes when a timer comes due.
   */
  private pump(connection: Connection): void {
    const now = this.clock.now();
    connection.tokens = Math.min(SEND_BURST, connection.tokens + ((now - connection.refilledAt) * SEND_PER_SECOND) / 1000);
    connection.refilledAt = now;
    while (connection.tokens >= 1 && connection.socket.bufferedAmount < MAX_BUFFERED_BYTES) {
      const item = connection.queue.shift();
      if (item === undefined) return;
      connection.queuedBytes -= item.data.length;
      connection.tokens -= 1;
      this.transmit(connection, item.data);
      // A send that failed let go of the connection.
      if (this.connection !== connection) return;
    }
    if (connection.queue.length === 0) return;
    // Out of tokens: wait for the next one. Otherwise the socket is full, so look again shortly.
    const wait = connection.tokens >= 1 ? BUFFER_CHECK_MS : Math.ceil(((1 - connection.tokens) * 1000) / SEND_PER_SECOND);
    connection.pumpTimer = this.clock.setTimeout(() => {
      connection.pumpTimer = null;
      if (this.connection === connection) this.pump(connection);
    }, wait);
  }

  /** Writes to the socket. A socket that refuses has gone, so the connection counts as lost. */
  private transmit(connection: Connection, data: string | Bytes): void {
    try {
      connection.socket.send(data);
    } catch (error) {
      logWarn("The phone link could not send to the relay.", error);
      this.lose(connection, "The connection to the relay closed.");
    }
  }

  /** Notes the new status, and tells Settings. */
  private setStatus(status: RelayStatus): void {
    this.current = status;
    this.options.onStatus?.(status);
  }
}
