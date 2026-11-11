/**
 * The help text (lib/help): one file per page, shown by the Help panel.
 *
 * The first test is the one that matters most. A page added to the menu with
 * no help entry would open the general help instead, and nobody would notice.
 * The rest keep each entry useful: a short blurb for the page header, real
 * steps, the page's words explained, and at least one common problem.
 */
import { NAV_ITEMS } from "@/components/studio/nav";
import { BLURB_MAX_WORDS, GENERAL_HELP, HELP_TOPICS, helpForPage, helpForPath } from "@/lib/help";

const ALL_TOPICS = [...Object.entries(HELP_TOPICS), ["general", GENERAL_HELP] as const];

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

describe("help topics", () => {
  test("every page in the menu has a help entry", () => {
    const missing = NAV_ITEMS.filter((item) => !HELP_TOPICS[item.href]).map((item) => item.href);
    expect(missing).toEqual([]);
  });

  test("a menu page's help carries the same name as the menu", () => {
    for (const item of NAV_ITEMS) {
      expect(HELP_TOPICS[item.href].title).toBe(item.label);
    }
  });

  test.each(ALL_TOPICS)("%s: the blurb fits the page header", (_page, topic) => {
    expect(wordCount(topic.blurb)).toBeGreaterThan(0);
    expect(wordCount(topic.blurb)).toBeLessThanOrEqual(BLURB_MAX_WORDS);
  });

  test.each(ALL_TOPICS)("%s: says what the page is for, the steps, the words and a problem", (_page, topic) => {
    expect(wordCount(topic.purpose)).toBeGreaterThanOrEqual(8);
    expect(topic.steps.length).toBeGreaterThanOrEqual(2);
    expect(topic.terms.length).toBeGreaterThanOrEqual(1);
    expect(topic.problems.length).toBeGreaterThanOrEqual(1);
    for (const entry of topic.terms) {
      expect(entry.term.trim()).not.toBe("");
      expect(entry.meaning.trim()).not.toBe("");
    }
    for (const entry of topic.problems) {
      expect(entry.problem.trim()).not.toBe("");
      expect(entry.fix.trim()).not.toBe("");
    }
  });

  test.each(ALL_TOPICS)("%s: nothing is said twice, and no long dashes", (_page, topic) => {
    // The panel uses each line as its React key, so a repeat would also warn.
    const lines = [
      ...topic.steps,
      ...topic.terms.map((entry) => entry.term),
      ...topic.problems.map((entry) => entry.problem),
      ...(topic.sections ?? []).map((section) => section.title),
      ...(topic.sections ?? []).flatMap((section) => section.body),
    ];
    expect(new Set(lines).size).toBe(lines.length);
    expect(JSON.stringify(topic)).not.toMatch(/[–—]/);
  });

  test("the help for a path sets the organization aside", () => {
    expect(helpForPath("/acme/deploy")).toBe(HELP_TOPICS["/deploy"]);
    expect(helpForPath("/deploy")).toBe(HELP_TOPICS["/deploy"]);
    expect(helpForPath("/acme/schemas/12")).toBe(HELP_TOPICS["/schemas"]);
  });

  test("a page with no help of its own gets the general help", () => {
    expect(helpForPath("/acme/phone")).toBe(GENERAL_HELP);
    expect(helpForPage("/nowhere")).toBe(GENERAL_HELP);
  });
});
