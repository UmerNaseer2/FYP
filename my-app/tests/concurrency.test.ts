import { mapWithLimit } from "@/lib/concurrency";
import { plural, countOf } from "@/lib/plural";

/**
 * The reason mapWithLimit exists is the connection pool, so the tests that
 * matter are the ones about how many jobs are in flight — not just that the
 * answers come back. A helper that returned the right array while still
 * starting every job at once would pass a shallow test and deadlock in
 * production exactly as before.
 */

/** A job that reports how many of its siblings were running alongside it. */
function tracker() {
  let running = 0;
  let peak = 0;
  return {
    peak: () => peak,
    async job<T>(value: T, delayTicks = 1): Promise<T> {
      running += 1;
      peak = Math.max(peak, running);
      // Yielding to the microtask queue is enough: it lets every other job
      // that is ready to start actually start before this one finishes.
      for (let i = 0; i < delayTicks; i += 1) await Promise.resolve();
      running -= 1;
      return value;
    },
  };
}

describe("mapWithLimit — how many run at once", () => {
  it("never exceeds the limit", async () => {
    const t = tracker();
    const items = [1, 2, 3, 4, 5, 6, 7, 8];
    await mapWithLimit(items, 2, (n) => t.job(n, 3));
    expect(t.peak()).toBeLessThanOrEqual(2);
  });

  it("actually uses the whole limit rather than running one at a time", async () => {
    const t = tracker();
    await mapWithLimit([1, 2, 3, 4, 5, 6], 3, (n) => t.job(n, 3));
    expect(t.peak()).toBe(3);
  });

  it("does not start more workers than there are items", async () => {
    const t = tracker();
    await mapWithLimit([1, 2], 10, (n) => t.job(n, 3));
    expect(t.peak()).toBe(2);
  });

  it("treats a nonsense limit as one at a time instead of hanging", async () => {
    const t = tracker();
    await expect(mapWithLimit([1, 2, 3], 0, (n) => t.job(n, 2))).resolves.toEqual([
      1, 2, 3,
    ]);
    expect(t.peak()).toBe(1);
    await expect(mapWithLimit([1, 2, 3], -5, (n) => t.job(n, 2))).resolves.toEqual([
      1, 2, 3,
    ]);
  });
});

describe("mapWithLimit — results", () => {
  it("returns results in input order, not completion order", async () => {
    // Reversed delays: the last item finishes first.
    const result = await mapWithLimit([0, 1, 2, 3], 4, async (n) => {
      for (let i = 0; i < 4 - n; i += 1) await Promise.resolve();
      return n * 10;
    });
    expect(result).toEqual([0, 10, 20, 30]);
  });

  it("passes the index through", async () => {
    const seen = await mapWithLimit(["a", "b", "c"], 2, async (item, index) =>
      `${index}:${item}`,
    );
    expect(seen).toEqual(["0:a", "1:b", "2:c"]);
  });

  it("returns an empty array for no items without hanging", async () => {
    await expect(mapWithLimit([], 4, async () => 1)).resolves.toEqual([]);
  });

  it("rejects when a job throws, the way Promise.all does", async () => {
    await expect(
      mapWithLimit([1, 2, 3], 2, async (n) => {
        if (n === 2) throw new Error("job 2 failed");
        return n;
      }),
    ).rejects.toThrow("job 2 failed");
  });
});

describe("plural", () => {
  it("uses the singular for exactly one", () => {
    expect(plural(1, "line")).toBe("line");
    expect(countOf(1, "line")).toBe("1 line");
  });

  it("uses the plural for everything else, zero included", () => {
    expect(countOf(0, "line")).toBe("0 lines");
    expect(countOf(2, "line")).toBe("2 lines");
    // Negative counts should not read as singular either.
    expect(plural(-1, "line")).toBe("lines");
  });

  it("takes an irregular plural when the caller supplies one", () => {
    expect(countOf(1, "table differs", "tables differ")).toBe("1 table differs");
    expect(countOf(3, "table differs", "tables differ")).toBe("3 tables differ");
  });
});
