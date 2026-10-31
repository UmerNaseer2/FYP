/**
 * The rules for a short pairing code's box, with a pretend store and clock.
 * The real ones run against wrangler in relay.e2e.test.ts.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { countTry, MAX_TRIES, storeBox, takeBox, TRIES_WINDOW_MS, type BoxStorage, type KeptBox, type Tries } from "../code-box-logic.js";
import { PAIRING_LIFETIME_MS } from "../shared/remote/pairing.js";

const START = 1_000_000;
const BOX = new Uint8Array([1, 2, 3]);
const OTHER = new Uint8Array([4, 5, 6]);

function fakeStorage(): BoxStorage & { kept: KeptBox | undefined; wakes: number[] } {
  return {
    kept: undefined,
    wakes: [],
    async get() {
      return this.kept;
    },
    async put(kept) {
      this.kept = kept;
    },
    async remove() {
      this.kept = undefined;
    },
    async wakeAt(time) {
      this.wakes.push(time);
    },
  };
}

test("keeps a box for as long as a pairing link lasts", async () => {
  const storage = fakeStorage();
  assert.equal(await storeBox(storage, BOX, START), "stored");
  assert.deepEqual(storage.kept, { box: BOX, until: START + PAIRING_LIFETIME_MS });
  assert.deepEqual(storage.wakes, [START + PAIRING_LIFETIME_MS]);
});

test("will not write over a box that is still good", async () => {
  const storage = fakeStorage();
  await storeBox(storage, BOX, START);
  assert.equal(await storeBox(storage, OTHER, START + PAIRING_LIFETIME_MS - 1), "taken");
  assert.equal(storage.kept?.box, BOX);
});

test("writes over a box that has run out, when its clearing came late", async () => {
  const storage = fakeStorage();
  await storeBox(storage, BOX, START);
  assert.equal(await storeBox(storage, OTHER, START + PAIRING_LIFETIME_MS), "stored");
  assert.equal(storage.kept?.box, OTHER);
  assert.equal(storage.wakes.at(-1), START + 2 * PAIRING_LIFETIME_MS);
});

test("gives a box to the first one who takes it, and nobody else", async () => {
  const storage = fakeStorage();
  await storeBox(storage, BOX, START);
  assert.equal(await takeBox(storage, START + 1), BOX);
  assert.equal(await takeBox(storage, START + 1), null);
});

test("gives nobody a box that has run out, and forgets it", async () => {
  const storage = fakeStorage();
  await storeBox(storage, BOX, START);
  assert.equal(await takeBox(storage, START + PAIRING_LIFETIME_MS), null);
  assert.equal(storage.kept, undefined);
});

test("has nothing to give for a label that never held a box", async () => {
  assert.equal(await takeBox(fakeStorage(), START), null);
});

test("lets an address try so many times in a window and no more", () => {
  let tries: Tries | undefined;
  for (let i = 0; i < MAX_TRIES; i++) {
    const { next, allowed } = countTry(tries, START + i);
    assert.equal(allowed, true, `try ${i + 1}`);
    tries = next;
  }
  assert.equal(tries?.count, MAX_TRIES);
  const refused = countTry(tries, START + MAX_TRIES);
  assert.equal(refused.allowed, false);
  // Being refused does not move the window on, or a steady stream of tries would never be let back in.
  assert.deepEqual(refused.next, tries);
});

test("counts again once the window is over", () => {
  const full: Tries = { windowStart: START, count: MAX_TRIES };
  assert.equal(countTry(full, START + TRIES_WINDOW_MS - 1).allowed, false);
  assert.deepEqual(countTry(full, START + TRIES_WINDOW_MS), { next: { windowStart: START + TRIES_WINDOW_MS, count: 1 }, allowed: true });
});

test("is not stuck by a clock that went back", () => {
  const full: Tries = { windowStart: START, count: MAX_TRIES };
  assert.deepEqual(countTry(full, START - 1), { next: { windowStart: START - 1, count: 1 }, allowed: true });
});
