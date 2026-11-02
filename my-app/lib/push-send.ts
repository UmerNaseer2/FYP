/**
 * Sends one alert to a list of devices through their browsers' push services.
 *
 * It never throws, because an alert is a side effect of something that has
 * already happened: a drift check or a decision must not fail because Google's
 * push service did not answer. There is no retry queue either. What an alert
 * says is still on the phone's screens when the app opens, so a lost one costs
 * someone the nudge and not the news.
 *
 * Logs counts only, never an address or a key.
 */
import { mapWithLimit } from "@/lib/concurrency";
import {
  dropPushSubscription,
  holdPushSubscription,
  pushSender,
  type StoredSubscription,
} from "@/lib/push-db";
import {
  pushOutcome,
  pushRequest,
  pushSubject,
  readPushEndpoint,
  type PushRequest,
  type PushResponse,
} from "@/lib/web-push";

/** How long one push service has to answer. */
const ANSWER_WITHIN_MS = 10_000;

/** How many are sent at once, so that a large organization does not open hundreds of connections. */
const AT_ONCE = 8;

/** What the service worker (public/sw.js) reads, as plain text. */
export type Alert = {
  kind: "drift" | "approval" | "request" | "test";
  title: string;
  body: string;
  /** A path on this site, opened when the alert is tapped. */
  url: string;
};

export type SendReport = { sent: number; failed: number };

async function post(request: PushRequest): Promise<PushResponse> {
  // The address came from a browser, so it is checked once more right before
  // anything is sent, and a redirect is an error rather than somewhere new to go.
  if (readPushEndpoint(request.url) === null) {
    throw new Error("Expected a push service's address.");
  }
  const response = await fetch(request.url, {
    method: "POST",
    headers: request.headers,
    body: new Uint8Array(request.body),
    redirect: "error",
    credentials: "omit",
    cache: "no-store",
    signal: AbortSignal.timeout(ANSWER_WITHIN_MS),
  });
  void response.body?.cancel().catch(() => undefined);
  return { status: response.status, retryAfter: response.headers.get("retry-after") };
}

/** Sends the alert to each device, and acts on what each push service says. */
export async function sendAlert(
  devices: readonly StoredSubscription[],
  alert: Alert
): Promise<SendReport> {
  const report: SendReport = { sent: 0, failed: 0 };
  if (devices.length === 0) return report;
  try {
    const { key, siteOrigin } = await pushSender();
    const sender = { key, subject: pushSubject(siteOrigin) };
    const payload = Buffer.from(JSON.stringify({ v: 1, ...alert }), "utf8");
    await mapWithLimit(devices, AT_ONCE, async (device) => {
      try {
        const now = Date.now();
        const outcome = pushOutcome(await post(pushRequest(device, payload, sender, now)), now);
        if (outcome.kind === "sent") {
          report.sent += 1;
          return;
        }
        report.failed += 1;
        if (outcome.kind === "gone") await dropPushSubscription(device.id);
        if (outcome.kind === "slow-down" || outcome.kind === "unavailable") {
          await holdPushSubscription(device.id, new Date(outcome.until));
        }
      } catch {
        // What fetch throws can quote the address, so it is not logged.
        report.failed += 1;
      }
    });
  } catch (error) {
    report.failed = devices.length - report.sent;
    console.error(
      "Could not send phone alerts:",
      error instanceof Error ? error.name : "unknown error"
    );
  }
  if (report.failed > 0) {
    console.warn(`Phone alerts: ${report.sent} sent, ${report.failed} not sent.`);
  }
  return report;
}
