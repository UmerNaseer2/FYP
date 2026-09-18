import {
  compareRuns,
  describeDelta,
  describeItem,
  HISTORY_ITEM_LIMIT,
  readRunSnapshot,
  snapshotChanges,
  type RunSnapshot,
} from "@/lib/comparison-history";
import type { ChangeRow } from "@/lib/compare-export";

/**
 * The rules behind "show historical comparison changes" (spec 04).
 *
 * Everything here is pure — no database — so the writing and reading of the
 * row is tested separately. What this file is about is the one question the
 * feature exists to answer: given what the last run found and what this one
 * found, what actually moved?
 *
 * What is NOT here:
 *  - The panel that draws this answer on the compare screen:
 *    tests/component-compare-history.test.tsx.
 */

function change(over: Partial<ChangeRow> = {}): ChangeRow {
  return {
    category: "Column",
    table: "orders",
    object: "total",
    change: "changed",
    severity: "breaking",
    detail: "numeric(10,2) → integer",
    manual: false,
    ...over,
  };
}

describe("snapshotChanges", () => {
  it("counts each severity separately", () => {
    const snap = snapshotChanges([
      change({ object: "a", severity: "breaking" }),
      change({ object: "b", severity: "safe" }),
      change({ object: "c", severity: "safe" }),
      change({ object: "d", severity: "info" }),
    ]);
    expect(snap).toMatchObject({ breaking: 1, safe: 2, info: 1, total: 4 });
  });

  it("finds nothing in an empty report", () => {
    const snap = snapshotChanges([]);
    expect(snap.total).toBe(0);
    expect(snap.items).toEqual([]);
    expect(snap.truncated).toBe(false);
  });

  it("does not depend on the order the report walked the schema in", () => {
    // The two sides of a comparison are walked in whatever order the
    // introspection returned them. A fingerprint that moved with that order
    // would report drift on every other run.
    const rows = [change({ object: "a" }), change({ object: "b" }), change({ object: "c" })];
    const forwards = snapshotChanges(rows);
    const backwards = snapshotChanges([...rows].reverse());
    expect(backwards.fingerprint).toBe(forwards.fingerprint);
    expect(backwards.items).toEqual(forwards.items);
  });

  it("counts the same difference listed twice only once", () => {
    const snap = snapshotChanges([change(), change()]);
    expect(snap.total).toBe(1);
    expect(snap.breaking).toBe(1);
  });

  it("keeps the worse severity when a difference is listed twice", () => {
    // Otherwise a breaking change could read as safe purely because the safe
    // copy of the row happened to come second.
    const snap = snapshotChanges([
      change({ severity: "safe" }),
      change({ severity: "breaking" }),
    ]);
    expect(snap).toMatchObject({ breaking: 1, safe: 0 });
  });

  it("separates two differences that differ only in one field", () => {
    // Every field in the key is there because two differences can share all
    // the others. A key missing one of them would report the pair as a single
    // difference, and hide the moment one of them was fixed.
    const rows: ChangeRow[] = [
      change(),
      change({ category: "Constraint" }),
      change({ table: "invoices" }),
      change({ object: "subtotal" }),
      change({ change: "dropped" }),
      change({ detail: "integer → text" }),
    ];
    expect(snapshotChanges(rows).total).toBe(rows.length);
  });

  it("does not confuse two differences whose names run together", () => {
    // A key joined with a separator character would read these as the same
    // difference, because a table or a column may legally contain whatever
    // character was picked.
    const snap = snapshotChanges([
      change({ table: "a|b", object: "c" }),
      change({ table: "a", object: "b|c" }),
    ]);
    expect(snap.total).toBe(2);
  });

  it("stores only the first differences of a huge report, and says so", () => {
    const rows = Array.from({ length: HISTORY_ITEM_LIMIT + 5 }, (_, i) =>
      change({ object: `col_${String(i).padStart(4, "0")}` }),
    );
    const snap = snapshotChanges(rows);
    expect(snap.items).toHaveLength(HISTORY_ITEM_LIMIT);
    expect(snap.truncated).toBe(true);
    // The total is what was FOUND, not what was stored — the banner says "512
    // differences", not "500".
    expect(snap.total).toBe(HISTORY_ITEM_LIMIT + 5);
  });

  it("fingerprints past the stored limit", () => {
    // The whole point of hashing every key rather than the stored ones: two
    // runs that differ only in a difference beyond the cut-off must not read
    // as identical.
    const base = Array.from({ length: HISTORY_ITEM_LIMIT + 1 }, (_, i) =>
      change({ object: `col_${String(i).padStart(4, "0")}` }),
    );
    const moved = [...base.slice(0, -1), change({ object: "zzz_new_column" })];
    const a = snapshotChanges(base);
    const b = snapshotChanges(moved);
    expect(a.items).toEqual(b.items);
    expect(a.fingerprint).not.toBe(b.fingerprint);
  });

  it("gives two different reports two different fingerprints", () => {
    expect(snapshotChanges([change()]).fingerprint).not.toBe(
      snapshotChanges([change({ object: "shipping" })]).fingerprint,
    );
    // Severity is not part of the key, so a regrade alone keeps the
    // fingerprint — the same difference is still the same difference.
    expect(snapshotChanges([change({ severity: "safe" })]).fingerprint).toBe(
      snapshotChanges([change({ severity: "breaking" })]).fingerprint,
    );
  });

  it("keeps the fingerprint inside 32 bits of hex", () => {
    // A hash that overflowed into floating point would come back as
    // "-1a2b3c4d" or in exponent form, and a column that stores it as text
    // would keep both spellings of the same run.
    for (const n of [1, 2, 50, 300]) {
      const snap = snapshotChanges(
        Array.from({ length: n }, (_, i) => change({ object: `c${i}` })),
      );
      expect(snap.fingerprint).toMatch(/^[0-9a-f]{8}$/);
    }
  });
});

describe("compareRuns", () => {
  const snapOf = (...objects: string[]) =>
    snapshotChanges(objects.map((object) => change({ object })));

  it("says nothing moved when the two runs found the same differences", () => {
    const delta = compareRuns(snapOf("a", "b"), snapOf("b", "a"));
    expect(delta.same).toBe(true);
    expect(delta.appeared).toEqual([]);
    expect(delta.resolved).toEqual([]);
  });

  it("names what appeared and what was resolved", () => {
    const delta = compareRuns(snapOf("a", "b"), snapOf("b", "c"));
    expect(delta.appeared.map((i) => JSON.parse(i.key)[2])).toEqual(["c"]);
    expect(delta.resolved.map((i) => JSON.parse(i.key)[2])).toEqual(["a"]);
    expect(delta.same).toBe(false);
  });

  it("reports a first difference and a last one resolved", () => {
    expect(compareRuns(snapOf(), snapOf("a")).appeared).toHaveLength(1);
    expect(compareRuns(snapOf("a"), snapOf()).resolved).toHaveLength(1);
  });

  it("carries the severity of what appeared", () => {
    const before = snapshotChanges([]);
    const after = snapshotChanges([change({ severity: "breaking" })]);
    expect(compareRuns(before, after).appeared[0].severity).toBe("breaking");
  });

  it("does not call two truncated runs the same just because the stored lists match", () => {
    // Both runs stored the same first 500 differences; what moved is past
    // them. Deciding `same` from the lists would say "nothing has drifted"
    // about a run that drifted.
    const a: RunSnapshot = { ...snapOf("a"), truncated: true, fingerprint: "1111" };
    const b: RunSnapshot = { ...snapOf("a"), truncated: true, fingerprint: "2222" };
    const delta = compareRuns(a, b);
    expect(delta.same).toBe(false);
    expect(delta.appeared).toEqual([]);
    expect(delta.complete).toBe(false);
  });

  it("is complete only when neither run was truncated", () => {
    const whole = snapOf("a");
    const cut: RunSnapshot = { ...whole, truncated: true };
    expect(compareRuns(whole, whole).complete).toBe(true);
    expect(compareRuns(cut, whole).complete).toBe(false);
    expect(compareRuns(whole, cut).complete).toBe(false);
  });
});

describe("describeItem", () => {
  it("names a table's object", () => {
    const [item] = snapshotChanges([change()]).items;
    expect(describeItem(item)).toBe("orders.total — column changed");
  });

  it("leaves off the dot for something that is not inside a table", () => {
    const [item] = snapshotChanges([
      change({ category: "View", table: "", object: "active_orders", change: "dropped" }),
    ]).items;
    expect(describeItem(item)).toBe("active_orders — view dropped");
  });

  it("shows a key it cannot read rather than dropping the row", () => {
    // A row written by a build that shaped keys differently. A list of what
    // changed that quietly lost entries would be worse than an ugly one.
    expect(describeItem({ key: "not json", severity: "info" })).toBe("not json");
    expect(describeItem({ key: '"a string"', severity: "info" })).toBe('"a string"');
  });
});

describe("describeDelta", () => {
  const snapOf = (...objects: string[]) =>
    snapshotChanges(objects.map((object) => change({ object })));

  it("says so when nothing has drifted", () => {
    const said = describeDelta(compareRuns(snapOf("a"), snapOf("a")), "yesterday");
    expect(said).toContain("yesterday");
    expect(said).toContain("Nothing has drifted");
  });

  it("counts what appeared and calls out the breaking ones", () => {
    const before = snapshotChanges([]);
    const after = snapshotChanges([
      change({ object: "a", severity: "breaking" }),
      change({ object: "b", severity: "safe" }),
    ]);
    const said = describeDelta(compareRuns(before, after), "on Monday");
    expect(said).toContain("2 new differences");
    expect(said).toContain("1 of them breaking");
  });

  it("counts one difference in the singular", () => {
    const said = describeDelta(compareRuns(snapOf(), snapOf("a")), "last week");
    expect(said).toContain("1 new difference");
    expect(said).not.toContain("differences");
  });

  it("reports resolved differences too", () => {
    const said = describeDelta(compareRuns(snapOf("a", "b"), snapOf("b")), "last week");
    expect(said).toContain("1 difference resolved");
  });

  it("admits when the lists could not cover everything", () => {
    const a: RunSnapshot = { ...snapOf("a"), truncated: true };
    const b: RunSnapshot = { ...snapOf("b"), truncated: true };
    const said = describeDelta(compareRuns(a, b), "yesterday");
    expect(said).toContain("1 new difference");
    expect(said).toContain("what could be compared");
  });

  it("does not claim nothing appeared when the change is past the stored limit", () => {
    // Fingerprints disagree, both stored lists are identical. Silence here
    // would read as "no new differences", which is the one thing it does not
    // mean.
    const a: RunSnapshot = { ...snapOf("a"), truncated: true, fingerprint: "1111" };
    const b: RunSnapshot = { ...snapOf("a"), truncated: true, fingerprint: "2222" };
    const said = describeDelta(compareRuns(a, b), "yesterday");
    expect(said).toContain("Something changed");
    expect(said).toContain(String(HISTORY_ITEM_LIMIT));
  });
});

describe("readRunSnapshot", () => {
  it("reads back what snapshotChanges wrote", () => {
    const snap = snapshotChanges([change(), change({ object: "shipping", severity: "safe" })]);
    // Through JSON, the way the JSONB column round-trips it.
    expect(readRunSnapshot(JSON.parse(JSON.stringify(snap)))).toEqual(snap);
  });

  it("refuses anything that is not a stored snapshot", () => {
    for (const value of [null, undefined, 7, "x", [], {}, { fingerprint: 1, items: [] }]) {
      expect(readRunSnapshot(value)).toBeNull();
    }
    // A fingerprint with no list is not a snapshot either — it would compare
    // as "something changed" against everything, forever.
    expect(readRunSnapshot({ fingerprint: "abc" })).toBeNull();
  });

  it("drops entries it cannot read and keeps the rest", () => {
    const read = readRunSnapshot({
      fingerprint: "abcd1234",
      items: [
        { key: "good", severity: "breaking" },
        { key: "no severity" },
        { key: 7, severity: "safe" },
        { key: "bad severity", severity: "catastrophic" },
        null,
        { key: "also good", severity: "info" },
      ],
    });
    expect(read?.items).toEqual([
      { key: "good", severity: "breaking" },
      { key: "also good", severity: "info" },
    ]);
  });

  it("never reports a total smaller than the list under it", () => {
    // "500 of 3 differences" is nonsense on screen; falling back to what was
    // actually read keeps the sentence true.
    const read = readRunSnapshot({
      fingerprint: "abcd1234",
      items: [{ key: "a", severity: "info" }],
    });
    expect(read?.total).toBe(1);
  });

  it("treats a missing truncated flag as not truncated", () => {
    const read = readRunSnapshot({ fingerprint: "abcd1234", items: [], truncated: "yes" });
    // Only a real `true` counts — a string is not a flag, and guessing `true`
    // here would put the "could not cover everything" warning on every run.
    expect(read?.truncated).toBe(false);
  });
});
