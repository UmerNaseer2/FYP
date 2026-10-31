/**
 * What the phone app makes of a short pairing code someone typed
 * (src/phone/code-entry.ts), with a fake fetch in place of the relay.
 *
 * Every code here is made up at random as the test runs, and no test prints one.
 * Each try at a code does the slow sums for real, so these tests take some seconds.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { readTypedCode, type CodeFetch } from "../phone/code-entry.js";
import { randomBytes, sameBytes, toBase64Url, utf8 } from "../shared/remote/bytes.js";
import { KEY_BYTES } from "../shared/remote/keys.js";
import { PAIRING_SECRET_BYTES, writePairingLink, type PairingCode } from "../shared/remote/pairing.js";
import { DESKTOP_ID_BYTES } from "../shared/remote/relay-auth.js";
import { relayCodePath } from "../shared/remote/relay-protocol.js";
import { lockCodeBox, makeCodeKeys, makeShortCode, showShortCode } from "../shared/remote/short-code.js";

const RELAY = "https://relay.example.test";

type FetchCall = { url: string; init: RequestInit };

/** A fetch that keeps what it was asked, and answers with what `respond` gives. */
function fakeFetch(respond: (url: string, init: RequestInit) => Promise<Response>): { fetch: CodeFetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetch: CodeFetch = (url, init) => {
    calls.push({ url, init });
    return respond(url, init);
  };
  return { fetch, calls };
}

function answering(status: number): CodeFetch {
  return fakeFetch(async () => new Response("no", { status })).fetch;
}

function newPairingCode(): PairingCode {
  return {
    desktopId: toBase64Url(randomBytes(DESKTOP_ID_BYTES)),
    desktopKey: randomBytes(KEY_BYTES),
    secret: randomBytes(PAIRING_SECRET_BYTES),
  };
}

/** A code, and the box the computer would leave for it holding this text. */
async function boxOf(text: string, origin = RELAY): Promise<{ code: string; box: Uint8Array<ArrayBuffer> }> {
  const code = makeShortCode();
  return { code, box: await lockCodeBox(await makeCodeKeys(code, origin), text) };
}

test("takes the box with a code however it was typed, and reads the link inside as a QR code's", async () => {
  const pairing = newPairingCode();
  const { code, box } = await boxOf(writePairingLink(RELAY, pairing));
  const { fetch, calls } = fakeFetch(async () => new Response(box, { status: 200 }));
  const typed = ` ${showShortCode(code).toLowerCase()} `;
  const outcome = await readTypedCode(typed, RELAY, fetch);
  assert.equal(outcome.kind, "pair");
  assert.ok(outcome.kind === "pair");
  assert.equal(outcome.code.desktopId, pairing.desktopId);
  assert.ok(sameBytes(outcome.code.desktopKey, pairing.desktopKey));
  assert.ok(sameBytes(outcome.code.secret, pairing.secret));

  assert.equal(calls.length, 1);
  const { url, init } = calls[0];
  const { label } = await makeCodeKeys(code, RELAY);
  assert.equal(url, RELAY + relayCodePath(label));
  assert.ok(!url.includes(code), "the relay gets the label, never the code");
  assert.equal(init.method, "POST");
  assert.equal(init.redirect, "error");
  assert.equal(init.credentials, "omit");
  assert.equal(init.cache, "no-store");
  assert.ok(init.signal instanceof AbortSignal);
});

test("asks the relay nothing about what cannot be a code", async () => {
  const { fetch, calls } = fakeFetch(async () => new Response(null, { status: 404 }));
  for (const typed of ["", "   ", "ABC", "ABCDEFGHJ", "ABCD-EFG0", "ABCD EFGI"]) {
    assert.deepEqual(await readTypedCode(typed, RELAY, fetch), { kind: "not-a-code" }, `typed "${typed}"`);
  }
  assert.equal(calls.length, 0);
});

test("says a code is wrong when the relay holds no box for it", async () => {
  assert.deepEqual(await readTypedCode(makeShortCode(), RELAY, answering(404)), { kind: "wrong" });
});

test("says so when the relay has turned away too many tries", async () => {
  assert.deepEqual(await readTypedCode(makeShortCode(), RELAY, answering(429)), { kind: "too-many" });
});

test("counts any other answer, no answer and a slow answer as the relay not being reached", async () => {
  for (const status of [201, 403, 405, 500, 503]) {
    assert.deepEqual(await readTypedCode(makeShortCode(), RELAY, answering(status)), { kind: "offline" }, `status ${status}`);
  }
  const unreachable = fakeFetch(async () => {
    throw new Error(`could not reach ${RELAY}`);
  });
  assert.deepEqual(await readTypedCode(makeShortCode(), RELAY, unreachable.fetch), { kind: "offline" });

  const silent = fakeFetch(
    (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      }),
  );
  // A timeout's timer does not hold the process open by itself, and a page has its own loop to do that.
  const holdOpen = setInterval(() => {}, 5);
  try {
    assert.deepEqual(await readTypedCode(makeShortCode(), RELAY, silent.fetch, 10), { kind: "offline" });
  } finally {
    clearInterval(holdOpen);
  }
});

test("takes nothing from a box the code does not open, or one with no pairing link in it", async () => {
  const someoneElses = await boxOf(writePairingLink(RELAY, newPairingCode()));
  const changed = someoneElses.box.slice();
  changed[changed.length - 1] ^= 1;
  const notALink = await boxOf("https://example.test/not-a-pairing-link");
  for (const [box, typed] of [
    [someoneElses.box, makeShortCode()],
    [changed, someoneElses.code],
    [utf8("nothing locked"), makeShortCode()],
    [notALink.box, notALink.code],
  ] as const) {
    const { fetch } = fakeFetch(async () => new Response(box, { status: 200 }));
    assert.deepEqual(await readTypedCode(typed, RELAY, fetch), { kind: "wrong" });
  }
});

test("says which relay a code is for when it is not this one", async () => {
  const other = "https://other-relay.example.test";
  const { code, box } = await boxOf(writePairingLink(other, newPairingCode()));
  const { fetch } = fakeFetch(async () => new Response(box, { status: 200 }));
  assert.deepEqual(await readTypedCode(code, RELAY, fetch), { kind: "other-relay", relayOrigin: other });
});
