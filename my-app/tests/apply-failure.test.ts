// readApplyFailure: how a failed answer from the apply route is read. It
// decides what the Deploy page's rows, toast, header and recovery bar claim
// about the target afterwards.
import { readApplyFailure } from "@/lib/apply-failure";

describe("readApplyFailure", () => {
  it("cannot say how the run ended without an answer it can read", () => {
    expect(readApplyFailure(null, null)).toBe("unknown");
    expect(readApplyFailure(502, null)).toBe("unknown");
  });

  it("believes the server when it says its COMMIT did not report back, whatever the status", () => {
    expect(readApplyFailure(500, { outcomeUnknown: true })).toBe("unknown");
    expect(readApplyFailure(409, { outcomeUnknown: true, nothingRan: true })).toBe("unknown");
  });

  it("does not read an answer that is neither an error nor a success", () => {
    expect(readApplyFailure(200, {})).toBe("unknown");
  });

  it("reads every 4xx but 422 as a refusal, flag or no flag", () => {
    for (const status of [400, 403, 404, 409]) {
      expect(readApplyFailure(status, {})).toBe("refused");
      expect(readApplyFailure(status, { nothingRan: true })).toBe("refused");
    }
  });

  it("reads 422 as a rehearsal that ran and rolled back", () => {
    expect(readApplyFailure(422, {})).toBe("rolled-back");
  });

  it("reads a 5xx marked nothingRan as a run that never started", () => {
    expect(readApplyFailure(503, { nothingRan: true })).toBe("not-started");
    expect(readApplyFailure(500, { nothingRan: true })).toBe("not-started");
  });

  it("reads any other 5xx as a run that rolled back", () => {
    expect(readApplyFailure(503, {})).toBe("rolled-back");
    expect(readApplyFailure(500, { nothingRan: false })).toBe("rolled-back");
    expect(readApplyFailure(503, { nothingRan: "true" })).toBe("rolled-back");
  });
});
