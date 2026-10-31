/**
 * The short pairing code: what counts as one, and that only the same code at the
 * same relay opens a box. Making the keys is slow on purpose, so these tests make
 * as few as they can and share them.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { fromBase64UrlOfLength } from "../shared/remote/bytes";
import { readCodePath, relayCodePath } from "../shared/remote/relay-protocol";
import {
  lockCodeBox,
  makeCodeKeys,
  makeShortCode,
  MAX_CODE_BOX_BYTES,
  openCodeBox,
  readShortCode,
  SHORT_CODE_LENGTH,
  showShortCode,
} from "../shared/remote/short-code";

const RELAY = "https://relay.example.test";
const TEXT = "https://relay.example.test/#pair=v1.an-id.a-key.a-secret";
const CODE = "K7F29XQM";

test("a new code uses only symbols that do not look alike, and each one comes up", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 400; i += 1) {
    const code = makeShortCode();
    assert.equal(code.length, SHORT_CODE_LENGTH);
    assert.equal(readShortCode(code), code);
    assert.doesNotMatch(code, /[01OI]/);
    for (const symbol of code) seen.add(symbol);
  }
  assert.equal(seen.size, 32);
});

test("a typed code may be in either case, with spaces or a hyphen", () => {
  for (const typed of ["K7F29XQM", "k7f29xqm", "K7F2-9XQM", " k7f2 9xqm ", "K7F2 - 9XQM"]) {
    assert.equal(readShortCode(typed), CODE);
  }
});

test("text that cannot be a code is not read as one", () => {
  for (const typed of ["", "K7F2", "K7F29XQMM", "K7F29XQ0", "K7F29XQ1", "K7F29XQO", "K7F29XQI", "K7F2_9XQM", "K7F29XQÉ"]) {
    assert.equal(readShortCode(typed), null, typed);
  }
});

test("a code is shown in two halves, and reads back the same", () => {
  assert.equal(showShortCode(CODE), "K7F2-9XQM");
  assert.equal(readShortCode(showShortCode(CODE)), CODE);
});

test("only the same code at the same relay opens a box", async () => {
  const [keys, again, otherCode, otherRelay] = await Promise.all([
    makeCodeKeys(CODE, RELAY),
    makeCodeKeys(CODE, RELAY),
    makeCodeKeys("K7F29XQN", RELAY),
    makeCodeKeys(CODE, "https://other.example.test"),
  ]);
  const box = await lockCodeBox(keys, TEXT);
  assert.equal(await openCodeBox(keys, box), TEXT);
  assert.equal(await openCodeBox(again, box), TEXT);
  assert.equal(again.label, keys.label);
  assert.equal(await openCodeBox(otherCode, box), null);
  assert.equal(await openCodeBox(otherRelay, box), null);
  assert.notEqual(otherCode.label, keys.label);
  assert.notEqual(otherRelay.label, keys.label);

  // Locking twice gives different boxes, so a box says nothing about what is inside.
  assert.notDeepEqual(await lockCodeBox(keys, TEXT), box);

  // The box does not fit the door's label by accident, and the label fits the door.
  assert.notEqual(fromBase64UrlOfLength(keys.label, 32), null);
  assert.equal(readCodePath(relayCodePath(keys.label)), keys.label);

  // A box that was changed, cut short or is far too big does not open.
  const changed = box.slice();
  changed[changed.length - 1] ^= 1;
  assert.equal(await openCodeBox(keys, changed), null);
  assert.equal(await openCodeBox(keys, box.slice(0, 12)), null);
  assert.equal(await openCodeBox(keys, new Uint8Array(MAX_CODE_BOX_BYTES + 1)), null);
});

test("the door that keeps boxes takes only a label", () => {
  const label = "A".repeat(43);
  assert.equal(readCodePath(`/v1/code/${label}`), label);
  for (const path of ["/v1/code/", `/v1/code/${label}A`, `/v1/code/${"A".repeat(42)}`, `/v1/code/${label}/more`, `/v2/code/${label}`, `/v1/code/${"A".repeat(42)}+`]) {
    assert.equal(readCodePath(path), null, path);
  }
  assert.throws(() => relayCodePath("../rooms"));
});
