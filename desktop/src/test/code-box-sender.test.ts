/**
 * How a short pairing code's box reaches the relay (src/main/code-box-sender.ts),
 * with a fake fetch in place of Electron's, so nothing here goes near a real relay.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { codeBoxSenderFor, type BoxFetch } from "../main/code-box-sender";
import { relayCodePath } from "../shared/remote/relay-protocol";

const RELAY = "https://relay.example.test";
const LABEL = "L".repeat(43);
const BOX = new Uint8Array([1, 2, 3, 4]);

type FetchCall = { url: string; init: RequestInit };

/** A fetch that keeps what it was asked, and answers with what `respond` gives. */
function fakeFetch(respond: (url: string, init: RequestInit) => Promise<Response>): { fetch: BoxFetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetch: BoxFetch = (url, init) => {
    calls.push({ url, init });
    return respond(url, init);
  };
  return { fetch, calls };
}

test("leaves the box at the door for its label, and says it did", async () => {
  const { fetch, calls } = fakeFetch(async () => new Response(null, { status: 201 }));
  assert.equal(await codeBoxSenderFor(fetch)(RELAY, LABEL, BOX), "stored");
  assert.equal(calls.length, 1);
  const { url, init } = calls[0];
  assert.equal(url, RELAY + relayCodePath(LABEL));
  assert.equal(init.method, "PUT");
  assert.equal(init.body, BOX);
  assert.equal(init.redirect, "error");
  assert.equal(init.credentials, "omit");
  assert.equal(init.cache, "no-store");
  assert.ok(init.signal instanceof AbortSignal);
});

test("says when the label holds another box, so that another code can be tried", async () => {
  const { fetch } = fakeFetch(async () => new Response("That label holds a box already.", { status: 409 }));
  assert.equal(await codeBoxSenderFor(fetch)(RELAY, LABEL, BOX), "taken");
});

test("counts anything else as failed, as from a relay that does not keep boxes yet", async () => {
  for (const status of [200, 403, 404, 413, 429, 500, 503]) {
    const { fetch } = fakeFetch(async () => new Response("no", { status }));
    assert.equal(await codeBoxSenderFor(fetch)(RELAY, LABEL, BOX), "failed", `status ${status}`);
  }
});

test("does not throw when the relay cannot be reached, or the label cannot be written", async () => {
  const { fetch, calls } = fakeFetch(async () => {
    throw new Error(`could not reach ${RELAY}`);
  });
  assert.equal(await codeBoxSenderFor(fetch)(RELAY, LABEL, BOX), "failed");
  assert.equal(calls.length, 1);
  assert.equal(await codeBoxSenderFor(fetch)(RELAY, "../rooms", BOX), "failed");
  assert.equal(calls.length, 1, "nothing was sent for a label that cannot be one");
});

test("gives up on a relay that does not answer in time", async () => {
  const { fetch } = fakeFetch(
    (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      }),
  );
  // A timeout's timer does not hold the process open by itself, and the app has its own loop to do that.
  const holdOpen = setInterval(() => {}, 5);
  try {
    assert.equal(await codeBoxSenderFor(fetch, 10)(RELAY, LABEL, BOX), "failed");
  } finally {
    clearInterval(holdOpen);
  }
});

test("lets go of an answer's body unread", async () => {
  let cancelled = false;
  const body = new ReadableStream({
    cancel() {
      cancelled = true;
    },
  });
  const { fetch } = fakeFetch(async () => new Response(body, { status: 201 }));
  assert.equal(await codeBoxSenderFor(fetch)(RELAY, LABEL, BOX), "stored");
  assert.ok(cancelled);
});
