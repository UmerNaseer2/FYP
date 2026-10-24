/**
 * The computer's side of the phone link, one phone at a time. It greets each
 * phone the relay connects, checks that the phone is paired or pairs it with
 * the one-time secret from the latest pairing link, then answers the phone's
 * requests over the encrypted link.
 *
 * The relay only passes messages along, numbering each phone's connection (a
 * channel). Everything is encrypted from end to end, so the relay never sees
 * a request or an answer, and it cannot pretend to be a paired phone: the
 * handshake proves that the phone holds the private half of the key it was
 * paired with. The relay could play a phone's first message again, and the
 * computer answers that as it would the phone, but without the phone's keys
 * the relay can neither read the answer nor send a message that opens. So a
 * phone counts as connected, and as seen, only once a message from it opens.
 *
 * Pure apart from the log. The relay connection (src/main/phone-relay.ts),
 * the saved phones (src/main/phone-link.ts) and the answers
 * (src/main/phone-requests.ts) are passed in, so the tests can play each part.
 */
import { withPairedPhone, withPhoneSeen, withoutPhone, type PairedPhone } from "../core/phone-link-file";
import { randomBytes, sameBytes, toBase64Url, type Bytes } from "../shared/remote/bytes";
import type { KeyPair } from "../shared/remote/keys";
import { Link, MAX_LINK_MESSAGE_BYTES } from "../shared/remote/link";
import { Responder } from "../shared/remote/noise";
import {
  PAIRING_LIFETIME_MS,
  PAIRING_SECRET_BYTES,
  PHONE_LINK_PROLOGUE,
  readOpening,
  writeOpeningAnswer,
  type Opening,
  type OpeningAnswer,
  type OpeningRefusal,
  type PairingCode,
} from "../shared/remote/pairing";
import { ANSWER_WITHIN_MS, MAX_PENDING_REQUESTS, readRequest, type Request } from "../shared/remote/rpc";
import { SYSTEM_CLOCK, type Clock } from "./clock";
import { logInfo, logWarn } from "./log";
import { writeRefusal } from "./phone-requests";

/** How long a phone has to finish the handshake, counted from when the relay connects it. */
export const HANDSHAKE_WITHIN_MS = 30_000;

/**
 * How long a request may take before the phone is told the computer took too
 * long. Shorter than the phone's own wait (ANSWER_WITHIN_MS), so the phone
 * hears why before it gives up.
 */
export const ANSWER_TIMEOUT_MS = ANSWER_WITHIN_MS - 10_000;

/**
 * The most phone connections kept at once. Twice the most the relay connects
 * (MAX_PHONES in relay/src/room-logic.ts), so only a relay that misbehaves
 * reaches it.
 */
export const MAX_CHANNELS = 16;

export type PhoneHostOptions = {
  /** The computer's key for the handshake. A phone knows its public half from the pairing link. */
  staticKey: KeyPair;
  /** The computer's number at the relay, which goes in each pairing link. */
  desktopId: string;
  /** The name a phone shows for this computer. */
  computerName: string;
  /** The paired phones, as saved now. */
  phones: () => readonly PairedPhone[];
  /** Saves the paired phones. It must not throw: a failure to save is logged where it happens. */
  savePhones: (phones: PairedPhone[]) => void;
  /**
   * The answer to a phone's request, ready to send (answerRequest in
   * src/main/phone-requests.ts). `phoneKey` is the key of the phone that
   * asked, as base64url, for a request about the phone itself, such as
   * whether it gets drift alerts. Once `signal` aborts, what it gives is not
   * sent. If it throws, the phone hears that the computer could not do that.
   */
  answer: (request: Request, signal: AbortSignal, phoneKey: string) => Promise<Bytes>;
  /** Sends a message to the phone on this channel, through the relay. */
  send: (channel: number, message: Bytes) => void;
  /** Asks the relay to send the phone on this channel away. */
  close: (channel: number) => void;
  /** Told when a phone pairs, so that Settings can show it at once. It must not throw. */
  onPaired?: (phone: PairedPhone) => void;
  /**
   * Told when the first message from a phone that was let in opens, and when
   * such a phone goes, so that Settings can show which phones are connected.
   * It must not throw.
   */
  onConnectedChange?: () => void;
  /** The time and timers: the computer's own clock unless a test passes one. */
  clock?: Clock;
};

/** A request being answered. Aborting the controller tells the answer to stop. */
type Pending = { controller: AbortController; timer: unknown };

/**
 * One phone's connection. It is "waiting" for the phone's first message,
 * "opening" while the computer works out its answer, and "open" once the
 * phone is let in. An open connection is confirmed once a message from the
 * phone opens.
 */
type Channel = {
  state: "waiting" | "opening" | "open";
  /** The phone's public key as base64url, once its first message is read. */
  phoneKey: string | null;
  /** The encrypted link, once the phone is let in. */
  link: Link | null;
  /**
   * Whether a message from the phone has opened since it was let in. A relay
   * can play a phone's first message again, and the computer answers it, but
   * whoever plays it can neither read the answer nor send a message that
   * opens. So only a phone that has sent one counts as connected and as seen.
   */
  confirmed: boolean;
  /** The requests being answered, by their number. */
  pending: Map<number, Pending>;
  handshakeTimer: unknown;
};

/** What the log says about a phone that was turned away, after "it". */
const TURNED_AWAY: Record<OpeningRefusal, string> = {
  "expired-code": "tried to pair with a pairing link that was out of date, used already, or not the latest one",
  "too-many-phones": "tried to pair while the computer had as many phones as it takes",
  "not-paired": "is not paired with this computer",
};

export class PhoneHost {
  private readonly channels = new Map<number, Channel>();
  private readonly clock: Clock;
  /** The secret in the latest pairing link, until a phone uses it, it runs out, or it is cancelled. */
  private pairing: { secret: Bytes; expiresAt: number } | null = null;

  constructor(private readonly options: PhoneHostOptions) {
    this.clock = options.clock ?? SYSTEM_CLOCK;
  }

  /**
   * A new pairing code, for the pairing link Settings shows. Only the latest
   * one pairs: it replaces the secret of any before it, and pairs one phone.
   */
  startPairing(): { code: PairingCode; expiresAt: number } {
    const secret = randomBytes(PAIRING_SECRET_BYTES);
    const expiresAt = this.clock.now() + PAIRING_LIFETIME_MS;
    this.pairing = { secret, expiresAt };
    return { code: { desktopId: this.options.desktopId, desktopKey: this.options.staticKey.publicKey, secret }, expiresAt };
  }

  /** Makes the latest pairing link pair nothing. */
  cancelPairing(): void {
    this.pairing = null;
  }

  /** The keys of the phones connected now, whose messages have opened, each once, however many connections it has. */
  connectedPhones(): string[] {
    const keys = new Set<string>();
    for (const channel of this.channels.values()) {
      if (channel.confirmed && channel.phoneKey !== null) keys.add(channel.phoneKey);
    }
    return [...keys];
  }

  /** Unpairs a phone, and sends away each connection it has, open or not. */
  forgetPhone(key: string): void {
    this.options.savePhones(withoutPhone(this.options.phones(), key));
    for (const [number, channel] of [...this.channels]) {
      if (channel.phoneKey === key) this.shut(number, channel, "was removed from the paired phones");
    }
  }

  /** The relay connected a phone on this channel. */
  opened(number: number): void {
    // A number the relay gives again is a new phone: whatever the old one was doing stops.
    const old = this.channels.get(number);
    if (old !== undefined) this.drop(number, old);
    if (this.channels.size >= MAX_CHANNELS) {
      logWarn(`The relay connected more phones than the phone link keeps (${MAX_CHANNELS}), so one was sent away.`);
      this.options.close(number);
      return;
    }
    const channel: Channel = { state: "waiting", phoneKey: null, link: null, confirmed: false, pending: new Map(), handshakeTimer: null };
    channel.handshakeTimer = this.clock.setTimeout(() => {
      if (channel.state !== "open") this.shut(number, channel, "did not finish connecting in time");
    }, HANDSHAKE_WITHIN_MS);
    this.channels.set(number, channel);
  }

  /** The phone on this channel went, so the relay closed it. Nothing is sent back. */
  closed(number: number): void {
    const channel = this.channels.get(number);
    if (channel !== undefined) this.drop(number, channel);
  }

  /** A message from the phone on this channel. */
  received(number: number, message: Bytes): void {
    const channel = this.channels.get(number);
    if (channel === undefined) return;
    switch (channel.state) {
      case "waiting":
        channel.state = "opening";
        void this.greet(number, channel, message).catch((error: unknown) => {
          logWarn("The phone link could not greet a phone.", error);
          this.shut(number, channel, "could not be greeted");
        });
        return;
      case "opening":
        // A phone waits for the computer's answer before it says anything more.
        this.shut(number, channel, "spoke before it was answered");
        return;
      case "open": {
        const link = channel.link;
        if (link === null) return;
        // The link opens messages in the order they arrive, so requests are handled in the order they were sent.
        void link.receive(message).then(
          (whole) => {
            this.confirm(number, channel);
            this.handle(number, channel, whole);
          },
          () => this.shut(number, channel, "sent a message that could not be opened"),
        );
        return;
      }
    }
  }

  /**
   * Lets go of every phone without sending anything, for when the connection
   * to the relay drops: the relay has let the phones go already. The latest
   * pairing link still pairs.
   */
  dropAll(): void {
    for (const [number, channel] of [...this.channels]) this.drop(number, channel);
  }

  /** Reads the phone's first message, decides whether it is let in, and answers. */
  private async greet(number: number, channel: Channel, first: Bytes): Promise<void> {
    const responder = new Responder({ prologue: PHONE_LINK_PROLOGUE, staticKey: this.options.staticKey });
    let read: { payload: Bytes; remoteStaticKey: Bytes };
    try {
      read = await responder.readFirstMessage(first);
    } catch {
      // Not a phone link handshake, or one meant for another computer's key.
      this.shut(number, channel, "sent a first message that could not be read");
      return;
    }
    if (this.channels.get(number) !== channel) return;
    const opening = readOpening(read.payload);
    if (opening === null) {
      this.shut(number, channel, "sent an opening that could not be read");
      return;
    }
    // Noted before anything is awaited, so that forgetting this phone meanwhile sends this connection away too.
    const key = toBase64Url(read.remoteStaticKey);
    channel.phoneKey = key;
    const answer = this.admit(key, opening);
    const { message, session } = await responder.writeAnswer(writeOpeningAnswer(answer));
    if (this.channels.get(number) !== channel) return;
    if (!answer.ok) {
      // The relay passes on the computer's messages in order, so the phone hears why before it is sent away.
      this.options.send(number, message);
      this.shut(number, channel, TURNED_AWAY[answer.reason]);
      return;
    }
    channel.state = "open";
    channel.link = new Link(session, (sealed) => {
      if (this.channels.get(number) === channel) this.options.send(number, sealed);
    });
    this.clock.clearTimeout(channel.handshakeTimer);
    channel.handshakeTimer = null;
    this.options.send(number, message);
  }

  /**
   * Whether a phone is let in, and what it is told. A pairing is saved here,
   * at once, with nothing awaited, so two phones that use one link at the same
   * moment cannot both pair. A phone that goes before it hears the answer can
   * pair again with a new link. A paired phone is not noted as seen here, as
   * its first message could be one played again: confirm notes it once a
   * message from it opens.
   */
  private admit(key: string, opening: Opening): OpeningAnswer {
    const now = this.clock.now();
    const phones = this.options.phones();
    if (opening.kind === "session") {
      if (!phones.some((known) => known.key === key)) return { ok: false, reason: "not-paired" };
      return { ok: true, name: this.options.computerName };
    }
    const pairing = this.pairing;
    if (pairing === null || now >= pairing.expiresAt || !sameBytes(pairing.secret, opening.secret)) {
      return { ok: false, reason: "expired-code" };
    }
    const next = withPairedPhone(phones, key, opening.name, now);
    // The secret is not used up, so the person can remove a phone and try the same link again.
    if (next === null) return { ok: false, reason: "too-many-phones" };
    this.pairing = null;
    this.options.savePhones(next);
    const phone = next.find((known) => known.key === key);
    if (phone !== undefined) {
      logInfo(`Paired a phone named "${phone.name}".`);
      this.options.onPaired?.(phone);
    }
    return { ok: true, name: this.options.computerName };
  }

  /**
   * Counts a phone as connected, and notes it as seen, the first time a
   * message from it opens on this connection: only the phone itself, which
   * holds the keys of the handshake, could have sent one.
   */
  private confirm(number: number, channel: Channel): void {
    if (channel.confirmed || this.channels.get(number) !== channel) return;
    channel.confirmed = true;
    const phones = this.options.phones();
    const phone = phones.find((known) => known.key === channel.phoneKey);
    if (phone !== undefined) {
      this.options.savePhones(withPhoneSeen(phones, phone.key, this.clock.now()));
      logInfo(`A paired phone connected: "${phone.name}".`);
    }
    this.options.onConnectedChange?.();
  }

  /** Handles one whole message from a phone that is let in. */
  private handle(number: number, channel: Channel, message: Bytes | null): void {
    // Null is a piece of a longer message, which waits for the rest.
    if (message === null || this.channels.get(number) !== channel) return;
    const phoneKey = channel.phoneKey;
    // greet notes the phone's key before it lets the phone in, so this is only in case.
    if (phoneKey === null) return;
    const reading = readRequest(message);
    if (!reading.ok) {
      // Without the request's number, an answer could not say which request it is for.
      if (reading.id === null) this.shut(number, channel, "sent a request that could not be read");
      else this.reply(number, channel, writeRefusal(reading.id, reading.code));
      return;
    }
    const request = reading.request;
    const id = request.id;
    if (channel.pending.has(id)) {
      // Its answer could be taken for the other one's, so the phone app is not working as it should.
      this.shut(number, channel, "reused the number of a request still waiting");
      return;
    }
    if (channel.pending.size >= MAX_PENDING_REQUESTS) {
      this.reply(number, channel, writeRefusal(id, "busy"));
      return;
    }
    const controller = new AbortController();
    const entry: Pending = { controller, timer: null };
    entry.timer = this.clock.setTimeout(() => {
      logWarn(
        `A phone's ${request.method} took longer than ${ANSWER_TIMEOUT_MS / 1000} seconds, so the phone was told the computer took too long.`,
      );
      controller.abort();
      this.finish(number, channel, id, entry, writeRefusal(id, "too-slow"));
    }, ANSWER_TIMEOUT_MS);
    channel.pending.set(id, entry);
    // Started from a resolved promise, so that an answer that throws at once is caught like one that fails later.
    void Promise.resolve()
      .then(() => this.options.answer(request, controller.signal, phoneKey))
      .then(
        (answer) => this.finish(number, channel, id, entry, answer),
        (error: unknown) => {
          if (!controller.signal.aborted) logWarn(`The phone link could not answer a phone's ${request.method}.`, error);
          this.finish(number, channel, id, entry, writeRefusal(id, "failed"));
        },
      );
  }

  /** Sends a request's answer, unless the request was answered already: the phone went, or was told it took too long. */
  private finish(number: number, channel: Channel, id: number, entry: Pending, answer: Bytes): void {
    if (channel.pending.get(id) !== entry) return;
    channel.pending.delete(id);
    this.clock.clearTimeout(entry.timer);
    // The link carries nothing bigger, so the phone hears why instead.
    this.reply(number, channel, answer.length > MAX_LINK_MESSAGE_BYTES ? writeRefusal(id, "too-big") : answer);
  }

  private reply(number: number, channel: Channel, answer: Bytes): void {
    const link = channel.link;
    if (link === null || this.channels.get(number) !== channel) return;
    void link.send(answer).catch(() => this.shut(number, channel, "could not be sent an answer"));
  }

  /** Sends a phone away, and notes why. Nothing happens when that connection is gone already. */
  private shut(number: number, channel: Channel, reason: string): void {
    if (this.channels.get(number) !== channel) return;
    this.drop(number, channel);
    this.options.close(number);
    logInfo(`Closed a phone's connection: it ${reason}.`);
  }

  /** Forgets a connection, and stops each request it was waiting on. */
  private drop(number: number, channel: Channel): void {
    this.clock.clearTimeout(channel.handshakeTimer);
    for (const entry of channel.pending.values()) {
      this.clock.clearTimeout(entry.timer);
      entry.controller.abort();
    }
    channel.pending.clear();
    if (this.channels.get(number) === channel) {
      this.channels.delete(number);
      if (channel.confirmed) this.options.onConnectedChange?.();
    }
  }
}
