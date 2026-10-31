/**
 * How a short pairing code's locked box reaches the relay: one PUT, sent for
 * src/main/phone-link.ts.
 *
 * It sends with Electron's networking, as drift alerts do
 * (src/main/push-transport.ts), so the request goes through the proxy Ubuntu
 * is set to use and trusts the certificates Ubuntu trusts.
 *
 * It never throws. A box that could not be left means only that the computer
 * shows no code to type this time, and the QR code still works. A relay that
 * has not been updated to keep boxes yet goes the same way.
 *
 * Tested in src/test/code-box-sender.test.ts.
 */
import { session, type Session } from "electron";

import type { Bytes } from "../shared/remote/bytes";
import { relayCodePath } from "../shared/remote/relay-protocol";

/** How long the relay has to answer. Someone is waiting for the code to appear, so this is short. */
const BOX_TIMEOUT_MS = 5_000;

/** What became of a box: left at the relay, turned away because its label holds another, or anything else. */
export type BoxAnswer = "stored" | "taken" | "failed";

export type CodeBoxSender = (relayOrigin: string, label: string, box: Bytes) => Promise<BoxAnswer>;

export type BoxFetch = (url: string, init: RequestInit) => Promise<Response>;

/** A sender that uses this fetch, which tests can fake. */
export function codeBoxSenderFor(fetchWith: BoxFetch, timeoutMs = BOX_TIMEOUT_MS): CodeBoxSender {
  return async (relayOrigin, label, box) => {
    let response: Response;
    try {
      response = await fetchWith(relayOrigin + relayCodePath(label), {
        method: "PUT",
        body: box,
        // The relay answers directly. A redirect would come from something in between, such as a hotel Wi-Fi login page.
        redirect: "error",
        credentials: "omit",
        cache: "no-store",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      return "failed";
    }
    // Only the status counts, so the body is let go of unread.
    response.body?.cancel().catch(() => {
      /* Nothing more is wanted from it. */
    });
    if (response.status === 201) return "stored";
    return response.status === 409 ? "taken" : "failed";
  };
}

let boxSession: Session | null = null;

// Its session lives in memory only, so the requests share no cookies with the app's windows and leave nothing on disk. Made on first use, because Electron makes sessions only once the app is ready.
export const sendCodeBox: CodeBoxSender = codeBoxSenderFor((url, init) => {
  boxSession ??= session.fromPartition("code-box");
  return boxSession.fetch(url, init);
});
