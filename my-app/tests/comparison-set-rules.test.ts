import {
  isNameConflict,
  matchesSet,
  MAX_COMPARISON_TARGETS,
  parseSaveBody,
  saveButtonLabel,
  setOptionLabel,
  validateSaveInput,
  type SaveComparisonSetInput,
} from "@/lib/comparison-set-rules";

/**
 * Saved comparison sets, minus the database: what a save request is read as,
 * what is refused and in which words, and when the screen still counts as the
 * set it was opened from.
 */

function input(overrides: Partial<SaveComparisonSetInput> = {}): SaveComparisonSetInput {
  return {
    id: null,
    overwrite: false,
    name: "Nightly",
    sourceConnectionId: 1,
    sourceConnectionLabel: "Dev (app)",
    sourceSchema: "public",
    allowDataLoss: false,
    compareData: false,
    targets: [
      { connectionId: 2, connectionLabel: "Staging (app)", schema: "public" },
      { connectionId: 3, connectionLabel: "Prod (app)", schema: "public" },
    ],
    ...overrides,
  };
}

describe("parseSaveBody", () => {
  it("reads a well-formed body as it was sent", () => {
    const parsed = parseSaveBody({
      id: 4,
      overwrite: true,
      name: "Nightly",
      sourceConnectionId: 1,
      sourceConnectionLabel: "Dev (app)",
      sourceSchema: "public",
      allowDataLoss: true,
      compareData: true,
      targets: [{ connectionId: "2", connectionLabel: "Staging", schema: "public" }],
    });
    expect(parsed).toEqual({
      id: 4,
      overwrite: true,
      name: "Nightly",
      sourceConnectionId: 1,
      sourceConnectionLabel: "Dev (app)",
      sourceSchema: "public",
      allowDataLoss: true,
      compareData: true,
      targets: [{ connectionId: 2, connectionLabel: "Staging", schema: "public" }],
    });
  });

  it("turns the row-data option on only for an actual true", () => {
    expect(parseSaveBody({ compareData: true }).compareData).toBe(true);
    expect(parseSaveBody({ compareData: false }).compareData).toBe(false);
    expect(parseSaveBody({ compareData: "true" }).compareData).toBe(false);
    expect(parseSaveBody({}).compareData).toBe(false);
  });

  it("never fails: anything missing or mistyped becomes empty, null or false", () => {
    for (const body of [null, "text", 42, [], undefined]) {
      expect(parseSaveBody(body)).toEqual({
        id: null,
        overwrite: false,
        name: "",
        sourceConnectionId: null,
        sourceConnectionLabel: "",
        sourceSchema: "",
        allowDataLoss: false,
        compareData: false,
        targets: [],
      });
    }
    const odd = parseSaveBody({
      id: 0,
      sourceConnectionId: 3.5,
      overwrite: "yes",
      targets: [null, { connectionId: -1, schema: 7 }],
    });
    expect(odd.id).toBeNull();
    expect(odd.sourceConnectionId).toBeNull();
    expect(odd.overwrite).toBe(false);
    expect(odd.targets).toEqual([
      { connectionId: null, connectionLabel: "", schema: "" },
      { connectionId: null, connectionLabel: "", schema: "" },
    ]);
  });

  it("caps the stored labels", () => {
    const parsed = parseSaveBody({ sourceConnectionLabel: "x".repeat(500) });
    expect(parsed.sourceConnectionLabel).toHaveLength(200);
  });
});

describe("validateSaveInput", () => {
  it("accepts a complete set", () => {
    expect(validateSaveInput(input())).toBeNull();
  });

  it("needs a name of a sensible length", () => {
    expect(validateSaveInput(input({ name: "   " }))).toBe(
      "Give the set a name so you can find it again.",
    );
    expect(validateSaveInput(input({ name: "x".repeat(61) }))).toBe(
      "Set names are limited to 60 characters.",
    );
    expect(validateSaveInput(input({ name: "x".repeat(60) }))).toBeNull();
  });

  it("needs a source connection and schema", () => {
    expect(validateSaveInput(input({ sourceConnectionId: null }))).toBe(
      "The source has no connection — pick one before saving.",
    );
    expect(validateSaveInput(input({ sourceSchema: " " }))).toBe("The source schema is missing.");
  });

  it("needs between one and the maximum number of targets", () => {
    expect(validateSaveInput(input({ targets: [] }))).toBe("A set needs at least one target.");
    const tooMany = Array.from({ length: MAX_COMPARISON_TARGETS + 1 }, (_, i) => ({
      connectionId: 10 + i,
      connectionLabel: `c${i}`,
      schema: "public",
    }));
    expect(validateSaveInput(input({ targets: tooMany }))).toBe(
      "A set can hold at most 6 targets.",
    );
  });

  it("names the target that has no connection or no schema", () => {
    expect(
      validateSaveInput(
        input({
          targets: [
            { connectionId: 2, connectionLabel: "", schema: "public" },
            { connectionId: null, connectionLabel: "Gone", schema: "public" },
          ],
        }),
      ),
    ).toBe("Target 2 has no connection — pick one before saving.");
    expect(
      validateSaveInput(
        input({ targets: [{ connectionId: 2, connectionLabel: "", schema: "  " }] }),
      ),
    ).toBe("Target 1 has no schema selected.");
  });

  it("refuses a target that is the source itself", () => {
    expect(
      validateSaveInput(
        input({
          targets: [
            { connectionId: 2, connectionLabel: "", schema: "public" },
            { connectionId: 1, connectionLabel: "", schema: " public " },
          ],
        }),
      ),
    ).toBe("Target 2 is the same connection and schema as the source.");
    // Same connection, different schema is an ordinary comparison.
    expect(
      validateSaveInput(
        input({ targets: [{ connectionId: 1, connectionLabel: "", schema: "sales" }] }),
      ),
    ).toBeNull();
  });

  it("names both targets when one repeats another", () => {
    expect(
      validateSaveInput(
        input({
          targets: [
            { connectionId: 2, connectionLabel: "", schema: "public" },
            { connectionId: 3, connectionLabel: "", schema: "public" },
            { connectionId: 2, connectionLabel: "", schema: "public" },
          ],
        }),
      ),
    ).toBe("Targets 1 and 3 are the same connection and schema.");
  });
});

describe("matchesSet", () => {
  const saved = {
    sourceConnectionId: 1,
    sourceSchema: "public",
    allowDataLoss: false,
    compareData: true,
    targets: [
      { connectionId: 2, schema: "public" },
      { connectionId: 3, schema: "public" },
    ],
  };

  it("is true for the selection the set was saved from", () => {
    expect(matchesSet(saved, { ...saved, targets: saved.targets.map((t) => ({ ...t })) })).toBe(true);
  });

  it("notices each kind of change", () => {
    expect(matchesSet(saved, { ...saved, compareData: false })).toBe(false);
    expect(matchesSet(saved, { ...saved, allowDataLoss: true })).toBe(false);
    expect(matchesSet(saved, { ...saved, sourceSchema: "sales" })).toBe(false);
    expect(matchesSet(saved, { ...saved, targets: [...saved.targets].reverse() })).toBe(false);
    expect(
      matchesSet(saved, { ...saved, targets: [saved.targets[0], { connectionId: 3, schema: "sales" }] }),
    ).toBe(false);
    expect(matchesSet(saved, { ...saved, targets: [saved.targets[0]] })).toBe(false);
  });

  it("still matches a set whose deleted connections are shown as missing", () => {
    const withGap = { ...saved, targets: [{ connectionId: null, schema: "public" }] };
    expect(matchesSet(withGap, { ...withGap, targets: [{ connectionId: null, schema: "public" }] })).toBe(true);
  });
});

describe("saveButtonLabel", () => {
  it("says what pressing it will do", () => {
    expect(saveButtonLabel(null, "x")).toBe("Save");
    expect(saveButtonLabel("Nightly", "nightly ")).toBe("Update");
    expect(saveButtonLabel("Nightly", "Weekly")).toBe("Save as new");
    expect(saveButtonLabel("Nightly", "  ")).toBe("Save");
  });
});

describe("isNameConflict", () => {
  it("is a conflict only when the name belongs to another set and nobody confirmed", () => {
    expect(isNameConflict(null, null, false)).toBe(false);
    expect(isNameConflict(3, 3, false)).toBe(false);
    expect(isNameConflict(3, null, false)).toBe(true);
    expect(isNameConflict(3, 5, false)).toBe(true);
    expect(isNameConflict(3, 5, true)).toBe(false);
  });
});

describe("setOptionLabel", () => {
  const plain = {
    name: "Nightly",
    targetCount: 1,
    hasProduction: false,
    compareData: false,
    hasMissingConnection: false,
  };

  it("counts targets in the singular and the plural", () => {
    expect(setOptionLabel(plain, "never run")).toBe("Nightly · 1 target · never run");
    expect(setOptionLabel({ ...plain, targetCount: 3 }, "run 2h ago")).toBe(
      "Nightly · 3 targets · run 2h ago",
    );
  });

  it("adds each flag on its own, and all of them in a fixed order", () => {
    expect(setOptionLabel({ ...plain, hasProduction: true }, "never run")).toBe(
      "Nightly · 1 target · prod · never run",
    );
    expect(setOptionLabel({ ...plain, compareData: true }, "never run")).toBe(
      "Nightly · 1 target · row data · never run",
    );
    expect(setOptionLabel({ ...plain, hasMissingConnection: true }, "never run")).toBe(
      "Nightly · 1 target · connection deleted · never run",
    );
    expect(
      setOptionLabel(
        { ...plain, targetCount: 2, hasProduction: true, compareData: true, hasMissingConnection: true },
        "run 5m ago",
      ),
    ).toBe("Nightly · 2 targets · prod · row data · connection deleted · run 5m ago");
  });
});
