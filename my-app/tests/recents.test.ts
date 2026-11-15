/** @jest-environment jsdom */

// The recents list (lib/recents.ts): the last few pages, schemas and actions,
// kept in this browser for the command bar. What matters is that it never
// throws, never repeats itself, stays short and keeps organizations apart.

import { MAX_RECENTS, clearRecents, forgetAllRecents, readRecents, recordRecent } from "@/lib/recents";

beforeEach(() => localStorage.clear());

test("starts empty", () => {
  expect(readRecents("acme")).toEqual([]);
});

test("puts the newest first", () => {
  recordRecent({ kind: "page", label: "Drift", href: "/acme/drift" }, "acme");
  recordRecent({ kind: "schema", label: "university", href: "/acme/visualizer?schema=university" }, "acme");
  expect(readRecents("acme").map((each) => each.label)).toEqual(["university", "Drift"]);
});

test("moves a repeat to the top instead of listing it twice", () => {
  recordRecent({ kind: "page", label: "Drift", href: "/acme/drift" }, "acme");
  recordRecent({ kind: "page", label: "Deploy", href: "/acme/deploy" }, "acme");
  recordRecent({ kind: "page", label: "Drift", href: "/acme/drift" }, "acme");
  expect(readRecents("acme").map((each) => each.label)).toEqual(["Drift", "Deploy"]);
});

test("keeps only the last few", () => {
  for (let i = 0; i < MAX_RECENTS + 4; i++) {
    recordRecent({ kind: "page", label: `Page ${i}`, href: `/acme/p${i}` }, "acme");
  }
  const kept = readRecents("acme");
  expect(kept).toHaveLength(MAX_RECENTS);
  expect(kept[0].label).toBe(`Page ${MAX_RECENTS + 3}`);
});

test("keeps one list per organization", () => {
  recordRecent({ kind: "page", label: "Drift", href: "/acme/drift" }, "acme");
  recordRecent({ kind: "page", label: "Deploy", href: "/globex/deploy" }, "globex");
  expect(readRecents("acme").map((each) => each.label)).toEqual(["Drift"]);
  expect(readRecents("globex").map((each) => each.label)).toEqual(["Deploy"]);
  clearRecents("acme");
  expect(readRecents("acme")).toEqual([]);
  expect(readRecents("globex")).toHaveLength(1);
});

test("shrugs off saved text that is not JSON, or not a list", () => {
  localStorage.setItem("schema-studio:recents:acme", "not json");
  expect(readRecents("acme")).toEqual([]);
  localStorage.setItem("schema-studio:recents:acme", '{"kind":"page"}');
  expect(readRecents("acme")).toEqual([]);
  // Recording over a broken list starts a clean one.
  recordRecent({ kind: "page", label: "Drift", href: "/acme/drift" }, "acme");
  expect(readRecents("acme")).toHaveLength(1);
});

test("drops entries that are not the right shape", () => {
  localStorage.setItem(
    "schema-studio:recents:acme",
    JSON.stringify([{ kind: "page", label: "Drift", href: "/acme/drift" }, { kind: "nope", label: "x", href: "/x" }, 7, null])
  );
  expect(readRecents("acme")).toEqual([{ kind: "page", label: "Drift", href: "/acme/drift" }]);
});

test("does not throw when storage is blocked", () => {
  const getItem = jest.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("blocked");
  });
  const setItem = jest.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("blocked");
  });
  try {
    expect(readRecents("acme")).toEqual([]);
    expect(() => recordRecent({ kind: "page", label: "Drift", href: "/acme/drift" }, "acme")).not.toThrow();
  } finally {
    getItem.mockRestore();
    setItem.mockRestore();
  }
});

test("forgetting all lists clears every organization and leaves other keys alone", () => {
  recordRecent({ kind: "page", label: "Drift", href: "/acme/drift" }, "acme");
  recordRecent({ kind: "page", label: "History", href: "/beta/history" }, "beta");
  window.localStorage.setItem("schema-studio:theme", "dark");
  forgetAllRecents();
  expect(readRecents("acme")).toEqual([]);
  expect(readRecents("beta")).toEqual([]);
  expect(window.localStorage.getItem("schema-studio:theme")).toBe("dark");
});
