// drift-runner: the AI's one line on a new drift is asked for before the row is
// written, so the row keeps it, and a line that fails never stops the check.

import { runDriftCheck } from "@/lib/drift-runner";
import { compareSchemas } from "@/lib/compare";
import { column, schema, table } from "./helpers/snapshots";

let outcome: unknown = { kind: "not_found" };

const mockPoolQuery = jest.fn<Promise<unknown>, [string, unknown[]?]>(async () => ({ rows: [], rowCount: 1 }));
jest.mock("../lib/version-db", () => ({
  __esModule: true,
  default: { query: (...args: [string, unknown[]?]) => mockPoolQuery(...args) },
  syncMetadataTables: async () => undefined,
}));

jest.mock("../lib/lineage-db", () => ({
  ...jest.requireActual("../lib/lineage-db"),
  computeDriftDetail: async () => mockOutcome.value,
}));

jest.mock("../lib/schema-metrics", () => ({
  recordSchemaMetrics: async () => undefined,
}));

const mockOutcome = {
  get value() {
    return outcome;
  },
};

const ORG = 7;
const subject = {
  schemaName: "public",
  label: null,
  environment: "development" as const,
  connection: null,
  driftIntervalMinutes: 15,
};

const id = () => column("id", { nullable: false, isPrimaryKey: true });
const baseline = schema([table("books", [id(), column("price", { typeDisplay: "numeric" })])]);
const live = schema([table("books", [id()])]);

function ok(status: "drifted" | "in_sync") {
  const report = status === "drifted" ? compareSchemas(baseline, live) : compareSchemas(baseline, baseline);
  return {
    kind: "ok",
    ...subject,
    status,
    summary: status === "drifted" ? "1 table changed" : "In sync",
    counts: { tablesAdded: 0, tablesRemoved: 0, tablesChanged: status === "drifted" ? 1 : 0, constraintsChanged: 0, objectsChanged: 0 },
    report,
    expected: { version: "1.2.0", seq: 3, snapshotId: 11 },
    live: status === "drifted" ? live : baseline,
  };
}

/** The detail column of each drift_events row the runner wrote. */
function details(): unknown[] {
  return mockPoolQuery.mock.calls
    .filter(([text]) => /INSERT INTO drift_events/.test(text))
    .map(([, values]) => {
      const detail = (values ?? [])[3];
      return typeof detail === "string" ? JSON.parse(detail) : detail;
    });
}

beforeEach(() => mockPoolQuery.mockClear());

test("a drift's row keeps the line, and the run carries it to the alerts", async () => {
  outcome = ok("drifted");
  const describe = jest.fn(async () => "Live lost books.price.");
  const result = await runDriftCheck(ORG, 4, "scheduled", "always", { describe });
  expect(describe).toHaveBeenCalledTimes(1);
  expect(result.ok && result.run.aiSummary).toBe("Live lost books.price.");
  expect(details()).toEqual([expect.objectContaining({ tablesChanged: 1, aiSummary: "Live lost books.price." })]);
});

test("no line leaves the row as it always was", async () => {
  outcome = ok("drifted");
  await runDriftCheck(ORG, 4, "scheduled", "always", { describe: async () => null });
  const [detail] = details() as Record<string, unknown>[];
  expect(detail).toEqual(expect.objectContaining({ tablesChanged: 1 }));
  expect("aiSummary" in detail).toBe(false);
});

test("a line that throws still records the check", async () => {
  outcome = ok("drifted");
  const quiet = jest.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    const result = await runDriftCheck(ORG, 4, "scheduled", "always", {
      describe: async () => {
        throw new Error("service down");
      },
    });
    expect(result.ok && result.run.recorded).toBe(true);
    expect(result.ok && result.run.aiSummary).toBeNull();
    expect(details()).toHaveLength(1);
  } finally {
    quiet.mockRestore();
  }
});

test("a schema in sync, or a database out of reach, asks for no line", async () => {
  const describe = jest.fn(async () => "never");
  outcome = ok("in_sync");
  await runDriftCheck(ORG, 4, "scheduled", "always", { describe });
  outcome = { kind: "unreachable", ...subject, summary: "Could not connect", expected: { version: "1.2.0", seq: 3, snapshotId: 11 } };
  await runDriftCheck(ORG, 4, "scheduled", "always", { describe });
  expect(describe).not.toHaveBeenCalled();
});

test("a check with no line asked for works as before", async () => {
  outcome = ok("drifted");
  const result = await runDriftCheck(ORG, 4, "manual", "always");
  expect(result.ok && result.run.aiSummary).toBeNull();
});
