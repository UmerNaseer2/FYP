/**
 * Sends drift alerts to the phones that turned them on, through each phone's
 * browser push service (src/core/web-push.ts makes each message), so a phone
 * hears about drift even while the phone app is closed.
 *
 * Every phone gets the same short message: the drift notification's title and
 * body, as plain text, and nothing more. The phone app shows it as the phone's
 * own notification.
 *
 * The phones are sent to at the same time, each on its own, so a push service
 * that is slow or broken never holds up another phone's alert. What a push
 * service answers counts for that phone only:
 *  - A subscription that has ended is forgotten through `forget`, so that
 *    phone's alerts stay off until it turns them on again.
 *  - A push service that asks for a pause gets nothing until the pause is
 *    over. Alerts in the meantime are skipped, not sent later.
 *  - A push service that cannot be reached, or has a problem of its own, is
 *    tried again with the next alert, unless it said how long to wait.
 *  - Trouble with a phone's alerts is logged once, and not again until an
 *    alert reaches that phone, so a phone that is off for days does not fill
 *    the log.
 *
 * The log names the phone, but never where its alerts go, its keys, or what a
 * push service or the network said: an error can quote the push service's
 * address, which belongs to that one phone.
 *
 * Tested in src/test/phone-push.test.ts.
 */
import { driftNotification, type DriftAlert } from "../core/drift-alerts";
import type { PhoneSubscription } from "../core/phone-link-file";
import { MAX_PUSH_PAYLOAD_BYTES, pushOutcome, pushRequest, type PushKey, type PushOutcome, type PushTransport } from "../core/web-push";
import { SYSTEM_CLOCK, type Clock } from "./clock";
import { logInfo, logWarn } from "./log";

/** A phone with drift alerts on, as the phone link lists it. */
export type PushPhone = {
  /** The phone's public key, which names it in phone-link.json. */
  key: string;
  /** The name the phone gave itself, for the log. */
  name: string;
  push: PhoneSubscription;
};

export type PushSenderOptions = {
  /** Sends one request to a push service (src/main/push-transport.ts). Tests pass in a fake push service. */
  transport: PushTransport;
  /** The computer's push key, which every phone turned its alerts on with. */
  key: PushKey;
  /**
   * Called when a push service says a phone's subscription has ended, with
   * the phone's key and the address that ended, so the phone link can turn
   * that phone's alerts off, unless the phone has turned them on again since.
   */
  forget: (phoneKey: string, endpoint: string) => void;
  /** The clock, which a test can move on by hand. The computer's own when left out. */
  clock?: Clock;
};

/** What the sender keeps about one phone's push service between alerts. */
type ServiceState = {
  /** The address this is about. A phone that subscribes again starts afresh. */
  endpoint: string;
  /**
   * When the phone turned its alerts on with this subscription. A phone that
   * turns its alerts off and on again starts afresh too, even at the same
   * address.
   */
  since: number;
  /** When the push service may be sent to again, in milliseconds since 1970. */
  waitUntil: number;
  /** Whether alerts have stopped reaching the phone, which the log has said already. */
  trouble: boolean;
};

/**
 * The message the phones get: the notification's words, as JSON, which the
 * phone app reads. "v" lets a later computer send something else without an
 * older phone app misreading it.
 */
function driftMessage(alerts: readonly DriftAlert[]): Buffer | null {
  // A phone shows the words as plain text, so nothing is written out as markup.
  const notification = driftNotification(alerts, { markup: false });
  if (notification === null) return null;
  return Buffer.from(JSON.stringify({ v: 1, kind: "drift", title: notification.title, body: notification.body }), "utf8");
}

/** True for the error a request gives when it runs out of time (src/main/push-transport.ts gives it one). */
function isTimeout(error: unknown): boolean {
  return typeof error === "object" && error !== null && "name" in error && error.name === "TimeoutError";
}

export class PushSender {
  private readonly clock: Clock;
  /** Each phone's push service, by the phone's key. */
  private readonly services = new Map<string, ServiceState>();
  private tooBigLogged = false;

  constructor(private readonly options: PushSenderOptions) {
    this.clock = options.clock ?? SYSTEM_CLOCK;
  }

  /**
   * Sends the alerts from one look at the drift log to each of `phones`, and
   * settles once every phone's push service has answered or failed. `subject`
   * is who the push services may contact about this computer (pushSubject in
   * src/core/web-push.ts). It never throws.
   */
  async send(phones: readonly PushPhone[], alerts: readonly DriftAlert[], subject: string | null): Promise<void> {
    // A phone that is no longer listed has turned its alerts off or been
    // removed, so nothing is kept about its push service.
    const listed = new Set(phones.map((phone) => phone.key));
    for (const key of this.services.keys()) {
      if (!listed.has(key)) this.services.delete(key);
    }
    const message = driftMessage(alerts);
    if (message === null) return;
    if (message.length > MAX_PUSH_PAYLOAD_BYTES) {
      // Names are cut to fit a line (src/core/drift-alerts.ts), so this should never happen.
      if (!this.tooBigLogged) logWarn("A drift alert was too long to send to phones, so phones did not get it.");
      this.tooBigLogged = true;
      return;
    }
    await Promise.all(
      phones.map(async (phone) => {
        try {
          await this.sendTo(phone, message, subject);
        } catch (error) {
          logWarn(`Could not send a drift alert to the phone "${phone.name}".`, error);
        }
      }),
    );
  }

  private async sendTo(phone: PushPhone, message: Buffer, subject: string | null): Promise<void> {
    const { endpoint, since } = phone.push;
    let service = this.services.get(phone.key);
    if (service === undefined || service.endpoint !== endpoint || service.since !== since) {
      service = { endpoint, since, waitUntil: 0, trouble: false };
      this.services.set(phone.key, service);
    }
    if (this.clock.now() < service.waitUntil) return;
    const request = pushRequest(phone.push, message, { key: this.options.key, subject }, this.clock.now());
    let outcome: PushOutcome;
    // What went wrong goes in the log in fixed words, since an error can quote the address.
    let problem = "had a problem of its own";
    try {
      outcome = pushOutcome(await this.options.transport(request), this.clock.now());
    } catch (error) {
      problem = isTimeout(error) ? "did not answer in time" : "could not be reached";
      outcome = { kind: "unavailable", until: this.clock.now() };
    }
    switch (outcome.kind) {
      case "sent":
        if (service.trouble) logInfo(`Drift alerts reach the phone "${phone.name}" again.`);
        service.trouble = false;
        return;
      case "gone":
        // It never works again, as when the phone turned alerts off in its
        // browser's settings. The phone link logs it.
        this.services.delete(phone.key);
        this.options.forget(phone.key, endpoint);
        return;
      case "too-big":
        this.troubleWith(service, `The push service of the phone "${phone.name}" refused a drift alert as too big.`);
        return;
      case "refused":
        this.troubleWith(service, `The push service of the phone "${phone.name}" refused a drift alert (status ${outcome.status}).`);
        return;
      case "slow-down":
        service.waitUntil = outcome.until;
        this.troubleWith(service, `The push service of the phone "${phone.name}" asked for a pause, so that phone gets no drift alerts for a while.`);
        return;
      case "unavailable":
        service.waitUntil = outcome.until;
        this.troubleWith(service, `Drift alerts could not reach the phone "${phone.name}": its push service ${problem}.`);
        return;
    }
  }

  /** Logs trouble with a phone's alerts, unless the log has said so since an alert last reached it. */
  private troubleWith(service: ServiceState, message: string): void {
    if (!service.trouble) logWarn(message);
    service.trouble = true;
  }
}
