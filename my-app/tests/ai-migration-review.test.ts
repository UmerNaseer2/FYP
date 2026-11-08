// Feature 2, the migration review on the Deploy screen: the engine's reading
// of each statement, what the prompt carries, and the checks between the
// model's answer and the screen.

jest.mock("../lib/version-db", () => ({
  __esModule: true,
  default: {},
  syncMetadataTables: async () => undefined,
}));

import {
  buildMigrationReviewTask,
  checkMigrationReview,
  listReviewStatements,
  readStatement,
  reviewedStatements,
  statementNames,
  withAppFindings,
  type ModelReview,
  type ReviewScript,
} from "@/lib/ai/features/migration-review";
import { isMigrationReviewAnswer } from "@/lib/ai/features/migration-review-view";
import type { AiConfig } from "@/lib/ai/config";
import { MockProvider } from "@/lib/ai/mock";
import { runAiTask, type AiDeps } from "@/lib/ai/run";
import { AI_OFF } from "@/lib/ai/settings";
import { roughBytes, roughRows, type TableSize } from "@/lib/ai/table-sizes";
import { column, schema, table } from "./helpers/snapshots";

const id = () => column("id", { nullable: false, isPrimaryKey: true });
const target = schema(
  [
    table("books", [id(), column("title", { typeDisplay: "text" }), column("price", { typeDisplay: "numeric" })]),
    table("authors", [id(), column("name", { typeDisplay: "text" })]),
  ],
  { database: "bookshop_prod_secret" }
);

const scripts: ReviewScript[] = [
  {
    scriptName: "books",
    version: "2.0.0",
    sqlContent: [
      "-- price moves to its own table",
      "ALTER TABLE books DROP COLUMN price;",
      "ALTER TABLE books ADD COLUMN isbn text NOT NULL;",
      "CREATE TABLE prices (book_id integer REFERENCES books(id), amount numeric);",
    ].join("\n"),
  },
  { scriptName: "authors", version: "1.1.0", sqlContent: "ALTER TABLE authors ADD COLUMN bio text;" },
];

const sizes = new Map<string, TableSize>([
  ["books", { rows: 1_234_567, bytes: 3 * 1024 * 1024 * 1024 }],
  ["authors", { rows: 0, bytes: 8192 }],
]);

function task(list = listReviewStatements(scripts, target)!) {
  return buildMigrationReviewTask(list, { action: "deploy", snapshot: target, sizes, fingerprint: "abc" });
}

describe("the engine's reading of each statement", () => {
  test("statements are numbered across scripts in run order, comments are not statements", () => {
    const list = listReviewStatements(scripts, target)!;
    expect([...list.statements.keys()]).toEqual(["S1", "S2", "S3", "S4"]);
    expect(list.statements.get("S1")!.label).toBe("books v2.0.0, statement 1");
    expect(list.statements.get("S4")!.label).toBe("authors v1.1.0");
    expect(list.touched).toEqual(["books", "authors"]);
    expect(list.runNames.has("prices")).toBe(true);
  });

  test("a run with nothing that would run is not reviewed", () => {
    expect(listReviewStatements([{ scriptName: "x", version: "1", sqlContent: "-- nothing\n" }], target)).toBeNull();
  });

  test("dropping a column is high: it deletes rows and is breaking", () => {
    const r = readStatement("ALTER TABLE books DROP COLUMN price", false);
    expect(r.floor).toBe("high");
    expect(r.flags.some((f) => f.startsWith("deletes rows (DROP COLUMN"))).toBe(true);
    expect(r.flags.some((f) => f.startsWith("breaking"))).toBe(true);
  });

  test("a NOT NULL column with no default can fail on existing rows", () => {
    const r = readStatement("ALTER TABLE books ADD COLUMN isbn text NOT NULL", false);
    expect(r.flags).toContain("can fail on existing rows (NOT NULL column with no default)");
    expect(["medium", "high"]).toContain(r.floor);
  });

  test("CONCURRENTLY cannot run inside the run's transaction, so it is high", () => {
    const r = readStatement("CREATE INDEX CONCURRENTLY books_title_idx ON books (title)", false);
    expect(r.floor).toBe("high");
    expect(r.flags).toContain("cannot run inside the run's transaction (CONCURRENTLY)");
  });

  test("CONCURRENTLY in a comment is not a statement that cannot run", () => {
    const r = readStatement("-- later: CREATE INDEX CONCURRENTLY\nALTER TABLE authors ADD COLUMN bio text", false);
    expect(r.flags).toEqual([]);
    expect(r.floor).toBe("low");
  });

  test("an UPDATE with no WHERE changes every row, one with a WHERE is not flagged", () => {
    expect(readStatement("UPDATE orders SET status = 'open'", false)).toEqual({
      floor: "medium",
      flags: ["changes every row (UPDATE with no WHERE)"],
    });
    expect(readStatement("UPDATE orders SET status = 'open' WHERE status IS NULL", false).flags).toEqual([]);
    expect(readStatement("UPDATE orders SET note = 'no where here'", false).flags).toHaveLength(1);
  });

  test("a nullable new column is low with nothing flagged", () => {
    expect(readStatement("ALTER TABLE authors ADD COLUMN bio text", false)).toEqual({ floor: "low", flags: [] });
  });

  test("DROP INDEX straight before the CREATE that remakes it is not read as a breaking drop", () => {
    const list = listReviewStatements(
      [
        {
          scriptName: "books",
          version: "2.1.0",
          sqlContent: "DROP INDEX books_title_idx;\nCREATE INDEX books_title_idx ON books (lower(title));",
        },
      ],
      target
    )!;
    const drop = list.statements.get("S1")!;
    expect(drop.flags.some((f) => f.startsWith("breaking"))).toBe(false);
    expect(drop.flags).toContain("replaced by the next statement");
  });

  test("names inside a DO block count, names in strings and comments do not", () => {
    const names = statementNames(
      "DO $$ BEGIN ALTER TABLE public.books ADD CONSTRAINT books_isbn_key UNIQUE (isbn); END $$; -- authors\nSELECT 'prices'"
    );
    expect(names).toEqual(expect.arrayContaining(["books", "public.books", "books_isbn_key", "isbn"]));
    expect(names).not.toContain("prices");
    expect(names).not.toContain("authors");
  });
});

describe("what the prompt carries", () => {
  test("each statement shows its id, the app's reading and its script", () => {
    const { spec } = task();
    expect(spec.prompt).toMatch(/S1 \[high: [^\]]*deletes rows \(DROP COLUMN\)[^\]]*\] books v2\.0\.0, statement 1: ALTER TABLE books DROP COLUMN price/);
    expect(spec.prompt).toContain("S4 [low] authors v1.1.0: ALTER TABLE authors ADD COLUMN bio text");
  });

  test("comments are taken out of the statement text, a -- inside a string stays", () => {
    const list = listReviewStatements(
      [{ scriptName: "notes", version: "1.0.0", sqlContent: "/* why */ UPDATE authors SET name = 'a -- b' -- tidy\nWHERE id = 1;" }],
      target
    )!;
    const { spec } = buildMigrationReviewTask(list, { action: "deploy", snapshot: target, sizes, fingerprint: "c" });
    expect(spec.prompt).toContain("notes v1.0.0: UPDATE authors SET name = 'a -- b' WHERE id = 1");
    expect(spec.prompt).not.toContain("tidy");
  });

  test("the run's rules: one transaction, a 15 second lock wait", () => {
    const { spec } = task();
    expect(spec.prompt).toContain("one transaction");
    expect(spec.prompt).toContain("at most 15 seconds for a lock");
  });

  test("sizes are rounded estimates and the database name is never sent", () => {
    const { spec } = task();
    expect(spec.prompt).toContain("books: about 1,000,000 rows, about 3 GB");
    expect(spec.prompt).toContain("authors: no rows, about 8 kB");
    expect(spec.prompt).not.toContain("1234567");
    expect(spec.prompt).not.toContain("bookshop_prod_secret");
  });

  test("the saved answer belongs to one run: the fingerprint is in the cache key", () => {
    const { spec } = task();
    expect(spec.cacheInput).toEqual(expect.objectContaining({ fingerprint: "abc" }));
    expect(spec.feature).toBe("migration-review");
    expect(spec.tier).toBe("smart");
  });

  test("past the budget, flagged statements are still listed and the rest are counted", () => {
    const many: ReviewScript[] = [
      {
        scriptName: "bulk",
        version: "1.0.0",
        sqlContent:
          Array.from({ length: 400 }, (_, i) => `ALTER TABLE authors ADD COLUMN note_${i}_${"x".repeat(80)} text;`).join("\n") +
          "\nALTER TABLE books DROP COLUMN price;",
      },
    ];
    const list = listReviewStatements(many, target)!;
    const { spec, facts } = buildMigrationReviewTask(list, { action: "deploy", snapshot: target, sizes, fingerprint: "f" });
    expect(facts.listed.has("S401")).toBe(true);
    expect(facts.listed.size).toBeLessThan(401);
    expect(spec.prompt).toMatch(/\(\d+ more statements are not listed\.\)/);
  });
});

describe("the check on the model's answer", () => {
  const good: ModelReview["findings"][number] = {
    statements: ["S1"],
    severity: "high",
    title: "Dropping `books.price` loses every price",
    why: "`books` holds about a million rows, and the prices are gone once this runs.",
    saferWay: "Copy the prices into `prices` first.",
    objects: ["books.price"],
  };

  test("a finding that cites a statement not in the run is dropped", () => {
    const { facts } = task();
    const { value, report } = checkMigrationReview(
      { verdict: "Risky.", findings: [good, { ...good, statements: ["S99"] }] },
      facts
    );
    expect(value.findings).toHaveLength(1);
    expect(report.droppedItems).toBe(1);
  });

  test("a finding that names a table that is nowhere is dropped, one the run creates is kept", () => {
    const { facts } = task();
    const { value } = checkMigrationReview(
      {
        verdict: "Risky.",
        findings: [
          good,
          { ...good, statements: ["S3"], severity: "low", title: "New `prices` table", why: "It references `books`." },
          { ...good, statements: ["S2"], title: "Fills `book_isbns`", why: "It writes to `book_isbns`." },
        ],
      },
      facts
    );
    expect(value.findings.map((f) => f.title)).toEqual(["Dropping `books.price` loses every price", "New `prices` table"]);
  });

  test("severity is raised to the app's reading of the cited statements, never lowered", () => {
    const { facts } = task();
    const { value, report } = checkMigrationReview(
      {
        verdict: "Mostly fine.",
        findings: [
          { ...good, severity: "low" },
          { ...good, statements: ["S4"], severity: "medium", title: "Adds `authors.bio`", why: "Nothing breaks." },
        ],
      },
      facts
    );
    expect(value.findings[0].severity).toBe("high");
    expect(value.findings[1].severity).toBe("medium");
    expect(report.severityRaised).toBe(1);
  });

  test("objects that are nowhere are taken off, the finding stays", () => {
    const { facts } = task();
    const { value, report } = checkMigrationReview(
      { verdict: "Risky.", findings: [{ ...good, objects: ["books.price", "ghost_table"] }] },
      facts
    );
    expect(value.findings[0].objects).toEqual(["books.price"]);
    expect(report.droppedObjects).toBe(1);
  });

  test("when most findings are bad, or the verdict names what is not there, the answer is asked again", () => {
    const { facts } = task();
    expect(checkMigrationReview({ verdict: "Fine.", findings: [{ ...good, statements: ["S9"] }] }, facts).problems).toHaveLength(1);
    expect(checkMigrationReview({ verdict: "It rebuilds `ghosts`.", findings: [good] }, facts).problems).toHaveLength(1);
    expect(checkMigrationReview({ verdict: "It drops `books.price`.", findings: [good] }, facts).problems).toEqual([]);
  });

  test("a bad first answer is sent back once, and the second one is used", async () => {
    const t = task();
    const config: AiConfig = {
      provider: "openai-compatible",
      baseUrl: "https://example.test/v1",
      apiKey: "k",
      models: { fast: "fast-model", smart: "smart-model" },
    } as unknown as AiConfig;
    const deps: AiDeps = {
      config,
      provider: new MockProvider([
        { verdict: "Fine.", findings: [{ ...good, statements: ["S42"] }] },
        { verdict: "Back up `books.price` first.", findings: [good] },
      ]),
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
    const result = await runAiTask({ orgId: 1, email: "ada@example.com" }, t.spec, deps);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.retries).toBe(1);
    expect(result.value.findings[0].statements).toEqual(["S1"]);
  });
});

describe("the app's own findings", () => {
  test("flagged statements the model left out get a finding written by the app", () => {
    const { facts } = task();
    const answer = withAppFindings({ verdict: "Adding `authors.bio` is safe.", findings: [] }, facts);
    const fromApp = answer.findings.filter((f) => f.fromApp);
    expect(fromApp.map((f) => f.statements).flat().sort()).toEqual(["S1", "S2"]);
    expect(fromApp.every((f) => f.saferWay === "")).toBe(true);
    expect(answer.findings[0].severity).toBe("high");
    // A safe verdict over a high finding would contradict the list.
    expect(answer.verdict).toContain("The app's own checks flag");
    expect(isMigrationReviewAnswer({ verdict: answer.verdict, findings: answer.findings })).toBe(true);
  });

  test("a statement the model covered gets no app finding, and its verdict stands", () => {
    const { facts } = task();
    const review: ModelReview = {
      verdict: "Back up `books.price` before you run this.",
      findings: [
        { statements: ["S1", "S2"], severity: "high", title: "Price is lost", why: "`books` loses `books.price`.", saferWay: "", objects: [] },
      ],
    };
    const answer = withAppFindings(review, facts);
    expect(answer.appFindings).toBe(0);
    expect(answer.verdict).toBe(review.verdict);
    expect(answer.findings.every((f) => !f.fromApp)).toBe(true);
  });

  test("the screen gets what each cited id stands for", () => {
    const { facts } = task();
    const answer = withAppFindings({ verdict: "Risky.", findings: [] }, facts);
    const cited = reviewedStatements(answer, facts);
    expect(cited.S1.label).toBe("books v2.0.0, statement 1");
    expect(cited.S1.preview).toContain("DROP COLUMN price");
    expect(cited.S4).toBeUndefined();
  });
});

describe("rough sizes", () => {
  test("rows, to one figure", () => {
    expect(roughRows(null)).toBe("an unknown number of rows (never analysed)");
    expect(roughRows(0)).toBe("no rows");
    expect(roughRows(1)).toBe("1 row");
    expect(roughRows(7)).toBe("7 rows");
    expect(roughRows(12_345)).toBe("about 10,000 rows");
    expect(roughRows(87_000)).toBe("about 90,000 rows");
  });

  test("bytes, in 1024 steps", () => {
    expect(roughBytes(500)).toBe("about 500 bytes");
    expect(roughBytes(8192)).toBe("about 8 kB");
    expect(roughBytes(3.2 * 1024 * 1024)).toBe("about 3 MB");
  });
});
