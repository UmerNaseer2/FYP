// lineage-db: the one-line summary stored on a drift event.
//
// It read "1 table(s) added" and "3 view/function/grant change(s)", on the
// Drift and Lineage screens, where every other count is a proper plural. The
// last one also named three kinds of object while counting sequences, types
// and extensions as well.
//
// Nothing here reaches a database: the metadata pool is a stand-in.
jest.mock("../lib/version-db", () => ({
  __esModule: true,
  default: {},
  syncMetadataTables: async () => undefined,
}));

import { buildDriftSummary, type DriftCounts } from "../lib/lineage-db";

const none: DriftCounts = { tablesAdded: 0, tablesRemoved: 0, tablesChanged: 0, constraintsChanged: 0 };

describe("buildDriftSummary", () => {
  it("counts one of a thing as one and more as more", () => {
    expect(
      buildDriftSummary("1.2.0", {
        ...none,
        tablesAdded: 1,
        tablesRemoved: 2,
        tablesChanged: 1,
        constraintsChanged: 2,
        objectsChanged: 1,
      })
    ).toBe(
      "Drift vs v1.2.0: 1 table added, 2 tables removed, 1 table changed, 2 constraints changed, 1 other object change."
    );
    expect(buildDriftSummary("1.2.0", { ...none, constraintsChanged: 1, objectsChanged: 3 })).toBe(
      "Drift vs v1.2.0: 1 constraint changed, 3 other object changes."
    );
  });

  it("says in sync when nothing differs", () => {
    expect(buildDriftSummary("1.2.0", none)).toBe("In sync with v1.2.0 — no structural drift.");
  });
});
