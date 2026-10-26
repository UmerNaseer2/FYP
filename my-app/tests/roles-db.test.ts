// roles-db: the reads and writes behind the Admin screen's Roles tab.
//
// Run against a stand-in database (tests/helpers/fake-pg.ts), so what is
// checked is what lib/roles-db.ts says to Postgres and what it answers:
//
//   - The refusals a person can act on, each in the words the screen shows.
//     The ones that need no database are made before a connection is taken.
//   - The rows a save writes. What is stored is what the role can really do,
//     so a Run brings its feature's Read with it.
//   - The change log, which records the decision an admin made, one row per
//     box, and not every row that happened to move.
//   - The connection. Every write takes one and gives it back exactly once,
//     whichever way it ends, or the pool runs dry after a few failed saves.
//   - The organization. Every function takes the id of the one it acts in,
//     and every statement it sends names org_id and binds that id first, so
//     one organization's roles, rows and log never reach another's.
import {
  createFakeClient,
  queriesMatching,
  queryTexts,
  type FakeClient,
  type FakeStep,
} from "./helpers/fake-pg";

let mockPool: FakeClient = createFakeClient([]);
let mockClient: FakeClient = createFakeClient([]);
let mockConnects = 0;

// The pool's own query() answers the reads; connect() hands out the client a
// write runs its transaction on. Both are looked up when called, not when the
// mock is made, because this factory runs before the lines above do.
jest.mock("../lib/version-db", () => ({
  __esModule: true,
  default: {
    query: (text: string, values?: unknown[]) => mockPool.query(text, values),
    connect: async () => {
      mockConnects += 1;
      return mockClient;
    },
  },
  syncMetadataTables: async () => undefined,
}));

import {
  ALL_PERMISSIONS,
  ROLE_DESCRIPTION_MAX,
  ROLE_LABEL_MAX,
  isAdminOnly,
  presetFor,
} from "@/lib/permissions";
import {
  createRole,
  deleteRole,
  getRoleAccess,
  listRoleChanges,
  listRoles,
  lockRoles,
  logRoleChanges,
  resetRolePermissions,
  setRolePermissions,
} from "@/lib/roles-db";
import { TEST_ORG } from "./helpers/principals";

const ORG = TEST_ORG.id;
const ACTOR = "umer@x";
const ADMIN_IS_FIXED =
  "The admin role can always do everything, so its permissions can't be changed.";

beforeEach(() => {
  mockPool = createFakeClient([]);
  mockClient = createFakeClient([]);
  mockConnects = 0;
});

/** Make the next pool.connect() hand out a stand-in that answers with these steps. */
function connectsTo(steps: FakeStep[]): FakeClient {
  mockClient = createFakeClient(steps);
  return mockClient;
}

/** A role that exists and holds these permission rows, for the permission writes. */
function roleHolding(role: string, stored: string[]): FakeClient {
  return connectsTo([
    {
      match: /SELECT name FROM roles WHERE org_id = \$1 AND name = \$2 FOR UPDATE/,
      rows: [{ name: role }],
    },
    { match: /AS key FROM role_permissions/, rows: stored.map((key) => ({ key })) },
  ]);
}

/** The values bound to the one statement matching this pattern. */
function valuesOf(client: FakeClient, pattern: RegExp): unknown[] | undefined {
  const found = queriesMatching(client, pattern);
  expect(found).toHaveLength(1);
  return found[0].values;
}

type LoggedRow = {
  role: string | null;
  kind: string | null;
  feature: string | null;
  action: string | null;
  subject: string | null;
  detail: string | null;
  actor: string | null;
};

/**
 * The change log rows a write sent, read back out of what logRoleChanges
 * binds: the organization first, then seven arrays (one array per column,
 * one entry per row).
 */
function loggedRows(client: FakeClient): LoggedRow[] {
  const inserts = queriesMatching(client, /INSERT INTO role_changes/);
  if (inserts.length === 0) return [];
  expect(inserts).toHaveLength(1);
  const [orgId, ...columns] = inserts[0].values as [number, ...(string | null)[][]];
  expect(orgId).toBe(ORG);
  expect(columns).toHaveLength(7);
  const [roles, kinds, features, actions, subjects, details, actors] = columns;
  for (const column of columns) expect(column).toHaveLength(roles.length);
  return roles.map((role, i) => ({
    role,
    kind: kinds[i],
    feature: features[i],
    action: actions[i],
    subject: subjects[i],
    detail: details[i],
    actor: actors[i],
  }));
}

/** The log as short lines, "grant drift:run", for checking the order. */
function logLines(client: FakeClient): string[] {
  return loggedRows(client).map((row) =>
    row.feature === null ? `${row.kind}` : `${row.kind} ${row.feature}:${row.action}`
  );
}

/**
 * Every statement sent, other than the transaction's own, names org_id and
 * binds the organization as its first value. One that forgot either would
 * read or change another organization's rows, and the tests that check
 * single statements would not notice a new one added later.
 */
function expectKeptToOrg(client: FakeClient): void {
  const statements = client.queries.filter(
    (query) => !/^(BEGIN|COMMIT|ROLLBACK)$/.test(query.text.trim())
  );
  expect(statements.length).toBeGreaterThan(0);
  for (const statement of statements) {
    expect(statement.text).toMatch(/\borg_id\b/);
    expect(statement.values?.[0]).toBe(ORG);
  }
}

const ROLLBACK_FAILS: FakeStep[] = [
  { match: /^ROLLBACK$/, error: { message: "connection terminated" } },
];

describe("createRole", () => {
  test.each([
    ["an empty name", { label: "   " }, "Give the role a name."],
    [
      "a name that is too long",
      { label: "x".repeat(ROLE_LABEL_MAX + 1) },
      `Keep the name to ${ROLE_LABEL_MAX} characters or fewer.`,
    ],
    [
      "a description that is too long",
      { label: "QA Lead", description: "x".repeat(ROLE_DESCRIPTION_MAX + 1) },
      `Keep the description to ${ROLE_DESCRIPTION_MAX} characters or fewer.`,
    ],
    [
      "a name with no letter from A to Z and no digit in it",
      { label: "!!! ---" },
      "Give the role a name with at least one letter from A to Z, or a number.",
    ],
  ])("refuses %s before taking a connection", async (_name, input, error) => {
    const result = await createRole(ORG, { description: "", copyFrom: null, ...input }, ACTOR);
    expect(result).toEqual({ ok: false, status: 400, error });
    expect(mockConnects).toBe(0);
  });

  test("measures the name and description without the spaces around them", async () => {
    connectsTo([]);
    const result = await createRole(
      ORG,
      {
        label: `  ${"a".repeat(ROLE_LABEL_MAX)}  `,
        description: ` ${"d".repeat(ROLE_DESCRIPTION_MAX)} `,
        copyFrom: null,
      },
      ACTOR
    );
    expect(result.ok).toBe(true);
  });

  test("makes an empty role, and logs that nothing was copied", async () => {
    const client = connectsTo([]);
    const result = await createRole(
      ORG,
      { label: "  QA Lead ", description: "  Runs the test plan ", copyFrom: null },
      ACTOR
    );

    expect(result).toEqual({
      ok: true,
      role: {
        name: "qa-lead",
        label: "QA Lead",
        description: "Runs the test plan",
        builtIn: false,
        userCount: 0,
        permissions: [],
      },
    });
    expect(queryTexts(client)).toEqual([
      "BEGIN",
      "SELECT label FROM roles WHERE org_id = $1 AND " +
        "(name = $2 OR lower(label) = lower($3)) LIMIT 1",
      "INSERT INTO roles (org_id, name, label, description) VALUES ($1, $2, $3, $4)",
      expect.stringMatching(/^INSERT INTO role_changes/),
      "COMMIT",
    ]);
    expect(valuesOf(client, /INSERT INTO roles \(/)).toEqual([
      ORG,
      "qa-lead",
      "QA Lead",
      "Runs the test plan",
    ]);
    expect(loggedRows(client)).toEqual([
      {
        role: "qa-lead",
        kind: "create-role",
        feature: null,
        action: null,
        subject: null,
        detail: null,
        actor: ACTOR,
      },
    ]);
    expectKeptToOrg(client);
    expect(client.releaseCount).toBe(1);
  });

  test("refuses a name that is taken, and names the role in the way", async () => {
    const TAKEN = /SELECT label FROM roles\s+WHERE org_id = \$1 AND \(name = \$2 OR/;
    const client = connectsTo([{ match: TAKEN, rows: [{ label: "QA Lead" }] }]);
    const result = await createRole(
      ORG,
      { label: "qa  lead!", description: "", copyFrom: null },
      ACTOR
    );

    expect(result).toEqual({
      ok: false,
      status: 409,
      error: 'There is already a role called "QA Lead". Pick a different name.',
    });
    // Looked up by the key the name would be stored under, and by the name as
    // typed, so "qa  lead!" finds the "QA Lead" that is already there. Only
    // in this organization: another one's "QA Lead" is not in the way.
    expect(valuesOf(client, TAKEN)).toEqual([ORG, "qa-lead", "qa  lead!"]);
    expect(queriesMatching(client, /INSERT/)).toEqual([]);
    expect(queryTexts(client).at(-1)).toBe("ROLLBACK");
    expect(client.releaseCount).toBe(1);
  });

  test("refuses to copy a role that has gone", async () => {
    // Nothing answers the copy's lookup, the way a role deleted in another tab looks.
    const client = connectsTo([]);
    const result = await createRole(
      ORG,
      { label: "QA Lead", description: "", copyFrom: "old-role" },
      ACTOR
    );

    expect(result).toEqual({
      ok: false,
      status: 400,
      error: "The role to copy from no longer exists. Refresh the page and try again.",
    });
    expect(valuesOf(client, /FROM roles r\s+LEFT JOIN role_permissions/)).toEqual([
      ORG,
      "old-role",
    ]);
    expect(queriesMatching(client, /INSERT/)).toEqual([]);
    expect(queryTexts(client).at(-1)).toBe("ROLLBACK");
    expect(client.releaseCount).toBe(1);
  });

  test("copies Admin without the permissions only admin may hold", async () => {
    const client = connectsTo([
      // The admin role keeps no rows: it can do everything by definition.
      {
        match: /FROM roles r\s+LEFT JOIN role_permissions/,
        rows: [{ label: "Admin", granted: [] }],
      },
    ]);
    const result = await createRole(
      ORG,
      { label: "Deputy", description: "", copyFrom: "admin" },
      ACTOR
    );

    const expected = ALL_PERMISSIONS.filter((key) => !isAdminOnly(key));
    expect(result.ok && result.role.permissions).toEqual(expected);
    // Approving production runs is not admin-only, so a deputy can be given it.
    expect(expected).toContain("approvals:approve");
    expect(expected.filter((key) => /^(roles|organization):/.test(key))).toEqual([]);
    // Managing people comes along. The rank rule still keeps a deputy from
    // touching anyone who holds the admin role.
    expect(expected).toContain("users:update");
    expect(valuesOf(client, /INSERT INTO role_permissions/)).toEqual([
      ORG,
      "deputy",
      expected.map((key) => key.split(":")[0]),
      expected.map((key) => key.split(":")[1]),
    ]);
    expect(loggedRows(client)).toEqual([
      expect.objectContaining({ role: "deputy", kind: "create-role", detail: "Copied from Admin" }),
    ]);
  });

  test("copies what a role can do, not the rows it happens to have", async () => {
    const client = connectsTo([
      {
        match: /FROM roles r\s+LEFT JOIN role_permissions/,
        rows: [{ label: "QA Lead", granted: ["deploy:run", "roles:read", "reports:read"] }],
      },
    ]);
    const result = await createRole(
      ORG,
      { label: "QA Lead 2", description: "", copyFrom: "qa-lead" },
      ACTOR
    );

    // Run brings Deploy's Read with it. A row for an admin-only permission, or
    // for a feature the app no longer has, is left behind.
    expect(result.ok && result.role.permissions).toEqual(["deploy:read", "deploy:run"]);
    expect(valuesOf(client, /INSERT INTO role_permissions/)).toEqual([
      ORG,
      "qa-lead-2",
      ["deploy", "deploy"],
      ["read", "run"],
    ]);
    // The copy is read from this organization's role of that name, and
    // everything it writes is this organization's.
    expectKeptToOrg(client);
  });

  test.each([
    ["the rollback works", [] as FakeStep[]],
    ["the rollback fails too", ROLLBACK_FAILS],
  ])("turns a name taken in a race into the same refusal, when %s", async (_name, extra) => {
    const client = connectsTo([
      ...extra,
      {
        match: /INSERT INTO roles \(/,
        error: { code: "23505", message: "duplicate key value violates unique constraint" },
      },
    ]);
    const result = await createRole(
      ORG,
      { label: "QA Lead", description: "", copyFrom: null },
      ACTOR
    );

    expect(result).toEqual({
      ok: false,
      status: 409,
      error: "There is already a role with that name. Pick a different name.",
    });
    expect(queriesMatching(client, /COMMIT/)).toEqual([]);
    expect(queryTexts(client).at(-1)).toBe("ROLLBACK");
    expect(client.releaseCount).toBe(1);
  });

  test.each([
    ["the rollback works", [] as FakeStep[]],
    ["the rollback fails too", ROLLBACK_FAILS],
  ])("passes any other failure on, when %s", async (_name, extra) => {
    const client = connectsTo([
      ...extra,
      { match: /INSERT INTO role_changes/, error: { message: "disk full" } },
    ]);

    // The error worth reporting is the first one, not the failed rollback.
    await expect(
      createRole(ORG, { label: "QA Lead", description: "", copyFrom: null }, ACTOR)
    ).rejects.toThrow("disk full");
    expect(queriesMatching(client, /COMMIT/)).toEqual([]);
    expect(queryTexts(client).at(-1)).toBe("ROLLBACK");
    expect(client.releaseCount).toBe(1);
  });
});

describe("setRolePermissions", () => {
  test.each([
    ["the admin role", "admin", ["deploy:read"], ADMIN_IS_FIXED],
    [
      "a permission the app does not know, cut short",
      "qa-lead",
      ["deploy:run", "x".repeat(100), "users:read"],
      `"${"x".repeat(60)}" is not a permission this app knows.`,
    ],
    [
      "a permission only admin may hold",
      "editor",
      ["deploy:run", "roles:update"],
      '"Roles & permissions: Update" can only belong to the admin role.',
    ],
  ])("refuses %s before taking a connection", async (_name, role, keys, error) => {
    expect(await setRolePermissions(ORG, role, keys, ACTOR)).toEqual({
      ok: false,
      status: 400,
      error,
    });
    expect(mockConnects).toBe(0);
  });

  test("stores the Read a box implies, and clears rows for features that are gone", async () => {
    const client = roleHolding("qa-lead", ["deploy:read", "deploy:run", "reports:read"]);
    const result = await setRolePermissions(ORG, "qa-lead", ["deploy:run", "drift:run"], ACTOR);

    expect(result).toEqual({
      ok: true,
      permissions: ["deploy:read", "deploy:run", "drift:read", "drift:run"],
      changes: 2,
    });
    expect(queryTexts(client)).toEqual([
      "BEGIN",
      "SELECT name FROM roles WHERE org_id = $1 AND name = $2 FOR UPDATE",
      "SELECT feature || ':' || action AS key FROM role_permissions " +
        "WHERE org_id = $1 AND role = $2",
      "DELETE FROM role_permissions WHERE org_id = $1 AND role = $2 " +
        "AND feature || ':' || action = ANY($3::text[])",
      "INSERT INTO role_permissions (org_id, role, feature, action) " +
        "SELECT $1::int, $2::text, feature, action " +
        "FROM unnest($3::text[], $4::text[]) AS p(feature, action)",
      expect.stringMatching(/^INSERT INTO role_changes/),
      "COMMIT",
    ]);
    expect(valuesOf(client, /DELETE FROM role_permissions/)).toEqual([
      ORG,
      "qa-lead",
      ["reports:read"],
    ]);
    expect(valuesOf(client, /INSERT INTO role_permissions/)).toEqual([
      ORG,
      "qa-lead",
      ["drift", "drift"],
      ["read", "run"],
    ]);
    // Tidying the stale row was nobody's decision, so it is not in the log.
    expect(loggedRows(client)).toEqual([
      {
        role: "qa-lead",
        kind: "grant",
        feature: "drift",
        action: "read",
        subject: null,
        detail: null,
        actor: ACTOR,
      },
      expect.objectContaining({ kind: "grant", feature: "drift", action: "run" }),
    ]);
    expectKeptToOrg(client);
    expect(client.releaseCount).toBe(1);
  });

  test("logs nothing for a Read the role already had through another box", async () => {
    // A Run row without its Read row, the way a hand-written row could be.
    const client = roleHolding("qa-lead", ["deploy:run"]);
    const result = await setRolePermissions(ORG, "qa-lead", ["deploy:run"], ACTOR);

    expect(result).toEqual({ ok: true, permissions: ["deploy:read", "deploy:run"], changes: 0 });
    // The table catches up with what the role could already do...
    expect(valuesOf(client, /INSERT INTO role_permissions/)).toEqual([
      ORG,
      "qa-lead",
      ["deploy"],
      ["read"],
    ]);
    // ...and the log, which is about what changed, has nothing to say.
    expect(queriesMatching(client, /role_changes/)).toEqual([]);
  });

  test("logs one row per box, the ones ticked before the ones unticked", async () => {
    const client = roleHolding("qa-lead", ["deploy:read", "deploy:run"]);
    const result = await setRolePermissions(ORG, "qa-lead", ["drift:run"], ACTOR);

    expect(result.ok && result.changes).toBe(4);
    expect(logLines(client)).toEqual([
      "grant drift:read",
      "grant drift:run",
      "revoke deploy:read",
      "revoke deploy:run",
    ]);
    expect(valuesOf(client, /DELETE FROM role_permissions/)).toEqual([
      ORG,
      "qa-lead",
      ["deploy:read", "deploy:run"],
    ]);
  });

  test("takes everything away when sent an empty list", async () => {
    const client = roleHolding("qa-lead", ["drift:read", "drift:run"]);
    const result = await setRolePermissions(ORG, "qa-lead", [], ACTOR);

    expect(result).toEqual({ ok: true, permissions: [], changes: 2 });
    expect(logLines(client)).toEqual(["revoke drift:read", "revoke drift:run"]);
    expect(queriesMatching(client, /INSERT INTO role_permissions/)).toEqual([]);
  });

  test("writes nothing but the lock when the role already has exactly that", async () => {
    const client = roleHolding("qa-lead", ["deploy:read", "deploy:run"]);
    const result = await setRolePermissions(
      ORG,
      "qa-lead",
      ["deploy:read", "deploy:run"],
      ACTOR
    );

    expect(result).toEqual({ ok: true, permissions: ["deploy:read", "deploy:run"], changes: 0 });
    expect(queryTexts(client)).toEqual([
      "BEGIN",
      "SELECT name FROM roles WHERE org_id = $1 AND name = $2 FOR UPDATE",
      "SELECT feature || ':' || action AS key FROM role_permissions " +
        "WHERE org_id = $1 AND role = $2",
      "COMMIT",
    ]);
  });

  test("refuses a role that has been deleted since the page loaded", async () => {
    const client = connectsTo([]);
    expect(await setRolePermissions(ORG, "qa-lead", ["deploy:run"], ACTOR)).toEqual({
      ok: false,
      status: 404,
      error: "That role no longer exists. Refresh the page.",
    });
    expect(queryTexts(client)).toEqual([
      "BEGIN",
      "SELECT name FROM roles WHERE org_id = $1 AND name = $2 FOR UPDATE",
      "ROLLBACK",
    ]);
    expect(client.releaseCount).toBe(1);
  });

  test.each([
    ["the rollback works", [] as FakeStep[]],
    ["the rollback fails too", ROLLBACK_FAILS],
  ])("passes a failure on with nothing committed, when %s", async (_name, extra) => {
    const client = connectsTo([
      ...extra,
      {
        match: /SELECT name FROM roles WHERE org_id = \$1 AND name = \$2 FOR UPDATE/,
        rows: [{ name: "qa-lead" }],
      },
      { match: /INSERT INTO role_permissions/, error: { message: "disk full" } },
    ]);

    await expect(setRolePermissions(ORG, "qa-lead", ["deploy:run"], ACTOR)).rejects.toThrow(
      "disk full"
    );
    expect(queriesMatching(client, /COMMIT|role_changes/)).toEqual([]);
    expect(queryTexts(client).at(-1)).toBe("ROLLBACK");
    expect(client.releaseCount).toBe(1);
  });
});

describe("resetRolePermissions", () => {
  test.each([
    ["admin", ADMIN_IS_FIXED],
    ["qa-lead", "Only Viewer and Editor have a default to go back to."],
  ])("refuses %s before taking a connection", async (role, error) => {
    expect(await resetRolePermissions(ORG, role, ACTOR)).toEqual({ ok: false, status: 400, error });
    expect(mockConnects).toBe(0);
  });

  test("puts Editor back, logging each box and then the reset on top", async () => {
    const preset = presetFor("editor") ?? [];
    // An admin took Deploy: Run away from editors and gave them Approve.
    const stored = [...preset.filter((key) => key !== "deploy:run"), "approvals:approve"];
    const client = roleHolding("editor", stored);
    const result = await resetRolePermissions(ORG, "editor", ACTOR);

    // The reset row is not a box, so it is not one of the changes counted.
    expect(result).toEqual({ ok: true, permissions: [...preset], changes: 2 });
    expect(logLines(client)).toEqual(["grant deploy:run", "revoke approvals:approve", "reset"]);
    expect(loggedRows(client).at(-1)).toEqual({
      role: "editor",
      kind: "reset",
      feature: null,
      action: null,
      subject: null,
      detail: null,
      actor: ACTOR,
    });
    expect(valuesOf(client, /DELETE FROM role_permissions/)).toEqual([
      ORG,
      "editor",
      ["approvals:approve"],
    ]);
    expect(valuesOf(client, /INSERT INTO role_permissions/)).toEqual([
      ORG,
      "editor",
      ["deploy"],
      ["run"],
    ]);
    expectKeptToOrg(client);
  });

  test("still logs a reset that found nothing to change, so the log shows it was pressed", async () => {
    const preset = presetFor("viewer") ?? [];
    const client = roleHolding("viewer", [...preset]);
    const result = await resetRolePermissions(ORG, "viewer", ACTOR);

    expect(result).toEqual({ ok: true, permissions: [...preset], changes: 0 });
    expect(logLines(client)).toEqual(["reset"]);
  });
});

describe("deleteRole", () => {
  const FOUND: FakeStep = {
    match: /SELECT label FROM roles WHERE org_id = \$1 AND name = \$2 FOR UPDATE/,
    rows: [{ label: "QA Lead" }],
  };

  test.each(["viewer", "editor", "admin"])(
    "refuses to delete %s, which is built in",
    async (role) => {
      expect(await deleteRole(ORG, role, ACTOR)).toEqual({
        ok: false,
        status: 400,
        error: "Viewer, Editor and Admin are built in and can't be deleted.",
      });
      expect(mockConnects).toBe(0);
    }
  );

  test("refuses a role that has already gone", async () => {
    const client = connectsTo([]);
    expect(await deleteRole(ORG, "qa-lead", ACTOR)).toEqual({
      ok: false,
      status: 404,
      error: "That role no longer exists. Refresh the page.",
    });
    expect(queryTexts(client)).toEqual([
      "BEGIN",
      "SELECT label FROM roles WHERE org_id = $1 AND name = $2 FOR UPDATE",
      "ROLLBACK",
    ]);
    expect(client.releaseCount).toBe(1);
  });

  test.each([
    [1, "1 person has this role. Give them another role on the Users tab first."],
    [3, "3 people have this role. Give them another role on the Users tab first."],
  ])("refuses a role still held by %i", async (count, error) => {
    const client = connectsTo([FOUND, { match: /SELECT count\(\*\)/, rows: [{ count }] }]);
    expect(await deleteRole(ORG, "qa-lead", ACTOR)).toEqual({ ok: false, status: 409, error });
    // The people who hold it in this organization. Another organization's
    // QA Lead is another role, and its holders do not keep this one alive.
    expect(valuesOf(client, /SELECT count\(\*\)/)).toEqual([ORG, "qa-lead"]);
    expect(queriesMatching(client, /DELETE|INSERT/)).toEqual([]);
    expect(queryTexts(client).at(-1)).toBe("ROLLBACK");
    expect(client.releaseCount).toBe(1);
  });

  test("deletes a role nobody holds, and logs the name it had", async () => {
    const client = connectsTo([FOUND, { match: /SELECT count\(\*\)/, rows: [{ count: 0 }] }]);
    expect(await deleteRole(ORG, "qa-lead", ACTOR)).toEqual({ ok: true });

    expect(queryTexts(client)).toEqual([
      "BEGIN",
      "SELECT label FROM roles WHERE org_id = $1 AND name = $2 FOR UPDATE",
      "SELECT count(*)::int AS count FROM memberships WHERE org_id = $1 AND role = $2",
      "DELETE FROM roles WHERE org_id = $1 AND name = $2",
      expect.stringMatching(/^INSERT INTO role_changes/),
      "COMMIT",
    ]);
    // The label, because the log row has to read after the role is gone.
    expect(loggedRows(client)).toEqual([
      {
        role: "qa-lead",
        kind: "delete-role",
        feature: null,
        action: null,
        subject: null,
        detail: "QA Lead",
        actor: ACTOR,
      },
    ]);
    expectKeptToOrg(client);
    expect(client.releaseCount).toBe(1);
  });

  test("gives the same answer when someone is given the role mid-delete", async () => {
    const client = connectsTo([
      FOUND,
      {
        match: /DELETE FROM roles/,
        error: { code: "23503", message: "violates foreign key constraint" },
      },
    ]);
    expect(await deleteRole(ORG, "qa-lead", ACTOR)).toEqual({
      ok: false,
      status: 409,
      error: "Someone still has this role. Give them another role on the Users tab first.",
    });
    expect(queryTexts(client).at(-1)).toBe("ROLLBACK");
    expect(client.releaseCount).toBe(1);
  });

  test.each([
    ["the rollback works", [] as FakeStep[]],
    ["the rollback fails too", ROLLBACK_FAILS],
  ])("passes any other failure on, when %s", async (_name, extra) => {
    const client = connectsTo([
      ...extra,
      FOUND,
      { match: /SELECT count\(\*\)/, error: { message: "disk full" } },
    ]);
    await expect(deleteRole(ORG, "qa-lead", ACTOR)).rejects.toThrow("disk full");
    expect(queriesMatching(client, /DELETE|COMMIT/)).toEqual([]);
    expect(queryTexts(client).at(-1)).toBe("ROLLBACK");
    expect(client.releaseCount).toBe(1);
  });
});

describe("logRoleChanges", () => {
  // The fake answers with rows and rowCount only, which is all logRoleChanges
  // reads. pg's full result type also has command, oid and fields.
  const asConnection = (client: FakeClient) =>
    client as unknown as Parameters<typeof logRoleChanges>[0];

  test("writes nothing at all for no entries", async () => {
    const client = createFakeClient([]);
    await logRoleChanges(asConnection(client), ORG, []);
    expect(client.queries).toEqual([]);
  });

  test("writes every entry in one statement, in the order given", async () => {
    const client = createFakeClient([]);
    await logRoleChanges(asConnection(client), ORG, [
      { role: "editor", kind: "assign", subject: "sam@x", detail: "viewer", actor: ACTOR },
      { role: "editor", kind: "grant", feature: "deploy", action: "run", actor: ACTOR },
    ]);
    expect(client.queries).toHaveLength(1);
    expect(loggedRows(client)).toEqual([
      {
        role: "editor",
        kind: "assign",
        feature: null,
        action: null,
        subject: "sam@x",
        detail: "viewer",
        actor: ACTOR,
      },
      {
        role: "editor",
        kind: "grant",
        feature: "deploy",
        action: "run",
        subject: null,
        detail: null,
        actor: ACTOR,
      },
    ]);
  });
});

describe("lockRoles", () => {
  test("locks this organization's roles of those names and says what each can do", async () => {
    const client = createFakeClient([
      {
        match: /FROM roles r/,
        rows: [
          { name: "admin", label: "Admin", granted: [] },
          { name: "qa-lead", label: "QA Lead", granted: ["deploy:run", "roles:update"] },
        ],
      },
    ]);

    // The stand-in answers only the fields the code reads.
    const roles = await lockRoles(client as unknown as Parameters<typeof lockRoles>[0], ORG, [
      "admin",
      "qa-lead",
      "ghost",
    ]);
    // The admin role holds everything whatever its rows say, and another role
    // never holds an admin-only box. A name it does not have is simply missing.
    expect(Object.fromEntries(roles)).toEqual({
      admin: { label: "Admin", permissions: [...ALL_PERMISSIONS] },
      "qa-lead": { label: "QA Lead", permissions: ["deploy:read", "deploy:run"] },
    });
    expect(client.queries[0].values).toEqual([ORG, ["admin", "qa-lead", "ghost"]]);
    // A key-share lock: a role cannot be deleted or renamed between this read
    // and the write that relies on it.
    expect(client.queries[0].text).toMatch(/FOR KEY SHARE OF r$/);
    expectKeptToOrg(client);
  });
});

describe("reading roles", () => {
  test("getRoleAccess answers null for a role the organization does not have", async () => {
    expect(await getRoleAccess(ORG, "ghost")).toBeNull();
    expect(mockPool.queries[0].values).toEqual([ORG, "ghost"]);
    expectKeptToOrg(mockPool);
  });

  test("getRoleAccess answers what a role can do", async () => {
    mockPool = createFakeClient([
      { match: /FROM roles r/, rows: [{ label: "QA Lead", granted: ["drift:run"] }] },
    ]);
    expect(await getRoleAccess(ORG, "qa-lead")).toEqual({
      role: "qa-lead",
      roleLabel: "QA Lead",
      permissions: ["drift:read", "drift:run"],
    });
  });

  test("listRoles says what each role can do", async () => {
    mockPool = createFakeClient([
      {
        match: /FROM roles r/,
        rows: [
          {
            name: "admin",
            label: "Admin",
            description: "Can do everything",
            built_in: true,
            user_count: 2,
            granted: [],
          },
          {
            name: "qa-lead",
            label: "QA Lead",
            description: "",
            built_in: false,
            user_count: 0,
            granted: ["deploy:run", "roles:update"],
          },
        ],
      },
    ]);
    expect(await listRoles(ORG)).toEqual([
      {
        name: "admin",
        label: "Admin",
        description: "Can do everything",
        builtIn: true,
        userCount: 2,
        permissions: [...ALL_PERMISSIONS],
      },
      {
        name: "qa-lead",
        label: "QA Lead",
        description: "",
        builtIn: false,
        userCount: 0,
        permissions: ["deploy:read", "deploy:run"],
      },
    ]);
    expectKeptToOrg(mockPool);
  });

  test("listRoles counts holders and rows in the role's own organization only", async () => {
    await listRoles(ORG);
    // Two organizations can each have a role called qa-lead. Matching on the
    // name alone would count the other one's members and add its boxes in.
    const [sql] = queryTexts(mockPool);
    expect(sql).toContain("WHERE m.org_id = r.org_id AND m.role = r.name");
    expect(sql).toContain("ON p.org_id = r.org_id AND p.role = r.name");
    expect(sql).toContain("WHERE r.org_id = $1");
    expect(sql).toContain("GROUP BY r.org_id, r.name");
  });

  test("listRoles puts the built-in roles first, then the rest by name as a person reads it", async () => {
    // Sent in no order at all, as a database may. "Équipe QA" goes with the
    // other names starting with E, not after Z, and "release manager" is not
    // put last for starting with a small letter. "Straße" and "Strasse" read
    // the same, so their keys settle which comes first.
    const row = (name: string, label: string, builtIn = false) => ({
      name,
      label,
      description: "",
      built_in: builtIn,
      user_count: 0,
      granted: [],
    });
    mockPool = createFakeClient([
      {
        match: /FROM roles r/,
        rows: [
          row("strasse", "Strasse"),
          row("qa-lead", "QA Lead"),
          row("admin", "Admin", true),
          row("release-manager", "release manager"),
          row("stra-e", "Straße"),
          row("equipe-qa", "Équipe QA"),
          row("viewer", "Viewer", true),
          row("fix-check", "Fix Check"),
          row("editor", "Editor", true),
        ],
      },
    ]);
    expect((await listRoles(ORG)).map((role) => role.label)).toEqual([
      "Viewer",
      "Editor",
      "Admin",
      "Équipe QA",
      "Fix Check",
      "QA Lead",
      "release manager",
      "Straße",
      "Strasse",
    ]);
  });

  test.each([
    [undefined, 50],
    [0, 1],
    [-5, 1],
    [7.9, 7],
    [500, 200],
  ])("listRoleChanges(%p) asks for %i rows", async (limit, rows) => {
    await listRoleChanges(ORG, limit);
    expect(mockPool.queries[0].values).toEqual([ORG, rows]);
  });

  test("listRoleChanges reads the organization's log, and names roles from it alone", async () => {
    await listRoleChanges(ORG);
    const [sql] = queryTexts(mockPool);
    expect(sql).toContain("ON r.org_id = c.org_id AND r.name = c.role");
    expect(sql).toContain("WHERE c.org_id = $1");
  });

  test("listRoleChanges hands times back as text, and leaves a deleted role unnamed", async () => {
    mockPool = createFakeClient([
      {
        match: /FROM role_changes c/,
        rows: [
          {
            id: 9,
            role: "qa-lead",
            role_label: null,
            kind: "delete-role",
            feature: null,
            action: null,
            subject: null,
            detail: "QA Lead",
            actor: ACTOR,
            // What pg hands back for a timestamptz.
            created_at: new Date("2026-10-16T01:02:03.000Z"),
          },
          {
            id: 8,
            role: "editor",
            role_label: "Editor",
            kind: "grant",
            feature: "deploy",
            action: "run",
            subject: null,
            detail: null,
            actor: ACTOR,
            created_at: "2026-10-15 09:00:00+00",
          },
        ],
      },
    ]);
    expect(await listRoleChanges(ORG)).toEqual([
      {
        id: 9,
        role: "qa-lead",
        roleLabel: null,
        kind: "delete-role",
        feature: null,
        action: null,
        subject: null,
        detail: "QA Lead",
        actor: ACTOR,
        createdAt: "2026-10-16T01:02:03.000Z",
      },
      {
        id: 8,
        role: "editor",
        roleLabel: "Editor",
        kind: "grant",
        feature: "deploy",
        action: "run",
        subject: null,
        detail: null,
        actor: ACTOR,
        createdAt: "2026-10-15 09:00:00+00",
      },
    ]);
  });
});
