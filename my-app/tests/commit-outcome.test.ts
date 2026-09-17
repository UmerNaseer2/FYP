// lib/commit-outcome: whether a COMMIT that threw left the run's fate in doubt.
//
// The deploy and rollback routes used to treat every failed COMMIT as
// unreportable and send the reader off to inspect script_patch. Most failed
// COMMITs are not like that: the server answered, named a constraint, and
// rolled the whole transaction back by itself. These tests pin the line
// between the two, because the wrong answer either hides an error that is
// already in hand or claims a run was undone when nobody knows.
import { commitOutcomeIsUnknown, describeCommitError } from "@/lib/commit-outcome";

/** A pg error the way node-postgres builds one. */
function pgError(message: string, extra: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(message), extra);
}

describe("commitOutcomeIsUnknown", () => {
  it("is unknown when nothing came back with a SQLSTATE", () => {
    // A socket that died mid-COMMIT. node-postgres raises a plain Error, so
    // there is no code to read and the server never said what it did.
    expect(commitOutcomeIsUnknown(pgError("Connection terminated unexpectedly"))).toBe(true);
    expect(commitOutcomeIsUnknown(new Error("write EPIPE"))).toBe(true);
    expect(commitOutcomeIsUnknown(null)).toBe(true);
    expect(commitOutcomeIsUnknown(undefined)).toBe(true);
    expect(commitOutcomeIsUnknown("COMMIT failed")).toBe(true);
  });

  it("is unknown for a code that is not a SQLSTATE at all", () => {
    // Node's own network errors land in the same field, and they are exactly
    // the case where the server never answered.
    for (const code of ["ECONNRESET", "ETIMEDOUT", "", "23", "0800"]) {
      expect(commitOutcomeIsUnknown(pgError("socket hang up", { code }))).toBe(true);
    }
  });

  it("is unknown for a Node socket error whose code looks like a SQLSTATE", () => {
    // "EPIPE" is five letters, so the shape of the code cannot tell it apart
    // from a server answer — and it is the socket dying mid-COMMIT, the one
    // case that must stay unknown. errno/syscall are what give it away.
    expect(
      commitOutcomeIsUnknown(pgError("write EPIPE", { code: "EPIPE", errno: -32, syscall: "write" }))
    ).toBe(true);
    // Even a real-looking SQLSTATE does not survive those fields.
    expect(
      commitOutcomeIsUnknown(pgError("write EPIPE", { code: "23503", syscall: "write" }))
    ).toBe(true);
  });

  it("is unknown for class 08, the connection failures", () => {
    for (const code of ["08000", "08003", "08006", "08P01"]) {
      expect(commitOutcomeIsUnknown(pgError("connection exception", { code }))).toBe(true);
    }
  });

  it("is unknown when the server is going away as it answers", () => {
    // admin_shutdown, crash_shutdown, cannot_connect_now: the answer arrived,
    // but a COMMIT in flight may or may not have been written before the stop.
    for (const code of ["57P01", "57P02", "57P03"]) {
      expect(commitOutcomeIsUnknown(pgError("terminating connection", { code }))).toBe(true);
    }
  });

  it("is KNOWN for a deferred constraint the server refused", () => {
    // The whole point of the fix. A DEFERRABLE constraint is checked here, and
    // a refusal means the server rolled the transaction back and said why.
    expect(
      commitOutcomeIsUnknown(
        pgError('insert or update on table "orders" violates foreign key constraint', {
          code: "23503",
        })
      )
    ).toBe(false);
    expect(commitOutcomeIsUnknown(pgError("duplicate key value", { code: "23505" }))).toBe(false);
    expect(commitOutcomeIsUnknown(pgError("check constraint violated", { code: "23514" }))).toBe(false);
  });

  it("is KNOWN for the other failures a COMMIT can end in", () => {
    // Serialization failure, deadlock, and a 57P0x neighbour that is not a
    // shutdown — all of them rolled back, all of them said so.
    for (const code of ["40001", "40P01", "25P02", "57014", "57P04"]) {
      expect(commitOutcomeIsUnknown(pgError("rolled back", { code }))).toBe(false);
    }
  });
});

describe("describeCommitError", () => {
  it("names the constraint and its table when the message did not", () => {
    // A deferred foreign key reports the referencing side without naming the
    // constraint, which is the first thing the reader needs.
    const said = describeCommitError(
      pgError("insert or update on table \"orders\" violates foreign key constraint", {
        code: "23503",
        constraint: "orders_customer_fkey",
        table: "orders",
      })
    );
    expect(said).toBe(
      'insert or update on table "orders" violates foreign key constraint ' +
        '(constraint "orders_customer_fkey" on "orders")'
    );
  });

  it("does not repeat a constraint the message already names", () => {
    const said = describeCommitError(
      pgError('duplicate key value violates unique constraint "orders_ref_key"', {
        code: "23505",
        constraint: "orders_ref_key",
        table: "orders",
      })
    );
    expect(said).toBe('duplicate key value violates unique constraint "orders_ref_key"');
  });

  it("leaves out the table when the error does not carry one", () => {
    const said = describeCommitError(
      pgError("constraint violated", { code: "23514", constraint: "amount_positive" })
    );
    expect(said).toBe('constraint violated (constraint "amount_positive")');
  });

  it("gives back an empty string when there is nothing to say", () => {
    // The caller falls back to its own wording, so an empty answer must not
    // become the words "undefined" in the middle of a sentence.
    expect(describeCommitError(null)).toBe("");
    expect(describeCommitError(undefined)).toBe("");
    expect(describeCommitError({ code: "23503" })).toBe("");
    expect(describeCommitError(pgError("   "))).toBe("");
  });
});
