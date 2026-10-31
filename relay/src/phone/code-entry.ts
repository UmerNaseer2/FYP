/**
 * What to make of a short pairing code someone typed, on a device with no camera
 * to scan the QR code with. The code makes a label and a key, the relay hands
 * over the locked box it holds under that label, the key opens the box, and what
 * is inside is read exactly as if it had come from a QR code (scan.ts).
 *
 * The relay gets the label and never the code. See shared/remote/short-code.ts
 * for why that is enough. A box goes to the first one to take it, so a mistyped
 * code, which makes another label, uses nothing up.
 *
 * Never logs or shows the code, its label or its key. Kept apart from the page
 * so the tests (src/test/phone-code.test.ts) can run it in Node.
 */
import type { PairingCode } from "../shared/remote/pairing.js";
import { relayCodePath } from "../shared/remote/relay-protocol.js";
import { makeCodeKeys, openCodeBox, readShortCode, type CodeKeys } from "../shared/remote/short-code.js";
import { readScannedText } from "./scan.js";

/** How long the relay has to answer once the code's slow sums are done. */
const TAKE_WITHIN_MS = 15_000;

/** The browser's fetch, which tests can fake. */
export type CodeFetch = (url: string, init: RequestInit) => Promise<Response>;

export type CodeOutcome =
  | { kind: "pair"; code: PairingCode }
  /** What was typed cannot be a code at all, so the relay was not asked. */
  | { kind: "not-a-code" }
  /** The relay holds no box for this code, because it was mistyped, has run out or has been used. */
  | { kind: "wrong" }
  /** The relay has turned away too many tries from this address for now. */
  | { kind: "too-many" }
  /** The relay could not be reached, or gave no usable answer. */
  | { kind: "offline" }
  /** This browser could not do the sums that make a code's label and key. */
  | { kind: "browser" }
  /** The code is for a computer that uses a different relay from the one this app was opened from. */
  | { kind: "other-relay"; relayOrigin: string };

/** Works out what this typed text leads to. Never throws. */
export async function readTypedCode(typed: string, origin: string, fetchWith: CodeFetch, timeoutMs = TAKE_WITHIN_MS): Promise<CodeOutcome> {
  const code = readShortCode(typed);
  if (code === null) return { kind: "not-a-code" };
  let keys: CodeKeys;
  try {
    keys = await makeCodeKeys(code, origin);
  } catch {
    return { kind: "browser" };
  }
  let box: Uint8Array<ArrayBuffer>;
  try {
    const response = await fetchWith(origin + relayCodePath(keys.label), {
      method: "POST",
      // The relay answers directly. A redirect would come from something in between, such as a hotel Wi-Fi login page.
      redirect: "error",
      credentials: "omit",
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status === 404) return { kind: "wrong" };
    if (response.status === 429) return { kind: "too-many" };
    if (response.status !== 200) return { kind: "offline" };
    box = new Uint8Array(await response.arrayBuffer());
  } catch {
    return { kind: "offline" };
  }
  const text = await openCodeBox(keys, box);
  if (text === null) return { kind: "wrong" };
  const read = readScannedText(text, origin);
  return read.kind === "not-pairing" ? { kind: "wrong" } : read;
}
