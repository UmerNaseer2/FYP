/**
 * @jest-environment jsdom
 */
// The Compare tiles count what the script changes, one per table, column,
// index and so on. Three new tables used to read "8 added": the owner and
// grants entry of each new table and of each table's id sequence was counted
// as a change of its own. Found on sample data (courses_dev against
// students_dev). These tests hold the tiles, the export bar, the matrix and the
// report to one answer: the grants of something new go with it.
import "@testing-library/jest-dom";
import { cleanup, render, screen } from "@testing-library/react";
import { comesWithNewObject, compareSchemas } from "@/lib/compare";
import { buildDiffDocument } from "@/lib/compare-export";
import { countedChanges } from "@/lib/compare-export-format";
import { summaryRows } from "@/lib/compare-summary";
import { DiffReport, describeParts, tallyDelta } from "@/components/studio/DiffReport";
import type { PrivilegeSnapshot, SchemaSnapshot } from "@/lib/postgres";
import { column, schema, table } from "./helpers/snapshots";

afterEach(cleanup);

function access(
  objectKind: PrivilegeSnapshot["objectKind"],
  objectName: string,
  grants: PrivilegeSnapshot["grants"] = [],
): PrivilegeSnapshot {
  const text = `owner app ${grants.map((g) => `${g.grantee}=${g.privileges.join(",")}`).join(" ")}`;
  return { objectKind, objectName, owner: "app", grants, definition: text, normalizedDefinition: text };
}

/** students on both sides, courses only in the source, grades only in the target. */
function pair(studentGrants: PrivilegeSnapshot["grants"] = []): [SchemaSnapshot, SchemaSnapshot] {
  const source = schema(
    [table("students", [column("id"), column("name")]), table("courses", [column("id"), column("title")])],
    {
      // The id sequence belongs to courses, so its grants go with that table.
      sequences: [
        {
          name: "courses_id_seq",
          ownedByTable: "courses",
          ownedByColumn: "id",
          dataType: "integer",
          startValue: "1",
          increment: "1",
          minValue: "1",
          maxValue: "2147483647",
          cycles: false,
          cacheSize: "1",
        },
      ],
      privileges: [
        access("SCHEMA", "public"),
        access("TABLE", "students", studentGrants),
        access("TABLE", "courses"),
        access("SEQUENCE", "courses_id_seq"),
      ],
    },
  );
  const target = schema(
    [table("students", [column("id"), column("name")]), table("grades", [column("id"), column("mark")])],
    {
      privileges: [access("SCHEMA", "public"), access("TABLE", "students"), access("TABLE", "grades")],
    },
  );
  return [source, target];
}

describe("headline counts", () => {
  it("counts a new table once, not once more for its owner and its sequence's owner", () => {
    const report = compareSchemas(...pair());
    // The engine still reports both entries: the script needs them to set the owner.
    expect(report.objectDiffs.filter(comesWithNewObject).map((d) => d.name).sort()).toEqual([
      "sequence courses_id_seq",
      "table courses",
    ]);

    const delta = tallyDelta(report);
    expect(delta).toMatchObject({ adds: 1, chgs: 0, rems: 1, tablesTouched: 2, total: 2 });
    expect(delta.parts.adds).toEqual([{ count: 1, noun: "table" }]);
    expect(delta.parts.rems).toEqual([{ count: 1, noun: "table" }]);
  });

  it("still counts access that changes on a table both sides have", () => {
    const report = compareSchemas(...pair([{ grantee: "reporter", privileges: ["SELECT"], grantable: [] }]));
    const delta = tallyDelta(report);
    expect(delta.chgs).toBe(1);
    expect(delta.parts.chgs).toEqual([{ count: 1, noun: "grant" }]);
  });

  it("agrees with the export bar and the matrix", () => {
    const report = compareSchemas(...pair());
    expect(countedChanges(buildDiffDocument(report).totals)).toBe(tallyDelta(report).total);

    const privileges = summaryRows(report).find((row) => row.label === "Privileges");
    // Nothing added on its own, and the two new objects' entries are not "in sync" either.
    expect(privileges).toMatchObject({ added: 0, dropped: 0, changed: 0, inSync: 2 });
  });

  it("lists the grants on the new table's card, outside the schema objects card", () => {
    render(<DiffReport report={compareSchemas(...pair())} />);
    expect(screen.getByText("Owner and grants")).toBeInTheDocument();
    expect(screen.getByText("table courses")).toBeInTheDocument();
    expect(screen.getByText("sequence courses_id_seq")).toBeInTheDocument();
    expect(screen.queryByText("Ownership and grants")).not.toBeInTheDocument();
  });
});

describe("describeParts", () => {
  it("names one kind", () => {
    expect(describeParts([{ count: 3, noun: "tables" }])).toBe("3 tables");
  });

  it("folds the tail into a count that still adds up", () => {
    const parts = [
      { count: 1, noun: "table" },
      { count: 2, noun: "columns" },
      { count: 1, noun: "index" },
      { count: 3, noun: "grants" },
    ];
    expect(describeParts(parts)).toBe("1 table · 2 columns · 4 more");
  });

  it("is empty for nothing, so the tile keeps its plain hint", () => {
    expect(describeParts([])).toBe("");
    expect(describeParts(undefined)).toBe("");
  });
});
