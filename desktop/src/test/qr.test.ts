/**
 * The pairing code's drawing (src/main/qr.ts). Each test paints the drawing
 * into pixels, black on white as Settings shows it, and reads it back with
 * jsQR, as a phone's camera would.
 */
import assert from "node:assert/strict";
import test from "node:test";

import jsQR from "jsqr";

import { pairingQr } from "../main/qr";

/** How many pixels each square of the code gets in the picture. */
const SCALE = 4;

/** Paints the drawing and notes each dark square, checking that every run of squares is drawn as a closed rectangle. */
function paint(qr: { size: number; path: string }): { pixels: Uint8ClampedArray; side: number; dark: Array<[number, number]> } {
  const side = qr.size * SCALE;
  const pixels = new Uint8ClampedArray(side * side * 4).fill(255);
  const dark: Array<[number, number]> = [];
  for (const match of qr.path.matchAll(/M(\d+) (\d+)h(\d+)v1h-(\d+)z/g)) {
    const [x, y, width, back] = match.slice(1).map(Number);
    assert.equal(back, width, "each run goes back to where it started");
    for (let column = x; column < x + width; column += 1) {
      dark.push([column, y]);
      for (let down = 0; down < SCALE; down += 1) {
        for (let across = 0; across < SCALE; across += 1) {
          pixels.set([0, 0, 0, 255], ((y * SCALE + down) * side + column * SCALE + across) * 4);
        }
      }
    }
  }
  return { pixels, side, dark };
}

test("draws a pairing link as a code a camera reads back, inside a light border", () => {
  const text = ("https://relay.example.com/#pair=v1." + "AbCd-_09".repeat(30)).slice(0, 168);
  const qr = pairingQr(text);
  // 168 characters take version 9 at medium error correction: 53 squares a side, plus four light ones on each side.
  assert.equal(qr.size, 61);
  assert.match(qr.path, /^(M\d+ \d+h\d+v1h-\d+z)+$/);
  const { pixels, side, dark } = paint(qr);
  assert.equal(jsQR(pixels, side, side)?.data, text);
  assert.ok(dark.length > 0);
  for (const [x, y] of dark) {
    assert.ok(x >= 4 && y >= 4 && x < qr.size - 4 && y < qr.size - 4, `the dark square at ${x}, ${y} is in the light border`);
  }
});

test("draws a short text in the smallest code there is", () => {
  const qr = pairingQr("hello");
  assert.equal(qr.size, 29);
  const { pixels, side } = paint(qr);
  assert.equal(jsQR(pixels, side, side)?.data, "hello");
});
