/**
 * The phone's side of the phone link: its connection to the relay, the
 * handshake with the computer through it, and the requests that go over the
 * link once it is open.
 *
 * The phone connects to the relay's door for the computer's room, and the
 * relay says whether the computer is there: `online` when it is, `offline`
 * when it is not. Every `online` starts the link over with a fresh
 * handshake, because the relay gives the phone a new channel to the computer
 * each time and the computer knows nothing of the old one. While the
 * computer is away the phone waits on the open connection, so it hears at
 * once when the computer comes back.
 *
 * Like the computer's own connection to the relay
 * (desktop/src/main/phone-relay.ts), it pings so that an idle connection
 * stays open and a lost one is noticed, and connects again after a wait that
 * doubles with each failure in a row. A refusal from the computer is final,
 * since trying again would only be refused again: the connection ends and
 * says why.
 *
 * Pure: the socket, the clock and the random numbers for the waits are
 * passed in, so the tests (src/test/phone-connection.test.ts) can play the
 * relay and the computer and move time on by hand. The app (main.ts) uses
 * the browser's WebSocket.
 */
import type { Bytes } from "../shared/remote/bytes.js";
import { KEY_BYTES, type KeyPair } from "../shared/remote/keys.js";
import { Link } from "../shared/remote/link.js";
import { Initiator, type Session } from "../shared/remote/noise.js";
import { PHONE_LINK_PROLOGUE, readOpeningAnswer, writeOpening, type Opening, type OpeningRefusal } from "../shared/remote/pairing.js";
import {
  CLOSE_BROKEN,
  CLOSE_FULL,
  CLOSE_SENT_AWAY,
  CLOSE_TOO_BIG,
  CLOSE_TOO_FAST,
  PING,
  readControl,
  relaySocketUrl,
} from "../shared/remote/relay-protocol.js";
import {
  ANSWER_WITHIN_MS,
  MAX_PENDING_REQUESTS,
  MAX_REQUEST_BYTES,
  readAnswer,
  readResult,
  writeRequest,
  type ErrorCode,
  type Method,
  type Request,
  type Results,
} from "../shared/remote/rpc.js";
import { SYSTEM_CLOCK, type Clock } from "./clock.js";

/** How often the phone pings the relay, so that an idle connection stays open and a lost one is noticed. */
export const PING_EVERY_MS = 30_000;
/**
 * How long the relay may stay silent before the connection counts as lost.
 * It is checked as each ping falls due, so it takes two pings that go
 * unanswered, and a lost connection is noticed within about a minute and a
 * half.
 */
export const SILENT_FOR_MS = 70_000;
/** How long the relay has, from when the connection starts, to say whether the computer is there. */
export const CONNECT_WITHIN_MS = 30_000;
/** How long the relay has to answer the ping that wake() sends, before the connection counts as lost. */
export const PROBE_WITHIN_MS = 8_000;
/**
 * How long the computer has to answer the handshake: a little longer than
 * the computer itself waits (desktop/src/main/phone-host.ts), so the
 * computer gives up first.
 */
export const HANDSHAKE_WITHIN_MS = 35_000;
/** The wait before the first try at connecting again. Each failure in a row doubles it, up to MAX_WAIT_MS. */
export const FIRST_WAIT_MS = 1_000;
/**
 * The longest wait before connecting again. It is also the wait after the
 * relay says the phone sent too much, or that too many phones are
 * connected, since trying again at once would only end the same way.
 */
export const MAX_WAIT_MS = 30_000;
/** How long a connection must stay open for its loss to start the waits again from FIRST_WAIT_MS. */
export const STEADY_MS = 60_000;

/** The close code for an ordinary close. It goes without a reason: a long one makes close() throw. */
const NORMAL_CLOSE = 1000;

const UNREACHABLE = "The relay could not be reached. Check the phone's internet connection.";
const VERSION_MISMATCH =
  "This phone app and Schema Studio on the computer are different versions, so the phone could not read the computer's answer. Update Schema Studio on the computer.";

/** What a socket reports. "closed" always comes last, and it also comes when the connection could not be made. */
export type SocketEvents = {
  opened: () => void;
  text: (text: string) => void;
  binary: (data: Bytes) => void;
  closed: (code: number) => void;
};

/** A WebSocket to the relay, as the phone link uses it. */
export type PhoneSocket = {
  /** Throws while the socket is still connecting. */
  send: (data: string | Bytes) => void;
  /** On a socket that is still connecting, the close may be reported from inside this call. */
  close: (code: number) => void;
};

/** Opens a socket to this address. None of its events fire from inside this call. */
export type OpenSocket = (url: string, events: SocketEvents) => PhoneSocket;

/** Opens a real WebSocket: the browser's own. */
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
  };
};

/** Why the connection ended for good: a refusal from the computer, or something on the phone's side. */
export type EndReason = OpeningRefusal | "version" | "pairing-timed-out" | "save-failed";

/** What each end says, for the phone to show as it is. */
export const END_MESSAGES: Record<EndReason, string> = {
  "expired-code":
    "That pairing code has run out or was replaced by a newer one. Make a new one in Settings on the computer, then scan it.",
  "too-many-phones":
    "The computer already has as many phones paired as it takes. Remove one in Settings on the computer, then try again.",
  "not-paired":
    "The computer no longer knows this phone. It was removed in Settings on the computer, or the computer's phone link was set up again. Pair the phone again.",
  version:
    "This phone app and Schema Studio on the computer are different versions, so they could not understand each other. Update Schema Studio on the computer, then try again.",
  "pairing-timed-out": "The pairing code ran out before the computer answered. Make a new one in Settings on the computer.",
  "save-failed":
    "This phone could not save the pairing, so it could not stay paired. Check that the browser is not in private browsing and has space to store data, then pair again with a new code.",
};

/** Where the connection is, for the app to show. */
export type ConnectionState =
  /** Not started yet, or stopped. */
  | { kind: "off" }
  /** Connecting to the relay. */
  | { kind: "connecting" }
  /** Connected to the relay, and waiting for the computer to connect to it too. */
  | { kind: "waiting" }
  /** The computer is there, and the handshake with it is under way. */
  | { kind: "opening" }
  /** The link is open, so requests go through. */
  | { kind: "ready"; computerName: string }
  /** The connection was lost, or never made, and the phone tries again at retryAt. */
  | { kind: "retrying"; retryAt: number; reason: string }
  /** The connection ended for good: the person must do something before trying again. */
  | { kind: "ended"; why: EndReason; message: string };

/**
 * Why a request failed: a refusal from the computer, or one of the phone's
 * own reasons. "lost" is a connection that went before the answer came,
 * "version" an answer the phone could not read, and "ended" a connection
 * that ended for good.
 */
export type RpcErrorCode = ErrorCode | "lost" | "version" | "ended";

/** A request that failed, with a message the phone can show as it is. */
export class RpcError extends Error {
  constructor(
    readonly code: RpcErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "RpcError";
  }
}

/** A request as the app makes it: the ID is added as it goes out. */
export type Call = { [M in Method]: Omit<Extract<Request, { method: M }>, "id"> }[Method];

/** The pairing code, for a phone that is pairing. */
export type Pairing = {
  secret: Bytes;
  /** The phone's name, which the computer shows in its list of phones. */
  name: string;
  /**
   * When the code runs out on the phone: PAIRING_LIFETIME_MS from when it
   * was scanned, since the code itself does not say when it was made.
   */
  until: number;
};

export type PhoneConnectionOptions = {
  /** The relay's address, such as https://relay.example.com. */
  relayOrigin: string;
  /** The computer's ID at the relay, which names its room. */
  desktopId: string;
  /** The computer's public key, which the handshake checks, so the phone talks to that computer and no other. */
  desktopKey: Bytes;
  /** The phone's own key pair, which the computer knows the phone by. */
  staticKey: KeyPair;
  /** The pairing code, for a phone that is pairing. A phone that was paired already leaves it out. */
  pairing?: Pairing;
  /**
   * Saves the pairing, once the computer has paired the phone. Nothing is
   * asked of the computer until it resolves, and a rejection ends the
   * connection with "save-failed". It is not called for a phone that was
   * paired already.
   */
  onPaired?: (computerName: string) => Promise<void>;
  /** Told each time the state changes, so that the app can show it. It must not throw. */
  onState?: (state: ConnectionState) => void;
  /** Opens the socket: the browser's WebSocket unless a test passes its own. */
  openSocket?: OpenSocket;
  /** The time and timers: the browser's own clock unless a test passes one. */
  clock?: Clock;
  /** A random number from 0 up to 1, to spread the waits out: Math.random unless a test passes one. */
  random?: () => number;
};

/** The handshake under way on a connection. */
type Handshake = {
  /** Whether it pairs the phone, or opens a session for a phone that is paired already. */
  kind: Opening["kind"];
  initiator: Initiator;
  /**
   * "writing" until the first message is ready, "sent" once it has gone,
   * "reading" once the computer's answer is in, and "saving" while the
   * pairing is saved.
   */
  stage: "writing" | "sent" | "reading" | "saving";
};

/** One connection to the relay, from when it is opened until it is let go. */
type Connection = {
  socket: PhoneSocket;
  /** When the socket opened, or null while it is still connecting. */
  openedAt: number | null;
  /** When the relay was last heard from. */
  heardAt: number;
  /** The close code, when the relay closed the connection while the computer's answer to the handshake was still being read. */
  closedCode: number | null;
  connectTimer: unknown;
  pingTimer: unknown;
  probeTimer: unknown;
  handshakeTimer: unknown;
  handshake: Handshake | null;
  /** The link to the computer, once the handshake has opened it. */
  link: Link | null;
};

/** A request waiting to go to the computer. */
type Pending = {
  id: number;
  method: Method;
  /** The request as it goes out, written when it was made. */
  message: Bytes;
  resolve: (result: unknown) => void;
  reject: (error: RpcError) => void;
};

/** A request sent to the computer, with the timer that gives up on its answer. */
type InFlight = Pending & { timer: unknown };

/**
 * The phone link from the phone's side. It is used once: after stop(), or
 * after it ends, the app makes a new one to connect again.
 */
export class PhoneConnection {
  private readonly url: string;
  private readonly openSocket: OpenSocket;
  private readonly clock: Clock;
  private readonly random: () => number;
  private current: ConnectionState = { kind: "off" };
  private started = false;
  /** Set once stop() is called or the connection ends, after which it never connects again. */
  private finished = false;
  /** What a request made after the end is turned down with. */
  private endMessage = "The phone link was stopped.";
  private connection: Connection | null = null;
  private retryTimer: unknown = null;
  /** Runs when the pairing code runs out. */
  private deadlineTimer: unknown = null;
  /** The wait before the next try at connecting again, before the random cut. */
  private nextWait = FIRST_WAIT_MS;
  /** The pairing code, until the computer has paired the phone. */
  private pairing: Pairing | null;
  /** How many handshakes have carried the pairing code. */
  private pairOpeningsSent = 0;
  /**
   * Set when the phone may have been paired without hearing so: the next
   * handshake opens a session instead of pairing, to find out.
   */
  private confirming = false;
  /** The save of the pairing, while it is under way. */
  private saving: Promise<void> | null = null;
  /** Requests waiting for a link, or for a free place at the computer, in the order they were made. */
  private readonly queued: Pending[] = [];
  /** Requests the computer has not answered yet, by ID. */
  private readonly inFlight = new Map<number, InFlight>();
  /** The next request's ID. No ID is used twice, since the computer closes a link that reuses the ID of a request it is still working on. */
  private nextId = 1;

  constructor(private readonly options: PhoneConnectionOptions) {
    // Throws for an address that is not a relay's, an ID that is not a computer's, or a key of the wrong size, so a mistake shows at once.
    this.url = relaySocketUrl(options.relayOrigin, "phone", options.desktopId);
    if (options.desktopKey.length !== KEY_BYTES) throw new Error("The computer's key must be 32 bytes.");
    this.openSocket = options.openSocket ?? openWebSocket;
    this.clock = options.clock ?? SYSTEM_CLOCK;
    this.random = options.random ?? Math.random;
    this.pairing = options.pairing ?? null;
  }

  get state(): ConnectionState {
    return this.current;
  }

  /** Connects, and stays connected until stop() is called or the connection ends. Only the first call does anything. */
  start(): void {
    if (this.started || this.finished) return;
    this.started = true;
    if (this.pairing !== null) {
      const left = this.pairing.until - this.clock.now();
      if (left <= 0) {
        this.end("pairing-timed-out");
        return;
      }
      this.deadlineTimer = this.clock.setTimeout(() => this.pairingRanOut(), left);
    }
    this.connect();
  }

  /** Disconnects for good, and turns down every request still waiting. */
  stop(): void {
    if (this.finished) return;
    this.finish("The phone link was stopped.", { kind: "off" });
  }

  /**
   * Checks the connection at once, for when the phone may have been asleep
   * or offline, or the person asks to try again now. A wait to connect again
   * is cut short. An open connection is pinged, and counts as lost unless
   * the relay answers within PROBE_WITHIN_MS: a phone stops a page's timers
   * while it sleeps, so the connection may have gone without the phone
   * hearing.
   */
  wake(): void {
    if (this.finished) return;
    if (this.retryTimer !== null) {
      this.clock.clearTimeout(this.retryTimer);
      this.nextWait = FIRST_WAIT_MS;
      this.connect();
      return;
    }
    const connection = this.connection;
    if (connection === null || connection.openedAt === null || connection.probeTimer !== null || connection.closedCode !== null) return;
    // Set before the ping goes, so that a ping that fails clears it along with the connection.
    connection.probeTimer = this.clock.setTimeout(() => {
      connection.probeTimer = null;
      this.lose(connection, "The relay stopped answering.");
    }, PROBE_WITHIN_MS);
    this.transmit(connection, PING);
  }

  /**
   * Asks the computer something. A request made before the link is open
   * waits for it, and at most MAX_PENDING_REQUESTS go to the computer at
   * once, the rest waiting their turn. A request the computer had not
   * answered when the connection went fails with "lost", since its answer
   * can no longer arrive.
   */
  request<C extends Call>(call: C): Promise<Results[C["method"]]> {
    if (this.finished) return Promise.reject(new RpcError("ended", this.endMessage));
    const id = this.nextId;
    this.nextId += 1;
    // Written now, so that a request too big to send is turned down here: the computer would close the link over it.
    const message = writeRequest({ ...call, id } as Request);
    if (message.length > MAX_REQUEST_BYTES) return Promise.reject(new RpcError("too-big", "This request is too big to send to the computer."));
    return new Promise((resolve, reject) => {
      this.queued.push({ id, method: call.method, message, resolve: resolve as (result: unknown) => void, reject });
      this.flush();
    });
  }

  /** Opens a new connection, and starts the clock on the relay saying whether the computer is there. */
  private connect(): void {
    this.retryTimer = null;
    // The socket's events never fire from inside openSocket, so `connection` below is set before any of them runs.
    const events: SocketEvents = {
      opened: () => this.whenOpened(connection),
      text: (text) => this.whenText(connection, text),
      binary: (data) => this.whenBinary(connection, data),
      closed: (code) => this.whenClosed(connection, code),
    };
    let socket: PhoneSocket;
    try {
      socket = this.openSocket(this.url, events);
    } catch {
      this.waitToRetry(null, UNREACHABLE, false);
      return;
    }
    const connection: Connection = {
      socket,
      openedAt: null,
      heardAt: this.clock.now(),
      closedCode: null,
      connectTimer: null,
      pingTimer: null,
      probeTimer: null,
      handshakeTimer: null,
      handshake: null,
      link: null,
    };
    this.connection = connection;
    connection.connectTimer = this.clock.setTimeout(() => {
      this.lose(connection, connection.openedAt === null ? UNREACHABLE : "The relay did not say whether the computer is there.");
    }, CONNECT_WITHIN_MS);
    this.setState({ kind: "connecting" });
  }

  private whenOpened(connection: Connection): void {
    if (this.connection !== connection || connection.openedAt !== null) return;
    const now = this.clock.now();
    connection.openedAt = now;
    connection.heardAt = now;
    // No ping goes now: the relay says straight away whether the computer is there.
    this.schedulePing(connection);
  }

  private whenText(connection: Connection, text: string): void {
    if (this.connection !== connection) return;
    this.heard(connection);
    const control = readControl(text);
    if (control?.type === "online") {
      this.clock.clearTimeout(connection.connectTimer);
      connection.connectTimer = null;
      void this.startHandshake(connection);
    } else if (control?.type === "offline") {
      this.clock.clearTimeout(connection.connectTimer);
      this.clock.clearTimeout(connection.handshakeTimer);
      connection.connectTimer = null;
      connection.handshakeTimer = null;
      connection.handshake = null;
      this.dropLink(connection);
      this.setState({ kind: "waiting" });
    }
    // Anything else, such as the answer to a ping, only shows that the relay is still there.
  }

  private whenBinary(connection: Connection, data: Bytes): void {
    if (this.connection !== connection) return;
    this.heard(connection);
    const handshake = connection.handshake;
    if (handshake?.stage === "sent") {
      handshake.stage = "reading";
      // The answer came in time.
      this.clock.clearTimeout(connection.handshakeTimer);
      connection.handshakeTimer = null;
      void this.finishHandshake(connection, handshake, data);
      return;
    }
    const link = connection.link;
    if (link === null) {
      // The computer sends nothing of its own accord, so this is not something the phone can use.
      this.lose(connection, "The relay passed on a message at the wrong time.");
      return;
    }
    // Called at once as each piece arrives, so that the pieces are opened in the order they came.
    link.receive(data).then(
      (message) => {
        if (message !== null && this.connection === connection && connection.link === link) this.whenAnswer(message);
      },
      () => {
        if (this.connection === connection && connection.link === link) this.lose(connection, "A message from the computer could not be opened.");
      },
    );
  }

  private whenClosed(connection: Connection, code: number): void {
    if (this.connection !== connection) return;
    if (connection.handshake?.stage === "reading") {
      // The computer turns a phone away by having the relay close the
      // phone's connection straight after its answer, so the close can come
      // while that answer is still being read, and the answer says why.
      // finishHandshake deals with the close once it has read the answer.
      connection.closedCode = code;
      this.clock.clearTimeout(connection.connectTimer);
      this.clock.clearTimeout(connection.pingTimer);
      this.clock.clearTimeout(connection.probeTimer);
      connection.connectTimer = null;
      connection.pingTimer = null;
      connection.probeTimer = null;
      return;
    }
    this.lostToClose(connection, code);
  }

  /** Notes that the relay was heard from, which also answers a probe. */
  private heard(connection: Connection): void {
    connection.heardAt = this.clock.now();
    this.clock.clearTimeout(connection.probeTimer);
    connection.probeTimer = null;
  }

  /** Starts a fresh handshake with the computer, over the channel the relay has just made. */
  private async startHandshake(connection: Connection): Promise<void> {
    // The channel is new, so any link over the old one is gone.
    this.dropLink(connection);
    const pairing = this.confirming ? null : this.pairing;
    const opening: Opening = pairing === null ? { kind: "session" } : { kind: "pair", secret: pairing.secret, name: pairing.name };
    const initiator = new Initiator({ prologue: PHONE_LINK_PROLOGUE, staticKey: this.options.staticKey, remoteStaticKey: this.options.desktopKey });
    const handshake: Handshake = { kind: opening.kind, initiator, stage: "writing" };
    connection.handshake = handshake;
    this.clock.clearTimeout(connection.handshakeTimer);
    connection.handshakeTimer = this.clock.setTimeout(() => {
      if (this.isCurrent(connection, handshake)) this.lose(connection, "The computer did not answer.");
    }, HANDSHAKE_WITHIN_MS);
    this.setState({ kind: "opening" });
    let message: Bytes;
    try {
      message = await initiator.writeFirstMessage(writeOpening(opening));
    } catch {
      if (this.isCurrent(connection, handshake)) this.lose(connection, "The phone could not start the handshake with the computer.");
      return;
    }
    if (!this.isCurrent(connection, handshake)) return;
    handshake.stage = "sent";
    // Counted before it goes, since it may reach the computer even if the connection fails straight after.
    if (handshake.kind === "pair") this.pairOpeningsSent += 1;
    // The computer shuts a channel that sends anything more before it answers, so nothing else goes until then.
    this.transmit(connection, message);
  }

  /** Reads the computer's answer to the handshake, and opens the link when the computer lets the phone in. */
  private async finishHandshake(connection: Connection, handshake: Handshake, message: Bytes): Promise<void> {
    let reading: { payload: Bytes; session: Session };
    try {
      reading = await handshake.initiator.readAnswer(message);
    } catch {
      if (this.isCurrent(connection, handshake)) this.lose(connection, "The computer's answer could not be read.");
      return;
    }
    if (!this.isCurrent(connection, handshake)) return;
    const answer = readOpeningAnswer(reading.payload);
    if (answer === null) {
      this.end("version");
      return;
    }
    if (!answer.ok) {
      this.refused(connection, handshake, answer.reason);
      return;
    }
    if (handshake.kind === "pair" || this.confirming) {
      // The computer has paired the phone, so from here on every handshake
      // opens a session, even one on a new connection while the pairing is
      // still being saved.
      this.clock.clearTimeout(this.deadlineTimer);
      this.deadlineTimer = null;
      this.pairing = null;
      this.confirming = false;
      this.saving = this.save(answer.name);
    }
    // Nothing is asked of the computer until the pairing is saved, so a phone that could not save it never acts as paired.
    const saving = this.saving;
    if (saving !== null) {
      handshake.stage = "saving";
      try {
        await saving;
      } catch {
        this.end("save-failed");
        return;
      }
      if (this.saving === saving) this.saving = null;
      if (!this.isCurrent(connection, handshake)) return;
    }
    if (connection.closedCode !== null) {
      // The relay closed the connection while the answer was being read.
      // The phone is paired by now, so the next try opens a session.
      this.lostToClose(connection, connection.closedCode);
      return;
    }
    connection.handshake = null;
    const link: Link = new Link(reading.session, (sealed) => {
      if (this.connection === connection && connection.link === link) this.transmit(connection, sealed);
    });
    connection.link = link;
    this.setState({ kind: "ready", computerName: answer.name });
    this.flush();
  }

  private async save(computerName: string): Promise<void> {
    await this.options.onPaired?.(computerName);
  }

  /** The computer turned the phone away. */
  private refused(connection: Connection, handshake: Handshake, reason: OpeningRefusal): void {
    if (handshake.kind === "pair" && reason === "expired-code" && this.pairOpeningsSent > 1) {
      // An earlier try may have paired the phone, with only the computer's
      // answer lost on the way, and a code pairs only one phone. The
      // computer shuts the channel after a refusal, so the phone asks over
      // a new connection whether it is paired. A session is never refused
      // with expired-code, so this happens only once.
      this.confirming = true;
      this.release(connection);
      this.connect();
      return;
    }
    // A phone that was asking whether an earlier try paired it was not paired, so its code did not work.
    this.end(this.confirming && reason === "not-paired" ? "expired-code" : reason);
  }

  /** The pairing code ran out. A phone that never sent it gives up, and one that did asks the computer whether it was paired. */
  private pairingRanOut(): void {
    this.deadlineTimer = null;
    if (this.pairing === null) return;
    if (this.pairOpeningsSent === 0) {
      this.end("pairing-timed-out");
      return;
    }
    // A try may have reached the computer, with only its answer lost, so from now on the phone asks whether it is paired.
    this.confirming = true;
  }

  /** Hands an answer from the computer to the request it answers. */
  private whenAnswer(message: Bytes): void {
    const answer = readAnswer(message);
    // The handshake vouches for every message, so one that is not an answer comes from a computer that speaks another version.
    if (answer === null) {
      this.end("version");
      return;
    }
    const request = this.inFlight.get(answer.id);
    // The phone gave up waiting for it.
    if (request === undefined) return;
    this.inFlight.delete(answer.id);
    this.clock.clearTimeout(request.timer);
    if (!answer.ok) {
      request.reject(new RpcError(answer.error.code, answer.error.message));
    } else {
      const result = readResult(request.method, answer.result);
      if (result === null) request.reject(new RpcError("version", VERSION_MISMATCH));
      else request.resolve(result);
    }
    this.flush();
  }

  /** Sends waiting requests, while the link is open and the computer has room for them. */
  private flush(): void {
    const connection = this.connection;
    const link = connection?.link ?? null;
    if (connection === null || link === null) return;
    while (this.inFlight.size < MAX_PENDING_REQUESTS) {
      const request = this.queued.shift();
      if (request === undefined) return;
      const timer = this.clock.setTimeout(() => this.timedOut(request.id), ANSWER_WITHIN_MS);
      this.inFlight.set(request.id, { ...request, timer });
      // The link writes each piece through transmit, which deals with a socket that refuses, so this fails only when a piece cannot be sealed.
      link.send(request.message).catch(() => {
        if (this.connection === connection && connection.link === link) this.lose(connection, "A request could not be sent to the computer.");
      });
    }
  }

  private timedOut(id: number): void {
    const request = this.inFlight.get(id);
    if (request === undefined) return;
    this.inFlight.delete(id);
    request.reject(new RpcError("failed", "The computer took too long to answer."));
    // The computer gives up on a request before the phone does, so its place there is free again too.
    this.flush();
  }

  /** Lets go of a connection's link, turning down the requests it carried: their answers can no longer arrive. Requests still waiting to go wait for the next link. */
  private dropLink(connection: Connection): void {
    connection.link = null;
    if (this.inFlight.size === 0) return;
    const lost = new RpcError("lost", "The connection to the computer was lost before it answered.");
    for (const request of this.inFlight.values()) {
      this.clock.clearTimeout(request.timer);
      request.reject(lost);
    }
    this.inFlight.clear();
  }

  /** Lets go of a connection: its timers, its handshake, its link and its socket. */
  private release(connection: Connection): void {
    if (this.connection !== connection) return;
    // Cleared first, because closing a socket that is still connecting may report the close from inside close().
    this.connection = null;
    this.clock.clearTimeout(connection.connectTimer);
    this.clock.clearTimeout(connection.pingTimer);
    this.clock.clearTimeout(connection.probeTimer);
    this.clock.clearTimeout(connection.handshakeTimer);
    connection.connectTimer = null;
    connection.pingTimer = null;
    connection.probeTimer = null;
    connection.handshakeTimer = null;
    connection.handshake = null;
    this.dropLink(connection);
    try {
      // Closing a socket that has closed already does nothing.
      connection.socket.close(NORMAL_CLOSE);
    } catch {
      // A socket that cannot be closed has gone already.
    }
  }

  /** Lets go of a connection that was lost, or never made, and connects again after a wait. */
  private lose(connection: Connection, reason: string, longWait = false): void {
    if (this.connection !== connection) return;
    this.release(connection);
    this.waitToRetry(connection.openedAt, reason, longWait);
  }

  /** Lets go of a connection the relay closed, and connects again after a wait. */
  private lostToClose(connection: Connection, code: number): void {
    // Too many phones, or too much sent at once, would only happen again straight away, so those wait longest.
    this.lose(connection, closeReason(code, connection.openedAt !== null), code === CLOSE_TOO_FAST || code === CLOSE_FULL);
  }

  /**
   * Connects again after a wait that doubles with each failure in a row, up
   * to MAX_WAIT_MS. Each wait is cut by up to half at random, so that phones
   * that lost the relay together do not all come back at the same moment.
   */
  private waitToRetry(openedAt: number | null, reason: string, longWait: boolean): void {
    if (this.finished) return;
    const now = this.clock.now();
    // A connection that stayed open for a while was not part of a run of failures.
    if (openedAt !== null && now - openedAt >= STEADY_MS) this.nextWait = FIRST_WAIT_MS;
    const wait = longWait ? MAX_WAIT_MS : this.nextWait;
    this.nextWait = Math.min(this.nextWait * 2, MAX_WAIT_MS);
    const delay = Math.round(wait * (0.5 + this.random() / 2));
    this.retryTimer = this.clock.setTimeout(() => this.connect(), delay);
    this.setState({ kind: "retrying", retryAt: now + delay, reason });
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

  /** Writes to the socket. A socket that refuses has gone, so the connection counts as lost. */
  private transmit(connection: Connection, data: string | Bytes): void {
    try {
      connection.socket.send(data);
    } catch {
      this.lose(connection, "The connection to the relay closed.");
    }
  }

  /** Whether this is still the connection, and the handshake on it, that the phone is using. */
  private isCurrent(connection: Connection, handshake: Handshake): boolean {
    return this.connection === connection && connection.handshake === handshake;
  }

  /** Ends the connection for good, for a reason the person must act on before trying again. */
  private end(why: EndReason): void {
    if (this.finished) return;
    const message = END_MESSAGES[why];
    this.finish(message, { kind: "ended", why, message });
  }

  /** Stops for good: lets go of the connection, stops trying again, and turns down every request still waiting. */
  private finish(message: string, state: ConnectionState): void {
    this.finished = true;
    this.endMessage = message;
    this.clock.clearTimeout(this.retryTimer);
    this.clock.clearTimeout(this.deadlineTimer);
    this.retryTimer = null;
    this.deadlineTimer = null;
    const ended = new RpcError("ended", message);
    for (const request of this.inFlight.values()) {
      this.clock.clearTimeout(request.timer);
      request.reject(ended);
    }
    this.inFlight.clear();
    for (const request of this.queued.splice(0)) request.reject(ended);
    if (this.connection !== null) this.release(this.connection);
    this.setState(state);
  }

  /** Notes the new state, and tells the app. */
  private setState(state: ConnectionState): void {
    this.current = state;
    this.options.onState?.(state);
  }
}

/** What the relay's close code says about why it closed the connection. */
function closeReason(code: number, opened: boolean): string {
  switch (code) {
    case CLOSE_SENT_AWAY:
      return "The computer ended the connection.";
    case CLOSE_FULL:
      return "Too many phones are connected to the computer right now.";
    case CLOSE_BROKEN:
    case CLOSE_TOO_BIG:
      return "The relay could not read what this phone sent.";
    case CLOSE_TOO_FAST:
      return "The relay said this phone sent too much at once.";
    default:
      return opened ? "The connection to the relay closed." : UNREACHABLE;
  }
}
