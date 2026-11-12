/** @jest-environment jsdom */

/**
 * The comparison screen's note about renamed tables.
 *
 * The engine does not look for renamed tables when too many tables are left
 * over on both sides (lib/compare's renameMatchingSkipped), because scoring
 * every pair took minutes. A table that was only renamed then shows as one to
 * create and one to drop. The page has to say so, or a reader who knows the
 * table was renamed takes the report to be wrong.
 *
 * The panels under the note have their own suites and are stubbed here: a
 * report of 240 tables through all of them would test them a second time.
 */

import "@testing-library/jest-dom";
import { cleanup, screen } from "@testing-library/react";

jest.mock("next/navigation", () => require("./helpers/render-page").navigationStubs);
jest.mock("next-auth/react", () => require("./helpers/render-page").sessionStubs);
// tallyDelta is kept real: the report's header counts come from it.
jest.mock("../components/studio/DiffReport", () => ({
  ...jest.requireActual("../components/studio/DiffReport"),
  DiffReport: () => null,
}));
jest.mock("../components/studio/SummaryMatrix", () => ({ SummaryMatrix: () => null }));
jest.mock("../components/studio/CriticalChanges", () => ({ CriticalChanges: () => null }));
jest.mock("../components/studio/ExportBar", () => ({ ExportBar: () => null }));
jest.mock("../components/studio/CompareSummaryPanel", () => ({ CompareSummaryPanel: () => null }));
jest.mock("../components/studio/MigrationWorkbench", () => ({ MigrationWorkbench: () => null }));
jest.mock("../components/studio/VersionDetectBar", () => ({ VersionDetectBar: () => null }));
jest.mock("../components/studio/CompareVersionTimeline", () => ({ CompareVersionTimeline: () => null }));

import ComparePage from "@/app/[org]/(studio)/compare/page";
import { compareSchemas, type CompareReport } from "@/lib/compare";
import type { CompareScreen, OutcomeView } from "@/lib/compare-run";
import { tallyDelta } from "@/components/studio/DiffReport";
import { render, resetPageState, setRoutes, setSearchParams } from "./helpers/render-page";
import { column, schema, table } from "./helpers/snapshots";

/** `count` tables of one column each, every name starting with `prefix`. */
function manyTables(prefix: string, count: number) {
  return Array.from({ length: count }, (_, i) => table(`${prefix}_table_${i}`, [column(`${prefix}_id_${i}`)]));
}

/** One finished target, built around the report handed in. */
function outcome(report: CompareReport): OutcomeView {
  return {
    index: 0,
    connectionId: 1,
    connectionDatabase: "shop",
    displayName: "Local Postgres",
    schema: "shop_dev",
    schemaOptions: ["public", "shop_dev"],
    sameAsSource: false,
    report,
    data: null,
    error: null,
    failure: null,
    duplicateOf: null,
    delta: tallyDelta(report),
    sqlText: "",
    rollbackText: "",
    rollbackStatementCount: 0,
    rollbackCounts: { breaking: 0, safe: 0, info: 0 },
    rollbackWarnings: [],
    statementCount: 1,
    heldBackCount: 0,
    manualCount: 0,
    rollbackManualCount: 0,
    counts: { breaking: 0, safe: 0, info: 0 },
    overallKind: "additive",
    warnings: [],
    detectedVersion: null,
    versionVerdict: null,
    history: null,
  };
}

/** The screen after Compare was pressed, with one target's report on it. */
function screenWith(report: CompareReport): CompareScreen {
  return {
    kind: "ready",
    connections: [{ id: 1, name: "Local Postgres", database_name: "shop" }],
    canAddTarget: true,
    maxTargets: 4,
    sets: [],
    activeSetId: null,
    setNotFound: false,
    setsRefusal: null,
    setModified: false,
    selection: {
      sourceConnectionId: 1,
      sourceConnectionLabel: "Local Postgres",
      sourceSchema: "public",
      allowDataLoss: false,
      compareData: false,
      dataTables: [],
      targets: [{ connectionId: 1, connectionLabel: "Local Postgres", schema: "shop_dev" }],
    },
    source: {
      connectionId: 1,
      displayName: "Local Postgres",
      schema: "public",
      schemaOptions: ["public", "shop_dev"],
      detectedVersion: null,
      missingMessage: null,
    },
    sourceError: null,
    targets: [
      {
        index: 0,
        connectionId: 1,
        displayName: "Local Postgres",
        schema: "shop_dev",
        schemaOptions: ["public", "shop_dev"],
        missingMessage: null,
      },
    ],
    outcomes: [outcome(report)],
    allowDataLoss: false,
    compareData: false,
    dataTables: [],
    asked: true,
    swapHref: null,
  };
}

async function show(report: CompareReport) {
  setRoutes([{ match: "/api/compare", method: "POST", body: screenWith(report) }]);
  setSearchParams("run=1");
  render(<ComparePage />);
  // The header of the one target's section: the report is on screen.
  await screen.findByRole("heading", { name: "Diff" });
}

beforeEach(() => resetPageState());
afterEach(() => cleanup());

describe("the note about renamed tables", () => {
  it("says renamed tables were not looked for when the compare was too big", async () => {
    // 120 leftover tables on each side: 14,400 pairs, over the engine's limit.
    await show(compareSchemas(schema(manyTables("old", 120)), schema(manyTables("new", 120))));

    const note = screen.getByRole("note");
    expect(note).toHaveTextContent("Renamed tables were not looked for.");
    expect(note).toHaveTextContent("120 in the source, 120 in the target");
    expect(note).toHaveTextContent("A table that was only renamed shows as one table to create and one to drop.");
  });

  it("says nothing when renamed tables were looked for", async () => {
    await show(compareSchemas(schema(manyTables("old", 3)), schema(manyTables("new", 3))));

    expect(screen.queryByRole("note")).not.toBeInTheDocument();
    expect(screen.queryByText(/Renamed tables were not looked for/)).not.toBeInTheDocument();
  });
});
