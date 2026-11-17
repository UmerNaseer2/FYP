// ---------------------------------------------------------------------------
// concurrency.ts
// Run an array of async jobs a few at a time instead of all at once.
//
// `Promise.all(items.map(fn))` starts every job in the same tick. That is fine
// for pure computation and wrong for anything that borrows a database
// connection: six comparisons against a pool of six connections, each wanting
// two of them, do not run six times faster — they deadlock, because every job
// is holding one connection while waiting for a second that will never come
// free. Bounding how many run at once is what makes the arithmetic work out.
// ---------------------------------------------------------------------------

/**
 * Like `Promise.all(items.map(fn))`, but with at most `limit` jobs in flight.
 *
 * Results come back in the order of `items`, not the order they finished, so
 * callers can zip them against the input the same way they did with
 * Promise.all. A job that throws rejects the whole call — again matching
 * Promise.all — but jobs already running are not cancelled, so a caller that
 * needs every outcome should hand in a `fn` that catches for itself.
 */
export async function mapWithLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  // A limit below one would hand out no workers at all and hang forever, so
  // treat "no limit" and "nonsense limit" alike: run them one at a time.
  const workers = Math.max(1, Math.min(Math.floor(limit) || 1, items.length));
  const results: R[] = new Array(items.length);

  // Shared cursor. Each worker takes the next unclaimed index until there are
  // none left, which keeps every worker busy even when the jobs take wildly
  // different amounts of time — a fixed slice-per-worker split would leave
  // three workers idle while the fourth chewed through the big schema.
  let next = 0;
  async function work(): Promise<void> {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: workers }, work));
  return results;
}
