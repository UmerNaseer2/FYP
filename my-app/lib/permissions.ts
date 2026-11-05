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
// Pure: no database, no React, no next-auth. The routes, the session, the
// Roles & permissions tab and the tests all import it, and the route tests
// replace lib/auth-guard with a stand-in, so anything they need has to live
// somewhere that is not replaced.
// ---------------------------------------------------------------------------

/**
 * The verbs a permission can grant. Each feature's permissions are listed in
 * this order. People never see these words: a permission is named by its line
 * on the Roles & permissions tab (permissionLabel).
 */
export const ACTIONS = ["create", "read", "update", "delete", "run", "approve"] as const;
export type Action = (typeof ACTIONS)[number];

/**
 * The sidebar's screens, in the sidebar's order (components/studio/nav.tsx).
 * The Roles & permissions tab lists each permission under the screen it is
 * used on, so the names there are the ones people already see. Requests has
 * no permission of its own, so it is not here.
 */
export const SCREENS = [
  "Dashboard",
  "Compare & Author",
  "Script Editor",
  "Deploy",
  "Version Sync",
  "Drift",
  "Performance",
  "Visualizer",
  "Connections",
  "Admin",
] as const;
export type Screen = (typeof SCREENS)[number];

/**
 * Why a permission deserves a second look before it is turned on. The Roles &
 * permissions tab shows a tag with these words beside it.
 */
export type Risk = "database" | "live" | "production";

export const RISK_LABELS: Record<Risk, string> = {
  database: "Writes to a database",
  live: "Live database",
  production: "Production",
};

/**
 * The lowest built-in role that has a permission out of the box.
 *
 * Only used to build the day-one presets below. Once the app is running the
 * database is the answer, and an admin can move any of these.
 */
type StartsWith = "viewer" | "editor" | "admin";

type ActionSpec = {
  /**
   * What the permission lets someone do. Finishes "Your role can't ...", and
   * with a capital letter it is the line the Roles & permissions tab shows.
   */
  does: string;
  from: StartsWith;
  /** A tag for the ones that can change or block a real database. */
  risk?: Risk;
  /** A rule that is easy to miss, shown under the line in small print. */
  note?: string;
};

type FeatureSpec = {
  key: string;
  label: string;
  /** The sidebar screen it is used on, which the tab groups it under. */
  screen: Screen;
  /**
   * What the feature covers, in a sentence. The catalogue's own note: the
   * Roles & permissions tab shows each action's `does` line instead.
   */
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
    screen: "Dashboard",
    description: "The overview of tracked schemas and their drift.",
    actions: {
      read: { does: "open the dashboard", from: "viewer" },
    },
  },
  {
    key: "connections",
    label: "Connections",
    screen: "Connections",
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
    screen: "Compare & Author",
    description: "Comparing two schemas and reading the differences.",
    actions: {
      read: { does: "compare schemas", from: "viewer" },
    },
  },
  {
    key: "comparison_sets",
    label: "Comparison sets",
    screen: "Compare & Author",
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
    screen: "Script Editor",
    description: "The Script Editor and the script registry on GitHub.",
    actions: {
      create: { does: "save scripts to the registry", from: "editor" },
      read: { does: "open the script registry", from: "viewer" },
    },
  },
  {
    key: "deploy",
    label: "Deploy",
    screen: "Deploy",
    description:
      "Running migrations against a database. Each connection can still forbid it.",
    actions: {
      read: { does: "see deployments", from: "viewer" },
      run: {
        does: "apply or revert migrations",
        from: "editor",
        risk: "database",
        note: "Each connection can still say no in its own setting.",
      },
    },
  },
  {
    key: "approvals",
    label: "Approvals",
    screen: "Deploy",
    description: "The second person a production run needs.",
    actions: {
      create: { does: "request a production approval", from: "editor" },
      read: { does: "see production approvals", from: "viewer" },
      approve: { does: "approve production runs", from: "admin", risk: "production" },
    },
  },
  {
    key: "version_sync",
    label: "Version Sync",
    screen: "Version Sync",
    description:
      "Promoting a schema from one environment to the next. Promoting runs a deployment, so it also needs Apply or revert migrations, under Deploy.",
    actions: {
      read: {
        does: "open Version Sync",
        from: "viewer",
        note: "Promoting also needs Apply or revert migrations, under Deploy.",
      },
    },
  },
  {
    key: "drift",
    label: "Drift tracking",
    screen: "Drift",
    description: "Tracked schemas, their baselines and the checks that watch them.",
    actions: {
      create: { does: "track a schema", from: "editor" },
      read: { does: "see tracked schemas and their drift", from: "viewer" },
      update: {
        does: "change schedules, environments and baselines, or acknowledge drift",
        from: "editor",
      },
      delete: { does: "stop tracking a schema", from: "editor" },
      run: {
        does: "run a drift check",
        from: "editor",
        note: "A role that can apply or revert migrations can run a check too, because Deploy runs one straight after each migration.",
      },
    },
  },
  {
    key: "performance",
    label: "Performance",
    screen: "Performance",
    description: "Query analysis, live activity and trends.",
    actions: {
      read: { does: "open the Performance screen", from: "viewer" },
      update: { does: "cancel a stuck query on a live database", from: "editor", risk: "live" },
      run: { does: "measure a query on a live database", from: "editor", risk: "live" },
    },
  },
  {
    key: "alert_thresholds",
    label: "Alert thresholds",
    screen: "Performance",
    description: "The limits that raise a performance alert, on the Performance screen.",
    actions: {
      read: { does: "see alert thresholds", from: "viewer" },
      update: { does: "change alert thresholds", from: "editor" },
    },
  },
  {
    key: "visualizer",
    label: "Visualizer",
    screen: "Visualizer",
    description: "The schema diagram.",
    actions: {
      read: { does: "open the schema visualizer", from: "viewer" },
    },
  },
  // Not admin-only: an Admin can let another role invite people, change their
  // roles or remove them. What keeps that from becoming a way up is the rank
  // rule (canHandOut below, applied by the users and invites routes): nobody
  // can give, change or take away a role that can do something theirs can't.
  {
    key: "users",
    label: "Users",
    screen: "Admin",
    description: "Who belongs to this organization, who has been invited, and which role each person has.",
    actions: {
      create: { does: "invite someone", from: "admin" },
      read: { does: "see the user list", from: "admin" },
      update: { does: "change someone's role", from: "admin" },
      delete: { does: "remove a user", from: "admin" },
    },
  },
  {
    key: "roles",
    label: "Roles & permissions",
    screen: "Admin",
    description: "The roles themselves and what each one can do.",
    adminOnly: true,
    actions: {
      create: { does: "create a role", from: "admin" },
      read: { does: "see roles and permissions", from: "admin" },
      update: { does: "change what a role can do", from: "admin" },
      delete: { does: "delete a role", from: "admin" },
    },
  },
  {
    key: "organization",
    label: "Organization",
    screen: "Admin",
    description: "The organization's name, its two-person rule for production, and deleting it.",
    adminOnly: true,
    actions: {
      read: { does: "see the organization's settings", from: "admin" },
      update: { does: "rename the organization or change its two-person rule", from: "admin" },
      delete: { does: "delete the organization", from: "admin" },
    },
  },
  // Not admin-only, so an Admin can let another role look after the
  // repository and its token. The token itself is never shown to anyone, even
  // with Read: Read only says which repository is used and whether a token is
  // saved.
  {
    key: "github",
    label: "GitHub registry",
    screen: "Admin",
    description: "The GitHub repository this organization keeps its scripts in, and the access token the app uses for it.",
    actions: {
      read: { does: "see which GitHub repository the organization uses", from: "admin" },
      update: { does: "change the GitHub repository or its access token", from: "admin" },
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

/** One permission, with everything the Roles & permissions tab and the error messages need. */
export type Permission = {
  key: PermissionKey;
  feature: FeatureKey;
  action: Action;
  does: string;
  from: StartsWith;
  adminOnly: boolean;
  screen: Screen;
  risk: Risk | null;
  note: string | null;
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
          screen: feature.screen,
          risk: spec.risk ?? null,
          note: spec.note ?? null,
        },
      ];
    })
);

export const ALL_PERMISSIONS: readonly PermissionKey[] = PERMISSIONS.map((p) => p.key);

const BY_KEY = new Map<string, Permission>(PERMISSIONS.map((p) => [p.key, p]));

/** Narrow a string from the database or a request body to a known permission. */
export function isPermissionKey(value: unknown): value is PermissionKey {
  return typeof value === "string" && BY_KEY.has(value);
}

/** True for Roles & permissions and Organization, which only the admin role can touch. */
export function isAdminOnly(key: PermissionKey): boolean {
  return BY_KEY.get(key)?.adminOnly === true;
}

/** The Read permission of a feature. Every feature has one. */
export function readKeyOf(feature: FeatureKey): PermissionKey {
  return `${feature}:read` as PermissionKey;
}

/**
 * "Add a connection": a permission's name, which is the line it has on the
 * Roles & permissions tab. Refusals, access requests, alerts and the role
 * change log all name a permission this way, so whoever reads one can find
 * the very line to turn on. Every line's words are different, which
 * tests/permissions.test.ts checks. A key this build no longer has (an old
 * row) comes back as it is, so nothing is ever hidden.
 */
export function permissionLabel(key: PermissionKey): string {
  const permission = BY_KEY.get(key);
  if (!permission) return key;
  return permission.does.charAt(0).toUpperCase() + permission.does.slice(1);
}

// ---------------------------------------------------------------------------
// Roles.
// ---------------------------------------------------------------------------

/**
 * The three roles every organization has. They cannot be deleted, so there is
 * always somewhere to put a member, and an organization's first member always
 * has an admin role to land in.
 */
export const BUILT_IN_ROLES = ["viewer", "editor", "admin"] as const;
export type BuiltInRole = (typeof BUILT_IN_ROLES)[number];

/** The role that can do everything. Its permissions are not stored or edited. */
export const ADMIN_ROLE: BuiltInRole = "admin";

/**
 * The least this app gives a member: someone who joins an organization that
 * already has members, or someone from before organizations whose role is gone.
 */
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
 * Each organization is seeded from this (seedBuiltInRoles in
 * lib/db/bootstrap.ts) and its rows are the answer from then on, so changing a
 * `from` above does not take anything away from an organization that already
 * exists. It is also what "Reset to default"
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
 *     permission turned off could lock every admin out of the screen that
 *     turns it back on.
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
 * The rank rule: true when the holder may hand out a role that can do
 * `permissions`, which is when they can do every one of those things
 * themselves. A holder with no list at all may hand out nothing.
 *
 * The users and invites routes ask it before anyone is given a role, moved
 * out of one, or removed while holding one, so being allowed to manage people
 * never becomes a way to give someone (yourself included, by way of a second
 * account) more than you have. It also settles who may touch an Admin. The
 * admin role holds everything, and no other role can hold the admin-only
 * keys, so only an Admin can give the admin role, take it away, or remove
 * someone who has it.
 *
 * Equal is allowed: a role can be handed out by someone whose role can do
 * the same things, the way an Editor allowed to invite may invite an Editor.
 */
export function canHandOut(holder: PermissionHolder, permissions: readonly string[]): boolean {
  const held = holder?.permissions;
  if (!Array.isArray(held)) return false;
  return permissions.every((key) => held.includes(key));
}

/**
 * Why a request was refused, addressed to the person who made it.
 *
 * It says what was refused with the same `does` words the Roles & permissions
 * tab shows, and names the line on that tab to turn on, so whoever reads it
 * can ask for exactly that line instead of "more access". The admin-only ones
 * say so, because asking for them would be pointless.
 */
export function refusalMessage(roleLabel: string, key: PermissionKey): string {
  const permission = BY_KEY.get(key);
  if (!permission) return `Your role (${roleLabel}) can't do that.`;
  if (permission.adminOnly) {
    return `Your role (${roleLabel}) can't ${permission.does}. Only admins can.`;
  }
  return (
    `Your role (${roleLabel}) can't ${permission.does}. ` +
    `Ask an admin to turn on "${permissionLabel(key)}" for this role.`
  );
}

/**
 * The Roles & permissions tab's tick rule, here so it can be tested without a
 * screen.
 *
 * Ticking anything on a feature ticks its Read too. Unticking Read clears the
 * rest of that feature, because without Read the others could never be
 * reached. The tab says so each time it happens, with an Undo. Returned in
 * catalogue order so two equal sets compare equal.
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
 * What the role change log records (the `role_changes` table). One row per
 * permission turned on or off, so the log reads as a list of decisions rather
 * than a before-and-after blob nobody can diff by eye.
 *
 * Some are about people rather than permissions: someone inviting a person
 * into a role (or making a link that does), cancelling an invitation, someone
 * joining by one, and someone being removed. They sit in the same log because
 * each one decides who holds a role, which is what the log is for.
 *
 * The last three are about the organization itself: renaming it, switching
 * its two-person rule, and changing the GitHub repository or token its
 * scripts are kept with. They sit here because this log is the one record of
 * who changed what in an organization, and each changes what its members see
 * and may do. Their rows name a role only because the column needs one: the
 * admin role for the first two, which only an Admin can do, and the role of
 * whoever saved the GitHub settings for the last.
 *
 * The database holds this list as a CHECK (lib/db/bootstrap.ts), which every
 * start widens to match, so a kind can be added here and nowhere else. Taking
 * one away is different: rows that hold it stay in the log.
 */
export const ROLE_CHANGE_KINDS = [
  "create-role",
  "delete-role",
  "grant",
  "revoke",
  "reset",
  "assign",
  "invite",
  "cancel-invite",
  "join",
  "remove",
  "rename-organization",
  "two-person-rule",
  "github-settings",
] as const;
export type RoleChangeKind = (typeof ROLE_CHANGE_KINDS)[number];

/** The longest name a role can have. The key made from it is capped at 32. */
export const ROLE_LABEL_MAX = 40;
export const ROLE_DESCRIPTION_MAX = 200;

/**
 * The key a new role is stored under, made from the name an admin typed:
 * "QA Lead" becomes "qa-lead".
 *
 * The key is what a membership's role holds and what a log line records, so
 * it is kept to lowercase letters, digits and single hyphens, which nothing
 * has to quote. The database holds it to the same rule (roles_name_check).
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
