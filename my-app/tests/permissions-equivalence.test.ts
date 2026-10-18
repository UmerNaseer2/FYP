// permissions-equivalence: turning on per-feature permissions changed nobody's
// access.
//
// Before, every route asked one question: is this person at least a viewer, an
// editor or an admin? Now each route asks for named permissions, and Viewer,
// Editor and Admin start with the ones that reproduce the old answers. This
// file holds the two systems side by side for every route that existed then:
//
//   - The role the route used to require still gets in, out of the box.
//   - The role below it still does not.
//
// The old checks are written out by hand, copied from commit 256a210 (the last
// one before this work), because that commit is history: nothing should ever
// change this table except a route that is added or removed.
import path from "path";
import { hasPermission, isAdminOnly, presetFor, type PermissionKey } from "@/lib/permissions";
import { allHandlers, hasPermissionLiterals, API_DIR, type Gate } from "./helpers/route-gates";

type OldRole = "viewer" | "editor" | "admin";

/** What each handler required at 256a210 (requireViewer, requireEditor, requireAdmin). */
const BEFORE: Record<string, OldRole> = {
  "GET /api/admin/users": "admin",
  "PUT /api/admin/users": "admin",
  "DELETE /api/admin/users": "admin",
  "POST /api/compare": "viewer",
  "GET /api/compare/version-history": "viewer",
  "GET /api/comparison-sets": "viewer",
  "POST /api/comparison-sets": "editor",
  "DELETE /api/comparison-sets": "editor",
  "GET /api/connections": "viewer",
  "POST /api/connections": "editor",
  "PUT /api/connections": "editor",
  "DELETE /api/connections": "editor",
  "POST /api/connections/test": "editor",
  "POST /api/connections/test-saved": "editor",
  "GET /api/deploy/approvals": "viewer",
  "POST /api/deploy/approvals": "editor",
  "POST /api/deploy/approvals/[id]": "admin",
  "GET /api/github/family": "viewer",
  "GET /api/github/pull": "viewer",
  "POST /api/github/push": "editor",
  "GET /api/lineage": "viewer",
  "PATCH /api/lineage": "editor",
  "DELETE /api/lineage": "editor",
  "GET /api/lineage/[id]": "viewer",
  "POST /api/lineage/acknowledge": "editor",
  "GET /api/lineage/audit": "viewer",
  "GET /api/lineage/drift": "viewer",
  "POST /api/lineage/drift": "editor",
  "GET /api/lineage/lookup": "viewer",
  "POST /api/lineage/rebaseline": "editor",
  "GET /api/lineage/schedule": "viewer",
  "PATCH /api/lineage/schedule": "editor",
  "GET /api/lineage/schemas": "viewer",
  "POST /api/lineage/track": "editor",
  "GET /api/performance/activity": "viewer",
  "GET /api/performance/advice": "viewer",
  "POST /api/performance/analyze": "viewer",
  "GET /api/performance/history": "viewer",
  "GET /api/performance/metrics": "viewer",
  "GET /api/performance/thresholds": "viewer",
  "PUT /api/performance/thresholds": "editor",
  "GET /api/schema/snapshot": "viewer",
  "POST /api/scripts/apply": "editor",
  "GET /api/scripts/attempts": "viewer",
  "POST /api/scripts/preflight": "viewer",
  "POST /api/scripts/revert": "editor",
  "GET /api/scripts/schemas": "viewer",
  "GET /api/versionsync/ledger": "viewer",
};

/**
 * Handlers that did not exist at 256a210, and what each one asks for. Listed
 * so that a route added later has to say here who may call it, which is the
 * moment somebody should decide.
 */
const ADDED: Record<string, Gate> = {
  "GET /api/admin/roles": { kind: "permission", keys: ["roles:read"] },
  "POST /api/admin/roles": { kind: "permission", keys: ["roles:create"] },
  "PUT /api/admin/roles": { kind: "permission", keys: ["roles:update"] },
  "DELETE /api/admin/roles": { kind: "permission", keys: ["roles:delete"] },
  "GET /api/me": { kind: "signed-in" },
  "GET /api/me/view-as": { kind: "signed-in" },
  "POST /api/me/view-as": { kind: "signed-in" },
};

/** NextAuth's endpoints, ungated then and now (see permissions-coverage). */
const UNGATED = ["GET /api/auth/[...nextauth]", "POST /api/auth/[...nextauth]"];

const BELOW: Record<OldRole, OldRole | null> = { viewer: null, editor: "viewer", admin: "editor" };

const handlers = new Map(allHandlers().map((h) => [`${h.method} /api/${h.route}`, h]));

/**
 * Whether a built-in role, as a new install starts it, gets through these keys.
 * The same question requirePermission asks, put to the preset that
 * lib/db/bootstrap.ts seeds the role with.
 */
function startsAllowed(role: OldRole, keys: string[]): boolean {
  const [first, ...rest] = keys as PermissionKey[];
  return first !== undefined && hasPermission({ permissions: presetFor(role) ?? [] }, first, ...rest);
}

test("every handler is in one of the tables above", () => {
  // A failure lists the handler. A new one goes in ADDED with what it asks
  // for; a removed one comes out of BEFORE.
  const listed = new Set([...Object.keys(BEFORE), ...Object.keys(ADDED), ...UNGATED]);
  expect([...handlers.keys()].filter((name) => !listed.has(name)).sort()).toEqual([]);
  expect([...listed].filter((name) => !handlers.has(name)).sort()).toEqual([]);
});

describe.each(Object.entries(BEFORE))("%s", (name, old) => {
  const handler = handlers.get(name);
  const keys = handler?.gate.kind === "permission" ? handler.gate.keys : [];

  test(`asks for permissions, as it used to ask for ${old}`, () => {
    expect(handler?.gate.kind).toBe("permission");
  });

  test(`still lets ${old} in`, () => {
    expect(startsAllowed(old, keys)).toBe(true);
  });

  const below = BELOW[old];
  if (below) {
    test(`still keeps ${below} out`, () => {
      expect(startsAllowed(below, keys)).toBe(false);
    });
  }
});

describe("checks made after the gate", () => {
  test("measuring a query still needs what an editor has and a viewer does not", () => {
    // It used to be a second requireEditor() inside the "measure" branch. It
    // is Performance: Run now, asked for once the body says it is a measure.
    const analyze = path.join(API_DIR, "performance", "analyze", "route.ts");
    expect(hasPermissionLiterals(analyze)).toEqual(["performance:run"]);
    expect(startsAllowed("editor", ["performance:run"])).toBe(true);
    expect(startsAllowed("viewer", ["performance:run"])).toBe(false);
  });

  test("saving a comparison set still needs editor, for a new set and an existing one", () => {
    // The gate lets in either box; saveComparisonSet then asks for the one the
    // name calls for (a free name creates, a taken one overwrites).
    for (const key of ["comparison_sets:create", "comparison_sets:update"]) {
      expect([key, startsAllowed("editor", [key]), startsAllowed("viewer", [key])]).toEqual([
        key,
        true,
        false,
      ]);
    }
  });
});

describe.each(Object.entries(ADDED))("%s, added with this work", (name, gate) => {
  test("asks for what was decided", () => {
    expect(handlers.get(name)?.gate).toEqual(gate);
  });

  if (gate.kind === "permission") {
    test("is for admins only", () => {
      // Managing roles must not be grantable, or a role allowed to edit roles
      // could tick its own way to admin.
      expect(gate.keys.every((key) => isAdminOnly(key as PermissionKey))).toBe(true);
      expect(startsAllowed("admin", gate.keys)).toBe(true);
      expect(startsAllowed("editor", gate.keys)).toBe(false);
    });
  }
});
