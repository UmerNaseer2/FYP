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
 * The push key that signs drift alerts is the one exception: when there is
 * none that can be read, a new one is made, which only means each phone turns
 * its alerts on again (src/core/phone-link-file.ts says why).
 *
 * A change from Settings, or a phone turning its own drift alerts on or off,
 * counts at once, and is saved straight away. If the save fails, that is
 * logged, and the change holds until the app quits.
 *
 * Drift alerts go to each phone that turned them on (src/main/phone-push.ts),
 * but only while the link is on, only those about connections phones may see,
 * and only while the role signed in here may see drift, which the app's
 * server is asked each time. Alerts that come while others are still being
 * sent wait, and then go together in one message.
 *
 * A phone may also approve or reject the deploy and rollback requests waiting
 * in the app (src/main/phone-approvals.ts), but only once Allow approvals in
 * Settings has let it set up a passkey, and only as the person who was signed
 * in when it did. Turning the link off, or moving it to another relay, ends
 * any time a phone was given to set one up. Moving it to another relay also
 * takes every passkey away, since a passkey only ever signs for the relay it
 * was made at.
 *
 * Apart from the log, everything it touches is passed in: the file, the app's
 * server, the socket, the push services, the clock and chance, so the tests
 * can play each.
 */
import crypto from "node:crypto";

import type { DriftAlert } from "../core/drift-alerts";
import {
  newPhoneLinkState,
  readConnectionIds,
  withNewPushKey,
  withPhoneAction,
  withPhoneControl,
  withPhonePasskey,
  withPhoneSubscription,
  withoutPasskeys,
  type PairedPhone,
  type PhoneAction,
  type PhoneLinkState,
} from "../core/phone-link-file";
import { pushSubject, readPushKey, type PushKey, type PushSubscriptionFields, type PushTransport } from "../core/web-push";
import { fromBase64UrlOfLength } from "../shared/remote/bytes";
import { KEY_BYTES, importKeyPair, type KeyPair } from "../shared/remote/keys";
import { writePairingLink } from "../shared/remote/pairing";
import { desktopIdFor } from "../shared/remote/relay-auth";
import { readRelayOrigin } from "../shared/remote/relay-protocol";
import { lockCodeBox, makeCodeKeys, makeShortCode, showShortCode } from "../shared/remote/short-code";
import { SYSTEM_CLOCK, type Clock } from "./clock";
import type { CodeBoxSender } from "./code-box-sender";
import { addLogSecret, logError, logInfo, logWarn } from "./log";
import { PhoneApprovals } from "./phone-approvals";
import { PhoneControlActions } from "./phone-control";
import { PhoneHost, type PhoneHostOptions } from "./phone-host";
import { PushSender } from "./phone-push";
import { PhoneRelay, type OpenSocket, type RelayStatus } from "./phone-relay";
import { answerRequest, driftAlertsAllowed, type AppCaller, type PhoneControl, type Refusal, type RequestOptions } from "./phone-requests";
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
  /** Sends drift alerts to the phones' push services (src/main/push-transport.ts). Tests pass in a fake push service. */
  pushTransport: PushTransport;
  /** Leaves a short pairing code's locked box at the relay (src/main/code-box-sender.ts). With none, Settings shows the QR code alone. */
  sendCodeBox?: CodeBoxSender;
  /** Asks the person at the computer whether a browser that came with a short code may pair. With none, the answer is no. */
  askToPair?: PhoneHostOptions["askToPair"];
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
  /** The shared connections whose running SQL phones may read. */
  queryTextConnectionIds: number[];
  /** Whether the computer stays awake for its phones while the link is on. */
  keepAwake: boolean;
  /** Whether a short code to type could still pair a browser. It stops being so once used, as well as when it runs out. */
  typedCodeLive: boolean;
  /**
   * The paired phones, whether each is connected now, whether it gets drift
   * alerts, whether it may approve requests, while it may set that up until
   * when, and whether Allow control is on for it. Where a phone's alerts go,
   * and its passkey, never leave main.
   */
  phones: Array<Omit<PairedPhone, "push" | "passkey" | "control"> & { connected: boolean; alerts: boolean; approvals: boolean; approvalsAllowedUntil: number | null; control: boolean }>;
  /** What phones tried to change, newest first. */
  actions: PhoneAction[];
};

/** A phone link ready to start, or why there is none, written for a person. */
export type PhoneLinkOpening = { ok: true; link: PhoneLink } | { ok: false; reason: string };

/** The keys, opened, and the computer's ID at the relay that comes from them. */
type Keys = { signingKey: KeyPair; staticKey: KeyPair; desktopId: string; push: PushKey };

/** How long the app's server has to say whether the signed-in role may see drift. It answers at once unless something is wrong. */
const DRIFT_ACCESS_TIMEOUT_MS = 30_000;

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
  if (state.pushKey !== null) addLogSecret(state.pushKey);
}

/** crypto.randomBytes, unless a test passed its own. */
function randomBytesOf(options: PhoneLinkOptions): (size: number) => Buffer {
  return options.randomBytes ?? ((size) => crypto.randomBytes(size));
}

/** The saved state, or new state with new keys, saved, the first time. It opens the file as steps.ts opens the app's own keys. */
function loadState(options: PhoneLinkOptions): { ok: true; state: PhoneLinkState } | { ok: false; reason: string } {
  const { store, fileLabel } = options;
  const loaded = store.load();
  switch (loaded.status) {
    case "missing": {
      const state = newPhoneLinkState(randomBytesOf(options));
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
      if (loaded.values.pushKey === null) return { ok: true, state: withSavedPushKey(loaded.values, options, loaded.upgrade) };
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

/**
 * The state with a new push key, saved, for a file with none that can be
 * read: one from before drift alerts went to phones, or a damaged one. Each
 * phone's alerts go with the old key (withNewPushKey says why). The one save
 * also moves the keys into the login keyring when loading asked for that. If
 * it fails, that is logged, and the new key lasts until the app quits.
 */
function withSavedPushKey(state: PhoneLinkState, options: PhoneLinkOptions, upgrade: boolean): PhoneLinkState {
  const next = withNewPushKey(state, randomBytesOf(options));
  hideKeys(next);
  logInfo(
    state.phones.some((phone) => phone.push !== undefined)
      ? "Made a new key for sending drift alerts to phones, so each phone that had them on needs to turn them on again."
      : "Made a new key for sending drift alerts to phones.",
  );
  try {
    if (options.store.save(next) === "keyring" && upgrade) logInfo("Moved the phone link's keys into the login keyring.");
  } catch (error) {
    logWarn("Could not save the phone link's new key for drift alerts, so it lasts only until Schema Studio quits.", error);
  }
  return next;
}

/** The keys, ready to use, or null when they cannot be opened, which is logged. */
async function openKeys(state: PhoneLinkState): Promise<Keys | null> {
  try {
    const signing = fromBase64UrlOfLength(state.signingKey, KEY_BYTES);
    const handshake = fromBase64UrlOfLength(state.staticKey, KEY_BYTES);
    const push = readPushKey(state.pushKey);
    // parsePhoneLinkState, newPhoneLinkState and loadState make sure of these, so they are only in case.
    if (signing === null || handshake === null) throw new Error(`A phone link key is not ${KEY_BYTES} bytes written in base64url.`);
    if (push === null) throw new Error("The phone link's push key is not a P-256 private key written in base64url.");
    const signingKey = await importKeyPair("Ed25519", signing);
    const staticKey = await importKeyPair("X25519", handshake);
    return { signingKey, staticKey, desktopId: await desktopIdFor(signingKey.publicKey), push };
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
  /** The time and timers: the computer's own unless a test passed a clock. */
  private readonly clock: Clock;
  /** Sends drift alerts to the phones that turned them on. */
  private readonly push: PushSender;
  /** The drift alerts being sent to phones, which the next ones wait for. */
  private pushing: Promise<void> = Promise.resolve();
  /** Drift alerts waiting for those being sent, which go together in one message, and when they will have gone. */
  private waiting: { alerts: DriftAlert[]; sent: Promise<void> } | null = null;
  /** Why drift alerts last did not go to phones, so that the log says so once, not with every alert. */
  private pushRefusal: Refusal | null = null;
  /** Lets paired phones approve or reject the app's deploy and rollback requests. */
  private readonly approvals: PhoneApprovals;
  private readonly controlActions: PhoneControlActions;

  /** Made by openPhoneLink. */
  constructor(
    private readonly options: PhoneLinkOptions,
    private state: PhoneLinkState,
    private readonly keys: Keys,
  ) {
    this.clock = options.clock ?? SYSTEM_CLOCK;
    this.host = new PhoneHost({
      staticKey: keys.staticKey,
      desktopId: keys.desktopId,
      computerName: options.computerName,
      phones: () => this.state.phones,
      savePhones: (phones) => {
        this.state = { ...this.state, phones };
        this.saveState();
      },
      answer: (request, signal, phoneKey) => answerRequest(request, this.requestOptions(phoneKey), signal),
      // Only the connection in use is sent to: the host's phones went with any before it.
      send: (channel, message) => this.connection?.relay.send(channel, message),
      close: (channel) => this.connection?.relay.close(channel),
      // Told after the pairing is saved, in a microtask like onChange, so that the app's code never runs in the middle of the host's.
      onPaired: (phone) => queueMicrotask(() => this.tell(() => this.options.onPaired?.(phone))),
      onConnectedChange: () => this.changed(),
      askToPair: options.askToPair,
      onTypedCodeChange: () => this.changed(),
      clock: options.clock,
    });
    this.push = new PushSender({
      transport: options.pushTransport,
      key: keys.push,
      forget: (phoneKey, endpoint) => this.forgetSubscription(phoneKey, endpoint),
      clock: options.clock,
    });
    this.approvals = new PhoneApprovals({
      call: options.call,
      sharedConnectionIds: () => this.state.sharedConnectionIds,
      relayOrigin: () => this.state.relayOrigin,
      phone: (phoneKey) => this.state.phones.find((phone) => phone.key === phoneKey),
      savePasskey: (phoneKey, passkey) => {
        this.state = { ...this.state, phones: withPhonePasskey(this.state.phones, phoneKey, passkey) };
        this.saveState();
      },
      onChange: () => this.changed(),
      clock: options.clock,
    });
    this.controlActions = new PhoneControlActions({
      call: options.call,
      sharedConnectionIds: () => this.state.sharedConnectionIds,
      approvals: this.approvals,
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
    this.approvals.forgetAll();
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
      queryTextConnectionIds: [...this.state.queryTextConnectionIds],
      keepAwake: this.state.keepAwake,
      typedCodeLive: this.host.typedCodeIsGood(),
      // Named one by one, so that where a phone's alerts go, and its passkey, are never passed on.
      phones: this.state.phones.map(({ key, name, pairedAt, lastSeenAt, push, passkey, control }) => ({
        key,
        name,
        pairedAt,
        lastSeenAt,
        connected: connected.has(key),
        alerts: push !== undefined,
        approvals: passkey !== undefined,
        approvalsAllowedUntil: this.approvals.allowedUntil(key),
        control: control !== undefined,
      })),
      actions: [...this.state.actionLog].reverse(),
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

  /**
   * A new pairing for Settings to show: the pairing link for the QR code, when
   * it runs out, and a short code to type in a browser with no camera. The
   * short code is null when its box could not be left at the relay, or when
   * the pairing was replaced or put away meanwhile, and the QR code still
   * works then. Null while there is no connection to the relay, as for
   * newPairingLink.
   */
  async newPairing(): Promise<{ link: string; expiresAt: number; shortCode: string | null } | null> {
    const made = this.newPairingLink();
    if (made === null) return null;
    return { ...made, shortCode: await this.newShortCode() };
  }
  /** Leaves a locked pairing link at the relay, and gives the short code that opens it. Never throws. */
  private async newShortCode(): Promise<string | null> {
    const send = this.options.sendCodeBox;
    const origin = this.connection?.origin;
    if (send === undefined || origin === undefined) return null;
    // Made after the pairing link, which would replace it.
    const { code } = this.host.startTypedPairing();
    try {
      const link = writePairingLink(origin, code);
      // A label that holds a box already is another code's, which is very unlikely, so one more try is plenty.
      for (let tries = 0; tries < 2; tries += 1) {
        const shortCode = makeShortCode();
        // Never logged anyway. Masked in both forms because a log masks only the exact text.
        addLogSecret(shortCode);
        addLogSecret(showShortCode(shortCode));
        const keys = await makeCodeKeys(shortCode, origin);
        const answer = await send(origin, keys.label, await lockCodeBox(keys, link));
        // A cancel or a newer pairing while the box was on its way has made this code pair nothing, so it is not shown.
        if (answer === "stored") return this.host.holdsTypedCode(code.secret) ? shortCode : null;
        if (answer === "failed") break;
      }
    } catch (error) {
      logWarn(`Could not make a short pairing code: ${String(error)}`);
    }
    logWarn("A short pairing code could not be left at the relay, so only the QR code works for now.");
    return null;
  }
  /** Makes the latest pairing link pair nothing, for when Settings puts it away. */
  cancelPairing(): void {
    this.host.cancelPairing();
  }

  /** Turns the link on or off. Anything but true or false is ignored. */
  setEnabled(enabled: unknown): void {
    if (typeof enabled !== "boolean" || enabled === this.state.enabled) return;
    // A pairing link shown before must not pair a phone once the link is back on, nor a phone set up approvals then.
    if (!enabled) {
      this.host.cancelPairing();
      this.approvals.forgetAll();
    }
    logInfo(enabled ? "The phone link was turned on." : "The phone link was turned off.");
    this.state = { ...this.state, enabled };
    this.refreshRelay();
    this.saveState();
  }

  /** Sets whether the computer stays awake for its phones while the link is on. Anything but true or false is ignored. */
  setKeepAwake(keepAwake: unknown): void {
    if (typeof keepAwake !== "boolean" || keepAwake === this.state.keepAwake) return;
    logInfo(keepAwake ? "The computer will stay awake while the phone link is on." : "The computer may sleep while the phone link is on.");
    this.state = { ...this.state, keepAwake };
    this.saveState();
  }

  /**
   * Sets the relay's address, and gives false, changing nothing, when the
   * text is not one. Phones paired through another relay keep using that
   * one, so they need pairing again. Approvals are turned off on every phone,
   * since a passkey only ever signs for the relay it was made at.
   */
  setRelayOrigin(text: unknown): boolean {
    const origin = typeof text === "string" ? readRelayOrigin(text) : null;
    if (origin === null) return false;
    if (origin === this.state.relayOrigin) return true;
    // A pairing link names the relay, so one made for the old relay would lead nowhere.
    this.host.cancelPairing();
    this.approvals.forgetAll();
    logInfo(`The phone link's relay is now ${origin}.`);
    const withPasskeys = this.state.phones.filter((phone) => phone.passkey !== undefined).length;
    if (withPasskeys > 0) {
      const which = withPasskeys === 1 ? "1 phone, since its passkey was" : `${withPasskeys} phones, since their passkeys were`;
      logInfo(`Approvals were turned off on ${which} made for the old relay.`);
    }
    this.state = { ...this.state, relayOrigin: origin, phones: withoutPasskeys(this.state.phones) };
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
    // A connection taken off the list loses this too, so sharing it again one
    // day never turns its SQL back on without the person choosing to.
    const queryText = this.state.queryTextConnectionIds.filter((id) => shared.includes(id));
    this.state = { ...this.state, sharedConnectionIds: shared, queryTextConnectionIds: queryText };
    this.saveState();
  }

  /** Sets which shared connections' running SQL phones may read, by their numbers. A connection that is not shared is left out. */
  setQueryTextConnections(ids: unknown): void {
    const queryText = readConnectionIds(ids).filter((id) => this.state.sharedConnectionIds.includes(id));
    const current = this.state.queryTextConnectionIds;
    if (queryText.length === current.length && queryText.every((id, index) => id === current[index])) return;
    logInfo(`Phones may now read the running SQL of ${queryText.length} saved ${queryText.length === 1 ? "connection" : "connections"}.`);
    this.state = { ...this.state, queryTextConnectionIds: queryText };
    this.saveState();
  }

  /** Unpairs a phone, by its key, and sends away each connection it has. */
  forgetPhone(key: unknown): void {
    const phone = this.state.phones.find((known) => known.key === key);
    if (phone === undefined) return;
    logInfo(`Removed the phone "${phone.name}" from the paired phones.`);
    this.approvals.forget(phone.key);
    this.host.forgetPhone(phone.key);
  }

  /**
   * For Settings' "Allow approvals": lets a paired phone, by its key, set up
   * its passkey within the next 5 minutes. Anything that is not a paired
   * phone's key is ignored, and so is everything while the link is off, as
   * a phone could not reach this computer to set one up then.
   */
  allowApprovals(key: unknown): void {
    const phone = this.state.phones.find((known) => known.key === key);
    if (phone === undefined || !this.state.enabled) return;
    logInfo(`Approvals may be set up on the phone "${phone.name}" for the next 5 minutes.`);
    this.approvals.allow(phone.key);
  }

  /**
   * For Settings' "Allow control": the phone with this key may check and
   * acknowledge drift from now on, until it is turned off. It is the one way
   * this gets turned on, and a phone cannot ask for it. A phone with no passkey
   * also gets its 5 minutes to set one up, since starting a run or cancelling a
   * query needs one.
   */
  allowControl(key: unknown): void {
    const phone = this.state.phones.find((known) => known.key === key);
    if (phone === undefined || !this.state.enabled || phone.control !== undefined) return;
    logInfo(`Allow control was turned on for the phone "${phone.name}".`);
    this.state = { ...this.state, phones: withPhoneControl(this.state.phones, phone.key, this.now()) };
    this.saveState();
    if (phone.passkey === undefined) this.approvals.allow(phone.key);
  }

  /** For Settings' "Turn off control". It counts at once, since every request reads it, and works with the link off too. */
  turnOffControl(key: unknown): void {
    const phone = this.state.phones.find((known) => known.key === key);
    if (phone === undefined || phone.control === undefined) return;
    logInfo(`Allow control was turned off for the phone "${phone.name}".`);
    this.state = { ...this.state, phones: withPhoneControl(this.state.phones, phone.key, null) };
    this.saveState();
  }

  /**
   * For Settings' "Turn off approvals": the phone with this key decides
   * nothing from now on, until approvals are set up on it again. Any time it
   * was given to set them up ends too.
   */
  turnOffApprovals(key: unknown): void {
    const phone = this.state.phones.find((known) => known.key === key);
    if (phone === undefined) return;
    this.approvals.forget(phone.key);
    if (phone.passkey === undefined) {
      logInfo(`The phone "${phone.name}" may no longer set up approvals.`);
      this.changed();
      return;
    }
    logInfo(`Approvals were turned off on the phone "${phone.name}".`);
    this.state = { ...this.state, phones: withPhonePasskey(this.state.phones, phone.key, null) };
    this.saveState();
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

  /**
   * For when the computer wakes from sleep: checks at once that the
   * connection to the relay still works, and connects again if it died
   * while the computer slept.
   */
  checkNow(): void {
    this.connection?.relay.checkNow();
  }

  /**
   * Sends drift alerts to each phone that turned them on, for the app's drift
   * watcher. Alerts that come while others are being sent wait, and go
   * together in one message once those have gone, so phones get them in
   * order and a slow push service never piles them up. It never throws, and
   * settles once these alerts have gone to every phone or been let go.
   */
  pushDrift(alerts: readonly DriftAlert[]): Promise<void> {
    if (this.waiting !== null) {
      this.waiting.alerts.push(...alerts);
      return this.waiting.sent;
    }
    const batch: DriftAlert[] = [...alerts];
    const sent = this.pushing
      .then(() => {
        // Alerts that come from now on wait for these to go.
        this.waiting = null;
        return this.sendDrift(batch);
      })
      .catch((error: unknown) => logError("The phone link could not send drift alerts to phones.", error));
    this.waiting = { alerts: batch, sent };
    this.pushing = sent;
    return sent;
  }

  /**
   * What answers the requests of the phone with this key. Its drift alerts
   * and its approvals are bound to it here, so a phone can only ever turn its
   * own alerts on or off, and only ever decide with its own passkey.
   */
  private requestOptions(phoneKey: string): RequestOptions {
    const control: PhoneControl = {
      allowed: () => this.state.phones.some((phone) => phone.key === phoneKey && phone.control !== undefined),
      record: (entry) => this.recordAction(phoneKey, entry),
    };
    return {
      call: this.options.call,
      sharedConnectionIds: () => this.state.sharedConnectionIds,
      queryTextConnectionIds: () => this.state.queryTextConnectionIds,
      appVersion: this.options.appVersion,
      alerts: {
        key: this.keys.push.publicKey.toString("base64url"),
        on: () => this.state.phones.some((phone) => phone.key === phoneKey && phone.push !== undefined),
        set: (subscription) => this.setDriftAlerts(phoneKey, subscription),
      },
      approvals: this.approvals.forPhone(phoneKey),
      control,
      controlRequests: this.controlActions.forPhone(phoneKey, control),
    };
  }

  /** Writes a phone's try in the action log, with its name as it is now. A phone removed while its request ran is still written, as "Phone". */
  private recordAction(phoneKey: string, entry: Omit<PhoneAction, "at" | "phone">): void {
    const phone = this.state.phones.find((known) => known.key === phoneKey)?.name ?? "Phone";
    // Which connection and schema stay out of the log file, as they do for every request (see ask in src/main/phone-requests.ts).
    logInfo(`The phone "${phone}" tried ${entry.action}: ${entry.outcome}.`);
    this.state = { ...this.state, actionLog: withPhoneAction(this.state.actionLog, { ...entry, at: this.now(), phone }) };
    this.saveState();
  }

  /**
   * Turns a phone's drift alerts on with the subscription its browser made,
   * or off with null, as the phone asked (src/main/phone-requests.ts checks
   * that it may). Nothing is saved when nothing changes, and a phone removed
   * meanwhile stays removed.
   */
  private setDriftAlerts(phoneKey: string, subscription: PushSubscriptionFields | null): void {
    const phone = this.state.phones.find((known) => known.key === phoneKey);
    if (phone === undefined) return;
    const old = phone.push;
    if (subscription === null) {
      if (old === undefined) return;
      logInfo(`The phone "${phone.name}" turned drift alerts off.`);
    } else {
      const same = old !== undefined && old.endpoint === subscription.endpoint && old.p256dh === subscription.p256dh && old.auth === subscription.auth;
      if (same) return;
      // Where the alerts go is never logged: only that they changed.
      logInfo(old === undefined ? `The phone "${phone.name}" turned drift alerts on.` : `The phone "${phone.name}" renewed its drift alerts.`);
    }
    // Named one by one, so that only what phone-link.json keeps is saved.
    const next =
      subscription === null ? null : { endpoint: subscription.endpoint, p256dh: subscription.p256dh, auth: subscription.auth, since: this.now() };
    this.state = { ...this.state, phones: withPhoneSubscription(this.state.phones, phoneKey, next) };
    this.saveState();
  }

  /**
   * The alerts phones may get now: only those about connections phones may
   * see, and none while the link is not running or is turned off, or while no
   * phone has its alerts on.
   */
  private alertsFor(alerts: readonly DriftAlert[]): DriftAlert[] {
    if (this.phase !== "running" || !this.state.enabled || !this.state.phones.some((phone) => phone.push !== undefined)) return [];
    const shared = new Set(this.state.sharedConnectionIds);
    return alerts.filter((alert) => alert.connectionId !== null && shared.has(alert.connectionId));
  }

  /** Sends the alerts phones may get to each phone that turned them on, once the app's server says the signed-in role may see drift. */
  private async sendDrift(alerts: readonly DriftAlert[]): Promise<void> {
    // The server is only asked when there is something to send.
    if (this.alertsFor(alerts).length === 0) return;
    const allowed = await this.driftAllowed();
    if (allowed !== "yes") {
      if (allowed !== this.pushRefusal) {
        if (allowed === "signed-out") logInfo("Drift alerts did not go to phones, because nobody is signed in to Schema Studio.");
        else if (allowed === "forbidden") logInfo("Drift alerts did not go to phones, because the signed-in role may not see drift.");
        else logWarn("Drift alerts did not go to phones, because the app could not say whether the signed-in role may see drift.");
      }
      this.pushRefusal = allowed;
      return;
    }
    this.pushRefusal = null;
    // Settings or a phone can change things while the server answers, so what goes, and to whom, is worked out again.
    const wanted = this.alertsFor(alerts);
    if (wanted.length === 0) return;
    const phones = this.state.phones.flatMap(({ key, name, push }) => (push === undefined ? [] : [{ key, name, push }]));
    await this.push.send(phones, wanted, pushSubject(this.state.relayOrigin));
  }

  /** Asks the app's server whether the signed-in role may see drift, giving up after DRIFT_ACCESS_TIMEOUT_MS. */
  private async driftAllowed(): Promise<"yes" | Refusal> {
    const controller = new AbortController();
    const timer = this.clock.setTimeout(() => controller.abort(), DRIFT_ACCESS_TIMEOUT_MS);
    try {
      return await driftAlertsAllowed(this.options.call, controller.signal);
    } finally {
      this.clock.clearTimeout(timer);
    }
  }

  /**
   * Turns a phone's drift alerts off once its push service says they have
   * ended, unless the phone has turned them on again since with another
   * subscription.
   */
  private forgetSubscription(phoneKey: string, endpoint: string): void {
    const phone = this.state.phones.find((known) => known.key === phoneKey);
    if (phone === undefined || phone.push?.endpoint !== endpoint) return;
    logInfo(`The push service of the phone "${phone.name}" says its drift alerts have ended, so they stay off until the phone turns them on again.`);
    this.state = { ...this.state, phones: withPhoneSubscription(this.state.phones, phoneKey, null) };
    this.saveState();
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

  /** The time now, in milliseconds since 1970, by the clock the link was given. */
  private now(): number {
    return this.clock.now();
  }
}
