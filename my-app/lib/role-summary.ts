// ---------------------------------------------------------------------------
// role-summary.ts
// The words the Roles & permissions tab uses about a role: its lines grouped
// by screen, a one-line summary, four answers at a glance, what a tick did
// besides the line that was clicked, and what Save will change.
//
// Pure, like lib/permissions.ts, so tests/role-summary.test.ts can check every
// sentence without a screen. Nothing here decides what a role may do: the
// permission keys, withToggled and the server's checks do that. This file only
// describes what they decided.
// ---------------------------------------------------------------------------

import {
  ADMIN_ROLE,
  FEATURES,
  PERMISSIONS,
  SCREENS,
  permissionLabel,
  readKeyOf,
  type FeatureKey,
  type Permission,
  type PermissionKey,
  type Screen,
} from "./permissions";

/** "add a connection" becomes "Add a connection". */
export function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * A list as words: "a", "a and b", "a, b and c". Past `max` items the rest
 * are counted instead: "a, b, c, d and 3 more". When a list of three or more
 * has an item with a comma of its own, semicolons keep the items apart, so
 * "change schedules and baselines, or acknowledge drift" still
 * reads as one item. Two items only ever need the "and".
 */
export function joinList(items: readonly string[], max = 4): string {
  const shown =
    items.length > max ? [...items.slice(0, max), `${items.length - max} more`] : [...items];
  if (shown.length <= 1) return shown[0] ?? "";
  const semicolons = shown.length > 2 && shown.some((item) => item.includes(","));
  const between = semicolons ? "; " : ", ";
  const beforeLast = semicolons ? "; and " : " and ";
  return shown.slice(0, -1).join(between) + beforeLast + shown[shown.length - 1];
}

// ---------------------------------------------------------------------------
// The lines, grouped the way the tab shows them.
// ---------------------------------------------------------------------------

/** One feature's lines: its see or open line, then the ones that need it. */
export type FeatureLines = {
  feature: FeatureKey;
  label: string;
  adminOnly: boolean;
  read: Permission;
  others: readonly Permission[];
};

export type ScreenGroup = { screen: Screen; features: readonly FeatureLines[] };

/**
 * Every feature under the sidebar screen it is used on, in the sidebar's
 * order. Within a screen the features keep the catalogue's order. Every
 * feature has a Read (lib/permissions.ts says why), so `read` is always there.
 */
export const SCREEN_GROUPS: readonly ScreenGroup[] = SCREENS.map((screen) => ({
  screen,
  features: FEATURES.filter((feature) => feature.screen === screen).map((feature) => {
    const lines = PERMISSIONS.filter((p) => p.feature === feature.key);
    return {
      feature: feature.key,
      label: feature.label,
      adminOnly: lines.some((p) => p.adminOnly),
      read: lines.find((p) => p.action === "read") as Permission,
      others: lines.filter((p) => p.action !== "read"),
    };
  }),
})).filter((group) => group.features.length > 0);

/** Every permission in the order the tab lists them: by screen, see line first. */
const SCREEN_ORDER: readonly Permission[] = SCREEN_GROUPS.flatMap((group) =>
  group.features.flatMap((lines) => [lines.read, ...lines.others])
);

const LOCKED_LABELS = FEATURES.filter((feature) =>
  PERMISSIONS.some((p) => p.feature === feature.key && p.adminOnly)
).map((feature) => feature.label);

const LOCKED_TABS = `the ${joinList(LOCKED_LABELS)} ${LOCKED_LABELS.length === 1 ? "tab" : "tabs"}`;

/** "The Roles & permissions and Organization tabs": what only Admin can touch. */
export const ADMIN_ONLY_TABS = capitalise(LOCKED_TABS);

/** The one line that stands in for the admin-only features on every other role. */
export const ADMIN_ONLY_LINE = `${ADMIN_ONLY_TABS} ${
  LOCKED_LABELS.length === 1 ? "is" : "are"
} for Admin only, so no role can make itself an admin.`;

/** Under "Start from" when a new role copies Admin: what the copy leaves out (lib/roles-db.ts). */
export const ADMIN_COPY_NOTE = `A copy of Admin gets everything except ${LOCKED_TABS}, which only Admin can have.`;

// ---------------------------------------------------------------------------
// What a role adds up to.
// ---------------------------------------------------------------------------

const MIGRATIONS: PermissionKey = "deploy:run";
const DRIFT_CHECK: PermissionKey = "drift:run";
const APPROVE: PermissionKey = "approvals:approve";
const PEOPLE: readonly PermissionKey[] = ["users:create", "users:update", "users:delete"];

function heldOf(keys: readonly string[]): Permission[] {
  const set = new Set(keys);
  return PERMISSIONS.filter((p) => set.has(p.key));
}

/**
 * True when a role can change something rather than only look. A drift check
 * counts as looking: it reads a schema and records what it found.
 */
function changesThings(held: readonly Permission[]): boolean {
  return held.some((p) => p.action !== "read" && p.key !== DRIFT_CHECK);
}

/**
 * A few words for the role's card, worked out from what it holds (unsaved
 * changes included), so the card answers the first question about a role:
 * can it only look, or can it change things and run migrations?
 */
export function roleSummary(roleName: string, keys: readonly string[]): string {
  if (roleName === ADMIN_ROLE) return "Everything, always";
  const held = heldOf(keys);
  if (held.length === 0) return "Nothing turned on";
  if (held.some((p) => p.key === MIGRATIONS)) return "Can run migrations";
  if (changesThings(held)) return "Can change things";
  return held.some((p) => p.key === DRIFT_CHECK) ? "Read-only, plus drift checks" : "Read-only";
}

export type GlanceRow = {
  label: string;
  yes: boolean;
  /** A limit that still applies to a yes, such as each connection's own setting. */
  detail: string | null;
};

/** The four things people ask about a role first, as yes or no. */
export function glance(roleName: string, keys: readonly string[]): GlanceRow[] {
  const admin = roleName === ADMIN_ROLE;
  const held = heldOf(keys);
  const has = (key: PermissionKey) => admin || held.some((p) => p.key === key);
  return [
    { label: "Changes things", yes: admin || changesThings(held), detail: null },
    { label: "Runs migrations", yes: has(MIGRATIONS), detail: "where the connection allows" },
    { label: "Approves runs", yes: has(APPROVE), detail: null },
    { label: "Manages people", yes: PEOPLE.some((key) => has(key)), detail: null },
  ];
}

/** "No", "Yes", or "Yes, where the connection allows". */
export function glanceValue(row: GlanceRow): string {
  if (!row.yes) return "No";
  return row.detail ? `Yes, ${row.detail}` : "Yes";
}

// ---------------------------------------------------------------------------
// What a change does.
// ---------------------------------------------------------------------------

const BY_KEY = new Map<string, Permission>(PERMISSIONS.map((p) => [p.key, p]));

/**
 * A permission by the name its line has on the Roles & permissions tab:
 * "connections:create" is "Add a connection". The same name refusals and
 * access requests use (permissionLabel). A key the catalogue no longer has
 * (an old log row) comes back as it is, so nothing is ever hidden.
 */
export function lineName(key: string): string {
  return permissionLabel(key as PermissionKey);
}

function quoted(permission: Permission): string {
  return `“${capitalise(permission.does)}”`;
}

/** What a click did besides itself. `key` is the line that was clicked, so Undo can hand focus back to it. */
export type ToggleHint = { key: PermissionKey; feature: FeatureKey; text: string };

/**
 * What a tick did besides the line that was clicked, or null when it did
 * nothing else. withToggled turns a feature's see line on with any of its
 * other lines, and turns those off when the see line goes, because none of
 * them can be reached without it. Doing that without a word looks like a bug,
 * so the tab shows this under the feature, with an Undo.
 *
 * `before` is what the role held just before the click.
 */
export function toggleHint(
  before: readonly string[],
  key: PermissionKey,
  on: boolean
): ToggleHint | null {
  const permission = BY_KEY.get(key);
  if (!permission) return null;
  const had = new Set(before);
  if (on) {
    const read = BY_KEY.get(readKeyOf(permission.feature));
    if (permission.action === "read" || !read || had.has(read.key)) return null;
    return {
      key,
      feature: permission.feature,
      text: `Also turned on ${quoted(read)}, because ${quoted(permission)} needs it.`,
    };
  }
  if (permission.action !== "read") return null;
  const cleared = PERMISSIONS.filter(
    (p) => p.feature === permission.feature && p.key !== key && had.has(p.key)
  );
  if (cleared.length === 0) return null;
  return {
    key,
    feature: permission.feature,
    text:
      `Also turned off ${joinList(cleared.map(quoted), cleared.length)}, because ` +
      `${cleared.length === 1 ? "it needs" : "they need"} ${quoted(permission)}.`,
  };
}

/**
 * What Save will change, in words: "Editor will be able to delete a
 * connection." and "Editor will no longer be able to run a drift check.",
 * each list in the order the tab shows the lines. Empty when nothing would
 * change.
 */
export function changeSentences(
  roleLabel: string,
  saved: readonly string[],
  draft: readonly string[]
): string[] {
  const before = new Set(saved);
  const after = new Set(draft);
  const gained = SCREEN_ORDER.filter((p) => after.has(p.key) && !before.has(p.key));
  const lost = SCREEN_ORDER.filter((p) => before.has(p.key) && !after.has(p.key));
  const sentences: string[] = [];
  if (gained.length > 0) {
    sentences.push(`${roleLabel} will be able to ${joinList(gained.map((p) => p.does))}.`);
  }
  if (lost.length > 0) {
    sentences.push(`${roleLabel} will no longer be able to ${joinList(lost.map((p) => p.does))}.`);
  }
  return sentences;
}
