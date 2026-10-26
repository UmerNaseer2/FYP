// permissions: the catalogue of what each role may do, feature by feature.
//
// The client asked at the 22 September review for an admin to be able to say,
// for every role and every feature, which of create, read, update and delete
// that role may do. lib/permissions.ts is the one list of those permissions,
// and every route, screen and the admin grid reads it. Three things here would
// be easy to break without noticing:
//
//   - The day-one grid. Viewer and Editor start with exactly what the old
//     viewer and editor ranks allowed, so turning this system on changed
//     nobody's access. A `from` edited by mistake would quietly hand a viewer a
//     button, and nothing on screen would say so.
//   - The three rules effectivePermissions applies whatever the database says:
//     admin can do everything, nobody else holds an admin-only permission, and
//     every box brings its feature's Read with it.
//   - The sentences people read when they are refused, which name the exact box
//     an admin has to tick.
import {
  ACTIONS,
  ADMIN_ROLE,
  ALL_PERMISSIONS,
  BUILT_IN_ROLES,
  FEATURES,
  PERMISSIONS,
  canHandOut,
  effectivePermissions,
  hasPermission,
  isAdminOnly,
  isBuiltInRole,
  isPermissionKey,
  permissionLabel,
  presetFor,
  readKeyOf,
  refusalMessage,
  roleKeyFrom,
  withToggled,
  type PermissionHolder,
  type PermissionKey,
} from "@/lib/permissions";
import { BYPASS_ACTOR, actorFor } from "@/lib/auth-mode";

/**
 * The grid the client agreed to, written out by hand on purpose: if this and
 * the catalogue disagree, one of them was changed without the other, and that
 * is a decision somebody should make deliberately rather than by accident.
 * The value is the lowest built-in role that has the box ticked out of the box.
 */
const AGREED_GRID: Record<string, "viewer" | "editor" | "admin"> = {
  "dashboard:read": "viewer",
  "connections:create": "editor",
  "connections:read": "viewer",
  "connections:update": "editor",
  "connections:delete": "editor",
  "compare:read": "viewer",
  "comparison_sets:create": "editor",
  "comparison_sets:read": "viewer",
  "comparison_sets:update": "editor",
  "comparison_sets:delete": "editor",
  "scripts:create": "editor",
  "scripts:read": "viewer",
  "deploy:read": "viewer",
  "deploy:run": "editor",
  "approvals:create": "editor",
  "approvals:read": "viewer",
  "approvals:approve": "admin",
  "version_sync:read": "viewer",
  "drift:create": "editor",
  "drift:read": "viewer",
  "drift:update": "editor",
  "drift:delete": "editor",
  "drift:run": "editor",
  "performance:read": "viewer",
  "performance:run": "editor",
  "alert_thresholds:read": "viewer",
  "alert_thresholds:update": "editor",
  "visualizer:read": "viewer",
  // Create on Users is inviting someone: step 3 of the organizations plan.
  "users:create": "admin",
  "users:read": "admin",
  "users:update": "admin",
  "users:delete": "admin",
  "roles:create": "admin",
  "roles:read": "admin",
  "roles:update": "admin",
  "roles:delete": "admin",
  "organization:read": "admin",
  "organization:update": "admin",
  "organization:delete": "admin",
};

describe("the catalogue", () => {
  test("holds exactly the agreed grid, in the order the admin grid shows it", () => {
    // Keys in the same order as AGREED_GRID: features top to bottom, and each
    // feature's actions in ACTIONS order (Create, Read, Update, Delete, Run,
    // Approve), which is the order of the grid's columns.
    expect(PERMISSIONS.map((p) => p.key)).toEqual(Object.keys(AGREED_GRID));
    for (const permission of PERMISSIONS) {
      expect([permission.key, permission.from]).toEqual([
        permission.key,
        AGREED_GRID[permission.key],
      ]);
    }
    expect(ALL_PERMISSIONS).toEqual(PERMISSIONS.map((p) => p.key));
  });

  test("gives every feature a Read, because every other box brings Read with it", () => {
    for (const feature of FEATURES) {
      expect([feature.key, "read" in feature.actions]).toEqual([feature.key, true]);
      expect(isPermissionKey(readKeyOf(feature.key))).toBe(true);
    }
  });

  test("keeps each feature's actions in the order of the grid's columns", () => {
    for (const feature of FEATURES) {
      const order = PERMISSIONS.filter((p) => p.feature === feature.key).map((p) =>
        ACTIONS.indexOf(p.action)
      );
      expect(order).toEqual([...order].sort((a, b) => a - b));
    }
  });

  test("makes only Roles & permissions and Organization admin-only", () => {
    // A role allowed to change roles could tick its own way to admin, and the
    // organization's settings include deleting it, so nothing else may hold
    // these, and every one of their boxes starts at admin. Users is not one:
    // the rank rule keeps managing people from being a way up.
    const adminOnly = FEATURES.filter((f) => "adminOnly" in f && f.adminOnly).map((f) => f.key);
    expect(adminOnly).toEqual(["roles", "organization"]);
    for (const permission of PERMISSIONS) {
      expect([permission.key, permission.adminOnly, isAdminOnly(permission.key)]).toEqual([
        permission.key,
        adminOnly.includes(permission.feature),
        adminOnly.includes(permission.feature),
      ]);
      if (permission.adminOnly) expect(permission.from).toBe("admin");
    }
  });

  test("words every permission so it finishes the sentence \"Your role can't ...\"", () => {
    // refusalMessage puts `does` straight after "can't", so a capital letter or
    // a full stop of its own would read wrongly in every refusal.
    for (const permission of PERMISSIONS) {
      expect([permission.key, permission.does]).toEqual([
        permission.key,
        expect.stringMatching(/^[a-z][^.]*[^.\s]$/),
      ]);
    }
  });
});

describe("presetFor", () => {
  test("starts Viewer able to read every feature but the people in it and the admin-only ones", () => {
    // Users is open to any role an Admin ticks it for, but a new Viewer is
    // not shown who else belongs and under which address.
    const expected = FEATURES.filter((f) => !("adminOnly" in f && f.adminOnly))
      .filter((f) => f.key !== "users")
      .map((f) => readKeyOf(f.key));
    expect(presetFor("viewer")).toEqual(expected);
    expect(presetFor("editor")).not.toContain("users:read");
  });

  test("starts Editor with everything the old editor rank had and nothing it did not", () => {
    const expected = Object.entries(AGREED_GRID)
      .filter(([, from]) => from !== "admin")
      .map(([key]) => key);
    expect(presetFor("editor")).toEqual(expected);
    expect(presetFor("editor")).not.toContain("approvals:approve");
  });

  test("gives Admin the whole catalogue", () => {
    expect(presetFor(ADMIN_ROLE)).toBe(ALL_PERMISSIONS);
  });

  test("has no preset for a custom role, which starts as a copy or with nothing", () => {
    expect(presetFor("qa-lead")).toBeNull();
    expect(presetFor("")).toBeNull();
    // Keys are lowercase; "Editor" is a label, not a role.
    expect(presetFor("Editor")).toBeNull();
  });

  test("never hands a built-in role other than admin an admin-only permission", () => {
    for (const role of BUILT_IN_ROLES.filter((r) => r !== ADMIN_ROLE)) {
      expect((presetFor(role) ?? []).filter(isAdminOnly)).toEqual([]);
    }
  });
});

describe("effectivePermissions", () => {
  test("lets admin do everything whatever its rows say", () => {
    // Otherwise unticking one box by hand in psql could lock every admin out
    // of the screen that ticks it back.
    expect(effectivePermissions(ADMIN_ROLE, [])).toEqual([...ALL_PERMISSIONS]);
    expect(effectivePermissions(ADMIN_ROLE, ["deploy:read"])).toEqual([...ALL_PERMISSIONS]);
  });

  test("hands back a copy for admin, so a caller cannot change the catalogue", () => {
    expect(effectivePermissions(ADMIN_ROLE, [])).not.toBe(ALL_PERMISSIONS);
  });

  test("drops an admin-only permission held by any other role", () => {
    expect(
      effectivePermissions("editor", ["organization:delete", "roles:update", "roles:read"])
    ).toEqual([]);
    // Users is not one of them.
    expect(effectivePermissions("lead", ["users:update"])).toEqual(["users:read", "users:update"]);
    expect(effectivePermissions("qa-lead", ["roles:delete", "deploy:run"])).toEqual([
      "deploy:read",
      "deploy:run",
    ]);
  });

  test("brings each feature's Read along with any other box on it", () => {
    expect(effectivePermissions("qa-lead", ["connections:delete"])).toEqual([
      "connections:read",
      "connections:delete",
    ]);
  });

  test("drops a permission the catalogue no longer knows", () => {
    // A feature removed since the row was written, or a hand-typed row. Kept,
    // it could match a check by accident one day; dropped, it can only be
    // noise in the table.
    expect(
      effectivePermissions("qa-lead", ["version_sync:create", "deploy:fly", "", "DEPLOY:RUN"])
    ).toEqual([]);
  });

  test("answers in catalogue order with no repeats, so two equal sets compare equal", () => {
    expect(
      effectivePermissions("qa-lead", [
        "visualizer:read",
        "dashboard:read",
        "visualizer:read",
        "drift:run",
        "drift:read",
      ])
    ).toEqual(["dashboard:read", "drift:read", "drift:run", "visualizer:read"]);
  });
});

describe("hasPermission", () => {
  const holder = { permissions: ["deploy:read", "drift:read"] };

  test("is any-of: one matching permission is enough", () => {
    expect(hasPermission(holder, "deploy:run", "deploy:read")).toBe(true);
    expect(hasPermission(holder, "drift:read")).toBe(true);
  });

  test("says no when none of them match", () => {
    expect(hasPermission(holder, "deploy:run", "connections:read")).toBe(false);
  });

  test("treats an unknown answer as a no", () => {
    expect(hasPermission(null, "dashboard:read")).toBe(false);
    expect(hasPermission(undefined, "dashboard:read")).toBe(false);
    expect(hasPermission({}, "dashboard:read")).toBe(false);
  });

  test("does not mistake a string for a list", () => {
    // "deploy:read".includes("deploy:read") is true, so a session that somehow
    // carried one string instead of a list would pass every check it spelled.
    const broken = { permissions: "deploy:read" } as unknown as PermissionHolder;
    expect(hasPermission(broken, "deploy:read")).toBe(false);
  });
});

describe("canHandOut", () => {
  const lead = { permissions: ["users:read", "users:create", "connections:read"] };

  test("lets someone hand out a role that can do no more than theirs, equal included", () => {
    expect(canHandOut(lead, [])).toBe(true);
    expect(canHandOut(lead, ["connections:read"])).toBe(true);
    expect(canHandOut(lead, lead.permissions)).toBe(true);
  });

  test("refuses a role that can do even one thing theirs can't", () => {
    expect(canHandOut(lead, ["connections:read", "connections:create"])).toBe(false);
  });

  test("keeps the admin role for Admins, since nobody else can hold its admin-only boxes", () => {
    const admin = presetFor("admin") ?? [];
    expect(canHandOut({ permissions: admin }, admin)).toBe(true);
    expect(canHandOut({ permissions: presetFor("editor") ?? [] }, admin)).toBe(false);
  });

  test("lets a holder with no list at all hand out nothing", () => {
    expect(canHandOut(null, [])).toBe(false);
    expect(canHandOut(undefined, [])).toBe(false);
    expect(canHandOut({}, [])).toBe(false);
  });
});

describe("refusalMessage", () => {
  test("names the box an admin has to tick", () => {
    expect(refusalMessage("Viewer", "connections:create")).toBe(
      'Your role (Viewer) can\'t add a connection. Ask an admin to allow "Connections: Create" for this role.'
    );
    expect(refusalMessage("QA Lead", "alert_thresholds:update")).toBe(
      'Your role (QA Lead) can\'t change alert thresholds. Ask an admin to allow "Alert thresholds: Update" for this role.'
    );
  });

  test("sends someone to ask for a Users box, which any role can be given", () => {
    expect(refusalMessage("Editor", "users:read")).toBe(
      'Your role (Editor) can\'t see the user list. Ask an admin to allow "Users: Read" for this role.'
    );
  });

  test("does not send anyone to ask for an admin-only box", () => {
    // It cannot be ticked for any role, so asking for it would be pointless.
    expect(refusalMessage("Editor", "organization:delete")).toBe(
      "Your role (Editor) can't delete the organization. Only admins can."
    );
    expect(refusalMessage("Editor", "roles:update")).toBe(
      "Your role (Editor) can't change what a role can do. Only admins can."
    );
  });

  test("still reads for a key the catalogue does not know", () => {
    expect(refusalMessage("Viewer", "nope:read" as PermissionKey)).toBe(
      "Your role (Viewer) can't do that."
    );
  });
});

describe("withToggled, the admin grid's checkbox rule", () => {
  test("ticks the feature's Read along with any other box", () => {
    expect(withToggled([], "connections:delete", true)).toEqual([
      "connections:read",
      "connections:delete",
    ]);
  });

  test("clears the whole feature when Read is unticked", () => {
    expect(
      withToggled(
        ["connections:create", "connections:read", "connections:update", "deploy:read"],
        "connections:read",
        false
      )
    ).toEqual(["deploy:read"]);
  });

  test("unticks only that box when it is not Read", () => {
    expect(
      withToggled(["connections:read", "connections:update"], "connections:update", false)
    ).toEqual(["connections:read"]);
  });

  test("leaves the set alone for a key it does not know", () => {
    expect(withToggled(["deploy:read"], "nope:run" as PermissionKey, true)).toEqual([
      "deploy:read",
    ]);
  });

  test("drops unknown keys and answers in catalogue order", () => {
    expect(withToggled(["visualizer:read", "bogus", "deploy:read"], "dashboard:read", true)).toEqual(
      ["dashboard:read", "deploy:read", "visualizer:read"]
    );
  });
});

describe("the small helpers", () => {
  test("permissionLabel names a box the way the grid does", () => {
    expect(permissionLabel("connections:create")).toBe("Connections: Create");
    expect(permissionLabel("roles:read")).toBe("Roles & permissions: Read");
    expect(permissionLabel("approvals:approve")).toBe("Approvals: Approve");
    expect(permissionLabel("nope:read" as PermissionKey)).toBe("nope:read");
  });

  test("isPermissionKey accepts exactly the catalogue's spelling", () => {
    expect(isPermissionKey("deploy:run")).toBe(true);
    for (const value of ["deploy:fly", "DEPLOY:RUN", " deploy:run", "deploy", "", 42, null, undefined]) {
      expect([value, isPermissionKey(value)]).toEqual([value, false]);
    }
  });

  test("isBuiltInRole knows the three keys and nothing that only looks like them", () => {
    for (const role of BUILT_IN_ROLES) expect(isBuiltInRole(role)).toBe(true);
    expect(isBuiltInRole("Admin")).toBe(false);
    expect(isBuiltInRole("qa-lead")).toBe(false);
  });
});

describe("roleKeyFrom, the key a new role is stored under", () => {
  test("turns a name into lowercase words joined by single hyphens", () => {
    expect(roleKeyFrom("QA Lead")).toBe("qa-lead");
    expect(roleKeyFrom("  Release   Manager  ")).toBe("release-manager");
    expect(roleKeyFrom("Ops/DBA team 2")).toBe("ops-dba-team-2");
  });

  test("keeps accented letters, without their accents", () => {
    expect(roleKeyFrom("Équipe QA")).toBe("equipe-qa");
    expect(roleKeyFrom("Prüfer")).toBe("prufer");
    expect(roleKeyFrom("Ｑ Ａ Lead")).toBe("q-a-lead");
  });

  test("gives nothing for a name with no letter from A to Z or digit, which the caller refuses", () => {
    expect(roleKeyFrom("!!!")).toBe("");
    expect(roleKeyFrom("   ")).toBe("");
    expect(roleKeyFrom("")).toBe("");
    expect(roleKeyFrom("管理者")).toBe("");
  });

  test("stops at 32 characters without leaving a hyphen on the end", () => {
    expect(roleKeyFrom("x".repeat(40))).toBe("x".repeat(32));
    // 31 letters, a space and one more: the cut lands right after the hyphen.
    expect(roleKeyFrom(`${"a".repeat(31)} b`)).toBe("a".repeat(31));
  });

  test("makes the same key for names that differ only in case or punctuation", () => {
    // Which is why createRole refuses the second one as already taken, when
    // both are in the same organization.
    expect(roleKeyFrom("QA Lead")).toBe(roleKeyFrom("qa-lead"));
    expect(roleKeyFrom("QA Lead")).toBe(roleKeyFrom("QA  LEAD!"));
  });
});

describe("actorFor, who an audit row names", () => {
  test("records the email of someone who signed in", () => {
    expect(actorFor({ email: "sam@example.com", bypass: false })).toBe("sam@example.com");
  });

  test("records that sign-in was off rather than the bypass's made-up address", () => {
    expect(actorFor({ email: "bypass@local", bypass: true })).toBe(BYPASS_ACTOR);
    expect(BYPASS_ACTOR).not.toContain("@");
  });
});
