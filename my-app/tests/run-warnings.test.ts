// lib/deploy/run-warnings.ts: which notices count as warnings, and how a page
// reads them back off an apply answer.
import { isWarning, readRunWarnings, warningCollector } from "@/lib/deploy/run-warnings";

describe("isWarning", () => {
  it("takes SQLSTATE class 01 and the WARNING severity, and nothing else", () => {
    expect(isWarning({ code: "01000", severity: "WARNING" })).toBe(true);
    // "no privileges were granted" comes with its own class 01 code.
    expect(isWarning({ code: "01007", severity: "WARNING" })).toBe(true);
    expect(isWarning({ code: "01000", severity: "AVERTISSEMENT" })).toBe(true);
    expect(isWarning({ code: "XX000", severity: "WARNING" })).toBe(true);
    expect(isWarning({ code: "42P07", severity: "NOTICE" })).toBe(false);
    expect(isWarning({ code: "00000", severity: "NOTICE" })).toBe(false);
    expect(isWarning({ message: "no code or severity at all" })).toBe(false);
  });
});

describe("warningCollector", () => {
  it("gives nothing at all for a script that raised no warning", () => {
    const collector = warningCollector();
    collector.listener({ code: "42P07", severity: "NOTICE", message: "skipping" });
    expect(collector.result()).toEqual({});
  });

  it("keeps the order PostgreSQL sent them in", () => {
    const collector = warningCollector();
    collector.listener({ code: "01000", message: "first" });
    collector.listener({ code: "01000", message: "second" });
    expect(collector.result()).toEqual({ warnings: ["first", "second"] });
  });

  it("hands out a copy, so a later warning cannot change an outcome already sent", () => {
    const collector = warningCollector();
    collector.listener({ code: "01000", message: "first" });
    const sent = collector.result();
    collector.listener({ code: "01000", message: "second" });
    expect(sent).toEqual({ warnings: ["first"] });
  });
});

describe("readRunWarnings", () => {
  it("reads the warnings and the count of any more", () => {
    expect(readRunWarnings({ warnings: ["a", "b"], moreWarnings: 3 })).toEqual({ warnings: ["a", "b"], moreWarnings: 3 });
  });

  it("reads an answer without them, or with anything odd in them, as none", () => {
    expect(readRunWarnings({ status: "applied" })).toEqual({ warnings: [], moreWarnings: 0 });
    expect(readRunWarnings(undefined)).toEqual({ warnings: [], moreWarnings: 0 });
    expect(readRunWarnings(null)).toEqual({ warnings: [], moreWarnings: 0 });
    expect(readRunWarnings("applied")).toEqual({ warnings: [], moreWarnings: 0 });
    expect(readRunWarnings({ warnings: "one", moreWarnings: "2" })).toEqual({ warnings: [], moreWarnings: 0 });
    expect(readRunWarnings({ warnings: ["kept", 4, null], moreWarnings: -1 })).toEqual({ warnings: ["kept"], moreWarnings: 0 });
    expect(readRunWarnings({ warnings: [], moreWarnings: 1.5 })).toEqual({ warnings: [], moreWarnings: 0 });
  });
});
