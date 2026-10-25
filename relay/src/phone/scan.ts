/**
 * The arithmetic and the decisions behind pairing: which part of a camera
 * frame the QR reader looks at (scanner.ts), and what to make of the text in
 * a QR code or in the page's own address. Kept apart from the camera so the
 * tests (src/test/phone-scan.test.ts) can run them in Node.
 */
import { readPairingLink, type PairingCode } from "../shared/remote/pairing.js";

/**
 * The longest side, in pixels, of the picture handed to the QR reader. A
 * pairing code fills much of the frame, so a bigger picture would only make
 * each look slower.
 */
export const MAX_SCAN_SIDE = 640;

/** The square in the middle of a camera frame that the QR reader looks at, and the size it is drawn at for it. */
export type ScanSquare = { x: number; y: number; side: number; drawSide: number };

/**
 * The biggest square in the middle of a frame of this size, which is where a
 * person holds the code, or null while the camera has no frame yet.
 */
export function scanSquare(width: number, height: number, maxSide = MAX_SCAN_SIDE): ScanSquare | null {
  if (!(width > 0 && height > 0)) return null;
  const side = Math.min(width, height);
  return { x: Math.floor((width - side) / 2), y: Math.floor((height - side) / 2), side, drawSide: Math.min(side, maxSide) };
}

/** What a scanned QR code turned out to hold. */
export type Scanned =
  | { kind: "pair"; code: PairingCode }
  /** A pairing code for a computer that uses a different relay from the one this app was opened from. */
  | { kind: "other-relay"; relayOrigin: string }
  | { kind: "not-pairing" };

/**
 * What to make of the text in a QR code. This app can pair only with codes
 * for the relay it was opened from (`origin`), because that is the relay it
 * connects to.
 */
export function readScannedText(text: string, origin: string): Scanned {
  const link = readPairingLink(text);
  if (link === null) return { kind: "not-pairing" };
  return link.relayOrigin === origin ? { kind: "pair", code: link.code } : { kind: "other-relay", relayOrigin: link.relayOrigin };
}

/**
 * The pairing code in the page's own address, which is how the app opens
 * when the phone's camera app follows a pairing link. Null when the address
 * holds none, and "unreadable" when it holds one that was cut short or
 * changed on the way.
 */
export function readAddressPairing(origin: string, hash: string): PairingCode | "unreadable" | null {
  if (!hash.startsWith("#pair=")) return null;
  // The link is read whole, as a QR code's would be. Only the relay's
  // address is put in front of it, so the page's own path does not matter.
  const scanned = readScannedText(`${origin}/${hash}`, origin);
  return scanned.kind === "pair" ? scanned.code : "unreadable";
}
