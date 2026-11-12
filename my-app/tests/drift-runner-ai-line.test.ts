// drift-runner: the AI's one line on a new drift is asked for before the row is
// written, so the row keeps it, and a line that fails never stops the check.
// It is asked for only when the alert will show it, and a row someone else
// wrote during the wait is never buried under this check's row.

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

/** Reads of the newest drift_events row answer these, in turn: a row, none (null) or a failure ("fail"). */
function newestRows(...answers: (Record<string, unknown> | null | "fail")[]): void {
  mockPoolQuery.mockImplementation(async (text: string) => {
    if (/SELECT id, status, fingerprint FROM drift_events/.test(text)) {
      const answer = answers.shift() ?? null;
      if (answer === "fail") throw new Error("metadata database down");
      return { rows: answer === null ? [] : [answer], rowCount: answer === null ? 0 : 1 };
    }
    return { rows: [], rowCount: 1 };
  });
}

beforeEach(() => {
  mockPoolQuery.mockReset();
  mockPoolQuery.mockImplementation(async () => ({ rows: [], rowCount: 1 }));
});

test("a drift's row keeps the line, and the run carries it to the alerts", async () => {
  outcome = ok("drifted");
  const describe = jest.fn(async () => "Live lost books.price.");
  const result = await runDriftCheck(ORG, 4, "scheduled", "on_change", { describe });
  expect(describe).toHaveBeenCalledTimes(1);
  expect(result.ok && result.run.aiSummary).toBe("Live lost books.price.");
  expect(details()).toEqual([expect.objectContaining({ tablesChanged: 1, aiSummary: "Live lost books.price." })]);
});

test("no line leaves the row as it always was", async () => {
  outcome = ok("drifted");
  await runDriftCheck(ORG, 4, "scheduled", "on_change", { describe: async () => null });
  const [detail] = details() as Record<string, unknown>[];
  expect(detail).toEqual(expect.objectContaining({ tablesChanged: 1 }));
  expect("aiSummary" in detail).toBe(false);
});

test("a line that throws still records the check", async () => {
  outcome = ok("drifted");
  const quiet = jest.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    const result = await runDriftCheck(ORG, 4, "scheduled", "on_change", {
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
  await runDriftCheck(ORG, 4, "scheduled", "on_change", { describe });
  outcome = { kind: "unreachable", ...subject, summary: "Could not connect", expected: { version: "1.2.0", seq: 3, snapshotId: 11 } };
  await runDriftCheck(ORG, 4, "scheduled", "on_change", { describe });
  expect(describe).not.toHaveBeenCalled();
});

test("a check with no line asked for works as before", async () => {
  outcome = ok("drifted");
  const result = await runDriftCheck(ORG, 4, "manual", "always");
  expect(result.ok && result.run.aiSummary).toBeNull();
});

test("only a new drift asks for the line: the one alert that shows it", async () => {
  outcome = ok("drifted");
  const describe = jest.fn(async () => "Live lost books.price.");
  const quiet = jest.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    // After a drifted row the alert is "Drift changed", after an unreachable
    // one it is "reachable again", and neither shows the line.
    newestRows({ id: 1, status: "drifted", fingerprint: "an older drift" });
    const changed = await runDriftCheck(ORG, 4, "scheduled", "on_change", { describe });
    newestRows({ id: 2, status: "unreachable", fingerprint: null });
    const reachable = await runDriftCheck(ORG, 4, "scheduled", "on_change", { describe });
    // A previous row that could not be read means no web alert at all.
    newestRows("fail");
    const unread = await runDriftCheck(ORG, 4, "scheduled", "on_change", { describe });
    // A person's check ("always") sends no alert either.
    newestRows();
    await runDriftCheck(ORG, 4, "manual", "always", { describe });
    expect(describe).not.toHaveBeenCalled();
    // Each was still written down, just without a line.
    for (const result of [changed, reachable, unread]) {
      expect(result.ok && result.run.recorded).toBe(true);
      expect(result.ok && result.run.aiSummary).toBeNull();
    }

    // After an in_sync row it is "Drift found", which does.
    newestRows({ id: 3, status: "in_sync", fingerprint: "x" }, { id: 3, status: "in_sync", fingerprint: "x" });
    const found = await runDriftCheck(ORG, 4, "scheduled", "on_change", { describe });
    expect(describe).toHaveBeenCalledTimes(1);
    expect(found.ok && found.run.aiSummary).toBe("Live lost books.price.");
  } finally {
    quiet.mockRestore();
  }
});

test("a row written while the AI wrote its line is not buried under this check's row", async () => {
  outcome = ok("drifted");
  // A person pressed Acknowledge (or Re-baseline) during the wait: the
  // newest row read after the wait is not the one read before it.
  newestRows({ id: 8, status: "in_sync", fingerprint: "x" }, { id: 9, status: "drifted", fingerprint: "acknowledged" });
  const result = await runDriftCheck(ORG, 4, "scheduled", "on_change", { describe: async () => "Live lost books.price." });
  expect(details()).toEqual([]);
  // Not recorded, so no alert goes out about it either.
  expect(result.ok && result.run.recorded).toBe(false);

  // The first row of all, and one landed during the wait.
  mockPoolQuery.mockClear();
  newestRows(null, { id: 1, status: "in_sync", fingerprint: "x" });
  await runDriftCheck(ORG, 4, "scheduled", "on_change", { describe: async () => "Live lost books.price." });
  expect(details()).toEqual([]);

  // Nothing new, or a second read that fails: the row is written as before.
  mockPoolQuery.mockClear();
  newestRows({ id: 8, status: "in_sync", fingerprint: "x" }, { id: "8", status: "in_sync", fingerprint: "x" });
  await runDriftCheck(ORG, 4, "scheduled", "on_change", { describe: async () => "Live lost books.price." });
  expect(details()).toHaveLength(1);
  mockPoolQuery.mockClear();
  const quiet = jest.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    newestRows({ id: 8, status: "in_sync", fingerprint: "x" }, "fail");
    await runDriftCheck(ORG, 4, "scheduled", "on_change", { describe: async () => "Live lost books.price." });
    expect(details()).toHaveLength(1);
  } finally {
    quiet.mockRestore();
  }
});
