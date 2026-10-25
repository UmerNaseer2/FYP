/**
 * Pairing from a QR code or a link (src/phone/scan.ts): the square of the
 * camera's picture that the QR reader looks at, and what the app makes of
 * the text it finds there or in its own address. One test draws a real
 * pairing code with the QR library the computer uses and reads it back with
 * the one the phone uses.
 *
 * Every pairing code here is made up at random as the test runs, and no
 * test prints one.
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

import qrcode from "qrcode-generator";

import { MAX_SCAN_SIDE, readAddressPairing, readScannedText, scanSquare } from "../phone/scan.js";
import { randomBytes, sameBytes, toBase64Url } from "../shared/remote/bytes.js";
import { KEY_BYTES } from "../shared/remote/keys.js";
import { PAIRING_SECRET_BYTES, writePairingLink, type PairingCode } from "../shared/remote/pairing.js";
import { DESKTOP_ID_BYTES } from "../shared/remote/relay-auth.js";

/**
 * jsQR, loaded as the phone loads it: its one built file, which hands over
 * the function itself. Its type definitions describe a default export, which
 * Node.js does not see in that file, so it is required instead.
 */
const jsQR = createRequire(import.meta.url)("jsqr") as (
  data: Uint8ClampedArray,
  width: number,
  height: number,
  options?: { inversionAttempts?: "dontInvert" | "onlyInvert" | "attemptBoth" | "invertFirst" },
) => { data: string } | null;

const RELAY = "https://relay.example.com";
/** How many light squares surround a QR code, as desktop/src/main/qr.ts draws it. */
const QUIET_ZONE = 4;

/** A pairing code with new random parts, as the computer makes one. */
function randomCode(): PairingCode {
  return {
    desktopId: toBase64Url(randomBytes(DESKTOP_ID_BYTES)),
    desktopKey: randomBytes(KEY_BYTES),
    secret: randomBytes(PAIRING_SECRET_BYTES),
  };
}

/** Whether two pairing codes are the same code. */
function sameCode(a: PairingCode, b: PairingCode): boolean {
  return a.desktopId === b.desktopId && sameBytes(a.desktopKey, b.desktopKey) && sameBytes(a.secret, b.secret);
}

/**
 * `text` as a QR code in a picture, in the four bytes a pixel that a canvas
 * gives: black squares `scale` pixels wide on white, with the light border
 * round the code.
 */
function drawQr(text: string, scale: number): { pixels: Uint8ClampedArray; side: number } {
  const code = qrcode(0, "M");
  code.addData(text, "Byte");
  code.make();
  const count = code.getModuleCount();
  const side = (count + QUIET_ZONE * 2) * scale;
  const pixels = new Uint8ClampedArray(side * side * 4).fill(255);
  for (let y = 0; y < side; y += 1) {
    for (let x = 0; x < side; x += 1) {
      const row = Math.floor(y / scale) - QUIET_ZONE;
      const column = Math.floor(x / scale) - QUIET_ZONE;
      if (row < 0 || row >= count || column < 0 || column >= count || !code.isDark(row, column)) continue;
      pixels.fill(0, (y * side + x) * 4, (y * side + x) * 4 + 3);
    }
  }
  return { pixels, side };
}

test("looks at the biggest square in the middle of the camera's picture", () => {
  assert.deepEqual(scanSquare(1280, 720), { x: 280, y: 0, side: 720, drawSide: MAX_SCAN_SIDE });
  assert.deepEqual(scanSquare(720, 1280), { x: 0, y: 280, side: 720, drawSide: MAX_SCAN_SIDE });
  assert.deepEqual(scanSquare(641, 480), { x: 80, y: 0, side: 480, drawSide: 480 });
  assert.deepEqual(scanSquare(480, 481), { x: 0, y: 0, side: 480, drawSide: 480 });
  assert.deepEqual(scanSquare(640, 640), { x: 0, y: 0, side: 640, drawSide: 640 });
});

test("hands the QR reader a picture no bigger than it needs", () => {
  assert.equal(MAX_SCAN_SIDE, 640);
  assert.deepEqual(scanSquare(1920, 1080), { x: 420, y: 0, side: 1080, drawSide: 640 });
  assert.deepEqual(scanSquare(1000, 800, 400), { x: 100, y: 0, side: 800, drawSide: 400 });
});

test("looks at nothing while the camera has no picture yet", () => {
  for (const [width, height] of [[0, 0], [0, 480], [640, 0], [-1, 480], [Number.NaN, 480], [640, Number.NaN]]) {
    assert.equal(scanSquare(width, height), null, `${width} by ${height} gave a square.`);
  }
});

test("pairs with a code for the relay the app was opened from", () => {
  const code = randomCode();
  const scanned = readScannedText(writePairingLink(RELAY, code), RELAY);
  if (scanned.kind !== "pair") throw new Error(`Expected a pairing code, but read ${scanned.kind}.`);
  assert.ok(sameCode(scanned.code, code), "The code read back was not the one written.");
});

test("pairs with a code for a relay on this machine, which `npm run dev` serves", () => {
  const local = "http://localhost:8787";
  const code = randomCode();
  const scanned = readScannedText(writePairingLink(local, code), local);
  if (scanned.kind !== "pair") throw new Error(`Expected a pairing code, but read ${scanned.kind}.`);
  assert.ok(sameCode(scanned.code, code), "The code read back was not the one written.");
});

test("pairs with a code that has spaces or a line break around it", () => {
  const code = randomCode();
  const scanned = readScannedText(` ${writePairingLink(RELAY, code)}\n`, RELAY);
  if (scanned.kind !== "pair") throw new Error(`Expected a pairing code, but read ${scanned.kind}.`);
  assert.ok(sameCode(scanned.code, code), "The code read back was not the one written.");
});

test("names the other relay when a code is for a different relay from this app's", () => {
  const scanned = readScannedText(writePairingLink("https://relay.example.org", randomCode()), RELAY);
  assert.equal(scanned.kind, "other-relay");
  if (scanned.kind !== "other-relay") throw new Error("Expected a code for another relay.");
  assert.equal(scanned.relayOrigin, "https://relay.example.org");
});

test("takes a relay on another port of the same machine for a different relay", () => {
  const scanned = readScannedText(writePairingLink("http://localhost:8788", randomCode()), "http://localhost:8787");
  assert.equal(scanned.kind, "other-relay");
});

test("reads anything else as not a pairing code", () => {
  const link = writePairingLink(RELAY, randomCode());
  const others = [
    "",
    "Schema Studio",
    "https://relay.example.com",
    `${RELAY}/`,
    `${RELAY}/#/settings`,
    link.slice(0, -1),
    `${link}A`,
    link.replace("#pair=v1.", "#pair=v2."),
    link.replace(RELAY, "http://relay.example.com"),
    link.replace(RELAY, `${RELAY}/app`),
  ];
  for (const text of others) assert.equal(readScannedText(text, RELAY).kind, "not-pairing");
});

test("finds no pairing code in an address without one", () => {
  for (const hash of ["", "#", "#/", "#/settings", "#/connections/3", "#pairing", "#Pair=v1.", "#/pair=v1."]) {
    assert.equal(readAddressPairing(RELAY, hash), null, `${hash} was taken for a pairing code.`);
  }
});

test("reads the pairing code in the app's own address, as the camera app opens it", () => {
  const code = randomCode();
  const read = readAddressPairing(RELAY, new URL(writePairingLink(RELAY, code)).hash);
  if (read === null || read === "unreadable") throw new Error(`Expected a pairing code, but read ${String(read)}.`);
  assert.ok(sameCode(read, code), "The code read back was not the one written.");
});

test("reads a pairing code in the address that was cut short or changed as unreadable", () => {
  const hash = new URL(writePairingLink(RELAY, randomCode())).hash;
  const broken = ["#pair=", "#pair=v1", "#pair=v1.", hash.slice(0, -1), `${hash}A`, `${hash}&from=mail`, hash.replace("v1.", "v2.")];
  for (const text of broken) assert.equal(readAddressPairing(RELAY, text), "unreadable");
});

test("reads a pairing code that the computer's QR library drew with the phone's QR reader", () => {
  const code = randomCode();
  const { pixels, side } = drawQr(writePairingLink(RELAY, code), 4);
  const found = jsQR(pixels, side, side, { inversionAttempts: "dontInvert" });
  assert.ok(found !== null, "The QR reader found no code in the picture.");
  const scanned = readScannedText(found.data, RELAY);
  if (scanned.kind !== "pair") throw new Error(`Expected a pairing code, but read ${scanned.kind}.`);
  assert.ok(sameCode(scanned.code, code), "The code read back was not the one drawn.");
});

test("reads a pairing code drawn as small as a phone's camera sees one from across a desk", () => {
  const code = randomCode();
  const { pixels, side } = drawQr(writePairingLink(RELAY, code), 2);
  const found = jsQR(pixels, side, side, { inversionAttempts: "dontInvert" });
  assert.ok(found !== null, "The QR reader found no code in the picture.");
  const scanned = readScannedText(found.data, RELAY);
  if (scanned.kind !== "pair") throw new Error(`Expected a pairing code, but read ${scanned.kind}.`);
  assert.ok(sameCode(scanned.code, code), "The code read back was not the one drawn.");
});
