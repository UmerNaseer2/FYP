/** @jest-environment jsdom */

/**
 * VersionTimeline: the one drawing of "which versions does each side have",
 * shared by Compare, Version Sync and Deploy (spec features 5, 7 and 9).
 *
 * It fetches nothing and decides nothing — the screen merges the two sides
 * with lib/version-timeline and hands the rows over. What it does decide is
 * how each row reads, and three of those readings are worth a suite:
 *
 *   A gap is never a guess. A side's list can be partial — the newest few
 *   entries and each group's head — and below where it stops, whether that
 *   side ever had a version is simply not known. That cell gets "?" and says
 *   "not known"; drawing it as "not recorded" would be a claim about a side
 *   nobody read that far down.
 *
 *   Two sides can store different scripts under one version number, and that
 *   is exactly the thing somebody opening this is looking for. Showing one of
 *   them silently would be a claim that they match, so the row says they
 *   differ and lets the reader pick whose to read.
 *
 *   A button inside a row does its own job and nothing else. The whole row is
 *   a click target that opens the script, so Run and Roll back sit in a cell
 *   that stops the click — otherwise pressing Roll back would also unfold a
 *   script nobody asked for, over the dialog it just opened.
 *
 * What is NOT here:
 *  - The merge itself: which versions pair up, which side is head, which side
 *    is behind, and the spelling-insensitive key that pairs "v1.2.0" with
 *    "1.2.0" are all lib/version-timeline, with tests/version-timeline.test.ts.
 *    This suite builds rows by hand and checks only what is drawn from them.
 *  - The screens that use it. Compare, Version Sync and Deploy each have their
 *    own rendered suite; what is checked here is the drawing they share.
 *  - Colour. The markers and level dots are aria-hidden, and every one of them
 *    has words beside it in a screen-reader-only span — those words are what
 *    is asserted, because they are what the drawing actually promises.
 */

import "@testing-library/jest-dom";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

import {
  NO_STORED_SCRIPT,
  VersionTimeline,
  type VersionTimelineProps,
} from "@/components/studio/VersionTimeline";
import {
  timelineKey,
  type TimelineEntry,
  type TimelineRow,
} from "@/lib/version-timeline";

/* ----------------------------------------------------------------- fixtures */

const entry = (over: Partial<TimelineEntry> & { version: string }): TimelineEntry => ({
  scriptName: null,
  appliedAt: "2026-09-10T09:00:00.000Z",
  appliedBy: null,
  changeType: "patch",
  sqlContent: null,
  ...over,
});

/** One merged row, keyed the way mergeTimelines keys it. */
const row = (over: Partial<TimelineRow> & { version: string }): TimelineRow => ({
  family: null,
  key: timelineKey(over.version),
  left: null,
  right: null,
  isLeftHead: false,
  isRightHead: false,
  leftUnknown: false,
  rightUnknown: false,
  changeType: "patch",
  ...over,
});

const LEFT = "Registry (GitHub)";
const RIGHT = "prod.public";

/** Both sides have it. */
const BOTH = row({
  version: "1.2.0",
  left: entry({ version: "1.2.0" }),
  right: entry({ version: "v1.2.0" }),
});

/* ------------------------------------------------------------------ helpers */

function show(props: Partial<VersionTimelineProps> = {}) {
  const merged: VersionTimelineProps = {
    leftLabel: LEFT,
    rightLabel: RIGHT,
    rows: [BOTH],
    outdatedSide: null,
    ...props,
  };
  return render(<VersionTimeline {...merged} />);
}

/** The row's own button — what a keyboard reaches, and what carries aria-expanded. */
const versionToggle = (text: string) =>
  screen.getByText(text).closest("button") as HTMLElement;

afterEach(() => cleanup());

/* -------------------------------------------------------------------- tests */

describe("when there is nothing on the axis", () => {
  it("says so in the words the screen chose", () => {
    show({ rows: [], emptyText: "This connection has no version table." });

    expect(screen.getByText("This connection has no version table.")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("has its own sentence when the screen chose none", () => {
    show({ rows: [] });

    expect(screen.getByText("Neither side records a version.")).toBeInTheDocument();
  });

  it("still prints the note above it, because that is what explains the emptiness", () => {
    show({ rows: [], note: "Only the newest five versions are read." });

    expect(screen.getByText("Only the newest five versions are read.")).toBeInTheDocument();
  });
});

describe("what each side's cell says", () => {
  it("names the side in every answer, so a cell read on its own still means something", () => {
    show({
      rows: [row({ version: "1.2.0", left: entry({ version: "1.2.0" }) })],
    });

    expect(screen.getByText(`${LEFT} records this version.`)).toBeInTheDocument();
    expect(screen.getByText(`${RIGHT} does not record this version.`)).toBeInTheDocument();
  });

  it("says a gap is not known rather than not recorded", () => {
    // The point of the "?" column. The right side's list stopped above this
    // version, so "does not record it" is a claim nobody checked.
    show({
      rows: [row({ version: "1.0.0", left: entry({ version: "1.0.0" }), rightUnknown: true })],
    });

    expect(
      screen.getByText(`Not known: this is older than the entries read from ${RIGHT}.`)
    ).toBeInTheDocument();
    expect(screen.queryByText(`${RIGHT} does not record this version.`)).not.toBeInTheDocument();
  });

  it("separates a failed run from a version that ran", () => {
    show({
      rows: [row({ version: "1.2.0", right: entry({ version: "1.2.0", failed: true }) })],
    });

    expect(
      screen.getByText(`${RIGHT} records this version as a failed run.`)
    ).toBeInTheDocument();
  });

  it("prints the day it was applied, in UTC, and who ran it in the tooltip", () => {
    // The date is the visible anchor; an address beside it would push the
    // version out of a two-column row, so the audit answer is on hover.
    show({
      rows: [
        row({
          version: "1.2.0",
          left: entry({
            version: "1.2.0",
            appliedAt: "2026-09-10T23:30:00.000Z",
            appliedBy: "umer@example.com",
          }),
        }),
      ],
    });

    const when = screen.getByText("Sep 10, 2026");
    expect(when).toHaveAttribute("title", "Applied Sep 10, 2026 by umer@example.com");
  });

  it("says plainly that a row does not record who ran it", () => {
    show({
      rows: [
        row({
          version: "1.2.0",
          left: entry({ version: "1.2.0", appliedAt: "2026-09-10T09:00:00.000Z", appliedBy: null }),
        }),
      ],
    });

    expect(screen.getByText("Sep 10, 2026")).toHaveAttribute(
      "title",
      "Applied Sep 10, 2026. This row does not record who ran it."
    );
  });

  it("prints no date at all when the side's table does not keep one", () => {
    show({
      rows: [row({ version: "1.2.0", left: entry({ version: "1.2.0", appliedAt: null }) })],
    });

    expect(screen.queryByText(/2026/)).not.toBeInTheDocument();
  });

  it("carries the status word a screen put on the row", () => {
    show({
      rows: [
        row({
          version: "1.2.0",
          left: entry({ version: "1.2.0" }),
          rightStatus: { text: "Pending", tone: "pending", title: "Not run on this database yet." },
        }),
      ],
    });

    expect(screen.getByText("Pending")).toHaveAttribute(
      "title",
      "Not run on this database yet."
    );
  });
});

describe("where each side is now", () => {
  it("marks each side's current version, and says so in the legend", () => {
    show({
      rows: [
        row({ version: "1.2.0", left: entry({ version: "1.2.0" }), isLeftHead: true }),
        row({
          version: "1.1.0",
          left: entry({ version: "1.1.0" }),
          right: entry({ version: "1.1.0" }),
          isRightHead: true,
        }),
      ],
    });

    expect(screen.getAllByText("HEAD")).toHaveLength(3); // two cells and the legend
    expect(screen.getByText("current version")).toBeInTheDocument();
  });

  it("leaves HEAD out of the legend when no row is anyone's head", () => {
    show();

    expect(screen.queryByText("HEAD")).not.toBeInTheDocument();
  });

  it("puts each side's version in its heading when the screen asks", () => {
    show({
      showHeadVersions: true,
      outdatedSide: "right",
      rows: [
        row({ version: "1.2.0", left: entry({ version: "1.2.0" }), isLeftHead: true }),
        row({
          version: "1.1.0",
          left: entry({ version: "1.1.0" }),
          right: entry({ version: "1.1.0" }),
          isRightHead: true,
        }),
      ],
    });

    const headings = screen.getAllByRole("columnheader");
    expect(headings[1]).toHaveTextContent(`${LEFT} — 1.2.0`);
    expect(headings[2]).toHaveTextContent(`${RIGHT} — 1.1.0 (Outdated)`);
  });

  it("names no head version when the rows hold more than one script group", () => {
    // Each group has its own head, so one version beside the side's name would
    // be a claim about the other groups that nothing checked.
    show({
      showHeadVersions: true,
      rows: [
        row({
          version: "1.2.0",
          family: "users",
          left: entry({ version: "1.2.0", scriptName: "users" }),
          isLeftHead: true,
        }),
        row({
          version: "3.0.0",
          family: "orders",
          left: entry({ version: "3.0.0", scriptName: "orders" }),
          isLeftHead: true,
        }),
      ],
    });

    expect(screen.getAllByRole("columnheader")[1]).toHaveTextContent(LEFT);
    expect(screen.getAllByRole("columnheader")[1]).not.toHaveTextContent("—");
  });
});

describe("script groups", () => {
  it("heads each group, and says which version numbers belong to a group", () => {
    show({
      rows: [
        row({
          version: "1.2.0",
          family: "users_migration",
          left: entry({ version: "1.2.0", scriptName: "users_migration" }),
        }),
      ],
    });

    expect(screen.getByRole("columnheader", { name: /Script group users_migration/ }))
      .toBeInTheDocument();
    expect(screen.getByText("v1.2.0")).toBeInTheDocument();
  });

  it("draws no group headings at all when no row has a group", () => {
    // A Flyway table has none, and "No script group" over every row is noise.
    show();

    expect(screen.queryByText(/Script group/)).not.toBeInTheDocument();
    expect(screen.queryByText("No script group")).not.toBeInTheDocument();
    expect(screen.getByText("1.2.0")).toBeInTheDocument();
  });

  it("names the ungrouped rows when they sit beside grouped ones", () => {
    show({
      rows: [
        row({
          version: "1.2.0",
          family: "users_migration",
          left: entry({ version: "1.2.0", scriptName: "users_migration" }),
        }),
        row({ version: "0.9.0", left: entry({ version: "0.9.0" }) }),
      ],
    });

    expect(screen.getByText("No script group")).toBeInTheDocument();
  });
});

describe("the script under a row", () => {
  const withScripts = (leftSql: string | null, rightSql: string | null) => [
    row({
      version: "1.2.0",
      left: leftSql === null ? null : entry({ version: "1.2.0", sqlContent: leftSql }),
      right: rightSql === null ? null : entry({ version: "1.2.0", sqlContent: rightSql }),
    }),
  ];

  it("opens on a click and closes on the next one", () => {
    show({ rows: withScripts("alter table orders add column note text;", null) });

    expect(versionToggle("1.2.0")).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(screen.getByText("1.2.0"));
    expect(versionToggle("1.2.0")).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("alter table orders add column note text;")).toBeInTheDocument();

    fireEvent.click(screen.getByText("1.2.0"));
    expect(versionToggle("1.2.0")).toHaveAttribute("aria-expanded", "false");
  });

  it("keeps one script open at a time", () => {
    // Two open scripts push the rest of the timeline off the screen.
    show({
      rows: [
        row({ version: "1.2.0", left: entry({ version: "1.2.0", sqlContent: "select 1;" }) }),
        row({ version: "1.1.0", left: entry({ version: "1.1.0", sqlContent: "select 2;" }) }),
      ],
    });

    fireEvent.click(screen.getByText("1.2.0"));
    fireEvent.click(screen.getByText("1.1.0"));

    expect(screen.queryByText("select 1;")).not.toBeInTheDocument();
    expect(screen.getByText("select 2;")).toBeInTheDocument();
  });

  it("says when both sides stored the same script, and shows it once", () => {
    show({ rows: withScripts("create index on orders (id);", "create index on orders (id);\n") });

    fireEvent.click(screen.getByText("1.2.0"));

    expect(screen.getByText("The same script on both sides.")).toBeInTheDocument();
    expect(screen.getAllByText(/create index on orders/)).toHaveLength(1);
  });

  it("says when the two sides stored different scripts, and lets the reader pick", () => {
    // The failure this drawing exists for: one version number, two scripts.
    show({ rows: withScripts("create index on orders (id);", "drop index orders_id_idx;") });

    fireEvent.click(screen.getByText("1.2.0"));
    expect(
      screen.getByText("The two sides stored different scripts for this version.")
    ).toBeInTheDocument();

    const picker = screen.getByRole("group", { name: "Whose script to show" });
    expect(within(picker).getByRole("button", { name: LEFT })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    expect(screen.getByText("create index on orders (id);")).toBeInTheDocument();

    fireEvent.click(within(picker).getByRole("button", { name: RIGHT }));
    expect(screen.getByText("drop index orders_id_idx;")).toBeInTheDocument();
    expect(screen.queryByText("create index on orders (id);")).not.toBeInTheDocument();
  });

  it("starts on the left side again when a different row is opened", () => {
    show({
      rows: [
        row({
          version: "1.2.0",
          left: entry({ version: "1.2.0", sqlContent: "left one;" }),
          right: entry({ version: "1.2.0", sqlContent: "right one;" }),
        }),
        row({
          version: "1.1.0",
          left: entry({ version: "1.1.0", sqlContent: "left two;" }),
          right: entry({ version: "1.1.0", sqlContent: "right two;" }),
        }),
      ],
    });

    fireEvent.click(screen.getByText("1.2.0"));
    fireEvent.click(
      within(screen.getByRole("group", { name: "Whose script to show" })).getByRole("button", {
        name: RIGHT,
      })
    );
    expect(screen.getByText("right one;")).toBeInTheDocument();

    fireEvent.click(screen.getByText("1.1.0"));
    expect(screen.getByText("left two;")).toBeInTheDocument();
  });

  it("names the side a lone script came from, and why the other side shows none", () => {
    show({
      rows: [
        row({
          version: "1.2.0",
          left: entry({ version: "1.2.0", sqlContent: "alter table t add c int;" }),
          right: entry({ version: "1.2.0" }),
        }),
      ],
      rightNoScript: "Flyway records a checksum, not the script.",
    });

    fireEvent.click(screen.getByText("1.2.0"));

    expect(screen.getByText(`Stored by ${LEFT}.`)).toBeInTheDocument();
    expect(
      screen.getByText(`${RIGHT}: Flyway records a checksum, not the script.`)
    ).toBeInTheDocument();
  });

  it("stays quiet about a side that does not have the version at all", () => {
    show({ rows: withScripts("alter table t add c int;", null) });

    fireEvent.click(screen.getByText("1.2.0"));

    expect(screen.getByText(`Stored by ${LEFT}.`)).toBeInTheDocument();
    expect(screen.queryByText(new RegExp(`^${RIGHT}:`))).not.toBeInTheDocument();
  });

  it("names no side when only one side has the version to begin with", () => {
    // Nothing to compare, so a label in front of the reason would only invite
    // the reader to look for the other side's answer, which does not exist.
    show({
      rows: [row({ version: "1.2.0", left: entry({ version: "1.2.0" }) })],
      leftNoScript: "The registry file was deleted.",
    });

    fireEvent.click(screen.getByText("1.2.0"));

    expect(screen.getByText("The registry file was deleted.")).toBeInTheDocument();
    expect(
      screen.queryByText(`${LEFT}: The registry file was deleted.`)
    ).not.toBeInTheDocument();
  });

  it("gives each side its own reason when the two differ", () => {
    show({
      rows: [
        row({
          version: "1.2.0",
          left: entry({ version: "1.2.0" }),
          right: entry({ version: "1.2.0" }),
        }),
      ],
      leftNoScript: "The registry file was deleted.",
      rightNoScript: "Flyway records a checksum, not the script.",
    });

    fireEvent.click(screen.getByText("1.2.0"));

    expect(screen.getByText(`${LEFT}: The registry file was deleted.`)).toBeInTheDocument();
    expect(
      screen.getByText(`${RIGHT}: Flyway records a checksum, not the script.`)
    ).toBeInTheDocument();
  });

  it("falls back to one sentence when neither side kept a script", () => {
    show({
      rows: [
        row({
          version: "1.2.0",
          left: entry({ version: "1.2.0" }),
          right: entry({ version: "1.2.0" }),
        }),
      ],
    });

    fireEvent.click(screen.getByText("1.2.0"));

    expect(screen.getByText(NO_STORED_SCRIPT)).toBeInTheDocument();
  });

  it("only promises a script when there is one to show", () => {
    show();
    expect(screen.queryByText("Click a version to see its script.")).not.toBeInTheDocument();

    cleanup();
    show({ rows: withScripts("select 1;", null) });
    expect(screen.getByText("Click a version to see its script.")).toBeInTheDocument();
  });
});

describe("the buttons beside a row", () => {
  it("adds no column when there is nothing to put in it", () => {
    show();

    expect(screen.getAllByRole("columnheader")).toHaveLength(3);
  });

  it("offers a roll back on the versions the screen named, matched by number not spelling", () => {
    // The screen holds "v1.2.0" and the row was written "1.2.0": one version.
    show({ revertableVersions: ["v1.2.0"], onRevert: () => {} });

    expect(screen.getByRole("button", { name: "Roll back to here…" })).toBeInTheDocument();
  });

  it("offers nothing when the screen passed no handler", () => {
    show({ revertableVersions: ["1.2.0"] });

    expect(screen.queryByRole("button", { name: "Roll back to here…" })).not.toBeInTheDocument();
  });

  it("keeps the offer inside the script group the screen named", () => {
    show({
      revertableVersions: ["1.2.0"],
      revertableFamily: "users",
      onRevert: () => {},
      rows: [
        row({
          version: "1.2.0",
          family: "orders",
          left: entry({ version: "1.2.0", scriptName: "orders" }),
        }),
      ],
    });

    expect(screen.queryByRole("button", { name: "Roll back to here…" })).not.toBeInTheDocument();
  });

  it("rolls back the row it sits in, without also opening its script", () => {
    // The guard: the whole row is a click target, so a button inside it has to
    // stop the click or Roll back would unfold a script over its own dialog.
    const rolled: string[] = [];
    show({
      revertableVersions: ["1.2.0"],
      onRevert: (r) => rolled.push(r.version),
      rows: [
        row({
          version: "1.2.0",
          left: entry({ version: "1.2.0", sqlContent: "select 1;" }),
        }),
      ],
    });

    fireEvent.click(screen.getByRole("button", { name: "Roll back to here…" }));

    expect(rolled).toEqual(["1.2.0"]);
    expect(versionToggle("1.2.0")).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("select 1;")).not.toBeInTheDocument();
  });

  it("does the same for the buttons a screen draws itself", () => {
    const ran: string[] = [];
    show({
      renderActions: (r) => (
        <button type="button" onClick={() => ran.push(r.version)}>
          Run
        </button>
      ),
      rows: [
        row({ version: "1.2.0", left: entry({ version: "1.2.0", sqlContent: "select 1;" }) }),
      ],
    });

    fireEvent.click(screen.getByRole("button", { name: "Run" }));

    expect(ran).toEqual(["1.2.0"]);
    expect(screen.queryByText("select 1;")).not.toBeInTheDocument();
  });
});

describe("the legend", () => {
  it("explains only what is actually on screen", () => {
    show();

    expect(screen.getByText("recorded")).toBeInTheDocument();
    expect(screen.getByText("not recorded")).toBeInTheDocument();
    expect(screen.queryByText(/older than the entries read from that side/)).not.toBeInTheDocument();
    expect(screen.queryByText("failed run")).not.toBeInTheDocument();
    expect(screen.queryByText("level not recorded")).not.toBeInTheDocument();
  });

  it("explains the “?” once a row has one", () => {
    show({ rows: [row({ version: "1.0.0", left: entry({ version: "1.0.0" }), rightUnknown: true })] });

    expect(screen.getByText(/older than the entries read from that side/)).toBeInTheDocument();
  });

  it("explains a failed run once a row has one", () => {
    show({ rows: [row({ version: "1.2.0", left: entry({ version: "1.2.0", failed: true }) })] });

    expect(screen.getByText("failed run")).toBeInTheDocument();
  });

  it("explains an ungraded version once a row has one", () => {
    show({
      rows: [
        row({
          version: "1.2.0",
          changeType: "unknown",
          left: entry({ version: "1.2.0", changeType: "unknown" }),
        }),
      ],
    });

    expect(screen.getByText("level not recorded")).toBeInTheDocument();
    expect(screen.getByText(", Change level not recorded")).toBeInTheDocument();
  });

  it("says HEAD means the group's current version when there are groups", () => {
    show({
      rows: [
        row({
          version: "1.2.0",
          family: "users",
          left: entry({ version: "1.2.0", scriptName: "users" }),
          isLeftHead: true,
        }),
      ],
    });

    expect(screen.getByText("current version in its script group")).toBeInTheDocument();
  });
});
