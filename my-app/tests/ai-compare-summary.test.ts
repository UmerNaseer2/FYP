// Feature 1, the Compare change summary: what the prompt carries, and the code
// checks that stand between the model's answer and the screen.

jest.mock("../lib/version-db", () => ({
  __esModule: true,
  default: {},
  syncMetadataTables: async () => undefined,
}));

import { compareSchemas } from "@/lib/compare";
import {
  buildCompareSummaryTask,
  changeLabel,
  checkCompareSummary,
  citedChanges,
  unknownTickedNames,
  type CompareSummaryTask,
} from "@/lib/ai/features/compare-summary";
import type { CompareSummaryAnswer } from "@/lib/ai/features/compare-summary-view";
import type { AiConfig } from "@/lib/ai/config";
import { MockProvider } from "@/lib/ai/mock";
import { runAiTask, type AiDeps } from "@/lib/ai/run";
import { AI_OFF } from "@/lib/ai/settings";
import type { ConstraintSnapshot, ForeignKeySnapshot } from "@/lib/postgres";
import { column, schema, table } from "./helpers/snapshots";

function pk(name: string): ConstraintSnapshot {
  return { name, kind: "PRIMARY KEY", columns: ["id"], definition: "PRIMARY KEY (id)", normalizedDefinition: "PRIMARY KEY (id)" };
}

function fk(name: string, col: string, referencedTable: string): ForeignKeySnapshot {
  const definition = `FOREIGN KEY (${col}) REFERENCES ${referencedTable}(id)`;
  return {
    name,
    kind: "FOREIGN KEY",
    columns: [col],
    definition,
    normalizedDefinition: definition,
    referencedSchema: "public",
    referencedTable,
    referencedColumns: ["id"],
    onUpdate: "NO ACTION",
    onDelete: "NO ACTION",
  } as ForeignKeySnapshot;
}

const id = () => column("id", { nullable: false, isPrimaryKey: true });
const authors = table("authors", [id(), column("name", { typeDisplay: "text", nullable: false })], {
  primaryKey: pk("authors_pkey"),
});
const orderItems = table("order_items", [id(), column("book_id")], {
  primaryKey: pk("order_items_pkey"),
  foreignKeys: [fk("order_items_book_id_fkey", "book_id", "books")],
});

// The target: books still has price.
const target = schema(
  [
    authors,
    table(
      "books",
      [id(), column("title", { typeDisplay: "text", nullable: false }), column("author_id"), column("price", { typeDisplay: "numeric(10,2)" })],
      { primaryKey: pk("books_pkey"), foreignKeys: [fk("books_author_id_fkey", "author_id", "authors")] }
    ),
    orderItems,
  ],
  { database: "secret_shop_target" }
);

// The source: price is gone, isbn is new, and so is reviews.
const source = schema(
  [
    authors,
    table(
      "books",
      [id(), column("title", { typeDisplay: "text", nullable: false }), column("author_id"), column("isbn", { typeDisplay: "text" })],
      { primaryKey: pk("books_pkey"), foreignKeys: [fk("books_author_id_fkey", "author_id", "authors")] }
    ),
    orderItems,
    table("reviews", [id(), column("book_id"), column("stars")], {
      primaryKey: pk("reviews_pkey"),
      foreignKeys: [fk("reviews_book_id_fkey", "book_id", "books")],
    }),
  ],
  { database: "secret_shop_source" }
);

function task(allowDataLoss = false): CompareSummaryTask {
  const built = buildCompareSummaryTask(compareSchemas(source, target), { allowDataLoss });
  if (!built) throw new Error("expected changes");
  return built;
}

/** The id of the first change row matching. */
function idOf(t: CompareSummaryTask, match: (label: string) => boolean): string {
  const found = [...t.facts.rows.entries()].find(([, row]) => match(changeLabel(row)));
  if (!found) throw new Error(`no row matches; rows: ${[...t.facts.rows.values()].map(changeLabel).join(" | ")}`);
  return found[0];
}

const priceDropped = (t: CompareSummaryTask) => idOf(t, (label) => /books\.price dropped/.test(label));
const isbnAdded = (t: CompareSummaryTask) => idOf(t, (label) => /books\.isbn added/.test(label));

describe("the prompt", () => {
  test("two matching schemas ask nothing", () => {
    expect(buildCompareSummaryTask(compareSchemas(target, target), { allowDataLoss: false })).toBeNull();
  });

  test("lists every change with its id and the engine's grade", () => {
    const t = task();
    const price = priceDropped(t);
    expect(t.facts.breakingIds).toContain(price);
    expect(t.spec.prompt).toMatch(new RegExp(`^${price} \\[breaking\\] Column books\\.price dropped`, "m"));
    expect(t.spec.prompt).toContain(`${isbnAdded(t)} [`);
    expect(t.spec.prompt).toContain("ENGINE TOTALS");
    expect(t.inputTokens).toBeGreaterThan(0);
  });

  test("says who uses what changes, and shows the new tables", () => {
    const prompt = task().spec.prompt;
    expect(prompt).toMatch(/order_items/);
    expect(prompt).toContain("NEW TABLES FROM THE SOURCE");
    expect(prompt).toContain("TABLE reviews");
  });

  test("carries the data loss switch", () => {
    expect(task(false).spec.prompt).toContain("commented out");
    expect(task(true).spec.prompt).toContain("will run");
  });

  test("never carries a database name", () => {
    const t = task();
    expect(t.spec.prompt).not.toContain("secret_shop");
    expect(t.spec.system).not.toContain("secret_shop");
  });

  test("the same diff asks the same question, so the saved answer is reused", () => {
    expect(task().spec.cacheInput).toEqual(task().spec.cacheInput);
  });
});

describe("unknownTickedNames", () => {
  const known = task().facts.known;
  test.each([
    ["Drops `books.price` from `books`.", []],
    ["Sets `NOT NULL` on a `text` column, see `C2`.", []],
    ["Breaks `invoices` and `books.cost`.", ["invoices", "books.cost"]],
    ["No backticks, so `nothing` else", ["nothing"]],
    ["A phrase `like this one` is not a name.", []],
  ])("%s", (text, expected) => {
    expect(unknownTickedNames(text, known)).toEqual(expected);
  });
});

describe("checkCompareSummary", () => {
  function answer(t: CompareSummaryTask, over: Partial<CompareSummaryAnswer> = {}): CompareSummaryAnswer {
    return {
      headline: "Drops `books.price` and adds `books.isbn` and `reviews`.",
      risks: [
        {
          title: "Dropping `books.price` loses every price",
          changes: [priceDropped(t)],
          level: "breaking",
          why: "The column and its values are deleted.",
          affects: ["order_items"],
        },
      ],
      order: [{ step: "Add `books.isbn` first, then drop `books.price` after a backup.", changes: [isbnAdded(t), priceDropped(t)] }],
      ...over,
    };
  }

  test("a good answer passes untouched", () => {
    const t = task();
    const result = checkCompareSummary(answer(t), t.facts);
    expect(result.problems).toEqual([]);
    expect(result.value).toEqual(answer(t));
    expect(result.report).toEqual({ droppedItems: 0, droppedNames: 0, levelFixed: 0 });
  });

  test("the level is always the engine's", () => {
    const t = task();
    const soft = answer(t);
    soft.risks[0].level = "info";
    const result = checkCompareSummary(soft, t.facts);
    expect(result.value.risks[0].level).toBe("breaking");
    expect(result.report.levelFixed).toBe(1);
    expect(result.problems).toEqual([]);

    const loud = answer(t, {
      risks: [{ title: "New column", changes: [isbnAdded(t)], level: "breaking", why: "Nothing breaks.", affects: [] }],
    });
    const checked = checkCompareSummary(loud, t.facts);
    expect(checked.value.risks[0].level).not.toBe("breaking");
  });

  test("ids are read loosely, but an id that is not listed drops its item", () => {
    const t = task();
    const result = checkCompareSummary(
      answer(t, {
        risks: [
          { ...answer(t).risks[0], changes: [` ${priceDropped(t).toLowerCase()} `, priceDropped(t)] },
          { title: "Something else", changes: ["C999"], level: "breaking", why: "Made up.", affects: [] },
        ],
      }),
      t.facts
    );
    expect(result.value.risks).toHaveLength(1);
    expect(result.value.risks[0].changes).toEqual([priceDropped(t)]);
    expect(result.report.droppedItems).toBe(1);
  });

  test("an item naming a table neither schema has is dropped; a made-up user is struck out", () => {
    const t = task();
    const result = checkCompareSummary(
      answer(t, {
        risks: [
          { ...answer(t).risks[0], affects: ["order_items", "invoices", " order_items "] },
          { title: "Breaks `invoices`", changes: [isbnAdded(t)], level: "safe", why: "It does not.", affects: [] },
        ],
      }),
      t.facts
    );
    expect(result.value.risks).toHaveLength(1);
    expect(result.value.risks[0].affects).toEqual(["order_items"]);
    expect(result.report).toMatchObject({ droppedItems: 1, droppedNames: 1 });
  });

  test("leaving out every breaking change sends the answer back", () => {
    const t = task();
    const result = checkCompareSummary(answer(t, { risks: [] }), t.facts);
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toContain(priceDropped(t));
  });

  test("a made-up name in the headline sends the answer back", () => {
    const t = task();
    const result = checkCompareSummary(answer(t, { headline: "Rewrites `invoices`." }), t.facts);
    expect(result.problems[0]).toMatch(/headline.*invoices/);
  });

  test("mostly made-up items send the answer back", () => {
    const t = task();
    const result = checkCompareSummary(
      answer(t, {
        risks: [answer(t).risks[0], { title: "x", changes: ["C900"], level: "safe", why: "x", affects: [] }],
        order: [{ step: "x", changes: ["C901"] }],
      }),
      t.facts
    );
    expect(result.problems.some((p) => p.includes("Too many items"))).toBe(true);
  });

  test("citedChanges says what each id stands for", () => {
    const t = task();
    const cited = citedChanges(answer(t), t.facts);
    expect(cited[priceDropped(t)]).toEqual({ label: "Column books.price dropped", severity: "breaking" });
    expect(cited[isbnAdded(t)].label).toBe("Column books.isbn added");
    expect(Object.keys(cited).sort()).toEqual([isbnAdded(t), priceDropped(t)].sort());
  });
});

describe("through runAiTask", () => {
  const config: AiConfig = {
    provider: "openai-compatible",
    baseUrl: "https://example.test/v1/",
    apiKey: "test-key",
    models: { fast: "fast-model", smart: "smart-model" },
    reasoningEffort: "low",
    timeoutMs: 90_000,
    dailyLimit: 300,
    perMinuteLimit: 10,
  };

  function deps(provider: MockProvider): AiDeps {
    return {
      config,
      provider,
      readSettings: async () => ({ ...AI_OFF, enabled: true, features: { ...AI_OFF.features } }),
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

  test("an answer that skips the breaking change is asked again, and the second one is graded by the engine", async () => {
    const t = task();
    const first = { headline: "Adds `books.isbn`.", risks: [], order: [{ step: "Add it.", changes: [isbnAdded(t)] }] };
    const second = {
      headline: "Drops `books.price`.",
      risks: [{ title: "Price goes", changes: [priceDropped(t)], level: "safe", why: "Values are lost.", affects: [] }],
      order: [{ step: "Back up, then drop.", changes: [priceDropped(t)] }],
    };
    const provider = new MockProvider([first, second]);
    const result = await runAiTask({ orgId: 1, email: "ada@example.com" }, t.spec, deps(provider));
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(provider.requests).toHaveLength(2);
    expect(JSON.stringify(provider.requests[1])).toContain(priceDropped(t));
    expect(result.value.risks[0].level).toBe("breaking");
    expect(provider.requests[0].model).toBe("fast-model");
  });
});
