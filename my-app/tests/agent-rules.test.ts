// The rules for a linked computer that need no database: its code, what it may
// be asked, and what of its answers the site keeps.
import {
  CODE_LENGTH,
  CODE_LETTERS,
  TIMED_OUT,
  cleanLabel,
  keptRefusal,
  readUserCode,
  refusalSentence,
  showUserCode,
} from "@/lib/agent-rules";
import { connectionsIn, readAgentAnswer, readAgentJob } from "@/lib/agent-jobs";
import { readCompareSummary, type CompareSummary } from "@/lib/phone-compare";

const FAKE_HOST = "db.private.example.test";

function summary(over: Partial<CompareSummary["targets"][number]> = {}): CompareSummary {
  return {
    source: { connectionId: 1, name: "Dev", environment: "dev", schema: "shop", error: null },
    targets: [
      {
        connectionId: 2,
        name: "Prod",
        environment: "prod",
        schema: "shop",
        status: "compared",
        error: null,
        changes: 1,
        breaking: 0,
        manual: 0,
        lines: [
          {
            category: "column",
            table: "books",
            object: "title",
            change: "added",
            severity: "safe",
            detail: "text",
            manual: false,
          },
        ],
        moreLines: 0,
        history: null,
        ...over,
      },
    ],
  } as CompareSummary;
}

describe("the code someone reads off a computer", () => {
  it("is forgiving about how it was typed", () => {
    for (const typed of ["BCDF-GHJK", "bcdf-ghjk", "BCDFGHJK", " bcdf ghjk "]) {
      expect(readUserCode(typed)).toBe("BCDFGHJK");
    }
  });

  it("refuses what cannot be one", () => {
    for (const bad of ["", "BCDF", "BCDF-GHJKL", "AEIO-U012", "BCDF GHJ!", null, 12345678, undefined]) {
      expect(readUserCode(bad)).toBeNull();
    }
  });

  it("shows in two halves", () => {
    expect(showUserCode("BCDFGHJK")).toBe("BCDF-GHJK");
  });

  it("uses letters that spell no word and cannot be misread", () => {
    expect(CODE_LETTERS).not.toMatch(/[AEIOU01]/);
    expect(CODE_LENGTH).toBe(8);
  });
});

describe("a name a computer sent", () => {
  it("comes out on one line, without invisible characters", () => {
    expect(cleanLabel("  Ada's\n\tlaptop​ ", 40)).toBe("Ada's laptop");
  });

  it("is cut to the limit by character, not by half a character", () => {
    expect(cleanLabel("😀😀😀", 2)).toBe("😀😀");
  });

  it("is empty when it is not text", () => {
    expect(cleanLabel(42, 40)).toBe("");
  });
});

describe("why a computer could not answer", () => {
  it("is one of the site's own sentences", () => {
    expect(refusalSentence("unreachable")).toBe("The computer could not reach that database.");
  });

  it("has a plain sentence for a word it does not know, and for none", () => {
    const plain = "The computer could not do that. Its log has the details.";
    expect(refusalSentence("failed")).toBe(plain);
    expect(refusalSentence(null)).toBe(plain);
    // An object's own built-in names are not refusals.
    expect(refusalSentence("constructor")).toBe(plain);
  });

  it("keeps only known words, so a computer cannot fill the column with its own text", () => {
    expect(keptRefusal("too-big")).toBe("too-big");
    expect(keptRefusal(`could not connect to ${FAKE_HOST}`)).toBe("failed");
    expect(keptRefusal("constructor")).toBe("failed");
    expect(keptRefusal(undefined)).toBe("failed");
  });

  it("says plainly when a computer never answered", () => {
    expect(TIMED_OUT).toMatch(/asleep or off/);
  });
});

describe("what a computer can be asked", () => {
  const source = { connectionId: 1, schema: "shop" };
  const target = { connectionId: 2, schema: "shop" };

  it("takes the two read-only questions and nothing else", () => {
    expect(readAgentJob("schemas.list", { connectionId: 1 })).toEqual({
      ok: true,
      job: { method: "schemas.list", params: { connectionId: 1 } },
    });
    expect(readAgentJob("compare.run", { source, targets: [target] }).ok).toBe(true);
    for (const method of ["deploy.run", "connections.list", "constructor", 1, null, undefined]) {
      expect(readAgentJob(method, { connectionId: 1 }).ok).toBe(false);
    }
  });

  it("refuses a schema list with no proper connection", () => {
    for (const connectionId of [0, -1, 1.5, "1", null, undefined]) {
      expect(readAgentJob("schemas.list", { connectionId }).ok).toBe(false);
    }
    expect(readAgentJob("schemas.list", null).ok).toBe(false);
  });

  it("compares one target at a time, so an answer always fits", () => {
    expect(readAgentJob("compare.run", { source, targets: [target, { connectionId: 3, schema: "shop" }] })).toEqual({
      ok: false,
      error: "Compare one target at a time.",
    });
    expect(readAgentJob("compare.run", { source, targets: [] }).ok).toBe(false);
  });

  it("names every connection it touches, so each can be checked as shared", () => {
    const read = readAgentJob("compare.run", { source, targets: [target] });
    if (!read.ok) throw new Error(read.error);
    expect(connectionsIn(read.job)).toEqual([1, 2]);
    expect(connectionsIn({ method: "schemas.list", params: { connectionId: 9 } })).toEqual([9]);
  });
});

describe("what is kept of a computer's answer", () => {
  it("takes a list of schema names, within limits", () => {
    expect(readAgentAnswer("schemas.list", { schemas: ["public", "shop"], extra: FAKE_HOST })).toEqual({
      schemas: ["public", "shop"],
    });
    expect(readAgentAnswer("schemas.list", { schemas: [""] })).toBeNull();
    expect(readAgentAnswer("schemas.list", { schemas: ["x".repeat(129)] })).toBeNull();
    expect(readAgentAnswer("schemas.list", { schemas: Array(2001).fill("x") })).toBeNull();
    expect(readAgentAnswer("schemas.list", { schemas: [1] })).toBeNull();
    expect(readAgentAnswer("schemas.list", null)).toBeNull();
  });

  it("takes a comparison, and drops anything it did not ask for", () => {
    const sent = summary();
    const padded = {
      ...sent,
      host: FAKE_HOST,
      source: { ...sent.source, password: "not-a-real-one", sql: "drop table books" },
      targets: [
        {
          ...sent.targets[0],
          host: FAKE_HOST,
          lines: [{ ...sent.targets[0].lines[0], rows: ["a row"] }],
        },
      ],
    };
    const kept = readAgentAnswer("compare.run", padded);
    expect(kept).toEqual(sent);
    const text = JSON.stringify(kept);
    expect(text).not.toContain(FAKE_HOST);
    expect(text).not.toContain("not-a-real-one");
    expect(text).not.toContain("drop table");
    expect(text).not.toContain("a row");
  });

  it("refuses what is not a comparison", () => {
    expect(readAgentAnswer("compare.run", null)).toBeNull();
    expect(readAgentAnswer("compare.run", { source: {} })).toBeNull();
    const sent = summary();
    expect(readCompareSummary({ ...sent, targets: "many" })).toBeNull();
    expect(readCompareSummary(summary({ status: "exploded" as never }))).toBeNull();
    expect(readCompareSummary(summary({ changes: -1 }))).toBeNull();
    expect(readCompareSummary(summary({ lines: "many" as never }))).toBeNull();
  });

  it("refuses more than the summary could ever hold", () => {
    const sent = summary();
    expect(
      readCompareSummary({ ...sent, targets: Array(50).fill(sent.targets[0]) })
    ).toBeNull();
    expect(
      readCompareSummary(summary({ lines: Array(5000).fill(sent.targets[0].lines[0]) }))
    ).toBeNull();
  });

  it("has no answer for a question it does not know", () => {
    expect(readAgentAnswer("deploy.run", { schemas: [] })).toBeNull();
  });
});
