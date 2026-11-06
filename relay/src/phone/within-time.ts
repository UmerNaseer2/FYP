/**
 * A time limit on the phone's storage, since a stuck browser never answers
 * at all. It is kept apart from idb-store.ts, which needs the browser's
 * IndexedDB, so that the tests can run it in Node.
 */
import { SYSTEM_CLOCK, type Clock } from "./clock.js";

export type TimeLimit = {
  /** How long the work has. */
  ms: number;
  /** What the failure says once time runs out. */
  tooSlow: string;
  /**
   * Stops the work, or returns false when that is too late, as for a save
   * the browser is already writing. Work without one fails on time,
   * whatever it goes on to do.
   */
  takeBack?: () => boolean;
  /** The browser's own clock unless a test passes one. */
  clock?: Clock;
};

/**
 * `work`, or a failure once the time limit has gone by. Saying the work
 * failed is only true once it can no longer happen, so work that cannot be
 * taken back is waited for instead: otherwise the phone could say a pairing
 * was not saved, and then find it saved after all.
 */
export function withinTime<T>(work: Promise<T>, limit: TimeLimit): Promise<T> {
  const clock = limit.clock ?? SYSTEM_CLOCK;
  return new Promise<T>((resolve, reject) => {
    const timer = clock.setTimeout(() => {
      if (limit.takeBack === undefined || limit.takeBack()) reject(new Error(limit.tooSlow));
    }, limit.ms);
    work.then(resolve, reject).finally(() => clock.clearTimeout(timer));
  });
}
