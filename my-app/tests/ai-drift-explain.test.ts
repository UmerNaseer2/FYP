// Feature 3, Explain drift: the changes read from the baseline to live, the two
// scripts the app writes, what the prompt carries, the checks between the
// model's answer and the screen, and the one line in a drift alert.

jest.mock("../lib/version-db", () => ({
  __esModule: true,
  default: {},
  syncMetadataTables: async () => undefined,
}));

import { compareSchemas } from "@/lib/compare";
import {
  alertLine,
  buildDriftExplainTask,
  buildDriftOneLinerTask,
  buildDriftScripts,
  checkDriftExplain,
  checkDriftOneLiner,
  citedDriftChanges,
  commentLine,
  driftChanges,
  withAppManualNotes,
  type DriftExplainFacts,
} from "@/lib/ai/features/drift-explain";
import {
  driftExplainKey,
  isDriftExplainAnswer,
  isDriftScripts,
  type DriftExplainAnswer,
} from "@/lib/ai/features/drift-explain-view";
import { changeLabel } from "@/lib/ai/features/compare-summary";
import { knownNames } from "@/lib/ai/checks";
import { ALERT_LINE_TIMEOUT_MS, ALERT_LINE_WAIT_MS, driftAlertLine, SCHEDULED_ACTOR } from "@/lib/ai/drift-alert-line";
import type { AiConfig } from "@/lib/ai/config";
import { MockProvider } from "@/lib/ai/mock";
import type { AiProvider } from "@/lib/ai/provider";
import type { AiDeps } from "@/lib/ai/run";
import { AI_OFF } from "@/lib/ai/settings";
import { column, schema, table } from "./helpers/snapshots";

const id = () => column("id", { nullable: false, isPrimaryKey: true });
const text = (name: string) => column(name, { typeDisplay: "text" });

/** What the registry says public should look like. */
const baseline = schema(
  [
    table("authors", [id(), text("name")]),
    table("books", [id(), text("title"), column("price", { typeDisplay: "numeric" })]),
    table("old_notes", [id(), text("body")]),
  ],
  { database: "bookshop_prod_secret" }
);

/** What someone did to it by hand: price and old_notes gone, isbn and reviews new. */
const live = schema(
  [
    table("authors", [id(), text("name")]),
    table("books", [id(), text("title"), text("isbn")]),
    table("reviews", [id(), column("book_id")]),
  ],
  { database: "bookshop_prod_secret" }
);

/** The drift check's own comparison: baseline left, live right. */
const report = compareSchemas(baseline, live);
const whatChanged = driftChanges(report);
const scripts = buildDriftScripts(report, whatChanged, { schemaName: "public", expectedVersion: "1.2.0" });

function task() {
  return buildDriftExplainTask(report, whatChanged, { expectedVersion: "1.2.0", scripts })!;
}

function answer(over: Partial<DriftExplainAnswer> = {}): DriftExplainAnswer {
  return {
    headline: "Live lost `old_notes` and `books.price`, and gained `reviews` and `books.isbn`.",
    items: [
      { title: "New `reviews` table", changes: ["c1"], level: "breaking", why: "A new table nothing uses yet.", affects: [] },
      {
        title: "Lost `books.price`",
        changes: ["C4"],
        level: "safe",
        why: "Every price is gone.",
        affects: ["books", "ghost_view"],
      },
      { title: "Lost `old_notes`", changes: ["C2"], level: "breaking", why: "The notes are gone.", affects: [] },
    ],
    likelyCause: "Looks like a clean-up run by hand.",
    recommendation: { choice: "revert", why: "Dropping `books.price` lost data the app still reads." },
    manualNotes: [],
    ...over,
  };
}

describe("the changes, read from the baseline to live", () => {
  test("added means live has it, dropped means live lost it", () => {
    const { rows } = task().facts;
    expect(rows.get("C1")).toMatchObject({ category: "Table", object: "reviews", change: "added", severity: "safe" });
    expect(rows.get("C2")).toMatchObject({ category: "Table", object: "old_notes", change: "dropped", severity: "breaking" });
    expect(rows.get("C3")).toMatchObject({ category: "Column", table: "books", object: "isbn", change: "added" });
    expect(rows.get("C4")).toMatchObject({ category: "Column", table: "books", object: "price", change: "dropped", severity: "breaking" });
    expect(rows.get("C5")).toMatchObject({ change: "rename-suggested", severity: "info" });
  });

  test("the facts list every id, the breaking ones and no manual ones", () => {
    const { facts } = task();
    expect([...facts.listed]).toEqual(["C1", "C2", "C3", "C4", "C5"]);
    expect(facts.breakingIds).toEqual(["C2", "C4"]);
    expect(facts.manualIds).toEqual([]);
  });
});

describe("the two scripts the app writes", () => {
  const runnable = (sql: string) => sql.split("\n").filter((line) => line.trim() && !line.trim().startsWith("--"));

  test("revert puts back what live lost and holds back the drops", () => {
    const { revert } = scripts;
    expect(revert.sql).toContain("-- Revert drift: puts public back the way the registry's 1.2.0 says it should be.");
    expect(revert.sql).toContain("-- Run it on the drifted database.");
    expect(revert.sql).toContain('CREATE TABLE IF NOT EXISTS "old_notes"');
    expect(revert.sql).toContain('ALTER TABLE "books" ADD COLUMN IF NOT EXISTS "price" numeric;');
    expect(revert.sql).toContain('-- ALTER TABLE "books" DROP COLUMN IF EXISTS "isbn" CASCADE;');
    expect(runnable(revert.sql).some((line) => /\bDROP\b/i.test(line))).toBe(false);
    // The fifth statement is the note that says "isbn" may be "price" renamed.
    expect(revert).toMatchObject({ statements: 5, runs: 2, heldBack: 2, manual: 1 });
    expect(revert.rollbackSql).not.toBeNull();
    expect(revert.description).toBe("Revert drift on public: back to the registry's 1.2.0");
  });

  test("adopt writes the live changes for the registry, and says not to run it on live", () => {
    const { adopt } = scripts;
    expect(adopt.sql).toContain("-- Adopt drift: the changes made on the live public, written as the next version after the registry's 1.2.0.");
    expect(adopt.sql).toContain("-- Do not run this on the drifted database: it already has these changes.");
    expect(adopt.sql).toContain('CREATE TABLE IF NOT EXISTS "reviews"');
    expect(adopt.sql).toContain('"isbn"');
    expect(runnable(adopt.sql).some((line) => /\bDROP\b/i.test(line))).toBe(false);
    expect(adopt).toMatchObject({ statements: 5, runs: 2, heldBack: 2, manual: 1 });
    expect(adopt.description).toBe("Adopt drift on public into the registry");
  });

  test("a schema with no registry version is back to its baseline", () => {
    const plain = buildDriftScripts(report, whatChanged, { schemaName: "public", expectedVersion: null });
    expect(plain.revert.description).toBe("Revert drift on public: back to its baseline");
    expect(plain.revert.sql).toContain("the way its baseline says");
  });

  test("a name cannot end the header comment and start a statement", () => {
    expect(commentLine("a\nDROP TABLE x;\u2028b\r\u2029c\u0007\u200b")).toBe("-- a DROP TABLE x; b c");
    const sly = buildDriftScripts(report, whatChanged, { schemaName: "pub\nDROP TABLE books;", expectedVersion: "1\u2028x" });
    for (const script of [sly.revert, sly.adopt]) {
      expect(script.sql.split("\n").some((line) => line.startsWith("DROP"))).toBe(false);
      expect(script.sql).not.toMatch(/[\u2028\u2029]/);
    }
  });

  test("both scripts have the shape the screen checks for", () => {
    expect(isDriftScripts(scripts)).toBe(true);
    expect(isDriftScripts({ revert: scripts.revert })).toBe(false);
  });
});

describe("the question", () => {
  test("carries the drift, the totals, both ways out and the lost tables", () => {
    const { spec } = task();
    expect(spec.feature).toBe("drift-explain");
    expect(spec.tier).toBe("smart");
    const prompt = spec.prompt;
    expect(prompt).toContain("THE DRIFT");
    expect(prompt).toContain("The live schema no longer matches the registry's 1.2.0.");
    expect(prompt).toContain("5 changes on live: 2 added, 2 dropped");
    expect(prompt).toContain("2 breaking. 0 need a person.");
    expect(prompt).toContain("Revert: 2 statements put live back to the baseline; 2 drops held back");
    expect(prompt).toContain("Adopt: 2 statements write the live changes");
    expect(prompt).toContain("C2 [breaking] Table old_notes dropped: ");
    expect(prompt).toContain("C4 [breaking] Column books.price dropped: ");
    expect(prompt).toContain("WHAT USES THE OBJECTS THAT CHANGED");
    expect(prompt).toContain("LIVE SCHEMA NOW");
    expect(prompt).toContain("BASELINE TABLES LIVE NO LONGER HAS");
    expect(prompt).toContain("TABLE old_notes");
  });

  test("never carries the database name, and says its baseline when there is no version", () => {
    expect(task().spec.prompt).not.toContain("bookshop_prod_secret");
    const plain = buildDriftExplainTask(report, whatChanged, { expectedVersion: null, scripts })!;
    expect(plain.spec.prompt).toContain("The live schema no longer matches its baseline.");
  });

  test("two schemas that match ask nothing", () => {
    const same = compareSchemas(baseline, baseline);
    expect(buildDriftExplainTask(same, driftChanges(same), { expectedVersion: "1.2.0", scripts })).toBeNull();
  });

  test("the same drift asks the same question, so a saved answer can be reused", () => {
    expect(task().spec.cacheInput).toEqual({ prompt: task().spec.prompt });
  });
});

describe("the checks on the answer", () => {
  test("a good answer passes, with each level locked to the engine's grade", () => {
    const { value, problems, report: fixed } = checkDriftExplain(answer(), task().facts);
    expect(problems).toEqual([]);
    expect(value.items.map((i) => [i.changes, i.level])).toEqual([
      [["C4"], "breaking"],
      [["C2"], "breaking"],
      [["C1"], "safe"],
    ]);
    expect(fixed.levelFixed).toBe(2);
    expect(isDriftExplainAnswer(value)).toBe(true);
  });

  test("an object the answer says uses a change must exist", () => {
    const { value, report: fixed } = checkDriftExplain(answer(), task().facts);
    expect(value.items.find((i) => i.changes[0] === "C4")!.affects).toEqual(["books"]);
    expect(fixed.droppedNames).toBe(1);
  });

  test("an item that cites an unknown change or names a missing table is dropped", () => {
    const base = answer();
    const { value, problems, report: fixed } = checkDriftExplain(
      answer({
        items: [
          ...base.items,
          { title: "Something else", changes: ["C9"], level: "info", why: "Made up.", affects: [] },
          { title: "Lost `ghost`", changes: ["C2"], level: "breaking", why: "Gone.", affects: [] },
        ],
      }),
      task().facts
    );
    expect(value.items).toHaveLength(3);
    expect(fixed.droppedItems).toBe(2);
    expect(problems).toEqual([]);
  });

  test("an answer that is mostly made up is sent back", () => {
    const { problems } = checkDriftExplain(
      answer({ items: [{ title: "x", changes: ["C42"], level: "info", why: "Made up.", affects: [] }] }),
      task().facts
    );
    expect(problems.some((p) => p.startsWith("Too many items cite things that are not in the drift (C42 is not a listed change)"))).toBe(true);
    expect(problems.some((p) => p.includes("leave out every breaking change (C2, C4)"))).toBe(true);
  });

  test("an answer that leaves out the breaking changes is sent back", () => {
    const { problems } = checkDriftExplain(answer({ items: [answer().items[0]] }), task().facts);
    expect(problems).toEqual(["The items leave out every breaking change (C2, C4). Cover them."]);
  });

  test("names in the headline, the cause and the recommendation must exist", () => {
    const { problems } = checkDriftExplain(
      answer({
        headline: "Live lost `ghost`.",
        likelyCause: "Someone ran `phantom.sql` by hand.",
        recommendation: { choice: "adopt", why: "Keep `spooky`." },
      }),
      task().facts
    );
    expect(problems).toEqual([
      "The headline names things neither schema has: ghost.",
      "The likely cause names things neither schema has: phantom.sql.",
      "The recommendation names things neither schema has: spooky.",
    ]);
  });

  test("a likely cause never names a person", () => {
    const { value, problems } = checkDriftExplain(answer({ likelyCause: "Probably ada@example.com ran a fix." }), task().facts);
    expect(problems).toContain("The likely cause names a person. Guess at how it happened, never at who did it.");
    expect(value.likelyCause).toBe("");
  });

  test("a note is kept only for changes the engine marked as needing a person", () => {
    const note = { changes: ["c2"], note: "Copy the notes back from a backup." };
    const plain = checkDriftExplain(answer({ manualNotes: [note] }), task().facts);
    expect(plain.value.manualNotes).toEqual([]);
    expect(plain.report.droppedNotes).toBe(1);

    const facts: DriftExplainFacts = { ...task().facts, manualIds: ["C2"] };
    const marked = checkDriftExplain(answer({ manualNotes: [note] }), facts);
    expect(marked.value.manualNotes).toEqual([{ changes: ["C2"], note: "Copy the notes back from a backup." }]);
  });
});

describe("the app's own notes", () => {
  const facts: DriftExplainFacts = { ...task().facts, manualIds: ["C2", "C4"] };

  test("each change that needs a person and has no note gets one from the app", () => {
    const notes = withAppManualNotes(answer(), facts).manualNotes;
    expect(notes.map((n) => [n.changes, n.fromApp])).toEqual([
      [["C2"], true],
      [["C4"], true],
    ]);
    expect(notes[0].note.startsWith("The app could not write SQL for this one: ")).toBe(true);
  });

  test("a change the AI already wrote a note for gets no second one", () => {
    const own = { changes: ["C2"], note: "Copy the notes back." };
    const notes = withAppManualNotes(answer({ manualNotes: [own] }), facts).manualNotes;
    expect(notes).toEqual([own, expect.objectContaining({ changes: ["C4"], fromApp: true })]);
  });

  test("when the room runs out, the rest share one note", () => {
    const own = Array.from({ length: 7 }, () => ({ changes: ["C1"], note: "x" }));
    const notes = withAppManualNotes(answer({ manualNotes: own }), facts).manualNotes;
    expect(notes).toHaveLength(8);
    expect(notes[7]).toMatchObject({ changes: ["C2", "C4"], fromApp: true });
    expect(notes[7].note).toContain("The app could not write SQL for these.");
  });

  test("nothing changes when no change needs a person", () => {
    const a = answer();
    expect(withAppManualNotes(a, task().facts)).toBe(a);
  });
});

test("the screen gets what each cited id stands for, and nothing for an id it does not know", () => {
  const { facts } = task();
  const cited = citedDriftChanges(
    answer({ items: [{ title: "t", changes: ["C2", "C99"], level: "breaking", why: "w", affects: [] }] }),
    facts
  );
  expect(cited).toEqual({ C2: { label: changeLabel(facts.rows.get("C2")!), severity: "breaking" } });
  expect(cited.C2.label).toBe("Table old_notes dropped");
});

describe("the one line in a drift alert", () => {
  const known = knownNames(baseline, live);

  test("a fast, short question with no database name in it", () => {
    const t = buildDriftOneLinerTask(report)!;
    expect(t.spec.feature).toBe("drift-oneliner");
    expect(t.spec.tier).toBe("fast");
    expect(t.spec.prompt).toContain("C2 [breaking] Table old_notes dropped: ");
    expect(t.spec.prompt).not.toContain("bookshop_prod_secret");
    expect(buildDriftOneLinerTask(compareSchemas(live, live))).toBeNull();
  });

  test("a good line passes, with its spaces tidied", () => {
    expect(checkDriftOneLiner({ line: "  Live lost `old_notes`  and `books.price`. " }, known)).toEqual({
      value: { line: "Live lost `old_notes` and `books.price`." },
      problems: [],
    });
  });

  test("a line with a made-up name, a change id, too many words or an email is sent back", () => {
    expect(checkDriftOneLiner({ line: "Live lost `ghost`." }, known).problems).toEqual([
      "The line names things neither schema has: ghost. Put every table and column name in backticks.",
    ]);
    const problemsOf = (line: string) => checkDriftOneLiner({ line }, known).problems.join(" ");
    expect(problemsOf("`books` lost C2.")).toContain("change id");
    expect(problemsOf("`books` " + "word ".repeat(31))).toContain("longer than 30 words");
    expect(problemsOf("ada@example.com dropped `books`.")).toContain("names a person");
  });

  test("a name outside backticks is checked too, and a line with an unchecked name is sent back", () => {
    const problemsOf = (line: string) => checkDriftOneLiner({ line }, known).problems;
    // Names that look like names: an underscore, a dot, a capital inside.
    expect(problemsOf("Live lost `books.price` and customers_backup.")).toEqual([
      "The line names things neither schema has: customers_backup. Put every table and column name in backticks.",
    ]);
    expect(problemsOf("Live lost `old_notes` and the orders.total column.").join(" ")).toContain("orders.total");
    expect(problemsOf("Live lost `old_notes` and gained orderItems.").join(" ")).toContain("orderItems");
    // Plain words standing next to "table" or "column".
    expect(problemsOf("Live lost `books.price` and the customers table.").join(" ")).toContain("customers");
    expect(problemsOf("Live lost `books.price` and the table customers.").join(" ")).toContain("customers");
    expect(problemsOf("Live lost `books.price` and the billing table.").join(" ")).toContain("billing");
    // Backticks around something that is no name cannot be checked.
    expect(problemsOf("Live lost `the ghost table`.").join(" ")).toContain("Only put table and column names in backticks");
    // A line with no backticks at all ignored the rule, so nothing in it was checked.
    expect(problemsOf("Someone tidied up the database.").join(" ")).toContain("names no table or column in backticks");
    // A backtick with no partner leaves the rest bare, as the alert shows it.
    expect(problemsOf("Live lost `books.price` and `customers_backup").join(" ")).toContain("customers_backup");

    // Names that exist pass, in backticks or not, and so do ordinary words.
    expect(problemsOf("Live lost the `old_notes` table and the books.price column.")).toEqual([]);
    expect(problemsOf("Live has a new `reviews` table and lost the old_notes table.")).toEqual([]);
    expect(problemsOf("Live dropped 2 columns and the unique index on `books`, and the column type changed.")).toEqual([]);
    expect(problemsOf("Live lost `public.old_notes` with its 2 columns in version 1.5 of `books`.")).toEqual([]);
  });

  test("the alert shows it plain, on one line, and never too long", () => {
    expect(alertLine("Live lost `old_notes`\u0007 and\u2028`books.price`.\u200b")).toBe("Live lost old_notes and books.price.");
    const long = alertLine("word ".repeat(100))!;
    expect(long.length).toBeLessThanOrEqual(160);
    expect(long.endsWith("...")).toBe(true);
    expect(alertLine(" `` \n ")).toBeNull();
  });

  test("the alert line is cut in whole characters, never half an emoji", () => {
    // An emoji is two UTF-16 units. Placed across the cut, a cut by units
    // would keep only its first half, which jsonb refuses.
    const line = alertLine(`${"a".repeat(156)}\u{1F600}${"b".repeat(20)}`)!;
    expect(/\p{Cs}/u.test(line)).toBe(false);
    expect(Array.from(line)).toHaveLength(160);
    expect(line).toBe(`${"a".repeat(156)}\u{1F600}...`);
    // Half a pair standing alone in the answer goes.
    expect(alertLine("Live lost \ud83d `books.price`.")).toBe("Live lost books.price.");
    // A short line with an emoji is kept whole.
    expect(alertLine("Live lost `books.price` \u{1F600}")).toBe("Live lost books.price \u{1F600}");
  });
});

describe("asking for the alert line", () => {
  const config = {
    provider: "openai-compatible",
    baseUrl: "https://example.test/v1",
    apiKey: "k",
    models: { fast: "fast-model", smart: "smart-model" },
  } as unknown as AiConfig;

  function deps(provider: AiProvider, enabled = true): AiDeps {
    return {
      config,
      provider,
      readSettings: async () => ({ ...AI_OFF, enabled, features: { ...AI_OFF.features } }),
      store: {
        recordAiCall: async () => 1,
        callsToday: async () => 0,
        callsLastMinute: async () => 0,
        readSavedAnswer: (async () => null) as AiDeps["store"]["readSavedAnswer"],
        saveAnswer: async () => undefined,
      },
      now: () => 0,
    };
  }

  afterEach(() => jest.useRealTimers());

  test("comes back as the alert shows it, from the fast model", async () => {
    const provider = new MockProvider([{ line: "Live lost `old_notes` and `books.price`." }]);
    expect(await driftAlertLine(7, report, deps(provider))).toBe("Live lost old_notes and books.price.");
    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0].model).toBe("fast-model");
    expect(JSON.stringify(provider.requests[0])).not.toContain("bookshop_prod_secret");
    expect(provider.requests[0].timeoutMs).toBe(4_000);
  });

  test("is no line when AI is off for the organization, and nothing is asked", async () => {
    const provider = new MockProvider([]);
    expect(await driftAlertLine(7, report, deps(provider, false))).toBeNull();
    expect(provider.requests).toHaveLength(0);
  });

  test("is no line when the answer keeps failing its checks", async () => {
    const provider = new MockProvider([{ line: "C2 went." }, { line: "C2 went." }, { line: "C2 went." }, { line: "C2 went." }]);
    expect(await driftAlertLine(7, report, deps(provider))).toBeNull();
  });

  test("is no line for two schemas that match, and nothing is asked", async () => {
    const provider = new MockProvider([]);
    expect(await driftAlertLine(7, compareSchemas(live, live), deps(provider))).toBeNull();
    expect(provider.requests).toHaveLength(0);
  });

  test("a service that never answers does not hold up the check", async () => {
    jest.useFakeTimers();
    const silent: AiProvider = { generate: () => new Promise(() => undefined) };
    const pending = driftAlertLine(7, report, deps(silent));
    await jest.advanceTimersByTimeAsync(ALERT_LINE_WAIT_MS + 1);
    expect(await pending).toBeNull();
  });

  test("waits the plan's hard 4 seconds, retry included", () => {
    expect(ALERT_LINE_WAIT_MS).toBe(4_000);
    expect(ALERT_LINE_TIMEOUT_MS).toBeLessThanOrEqual(ALERT_LINE_WAIT_MS);
  });

  test("the call log says a scheduled check asked, not a person", () => {
    expect(SCHEDULED_ACTOR).toBe("scheduled drift check");
  });
});

describe("when the drift panel clears its answer", () => {
  test("a re-check that finds other drift with the same counts is a new key", () => {
    // Live added books.isbn, then someone swapped it for books.discount:
    // still one table changed, so the summary is the same words.
    const withIsbn = compareSchemas(baseline, live);
    const otherLive = schema(
      [
        table("authors", [id(), text("name")]),
        table("books", [id(), text("title"), text("discount")]),
        table("reviews", [id(), column("book_id")]),
      ],
      { database: "bookshop_prod_secret" }
    );
    const withDiscount = compareSchemas(baseline, otherLive);
    expect(driftExplainKey(4, withIsbn, 11)).not.toBe(driftExplainKey(4, withDiscount, 11));
    // The same drift is the same key, and so the answer stays.
    expect(driftExplainKey(4, withIsbn, 11)).toBe(driftExplainKey(4, compareSchemas(baseline, live), 11));
    // Another schema or another baseline is a new key too.
    expect(driftExplainKey(4, withIsbn, 11)).not.toBe(driftExplainKey(5, withIsbn, 11));
    expect(driftExplainKey(4, withIsbn, 11)).not.toBe(driftExplainKey(4, withIsbn, 12));
  });
});
