/**
 * The one status line on a Dashboard card (app/[org]/(studio)/studio/status-line.ts):
 * the state, who found it, when, and how often the schema is checked.
 */

import {
  cadenceSentence,
  longAgo,
  statusLine,
} from "@/app/[org]/(studio)/studio/status-line";

const NOW = new Date("2026-03-10T12:00:00.000Z").getTime();
const minutesAgo = (n: number) => new Date(NOW - n * 60_000).toISOString();

describe("longAgo", () => {
  it("says the age in whole minutes, hours or days", () => {
    expect(longAgo(minutesAgo(0), NOW)).toBe("just now");
    expect(longAgo(minutesAgo(1), NOW)).toBe("1 minute ago");
    expect(longAgo(minutesAgo(59), NOW)).toBe("59 minutes ago");
    expect(longAgo(minutesAgo(60), NOW)).toBe("1 hour ago");
    expect(longAgo(minutesAgo(60 * 49), NOW)).toBe("2 days ago");
  });

  it("is empty for a missing or unreadable time", () => {
    expect(longAgo(null, NOW)).toBe("");
    expect(longAgo("not a date", NOW)).toBe("");
  });
});

describe("cadenceSentence", () => {
  it("says how often the scheduler checks", () => {
    expect(cadenceSentence(15)).toBe("Checks every 15 minutes.");
    expect(cadenceSentence(60)).toBe("Checks every hour.");
    expect(cadenceSentence(120)).toBe("Checks every 2 hours.");
    expect(cadenceSentence(1440)).toBe("Checks once a day.");
  });

  it("says so when nothing checks on a timer", () => {
    expect(cadenceSentence(0)).toBe("Checks only when someone asks.");
    expect(cadenceSentence(null)).toBe("Checks only when someone asks.");
  });
});

describe("statusLine", () => {
  it("falls back to a plain line for a schema nobody has checked", () => {
    expect(statusLine({ status: null, foundAt: null, intervalMinutes: 15 }, NOW)).toBe(
      "Not checked yet. Checks every 15 minutes."
    );
  });

  it("names the check that found a drift, and leaves it out when unknown", () => {
    const drifted = { status: "drifted", foundAt: minutesAgo(60 * 24), intervalMinutes: 15 };
    expect(statusLine({ ...drifted, source: "scheduled" }, NOW)).toBe(
      "Found by the scheduled check 1 day ago. Checks every 15 minutes."
    );
    expect(statusLine({ ...drifted, source: "manual" }, NOW)).toBe(
      "Found by a check someone ran 1 day ago. Checks every 15 minutes."
    );
    expect(statusLine(drifted, NOW)).toBe("Drift found 1 day ago. Checks every 15 minutes.");
  });

  it("says a database could not be reached", () => {
    expect(
      statusLine(
        { status: "unreachable", foundAt: minutesAgo(120), source: "scheduled", intervalMinutes: 60 },
        NOW
      )
    ).toBe("The scheduled check could not connect 2 hours ago. Checks every hour.");
    expect(statusLine({ status: "unreachable", foundAt: null }, NOW)).toBe(
      "The last check could not connect. Checks only when someone asks."
    );
  });

  it("uses the newest run for a schema in sync, which later checks do not re-record", () => {
    expect(
      statusLine(
        {
          status: "in_sync",
          foundAt: minutesAgo(60 * 24),
          lastRanAt: minutesAgo(5),
          source: "manual",
          intervalMinutes: 15,
        },
        NOW
      )
    ).toBe("Matched its saved version at the last check, 5 minutes ago. Checks every 15 minutes.");
    expect(
      statusLine(
        { status: "in_sync", foundAt: minutesAgo(5), lastRanAt: minutesAgo(5), source: "scheduled" },
        NOW
      )
    ).toBe("The scheduled check found it in sync 5 minutes ago. Checks only when someone asks.");
  });
});
