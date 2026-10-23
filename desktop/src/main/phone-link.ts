/**
 * The phone link as a whole: what phone-link.json holds
 * (src/core/phone-link-file.ts), the connection to the relay
 * (src/main/phone-relay.ts), the host that lets paired phones in
 * (src/main/phone-host.ts) and the answers to their requests
 * (src/main/phone-requests.ts), put together for src/main/desktop-app.ts and
 * the Settings window.
 *
 * The keys are made the first time the app starts, whether or not the link
 * is ever turned on, so the computer's ID at the relay stays the same from
 * then on. A file that is damaged, or locked with a keyring that did not
 * open, is never replaced: new keys would make this a different computer to
 * every paired phone. The phone link stays unavailable instead, and says why.
 *
 * A change from Settings counts at once, and is saved straight away. If the
 * save fails, that is logged, and the change holds until the app quits.
 *
 * Apart from the log, everything it touches is passed in: the file, the app's
 * server, the socket, the clock and chance, so the tests can play each.
 */
import crypto from "node:crypto";

import { newPhoneLinkState, readConnectionIds, type PairedPhone, type PhoneLinkState } from "../core/phone-link-file";
import { fromBase64UrlOfLength } from "../shared/remote/bytes";
import { KEY_BYTES, importKeyPair, type KeyPair } from "../shared/remote/keys";
import { writePairingLink } from "../shared/remote/pairing";
import { desktopIdFor } from "../shared/remote/relay-auth";
import { readRelayOrigin } from "../shared/remote/relay-protocol";
import type { Clock } from "./clock";
import { addLogSecret, logError, logInfo, logWarn } from "./log";
import { PhoneHost } from "./phone-host";
import { PhoneRelay, type OpenSocket, type RelayStatus } from "./phone-relay";
import { answerRequest, type AppCaller } from "./phone-requests";
import type { ProtectedStore, Protection } from "./secrets";

/** Where the phone link's state is kept: phone-link.json through a ProtectedStore in the app, a fake in the tests. */
export type PhoneLinkStore = Pick<ProtectedStore<PhoneLinkState>, "load" | "save">;

export type PhoneLinkOptions = {
  /** Where the state is kept. */
  store: PhoneLinkStore;
  /** Where phone-link.json is, written as a person would know it, for the reasons the phone link gives. */
  fileLabel: string;
  /** Asks the app's server, for the phones' requests. */
  call: AppCaller;
  /** The version of the app, which phones are told when they connect. */
  appVersion: string;
  /** The name a phone shows for this computer. */
  computerName: string;
  /**
   * Told once a run of changes is done: to a setting, to which phones are
   * connected, or to the connection to the relay. Settings then asks for
   * view(). It is told after the change, never in the middle of one.
   */
  onChange?: () => void;
  /** Told when a phone pairs, after it is saved, so that Settings can put the pairing link away. */
  onPaired?: (phone: PairedPhone) => void;
  /** Opens the socket to the relay: a real WebSocket unless a test passes its own. */
  openSocket?: OpenSocket;
  /** The time and timers: the computer's own clock unless a test passes one. */
  clock?: Clock;
  /** A random number from 0 up to 1, to spread the relay's waits out: Math.random unless a test passes one. */
  random?: () => number;
  /** Random bytes for new keys: crypto.randomBytes unless a test passes its own. */
  randomBytes?: (size: number) => Buffer;
};

/**
 * Where the phone link stands, for Settings: "off" while it is turned off,
 * "needs-relay" while it is turned on with no relay to use yet, and otherwise
 * where the connection to the relay stands.
 */
export type PhoneLinkStatus = RelayStatus | { state: "needs-relay" };

/** What Settings shows. */
export type PhoneLinkView = {
  status: PhoneLinkStatus;
  enabled: boolean;
  relayOrigin: string | null;
  sharedConnectionIds: number[];
  /** The paired phones, and whether each is connected now. */
  phones: Array<PairedPhone & { connected: boolean }>;
};

/** A phone link ready to start, or why there is none, written for a person. */
export type PhoneLinkOpening = { ok: true; link: PhoneLink } | { ok: false; reason: string };

/** The keys, opened, and the computer's ID at the relay that comes from them. */
type Keys = { signingKey: KeyPair; staticKey: KeyPair; desktopId: string };

/**
 * Reads phone-link.json, making it with new keys the first time, and opens
 * the keys. The link it gives has not started.
 */
export async function openPhoneLink(options: PhoneLinkOptions): Promise<PhoneLinkOpening> {
  const loaded = loadState(options);
  if (!loaded.ok) return loaded;
  const keys = await openKeys(loaded.state);
  if (keys === null) return { ok: false, reason: "The phone link could not open its keys. Schema Studio's log has the details." };
  return { ok: true, link: new PhoneLink(options, loaded.state, keys) };
}

/** Keeps the keys out of the log, should one ever end up in a message. */
function hideKeys(state: PhoneLinkState): void {
  addLogSecret(state.signingKey);
  addLogSecret(state.staticKey);
}

/** The saved state, or new state with new keys, saved, the first time. It opens the file as steps.ts opens the app's own keys. */
function loadState(options: PhoneLinkOptions): { ok: true; state: PhoneLinkState } | { ok: false; reason: string } {
  const { store, fileLabel } = options;
  const loaded = store.load();
  switch (loaded.status) {
    case "missing": {
      const state = newPhoneLinkState(options.randomBytes ?? ((size) => crypto.randomBytes(size)));
      hideKeys(state);
      let protection: Protection;
      try {
        protection = store.save(state);
      } catch (error) {
        // Keys that were never saved would be new again at the next start, and
        // each phone paired in between would need pairing again.
        logWarn("Could not save new keys for the phone link.", error);
        return {
          ok: false,
          reason: `Schema Studio could not save the phone link's keys in ${fileLabel}. Check that there is space on the disk, then start Schema Studio again.`,
        };
      }
      logInfo(
        protection === "keyring"
          ? "Made new keys for the phone link and locked them in the login keyring."
          : "Made new keys for the phone link and kept them in a file only you can read.",
      );
      return { ok: true, state };
    }
    case "values":
      hideKeys(loaded.values);
      if (loaded.upgrade) {
        try {
          if (store.save(loaded.values) === "keyring") logInfo("Moved the phone link's keys into the login keyring.");
        } catch (error) {
          logWarn("Could not move the phone link's keys into the login keyring, so they stay in a file only you can read.", error);
        }
      }
      return { ok: true, state: loaded.values };
    case "locked":
      logWarn(loaded.message);
      return {
        ok: false,
        reason: `The phone link's keys are locked with your login keyring, and the keyring did not open. Log out and back in, or unlock the "Login" keyring in Passwords and Keys, then start Schema Studio again.`,
      };
    case "damaged":
      logWarn(loaded.message);
      return {
        ok: false,
        reason: `The file that holds the phone link's keys (${fileLabel}) is damaged. Restore it from a backup, or move it somewhere else and start Schema Studio again to make new keys. With new keys, each phone needs pairing again.`,
      };
  }
}

/** The keys, ready to use, or null when they cannot be opened, which is logged. */
async function openKeys(state: PhoneLinkState): Promise<Keys | null> {
  try {
    const signing = fromBase64UrlOfLength(state.signingKey, KEY_BYTES);
    const handshake = fromBase64UrlOfLength(state.staticKey, KEY_BYTES);
    // parsePhoneLinkState and newPhoneLinkState make sure of this, so it is only in case.
    if (signing === null || handshake === null) throw new Error(`A phone link key is not ${KEY_BYTES} bytes written in base64url.`);
    const signingKey = await importKeyPair("Ed25519", signing);
    const staticKey = await importKeyPair("X25519", handshake);
    return { signingKey, staticKey, desktopId: await desktopIdFor(signingKey.publicKey) };
  } catch (error) {
    logWarn("The phone link could not open its keys.", error);
    return null;
  }
}

/**
 * The phone link: the paired phones, and a connection to the relay while the
 * link is turned on and has a relay, kept in step with what Settings asks for.
 */
export class PhoneLink {
  private readonly host: PhoneHost;
  /** The connection to the relay, while the link is running, turned on and has a relay. */
  private connection: { origin: string; relay: PhoneRelay } | null = null;
  /** "ready" until start(), "running" until stop(), and "stopped" for good after that. */
  private phase: "ready" | "running" | "stopped" = "ready";
  /** Whether onChange is about to be told already. */
  private changeDue = false;

  /** Made by openPhoneLink. */
  constructor(
    private readonly options: PhoneLinkOptions,
    private state: PhoneLinkState,
    private readonly keys: Keys,
  ) {
    this.host = new PhoneHost({
      staticKey: keys.staticKey,
      desktopId: keys.desktopId,
      computerName: options.computerName,
      phones: () => this.state.phones,
      savePhones: (phones) => {
        this.state = { ...this.state, phones };
        this.saveState();
      },
      answer: (request, signal) =>
        answerRequest(
          request,
          { call: options.call, sharedConnectionIds: () => this.state.sharedConnectionIds, appVersion: options.appVersion },
          signal,
        ),
      // Only the connection in use is sent to: the host's phones went with any before it.
      send: (channel, message) => this.connection?.relay.send(channel, message),
      close: (channel) => this.connection?.relay.close(channel),
      // Told after the pairing is saved, in a microtask like onChange, so that the app's code never runs in the middle of the host's.
      onPaired: (phone) => queueMicrotask(() => this.tell(() => this.options.onPaired?.(phone))),
      onConnectedChange: () => this.changed(),
      clock: options.clock,
    });
  }

  /** Connects to the relay if the link is turned on and has one. Only the first call counts. */
  start(): void {
    if (this.phase !== "ready") return;
    this.phase = "running";
    this.refreshRelay();
  }

  /**
   * Lets go of the relay for good, as the app quits. A change made after this
   * is still saved, but no connection is made again.
   */
  stop(): void {
    this.phase = "stopped";
    this.host.cancelPairing();
    this.refreshRelay();
  }

  status(): PhoneLinkStatus {
    if (!this.state.enabled) return { state: "off" };
    if (this.state.relayOrigin === null) return { state: "needs-relay" };
    return this.connection?.relay.status() ?? { state: "off" };
  }

  view(): PhoneLinkView {
    const connected = new Set(this.host.connectedPhones());
    return {
      status: this.status(),
      enabled: this.state.enabled,
      relayOrigin: this.state.relayOrigin,
      sharedConnectionIds: [...this.state.sharedConnectionIds],
      phones: this.state.phones.map((phone) => ({ ...phone, connected: connected.has(phone.key) })),
    };
  }

  /**
   * A new pairing link, for Settings to show as a QR code, and when it runs
   * out. Only the latest one pairs, and it pairs one phone. Null while there
   * is no connection to the relay for a phone to pair through.
   */
  newPairingLink(): { link: string; expiresAt: number } | null {
    if (this.connection === null) return null;
    const { code, expiresAt } = this.host.startPairing();
    return { link: writePairingLink(this.connection.origin, code), expiresAt };
  }

  /** Makes the latest pairing link pair nothing, for when Settings puts it away. */
  cancelPairing(): void {
    this.host.cancelPairing();
  }

  /** Turns the link on or off. Anything but true or false is ignored. */
  setEnabled(enabled: unknown): void {
    if (typeof enabled !== "boolean" || enabled === this.state.enabled) return;
    // A pairing link shown before must not pair a phone once the link is back on.
    if (!enabled) this.host.cancelPairing();
    logInfo(enabled ? "The phone link was turned on." : "The phone link was turned off.");
    this.state = { ...this.state, enabled };
    this.refreshRelay();
    this.saveState();
  }

  /**
   * Sets the relay's address, and gives false, changing nothing, when the
   * text is not one. Phones paired through another relay keep using that
   * one, so they need pairing again.
   */
  setRelayOrigin(text: unknown): boolean {
    const origin = typeof text === "string" ? readRelayOrigin(text) : null;
    if (origin === null) return false;
    if (origin === this.state.relayOrigin) return true;
    // A pairing link names the relay, so one made for the old relay would lead nowhere.
    this.host.cancelPairing();
    logInfo(`The phone link's relay is now ${origin}.`);
    this.state = { ...this.state, relayOrigin: origin };
    this.refreshRelay();
    this.saveState();
    return true;
  }

  /** Sets which saved connections phones may see, by their numbers. Anything that is not a connection's number is left out. */
  setSharedConnections(ids: unknown): void {
    const shared = readConnectionIds(ids);
    const current = this.state.sharedConnectionIds;
    if (shared.length === current.length && shared.every((id, index) => id === current[index])) return;
    logInfo(`Phones may now see ${shared.length} saved ${shared.length === 1 ? "connection" : "connections"}.`);
    this.state = { ...this.state, sharedConnectionIds: shared };
    this.saveState();
  }

  /** Unpairs a phone, by its key, and sends away each connection it has. */
  forgetPhone(key: unknown): void {
    const phone = this.state.phones.find((known) => known.key === key);
    if (phone === undefined) return;
    logInfo(`Removed the phone "${phone.name}" from the paired phones.`);
    this.host.forgetPhone(phone.key);
  }

  /**
   * For Settings' "Connect now": connects at once instead of waiting to try
   * again, and takes the place back after another connection signed in as
   * this computer and took it.
   */
  connectNow(): void {
    const relay = this.connection?.relay;
    if (relay === undefined) return;
    if (relay.status().state === "replaced") relay.start();
    else relay.retryNow();
  }

  /** Saves the state. A failure is logged, and the change holds until the app quits. */
  private saveState(): void {
    try {
      this.options.store.save(this.state);
    } catch (error) {
      logWarn("Could not save the phone link's settings, so the change lasts only until Schema Studio quits.", error);
    }
    this.changed();
  }

  /** Makes, moves or closes the connection to the relay, to match the state. */
  private refreshRelay(): void {
    const wanted = this.phase === "running" && this.state.enabled ? this.state.relayOrigin : null;
    if ((this.connection?.origin ?? null) === wanted) return;
    // Let go first, so that the host sends nothing more to the old connection while it closes.
    const old = this.connection;
    this.connection = null;
    old?.relay.stop();
    if (wanted === null) return;
    let relay: PhoneRelay;
    try {
      relay = new PhoneRelay({
        relayOrigin: wanted,
        desktopId: this.keys.desktopId,
        signingKey: this.keys.signingKey,
        phones: this.host,
        onStatus: () => this.changed(),
        openSocket: this.options.openSocket,
        clock: this.options.clock,
        random: this.options.random,
      });
    } catch (error) {
      // The address was checked when it was set, so this would be a mistake in the code.
      logError(`The phone link could not use the relay at ${wanted}.`, error);
      return;
    }
    this.connection = { origin: wanted, relay };
    logInfo(`Connecting the phone link to the relay at ${wanted}.`);
    relay.start();
  }

  /**
   * Tells onChange once the change being made is done, so that Settings never
   * sees one half made, and hears once of a run of changes.
   */
  private changed(): void {
    if (this.changeDue) return;
    this.changeDue = true;
    queueMicrotask(() => {
      this.changeDue = false;
      this.tell(() => this.options.onChange?.());
    });
  }

  /** Passes news on to the app. It runs on its own, after the change, where a mistake in the app's code that throws would go unhandled. */
  private tell(run: () => void): void {
    try {
      run();
    } catch (error) {
      logError("The phone link could not pass news on to the app.", error);
    }
  }
}
