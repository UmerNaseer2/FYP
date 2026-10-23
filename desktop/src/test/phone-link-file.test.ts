/**
 * What phone-link.json holds, and checking what is read back
 * (src/core/phone-link-file.ts).
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import {
  MAX_PAIRED_PHONES,
  newPhoneLinkState,
  parsePhoneLinkState,
  withPairedPhone,
  withPhoneSeen,
  withoutPhone,
  type PairedPhone,
  type PhoneLinkState,
} from "../core/phone-link-file";
import { fromBase64Url } from "../shared/remote/bytes.js";
import { importKeyPair } from "../shared/remote/keys.js";

/** A made-up key: 32 bytes of `fill`, as base64url. */
function keyOf(fill: number): string {
  return Buffer.alloc(32, fill).toString("base64url");
}

const PHONE: PairedPhone = { key: keyOf(7), name: "Work phone", pairedAt: 1_700_000_000_000, lastSeenAt: 1_700_000_500_000 };

function saved(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    enabled: true,
    relayOrigin: "https://relay.example.com",
    sharedConnectionIds: [3, 1],
    phones: [PHONE],
    signingKey: keyOf(1),
    staticKey: keyOf(2),
    ...overrides,
  };
}

test("starts with new keys, the link off, nothing shared and no phones", () => {
  const sizes: number[] = [];
  let fill = 0;
  const state = newPhoneLinkState((size) => {
    sizes.push(size);
    return Buffer.alloc(size, ++fill);
  });
  assert.deepEqual(sizes, [32, 32]);
  assert.deepEqual(state, {
    enabled: false,
    relayOrigin: null,
    sharedConnectionIds: [],
    phones: [],
    signingKey: keyOf(1),
    staticKey: keyOf(2),
  });
});

test("reads back what it writes, through JSON as the file holds it", () => {
  const state = newPhoneLinkState(crypto.randomBytes);
  assert.deepEqual(parsePhoneLinkState(JSON.parse(JSON.stringify(state))), state);
  const full = saved();
  assert.deepEqual(parsePhoneLinkState(JSON.parse(JSON.stringify(full))), full);
});

test("makes keys that the phone link can use", async () => {
  const state = newPhoneLinkState(crypto.randomBytes);
  const signing = await importKeyPair("Ed25519", fromBase64Url(state.signingKey)!);
  const link = await importKeyPair("X25519", fromBase64Url(state.staticKey)!);
  assert.equal(signing.publicKey.length, 32);
  assert.equal(link.publicKey.length, 32);
});

test("counts the file as damaged when either key is not what the app wrote", () => {
  const short = Buffer.alloc(31, 1).toString("base64url");
  const long = Buffer.alloc(33, 1).toString("base64url");
  // The same 32 bytes as keyOf(1) would be, with an unused bit set in the last character.
  const twoWays = keyOf(1).slice(0, -1) + "F";
  for (const bad of [undefined, null, "", short, long, twoWays, keyOf(1) + "=", 5, [keyOf(1)]]) {
    assert.equal(parsePhoneLinkState(saved({ signingKey: bad })), null, `signing key ${String(bad)}`);
    assert.equal(parsePhoneLinkState(saved({ staticKey: bad })), null, `static key ${String(bad)}`);
  }
  for (const value of [null, undefined, "text", 5, [saved()]]) {
    assert.equal(parsePhoneLinkState(value), null, String(value));
  }
});

test("keeps the link off unless the file says it is on", () => {
  for (const enabled of [undefined, null, "true", 1, false]) {
    assert.equal(parsePhoneLinkState(saved({ enabled }))?.enabled, false, String(enabled));
  }
});

test("keeps only a relay address the phone link may use, written the one way", () => {
  assert.equal(parsePhoneLinkState(saved({ relayOrigin: "https://relay.example.com/" }))?.relayOrigin, "https://relay.example.com");
  assert.equal(parsePhoneLinkState(saved({ relayOrigin: "http://localhost:8787" }))?.relayOrigin, "http://localhost:8787");
  for (const relayOrigin of [undefined, null, "", "http://relay.example.com", "https://relay.example.com/room", "relay.example.com", 443]) {
    assert.equal(parsePhoneLinkState(saved({ relayOrigin }))?.relayOrigin, null, String(relayOrigin));
  }
});

test("keeps each shared connection once, and leaves out any that is not a connection's number", () => {
  const read = parsePhoneLinkState(saved({ sharedConnectionIds: [4, 2, 4, 0, -1, 1.5, "3", null, Number.MAX_SAFE_INTEGER + 1, 9] }));
  assert.deepEqual(read?.sharedConnectionIds, [4, 2, 9]);
  for (const sharedConnectionIds of [undefined, null, "1,2", { 0: 1 }]) {
    assert.deepEqual(parsePhoneLinkState(saved({ sharedConnectionIds }))?.sharedConnectionIds, [], String(sharedConnectionIds));
  }
});

test("leaves out a paired phone that cannot be read, and keeps the rest", () => {
  const other: PairedPhone = { key: keyOf(8), name: "Tablet", pairedAt: 5, lastSeenAt: 6 };
  const phones = [
    PHONE,
    { ...other, key: "not a key" },
    { ...other, key: Buffer.alloc(31, 8).toString("base64url") },
    { ...other, pairedAt: -1 },
    { ...other, pairedAt: 1.5 },
    { ...other, pairedAt: "5" },
    "phone",
    null,
    other,
  ];
  assert.deepEqual(parsePhoneLinkState(saved({ phones }))?.phones, [PHONE, other]);
  for (const bad of [undefined, null, PHONE, "phones"]) {
    assert.deepEqual(parsePhoneLinkState(saved({ phones: bad }))?.phones, [], String(bad));
  }
});

test("keeps the first of two phones with the same key, and no more than the most it pairs with", () => {
  const twice = [PHONE, { ...PHONE, name: "Copy" }];
  assert.deepEqual(parsePhoneLinkState(saved({ phones: twice }))?.phones, [PHONE]);
  const many = Array.from({ length: MAX_PAIRED_PHONES + 2 }, (_, i) => ({ ...PHONE, key: keyOf(20 + i) }));
  const read = parsePhoneLinkState(saved({ phones: many }))?.phones;
  assert.deepEqual(read, many.slice(0, MAX_PAIRED_PHONES));
});

test("cleans a paired phone's name, and takes its pairing time when its last connection cannot be read", () => {
  const phones = [
    { ...PHONE, name: "  Work\n\nphone  " },
    { ...PHONE, key: keyOf(9), name: 42, lastSeenAt: undefined },
    { ...PHONE, key: keyOf(10), name: "", lastSeenAt: "yesterday" },
  ];
  assert.deepEqual(parsePhoneLinkState(saved({ phones }))?.phones, [
    PHONE,
    { ...PHONE, key: keyOf(9), name: "Phone", lastSeenAt: PHONE.pairedAt },
    { ...PHONE, key: keyOf(10), name: "Phone", lastSeenAt: PHONE.pairedAt },
  ]);
});

test("pairs a new phone at the end, until the most it pairs with", () => {
  let phones: PairedPhone[] = [];
  for (let i = 0; i < MAX_PAIRED_PHONES; i++) {
    const next = withPairedPhone(phones, keyOf(30 + i), `Phone ${i}`, 1000 + i);
    assert.ok(next);
    phones = next;
  }
  assert.deepEqual(phones[0], { key: keyOf(30), name: "Phone 0", pairedAt: 1000, lastSeenAt: 1000 });
  assert.equal(phones.length, MAX_PAIRED_PHONES);
  assert.equal(withPairedPhone(phones, keyOf(99), "One too many", 2000), null);
});

test("lets a paired phone pair again, keeping its place and first pairing time, even when the list is full", () => {
  const full = Array.from({ length: MAX_PAIRED_PHONES }, (_, i) => ({ ...PHONE, key: keyOf(40 + i) }));
  const again = withPairedPhone(full, keyOf(42), "New name", 3000);
  assert.deepEqual(again?.[2], { key: keyOf(42), name: "New name", pairedAt: PHONE.pairedAt, lastSeenAt: 3000 });
  assert.deepEqual(again?.filter((_, i) => i !== 2), full.filter((_, i) => i !== 2));
  // The list it was given is left as it was.
  assert.equal(full[2].name, PHONE.name);
});

test("notes when a phone last connected, and forgets a phone", () => {
  const other: PairedPhone = { ...PHONE, key: keyOf(8) };
  const phones = [PHONE, other];
  assert.deepEqual(withPhoneSeen(phones, other.key, 4000), [PHONE, { ...other, lastSeenAt: 4000 }]);
  assert.deepEqual(withPhoneSeen(phones, keyOf(99), 4000), phones);
  assert.deepEqual(withoutPhone(phones, PHONE.key), [other]);
  assert.deepEqual(withoutPhone(phones, keyOf(99)), phones);
  assert.equal(phones.length, 2);
});

test("writes a state that reads back the same after a phone pairs", () => {
  const state: PhoneLinkState = { ...newPhoneLinkState(crypto.randomBytes), sharedConnectionIds: [5] };
  const paired = withPairedPhone(state.phones, keyOf(50), "Pixel", 1234);
  assert.ok(paired);
  const next: PhoneLinkState = { ...state, phones: paired };
  assert.deepEqual(parsePhoneLinkState(JSON.parse(JSON.stringify(next))), next);
});
