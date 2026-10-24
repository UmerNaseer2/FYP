/**
 * How drift alerts reach the phones' push services: one POST each, sent for
 * src/main/phone-push.ts.
 *
 * It sends with Electron's networking, which is Chromium's, as the sign-in
 * does (src/main/net-client.ts): requests go through the proxy Ubuntu is set
 * to use and trust the certificates Ubuntu trusts, which matters on a company
 * or university network.
 *
 * It keeps three promises:
 *  - It only ever sends to a browser's push service (readPushEndpoint in
 *    src/core/web-push.ts), even should an address get past the checks made
 *    when a phone turned its alerts on.
 *  - A push service that has not answered in 30 seconds is given up on, with
 *    an error named "TimeoutError", so the log can say it did not answer in
 *    time.
 *  - Its errors never quote the address, which belongs to one phone.
 *
 * Tested in src/test/push-transport.test.ts.
 */
import { session, type Session } from "electron";

import { readPushEndpoint, type PushTransport } from "../core/web-push";

/** How long a push service has to answer. They answer in well under a second. */
const PUSH_TIMEOUT_MS = 30_000;

/** Sends one request: a session's fetch in the app, a fake in the tests. */
export type PushFetch = (url: string, init: RequestInit) => Promise<Response>;

/** The error for a push service that did not answer in time. Its name is what src/main/phone-push.ts looks for. */
function timeoutError(): Error {
  const error = new Error("The push service did not answer in time.");
  error.name = "TimeoutError";
  return error;
}

/** A transport that sends with `fetchWith`, giving up after `timeoutMs`. */
export function pushTransportFor(fetchWith: PushFetch, timeoutMs = PUSH_TIMEOUT_MS): PushTransport {
  return async (request) => {
    if (readPushEndpoint(request.url) !== request.url) throw new Error("Drift alerts may only go to a browser's push service.");
    const signal = AbortSignal.timeout(timeoutMs);
    let response: Response;
    try {
      response = await fetchWith(request.url, {
        method: "POST",
        headers: request.headers,
        body: request.body,
        // A push service answers directly. A redirect would come from something in between, such as a hotel Wi-Fi login page.
        redirect: "error",
        credentials: "omit",
        cache: "no-store",
        signal,
      });
    } catch {
      // What fetch throws can quote the address, so none of it is passed on.
      throw signal.aborted ? timeoutError() : new Error("The push service could not be reached.");
    }
    // Only the status counts. The body is let go of unread, so a push service that sends a big one costs nothing.
    response.body?.cancel().catch(() => {
      // Nothing more is wanted from it.
    });
    return { status: response.status, retryAfter: response.headers.get("retry-after") };
  };
}

let pushSession: Session | null = null;

/**
 * The transport the app uses. Its session lives in memory only, so the push
 * services' requests share no cookies with the app's windows and leave
 * nothing on disk. It is made on first use, because Electron makes sessions
 * only once the app is ready.
 */
export const sendToPushService: PushTransport = pushTransportFor((url, init) => {
  pushSession ??= session.fromPartition("push");
  return pushSession.fetch(url, init);
});
