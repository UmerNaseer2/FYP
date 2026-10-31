/**
 * The rules for the boxes behind short pairing codes and for how often an
 * address may knock (short-code.ts in src/shared/remote explains the codes).
 * They are kept apart from the Durable Objects that run them (code-box.ts), so
 * the tests can run them in Node with a pretend store and clock.
 *
 * The relay cannot open a box and cannot tell a right guess from a wrong one
 * by what is inside, so its rules are only about time and counting: a box
 * lasts as long as a pairing link does, goes to the first one to take it, and
 * a label already holding a box cannot be written over.
 */
import { PAIRING_LIFETIME_MS } from "./shared/remote/pairing.js";

/** How many times one address may use the door in one window. Far more than anyone pairing, even in a busy office behind one address. */
export const MAX_TRIES = 30;
/** How long one window of counting lasts. */
export const TRIES_WINDOW_MS = 60_000;

/** A box the relay is keeping, and when it stops. */
export type KeptBox = { box: Uint8Array; until: number };

/** Where a box is kept. Each label has a store of its own. */
export interface BoxStorage {
  get(): Promise<KeptBox | undefined>;
  put(kept: KeptBox): Promise<void>;
  remove(): Promise<void>;
  /** Asks to have the box cleared away at this time, in case nobody takes it. */
  wakeAt(time: number): Promise<void>;
}

/**
 * Keeps a box, unless the label holds one already. Refusing is what stops
 * anyone replacing a box a computer has left, and a computer that hears this
 * only has to pick another code.
 */
export async function storeBox(storage: BoxStorage, box: Uint8Array, now: number): Promise<"stored" | "taken"> {
  const kept = await storage.get();
  if (kept !== undefined && now < kept.until) return "taken";
  const until = now + PAIRING_LIFETIME_MS;
  await storage.put({ box, until });
  await storage.wakeAt(until);
  return "stored";
}

/**
 * Hands a box over and forgets it, so that one code opens one browser's way
 * in at most. The time is checked here as well, as a clearing can come late.
 */
export async function takeBox(storage: BoxStorage, now: number): Promise<Uint8Array | null> {
  const kept = await storage.get();
  if (kept === undefined) return null;
  await storage.remove();
  return now < kept.until ? kept.box : null;
}

/** How many tries an address has made in the window that began at windowStart. */
export type Tries = { windowStart: number; count: number };

/** Counts one more try, and says whether it may go ahead. */
export function countTry(previous: Tries | undefined, now: number): { next: Tries; allowed: boolean } {
  if (previous === undefined || now < previous.windowStart || now >= previous.windowStart + TRIES_WINDOW_MS) {
    return { next: { windowStart: now, count: 1 }, allowed: true };
  }
  // A try over the limit is not added to the count, which never needs to go higher.
  if (previous.count >= MAX_TRIES) return { next: previous, allowed: false };
  return { next: { windowStart: previous.windowStart, count: previous.count + 1 }, allowed: true };
}
