/** @jest-environment jsdom */

/**
 * The "Declared versions" bar above the Compare diff: what each schema says
 * about its own version, and what that means for the migration below it.
 *
 * A sync runs source → target. If the target is the side declaring the higher
 * version, the script below would move a newer schema backwards — so the bar
 * exists to be read before the diff is, and almost everything it does is about
 * being right on that one point:
 *
 *   Only backwards is coloured. A source that is ahead is the ordinary
 *   direction of a sync; a bar that shouted about it would teach the reader to
 *   ignore the colour by the time it matters. And with the two structures
 *   already matching there is no migration to move anything, so the warning
 *   goes away rather than warning about a push that cannot happen.
 *
 *   Versions compare only inside a script group. script_patch keeps several
 *   version lines at once, so when both sides keep groups the bar reads them
 *   group by group and can say each side is ahead somewhere — a divergence,
 *   where no single side is "the outdated one" and the table below marks each
 *   group instead.
 *
 *   Not finding a version is an answer. When neither side has a version table
 *   the bar shrinks to one line rather than disappearing, and that line carries
 *   each side's own reason, because a schema that keeps no versions and a
 *   schema whose version table could not be read are different problems.
 *
 * What is NOT here:
 *  - Which side actually is newer. determineNewerSchema decides that and writes
 *    the sentence under the pill; it is tests/version-detection.test.ts. The
 *    verdict is a prop here.
 *  - Reading a version table at all, and trimming what it found down to what
 *    travels to the browser: tests/detected-version.test.ts.
 *  - The rules this file prints through — displayVersion, familyHeadRows,
 *    compareFamilyHeads, listNames, outdatedSideFor and pushMovesTargetBack.
 *    They are tests/version-timeline.test.ts. What is pinned here is that the
 *    bar asks them, and where it puts their answers.
 *  - The timeline disclosure underneath. It arrives as a prop; the component
 *    that fills it is tests/component-compare-version-timeline.test.tsx and
 *    tests/component-version-timeline.test.tsx.
 *  - DetectedVersion.recent and recentComplete. The bar never reads them —
 *    they are the timeline's, which is why the fixtures here leave them empty.
 *  - The Compare screen that mounts this. tests/page-compare.test.tsx builds
 *    both sides with no detected version at all, so before this file only the
 *    one-line form had ever been drawn.
 */

import "@testing-library/jest-dom";
import { cleanup, render, screen, within } from "@testing-library/react";

import { VersionDetectBar } from "@/components/studio/VersionDetectBar";
import type { DetectedVersion } from "@/lib/detected-version";
import type { NewerSchemaVerdict } from "@/lib/version-detection";

/** A schema whose versions another tool keeps: no script groups. */
function flyway(over: Partial<DetectedVersion> = {}): DetectedVersion {
  return {
    table: "flyway_schema_history",
    version: "1.4",
    // The bar reads neither of these — they belong to the timeline below it.
    recent: [],
    recentComplete: true,
    familyHeads: null,
    message: "Version table found: flyway_schema_history",
    ...over,
  };
}

/** A schema this app writes: script_patch, one version line per script group. */
function scriptPatch(heads: Record<string, string>, over: Partial<DetectedVersion> = {}): DetectedVersion {
  return {
    table: "script_patch",
    version: Object.values(heads)[0] ?? null,
    recent: [],
    recentComplete: true,
    familyHeads: heads,
    message: "Version table found: script_patch",
    ...over,
  };
}

/** A schema the detector found no version table in. */
const NO_TABLE = flyway({
  table: null,
  version: null,
  message: "no version table in this schema",
});

/** A schema whose version table could not be read at all. */
const UNREADABLE = flyway({
  table: null,
  version: null,
  message: "could not read a version table — permission denied for schema ops",
});

function bar(over: Partial<Parameters<typeof VersionDetectBar>[0]> = {}) {
  return render(
    <VersionDetectBar
      sourceName="staging.public"
      source={flyway()}
      targetName="prod.public"
      target={flyway({ version: "1.2" })}
      verdict={{ newer: "left", reason: "staging.public is ahead." }}
      inSync={false}
      {...over}
    />
  );
}

/** What each side's row says, in the order the bar draws them. */
function sides(container: HTMLElement) {
  const read = (el: Element) => ({
    role: el.querySelector(".verdet__role")?.textContent ?? "",
    // The version node carries "(Outdated)" when the verdict calls this side
    // behind, so one reading pins the number and the label together.
    version: (el.querySelector(".verdet__ver")?.textContent ?? "").trim(),
    from: (el.querySelector(".verdet__from")?.textContent ?? "").trim(),
  });
  const [source, target] = Array.from(container.querySelectorAll(".verdet__side"));
  return { source: read(source), target: read(target) };
}

const section = (container: HTMLElement) => container.querySelector(".verdet") as HTMLElement;
const pill = (container: HTMLElement) => container.querySelector(".verdet__verdict")?.textContent;
const why = (container: HTMLElement) => container.querySelector(".verdet__why")?.textContent ?? "";
const lead = (container: HTMLElement) => container.querySelector(".verdet__why b")?.textContent ?? null;

afterEach(() => cleanup());

describe("when neither side has a version table", () => {
  it("shrinks to one line instead of disappearing", () => {
    const { container } = bar({ source: NO_TABLE, target: NO_TABLE, verdict: null });

    expect(section(container)).toHaveClass("verdet--quiet");
    expect(screen.getByText("Declared versions")).toBeInTheDocument();
    expect(
      screen.getByText(/No version to compare, so the structural diff below is the whole answer\./)
    ).toBeInTheDocument();
    expect(container.querySelectorAll(".verdet__side")).toHaveLength(0);
  });

  it("gives each side's own reason, so a failed read is not read as 'keeps none'", () => {
    const { container } = bar({ source: NO_TABLE, target: UNREADABLE, verdict: null });

    const text = container.textContent ?? "";
    expect(text).toContain("staging.public: no version table in this schema");
    expect(text).toContain(
      "prod.public: could not read a version table — permission denied for schema ops"
    );
  });

  it("says a side was not read at all when nothing was detected for it", () => {
    const { container } = bar({ source: null, target: null, verdict: null });

    expect(container.textContent).toContain("staging.public: not read");
    expect(container.textContent).toContain("prod.public: not read");
  });

  it("shows no verdict, because there is nothing to have one about", () => {
    const { container } = bar({
      source: NO_TABLE,
      target: NO_TABLE,
      verdict: { newer: "unknown", reason: "Neither schema records a version." },
    });

    expect(pill(container)).toBeUndefined();
    expect(screen.queryByText(/Neither schema records a version\./)).not.toBeInTheDocument();
  });
});

describe("when only one side has a version table", () => {
  it("draws the full bar, and says of the other side what the detector said", () => {
    const { container } = bar({
      target: UNREADABLE,
      verdict: { newer: "unknown", reason: "prod.public records no version of its own." },
    });

    const { source, target } = sides(container);
    expect(source.version).toBe("1.4");
    expect(target.version).toBe("no version");
    expect(target.from).toBe("could not read a version table — permission denied for schema ops");
    expect(why(container)).toContain("prod.public records no version of its own.");
  });
});

describe("what each side declares", () => {
  it("names the role, the schema and the version, source first", () => {
    // A verdict that calls neither side behind, so this reads the numbers
    // alone — the "(Outdated)" label has its own tests below.
    const { container } = bar({
      source: flyway({ version: "1.4" }),
      target: flyway({ version: "1.2" }),
      verdict: { newer: "unknown", reason: "Two different version schemes." },
    });
    const { source, target } = sides(container);

    expect(source.role).toBe("source");
    expect(target.role).toBe("target");
    expect(source.version).toBe("1.4");
    expect(target.version).toBe("1.2");
    expect(container.textContent).toContain("staging.public");
    expect(container.textContent).toContain("prod.public");
  });

  it("says which table the version was read from", () => {
    const { container } = bar();
    expect(sides(container).source.from).toBe("from flyway_schema_history");
  });

  it("prints another tool's version exactly as that tool wrote it", () => {
    // "v20240115120000" is a spelling nobody used. Only a version this app
    // wrote — one in a script group — is printed the way Deploy prints it.
    const { container } = bar({ source: flyway({ version: "20240115120000" }) });
    expect(sides(container).source.version).toBe("20240115120000");
  });

  it("marks the side the verdict calls behind", () => {
    const { container } = bar({ verdict: { newer: "left", reason: "Source is ahead." } });
    expect(sides(container).target.version).toBe("1.2 (Outdated)");
    expect(sides(container).source.version).toBe("1.4");
  });

  it("marks the source when the target is the one ahead", () => {
    const { container } = bar({ verdict: { newer: "right", reason: "Target is ahead." } });
    expect(sides(container).source.version).toBe("1.4 (Outdated)");
    expect(sides(container).target.version).toBe("1.2");
  });

  it("marks neither side when the two agree or nobody is behind everywhere", () => {
    for (const newer of ["same", "diverged", "unknown"] as const) {
      const { container } = bar({ verdict: { newer, reason: "…" } });
      expect(container.textContent).not.toContain("(Outdated)");
      cleanup();
    }
  });

  it("does not label a side with no version at all as outdated", () => {
    // "no version (Outdated)" says a schema that records nothing is behind a
    // schema that records something, which is not what the detector compared.
    const { container } = bar({
      source: NO_TABLE,
      verdict: { newer: "right", reason: "Only the target records a version." },
    });
    expect(sides(container).source.version).toBe("no version");
    expect(container.textContent).not.toContain("(Outdated)");
  });
});

describe("the verdict", () => {
  const LABELS: [NewerSchemaVerdict["newer"], string][] = [
    ["left", "source ahead"],
    ["right", "target ahead"],
    ["same", "same version"],
    ["diverged", "diverged"],
    ["unknown", "not comparable"],
  ];

  it("says which direction, not which number", () => {
    for (const [newer, label] of LABELS) {
      const { container } = bar({ verdict: { newer, reason: "…" } });
      expect(pill(container)).toBe(label);
      cleanup();
    }
  });

  it("prints the reason the detector wrote", () => {
    const { container } = bar({
      verdict: { newer: "left", reason: "staging.public is at 1.4; prod.public is at 1.2." },
    });
    expect(why(container)).toContain("staging.public is at 1.4; prod.public is at 1.2.");
  });

  it("says nothing at all when there is no verdict", () => {
    const { container } = bar({ verdict: null });
    expect(pill(container)).toBeUndefined();
    expect(container.querySelector(".verdet__why")).toBeNull();
    // The sides are still worth drawing: each one still declares something.
    expect(container.querySelectorAll(".verdet__side")).toHaveLength(2);
  });
});

describe("script groups", () => {
  it("makes the group's head the headline, and names the group", () => {
    const { container } = bar({
      source: scriptPatch({ users_migration: "3.0.0" }),
      target: scriptPatch({ users_migration: "1.0.0" }),
    });

    const { source, target } = sides(container);
    expect(source.version).toBe("v3.0.0");
    expect(source.from).toBe("from script_patch, script group users_migration");
    expect(target.version).toBe("v1.0.0 (Outdated)");
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("counts the groups in the headline when there is more than one", () => {
    const { container } = bar({
      source: scriptPatch({ users_migration: "3.0.0", orders_migration: "1.0.0" }),
      target: scriptPatch({ users_migration: "1.0.0", orders_migration: "1.0.0" }),
      verdict: { newer: "left", reason: "…" },
    });

    const { source } = sides(container);
    expect(source.version).toBe("2 script groups");
    // No one group to name: the table below has them.
    expect(source.from).toBe("from script_patch");
  });

  it("gives every group a row, with each side's head", () => {
    bar({
      source: scriptPatch({ users_migration: "3.0.0", orders_migration: "1.0.0" }),
      target: scriptPatch({ users_migration: "1.0.0", orders_migration: "2.0.0" }),
      verdict: { newer: "diverged", reason: "…" },
    });

    const rows = within(screen.getByRole("table"))
      .getAllByRole("row")
      .slice(1)
      .map((row) => Array.from(row.querySelectorAll("td")).map((td) => td.textContent?.trim()));

    expect(rows).toEqual([
      ["orders_migration", "v1.0.0 (Outdated)", "v2.0.0"],
      ["users_migration", "v3.0.0", "v1.0.0 (Outdated)"],
    ]);
  });

  it("calls a side with no version in a group behind in it", () => {
    // The other side has versions there that this one does not, which is what
    // being behind in that group means.
    const { container } = bar({
      source: scriptPatch({ users_migration: "3.0.0", orders_migration: "1.0.0" }),
      target: scriptPatch({ users_migration: "3.0.0" }),
      verdict: { newer: "left", reason: "…" },
    });

    const rows = within(screen.getByRole("table"))
      .getAllByRole("row")
      .slice(1)
      .map((row) => Array.from(row.querySelectorAll("td")).map((td) => td.textContent?.trim()));

    expect(rows).toContainEqual(["orders_migration", "v1.0.0", "none (Outdated)"]);
    expect(container.querySelector(".verdet__fam td.is-none")).toBeInTheDocument();
  });

  it("reads one declared version when only one side keeps groups", () => {
    // The detector compares group by group only when both sides have groups,
    // so a bar that printed groups here would be showing a comparison that
    // was never made.
    const { container } = bar({
      source: scriptPatch({ users_migration: "3.0.0" }),
      target: flyway({ version: "1.2" }),
      verdict: { newer: "unknown", reason: "…" },
    });

    const { source } = sides(container);
    expect(source.version).toBe("v3.0.0");
    expect(source.from).toBe("from script_patch");
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });
});

describe("the sentence above the reason", () => {
  const DIVERGED: NewerSchemaVerdict = { newer: "diverged", reason: "Each side is ahead somewhere." };

  it("warns that the migration would move the target backwards", () => {
    const { container } = bar({
      verdict: { newer: "right", reason: "prod.public is ahead." },
      inSync: false,
    });
    expect(lead(container)).toBe(
      "The migration below would move the target backwards. The push button below asks you to confirm first."
    );
    expect(why(container)).toContain("prod.public is ahead.");
  });

  it("says there is nothing to push when the structures already match", () => {
    // Nothing would move, so warning about a backwards push would be warning
    // about something the button cannot do.
    const { container } = bar({
      verdict: { newer: "right", reason: "prod.public is ahead." },
      inSync: true,
    });
    expect(lead(container)).toContain("The structures already match, so there is nothing to push.");
  });

  it("names the groups a divergence would move backwards", () => {
    const { container } = bar({
      source: scriptPatch({ users_migration: "3.0.0", orders_migration: "1.0.0" }),
      target: scriptPatch({ users_migration: "1.0.0", orders_migration: "2.0.0" }),
      verdict: DIVERGED,
      inSync: false,
    });
    expect(lead(container)).toBe(
      "The migration below would move the target backwards in orders_migration. " +
        "The push button below asks you to confirm first."
    );
  });

  it("still warns when the verdict says diverged but neither side lists a group", () => {
    const { container } = bar({ verdict: DIVERGED, inSync: false });
    expect(lead(container)).toContain(
      "would move the target backwards in the script groups where it is ahead"
    );
  });

  it("says there is nothing to push when a divergence is only in the numbers", () => {
    const { container } = bar({
      source: scriptPatch({ users_migration: "3.0.0", orders_migration: "1.0.0" }),
      target: scriptPatch({ users_migration: "1.0.0", orders_migration: "2.0.0" }),
      verdict: DIVERGED,
      inSync: true,
    });
    expect(lead(container)).toBe(
      "The structures already match, so there is nothing to push. Only the declared versions differ."
    );
  });

  it("says nothing extra in the ordinary direction", () => {
    for (const newer of ["left", "same", "unknown"] as const) {
      const { container } = bar({ verdict: { newer, reason: "Nothing alarming." } });
      expect(lead(container)).toBeNull();
      expect(why(container)).toBe("Nothing alarming.");
      cleanup();
    }
  });
});

describe("the colour", () => {
  it("colours the bar only where the push would go backwards", () => {
    for (const newer of ["right", "diverged"] as const) {
      const { container } = bar({ verdict: { newer, reason: "…" }, inSync: false });
      expect(section(container)).toHaveClass("verdet--back");
      cleanup();
    }
  });

  it("drops the colour once the structures match, as the push button does", () => {
    for (const newer of ["right", "diverged"] as const) {
      const { container } = bar({ verdict: { newer, reason: "…" }, inSync: true });
      expect(section(container).className).not.toContain("verdet--back");
      cleanup();
    }
  });

  it("marks the ordinary direction without alarm", () => {
    const { container } = bar({ verdict: { newer: "left", reason: "…" } });
    expect(section(container)).toHaveClass("verdet--fwd");
    expect(section(container).className).not.toContain("verdet--back");
  });

  it("leaves the bar plain when nobody is ahead", () => {
    for (const newer of ["same", "unknown"] as const) {
      const { container } = bar({ verdict: { newer, reason: "…" } });
      expect(section(container).className).not.toContain("verdet--back");
      expect(section(container).className).not.toContain("verdet--fwd");
      cleanup();
    }
  });
});

describe("the timeline underneath", () => {
  it("shows whatever was handed to it, after the reason", () => {
    const { container } = bar({ timeline: <p>Version timeline</p> });
    const text = container.textContent ?? "";
    expect(text).toContain("Version timeline");
    expect(text.indexOf("Version timeline")).toBeGreaterThan(text.indexOf("staging.public is ahead."));
  });

  it("leaves the space empty when there is none", () => {
    const { container } = bar();
    expect(container.textContent).not.toContain("Version timeline");
  });
});
