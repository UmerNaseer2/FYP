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
//
// The "choosing a role" block covers the rest of a role change: the role
// asked for is looked up in the roles table (an admin can add and delete
// roles), and the change is logged in the same transaction that makes it.
//
// Everything here happens inside one organization, the caller's. The users are
// its members, the lock covers its admin memberships and no other
// organization's, and removing someone deletes their membership there, then
// their profile only if they belong to no organization at all. The last block
// checks that no statement strays outside the caller's organization, whatever
// the request body says.
import { NextRequest } from "next/server";

/** Every statement the route ran, in order, with its values. */
type Statement = { text: string; values: unknown[] };
let statements: Statement[] = [];

/** What the fake answers, keyed by the shape of the query. */
type Answers = {
  /**
   * The target's membership, as PUT's `SELECT role FROM memberships` and
   * DELETE's `SELECT p.email, m.role` find it. Null when there is none.
   */
  target?: { email: string; role: string } | null;
  /** How many OTHER admins the count query reports. */
  otherAdmins?: number;
  /**
   * Rows the role change, `WITH changed AS (UPDATE memberships ...)`, gives
   * back. Defaults to one row.
   */
  updated?: unknown[];
  /** A statement matching this text throws, to test the rollback path. */
  throwOn?: RegExp;
  /** The roles table, as name to label. Defaults to the three built-in roles. */
  roles?: Record<string, string>;
};

const BUILT_IN_ROLES = { viewer: "Viewer", editor: "Editor", admin: "Admin" };
let answers: Answers = {};

let released = 0;

/** Statements sent on the pool itself rather than on a borrowed connection: GET's. */
const mockQuery = async (text: string, values?: unknown[]) => {
  statements.push({ text, values: values ?? [] });
  return { rows: [], rowCount: 0 };
};

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
      if (/^\s*SELECT (role FROM memberships|p\.email, m\.role)/.test(text)) {
        const row = answers.target === undefined ? { email: "mei@x", role: "admin" } : answers.target;
        return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
      }
      if (/UPDATE memberships/.test(text)) {
        const rows = answers.updated ?? [{ id: 2, email: "mei@x", role: "viewer" }];
        return { rows, rowCount: rows.length };
      }
      if (/FROM roles/.test(text)) {
        // The lookup PUT makes before it changes anything: the role asked for
        // and the person's current one, each once, if the table has it. The
        // names are the second value; the first is the organization.
        const table = new Map(Object.entries(answers.roles ?? BUILT_IN_ROLES));
        const asked = Array.from(new Set((values?.[1] as string[] | undefined) ?? []));
        const rows = asked
          .filter((name) => table.has(name))
          .map((name) => ({ name, label: table.get(name) }));
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
    query: (text: string, values?: unknown[]) => mockQuery(text, values),
    connect: () => mockConnect(),
  },
  syncMetadataTables: async () => undefined,
}));

// A real admin, not the bypass, so the "you can't delete yourself" rule is live.
// The last block moves them into another organization with mockPrincipalOver.
let mockPrincipalOver: { orgId?: number; orgSlug?: string; orgName?: string } = {};
jest.mock("../lib/auth-guard", () => ({
  requirePermission: async () => ({
    ok: true,
    principal: require("./helpers/principals").principalFor("admin", {
      email: "umer@x",
      name: "Umer",
      ...mockPrincipalOver,
    }),
  }),
}));

import { GET, PUT, DELETE } from "@/app/api/admin/users/route";
import { TEST_ORG } from "./helpers/principals";

/** Just the statement texts, collapsed to one line each. */
function texts(): string[] {
  return statements.map((s) => withoutComments(s.text).replace(/\s+/g, " ").trim());
}

/**
 * A statement without its SQL comment lines. The profile delete covers every
 * organization on purpose and starts with a "-- every organization:" comment
 * saying why (tests/org-scoped-sql.test.ts checks that), and the tests here
 * are about what the SQL does, not the note on it.
 */
function withoutComments(text: string): string {
  return text.replace(/^\s*--[^\n]*\n/gm, "");
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
/** The role change: the UPDATE of the membership, in the statement that returns the row. */
const UPDATE = /^WITH changed AS \( UPDATE memberships/;

beforeEach(() => {
  statements = [];
  answers = {};
  released = 0;
  mockPrincipalOver = {};
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
    expect(at(UPDATE)).toBe(-1);
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
    expect(at(UPDATE)).toBeGreaterThan(-1);
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
    const update = at(UPDATE);
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
    expect(lock).toMatch(/FROM memberships WHERE org_id = \$1 AND role = 'admin'/);
    expect(lock).not.toMatch(/<>/);
    // The organization's admins and nobody else's: the only value is the
    // organization, and nothing names the person being changed.
    expect(statements[at(LOCK)].values).toEqual([TEST_ORG.id]);
    // Ordered, so two requests take the rows the same way round and cannot
    // deadlock by grabbing them in opposite directions.
    expect(lock).toMatch(/ORDER BY profile_id FOR UPDATE$/);
    // The count is the separate statement that excludes the target — under
    // READ COMMITTED it gets a fresh view, so it sees an admin promoted while
    // this request was waiting for the lock.
    expect(texts()[at(COUNT)]).toMatch(
      /FROM memberships WHERE org_id = \$1 AND role = 'admin' AND profile_id <> \$2$/
    );
    expect(statements[at(COUNT)].values).toEqual([TEST_ORG.id, 2]);
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
    answers.throwOn = /UPDATE memberships/;
    answers.otherAdmins = 1;

    const response = await PUT(request({ userId: 2, role: "viewer" }));

    expect(response.status).toBe(500);
    expect(released).toBe(1);
  });
});

describe("choosing a role", () => {
  const LOG = /^INSERT INTO role_changes/;

  it("refuses a role the roles table does not have, and changes nothing", async () => {
    // How it happens: one admin deletes a role while another still has the
    // Users tab open with that role in the picker.
    answers.target = { email: "mei@x", role: "viewer" };

    const response = await PUT(request({ userId: 2, role: "qa-lead" }));

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain('There is no role called "qa-lead"');
    expect(at(UPDATE)).toBe(-1);
    expect(at(LOG)).toBe(-1);
    expect(texts()).toContain("ROLLBACK");
    expect(texts()).not.toContain("COMMIT");
    expect(released).toBe(1);
  });

  it("accepts a role an admin added", async () => {
    answers.target = { email: "mei@x", role: "viewer" };
    answers.roles = { ...BUILT_IN_ROLES, "qa-lead": "QA lead" };
    answers.updated = [{ id: 2, email: "mei@x", role: "qa-lead" }];

    const response = await PUT(request({ userId: 2, role: "qa-lead" }));

    expect(response.status).toBe(200);
    expect(statements[at(UPDATE)].values).toEqual(["qa-lead", TEST_ORG.id, 2]);
  });

  it("holds the role it looked up until the change commits", async () => {
    // FOR KEY SHARE is what makes deleting that role wait for this
    // transaction, and then find the role in use and refuse.
    answers.target = { email: "mei@x", role: "viewer" };
    answers.updated = [{ id: 2, email: "mei@x", role: "editor" }];

    await PUT(request({ userId: 2, role: "editor" }));

    const lookup = at(/FROM roles/);
    expect(texts()[lookup]).toMatch(/WHERE org_id = \$1 AND name = ANY\(\$2::text\[\]\)/);
    expect(texts()[lookup]).toMatch(/FOR KEY SHARE$/);
    expect(statements[lookup].values).toEqual([TEST_ORG.id, ["editor", "viewer"]]);
    expect(lookup).toBeGreaterThan(at(/^BEGIN/));
    expect(lookup).toBeLessThan(at(UPDATE));
  });

  it("logs the change in the same transaction, with the role they had before", async () => {
    answers.target = { email: "mei@x", role: "viewer" };
    answers.updated = [{ id: 2, email: "mei@x", role: "editor" }];

    const response = await PUT(request({ userId: 2, role: "editor" }));

    expect(response.status).toBe(200);
    const log = at(LOG);
    expect(log).toBeGreaterThan(at(UPDATE));
    expect(log).toBeLessThan(at(/^COMMIT/));
    // The organization, then one entry: one value per column in the order the
    // INSERT names them, role, kind, feature, action, subject, detail, actor.
    expect(statements[log].values).toEqual([
      TEST_ORG.id,
      ["editor"],
      ["assign"],
      [null],
      [null],
      ["mei@x"],
      ["Viewer"],
      ["umer@x"],
    ]);
  });

  it("logs nothing when the person already had that role", async () => {
    answers.target = { email: "mei@x", role: "editor" };
    answers.updated = [{ id: 2, email: "mei@x", role: "editor" }];

    const response = await PUT(request({ userId: 2, role: "editor" }));

    expect(response.status).toBe(200);
    expect(at(LOG)).toBe(-1);
    expect(texts()).toContain("COMMIT");
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
    expect(at(/^DELETE FROM/)).toBe(-1);
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
    expect(at(COUNT)).toBeLessThan(at(/^DELETE FROM memberships/));
    expect(at(/^DELETE FROM memberships/)).toBeLessThan(at(/^COMMIT/));
  });

  it("removes the membership, then the profile only once no membership is left", async () => {
    // Removing someone from one organization must not take away their place
    // in another, so the profile, which says who they are wherever they
    // belong, goes only when this was their last membership. The check is
    // inside the DELETE itself, so a membership somewhere else that was added
    // a moment ago still keeps the profile.
    answers.target = { email: "mei@x", role: "viewer" };

    const response = await DELETE(request({ userId: 2 }));

    expect(response.status).toBe(200);
    const membership = at(/^DELETE FROM memberships/);
    const profile = at(/^DELETE FROM profiles/);
    expect(texts()[membership]).toBe(
      "DELETE FROM memberships WHERE org_id = $1 AND profile_id = $2"
    );
    expect(statements[membership].values).toEqual([TEST_ORG.id, 2]);
    expect(texts()[profile]).toBe(
      "DELETE FROM profiles WHERE id = $1 " +
        "AND NOT EXISTS (SELECT 1 FROM memberships WHERE profile_id = $1)"
    );
    expect(statements[profile].values).toEqual([2]);
    expect(membership).toBeLessThan(profile);
    expect(profile).toBeLessThan(at(/^COMMIT/));
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
    expect(at(/^DELETE FROM/)).toBe(-1);
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

describe("which organization the statements act in", () => {
  // The organization is the gate's and never the body's. Every statement that
  // reads or changes a member, a role or the log names org_id and binds the
  // caller's organization, so an admin of one organization cannot reach a
  // member of another by sending their id, and an organization named in the
  // body changes nothing. The one statement without org_id is the profile
  // delete, which only ever removes a profile with no membership anywhere.
  const ACME = { orgId: 12, orgSlug: "acme", orgName: "Acme" };
  /** What a body that tries to name another organization adds. */
  const NAMES_TEST_ORG = { orgId: TEST_ORG.id, org: TEST_ORG.slug };

  /**
   * The values a statement binds for org_id: one per `org_id = $n` in it, or,
   * for the change log's INSERT, which names org_id as its first column, the
   * first value.
   */
  function orgIdsBound(statement: Statement): unknown[] {
    const placeholders = Array.from(statement.text.matchAll(/org_id = \$(\d+)/g));
    if (placeholders.length === 0) return [statement.values[0]];
    return placeholders.map((match) => statement.values[Number(match[1]) - 1]);
  }

  function expectEveryStatementInAcme() {
    const scoped = statements.filter(
      ({ text }) =>
        !/^\s*(BEGIN|COMMIT|ROLLBACK)\s*$/.test(text) &&
        !/^\s*DELETE FROM profiles/.test(withoutComments(text))
    );
    expect(scoped.length).toBeGreaterThan(0);
    for (const statement of scoped) {
      expect(statement.text).toMatch(/\borg_id\b/);
      for (const id of orgIdsBound(statement)) expect(id).toBe(ACME.orgId);
    }
  }

  beforeEach(() => {
    mockPrincipalOver = ACME;
  });

  it("lists the members and roles of the caller's organization only", async () => {
    const response = await GET();

    expect(response.status).toBe(200);
    expectEveryStatementInAcme();
    expect(at(/FROM memberships m JOIN profiles p/)).toBeGreaterThan(-1);
    expect(at(/FROM roles r/)).toBeGreaterThan(-1);
  });

  it("keeps a demotion in the caller's organization", async () => {
    answers.target = { email: "mei@x", role: "admin" };
    answers.otherAdmins = 1;

    const response = await PUT(request({ userId: 2, role: "viewer", ...NAMES_TEST_ORG }));

    expect(response.status).toBe(200);
    expectEveryStatementInAcme();
    // A demotion that is logged sends every kind of statement PUT can send.
    expect(at(LOCK)).toBeGreaterThan(-1);
    expect(at(UPDATE)).toBeGreaterThan(-1);
    expect(at(/^INSERT INTO role_changes/)).toBeGreaterThan(-1);
  });

  it("keeps a removal in the caller's organization", async () => {
    answers.target = { email: "mei@x", role: "admin" };
    answers.otherAdmins = 1;

    const response = await DELETE(request({ userId: 2, ...NAMES_TEST_ORG }));

    expect(response.status).toBe(200);
    expectEveryStatementInAcme();
    expect(at(LOCK)).toBeGreaterThan(-1);
    expect(at(/^DELETE FROM memberships/)).toBeGreaterThan(-1);
  });
});
