/**
 * What the desktop app, the phone and the relay say to each other
 * (src/shared/remote/relay-protocol.ts).
 */
import assert from "node:assert/strict";
import test from "node:test";

import { randomBytes, toBase64Url } from "../shared/remote/bytes.js";
import { DESKTOP_ID_BYTES } from "../shared/remote/relay-auth.js";
import {
  addChannel,
  CLOSE_BROKEN,
  CLOSE_FULL,
  CLOSE_REPLACED,
  CLOSE_SENT_AWAY,
  CLOSE_SIGN_IN_FAILED,
  CLOSE_TOO_BIG,
  CLOSE_TOO_FAST,
  MAX_CHANNEL,
  MAX_CONTROL_LENGTH,
  MAX_FRAME_BYTES,
  MAX_RELAY_MESSAGE_BYTES,
  PING,
  PONG,
  readChannel,
  readControl,
  readRelayPath,
  relayPath,
  writeControl,
  type Control,
} from "../shared/remote/relay-protocol.js";

/** A computer's ID: any 16 bytes, written as relay-auth.ts writes them. */
const ID = toBase64Url(randomBytes(DESKTOP_ID_BYTES));

test("writes the computer's and the phone's relay addresses, and reads them back", () => {
  for (const role of ["desktop", "phone"] as const) {
    const path = relayPath(role, ID);
    assert.equal(path, `/v1/${role}/${ID}`);
    assert.deepEqual(readRelayPath(path), { role, desktopId: ID });
  }
  assert.throws(() => relayPath("phone", ID.slice(1)), /not a computer's ID/);
});

test("refuses any other address", () => {
  for (const path of [
    `/v1/phone/${ID.slice(1)}`,
    `/v1/phone/${ID.slice(0, 21)}B`,
    `/v1/laptop/${ID}`,
    `/v2/phone/${ID}`,
    `/v1/phone/${ID}/`,
    `/v1/phone/${ID}?x=1`,
    `v1/phone/${ID}`,
    "/v1/phone/",
  ]) {
    assert.equal(readRelayPath(path), null, path);
  }
});

test("puts a message's channel in front of it in four bytes, most significant first", () => {
  assert.deepEqual(addChannel(0x01020304, Uint8Array.of(9)), Uint8Array.of(1, 2, 3, 4, 9));
  assert.deepEqual(readChannel(addChannel(MAX_CHANNEL, Uint8Array.of(9))), { channel: MAX_CHANNEL, message: Uint8Array.of(9) });
  assert.equal(addChannel(1, new Uint8Array(MAX_RELAY_MESSAGE_BYTES)).length, MAX_FRAME_BYTES);
});

test("refuses a channel or a message it cannot carry", () => {
  for (const channel of [0, -1, 1.5, MAX_CHANNEL + 1, Number.NaN]) {
    assert.throws(() => addChannel(channel, Uint8Array.of(9)), /not a channel/, String(channel));
  }
  assert.throws(() => addChannel(1, new Uint8Array(0)), /wrong size/);
  assert.throws(() => addChannel(1, new Uint8Array(MAX_RELAY_MESSAGE_BYTES + 1)), /wrong size/);
});

test("reads only what addChannel makes, wherever it sits in its buffer", () => {
  // Too short to hold a message, then channel 0, which is never given out.
  assert.equal(readChannel(Uint8Array.of(0, 0, 0, 1)), null);
  assert.equal(readChannel(Uint8Array.of(0, 0, 0, 0, 9)), null);
  const tooBig = new Uint8Array(MAX_FRAME_BYTES + 1);
  tooBig[3] = 1;
  assert.equal(readChannel(tooBig), null);
  assert.equal(readChannel(tooBig.subarray(0, MAX_FRAME_BYTES))?.channel, 1);
  // A message that starts partway into a bigger buffer.
  assert.deepEqual(readChannel(Uint8Array.of(0xaa, 0, 0, 0, 5, 6, 7).subarray(1)), { channel: 5, message: Uint8Array.of(6, 7) });
});

test("writes every control message and reads it back the same", () => {
  const controls: Control[] = [
    { type: "challenge", challenge: randomBytes(32) },
    { type: "auth", publicKey: randomBytes(32), signature: randomBytes(64) },
    { type: "ready" },
    { type: "open", channel: 1 },
    { type: "close", channel: MAX_CHANNEL },
    { type: "online" },
    { type: "offline" },
    { type: "ping" },
    { type: "pong" },
  ];
  for (const control of controls) {
    assert.deepEqual(readControl(writeControl(control)), control, control.type);
  }
  assert.equal(writeControl({ type: "ping" }), PING);
  assert.equal(writeControl({ type: "pong" }), PONG);
});

test("keeps the longest control message, auth, well under the limit", () => {
  const auth = writeControl({ type: "auth", publicKey: new Uint8Array(32), signature: new Uint8Array(64) });
  assert.equal(auth.length, 159);
  assert.ok(auth.length < MAX_CONTROL_LENGTH);
});

test("refuses anything that is not exactly one of the control messages", () => {
  for (const text of [
    "",
    "ping",
    "[]",
    "null",
    '"ping"',
    "{}",
    '{"t":"hello"}',
    '{"t":"ping","x":1}',
    '{"__proto__":{},"t":"ping"}',
    '{"t":"open"}',
    '{"t":"open","c":0}',
    '{"t":"open","c":1.5}',
    '{"t":"open","c":"1"}',
    '{"t":"close","c":-1}',
    '{"t":"close","c":4294967296}',
    // A challenge of 31 bytes, then one with a field too many.
    JSON.stringify({ t: "challenge", n: "A".repeat(42) }),
    JSON.stringify({ t: "challenge", n: toBase64Url(randomBytes(32)), x: 1 }),
    JSON.stringify({ t: "auth", key: toBase64Url(randomBytes(32)) }),
    // A ping, but longer than any control message may be.
    PING + " ".repeat(MAX_CONTROL_LENGTH),
  ]) {
    assert.equal(readControl(text), null, JSON.stringify(text));
  }
});

test("gives each reason for closing its own code, from the range WebSocket leaves to applications", () => {
  const codes = [CLOSE_REPLACED, CLOSE_SIGN_IN_FAILED, CLOSE_SENT_AWAY, CLOSE_FULL, CLOSE_BROKEN, CLOSE_TOO_FAST, CLOSE_TOO_BIG];
  assert.equal(new Set(codes).size, codes.length);
  for (const code of codes) assert.ok(code >= 4000 && code <= 4999, String(code));
});
