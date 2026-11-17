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
import fs from "fs";
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
  "POST /api/deploy/approvals/[id]": "admin",
  "GET /api/github/family": "viewer",
  "GET /api/github/pull": "viewer",
  "POST /api/github/push": "editor",
  "GET /api/lineage": "viewer",
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
  "GET /api/scripts/attempts": "viewer",
  "POST /api/scripts/preflight": "viewer",
  "GET /api/scripts/schemas": "viewer",
  "GET /api/versionsync/ledger": "viewer",
};

/**
 * Handlers that did not exist at 256a210, and what each one asks for. Listed
 * so that a route added later has to say here who may call it, which is the
 * moment somebody should decide.
 */
const ADDED: Record<string, Gate> = {
  "GET /api/admin/invites": { kind: "permission", keys: ["users:read"] },
  "POST /api/admin/invites": { kind: "permission", keys: ["users:create"] },
  "DELETE /api/admin/invites": { kind: "permission", keys: ["users:create"] },
  "GET /api/admin/organization": { kind: "permission", keys: ["organization:read"] },
  "PATCH /api/admin/organization": { kind: "permission", keys: ["organization:update"] },
  "DELETE /api/admin/organization": { kind: "permission", keys: ["organization:delete"] },
  "GET /api/admin/github": { kind: "permission", keys: ["github:read"] },
  "PUT /api/admin/github": { kind: "permission", keys: ["github:update"] },
  "DELETE /api/admin/github": { kind: "permission", keys: ["github:update"] },
  "GET /api/admin/roles": { kind: "permission", keys: ["roles:read"] },
  "POST /api/admin/roles": { kind: "permission", keys: ["roles:create"] },
  "PUT /api/admin/roles": { kind: "permission", keys: ["roles:update"] },
  "DELETE /api/admin/roles": { kind: "permission", keys: ["roles:delete"] },
  "POST /api/invites/accept": { kind: "signed-in" },
  "GET /api/connections/machine": { kind: "permission", keys: ["connections:read", "connections:create", "connections:update"] },
  "GET /api/me": { kind: "member" },
  "GET /api/me/view-as": { kind: "member" },
  "POST /api/me/view-as": { kind: "member" },
  "GET /api/organizations": { kind: "signed-in" },
  "POST /api/organizations": { kind: "signed-in" },
  // Asking is open to every member. Who may answer is checked inside.
  "GET /api/requests": { kind: "member" },
  "POST /api/requests": { kind: "member" },
  "PATCH /api/requests/[id]": { kind: "member" },
  "POST /api/requests/seen": { kind: "member" },
  // AI assistance: using it, and the Admin screen's AI tab.
  "GET /api/ai/status": { kind: "permission", keys: ["ai:read"] },
  "POST /api/ai/rate": { kind: "permission", keys: ["ai:read"] },
  "POST /api/ai/chat": { kind: "permission", keys: ["ai:read"] },
  "POST /api/compare/summary": { kind: "permission", keys: ["compare:read"] },
  "POST /api/scripts/review": { kind: "permission", keys: ["deploy:read", "approvals:read"] },
  "POST /api/lineage/drift/explain": { kind: "permission", keys: ["drift:read"] },
  "POST /api/scripts/generate": { kind: "permission", keys: ["scripts:read"] },
  "GET /api/admin/ai": { kind: "permission", keys: ["organization:read"] },
  "PATCH /api/admin/ai": { kind: "permission", keys: ["organization:update"] },
  "PUT /api/admin/ai/key": { kind: "permission", keys: ["organization:update"] },
  "DELETE /api/admin/ai/key": { kind: "permission", keys: ["organization:update"] },
  // Deploying, rolling back and asking for approval: open to anyone who may
  // see deployments. Who may run by themselves, and who only with an Admin's
  // yes for that exact run, is decided inside, from "Deploy: Run" and the
  // connection's "who may run" (tests/run-approval.test.ts).
  "POST /api/deploy/approvals": { kind: "permission", keys: ["deploy:read"] },
  "POST /api/scripts/apply": { kind: "permission", keys: ["deploy:read"] },
  "POST /api/scripts/revert": { kind: "permission", keys: ["deploy:read"] },
  // The Stop button for a run that is going. Who may stop which run is
  // decided inside (tests/scripts-cancel-route.test.ts).
  "POST /api/scripts/cancel": { kind: "permission", keys: ["deploy:read"] },
};

/** NextAuth's endpoints, ungated then and now (see permissions-coverage). */
const UNGATED = [
  "GET /api/internal/drift-tick",
  "GET /api/auth/[...nextauth]",
  "POST /api/auth/[...nextauth]"];

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

describe.each(Object.entries(ADDED))("%s, added since 256a210", (name, gate) => {
  test("asks for what was decided", () => {
    expect(handlers.get(name)?.gate).toEqual(gate);
  });

  if (gate.kind === "permission" && name.endsWith("/api/admin/roles")) {
    test("is for admins only", () => {
      // Managing roles must not be grantable, or a role allowed to edit roles
      // could tick its own way to admin.
      expect(gate.keys.every((key) => isAdminOnly(key as PermissionKey))).toBe(true);
      expect(startsAllowed("admin", gate.keys)).toBe(true);
      expect(startsAllowed("editor", gate.keys)).toBe(false);
    });
  }
});

test("an AI route asks for AI assistance on top of the screen it serves", () => {
  // Each AI route calls aiPermissionRefusal, which checks "ai:read" for it.
  const asksForAi = (file: string) => fs.readFileSync(file, "utf8").includes("aiPermissionRefusal(");
  expect(hasPermissionLiterals(path.join(API_DIR, "..", "..", "lib", "ai", "respond.ts"))).toContain("ai:read");
  // requirePermission lets in any one of its keys, so each AI route that also
  // serves a screen checks "Use AI assistance" separately: a viewer, who may
  // compare but not use AI out of the box, is turned away.
  expect(handlers.get("POST /api/compare/summary")?.gate).toEqual({ kind: "permission", keys: ["compare:read"] });
  expect(asksForAi(path.join(API_DIR, "compare", "summary", "route.ts"))).toBe(true);
  expect(startsAllowed("viewer", ["compare:read"])).toBe(true);
  expect(startsAllowed("viewer", ["ai:read"])).toBe(false);
  expect(startsAllowed("editor", ["ai:read"])).toBe(true);
  expect(handlers.get("POST /api/scripts/review")?.gate).toEqual({
    kind: "permission",
    keys: ["deploy:read", "approvals:read"],
  });
  expect(asksForAi(path.join(API_DIR, "scripts", "review", "route.ts"))).toBe(true);
  expect(startsAllowed("viewer", ["deploy:read", "approvals:read"])).toBe(true);
  expect(handlers.get("POST /api/lineage/drift/explain")?.gate).toEqual({ kind: "permission", keys: ["drift:read"] });
  expect(asksForAi(path.join(API_DIR, "lineage", "drift", "explain", "route.ts"))).toBe(true);
  expect(handlers.get("POST /api/scripts/generate")?.gate).toEqual({ kind: "permission", keys: ["scripts:read"] });
  expect(asksForAi(path.join(API_DIR, "scripts", "generate", "route.ts"))).toBe(true);
  expect(startsAllowed("viewer", ["drift:read"])).toBe(true);
  // The chat serves no screen of its own: AI assistance alone lets someone ask,
  // and each lookup then runs the read route's own check as them.
  expect(handlers.get("POST /api/ai/chat")?.gate).toEqual({ kind: "permission", keys: ["ai:read"] });
  expect(startsAllowed("viewer", ["ai:read"])).toBe(false);
});
