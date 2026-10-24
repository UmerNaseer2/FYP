/**
 * The push transport (src/main/push-transport.ts), with a fake fetch in place
 * of Electron's, so nothing here goes near a real push service. It checks
 * that a request goes out as it was made, that only a browser's push service
 * is ever sent to, that a push service that does not answer in time is given
 * up on, and that no error quotes the address.
 */
import assert from "node:assert/strict";
import test from "node:test";

import type { PushRequest } from "../core/web-push";
import { pushTransportFor, type PushFetch } from "../main/push-transport";

const ENDPOINT = "https://fcm.googleapis.com/fcm/send/dGVzdA";

function requestTo(url: string): PushRequest {
  return {
    url,
    headers: { Authorization: "vapid t=a.b.c, k=d", TTL: "86400", "Content-Encoding": "aes128gcm" },
    body: Buffer.from([1, 2, 3]),
  };
}

type FetchCall = { url: string; init: RequestInit };

/** A fetch that keeps what it was asked, and answers with what `respond` gives. */
function fakeFetch(respond: (url: string, init: RequestInit) => Promise<Response>): { fetch: PushFetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetch: PushFetch = (url, init) => {
    calls.push({ url, init });
    return respond(url, init);
  };
  return { fetch, calls };
}

/** The error a send fails with, once it is checked for the address. */
async function failure(sending: Promise<unknown>, url: string): Promise<Error> {
  try {
    await sending;
  } catch (error) {
    assert.ok(error instanceof Error);
    assert.ok(!String(error.stack).includes(url), "the error does not quote the address");
    // The log prints an error's cause, so there must be none.
    assert.equal(error.cause, undefined);
    return error;
  }
  assert.fail("Expected the send to fail, but it did not.");
}

test("posts the request as it was made, and gives the status and any wait asked for", async () => {
  const { fetch, calls } = fakeFetch(async () => new Response(null, { status: 429, headers: { "Retry-After": "120" } }));
  const request = requestTo(ENDPOINT);
  assert.deepEqual(await pushTransportFor(fetch)(request), { status: 429, retryAfter: "120" });
  assert.equal(calls.length, 1);
  const { url, init } = calls[0];
  assert.equal(url, ENDPOINT);
  assert.equal(init.method, "POST");
  assert.deepEqual(init.headers, request.headers);
  assert.equal(init.body, request.body);
  assert.equal(init.redirect, "error");
  assert.equal(init.credentials, "omit");
  assert.equal(init.cache, "no-store");
  assert.ok(init.signal instanceof AbortSignal);
});

test("gives no wait when the push service asked for none", async () => {
  const { fetch } = fakeFetch(async () => new Response(null, { status: 201 }));
  assert.deepEqual(await pushTransportFor(fetch)(requestTo(ENDPOINT)), { status: 201, retryAfter: null });
});

test("sends nothing to an address that is not a browser's push service", async () => {
  const { fetch, calls } = fakeFetch(async () => new Response(null, { status: 201 }));
  const send = pushTransportFor(fetch);
  for (const url of ["http://fcm.googleapis.com/x", "https://example.com/push", "https://fcm.googleapis.com:8443/x"]) {
    const error = await failure(send(requestTo(url)), url);
    assert.equal(error.message, "Drift alerts may only go to a browser's push service.");
  }
  assert.equal(calls.length, 0);
});

test("says a push service could not be reached in fixed words, without the address", async () => {
  const { fetch } = fakeFetch(async (url) => {
    throw new TypeError(`fetch failed: getaddrinfo ENOTFOUND ${url}`);
  });
  const error = await failure(pushTransportFor(fetch)(requestTo(ENDPOINT)), ENDPOINT);
  assert.equal(error.message, "The push service could not be reached.");
  assert.notEqual(error.name, "TimeoutError");
});

test("gives up on a push service that does not answer in time", async () => {
  const { fetch } = fakeFetch(
    (_url, init) =>
      new Promise((_resolve, reject) => {
        // Node does not wait for the transport's own timer, so this one keeps
        // the test running, and fails it should the transport never give up.
        const failsafe = setTimeout(() => reject(new Error("Expected the push transport to give up, but it did not.")), 5000);
        // As fetch does, it stops once the signal says time is up.
        init.signal?.addEventListener("abort", () => {
          clearTimeout(failsafe);
          reject(init.signal?.reason);
        });
      }),
  );
  const error = await failure(pushTransportFor(fetch, 20)(requestTo(ENDPOINT)), ENDPOINT);
  assert.equal(error.name, "TimeoutError");
  assert.equal(error.message, "The push service did not answer in time.");
});

test("lets go of what the push service sent back, unread", async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled = true;
    },
  });
  const { fetch } = fakeFetch(async () => new Response(body, { status: 201 }));
  assert.deepEqual(await pushTransportFor(fetch)(requestTo(ENDPOINT)), { status: 201, retryAfter: null });
  // A stream can finish cancelling on a later turn.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cancelled, true);
});
