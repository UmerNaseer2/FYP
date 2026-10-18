// ---------------------------------------------------------------------------
// permissions.ts
// What each role may do, feature by feature.
//
// The client asked for this at the 22 September review: an admin should be able
// to say, for every role and every feature, whether that role may create, read,
// update or delete. Before this file a role was a rank on a ladder (viewer,
// then editor, then admin) and every route asked "at least editor?". A ladder
// cannot say "this role may run migrations but not edit connections", which is
// exactly the kind of sentence the client wanted to be able to write.
//
// So a permission is now a named thing, `feature:action`, and a role is a set
// of them. This file is the catalogue: the one list of every feature and every
// action the app knows how to check. The database stores which role holds
// which (the `role_permissions` table, seeded in lib/db/bootstrap.ts), the
// routes ask for them by name (requirePermission in lib/auth-guard.ts), and the
// screens hide what the person cannot use (`can()` from hooks/useUser.ts).
//
// Adding a feature means adding it to FEATURES below. The built-in roles pick
// up its new permissions on the next boot (see setUpRoles in bootstrap.ts), and
// tests/permissions-coverage.test.ts fails until a route asks for it.
//
// Pure: no database, no React, no next-auth. The routes, the session, the admin
// grid and the tests all import it, and the route tests replace lib/auth-guard
// with a stand-in, so anything they need has to live somewhere that is not
// replaced.
// ---------------------------------------------------------------------------

/** The verbs a permission can grant, in the order the admin grid shows them. */
export const ACTIONS = ["create", "read", "update", "delete", "run", "approve"] as const;
export type Action = (typeof ACTIONS)[number];

export const ACTION_LABELS: Record<Action, string> = {
  create: "Create",
  read: "Read",
  update: "Update",
  delete: "Delete",
  run: "Run",
  approve: "Approve",
};

/**
 * The lowest built-in role that has a permission out of the box.
 *
 * Only used to build the day-one presets below. Once the app is running the
 * database is the answer, and an admin can move any of these.
 */
type StartsWith = "viewer" | "editor" | "admin";

type ActionSpec = {
  /** What the permission lets someone do. Finishes "Your role can't ...". */
  does: string;
  from: StartsWith;
};

type FeatureSpec = {
  key: string;
  label: string;
  /** One line under the feature's name on the admin grid. */
  description: string;
  /**
   * Only the admin role can do these, and they cannot be given to another
   * role. Managing who may do what is the one thing that must not be
   * grantable: a role allowed to change roles could otherwise make itself an
   * admin in two clicks.
   */
  adminOnly?: boolean;
  actions: Partial<Record<Action, ActionSpec>>;
};

/**
 * Every feature and what can be done in it.
 *
 * The `from` values reproduce, exactly, the role checks the routes made before
 * this file existed: viewers could read everything, editors could change
 * things, admins could also approve production runs and manage users.
 * tests/permissions-equivalence.test.ts holds the routes to that, so turning
 * this system on changed nobody's access.
 *
 * Every feature has a `read`. The other actions bring it with them (see
 * effectivePermissions), because a role that may delete connections but not
 * see them would have a button it can never reach.
 */
export const FEATURES = [
  {
    key: "dashboard",
    label: "Dashboard",
    description: "The overview of tracked schemas and their drift.",
    actions: {
      read: { does: "open the dashboard", from: "viewer" },
    },
  },
  {
    key: "connections",
    label: "Connections",
    description: "Saved database connections and their credentials.",
    actions: {
      create: { does: "add a connection", from: "editor" },
      read: { does: "see saved connections", from: "viewer" },
      update: { does: "edit or test a saved connection", from: "editor" },
      delete: { does: "delete a connection", from: "editor" },
    },
  },
  {
    key: "compare",
    label: "Compare",
    description: "Comparing two schemas and reading the differences.",
    actions: {
      read: { does: "compare schemas", from: "viewer" },
    },
  },
  {
    key: "comparison_sets",
    label: "Comparison sets",
    description: "Saved source and target pairs on the Compare screen.",
    actions: {
      create: { does: "save a new comparison set", from: "editor" },
      read: { does: "open saved comparison sets", from: "viewer" },
      update: { does: "overwrite a saved comparison set", from: "editor" },
      delete: { does: "delete a comparison set", from: "editor" },
    },
  },
  {
    key: "scripts",
    label: "Scripts",
    description: "The Script Editor and the script registry on GitHub.",
    actions: {
      create: { does: "save scripts to the registry", from: "editor" },
      read: { does: "open the script registry", from: "viewer" },
    },
  },
  {
    key: "deploy",
    label: "Deploy",
    description:
      "Running migrations against a database. Each connection can still forbid it.",
    actions: {
      read: { does: "see deployments", from: "viewer" },
      run: { does: "apply or revert migrations", from: "editor" },
    },
  },
  {
    key: "approvals",
    label: "Approvals",
    description: "The second person a production run needs.",
    actions: {
      create: { does: "request a production approval", from: "editor" },
      read: { does: "see production approvals", from: "viewer" },
      approve: { does: "approve production runs", from: "admin" },
    },
  },
  {
    key: "version_sync",
    label: "Version Sync",
    description:
      "Promoting a schema from one environment to the next. Promoting runs a deployment, so it also needs Deploy: Run.",
    actions: {
      read: { does: "open Version Sync", from: "viewer" },
    },
  },
  {
    key: "drift",
    label: "Drift tracking",
    description:
      "Tracked schemas, their baselines and the checks that watch them. A role with Deploy: Run can also run a check, because Deploy runs one straight after a migration.",
    actions: {
      create: { does: "track a schema", from: "editor" },
      read: { does: "see tracked schemas and their drift", from: "viewer" },
      update: {
        does: "change schedules, environments and baselines, or acknowledge drift",
        from: "editor",
      },
      delete: { does: "stop tracking a schema", from: "editor" },
      run: { does: "run a drift check", from: "editor" },
    },
  },
  {
    key: "performance",
    label: "Performance",
    description: "Query analysis, live activity and trends.",
    actions: {
      read: { does: "open the Performance screen", from: "viewer" },
      run: { does: "measure a query on a live database", from: "editor" },
    },
  },
  {
    key: "alert_thresholds",
    label: "Alert thresholds",
    description: "The limits that raise a performance alert, on the Performance screen.",
    actions: {
      read: { does: "see alert thresholds", from: "viewer" },
      update: { does: "change alert thresholds", from: "editor" },
    },
  },
  {
    key: "visualizer",
    label: "Visualizer",
    description: "The schema diagram.",
    actions: {
      read: { does: "open the schema visualizer", from: "viewer" },
    },
  },
  {
    key: "users",
    label: "Users",
    description: "Who has signed in, and which role each person has.",
    adminOnly: true,
    actions: {
      read: { does: "see the user list", from: "admin" },
      update: { does: "change someone's role", from: "admin" },
      delete: { does: "remove a user", from: "admin" },
    },
  },
  {
    key: "roles",
    label: "Roles & permissions",
    description: "The roles themselves and what each one can do.",
    adminOnly: true,
    actions: {
      create: { does: "create a role", from: "admin" },
      read: { does: "see roles and permissions", from: "admin" },
      update: { does: "change what a role can do", from: "admin" },
      delete: { does: "delete a role", from: "admin" },
    },
  },
] as const satisfies readonly FeatureSpec[];

type Feature = (typeof FEATURES)[number];
export type FeatureKey = Feature["key"];

/**
 * "connections:create", "deploy:run" and so on: every permission the app can
 * check, as a type. Built from FEATURES, so a route asking for a permission
 * that does not exist is a compile error rather than a check that always fails.
 */
type KeysOf<F> = F extends { key: infer K extends string; actions: infer A }
  ? `${K}:${Extract<keyof A, string>}`
  : never;
export type PermissionKey = KeysOf<Feature>;

/** One permission, with everything the grid and the error messages need. */
export type Permission = {
  key: PermissionKey;
  feature: FeatureKey;
  action: Action;
  does: string;
  from: StartsWith;
  adminOnly: boolean;
};

/** Every permission, feature by feature, each feature's actions in ACTIONS order. */
export const PERMISSIONS: readonly Permission[] = (FEATURES as readonly FeatureSpec[]).flatMap(
  (feature) =>
    ACTIONS.flatMap((action) => {
      const spec = feature.actions[action];
      if (!spec) return [];
      return [
        {
          key: `${feature.key}:${action}` as PermissionKey,
          feature: feature.key as FeatureKey,
          action,
          does: spec.does,
          from: spec.from,
          adminOnly: feature.adminOnly === true,
        },
      ];
    })
);

export const ALL_PERMISSIONS: readonly PermissionKey[] = PERMISSIONS.map((p) => p.key);

const BY_KEY = new Map<string, Permission>(PERMISSIONS.map((p) => [p.key, p]));
const FEATURE_BY_KEY = new Map<string, FeatureSpec>(
  (FEATURES as readonly FeatureSpec[]).map((f) => [f.key, f])
);

/** Narrow a string from the database or a request body to a known permission. */
export function isPermissionKey(value: unknown): value is PermissionKey {
  return typeof value === "string" && BY_KEY.has(value);
}

/** True for Users and Roles & permissions, which only the admin role can touch. */
export function isAdminOnly(key: PermissionKey): boolean {
  return BY_KEY.get(key)?.adminOnly === true;
}

/** The Read permission of a feature. Every feature has one. */
export function readKeyOf(feature: FeatureKey): PermissionKey {
  return `${feature}:read` as PermissionKey;
}

/** "Connections: Create", the way the admin grid names a permission. */
export function permissionLabel(key: PermissionKey): string {
  const permission = BY_KEY.get(key);
  if (!permission) return key;
  const feature = FEATURE_BY_KEY.get(permission.feature);
  return `${feature?.label ?? permission.feature}: ${ACTION_LABELS[permission.action]}`;
}

// ---------------------------------------------------------------------------
// Roles.
// ---------------------------------------------------------------------------

/**
 * The three roles every install has. They cannot be deleted, so there is
 * always somewhere to put a person, and the first sign-in always has an admin
 * role to land in.
 */
export const BUILT_IN_ROLES = ["viewer", "editor", "admin"] as const;
export type BuiltInRole = (typeof BUILT_IN_ROLES)[number];

/** The role that can do everything. Its permissions are not stored or edited. */
export const ADMIN_ROLE: BuiltInRole = "admin";

/** The least this app gives anyone: a new sign-in, or a profile that is gone. */
export const DEFAULT_ROLE: BuiltInRole = "viewer";

export const BUILT_IN_ROLE_INFO: Record<BuiltInRole, { label: string; description: string }> = {
  viewer: {
    label: "Viewer",
    description: "Starts able to open every screen except Admin, and change nothing.",
  },
  editor: {
    label: "Editor",
    description: "Starts able to change things and run migrations where a connection allows it.",
  },
  admin: {
    label: "Admin",
    description: "Can do everything, always. Its permissions cannot be edited.",
  },
};

export function isBuiltInRole(role: string): role is BuiltInRole {
  return (BUILT_IN_ROLES as readonly string[]).includes(role);
}

const RANK: Record<StartsWith, number> = { viewer: 0, editor: 1, admin: 2 };

/**
 * What a built-in role starts with.
 *
 * The database is seeded from this (setUpRoles in lib/db/bootstrap.ts) and is
 * the answer from then on, so changing a `from` above does not take anything
 * away from an install that already exists. It is also what "Reset to default"
 * puts back. Null for a custom role, which starts as a copy of another role or
 * with nothing at all.
 */
export function presetFor(role: string): readonly PermissionKey[] | null {
  if (role === ADMIN_ROLE) return ALL_PERMISSIONS;
  if (role !== "viewer" && role !== "editor") return null;
  return PERMISSIONS.filter((p) => RANK[p.from] <= RANK[role]).map((p) => p.key);
}

/**
 * What a role can actually do, given the rows the database holds for it.
 *
 * Three rules are applied here rather than trusted to whatever wrote the rows:
 *
 *   - The admin role can do everything, whatever is stored. Otherwise one
 *     unticked box could lock every admin out of the screen that ticks it back.
 *   - Admin-only permissions are never held by another role, even when a row
 *     says so.
 *   - Any action on a feature brings that feature's Read with it.
 *
 * A key the catalogue no longer knows (a feature removed since the row was
 * written) is dropped, so it can never match a check by accident.
 */
export function effectivePermissions(
  role: string,
  granted: readonly string[]
): PermissionKey[] {
  if (role === ADMIN_ROLE) return [...ALL_PERMISSIONS];
  const held = new Set<string>();
  for (const key of granted) {
    const permission = BY_KEY.get(key);
    if (!permission || permission.adminOnly) continue;
    held.add(permission.key);
    held.add(readKeyOf(permission.feature));
  }
  return ALL_PERMISSIONS.filter((key) => held.has(key));
}

/** Anything that carries a permission list: a Principal, or what useUser holds. */
export type PermissionHolder = { permissions?: readonly string[] } | null | undefined;

/**
 * True when the holder has at least ONE of these permissions.
 *
 * Any-of, because that is what every call site means. The connection list,
 * for example, is needed by seven screens, and a role that may open any one of
 * them needs it. A holder with no list at all has nothing: an unknown answer
 * is a no.
 */
export function hasPermission(
  holder: PermissionHolder,
  ...keys: [PermissionKey, ...PermissionKey[]]
): boolean {
  const held = holder?.permissions;
  if (!Array.isArray(held)) return false;
  return keys.some((key) => held.includes(key));
}

/**
 * Why a request was refused, addressed to the person who made it.
 *
 * It names the permission in the words the admin grid uses, so whoever reads
 * it can ask for exactly the right box to be ticked instead of "more access".
 * The admin-only ones say so, because asking for them would be pointless.
 */
export function refusalMessage(roleLabel: string, key: PermissionKey): string {
  const permission = BY_KEY.get(key);
  if (!permission) return `Your role (${roleLabel}) can't do that.`;
  if (permission.adminOnly) {
    return `Your role (${roleLabel}) can't ${permission.does}. Only admins can.`;
  }
  return (
    `Your role (${roleLabel}) can't ${permission.does}. ` +
    `Ask an admin to allow "${permissionLabel(key)}" for this role.`
  );
}

/**
 * The admin grid's checkbox rule, here so it can be tested without a screen.
 *
 * Ticking anything on a feature ticks its Read too. Unticking Read clears the
 * rest of that feature, because without Read the others could never be
 * reached. Returned in catalogue order so two equal sets compare equal.
 */
export function withToggled(
  current: readonly string[],
  key: PermissionKey,
  on: boolean
): PermissionKey[] {
  const permission = BY_KEY.get(key);
  const next = new Set<string>(current.filter(isPermissionKey));
  if (permission) {
    if (on) {
      next.add(key);
      next.add(readKeyOf(permission.feature));
    } else if (permission.action === "read") {
      for (const p of PERMISSIONS) if (p.feature === permission.feature) next.delete(p.key);
    } else {
      next.delete(key);
    }
  }
  return ALL_PERMISSIONS.filter((k) => next.has(k));
}

/**
 * What the role change log records (the `role_changes` table). One row per box
 * ticked or unticked, so the log reads as a list of decisions rather than a
 * before-and-after blob nobody can diff by eye.
 */
export const ROLE_CHANGE_KINDS = [
  "create-role",
  "delete-role",
  "grant",
  "revoke",
  "reset",
  "assign",
] as const;
export type RoleChangeKind = (typeof ROLE_CHANGE_KINDS)[number];

/** The longest name a role can have. The key made from it is capped at 32. */
export const ROLE_LABEL_MAX = 40;
export const ROLE_DESCRIPTION_MAX = 200;

/**
 * The key a new role is stored under, made from the name an admin typed:
 * "QA Lead" becomes "qa-lead".
 *
 * The key is what profiles.role holds and what a log line records, so it is
 * kept to lowercase letters, digits and single hyphens, which nothing has to
 * quote. The database holds it to the same rule (roles_name_check).
 *
 * Accents come off first, so "Équipe QA" becomes "equipe-qa" rather than
 * losing its first letter. NFKD splits "É" into "E" and a separate accent
 * mark, and the marks (U+0300 to U+036F) are then dropped. It also turns
 * full-width letters such as "Ｑ" into plain ones.
 *
 * An empty result means the name had no letter from A to Z and no digit in it,
 * for example one written only in Japanese, and the caller refuses it. The
 * name is still shown as it was typed: only the key is kept to this shape.
 */
export function roleKeyFrom(label: string): string {
  return label
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, 32)
    .replace(/-+$/, "");
}
