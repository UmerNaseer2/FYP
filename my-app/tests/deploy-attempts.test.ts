// The deploy audit trail's classification.
//
// Spec feature 07: "Track SQL execution history for auditing."
//
// The apply route used to record only what it had applied, and it recorded it
// in the target's own script_patch table — inside the run's transaction, after
// the DDL. So every way a run can go wrong took the evidence with it: a script
// that threw, a COMMIT the server refused and a run that timed out waiting for
// a lock were all rolled back together with the row that would have described
// them, and a refusal never opened a transaction at all. The trail is written
// to the app's own database now, on a different connection, which is what makes
// it survive.
//
// What is pinned here is the reading of the route's answer. The apply route
// replies in more than twenty places, and the classification is derived from
// the reply rather than written out at each of them precisely so it cannot be
// wrong at the one rare branch nobody exercises — which is the branch an audit
// trail exists for. That makes this function the whole feature, and the two
// distinctions below are the ones worth being strict about:
//
//   • "refused" is not "failed". A refusal never touched the target, so there
//     is nothing to inspect and nothing to undo.
//   • "unknown" is not "failed" either, and this one is dangerous to get
//     wrong: the run may have landed. A row that says it failed would send the
//     reader to re-run migrations that are already applied.
import {
  MAX_ATTEMPT_DETAIL_LENGTH,
  attemptDetail,
  attemptOutcome,
  describeAttempt,
  type AttemptResponseBody,
} from "@/lib/deploy-attempts";

describe("attemptOutcome", () => {
  it("records a committed run as applied", () => {
    expect(attemptOutcome(200, { success: true })).toBe("applied");
  });

  it("records a clean rehearsal as applied too", () => {
    // A dry run that rehearsed and rolled back did what was asked of it. The
    // dry_run column on the row is what says nothing was written.
    expect(attemptOutcome(200, { success: true, dryRun: true } as AttemptResponseBody)).toBe("applied");
  });

  it("separates a refusal from a failure, because they are not the same event", () => {
    // Refused: the route said no before it wrote anything, so the target is
    // untouched and there is nothing to go and look at.
    expect(attemptOutcome(409, { success: false, nothingRan: true })).toBe("refused");
    // Failed: it ran, and the transaction was rolled back.
    expect(attemptOutcome(500, { success: false })).toBe("failed");
  });

  it("does not read the status code as the answer on its own", () => {
    // The route answers 503 both for a target it could not open (nothing ran)
    // and for a lock timeout AFTER BEGIN (the run started). Only nothingRan
    // tells them apart, and an audit that called them both the same thing
    // would send somebody looking for a rolled-back transaction that never
    // existed — or, worse, not looking for one that did.
    expect(attemptOutcome(503, { error: "…", nothingRan: true })).toBe("refused");
    expect(attemptOutcome(503, { error: "…" })).toBe("failed");
  });

  it("keeps an unknown commit out of both, even though it answers 500 and success: false", () => {
    // The one outcome that needs a person. It arrives looking exactly like a
    // failure, so the flag has to be read BEFORE anything else — reading it
    // after would fold "the run may have landed" into "the run was rolled
    // back", which is the opposite of the truth.
    const body = { success: false, outcomeUnknown: true, error: "The COMMIT did not report back." };
    expect(attemptOutcome(500, body)).toBe("unknown");
  });

  it("treats an answer it cannot read as a refusal when nothing reached the target", () => {
    // The auth gate and the JSON parse guard answer without either flag, and
    // some of them carry no JSON body to read at all. Nothing at 4xx ever got
    // as far as the target, so that is the honest reading.
    expect(attemptOutcome(401, null)).toBe("refused");
    expect(attemptOutcome(400, {})).toBe("refused");
    // But a 5xx with nothing to read is not: something may well have run.
    expect(attemptOutcome(500, null)).toBe("failed");
  });
});

describe("attemptDetail", () => {
  it("keeps the reason the operator was given, word for word", () => {
    // The point of the row. A refusal the operator has since closed the tab on
    // is otherwise unrecoverable.
    const error = "Version 1.2.0 of \"orders\" is restricted to billing.";
    expect(attemptDetail("refused", { error })).toBe(error);
  });

  it("stores nothing for a run that worked", () => {
    // The outcome already says "applied"; repeating the success message on
    // every row is noise to read past.
    expect(attemptDetail("applied", { message: "orders v1.2.0 applied successfully." })).toBeNull();
  });

  it("falls back to the message when there is no error field", () => {
    expect(attemptDetail("failed", { message: "Something to say." })).toBe("Something to say.");
  });

  it("is null rather than an empty string when there is nothing to say", () => {
    expect(attemptDetail("failed", null)).toBeNull();
    expect(attemptDetail("failed", { error: "   " })).toBeNull();
    // A non-string error (a route answering with an object) is not stored as
    // "[object Object]".
    expect(attemptDetail("failed", { error: { code: 42 } })).toBeNull();
  });

  it("cuts a message that would otherwise be a transcript, and says it cut it", () => {
    // A column that can hold a stack trace is one that eventually holds a
    // thousand of them. The ellipsis is what stops a truncated reason reading
    // as a complete one.
    const long = "x".repeat(MAX_ATTEMPT_DETAIL_LENGTH + 500);
    const kept = attemptDetail("failed", { error: long }) ?? "";
    expect(kept.length).toBe(MAX_ATTEMPT_DETAIL_LENGTH);
    expect(kept.endsWith("…")).toBe(true);
  });
});

describe("describeAttempt", () => {
  it("says which of the four happened, in words a reader can act on", () => {
    expect(describeAttempt("applied", false)).toBe("Applied");
    expect(describeAttempt("refused", false)).toContain("Refused");
    expect(describeAttempt("failed", false)).toContain("rolled back");
  });

  it("never lets an unknown outcome read as either a success or a failure", () => {
    // Whichever way it is shown, and dry run or not, the row has to send the
    // reader to look rather than let them conclude anything.
    for (const dryRun of [false, true]) {
      const said = describeAttempt("unknown", dryRun);
      expect(said.toLowerCase()).toContain("unknown");
      expect(said).not.toContain("Applied");
    }
  });

  it("says a rehearsal wrote nothing, so it is not read as a deploy", () => {
    expect(describeAttempt("applied", true)).toContain("nothing written");
  });
});
