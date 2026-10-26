/**
 * Sending drift alerts to phones through their push services
 * (src/main/phone-push.ts). A fake plays the push services, so these tests
 * read each message the way the phone would, and check what each answer
 * does: an ended subscription is forgotten, a pause is kept, trouble is
 * logged once, and one phone's push service never holds up another's. Each
 * look at the log also checks that it holds no push service address and no
 * phone key.
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

import { driftNotification, type DriftAlert } from "../core/drift-alerts";
import { newPushKey, readPushKey, type PushKey, type PushRequest, type PushResponse, type PushTransport } from "../core/web-push";
import type { Clock } from "../main/clock";
import { initLog, logFilePaths } from "../main/log";
import { PushSender, type PushPhone } from "../main/phone-push";
import { decrypt, newPhone, subscriptionOf, type Phone } from "./push-phone";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ss-phone-push-"));
initLog(path.join(root, "logs"), { echo: false });
after(() => fs.rmSync(root, { recursive: true, force: true }));

/** The push service addresses and phone keys the tests make. None of it may ever be in the log. */
const PRIVATE: string[] = [];

/** How much of the log the tests have read so far. */
let logRead = 0;

/** What has been logged since the last call, once it is checked for anything in PRIVATE. */
function newLogLines(): string {
  const file = logFilePaths()?.main;
  assert.ok(file, "the log has a folder");
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    // Nothing logged yet.
  }
  const fresh = text.slice(logRead);
  logRead = text.length;
  for (const value of PRIVATE) assert.ok(!fresh.includes(value), "the log holds no push service address and no phone key");
  return fresh;
}

const NOW = 1_700_000_000_000;
const SUBJECT = "https://relay.example.com";

/** A clock the tests move on by hand. The sender sets no timers, so it has none to give. */
class FakeClock implements Clock {
  time = NOW;
  now = (): number => this.time;
  setTimeout = (): unknown => {
    throw new Error("Expected the push sender to set no timers, but it set one.");
  };
  clearTimeout = (): void => {};
  advance(ms: number): void {
    this.time += ms;
  }
}

function pushKey(): PushKey {
  const key = readPushKey(newPushKey(crypto.randomBytes));
  assert.ok(key);
  return key;
}

const KEY = pushKey();

type TestPhone = { phone: PushPhone; browser: Phone };

/** A paired phone with drift alerts on, at a push service address of its own. */
function phoneWithAlerts(name: string, host = "fcm.googleapis.com"): TestPhone {
  const browser = newPhone();
  const token = crypto.randomBytes(12).toString("base64url");
  const push = { ...subscriptionOf(browser, `https://${host}/push/${token}`), since: NOW };
  PRIVATE.push(host, token, push.p256dh, push.auth);
  return { phone: { key: crypto.randomBytes(32).toString("base64url"), name, push }, browser };
}

/** The same phone after its browser subscribed again, with a new address and new keys. */
function resubscribed(old: TestPhone): TestPhone {
  const fresh = phoneWithAlerts(old.phone.name);
  return { phone: { ...old.phone, push: fresh.phone.push }, browser: fresh.browser };
}

function alert(changes: Partial<DriftAlert> = {}): DriftAlert {
  return {
    kind: "drifted",
    eventId: 1,
    trackedSchemaId: 7,
    name: "orders",
    connectionId: 5,
    connectionName: "Production",
    counts: { tablesAdded: 1, tablesRemoved: 0, tablesChanged: 0, constraintsChanged: 0, objectsChanged: 0 },
    drifted: true,
    orgSlug: "acme",
    ...changes,
  };
}

const ACCEPTED: PushResponse = { status: 201, retryAfter: null };

function answer(status: number, retryAfter: string | null = null): PushResponse {
  return { status, retryAfter };
}

/** Answers each request with the next answer in turn, failing once there are none left. */
function answersInTurn(...answers: PushResponse[]): () => PushResponse {
  return () => {
    const next = answers.shift();
    assert.ok(next, "the test push service has an answer left");
    return next;
  };
}

/**
 * A push sender whose push services are played by `answerFor`: each request
 * is kept, and answered with what `answerFor` gives for it, or fails with
 * what it throws, as a push service that could not be reached would.
 */
function newSender(answerFor: (request: PushRequest) => PushResponse | Promise<PushResponse> = () => ACCEPTED): {
  sender: PushSender;
  requests: PushRequest[];
  forgotten: Array<{ phoneKey: string; endpoint: string }>;
  clock: FakeClock;
} {
  newLogLines();
  const requests: PushRequest[] = [];
  const transport: PushTransport = async (request) => {
    requests.push(request);
    return answerFor(request);
  };
  const forgotten: Array<{ phoneKey: string; endpoint: string }> = [];
  const clock = new FakeClock();
  const sender = new PushSender({ transport, key: KEY, forget: (phoneKey, endpoint) => forgotten.push({ phoneKey, endpoint }), clock });
  return { sender, requests, forgotten, clock };
}

/** The message as the phone reads it. */
function readMessage(request: PushRequest, browser: Phone): unknown {
  return JSON.parse(decrypt(request.body, browser).toString("utf8"));
}

/** The claims in a request's VAPID token, and the public key sent with it. */
function vapidOf(request: PushRequest): { claims: unknown; key: string } {
  const match = /^vapid t=[\w-]+\.([\w-]+)\.[\w-]+, k=([\w-]+)$/.exec(request.headers.Authorization);
  assert.ok(match, "a VAPID Authorization header");
  return { claims: JSON.parse(Buffer.from(match[1], "base64url").toString("utf8")), key: match[2] };
}

test("sends each phone the drift alert, encrypted for that phone and signed with the push key", async () => {
  const { sender, requests } = newSender();
  const pixel = phoneWithAlerts("Pixel");
  const iphone = phoneWithAlerts("iPhone", "web.push.apple.com");
  await sender.send([pixel.phone, iphone.phone], [alert({ name: "Sales & <Orders>" })], SUBJECT);
  assert.equal(requests.length, 2);
  for (const [index, { phone, browser }] of [pixel, iphone].entries()) {
    const request = requests[index];
    assert.equal(request.url, phone.push.endpoint);
    // The name stays as it is: a phone shows plain text, not markup.
    assert.deepEqual(readMessage(request, browser), {
      v: 1,
      kind: "drift",
      title: "Drift found",
      body: "Sales & <Orders> on Production no longer matches its baseline: 1 table added.",
    });
    assert.equal(request.headers["Content-Encoding"], "aes128gcm");
    assert.equal(request.headers.TTL, "86400");
    const { claims, key } = vapidOf(request);
    assert.deepEqual(claims, { aud: new URL(phone.push.endpoint).origin, exp: NOW / 1000 + 12 * 60 * 60, sub: SUBJECT });
    assert.equal(key, KEY.publicKey.toString("base64url"));
  }
  // Each message opens for its own phone only.
  assert.throws(() => decrypt(requests[0].body, iphone.browser));
  assert.equal(newLogLines(), "");
});

test("sends one message for several alerts, worded as the desktop notification is", async () => {
  const { sender, requests } = newSender();
  const { phone, browser } = phoneWithAlerts("Pixel");
  const alerts = [alert(), alert({ eventId: 2, trackedSchemaId: 8, name: "billing", kind: "unreachable", counts: null })];
  const words = driftNotification(alerts, { markup: false });
  assert.ok(words);
  assert.equal(words.title, "Drift alerts for 2 schemas");
  await sender.send([phone], alerts, SUBJECT);
  assert.equal(requests.length, 1);
  assert.deepEqual(readMessage(requests[0], browser), { v: 1, kind: "drift", title: words.title, body: words.body });
});

test("sends nothing without an alert or a phone", async () => {
  const { sender, requests } = newSender();
  await sender.send([phoneWithAlerts("Pixel").phone], [], SUBJECT);
  await sender.send([], [alert()], SUBJECT);
  assert.equal(requests.length, 0);
  assert.equal(newLogLines(), "");
});

test("has a subscription forgotten when its push service says it has ended", async () => {
  for (const status of [404, 410]) {
    const { sender, requests, forgotten } = newSender(() => answer(status));
    const { phone } = phoneWithAlerts("Pixel");
    await sender.send([phone], [alert()], SUBJECT);
    assert.equal(requests.length, 1);
    assert.deepEqual(forgotten, [{ phoneKey: phone.key, endpoint: phone.push.endpoint }]);
    // The phone link logs it, as it turns the phone's alerts off.
    assert.equal(newLogLines(), "");
  }
});

test("keeps the pause a push service asks for, then sends again", async () => {
  const { sender, requests, clock } = newSender(answersInTurn(answer(429, "120"), ACCEPTED));
  const { phone } = phoneWithAlerts("Pixel");
  await sender.send([phone], [alert()], SUBJECT);
  assert.match(newLogLines(), /The push service of the phone "Pixel" asked for a pause, so that phone gets no drift alerts for a while\./);
  // An alert during the pause is skipped, not sent later.
  clock.advance(119_000);
  await sender.send([phone], [alert({ eventId: 2, kind: "in_sync", drifted: false })], SUBJECT);
  assert.equal(requests.length, 1);
  clock.advance(1000);
  await sender.send([phone], [alert({ eventId: 3 })], SUBJECT);
  assert.equal(requests.length, 2);
  assert.match(newLogLines(), /Drift alerts reach the phone "Pixel" again\./);
});

test("tries a push service with a problem of its own again at the next alert, unless it said to wait", async () => {
  const { sender, requests, clock } = newSender(answersInTurn(answer(503), answer(500), answer(503, "30"), ACCEPTED));
  const { phone } = phoneWithAlerts("Pixel");
  await sender.send([phone], [alert()], SUBJECT);
  assert.match(newLogLines(), /Drift alerts could not reach the phone "Pixel": its push service had a problem of its own\./);
  // It said nothing about waiting, so the next alert goes at once. The log has told of the trouble already.
  await sender.send([phone], [alert({ eventId: 2 })], SUBJECT);
  await sender.send([phone], [alert({ eventId: 3 })], SUBJECT);
  assert.equal(requests.length, 3);
  assert.equal(newLogLines(), "");
  // The last answer said to wait 30 seconds.
  clock.advance(29_000);
  await sender.send([phone], [alert({ eventId: 4 })], SUBJECT);
  assert.equal(requests.length, 3);
  clock.advance(1000);
  await sender.send([phone], [alert({ eventId: 5 })], SUBJECT);
  assert.equal(requests.length, 4);
  assert.match(newLogLines(), /Drift alerts reach the phone "Pixel" again\./);
});

test("logs a push service that cannot be reached, or does not answer in time, in fixed words", async () => {
  const { phone } = phoneWithAlerts("Pixel");
  // A network error can quote the address, which must stay out of the log.
  const unreachable = newSender(() => {
    throw new TypeError(`fetch failed: could not connect to ${phone.push.endpoint}`);
  });
  await unreachable.sender.send([phone], [alert()], SUBJECT);
  const unreachableLog = newLogLines();
  assert.match(unreachableLog, /Drift alerts could not reach the phone "Pixel": its push service could not be reached\./);
  assert.ok(!unreachableLog.includes("fetch failed"));

  const slow = newSender(() => {
    throw new DOMException(`The request to ${phone.push.endpoint} took too long.`, "TimeoutError");
  });
  await slow.sender.send([phone], [alert()], SUBJECT);
  const slowLog = newLogLines();
  assert.match(slowLog, /Drift alerts could not reach the phone "Pixel": its push service did not answer in time\./);
  assert.ok(!slowLog.includes("took too long"));
  // Neither said to wait, so the next alert is tried at once.
  await slow.sender.send([phone], [alert({ eventId: 2 })], SUBJECT);
  assert.equal(slow.requests.length, 2);
  assert.equal(newLogLines(), "");
});

test("logs a refusal once, until an alert reaches the phone again", async () => {
  const { sender, requests } = newSender(answersInTurn(answer(403), answer(403), answer(413), ACCEPTED, answer(413)));
  const { phone } = phoneWithAlerts("Pixel");
  await sender.send([phone], [alert()], SUBJECT);
  assert.match(newLogLines(), /The push service of the phone "Pixel" refused a drift alert \(status 403\)\./);
  await sender.send([phone], [alert({ eventId: 2 })], SUBJECT);
  await sender.send([phone], [alert({ eventId: 3 })], SUBJECT);
  assert.equal(newLogLines(), "");
  await sender.send([phone], [alert({ eventId: 4 })], SUBJECT);
  assert.match(newLogLines(), /Drift alerts reach the phone "Pixel" again\./);
  await sender.send([phone], [alert({ eventId: 5 })], SUBJECT);
  assert.match(newLogLines(), /The push service of the phone "Pixel" refused a drift alert as too big\./);
  // A refusal asks for no pause, so every alert was tried.
  assert.equal(requests.length, 5);
});

test("sends to each phone on its own, so one push service never holds up another", async () => {
  const pixel = phoneWithAlerts("Pixel");
  const iphone = phoneWithAlerts("iPhone", "web.push.apple.com");
  const galaxy = phoneWithAlerts("Galaxy");
  let answerPixel: (response: PushResponse) => void = () => {};
  const { sender, requests } = newSender((request) => {
    if (request.url === pixel.phone.push.endpoint) return new Promise<PushResponse>((resolve) => (answerPixel = resolve));
    if (request.url === iphone.phone.push.endpoint) throw new Error("Connection reset.");
    return ACCEPTED;
  });
  const sending = sender.send([pixel.phone, iphone.phone, galaxy.phone], [alert()], SUBJECT);
  // Every phone's request went out before any push service answered.
  assert.equal(requests.length, 3);
  let settled = false;
  void sending.then(() => (settled = true));
  await new Promise((resolve) => setImmediate(resolve));
  // The others are done, and the send waits only for the Pixel's push service.
  assert.equal(settled, false);
  assert.match(newLogLines(), /Drift alerts could not reach the phone "iPhone": its push service could not be reached\./);
  answerPixel(ACCEPTED);
  await sending;
  assert.equal(newLogLines(), "");
});

test("keeps sending to the other phones when one phone's message cannot be made", async () => {
  const { sender, requests } = newSender();
  const broken = phoneWithAlerts("Pixel");
  // Subscriptions are checked when a phone turns its alerts on, so only a test can give one keys that cannot be read.
  broken.phone.push = { ...broken.phone.push, p256dh: "not-a-key" };
  const galaxy = phoneWithAlerts("Galaxy");
  await sender.send([broken.phone, galaxy.phone], [alert()], SUBJECT);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, galaxy.phone.push.endpoint);
  assert.match(newLogLines(), /Could not send a drift alert to the phone "Pixel"\./);
});

test("starts afresh with a phone that subscribed again", async () => {
  const old = phoneWithAlerts("Pixel");
  const renewed = resubscribed(old);
  const { sender, requests } = newSender((request) => (request.url === old.phone.push.endpoint ? answer(429, "3600") : ACCEPTED));
  await sender.send([old.phone], [alert()], SUBJECT);
  assert.match(newLogLines(), /asked for a pause/);
  // The old address's pause does not hold up the new one.
  await sender.send([renewed.phone], [alert({ eventId: 2 })], SUBJECT);
  assert.equal(requests.length, 2);
  assert.equal(requests[1].url, renewed.phone.push.endpoint);
  assert.deepEqual(readMessage(requests[1], renewed.browser), readMessage(requests[0], old.browser));
  assert.equal(newLogLines(), "");
});

test("starts afresh with a phone that turned its alerts off and on again", async () => {
  const { sender, requests } = newSender(answersInTurn(answer(429, "3600"), ACCEPTED, ACCEPTED));
  const pixel = phoneWithAlerts("Pixel");
  const galaxy = phoneWithAlerts("Galaxy");
  await sender.send([pixel.phone], [alert()], SUBJECT);
  assert.match(newLogLines(), /asked for a pause/);
  // The Pixel turned its alerts off, so only the Galaxy is listed, and nothing is kept about the Pixel.
  await sender.send([galaxy.phone], [alert({ eventId: 2 })], SUBJECT);
  await sender.send([pixel.phone], [alert({ eventId: 3 })], SUBJECT);
  assert.deepEqual(
    requests.map((request) => request.url),
    [pixel.phone.push.endpoint, galaxy.phone.push.endpoint, pixel.phone.push.endpoint],
  );
});

test("starts afresh with a phone that turned its alerts on again at the same address", async () => {
  const { sender, requests } = newSender(answersInTurn(answer(429, "3600"), ACCEPTED));
  const pixel = phoneWithAlerts("Pixel");
  await sender.send([pixel.phone], [alert()], SUBJECT);
  assert.match(newLogLines(), /asked for a pause/);
  // The phone link gives a subscription a new time whenever a phone turns its
  // alerts on, even when the phone's browser hands back the subscription it had.
  const again = { ...pixel.phone, push: { ...pixel.phone.push, since: NOW + 60_000 } };
  await sender.send([again], [alert({ eventId: 2 })], SUBJECT);
  assert.equal(requests.length, 2);
  assert.equal(newLogLines(), "");
});

test("sends no alert too long for a push service, and logs that once", async () => {
  const { sender, requests } = newSender();
  const { phone } = phoneWithAlerts("Pixel");
  // Names are cut to fit a line before they get here, so only a test can make one this long.
  const long = alert({ name: "n".repeat(5000) });
  await sender.send([phone], [long], SUBJECT);
  await sender.send([phone], [long], SUBJECT);
  assert.equal(requests.length, 0);
  assert.equal(newLogLines().match(/A drift alert was too long to send to phones, so phones did not get it\./g)?.length, 1);
  // A message that fits still goes.
  await sender.send([phone], [alert()], SUBJECT);
  assert.equal(requests.length, 1);
});
