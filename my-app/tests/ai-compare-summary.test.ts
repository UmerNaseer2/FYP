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
  compareSummarySchema,
  MAX_LISTED_CHANGES,
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

  test("shows the new tables", () => {
    const prompt = task().spec.prompt;
    expect(prompt).toContain("NEW TABLES FROM THE SOURCE");
    expect(prompt).toContain("TABLE reviews");
    expect(prompt).not.toContain("WHAT USES");
  });

  test("asks for added, dropped and changed, and no order to apply them in", () => {
    const system = task().spec.system;
    expect(system).toMatch(/added/);
    expect(system).toMatch(/dropped/);
    expect(system).not.toMatch(/order to apply|safe order/i);
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

describe("the prompt after the review fixes", () => {
  // U43: more breaking changes than the list holds. The note under the list
  // used to call every cut change safe or info.
  test("says how many of the changes it leaves out are breaking", () => {
    const extra = Array.from({ length: MAX_LISTED_CHANGES + 30 }, (_, i) =>
      table(`old_${String(i).padStart(3, "0")}`, [id()], { primaryKey: pk(`old_${i}_pkey`) })
    );
    const built = buildCompareSummaryTask(compareSchemas(schema([]), schema(extra)), { allowDataLoss: false });
    if (!built) throw new Error("expected changes");
    const breaking = [...built.facts.rows.values()].filter((row) => row.severity === "breaking").length;
    expect(breaking).toBeGreaterThan(MAX_LISTED_CHANGES);
    const cut = built.facts.rows.size - MAX_LISTED_CHANGES;
    expect(built.spec.prompt).toContain(
      `(${cut} more changes are not listed, ${breaking - MAX_LISTED_CHANGES} of them breaking.)`
    );
    expect(built.spec.prompt).not.toContain("more safe or info changes");
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
  /** A good answer: every change of the bookshop covered once, in its list. */
  function answer(t: CompareSummaryTask): CompareSummaryAnswer {
    const ids = [...t.facts.rows.keys()];
    const others = ids.filter((id) => id !== priceDropped(t) && id !== isbnAdded(t));
    const added = others.filter((id) => t.facts.rows.get(id)!.change === "added");
    const rest = others.filter((id) => !added.includes(id));
    return {
      headline: "Drops `books.price` and adds `books.isbn` and `reviews`.",
      added: [
        { text: "Column `books.isbn`", changes: [isbnAdded(t)] },
        ...(added.length > 0 ? [{ text: "New table `reviews`", changes: added }] : []),
      ],
      dropped: [{ text: "Column `books.price` goes, with its values", changes: [priceDropped(t)] }],
      changed: rest.length > 0 ? [{ text: "Other bits", changes: rest }] : [],
    };
  }

  test("a good answer passes, with the breaking line marked by the app", () => {
    const t = task();
    const result = checkCompareSummary(answer(t), t.facts);
    expect(result.problems).toEqual([]);
    expect(result.report).toEqual({ droppedItems: 0, moved: 0, leftOut: 0 });
    expect(result.value.dropped).toEqual([
      { text: "Column `books.price` goes, with its values", changes: [priceDropped(t)], breaking: true },
    ]);
    expect(result.value.added[0].breaking).toBeUndefined();
  });

  test("the app files each line by the changes it cites, not where the model put it", () => {
    const t = task();
    const wrong = answer(t);
    wrong.added.push(wrong.dropped.pop()!);
    const result = checkCompareSummary(wrong, t.facts);
    expect(result.value.dropped.map((line) => line.changes)).toEqual([[priceDropped(t)]]);
    expect(result.value.added.some((line) => line.changes.includes(priceDropped(t)))).toBe(false);
    expect(result.report.moved).toBe(1);
  });

  test("ids are read loosely, but an id that is not listed drops its line", () => {
    const t = task();
    const loose = answer(t);
    loose.dropped = [
      { text: "Price goes", changes: [` ${priceDropped(t).toLowerCase()} `, priceDropped(t)] },
      { text: "Something else", changes: ["C999"] },
    ];
    const result = checkCompareSummary(loose, t.facts);
    expect(result.value.dropped).toHaveLength(1);
    expect(result.value.dropped[0].changes).toEqual([priceDropped(t)]);
    expect(result.report.droppedItems).toBe(1);
  });

  test("a line naming a table neither schema has is dropped", () => {
    const t = task();
    const made = answer(t);
    made.added.push({ text: "New table `invoices`", changes: [isbnAdded(t)] });
    const result = checkCompareSummary(made, t.facts);
    expect(result.value.added.some((line) => line.text.includes("invoices"))).toBe(false);
    expect(result.report.droppedItems).toBe(1);
  });

  test("leaving out every breaking change sends the answer back", () => {
    const t = task();
    const result = checkCompareSummary({ ...answer(t), dropped: [] }, t.facts);
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toContain(priceDropped(t));
  });

  test("a made-up name in the headline sends the answer back", () => {
    const t = task();
    const result = checkCompareSummary({ ...answer(t), headline: "Rewrites `invoices`." }, t.facts);
    expect(result.problems[0]).toMatch(/headline.*invoices/);
  });

  test("mostly made-up lines send the answer back", () => {
    const t = task();
    const result = checkCompareSummary(
      {
        headline: "x",
        added: [{ text: "x", changes: ["C900"] }],
        dropped: [{ text: "Price goes", changes: [priceDropped(t)] }],
        changed: [{ text: "x", changes: ["C901"] }],
      },
      t.facts
    );
    expect(result.problems.some((p) => p.includes("Too many lines"))).toBe(true);
  });

  test("citedChanges says what each id stands for", () => {
    const t = task();
    const cited = citedChanges(checkCompareSummary(answer(t), t.facts).value, t.facts);
    expect(cited[priceDropped(t)]).toEqual({ label: "Column books.price dropped", severity: "breaking" });
    expect(cited[isbnAdded(t)].label).toBe("Column books.isbn added");
    expect(Object.keys(cited).sort()).toEqual([...t.facts.rows.keys()].sort());
  });
});

describe("changes the answer leaves out", () => {
  // The shop: the migration drops legacy_notes, changes the type of
  // orders.status and narrows products.name.
  const shopTarget = schema([
    table("legacy_notes", [id(), column("note", { typeDisplay: "text" })], { primaryKey: pk("legacy_notes_pkey") }),
    table("orders", [id(), column("status", { typeDisplay: "text" })], { primaryKey: pk("orders_pkey") }),
    table("products", [id(), column("name", { typeDisplay: "character varying(80)" })], { primaryKey: pk("products_pkey") }),
  ]);
  const shopSource = schema([
    table("orders", [id(), column("status", { typeDisplay: "integer" })], { primaryKey: pk("orders_pkey") }),
    table("products", [id(), column("name", { typeDisplay: "character varying(20)" })], { primaryKey: pk("products_pkey") }),
  ]);

  function shopTask(): CompareSummaryTask {
    const built = buildCompareSummaryTask(compareSchemas(shopSource, shopTarget), { allowDataLoss: false });
    if (!built) throw new Error("expected changes");
    return built;
  }
  const notesDropped = (t: CompareSummaryTask) => idOf(t, (label) => /Table legacy_notes dropped/.test(label));
  const statusChanged = (t: CompareSummaryTask) => idOf(t, (label) => /orders\.status changed/.test(label));

  /** A fake model answer that covers only the dropped table. */
  function notesOnly(t: CompareSummaryTask): CompareSummaryAnswer {
    return {
      headline: "Drops `legacy_notes`.",
      added: [],
      dropped: [{ text: "Table `legacy_notes`, with its rows", changes: [notesDropped(t)] }],
      changed: [],
    };
  }

  test("are added by the app as one short line in their list", () => {
    const t = shopTask();
    const result = checkCompareSummary(notesOnly(t), t.facts);
    expect(result.problems).toEqual([]);
    const also = result.value.changed[result.value.changed.length - 1];
    expect(also.text).toMatch(/^Also: /);
    expect(also.text).toContain("`orders.status`");
    expect(also.changes).toContain(statusChanged(t));
    expect(also.breaking).toBe(true);
    // Every change is now cited once, and the screen can label each.
    const cited = [...result.value.added, ...result.value.dropped, ...result.value.changed].flatMap((l) => l.changes);
    expect([...cited].sort()).toEqual([...t.facts.rows.keys()].sort());
    // The answer still fits the shape a saved answer is read back with.
    expect(compareSummarySchema.safeParse(result.value).success).toBe(true);
  });

  test("a full answer gets nothing added", () => {
    const t = shopTask();
    const all = notesOnly(t);
    const rest = [...t.facts.rows.entries()].filter(([id]) => id !== notesDropped(t));
    all.changed = [{ text: "Column types change", changes: rest.map(([id]) => id) }];
    // Some of the rest may be drops (the table's own index, say).
    const result = checkCompareSummary(all, t.facts);
    expect(result.report.leftOut).toBe(0);
    expect(result.value.changed.every((line) => !line.text.startsWith("Also"))).toBe(true);
  });

  test("many left out: the first 8 are named and the rest counted", () => {
    const extra = Array.from({ length: 30 }, (_, i) =>
      table(`old_${String(i).padStart(2, "0")}`, [id()], { primaryKey: pk(`old_${i}_pkey`) })
    );
    const built = buildCompareSummaryTask(compareSchemas(schema([]), schema(extra)), { allowDataLoss: false });
    if (!built) throw new Error("expected changes");
    const first = built.facts.breakingIds[0];
    const result = checkCompareSummary(
      { headline: "Drops old tables.", added: [], dropped: [{ text: "One old table goes", changes: [first] }], changed: [] },
      built.facts
    );
    const also = result.value.dropped[1];
    const leftOut = built.facts.rows.size - 1;
    expect(also.changes).toHaveLength(leftOut);
    expect(also.text).toContain(`and ${leftOut - 8} more`);
    expect(compareSummarySchema.safeParse(result.value).success).toBe(true);
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

  test("an answer that skips the breaking change is asked again, and the second is filed by the engine", async () => {
    const t = task();
    const first = { headline: "Adds `books.isbn`.", added: [{ text: "Column `books.isbn`", changes: [isbnAdded(t)] }], dropped: [], changed: [] };
    const second = {
      headline: "Drops `books.price`.",
      added: [{ text: "Price goes", changes: [priceDropped(t)] }],
      dropped: [],
      changed: [],
    };
    const provider = new MockProvider([first, second]);
    const result = await runAiTask({ orgId: 1, email: "ada@example.com" }, t.spec, deps(provider));
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(provider.requests).toHaveLength(2);
    expect(JSON.stringify(provider.requests[1])).toContain(priceDropped(t));
    expect(result.value.dropped[0]).toMatchObject({ changes: [priceDropped(t)], breaking: true });
    expect(provider.requests[0].model).toBe("fast-model");
  });
});
