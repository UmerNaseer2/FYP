// roles-bootstrap: what setUpRoles (lib/db/bootstrap.ts) does to the app's
// database on every boot.
//
// It runs before anyone can sign in, on databases of every age: a new one, one
// made before roles existed, and one an admin has spent weeks tuning. So what
// it must never do matters as much as what it does:
//
//   - A new database gets Viewer, Editor and Admin, and Viewer and Editor get
//     the permissions the old role ladder gave them.
//   - A second boot grants nothing. A box an admin unticked is still unticked
//     after a restart.
//   - A permission added to the app later reaches Viewer and Editor once, so a
//     new feature is not invisible to everyone but admins.
//   - A failure part way leaves nothing half done, and a database where the
//     profiles cannot be tied to the roles still boots, with a warning.
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

// setUpRoles uses the shared pool for the two ALTERs and one borrowed client
// for the transaction between them. Both are wrapped so the order across the
// two can be checked; each fake still records its own queries and values.
jest.mock("../lib/db/sequelize", () => ({
  sequelize: {},
  metadataPool: {
    query: (text: string, values?: unknown[]) => {
      mockSaid.push(`pool: ${text}`);
      return mockPool.query(text, values);
    },
    connect: async () => ({
      query: (text: string, values?: unknown[]) => {
        mockSaid.push(`client: ${text}`);
        return mockClient.query(text, values);
      },
      release: () => mockClient.release(),
    }),
  },
}));
// The models only matter to sync(), which setUpRoles does not call.
jest.mock("../lib/db/models", () => ({}));

import { setUpRoles } from "@/lib/db/bootstrap";
import { BUILT_IN_ROLE_INFO, presetFor } from "@/lib/permissions";

const VIEWER: string[] = [...(presetFor("viewer") ?? [])];
const EDITOR: string[] = [...(presetFor("editor") ?? [])];

const DROP_CHECK = "ALTER TABLE profiles DROP CONSTRAINT IF EXISTS profiles_role_check";
const ADD_FOREIGN_KEY =
  "ALTER TABLE profiles ADD CONSTRAINT profiles_role_fkey FOREIGN KEY (role) " +
  "REFERENCES roles (name) ON UPDATE CASCADE ON DELETE RESTRICT";
const LOCK_ROLE = "SELECT preset_applied FROM roles WHERE name = $1 FOR UPDATE";
const GRANT_ROWS =
  "INSERT INTO role_permissions (role, feature, action) SELECT $1, feature, action " +
  "FROM unnest($2::text[], $3::text[]) AS p(feature, action) ON CONFLICT DO NOTHING";
const REMEMBER = "UPDATE roles SET preset_applied = $2::jsonb WHERE name = $1";

beforeEach(() => {
  mockPool = createFakeClient([]);
  mockClient = createFakeClient([]);
  mockSaid = [];
});

afterEach(() => {
  jest.restoreAllMocks();
});

/** The statements in order, whitespace squeezed so each one reads as a line. */
function said(): string[] {
  return mockSaid.map((line) => line.replace(/\s+/g, " ").trim());
}

/**
 * A database whose viewer and editor rows remember these presets as already
 * given. `extra` steps go first, so they win over the ones here.
 */
function rolesRemember(
  applied: { viewer: unknown; editor: unknown },
  extra: FakeStep[] = []
): FakeClient {
  mockClient = createFakeClient([
    ...extra,
    {
      match: /SELECT preset_applied FROM roles/,
      when: (values) => values[0] === "viewer",
      rows: [{ preset_applied: applied.viewer }],
    },
    {
      match: /SELECT preset_applied FROM roles/,
      when: (values) => values[0] === "editor",
      rows: [{ preset_applied: applied.editor }],
    },
  ]);
  return mockClient;
}

/** The permission rows given to one role, as "feature:action" keys. */
function granted(client: FakeClient, role: string): string[] {
  return queriesMatching(client, /INSERT INTO role_permissions/)
    .filter((query) => query.values?.[0] === role)
    .flatMap((query) => {
      const [, features, actions] = query.values as [string, string[], string[]];
      return features.map((feature, i) => `${feature}:${actions[i]}`);
    });
}

/** What was written to one role's preset_applied, or undefined when nothing was. */
function remembered(client: FakeClient, role: string): unknown {
  const updates = queriesMatching(client, /UPDATE roles SET preset_applied/).filter(
    (query) => query.values?.[0] === role
  );
  if (updates.length === 0) return undefined;
  expect(updates).toHaveLength(1);
  return JSON.parse(String(updates[0].values?.[1]));
}

const ROLLBACK_FAILS: FakeStep[] = [
  { match: /^ROLLBACK$/, error: { message: "connection terminated" } },
];

describe("on a new database", () => {
  test("writes the three built-in roles, leaving alone any that are already there", async () => {
    const client = rolesRemember({ viewer: [], editor: [] });
    await setUpRoles();

    const inserts = queriesMatching(client, /INSERT INTO roles \(/);
    expect(inserts).toHaveLength(1);
    // DO NOTHING, so an admin's own description of Editor survives a boot.
    expect(inserts[0].text).toMatch(/ON CONFLICT \(name\) DO NOTHING/);
    expect(inserts[0].values).toEqual([
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
    await setUpRoles();

    expect(granted(client, "viewer")).toEqual(VIEWER);
    expect(granted(client, "editor")).toEqual(EDITOR);
    expect(remembered(client, "viewer")).toEqual(VIEWER);
    expect(remembered(client, "editor")).toEqual(EDITOR);
    // Admin can do everything by definition, so it has no rows to be given.
    expect(granted(client, "admin")).toEqual([]);
    expect(remembered(client, "admin")).toBeUndefined();
  });

  test("does the seeding in one transaction, and ties profiles to roles only after it", async () => {
    const client = rolesRemember({ viewer: [], editor: [] });
    await setUpRoles();

    // The foreign key comes last because it checks every profile's role
    // against the table. Added before the built-in rows were committed, it
    // would find everyone's role missing.
    expect(said()).toEqual([
      `pool: ${DROP_CHECK}`,
      "client: BEGIN",
      expect.stringMatching(/^client: INSERT INTO roles \(/),
      `client: ${LOCK_ROLE}`,
      `client: ${GRANT_ROWS}`,
      `client: ${REMEMBER}`,
      `client: ${LOCK_ROLE}`,
      `client: ${GRANT_ROWS}`,
      `client: ${REMEMBER}`,
      "client: COMMIT",
      `pool: ${ADD_FOREIGN_KEY}`,
    ]);
    expect(queriesMatching(client, /FOR UPDATE/).map((query) => query.values)).toEqual([
      ["viewer"],
      ["editor"],
    ]);
    expect(client.releaseCount).toBe(1);
  });
});

describe("on a database that has booted before", () => {
  test("grants nothing again, so a box an admin unticked stays unticked", async () => {
    // Say editors lost Connections: Delete on the Admin screen. Their rows no
    // longer hold it, but preset_applied says it was given once, and that is
    // all this reads. The rows themselves are never looked at.
    const client = rolesRemember({ viewer: VIEWER, editor: EDITOR });
    await setUpRoles();

    expect(queryTexts(client)).toEqual([
      "BEGIN",
      expect.stringMatching(/^INSERT INTO roles \(/),
      LOCK_ROLE,
      LOCK_ROLE,
      "COMMIT",
    ]);
  });

  test("gives a permission added to the app since, once", async () => {
    // As if Drift tracking: Run had arrived in an update after this database
    // was set up.
    const before = EDITOR.filter((key) => key !== "drift:run");
    const client = rolesRemember({ viewer: VIEWER, editor: before });
    await setUpRoles();

    expect(granted(client, "editor")).toEqual(["drift:run"]);
    expect(remembered(client, "editor")).toEqual([...before, "drift:run"]);
    expect(granted(client, "viewer")).toEqual([]);
    expect(remembered(client, "viewer")).toBeUndefined();

    // The boot after that one has nothing left to give.
    const next = rolesRemember({ viewer: VIEWER, editor: [...before, "drift:run"] });
    await setUpRoles();
    expect(queriesMatching(next, /role_permissions|UPDATE roles/)).toEqual([]);
  });

  test.each([
    ["null", null],
    ["an object", { "dashboard:read": true }],
    ["a string", "dashboard:read"],
  ])("reads a preset_applied that is %s as nothing given yet", async (_name, stored) => {
    // Only a hand edit could leave one of these. Reading it as "nothing given"
    // grants the preset again, which is what a new install would have.
    const client = rolesRemember({ viewer: stored, editor: EDITOR });
    await setUpRoles();

    expect(granted(client, "viewer")).toEqual(VIEWER);
    expect(remembered(client, "viewer")).toEqual(VIEWER);
  });

  test("ignores entries in preset_applied that are not permission names", async () => {
    const client = rolesRemember({ viewer: [7, null, "dashboard:read"], editor: EDITOR });
    await setUpRoles();

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
    const client = rolesRemember({ viewer: [], editor: [] }, [
      ...extra,
      { match: /UPDATE roles SET preset_applied/, error: { message: "disk full" } },
    ]);

    // The first error is the one reported, not the failed rollback.
    await expect(setUpRoles()).rejects.toThrow("disk full");
    expect(queriesMatching(client, /COMMIT/)).toEqual([]);
    expect(queryTexts(client).at(-1)).toBe("ROLLBACK");
    expect(client.releaseCount).toBe(1);
    // A failed seeding is not followed by the foreign key.
    expect(queryTexts(mockPool)).toEqual([DROP_CHECK]);
  });

  test("starts no transaction when the old check cannot be dropped", async () => {
    mockPool = createFakeClient([
      { match: /DROP CONSTRAINT/, error: { message: "permission denied for table profiles" } },
    ]);
    await expect(setUpRoles()).rejects.toThrow("permission denied for table profiles");
    expect(said()).toEqual([`pool: ${DROP_CHECK}`]);
  });
});

describe("tying profiles to roles", () => {
  /** Make the foreign key's ALTER fail with this SQLSTATE. */
  function foreignKeyFails(code: string, message: string) {
    rolesRemember({ viewer: VIEWER, editor: EDITOR });
    mockPool = createFakeClient([{ match: /ADD CONSTRAINT profiles_role_fkey/, error: { code, message } }]);
  }

  test("is quiet when the key is already there", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    foreignKeyFails("42710", 'constraint "profiles_role_fkey" already exists');

    await expect(setUpRoles()).resolves.toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  test("boots anyway, with a warning, when someone's role is not in the table", async () => {
    // Refusing to boot would lock everyone out over one hand-edited profile,
    // and that person already gets no permissions: an unknown role holds none.
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    foreignKeyFails("23503", "insert or update violates foreign key constraint");

    await expect(setUpRoles()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toBe(
      "profiles.role could not be tied to the roles table: at least one profile has a role " +
        "that does not exist. Those people have no permissions until an admin gives them a real role."
    );
    expect(warn.mock.calls[0][1]).toEqual(expect.objectContaining({ code: "23503" }));
  });

  test("passes any other failure on", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    foreignKeyFails("42501", "must be owner of table profiles");

    await expect(setUpRoles()).rejects.toThrow("must be owner of table profiles");
    expect(warn).not.toHaveBeenCalled();
  });
});
