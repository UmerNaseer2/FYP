/**
 * What Settings' Phone section is told (src/main/phone-settings.ts). A fake
 * phone link stands in for the real one, which src/test/phone-link.test.ts
 * tests on its own.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { MAX_PAIRED_PHONES } from "../core/phone-link-file";
import type { PhoneLinkView } from "../main/phone-link";
import {
  CONNECTIONS_FAILED,
  makePairing,
  NOT_STARTED,
  phoneView,
  readPhoneConnections,
  setRelay,
  type PhoneSettingsLink,
} from "../main/phone-settings";
import { pairingQr } from "../main/qr";

const RELAY = "https://relay.example.com";
const KEYS_PROBLEM = "The phone link could not open its keys. Schema Studio's log has the details.";

function phone(number: number, connected = false, alerts = false) {
  return { key: `key-${number}`, name: `Phone ${number}`, pairedAt: 1_000 + number, lastSeenAt: 2_000 + number, connected, alerts };
}

/** A phone link that shows the view it is given and notes what Settings asks of it. */
function fakeLink(
  overrides: Partial<PhoneLinkView> = {},
  pairing: { link: string; expiresAt: number } | null = null,
  takesRelay = true,
) {
  const calls = { pairingLinks: 0, relays: [] as unknown[] };
  const view: PhoneLinkView = {
    status: { state: "connected" },
    enabled: true,
    relayOrigin: RELAY,
    sharedConnectionIds: [],
    phones: [],
    ...overrides,
  };
  const link: PhoneSettingsLink = {
    view: () => view,
    newPairingLink: () => {
      calls.pairingLinks += 1;
      return pairing;
    },
    setRelayOrigin: (text) => {
      calls.relays.push(text);
      return takesRelay;
    },
  };
  return { link, view, calls };
}

test("says why there is nothing to show before the phone link has opened", () => {
  assert.deepEqual(phoneView(null, null), { available: false, message: NOT_STARTED });
  assert.deepEqual(phoneView(null, KEYS_PROBLEM), { available: false, message: KEYS_PROBLEM });
});

test("shows only what the page needs, on a copy, with why a phone cannot pair yet", () => {
  // A field the page has no use for, which must not be passed on.
  const extra = { ...phone(1, true), note: "not for the page" };
  const { link, view } = fakeLink({
    status: { state: "waiting", retryAt: 5_000, reason: "The relay could not be reached." },
    sharedConnectionIds: [3, 1],
    phones: [extra, phone(2, false, true)],
  });
  const shown = phoneView(link, null);
  assert.deepEqual(shown, {
    available: true,
    status: { state: "waiting", retryAt: 5_000, reason: "The relay could not be reached." },
    enabled: true,
    relayOrigin: RELAY,
    sharedConnectionIds: [3, 1],
    phones: [phone(1, true), phone(2, false, true)],
    cannotPair: "The phone link is not connected to the relay yet, and a phone pairs through it.",
  });
  assert.notEqual(shown.sharedConnectionIds, view.sharedConnectionIds);
  assert.equal(MAX_PAIRED_PHONES, 8);

  const plain = phoneView(fakeLink({ status: Object.assign({ state: "connected" as const }, { note: "x" }) }).link, null);
  assert.ok(plain.available);
  assert.deepEqual(plain.status, { state: "connected" });

  // A link that is turned off is shown as off, so the page's switch matches it.
  const off = phoneView(fakeLink({ enabled: false, status: { state: "off" } }).link, null);
  assert.ok(off.available);
  assert.equal(off.enabled, false);
});

test("says why a phone cannot pair, and asks for no pairing link until one can", () => {
  assert.deepEqual(makePairing(null, null), { ok: false, message: NOT_STARTED });
  assert.deepEqual(makePairing(null, KEYS_PROBLEM), { ok: false, message: KEYS_PROBLEM });
  const refusals: Array<[Partial<PhoneLinkView>, RegExp]> = [
    [{ enabled: false, status: { state: "off" } }, /^Turn the phone link on to pair a phone\.$/],
    [{ relayOrigin: null, status: { state: "needs-relay" } }, /^Add a relay first/],
    [{ status: { state: "connecting" } }, /not connected to the relay yet/],
    [{ status: { state: "waiting", retryAt: 1, reason: "The relay stopped answering." } }, /not connected to the relay yet/],
    [{ status: { state: "replaced" } }, /not connected to the relay yet/],
    [{ phones: Array.from({ length: MAX_PAIRED_PHONES }, (_, index) => phone(index)) }, /^8 phones are paired, the most there can be\./],
  ];
  for (const [overrides, message] of refusals) {
    const { link, calls } = fakeLink(overrides, { link: `${RELAY}/#pair=v1.x`, expiresAt: 9 });
    const answer = makePairing(link, null);
    assert.equal(answer.ok, false);
    assert.match(answer.ok ? "" : answer.message, message);
    assert.equal(calls.pairingLinks, 0, `no pairing link was made for ${message}`);
    // The page is told the same reason beforehand, so its Pair button can say it.
    const shown = phoneView(link, null);
    assert.ok(shown.available && !answer.ok);
    assert.equal(shown.cannotPair, answer.message);
  }

  // Seven phones leave room for one more, and the link itself can still say no.
  const { link, calls } = fakeLink({ phones: Array.from({ length: MAX_PAIRED_PHONES - 1 }, (_, index) => phone(index)) });
  const shown = phoneView(link, null);
  assert.ok(shown.available);
  assert.equal(shown.cannotPair, null, "the page may offer a code");
  const answer = makePairing(link, null);
  assert.match(answer.ok ? "" : answer.message, /not connected to the relay yet/);
  assert.equal(calls.pairingLinks, 1);
});

test("gives the page the pairing code's drawing and never the link with its secret", () => {
  const secret = "Sec_RET".repeat(6) + "x";
  const text = `${RELAY}/#pair=v1.${"d".repeat(22)}.${"k".repeat(43)}.${secret}`;
  const { link, calls } = fakeLink({}, { link: text, expiresAt: 123_456 });
  const answer = makePairing(link, null);
  assert.deepEqual(answer, { ok: true, expiresAt: 123_456, qr: pairingQr(text) });
  assert.equal(calls.pairingLinks, 1);
  const sent = JSON.stringify(answer);
  assert.ok(!sent.includes(secret) && !sent.includes("#pair="), "the answer holds neither the link nor its secret");
});

test("saves a relay's address tidied, and refuses one that is not a relay's", () => {
  const { link, calls } = fakeLink();
  assert.deepEqual(setRelay(link, "  HTTPS://Relay.Example.com/ ", null), { ok: true, relayOrigin: RELAY });
  assert.deepEqual(setRelay(link, "http://localhost:8787", null), { ok: true, relayOrigin: "http://localhost:8787" });
  assert.deepEqual(calls.relays, [RELAY, "http://localhost:8787"]);

  for (const text of ["", "relay.example.com", "ftp://relay.example.com", "http://relay.example.com", `${RELAY}/path`, `${RELAY}/#x`, 42]) {
    const answer = setRelay(link, text, null);
    assert.match(answer.ok ? "" : answer.message, /^Enter the relay's address on its own/, `refused ${JSON.stringify(text)}`);
  }
  assert.equal(calls.relays.length, 2, "the link was never handed an address that is not one");

  assert.equal(setRelay(fakeLink({}, null, false).link, RELAY, null).ok, false, "an address the link turns down is refused");
  assert.deepEqual(setRelay(null, RELAY, null), { ok: false, message: NOT_STARTED });
  assert.deepEqual(setRelay(null, RELAY, KEYS_PROBLEM), { ok: false, message: KEYS_PROBLEM });
});

test("lists the saved connections the server sends, and says why it cannot", () => {
  const connections = [
    { id: 2, name: "Bookshop", environment: "prod" as const, database: "bookshop" },
    { id: 5, name: "Bookshop dev", environment: "unset" as const, database: "bookshop_dev" },
  ];
  assert.deepEqual(readPhoneConnections({ status: 200, json: { connections } }), { ok: true, connections });
  assert.deepEqual(readPhoneConnections({ status: 200, json: { connections: [] } }), { ok: true, connections: [] });
  assert.deepEqual(readPhoneConnections({ status: 200, json: { rows: connections } }), { ok: false, message: CONNECTIONS_FAILED });
  assert.deepEqual(readPhoneConnections({ status: 500, json: { error: "x" } }), { ok: false, message: CONNECTIONS_FAILED });
  // Only a 200 answer is the list, even when another answer's body looks like one.
  assert.deepEqual(readPhoneConnections({ status: 500, json: { connections } }), { ok: false, message: CONNECTIONS_FAILED });
  const signedOut = readPhoneConnections({ status: 401, json: null });
  assert.match(signedOut.ok ? "" : signedOut.message, /^Sign in to Schema Studio to choose/);
  const forbidden = readPhoneConnections({ status: 403, json: null });
  assert.match(forbidden.ok ? "" : forbidden.message, /^Your role in Schema Studio may not use Compare or the Visualizer/);
});
