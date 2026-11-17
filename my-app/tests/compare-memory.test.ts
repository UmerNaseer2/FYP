/**
 * @jest-environment jsdom
 */
// Compare keeps the last comparison so leaving the page and coming back finds
// it as it was: the result and filters in memory, the query in the tab.
import type { CompareScreen } from "@/lib/compare-run";
import {
  forgetCompare,
  hasMemory,
  isRestoring,
  markRestoring,
  recall,
  recallQuery,
  rememberDraft,
  rememberFilters,
  rememberQuery,
  rememberScreen,
  scriptKey,
} from "@/lib/compare-memory";

const ORG = "acme";
const QUERY = "run=1&sourceConnection=1&sourceSchema=a&targetConnection=1&targetSchema=b";
const screen = { marker: "screen" } as unknown as CompareScreen;

beforeEach(() => {
  forgetCompare(ORG);
  forgetCompare("other");
});

describe("compare memory", () => {
  it("keeps the result, filters and query of the comparison on screen", () => {
    rememberQuery(ORG, QUERY);
    rememberScreen(ORG, QUERY, screen);
    rememberFilters(ORG, QUERY, { 0: "rem" });
    expect(hasMemory(ORG)).toBe(true);
    expect(recallQuery(ORG)).toBe(QUERY);
    expect(recall(ORG, QUERY)).toEqual({ screen, filters: { 0: "rem" }, drafts: {} });
    expect(window.sessionStorage.getItem(`schema-studio:compare-last:${ORG}`)).toBe(QUERY);
  });

  it("recalls nothing for a different comparison or organization", () => {
    rememberQuery(ORG, QUERY);
    rememberScreen(ORG, QUERY, screen);
    expect(recall(ORG, "run=1&sourceSchema=x")).toBeNull();
    expect(recall("other", QUERY)).toBeNull();
    expect(hasMemory("other")).toBe(false);
  });

  it("starts fresh when a different comparison is noted", () => {
    rememberQuery(ORG, QUERY);
    rememberScreen(ORG, QUERY, screen);
    rememberQuery(ORG, "run=1&sourceSchema=x");
    expect(recall(ORG, QUERY)).toBeNull();
    expect(recall(ORG, "run=1&sourceSchema=x")).toEqual({ screen: null, filters: {}, drafts: {} });
  });

  it("ignores writes for a comparison that is no longer the one kept", () => {
    rememberQuery(ORG, QUERY);
    rememberScreen(ORG, "run=1&sourceSchema=x", screen);
    rememberFilters(ORG, "run=1&sourceSchema=x", { 0: "add" });
    expect(recall(ORG, QUERY)).toEqual({ screen: null, filters: {}, drafts: {} });
  });

  it("keeps a script edit and drops it once it matches the generated script again", () => {
    rememberQuery(ORG, QUERY);
    const base = { base: "CREATE TABLE t ();", baseDown: "DROP TABLE t;" };
    rememberDraft(ORG, QUERY, 0, { ...base, up: "CREATE TABLE t (); -- mine", down: base.baseDown });
    expect(recall(ORG, QUERY)?.drafts[0]?.up).toBe("CREATE TABLE t (); -- mine");
    rememberDraft(ORG, QUERY, 0, { ...base, up: base.base, down: base.baseDown });
    expect(recall(ORG, QUERY)?.drafts).toEqual({});
  });

  it("brings the query back from the tab after the memory is gone", () => {
    window.sessionStorage.setItem(`schema-studio:compare-last:${ORG}`, QUERY);
    expect(hasMemory(ORG)).toBe(false);
    expect(recallQuery(ORG)).toBe(QUERY);
  });

  it("marks a visit back so it is not counted as a run", () => {
    markRestoring(ORG, QUERY);
    expect(isRestoring(ORG, QUERY)).toBe(true);
    expect(isRestoring(ORG, "run=1&sourceSchema=x")).toBe(false);
    rememberQuery(ORG, "run=1&sourceSchema=x");
    expect(isRestoring(ORG, QUERY)).toBe(false);
  });

  it("forgets everything on Start over", () => {
    rememberQuery(ORG, QUERY);
    rememberScreen(ORG, QUERY, screen);
    markRestoring(ORG, QUERY);
    forgetCompare(ORG);
    expect(hasMemory(ORG)).toBe(false);
    expect(recallQuery(ORG)).toBeNull();
    expect(recall(ORG, QUERY)).toBeNull();
    expect(isRestoring(ORG, QUERY)).toBe(false);
  });

  it("does not note an empty query", () => {
    rememberQuery(ORG, "");
    expect(hasMemory(ORG)).toBe(false);
  });
});

describe("scriptKey", () => {
  it("is the same for the same script and differs for another", () => {
    expect(scriptKey("CREATE TABLE t ();")).toBe(scriptKey("CREATE TABLE t ();"));
    expect(scriptKey("CREATE TABLE t ();")).not.toBe(scriptKey("CREATE TABLE u ();"));
    expect(scriptKey("")).toBe("0-45h");
  });
});
