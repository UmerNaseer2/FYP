// buildSwapHref: the "Compare the other way instead" link the Migration
// Workbench offers when a push would move the target backwards. The link must
// swap the two sides exactly, run at once, and never point at a side nobody
// picked.
import { buildSwapHref } from "../lib/compare-links";
import type { CurrentSelection } from "../lib/compare-selection";

// staging.public (connection 3) compared with prod.app (connection 7).
function selection(overrides: Partial<CurrentSelection> = {}): CurrentSelection {
  return {
    sourceConnectionId: 3,
    sourceConnectionLabel: "staging",
    sourceSchema: "public",
    allowDataLoss: false,
    compareData: false,
    targets: [{ connectionId: 7, connectionLabel: "prod", schema: "app" }],
    ...overrides,
  };
}

describe("buildSwapHref", () => {
  it("makes the one target the source, the source the target, and runs it", () => {
    expect(buildSwapHref(selection())).toBe(
      "/compare?sourceConnection=7&sourceSchema=app&targetConnection=3&targetSchema=public&run=1",
    );
  });

  it("keeps allow data loss on when it was on", () => {
    expect(buildSwapHref(selection({ allowDataLoss: true }))).toBe(
      "/compare?sourceConnection=7&sourceSchema=app&targetConnection=3&targetSchema=public&allowDataLoss=1&run=1",
    );
  });

  it("keeps compare row data on when it was on", () => {
    const href = buildSwapHref(selection({ compareData: true }));
    expect(href).not.toBeNull();
    const params = new URLSearchParams(href!.split("?")[1]);
    expect(params.get("compareData")).toBe("1");
    expect(params.get("allowDataLoss")).toBeNull();
    expect(params.get("run")).toBe("1");
  });

  it("encodes schema names the way the form would submit them", () => {
    const href = buildSwapHref(
      selection({ targets: [{ connectionId: 7, connectionLabel: "prod", schema: "my app" }] }),
    );
    const params = new URLSearchParams(href!.split("?")[1]);
    expect(params.get("sourceSchema")).toBe("my app");
    expect(params.get("targetSchema")).toBe("public");
  });

  it("is null with two targets: the other way has no single meaning", () => {
    expect(
      buildSwapHref(
        selection({
          targets: [
            { connectionId: 7, connectionLabel: "prod", schema: "app" },
            { connectionId: 8, connectionLabel: "qa", schema: "app" },
          ],
        }),
      ),
    ).toBeNull();
  });

  it("is null with no targets", () => {
    expect(buildSwapHref(selection({ targets: [] }))).toBeNull();
  });

  it("is null when the source has no saved connection", () => {
    expect(buildSwapHref(selection({ sourceConnectionId: null }))).toBeNull();
  });

  it("is null when the target has no saved connection", () => {
    expect(
      buildSwapHref(
        selection({ targets: [{ connectionId: null, connectionLabel: "gone", schema: "app" }] }),
      ),
    ).toBeNull();
  });
});
