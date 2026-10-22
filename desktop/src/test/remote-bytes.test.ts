/**
 * The byte helpers the phone link is built on (src/shared/remote/bytes.ts).
 *
 * Node's Buffer is the yardstick for base64url here: the shared code may not
 * use it, because the phone and the relay have no Buffer, but a test can
 * check that the two agree.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  concatBytes,
  fromBase64Url,
  fromBase64UrlOfLength,
  randomBytes,
  readUtf8,
  sameBytes,
  toBase64Url,
  utf8,
  type Bytes,
} from "../shared/remote/bytes.js";

function filled(length: number, value: number): Bytes {
  return new Uint8Array(length).fill(value);
}

test("writes base64url exactly as Node does, and reads it back, at every length up to 40 bytes", () => {
  for (let length = 0; length <= 40; length++) {
    for (const bytes of [randomBytes(length), filled(length, 0xff), filled(length, 0)]) {
      const text = toBase64Url(bytes);
      assert.equal(text, Buffer.from(bytes).toString("base64url"));
      assert.deepEqual(fromBase64Url(text), bytes);
    }
  }
});

test("reads short base64url, the empty text included", () => {
  assert.deepEqual(fromBase64Url("AA"), Uint8Array.of(0));
  assert.deepEqual(fromBase64Url("AQ"), Uint8Array.of(1));
  assert.deepEqual(fromBase64Url("AAE"), Uint8Array.of(0, 1));
  assert.deepEqual(fromBase64Url(""), new Uint8Array(0));
});

test("refuses padding, characters from outside the alphabet, impossible lengths and unused bits that are set", () => {
  // "AB" and "AAB" would read as the same bytes as "AA" and "AAA" if the bits
  // their last character carries past the end of the bytes were ignored.
  for (const text of ["AA==", "AA+A", "AA/A", "A", "AAAAA", " AA", "AB", "AAB"]) {
    assert.equal(fromBase64Url(text), null, text);
  }
});

test("reads base64url only from text, and only when it holds exactly the bytes asked for", () => {
  assert.deepEqual(fromBase64UrlOfLength("AAE", 2), Uint8Array.of(0, 1));
  assert.equal(fromBase64UrlOfLength("AAE", 1), null);
  assert.equal(fromBase64UrlOfLength("AAE", 3), null);
  assert.deepEqual(fromBase64UrlOfLength("", 0), new Uint8Array(0));
  for (const value of [undefined, null, 123, ["AA"]]) {
    assert.equal(fromBase64UrlOfLength(value, 1), null, String(value));
  }
});

test("compares bytes", () => {
  assert.equal(sameBytes(Uint8Array.of(1, 2, 3), Uint8Array.of(1, 2, 3)), true);
  assert.equal(sameBytes(new Uint8Array(0), new Uint8Array(0)), true);
  assert.equal(sameBytes(Uint8Array.of(9, 2, 3), Uint8Array.of(1, 2, 3)), false);
  assert.equal(sameBytes(Uint8Array.of(1, 2, 9), Uint8Array.of(1, 2, 3)), false);
  assert.equal(sameBytes(Uint8Array.of(1, 2), Uint8Array.of(1, 2, 3)), false);
});

test("writes and reads UTF-8, and refuses bytes that are not UTF-8", () => {
  const text = "café \u{1f511}";
  assert.equal(readUtf8(utf8(text)), text);
  assert.deepEqual(utf8("é"), Uint8Array.of(0xc3, 0xa9));
  assert.equal(readUtf8(Uint8Array.of(0xff)), null);
  // The first byte of a two-byte character, with nothing after it.
  assert.equal(readUtf8(Uint8Array.of(0xc3)), null);
  // One decoder serves every call, so a failure must leave nothing behind.
  assert.equal(readUtf8(Uint8Array.of(0x41)), "A");
});

test("keeps a byte order mark, so the text read is exactly what was sent", () => {
  assert.equal(readUtf8(Uint8Array.of(0xef, 0xbb, 0xbf, 0x41)), "﻿A");
});

test("gives fresh random bytes of the length asked for", () => {
  assert.equal(randomBytes(32).length, 32);
  assert.equal(randomBytes(0).length, 0);
  assert.notDeepEqual(randomBytes(32), randomBytes(32));
});

test("joins bytes, empty parts included", () => {
  assert.deepEqual(concatBytes(), new Uint8Array(0));
  assert.deepEqual(concatBytes(Uint8Array.of(1), new Uint8Array(0), Uint8Array.of(2, 3)), Uint8Array.of(1, 2, 3));
});
