// roles-bootstrap: what setUpRoles and seedBuiltInRoles (lib/db/bootstrap.ts)
// do to the app's database on every boot.
//
// They run before anyone can sign in, on databases of every age: a new one,
// one made before organizations existed, and one whose admins have spent weeks
// tuning their roles. So what they must never do matters as much as what they
// do:
//
//   - Every organization gets its own Viewer, Editor and Admin, and Viewer and
//     Editor get the permissions the old role ladder gave them.
//   - A second boot grants nothing. A box an admin unticked is still unticked
//     after a restart.
//   - A permission added to the app later reaches Viewer and Editor once, so a
//     new feature is not invisible to everyone but admins.
//   - Seeding one organization never writes a row into another.
//   - A failure part way leaves nothing half done.
//
// What the SQL itself does to real rows (which organizations count as due,
// what a re-run leaves behind) is checked against a real database in
// tests/org-migration.test.ts.
import {
  createFakeClient,
  queriesMatching,
  queryTexts,
  type FakeClient,
  type FakeStep,
} from "./helpers/fake-pg";

let mockPool: FakeClient = createFakeClient([]);
let mockClient: FakeClient = createFakeClient([]);
/** Everything said to the database, in order, on whichever connection. */
let mockSaid: string[] = [];
/** How many connections setUpRoles borrowed from the pool. */
let mockConnects = 0;

// setUpRoles asks the shared pool which organizations are due, then borrows
// one client for their transactions. Both are wrapped so the order across the
// two can be checked; each fake still records its own queries and values.
jest.mock("../lib/db/sequelize", () => ({
  sequelize: {},
  metadataPool: {
    query: (text: string, values?: unknown[]) => {
      mockSaid.push(`pool: ${text}`);
      return mockPool.query(text, values);
    },
    connect: async () => {
      mockConnects += 1;
      return {
        query: (text: string, values?: unknown[]) => {
          mockSaid.push(`client: ${text}`);
          return mockClient.query(text, values);
        },
        release: () => mockClient.release(),
      };
    },
  },
}));
// The models only matter to sync() and the default organization, which these
// two functions never reach.
jest.mock("../lib/db/models", () => ({}));

import { seedBuiltInRoles, setUpRoles } from "@/lib/db/bootstrap";
import type { MetadataClient } from "@/lib/db/sequelize";
import { BUILT_IN_ROLE_INFO, presetFor } from "@/lib/permissions";

const VIEWER: string[] = [...(presetFor("viewer") ?? [])];
const EDITOR: string[] = [...(presetFor("editor") ?? [])];

/** The organization the seeding tests write into. Any id but 1 will do. */
const ORG = 7;

const DROP_CHECK = "ALTER TABLE profiles DROP CONSTRAINT IF EXISTS profiles_role_check";
// The fake matches steps against the text as written, line breaks included.
const FIND_DUE = /^SELECT o\.id FROM organizations o\s+WHERE EXISTS/;
const WRITE_ROLES =
  "INSERT INTO roles (org_id, name, label, description, built_in) " +
  "SELECT $1, name, label, description, true " +
  "FROM unnest($2::text[], $3::text[], $4::text[]) AS r(name, label, description) " +
  "ON CONFLICT (org_id, name) DO NOTHING";
const LOCK_ROLE =
  "SELECT preset_applied FROM roles WHERE org_id = $1 AND name = $2 FOR UPDATE";
const GRANT_ROWS =
  "INSERT INTO role_permissions (org_id, role, feature, action) SELECT $1, $2, feature, action " +
  "FROM unnest($3::text[], $4::text[]) AS p(feature, action) ON CONFLICT DO NOTHING";
const REMEMBER = "UPDATE roles SET preset_applied = $3::jsonb WHERE org_id = $1 AND name = $2";

beforeEach(() => {
  mockPool = createFakeClient([]);
  mockClient = createFakeClient([]);
  mockSaid = [];
  mockConnects = 0;
});

/** The statements in order, whitespace squeezed so each one reads as a line. */
function said(): string[] {
  return mockSaid.map((line) => line.replace(/\s+/g, " ").trim());
}

/** A database where these organizations are the ones due for seeding. */
function organizationsDue(ids: number[], extra: FakeStep[] = []): void {
  mockPool = createFakeClient([
    ...extra,
    { match: /FROM organizations o/, rows: ids.map((id) => ({ id })) },
  ]);
}

/**
 * A database whose viewer and editor rows remember these presets as already
 * given, in every organization. `extra` steps go first, so they win over the
 * ones here.
 */
function rolesRemember(
  applied: { viewer: unknown; editor: unknown },
  extra: FakeStep[] = []
): FakeClient {
  mockClient = createFakeClient([
    ...extra,
    {
      match: /SELECT preset_applied FROM roles/,
      when: (values) => values[1] === "viewer",
      rows: [{ preset_applied: applied.viewer }],
    },
    {
      match: /SELECT preset_applied FROM roles/,
      when: (values) => values[1] === "editor",
      rows: [{ preset_applied: applied.editor }],
    },
  ]);
  return mockClient;
}

/** Seed ORG straight through seedBuiltInRoles, on the fake client. */
function seed(client: FakeClient): Promise<void> {
  return seedBuiltInRoles(client as unknown as MetadataClient, ORG);
}

/** The permission rows given to one role, as "feature:action" keys. */
function granted(client: FakeClient, role: string): string[] {
  return queriesMatching(client, /INSERT INTO role_permissions/)
    .filter((query) => query.values?.[1] === role)
    .flatMap((query) => {
      const [, , features, actions] = query.values as [number, string, string[], string[]];
      return features.map((feature, i) => `${feature}:${actions[i]}`);
    });
}

/** What was written to one role's preset_applied, or undefined when nothing was. */
function remembered(client: FakeClient, role: string): unknown {
  const updates = queriesMatching(client, /UPDATE roles SET preset_applied/).filter(
    (query) => query.values?.[1] === role
  );
  if (updates.length === 0) return undefined;
  expect(updates).toHaveLength(1);
  return JSON.parse(String(updates[0].values?.[2]));
}

const ROLLBACK_FAILS: FakeStep[] = [
  { match: /^ROLLBACK$/, error: { message: "connection terminated" } },
];

describe("finding the organizations to seed", () => {
  test("asks once, with every built-in role's preset, and stops when none is due", async () => {
    organizationsDue([]);
    await setUpRoles();

    expect(said()).toEqual([`pool: ${DROP_CHECK}`, expect.stringMatching(/^pool: SELECT o\.id/)]);
    expect(mockConnects).toBe(0);

    const [find] = queriesMatching(mockPool, FIND_DUE);
    // Admin is listed with nothing to give, so an organization is due for it
    // only when its admin row is missing.
    expect(JSON.parse(String(find.values?.[0]))).toEqual({
      viewer: VIEWER,
      editor: EDITOR,
      admin: [],
    });
  });

  test("seeds each due organization in a transaction of its own, on one connection", async () => {
    organizationsDue([1, 4]);
    const client = rolesRemember({ viewer: [], editor: [] });
    await setUpRoles();

    const seeding = [
      expect.stringMatching(/^client: INSERT INTO roles \(/),
      `client: ${LOCK_ROLE}`,
      `client: ${GRANT_ROWS}`,
      `client: ${REMEMBER}`,
      `client: ${LOCK_ROLE}`,
      `client: ${GRANT_ROWS}`,
      `client: ${REMEMBER}`,
    ];
    expect(said()).toEqual([
      `pool: ${DROP_CHECK}`,
      expect.stringMatching(/^pool: SELECT o\.id/),
      "client: BEGIN",
      ...seeding,
      "client: COMMIT",
      "client: BEGIN",
      ...seeding,
      "client: COMMIT",
    ]);
    // In the order the search returned them, each statement naming its own.
    expect(
      queriesMatching(client, /INSERT INTO roles \(/).map((query) => query.values?.[0])
    ).toEqual([1, 4]);
    expect(mockConnects).toBe(1);
    expect(client.releaseCount).toBe(1);
  });

  test("never ties profiles.role to the roles table any more", async () => {
    // A person's role lives on their membership now. The old key pointed at a
    // role by name alone, which is not unique once there are organizations.
    organizationsDue([1]);
    rolesRemember({ viewer: [], editor: [] });
    await setUpRoles();

    expect(said().filter((line) => /profiles_role_fkey|ADD CONSTRAINT/.test(line))).toEqual([]);
  });
});

describe("seeding one organization", () => {
  test("writes the three built-in roles into it, leaving alone any that are already there", async () => {
    const client = rolesRemember({ viewer: [], editor: [] });
    await seed(client);

    const inserts = queriesMatching(client, /INSERT INTO roles \(/);
    expect(inserts).toHaveLength(1);
    // DO NOTHING, so an admin's own description of Editor survives a boot.
    expect(queryTexts(client)[0]).toBe(WRITE_ROLES);
    expect(inserts[0].values).toEqual([
      ORG,
      ["viewer", "editor", "admin"],
      ["Viewer", "Editor", "Admin"],
      [
        BUILT_IN_ROLE_INFO.viewer.description,
        BUILT_IN_ROLE_INFO.editor.description,
        BUILT_IN_ROLE_INFO.admin.description,
      ],
    ]);
  });

  test("gives Viewer and Editor their presets, and remembers giving them", async () => {
    const client = rolesRemember({ viewer: [], editor: [] });
    await seed(client);

    expect(granted(client, "viewer")).toEqual(VIEWER);
    expect(granted(client, "editor")).toEqual(EDITOR);
    expect(remembered(client, "viewer")).toEqual(VIEWER);
    expect(remembered(client, "editor")).toEqual(EDITOR);
    // Admin can do everything by definition, so it has no rows to be given.
    expect(granted(client, "admin")).toEqual([]);
    expect(remembered(client, "admin")).toBeUndefined();
  });

  test("opens no transaction of its own, and locks each role before reading it", async () => {
    // The caller's transaction is what holds the row locks until the grant is
    // recorded, so a second server seeding the same organization waits and then
    // finds nothing new to give.
    const client = rolesRemember({ viewer: [], editor: [] });
    await seed(client);

    expect(queryTexts(client)).toEqual([
      WRITE_ROLES,
      LOCK_ROLE,
      GRANT_ROWS,
      REMEMBER,
      LOCK_ROLE,
      GRANT_ROWS,
      REMEMBER,
    ]);
    expect(queriesMatching(client, /FOR UPDATE/).map((query) => query.values)).toEqual([
      [ORG, "viewer"],
      [ORG, "editor"],
    ]);
    expect(client.releaseCount).toBe(0);
  });

  test("names its organization in every statement it sends", async () => {
    const client = rolesRemember({ viewer: [], editor: [] });
    await seed(client);

    for (const query of client.queries) {
      expect(query.text).toMatch(/org_id/);
      expect(query.values?.[0]).toBe(ORG);
    }
  });

  test("grants nothing again, so a box an admin unticked stays unticked", async () => {
    // Say editors lost Connections: Delete on the Admin screen. Their rows no
    // longer hold it, but preset_applied says it was given once, and that is
    // all this reads. The rows themselves are never looked at.
    const client = rolesRemember({ viewer: VIEWER, editor: EDITOR });
    await seed(client);

    expect(queryTexts(client)).toEqual([WRITE_ROLES, LOCK_ROLE, LOCK_ROLE]);
  });

  test("gives a permission added to the app since, once", async () => {
    // As if Drift tracking: Run had arrived in an update after this
    // organization was set up.
    const before = EDITOR.filter((key) => key !== "drift:run");
    const client = rolesRemember({ viewer: VIEWER, editor: before });
    await seed(client);

    expect(granted(client, "editor")).toEqual(["drift:run"]);
    expect(remembered(client, "editor")).toEqual([...before, "drift:run"]);
    expect(granted(client, "viewer")).toEqual([]);
    expect(remembered(client, "viewer")).toBeUndefined();

    // The boot after that one has nothing left to give.
    const next = rolesRemember({ viewer: VIEWER, editor: [...before, "drift:run"] });
    await seed(next);
    expect(queriesMatching(next, /role_permissions|UPDATE roles/)).toEqual([]);
  });

  test.each([
    ["null", null],
    ["an object", { "dashboard:read": true }],
    ["a string", "dashboard:read"],
  ])("reads a preset_applied that is %s as nothing given yet", async (_name, stored) => {
    // Only a hand edit could leave one of these. Reading it as "nothing given"
    // grants the preset again, which is what a new organization would have.
    const client = rolesRemember({ viewer: stored, editor: EDITOR });
    await seed(client);

    expect(granted(client, "viewer")).toEqual(VIEWER);
    expect(remembered(client, "viewer")).toEqual(VIEWER);
  });

  test("ignores entries in preset_applied that are not permission names", async () => {
    const client = rolesRemember({ viewer: [7, null, "dashboard:read"], editor: EDITOR });
    await seed(client);

    const rest = VIEWER.filter((key) => key !== "dashboard:read");
    expect(granted(client, "viewer")).toEqual(rest);
    // Rewritten without the junk, so it does not travel on to the next boot.
    expect(remembered(client, "viewer")).toEqual(["dashboard:read", ...rest]);
  });
});

describe("when something fails", () => {
  test.each([
    ["the rollback works", [] as FakeStep[]],
    ["the rollback fails too", ROLLBACK_FAILS],
  ])("leaves nothing half done, when %s", async (_name, extra) => {
    organizationsDue([1]);
    const client = rolesRemember({ viewer: [], editor: [] }, [
      ...extra,
      { match: /UPDATE roles SET preset_applied/, error: { message: "disk full" } },
    ]);

    // The first error is the one reported, not the failed rollback.
    await expect(setUpRoles()).rejects.toThrow("disk full");
    expect(queriesMatching(client, /COMMIT/)).toEqual([]);
    expect(queryTexts(client).at(-1)).toBe("ROLLBACK");
    expect(client.releaseCount).toBe(1);
  });

  test("goes no further than the organization that failed", async () => {
    // The next boot starts again from the search, which still finds both.
    organizationsDue([1, 2]);
    const client = rolesRemember({ viewer: [], editor: [] }, [
      {
        match: /UPDATE roles SET preset_applied/,
        when: (values) => values[0] === 1,
        error: { message: "disk full" },
      },
    ]);

    await expect(setUpRoles()).rejects.toThrow("disk full");
    expect(queriesMatching(client, /^BEGIN$/)).toHaveLength(1);
    const orgs = client.queries.flatMap((query) => (query.values ? [query.values[0]] : []));
    expect(new Set(orgs)).toEqual(new Set([1]));
    expect(client.releaseCount).toBe(1);
  });

  test("starts nothing when the old check cannot be dropped", async () => {
    mockPool = createFakeClient([
      { match: /DROP CONSTRAINT/, error: { message: "permission denied for table profiles" } },
    ]);
    await expect(setUpRoles()).rejects.toThrow("permission denied for table profiles");
    expect(said()).toEqual([`pool: ${DROP_CHECK}`]);
    expect(mockConnects).toBe(0);
  });

  test("borrows no connection when the search fails", async () => {
    organizationsDue([], [{ match: FIND_DUE, error: { message: "relation \"roles\" does not exist" } }]);
    await expect(setUpRoles()).rejects.toThrow('relation "roles" does not exist');
    expect(mockConnects).toBe(0);
  });
});
