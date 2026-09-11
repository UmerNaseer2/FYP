import { compareSchemas } from "@/lib/compare";
import { buildDiffDocument, type DiffDocument } from "@/lib/compare-export";
import { countedChanges, documentToMarkdown } from "@/lib/compare-export-format";
import { tallyDelta } from "@/components/studio/DiffReport";
import { column, schema, table } from "./helpers/snapshots";

/**
 * The Compare header and the export bar under it count the same comparison
 * in two different places: the header from the report (tallyDelta), the export
 * from the document built out of that report. They disagreed — "7 changes"
 * above, "8 changes" below — because the export counted rename suggestions and
 * the header did not count an accepted table rename. These tests hold the two
 * together on real engine output, so the next change to either side cannot
 * quietly pull them apart again.
 */

function totals(over: Partial<DiffDocument["totals"]> = {}): DiffDocument["totals"] {
  return {
    changes: 0,
    added: 0,
    dropped: 0,
    changed: 0,
    renamed: 0,
    renameSuggestions: 0,
    breaking: 0,
    manual: 0,
    ...over,
  };
}

function documentWith(t: DiffDocument["totals"]): DiffDocument {
  return {
    format: "schema-studio-diff",
    version: 1,
    source: { database: "src", schema: "app" },
    target: { database: "tgt", schema: "app" },
    totals: t,
    notCompared: [],
    categories: [],
    changes: [],
    data: null,
  };
}

describe("countedChanges", () => {
  it("leaves rename suggestions out", () => {
    const t = totals({ changes: 8, added: 2, changed: 3, dropped: 2, renameSuggestions: 1 });
    expect(countedChanges(t)).toBe(7);
  });

  it("is every row when nothing was suggested", () => {
    const t = totals({ changes: 4, added: 1, changed: 1, dropped: 1, renamed: 1 });
    expect(countedChanges(t)).toBe(4);
  });
});

describe("documentToMarkdown — headline", () => {
  it("counts changes, and puts possible renames on a line of their own", () => {
    const md = documentToMarkdown(
      documentWith(totals({ changes: 8, added: 2, changed: 3, dropped: 2, renameSuggestions: 1 }))
    );
    expect(md).toContain("**7 changes** — 2 added, 3 changed, 2 dropped.");
    expect(md).toContain("1 possible rename is listed below but not applied");
    expect(md).not.toContain("8 change");
  });

  it("says one change in the singular", () => {
    const md = documentToMarkdown(documentWith(totals({ changes: 1, renamed: 1 })));
    expect(md).toContain("**1 change** — 0 added, 0 changed, 0 dropped, 1 renamed.");
    expect(md).not.toContain("possible rename");
  });

  it("calls two matching schemas in sync", () => {
    const md = documentToMarkdown(documentWith(totals()));
    expect(md).toContain("The two schemas are in sync. Nothing to migrate.");
  });
});

// Each pair is source first, target second — the way the Compare screen asks.
const scenarios: { name: string; source: ReturnType<typeof schema>; target: ReturnType<typeof schema> }[] = [
  {
    name: "a table renamed and nothing else",
    source: schema([
      table("app_users", [
        column("id", { nullable: false }),
        column("email", { typeDisplay: "text" }),
        column("created_at", { typeDisplay: "timestamptz" }),
        column("full_name", { typeDisplay: "text" }),
      ]),
    ]),
    target: schema([
      table("users", [
        column("id", { nullable: false }),
        column("email", { typeDisplay: "text" }),
        column("created_at", { typeDisplay: "timestamptz" }),
        column("full_name", { typeDisplay: "text" }),
      ]),
    ]),
  },
  {
    name: "columns added, dropped, retyped and maybe renamed",
    source: schema([
      table("orders", [
        column("id", { nullable: false }),
        column("total", { typeDisplay: "numeric(10,2)" }),
        column("customer_email", { typeDisplay: "text" }),
        column("placed_at", { typeDisplay: "timestamptz" }),
      ]),
    ]),
    target: schema([
      table("orders", [
        column("id", { nullable: false }),
        column("total", { typeDisplay: "integer" }),
        column("email", { typeDisplay: "text" }),
        column("note", { typeDisplay: "text" }),
      ]),
    ]),
  },
  {
    name: "two tables that share a little",
    source: schema([
      table("invoices", [
        column("id", { nullable: false }),
        column("amount", { typeDisplay: "numeric" }),
        column("issued_on", { typeDisplay: "date" }),
      ]),
    ]),
    target: schema([
      table("bills", [
        column("id", { nullable: false }),
        column("amount", { typeDisplay: "numeric" }),
        column("due_on", { typeDisplay: "date" }),
        column("vendor", { typeDisplay: "text" }),
      ]),
    ]),
  },
  {
    name: "unrelated tables",
    source: schema([table("orders", [column("id"), column("total")])]),
    target: schema([table("audit_log", [column("occurred_at"), column("payload")])]),
  },
  {
    name: "identical schemas",
    source: schema([table("orders", [column("id"), column("total")])]),
    target: schema([table("orders", [column("id"), column("total")])]),
  },
];

describe("header and export agree", () => {
  it.each(scenarios.map((s) => [s.name, s] as const))("%s", (_name, s) => {
    const report = compareSchemas(s.source, s.target);
    const document = buildDiffDocument(report);
    expect(countedChanges(document.totals)).toBe(tallyDelta(report).total);
  });

  // The agreement above means little unless the cases that used to break it
  // are among the scenarios. If the engine's thresholds move and a scenario
  // stops producing one, this says so instead of passing on easy cases.
  it("covers an accepted table rename and a rename suggestion", () => {
    const reports = scenarios.map((s) => compareSchemas(s.source, s.target));
    const acceptedRename = reports.some((r) => r.matchedTables.some((m) => !m.exact));
    const suggestion = reports.some((r) => buildDiffDocument(r).totals.renameSuggestions > 0);
    expect({ acceptedRename, suggestion }).toEqual({ acceptedRename: true, suggestion: true });
  });
});
