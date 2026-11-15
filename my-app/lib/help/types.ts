// The shape of one page's help. See lib/help/index.ts for the rule on what
// belongs in help and what stays on the page.

/** A word the page uses, and what it means in plain words. */
export type HelpTerm = { term: string; meaning: string };

/** Something that commonly goes wrong on the page, and what to do about it. */
export type HelpProblem = { problem: string; fix: string };

/** An extra part of the help, such as one tab of a page with tabs. */
export type HelpSection = { title: string; body: string[] };

/**
 * One step. Plain words, or words plus `target`: a CSS selector for the
 * control the step is about, which gives the step a "Show me" link in the
 * Help panel. Write targets with anchor() from ./steps.
 */
export type HelpStep = string | { text: string; target: string };

export type HelpTopic = {
  /** The page's name, as the menu shows it. The page header's big title is this. */
  title: string;
  /** The page's tagline, shown under the title: 15 words or fewer. */
  blurb: string;
  /** What the page is for, in two or three sentences. */
  purpose: string;
  /** How to use the page, one step per entry, in order. */
  steps: HelpStep[];
  /** What the page's words mean. */
  terms: HelpTerm[];
  /** Common problems and their fixes. */
  problems: HelpProblem[];
  /** Extra parts, such as one per tab. Optional. */
  sections?: HelpSection[];
};
