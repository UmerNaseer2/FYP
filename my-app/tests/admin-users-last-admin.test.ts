// Two admins demoting each other at the same moment must not leave none.
//
// The guard used to be a plain count followed by a write, on two separate
// connections. Umer demotes Mei while Mei demotes Umer: both counted "one other
// admin left", both were allowed through, and the app finished with no admin —
// and the only screen that can appoint one is the screen that now nobody can
// open. The fix is one transaction that locks every admin row before it counts,
// and still holds that lock when it writes.
//
// WHAT THESE TESTS CAN AND CANNOT SHOW. A fake client does not implement row
// locks, so nothing here proves PostgreSQL makes the second request wait. What
// it does prove is the shape the fix depends on, which is where the bug was and
// where a future edit would put it back: one connection, BEGIN before the
// check, the lock taken before the count, no COMMIT on a refusal, and — the
// easiest detail to get wrong — a lock that covers every admin rather than
// "every admin except the one I am changing". That variant excludes precisely
// the row the request then writes, so two of them deadlock on each other; run
// against a real PostgreSQL 17.11 it aborts one request every time. The data
// survives, but as a 500 rather than a refusal that names the rule.
import { NextRequest } from "next/server";

/** Every statement the route ran, in order, with its values. */
type Statement = { text: string; values: unknown[] };
let statements: Statement[] = [];

/** What the fake answers, keyed by the shape of the query. */
type Answers = {
  /** The target row for `SELECT role FROM profiles WHERE id = $1`. */
  target?: { email: string; role: string } | null;
  /** How many OTHER admins the count query reports. */
  otherAdmins?: number;
  /** Rows the UPDATE ... RETURNING gives back. Defaults to one row. */
  updated?: unknown[];
  /** A statement matching this text throws, to test the rollback path. */
  throwOn?: RegExp;
};
let answers: Answers = {};

let released = 0;

const mockConnect = async () => {
  let isReleased = false;
  return {
    query: async (text: string, values?: unknown[]) => {
      statements.push({ text, values: values ?? [] });
      if (answers.throwOn?.test(text)) throw new Error("connection lost");
      if (/FOR UPDATE/.test(text)) {
        // The lock query's rows are not what the route counts — see the route.
        return { rows: [], rowCount: 0 };
      }
      if (/count\(\*\)/.test(text)) {
        return {
          rows: [{ count: String(answers.otherAdmins ?? 0) }],
          rowCount: 1,
        };
      }
      if (/^\s*SELECT (role|email, role) FROM profiles/.test(text)) {
        const row = answers.target === undefined ? { email: "mei@x", role: "admin" } : answers.target;
        return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
      }
      if (/^\s*UPDATE profiles/.test(text)) {
        const rows = answers.updated ?? [{ id: 2, email: "mei@x", role: "viewer" }];
        return { rows, rowCount: rows.length };
      }
      return { rows: [], rowCount: 0 };
    },
    release: () => {
      if (isReleased) return;
      isReleased = true;
      released += 1;
    },
  };
};

jest.mock("../lib/version-db", () => ({
  __esModule: true,
  default: {
    query: async () => ({ rows: [], rowCount: 0 }),
    connect: () => mockConnect(),
  },
  syncMetadataTables: async () => undefined,
}));

// A real admin, not the bypass, so the "you can't delete yourself" rule is live.
jest.mock("../lib/auth-guard", () => ({
  requireAdmin: async () => ({
    ok: true,
    principal: { email: "umer@x", name: "Umer", role: "admin", bypass: false },
  }),
}));

import { PUT, DELETE } from "@/app/api/admin/users/route";

/** Just the statement texts, collapsed to one line each. */
function texts(): string[] {
  return statements.map((s) => s.text.replace(/\s+/g, " ").trim());
}

/** The index of the first statement matching `pattern`, or -1. */
function at(pattern: RegExp): number {
  return texts().findIndex((text) => pattern.test(text));
}

function request(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/admin/users", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

const LOCK = /FOR UPDATE/;
const COUNT = /count\(\*\)/;

beforeEach(() => {
  statements = [];
  answers = {};
  released = 0;
});

describe("demoting an admin", () => {
  it("refuses to demote the last admin, and writes nothing", async () => {
    answers.target = { email: "mei@x", role: "admin" };
    answers.otherAdmins = 0;

    const response = await PUT(request({ userId: 2, role: "viewer" }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "This is the last admin. Promote someone else first.",
    });
    expect(at(/^UPDATE profiles/)).toBe(-1);
  });

  it("rolls back rather than leaving the transaction open when it refuses", async () => {
    // The connection goes back to the pool at the end either way. Handing back
    // one that is still inside BEGIN gives the next borrower somebody else's
    // half-finished transaction.
    answers.target = { email: "mei@x", role: "admin" };
    answers.otherAdmins = 0;

    await PUT(request({ userId: 2, role: "viewer" }));

    expect(texts()).toContain("ROLLBACK");
    expect(texts()).not.toContain("COMMIT");
    expect(released).toBe(1);
  });

  it("allows the demotion when somebody else is still an admin", async () => {
    answers.target = { email: "mei@x", role: "admin" };
    answers.otherAdmins = 1;

    const response = await PUT(request({ userId: 2, role: "viewer" }));

    expect(response.status).toBe(200);
    expect(at(/^UPDATE profiles/)).toBeGreaterThan(-1);
    expect(texts()).toContain("COMMIT");
  });

  it("takes the lock before it counts, and is still holding it at the write", async () => {
    // The whole fix in one assertion. A count taken before the lock is the old
    // bug; a write after COMMIT is outside the lock and just as racy.
    answers.target = { email: "mei@x", role: "admin" };
    answers.otherAdmins = 1;

    await PUT(request({ userId: 2, role: "viewer" }));

    const begin = at(/^BEGIN/);
    const lock = at(LOCK);
    const count = at(COUNT);
    const update = at(/^UPDATE profiles/);
    const commit = at(/^COMMIT/);

    expect(begin).toBe(0);
    expect(begin).toBeLessThan(lock);
    expect(lock).toBeLessThan(count);
    expect(count).toBeLessThan(update);
    expect(update).toBeLessThan(commit);
  });

  it("locks every admin row, not every admin except the one being changed", async () => {
    // The detail that decides whether the lock works at all. With admins
    // {Umer, Mei}, an "except me" lock gives Umer's request Mei's row and Mei's
    // request Umer's row — disjoint, so neither waits and both go through.
    answers.target = { email: "mei@x", role: "admin" };
    answers.otherAdmins = 1;

    await PUT(request({ userId: 2, role: "viewer" }));

    const lock = texts()[at(LOCK)];
    expect(lock).toMatch(/WHERE role = 'admin'/);
    expect(lock).not.toMatch(/id <>/);
    expect(statements[at(LOCK)].values).toEqual([]);
    // Ordered, so two requests take the rows the same way round and cannot
    // deadlock by grabbing them in opposite directions.
    expect(lock).toMatch(/ORDER BY id FOR UPDATE/);
    // The count is the separate statement that excludes the target — under
    // READ COMMITTED it gets a fresh view, so it sees an admin promoted while
    // this request was waiting for the lock.
    expect(texts()[at(COUNT)]).toMatch(/id <> \$1/);
    expect(statements[at(COUNT)].values).toEqual([2]);
  });

  it("does not take the lock when nothing is being taken away", async () => {
    // A promotion cannot remove the last admin, so making every role change
    // queue behind every other one would cost something for nothing.
    answers.target = { email: "mei@x", role: "viewer" };
    answers.otherAdmins = 0;

    await PUT(request({ userId: 2, role: "admin" }));

    expect(at(LOCK)).toBe(-1);
    expect(texts()).toContain("COMMIT");
  });

  it("does not take the lock when the person was never an admin", async () => {
    answers.target = { email: "mei@x", role: "editor" };
    answers.otherAdmins = 0;

    const response = await PUT(request({ userId: 2, role: "viewer" }));

    expect(response.status).toBe(200);
    expect(at(LOCK)).toBe(-1);
  });

  it("answers 404 when the row disappears between the check and the write", async () => {
    // Only reachable on a promotion, which holds no lock: somebody else's
    // DELETE lands in the gap. Without the second check the reply would be
    // `{ success: true, user: undefined }`.
    answers.target = { email: "mei@x", role: "viewer" };
    answers.updated = [];

    const response = await PUT(request({ userId: 2, role: "admin" }));

    expect(response.status).toBe(404);
    expect(texts()).toContain("ROLLBACK");
    expect(texts()).not.toContain("COMMIT");
  });

  it("answers 404 for a user that was never there", async () => {
    answers.target = null;

    const response = await PUT(request({ userId: 99, role: "viewer" }));

    expect(response.status).toBe(404);
    expect(at(LOCK)).toBe(-1);
    expect(texts()).toContain("ROLLBACK");
  });

  it("gives the connection back even when a statement throws", async () => {
    answers.target = { email: "mei@x", role: "admin" };
    answers.throwOn = /^\s*UPDATE profiles/;
    answers.otherAdmins = 1;

    const response = await PUT(request({ userId: 2, role: "viewer" }));

    expect(response.status).toBe(500);
    expect(released).toBe(1);
  });
});

describe("deleting an admin", () => {
  it("refuses to delete the last admin, and deletes nothing", async () => {
    // A delete removes an admin exactly as surely as a demotion does, so it
    // needs the same lock — the two races are the same race.
    answers.target = { email: "mei@x", role: "admin" };
    answers.otherAdmins = 0;

    const response = await DELETE(request({ userId: 2 }));

    expect(response.status).toBe(409);
    expect(at(/^DELETE FROM profiles/)).toBe(-1);
    expect(texts()).toContain("ROLLBACK");
    expect(texts()).not.toContain("COMMIT");
  });

  it("takes the same lock before counting, and still holds it at the delete", async () => {
    answers.target = { email: "mei@x", role: "admin" };
    answers.otherAdmins = 1;

    const response = await DELETE(request({ userId: 2 }));

    expect(response.status).toBe(200);
    expect(at(/^BEGIN/)).toBe(0);
    expect(at(LOCK)).toBeLessThan(at(COUNT));
    expect(at(COUNT)).toBeLessThan(at(/^DELETE FROM profiles/));
    expect(at(/^DELETE FROM profiles/)).toBeLessThan(at(/^COMMIT/));
  });

  it("does not take the lock to delete someone who is not an admin", async () => {
    answers.target = { email: "mei@x", role: "viewer" };
    answers.otherAdmins = 0;

    const response = await DELETE(request({ userId: 2 }));

    expect(response.status).toBe(200);
    expect(at(LOCK)).toBe(-1);
  });

  it("rolls back when it refuses to let you delete yourself", async () => {
    // Matched case-insensitively, so the principal's own row is found whichever
    // way the sign-in provider capitalised the address.
    answers.target = { email: "Umer@X", role: "editor" };

    const response = await DELETE(request({ userId: 1 }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "You can't delete your own account here.",
    });
    expect(at(/^DELETE FROM profiles/)).toBe(-1);
    expect(texts()).toContain("ROLLBACK");
  });

  it("answers 404 for a user that was never there", async () => {
    answers.target = null;

    const response = await DELETE(request({ userId: 99 }));

    expect(response.status).toBe(404);
    expect(texts()).toContain("ROLLBACK");
    expect(released).toBe(1);
  });
});
