import {
  databaseIdentity,
  findDuplicateTargets,
  missingConnectionMessage,
  missingSourceMessage,
  pickSchemaAfterConnectionChange,
  selectionToQuery,
  swapSourceWithTarget,
  type CurrentSelection,
} from "@/lib/compare-selection";

/**
 * The Compare screen's picker decisions. None of these touch a database, which
 * is the point: each one used to be an inline expression in the run code that
 * could only be checked by clicking through the page.
 */

describe("databaseIdentity", () => {
  it("treats every spelling of this machine as the same host", () => {
    const local = databaseIdentity({ host: "localhost", port: 5432, database: "app" });
    expect(databaseIdentity({ host: "127.0.0.1", port: 5432, database: "app" })).toBe(local);
    expect(databaseIdentity({ host: "::1", port: 5432, database: "app" })).toBe(local);
    expect(databaseIdentity({ host: undefined, port: 5432, database: "app" })).toBe(local);
  });

  it("ignores the case of the host and surrounding spaces", () => {
    expect(databaseIdentity({ host: " DB.Example.COM ", port: 5432, database: " app " })).toBe(
      databaseIdentity({ host: "db.example.com", port: 5432, database: "app" }),
    );
  });

  it("reads a missing port as PostgreSQL's default", () => {
    expect(databaseIdentity({ host: "db", database: "app" })).toBe(
      databaseIdentity({ host: "db", port: 5432, database: "app" }),
    );
    expect(databaseIdentity({ host: "db", port: "5432", database: "app" })).toBe(
      databaseIdentity({ host: "db", port: 5432, database: "app" }),
    );
  });

  it("keeps a different port, database or host apart", () => {
    const base = databaseIdentity({ host: "db", port: 5432, database: "app" });
    expect(databaseIdentity({ host: "db", port: 5433, database: "app" })).not.toBe(base);
    expect(databaseIdentity({ host: "db", port: 5432, database: "other" })).not.toBe(base);
    expect(databaseIdentity({ host: "db2", port: 5432, database: "app" })).not.toBe(base);
  });
});

describe("pickSchemaAfterConnectionChange", () => {
  it("keeps the same schema when the new database has it", () => {
    expect(pickSchemaAfterConnectionChange("sales", ["public", "sales"])).toBe("sales");
  });

  it("falls back to public, then to the first schema listed", () => {
    expect(pickSchemaAfterConnectionChange("sales", ["hr", "public"])).toBe("public");
    expect(pickSchemaAfterConnectionChange("sales", ["hr", "ops"])).toBe("hr");
    expect(pickSchemaAfterConnectionChange("", ["hr", "public"])).toBe("public");
  });

  it("gives an empty string when the database lists no schemas", () => {
    expect(pickSchemaAfterConnectionChange("sales", [])).toBe("");
  });
});

describe("findDuplicateTargets", () => {
  it("points each repeat at the first earlier copy", () => {
    expect(findDuplicateTargets(["a|public", "b|public", "a|public"])).toEqual([null, null, 0]);
    expect(findDuplicateTargets(["a", "a", "a"])).toEqual([null, 0, 0]);
  });

  it("returns all nulls when every key is different", () => {
    expect(findDuplicateTargets(["a", "b", "c"])).toEqual([null, null, null]);
    expect(findDuplicateTargets([])).toEqual([]);
  });
});

function selection(overrides: Partial<CurrentSelection> = {}): CurrentSelection {
  return {
    sourceConnectionId: 1,
    sourceConnectionLabel: "Dev (app)",
    sourceSchema: "public",
    allowDataLoss: false,
    compareData: false,
    targets: [
      { connectionId: 2, connectionLabel: "Staging (app)", schema: "public" },
      { connectionId: 3, connectionLabel: "Prod (app)", schema: "public" },
      { connectionId: 4, connectionLabel: "QA (app)", schema: "qa" },
    ],
    ...overrides,
  };
}

describe("swapSourceWithTarget", () => {
  it("moves the target to the source and the old source to the front of the targets", () => {
    const swapped = swapSourceWithTarget(selection(), 0);
    expect(swapped.sourceConnectionId).toBe(2);
    expect(swapped.sourceConnectionLabel).toBe("Staging (app)");
    expect(swapped.sourceSchema).toBe("public");
    expect(swapped.targets.map((t) => t.connectionId)).toEqual([1, 3, 4]);
    expect(swapped.targets[0]).toEqual({
      connectionId: 1,
      connectionLabel: "Dev (app)",
      schema: "public",
    });
  });

  it("keeps the other targets in order when the last one is swapped", () => {
    const swapped = swapSourceWithTarget(selection(), 2);
    expect(swapped.sourceConnectionId).toBe(4);
    expect(swapped.sourceSchema).toBe("qa");
    expect(swapped.targets.map((t) => t.connectionId)).toEqual([1, 2, 3]);
  });

  it("keeps the run options and ignores an index that is not there", () => {
    const withOptions = selection({ allowDataLoss: true, compareData: true });
    expect(swapSourceWithTarget(withOptions, 1).allowDataLoss).toBe(true);
    expect(swapSourceWithTarget(withOptions, 1).compareData).toBe(true);
    expect(swapSourceWithTarget(withOptions, 9)).toBe(withOptions);
  });
});

describe("selectionToQuery", () => {
  it("writes the targets in order, as parallel lists the server pairs by index", () => {
    const params = new URLSearchParams(selectionToQuery(selection()));
    expect(params.get("sourceConnection")).toBe("1");
    expect(params.get("sourceSchema")).toBe("public");
    expect(params.getAll("targetConnection")).toEqual(["2", "3", "4"]);
    expect(params.getAll("targetSchema")).toEqual(["public", "public", "qa"]);
  });

  it("writes a side with no connection as empty instead of dropping it", () => {
    const params = new URLSearchParams(
      selectionToQuery(
        selection({
          sourceConnectionId: null,
          targets: [
            { connectionId: null, connectionLabel: "Old prod", schema: "public" },
            { connectionId: 3, connectionLabel: "Prod (app)", schema: "sales" },
          ],
        }),
      ),
    );
    expect(params.has("sourceConnection")).toBe(true);
    expect(params.get("sourceConnection")).toBe("");
    expect(params.getAll("targetConnection")).toEqual(["", "3"]);
    expect(params.getAll("targetSchema")).toEqual(["public", "sales"]);
  });

  it("writes the run options only when they are on, and never asks for a run", () => {
    const off = new URLSearchParams(selectionToQuery(selection()));
    expect(off.has("allowDataLoss")).toBe(false);
    expect(off.has("compareData")).toBe(false);
    expect(off.has("run")).toBe(false);

    const on = new URLSearchParams(
      selectionToQuery(selection({ allowDataLoss: true, compareData: true })),
    );
    expect(on.get("allowDataLoss")).toBe("1");
    expect(on.get("compareData")).toBe("1");
  });
});

describe("missing connection messages", () => {
  it("names a deleted target connection by the label the set kept", () => {
    expect(missingConnectionMessage("", "Prod — RDS")).toBe(
      '"Prod — RDS" no longer exists — it was deleted. Pick another connection for this target, or remove it.',
    );
    expect(missingConnectionMessage("", "  ")).toMatch(/^The connection this set used for this target was deleted/);
  });

  it("falls back to the id, then to 'nothing picked'", () => {
    expect(missingConnectionMessage("7", null)).toMatch(/^Connection #7 does not exist/);
    expect(missingConnectionMessage("", null)).toBe(
      "No connection is picked for this target. Pick one, then press Compare.",
    );
  });

  it("says the same things about the source", () => {
    expect(missingSourceMessage("", "Dev box")).toMatch(/^The source connection "Dev box" no longer exists/);
    expect(missingSourceMessage("", "")).toMatch(/^The source connection this set used was deleted/);
    expect(missingSourceMessage("12", null)).toMatch(/^The source connection #12 does not exist/);
    expect(missingSourceMessage("", null)).toBe(
      "No source connection is picked. Pick one, then press Compare.",
    );
  });
});
