// shortUtcDate: the short date on the version timeline and Deploy's ledger
// rows. It must name the UTC day, the day the "… UTC" stamps beside it name,
// whatever time zone the reader (or this test run) is in.

import { shortUtcDate } from "@/lib/format-date";

describe("shortUtcDate", () => {
  it("names the UTC day, not the reader's", () => {
    // 01:43 UTC on the 8th is still the 7th anywhere west of Greenwich.
    expect(shortUtcDate("2026-09-08T01:43:00.000Z")).toBe("Sep 8, 2026");
    // The same moment written with a New York offset.
    expect(shortUtcDate("2026-09-07T21:43:00-04:00")).toBe("Sep 8, 2026");
    expect(shortUtcDate("2026-09-08T23:59:59.999Z")).toBe("Sep 8, 2026");
  });

  it("gives an empty string for a missing or unreadable timestamp", () => {
    expect(shortUtcDate(null)).toBe("");
    expect(shortUtcDate("")).toBe("");
    expect(shortUtcDate("not a date")).toBe("");
  });
});
