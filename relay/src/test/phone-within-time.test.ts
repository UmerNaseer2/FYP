/**
 * The phone's time limit on its storage (src/phone/within-time.ts). Work that
 * answers in time gives its answer. When time runs out, work that can still
 * be taken back is, and then fails. Work that can no longer be taken back,
 * such as a save the browser is already writing, is waited for, so the phone
 * never says a pairing was not saved and then finds it saved after all.
 */
import assert from "node:assert/strict";
import test from "node:test";

import type { Clock } from "../phone/clock.js";
import { withinTime } from "../phone/within-time.js";

const TOO_SLOW = "The storage did not answer in time.";
const MS = 1000;

/** A clock whose timers run only when a test moves time on. */
class FakeClock implements Clock {
  private time = 0;
  private timers = new Map<number, { at: number; run: () => void }>();
  private lastId = 0;

  now = (): number => this.time;

  setTimeout = (run: () => void, ms: number): unknown => {
    this.lastId += 1;
    this.timers.set(this.lastId, { at: this.time + ms, run });
    return this.lastId;
  };

  clearTimeout = (timer: unknown): void => {
    this.timers.delete(timer as number);
  };

  /** Moves time on, running each timer that comes due. */
  advance(ms: number): void {
    this.time += ms;
    for (const [id, timer] of [...this.timers]) {
      if (timer.at > this.time) continue;
      this.timers.delete(id);
      timer.run();
    }
  }
}

/** Work that ends only when the test ends it. */
function work(): { promise: Promise<string>; resolve: (value: string) => void; reject: (error: Error) => void } {
  let resolve!: (value: string) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<string>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

/** How `promise` stands once everything already due has run. */
async function outcome(promise: Promise<string>): Promise<string> {
  let state = "waiting";
  promise.then(
    (value) => {
      state = `gave ${value}`;
    },
    (error: Error) => {
      state = `failed: ${error.message}`;
    },
  );
  await new Promise((resolve) => setImmediate(resolve));
  return state;
}

/** A takeBack that counts its calls and answers `works`. */
function takeBack(works: boolean): { calls: number; run: () => boolean } {
  const counter = {
    calls: 0,
    run: () => {
      counter.calls += 1;
      return works;
    },
  };
  return counter;
}

test("gives the work's answer when it comes in time, and takes nothing back", async () => {
  const clock = new FakeClock();
  const save = work();
  const back = takeBack(true);
  const limited = withinTime(save.promise, { ms: MS, tooSlow: TOO_SLOW, takeBack: back.run, clock });

  clock.advance(MS - 1);
  save.resolve("saved");
  assert.equal(await outcome(limited), "gave saved");
  clock.advance(MS);
  assert.equal(back.calls, 0);
});

test("fails once time runs out, for work with nothing to take back", async () => {
  const clock = new FakeClock();
  const open = work();
  const limited = withinTime(open.promise, { ms: MS, tooSlow: TOO_SLOW, clock });

  clock.advance(MS - 1);
  assert.equal(await outcome(limited), "waiting");
  clock.advance(1);
  assert.equal(await outcome(limited), `failed: ${TOO_SLOW}`);
});

test("takes the work back once time runs out, then fails", async () => {
  const clock = new FakeClock();
  const save = work();
  const back = takeBack(true);
  const limited = withinTime(save.promise, { ms: MS, tooSlow: TOO_SLOW, takeBack: back.run, clock });

  clock.advance(MS);
  assert.equal(back.calls, 1);
  assert.equal(await outcome(limited), `failed: ${TOO_SLOW}`);
  // The browser then ends the work it took back with an error of its own, which changes nothing.
  save.reject(new Error("The transaction was aborted."));
  assert.equal(await outcome(limited), `failed: ${TOO_SLOW}`);
});

test("waits for work that can no longer be taken back, and gives what it came to", async () => {
  // As for a save the browser is already writing when time runs out: it
  // lands, so saying it failed would be wrong.
  const clock = new FakeClock();
  const save = work();
  const back = takeBack(false);
  const limited = withinTime(save.promise, { ms: MS, tooSlow: TOO_SLOW, takeBack: back.run, clock });

  clock.advance(MS);
  assert.equal(back.calls, 1);
  assert.equal(await outcome(limited), "waiting");
  clock.advance(60 * MS);
  assert.equal(await outcome(limited), "waiting");
  save.resolve("saved");
  assert.equal(await outcome(limited), "gave saved");
});

test("gives the work's own failure when work that could not be taken back fails", async () => {
  const clock = new FakeClock();
  const save = work();
  const limited = withinTime(save.promise, { ms: MS, tooSlow: TOO_SLOW, takeBack: takeBack(false).run, clock });

  clock.advance(MS);
  save.reject(new Error("The phone is out of space."));
  assert.equal(await outcome(limited), "failed: The phone is out of space.");
});
