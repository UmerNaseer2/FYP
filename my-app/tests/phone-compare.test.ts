// phone-compare: what a paired phone is told about a comparison
// (lib/phone-compare.ts, behind POST /api/compare/phone).
//
// A phone is easy to lose, so most of these tests are about what is left out:
// no SQL, no host or address, and nothing a database server said. The rest are
// about what is kept exact because the phone sends it back, the schema names,
// and about the counts, which must match the Compare screen's.
//
// tests/phone-compare-route.test.ts runs the route over the real runComparison.
import { compareSchemas } from "@/lib/compare";
import { buildDiffDocument } from "@/lib/compare-export";
import { countedChanges } from "@/lib/compare-export-format";
import {
  MAX_PHONE_LINES,
  phoneCompareQuery,
  readPhoneCompareRequest,
  summarizeForPhone,
  type PhoneCompareInput,
  type PhoneOutcome,
} from "@/lib/phone-compare";
import { column, schema, table } from "./helpers/snapshots";

// The source has a table the target lacks (safe to add), the target has a
// column the source lacks (breaking to drop), and one column's type differs.
const SOURCE = schema([
  table("orders", [column("id"), column("total", { typeDisplay: "numeric" })]),
  table("users", [column("id"), column("email", { typeDisplay: "text" })]),
]);
const TARGET = schema([
  table("users", [
    column("id"),
    column("email", { typeDisplay: "varchar(80)" }),
    column("legacy"),
  ]),
]);
const REPORT = compareSchemas(SOURCE, TARGET);

const SOURCE_VIEW: PhoneCompareInput["source"] = {
  connectionId: 1,
  displayName: "Dev (app)",
  environment: "dev",
  schema: "public",
  schemaOptions: ["public", "qa"],
  missingMessage: null,
};

/** A target compared without trouble, unless `over` says otherwise. */
function outcome(over: Partial<PhoneOutcome> = {}): PhoneOutcome {
  return {
    connectionId: 2,
    displayName: "Staging (app)",
    environment: "staging",
    schema: "public",
    sameAsSource: false,
    failure: null,
    duplicateOf: null,
    report: REPORT,
    history: null,
    ...over,
  };
}

function summarize(outcomes: PhoneOutcome[], over: Partial<PhoneCompareInput> = {}) {
  return summarizeForPhone({ source: SOURCE_VIEW, sourceError: null, outcomes, ...over });
}

const GONE = "This connection is no longer saved on the computer.";
const SOURCE_UNREADABLE =
  "The computer could not read this schema. Open Compare on the computer to see why.";
const FAILED =
  "The computer could not compare this schema. Open Compare on the computer to see why.";

describe("readPhoneCompareRequest", () => {
  const ref = (connectionId: unknown, name: unknown) => ({ connectionId, schema: name });
  const valid = { source: ref(1, "public"), targets: [ref(2, "public"), ref(3, "qa")] };

  /** The reader's reason for refusing this body, or null when it accepts it. */
  function refusal(body: unknown): string | null {
    const read = readPhoneCompareRequest(body);
    return read.ok ? null : read.error;
  }

  test("accepts a request, keeping only the fields it knows", () => {
    const body = { ...valid, source: { ...valid.source, host: "db.example.test" }, extra: 1 };
    expect(readPhoneCompareRequest(body)).toStrictEqual({
      ok: true,
      data: {
        source: { connectionId: 1, schema: "public" },
        targets: [
          { connectionId: 2, schema: "public" },
          { connectionId: 3, schema: "qa" },
        ],
      },
    });
  });

  test.each([null, [], "x", 1, undefined])("refuses %p, which is not an object", (body) => {
    expect(refusal(body)).toMatch(/JSON object/);
  });

  test.each([
    ["an ID of 0", ref(0, "public")],
    ["an ID with a fraction", ref(1.5, "public")],
    ["an ID sent as text", ref("1", "public")],
    ["a negative ID", ref(-1, "public")],
    ["an ID too big to count exactly", ref(2 ** 53, "public")],
    ["no ID", { schema: "public" }],
    ["an empty schema name", ref(1, "")],
    ["a schema name of 129 characters", ref(1, "s".repeat(129))],
    ["a schema name that is a number", ref(1, 5)],
    ["no schema name", { connectionId: 1 }],
    ["a space before the schema name", ref(1, " public")],
    ["a line break after the schema name", ref(1, "public\n")],
    ["a schema name of only spaces", ref(1, "   ")],
    ["nothing in it", null],
    ["text in place of an object", "x"],
  ])("refuses a source with %s", (_label, source) => {
    expect(refusal({ ...valid, source })).toMatch(/^The source needs/);
  });

  test("accepts a schema name of 128 characters, and spaces inside a name", () => {
    expect(refusal({ ...valid, source: ref(1, "s".repeat(128)) })).toBeNull();
    expect(refusal({ ...valid, source: ref(1, "Mixed Case") })).toBeNull();
  });

  test.each([
    ["no targets", []],
    ["seven targets", Array.from({ length: 7 }, (_, i) => ref(i + 2, "public"))],
    ["targets that are not a list", ref(2, "public")],
    ["one bad target among good ones", [ref(2, "public"), ref(3, " qa")]],
  ])("refuses %s", (_label, targets) => {
    expect(refusal({ ...valid, targets })).toMatch(/^Send 1 to 6 targets/);
  });

  test("accepts six targets", () => {
    const targets = Array.from({ length: 6 }, (_, i) => ref(i + 2, "public"));
    expect(readPhoneCompareRequest({ ...valid, targets })).toEqual({
      ok: true,
      data: { source: valid.source, targets },
    });
  });
});

describe("phoneCompareQuery", () => {
  test("asks for the comparison the way the Compare button does", () => {
    const query = phoneCompareQuery({
      source: { connectionId: 1, schema: "public" },
      targets: [
        { connectionId: 2, schema: "app" },
        { connectionId: 3, schema: "public" },
      ],
    });
    expect(query.toString()).toBe(
      "run=1&sourceConnection=1&sourceSchema=public" +
        "&targetConnection=2&targetSchema=app&targetConnection=3&targetSchema=public"
    );
  });

  test("keeps a schema name with query characters in it whole", () => {
    const query = phoneCompareQuery({
      source: { connectionId: 1, schema: "a&b c" },
      targets: [{ connectionId: 2, schema: "x=y" }],
    });
    const read = new URLSearchParams(query.toString());
    expect([read.get("sourceSchema"), read.getAll("targetSchema")]).toEqual(["a&b c", ["x=y"]]);
  });
});

describe("a compared target", () => {
  const document = buildDiffDocument(REPORT);

  test("has the counts the Compare screen shows, and every row", () => {
    const [target] = summarize([outcome()]).targets;
    expect(target).toMatchObject({
      status: "compared",
      error: null,
      changes: countedChanges(document.totals),
      breaking: document.totals.breaking,
      manual: document.totals.manual,
      moreLines: 0,
      history: null,
    });
    expect(target.changes).toBeGreaterThan(0);
    expect(target.lines).toHaveLength(document.changes.length);
  });

  test("lists breaking changes first, then safe ones, then the rest", () => {
    // The export lists the new table (safe) before the dropped column
    // (breaking), so this is a real reordering.
    expect(document.changes[0].severity).toBe("safe");
    expect(document.totals.breaking).toBeGreaterThan(0);
    const rowsOf = (severity: string) =>
      document.changes.filter((row) => row.severity === severity);

    const [target] = summarize([outcome()]).targets;
    expect(target.lines).toEqual([...rowsOf("breaking"), ...rowsOf("safe"), ...rowsOf("info")]);
    expect(target.lines[0].severity).toBe("breaking");
  });

  test(`sends at most ${MAX_PHONE_LINES} rows, and counts the rest`, () => {
    const many = schema(Array.from({ length: 250 }, (_, i) => table(`t${i}`, [column("id")])));
    const [target] = summarize([outcome({ report: compareSchemas(many, schema([])) })]).targets;
    expect([target.lines.length, target.moreLines, target.changes]).toEqual([
      MAX_PHONE_LINES,
      50,
      250,
    ]);
  });
});

describe("text for a phone screen", () => {
  test("a name is put on one line, with invisible characters taken out", () => {
    const [target] = summarize([
      outcome({ displayName: "Staging\n  (app)\u{202E}\u{200B}" }),
    ]).targets;
    expect(target.name).toBe("Staging (app)");
  });

  test("a long name is cut to 200 characters, the last an ellipsis", () => {
    const { source } = summarize([], {
      source: { ...SOURCE_VIEW, displayName: "d".repeat(300) },
    });
    const chars = Array.from(source.name);
    expect([chars.length, chars[chars.length - 1]]).toEqual([200, "\u{2026}"]);
  });

  test("a long detail is cut between characters, never through an emoji", () => {
    // An added column's detail quotes its default, here 300 emoji long. Each
    // emoji is two UTF-16 units, and a cut between them would leave half of one.
    const withMood = schema([
      table("users", [column("id"), column("mood", { columnDefault: "\u{1F600}".repeat(300) })]),
    ]);
    const without = schema([table("users", [column("id")])]);
    const [target] = summarize([outcome({ report: compareSchemas(withMood, without) })]).targets;
    const detail = target.lines.find((line) => line.detail.includes("\u{1F600}"))?.detail ?? "";

    const chars = Array.from(detail);
    expect([chars.length, chars[chars.length - 1]]).toEqual([240, "\u{2026}"]);
    expect(detail).not.toMatch(/[\u{D800}-\u{DFFF}]/u);
  });

  test("a schema name is sent exactly as it was compared", () => {
    const name = "Mixed\t Case";
    const summary = summarize([outcome({ schema: name })], {
      source: { ...SOURCE_VIEW, schema: name, schemaOptions: [name] },
    });
    expect([summary.source.schema, summary.targets[0].schema]).toEqual([name, name]);
  });

  test("the history sentence is put on one line", () => {
    const [target] = summarize([
      outcome({
        history: { sentence: "Since the comparison\non 12 Sept 2026, 10:00: 2 new differences." },
      }),
    ]).targets;
    expect(target.history).toBe("Since the comparison on 12 Sept 2026, 10:00: 2 new differences.");
  });
});

describe("a target that was not compared", () => {
  test.each<[string, Partial<PhoneOutcome>, string, string]>([
    [
      "the source schema itself",
      { sameAsSource: true, report: null },
      "same-as-source",
      "This is the source schema itself, so there is nothing to compare.",
    ],
    [
      "a database that did not answer",
      { failure: "unreachable", report: null },
      "unreachable",
      "The computer could not connect to this database. Open Compare on the computer to see why.",
    ],
    [
      "a schema the database does not have",
      { failure: "schema-missing", schema: "nope", report: null },
      "schema-missing",
      'This database has no schema called "nope".',
    ],
    [
      "a repeat of target 1",
      { failure: "duplicate", duplicateOf: 0, report: null },
      "duplicate",
      "This is the same database and schema as target 1, so it is compared only once.",
    ],
    [
      "a repeat of a target it cannot name",
      { failure: "duplicate", duplicateOf: null, report: null },
      "duplicate",
      "This is the same database and schema as another target, so it is compared only once.",
    ],
    [
      "a connection that is gone",
      { failure: "no-connection", connectionId: null, report: null },
      "no-connection",
      GONE,
    ],
    [
      // A report that came with a failure is not trusted, nor its history.
      "a comparison that threw",
      { failure: "failed", history: { sentence: "Since the comparison on 1 Oct 2026, 09:00." } },
      "failed",
      FAILED,
    ],
    ["neither a report nor a reason", { report: null }, "failed", FAILED],
  ])("%s", (_label, over, status, error) => {
    const [target] = summarize([outcome(over)]).targets;
    expect(target).toMatchObject({
      status,
      error,
      changes: 0,
      breaking: 0,
      manual: 0,
      lines: [],
      moreLines: 0,
      history: null,
    });
  });
});

describe("what is never sent", () => {
  test("a database server's error, and the SQL, stay on the computer", () => {
    // More than the summary reads, as runComparison's real answer is.
    const leaky = {
      ...outcome({ failure: "unreachable", report: null }),
      error: "connect ECONNREFUSED 10.20.30.40:5432",
      sqlText: "DROP TABLE users;",
    };
    const text = JSON.stringify(summarize([leaky]));
    for (const secret of ["10.20.30.40", "ECONNREFUSED", "DROP TABLE"]) {
      expect(text).not.toContain(secret);
    }
  });

  test("a compared target sends its changes, not the script that makes them", () => {
    const compared = { ...outcome(), sqlText: "ALTER TABLE users DROP COLUMN legacy;" };
    expect(JSON.stringify(summarize([compared]))).not.toContain("ALTER TABLE");
  });
});

describe("a source that could not be read", () => {
  test("a connection that is gone stops the whole comparison", () => {
    const summary = summarize([outcome()], {
      source: { ...SOURCE_VIEW, connectionId: null, missingMessage: "That connection is gone." },
      sourceError: "That connection is gone.",
    });
    expect([summary.source.error, summary.targets]).toEqual([GONE, []]);
  });

  test("a schema the server does not list is named", () => {
    const summary = summarize([], {
      source: { ...SOURCE_VIEW, schema: "nope" },
      sourceError: "Schema nope was not found in Dev (app).",
    });
    expect(summary.source.error).toBe('This database has no schema called "nope".');
  });

  test("a server that did not answer is not quoted", () => {
    const summary = summarize([outcome()], {
      source: { ...SOURCE_VIEW, schemaOptions: [] },
      sourceError: "Could not reach Dev (app): connect ECONNREFUSED 10.20.30.40:5432",
    });
    expect([summary.source.error, summary.targets]).toEqual([SOURCE_UNREADABLE, []]);
    expect(JSON.stringify(summary)).not.toContain("10.20.30.40");
  });

  test("a schema that is there but could not be loaded is not called missing", () => {
    const summary = summarize([], {
      sourceError: "Could not load public from Dev (app): permission denied",
    });
    expect(summary.source.error).toBe(SOURCE_UNREADABLE);
  });
});

test("the answer has exactly the fields rpc.ts reads", () => {
  const summary = summarize([outcome()]);
  const keys = (value: object) => Object.keys(value).sort();
  expect(keys(summary)).toEqual(["source", "targets"]);
  expect(keys(summary.source)).toEqual(["connectionId", "environment", "error", "name", "schema"]);
  expect(keys(summary.targets[0])).toEqual([
    "breaking",
    "changes",
    "connectionId",
    "environment",
    "error",
    "history",
    "lines",
    "manual",
    "moreLines",
    "name",
    "schema",
    "status",
  ]);
  expect(keys(summary.targets[0].lines[0])).toEqual([
    "category",
    "change",
    "detail",
    "manual",
    "object",
    "severity",
    "table",
  ]);
});
