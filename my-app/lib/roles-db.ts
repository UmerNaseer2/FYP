import pool, { syncMetadataTables } from "./version-db";
import type { MetadataClient } from "./db/sequelize";
import {
  ADMIN_ROLE,
  BUILT_IN_ROLES,
  ROLE_DESCRIPTION_MAX,
  ROLE_LABEL_MAX,
  effectivePermissions,
  isAdminOnly,
  isBuiltInRole,
  isPermissionKey,
  permissionLabel,
  presetFor,
  roleKeyFrom,
  type PermissionKey,
  type RoleChangeKind,
} from "./permissions";

/**
 * Roles, what each one may do, and the log of who changed that.
 *
 * The catalogue of permissions lives in lib/permissions.ts and never touches
 * the database. This file is the other half: which role holds which
 * permission (`role_permissions`), the roles themselves (`roles`), and one log
 * row per decision (`role_changes`). The tables are defined in
 * lib/db/models.ts and the built-in roles are seeded by setUpRoles in
 * lib/db/bootstrap.ts.
 *
 * Every role belongs to one organization, and so does everything here. Each
 * function takes the id of the organization it acts in (the principal's, see
 * lib/auth-guard.ts) and every statement is filtered by it, so two
 * organizations can each have a role called "QA Lead" without either one ever
 * seeing, changing or deleting the other's.
 *
 * Every write here runs in one transaction with the role's row locked, so two
 * admins saving at the same moment take turns instead of each writing half of
 * what they meant, and the log always describes what really happened.
 *
 * The writes answer `{ ok: false, status, error }` for anything the person can
 * fix (a name already taken, a role still in use) and throw for anything they
 * cannot (the database is down), so a route can pass the first straight back
 * and turn the second into a 500.
 */

/**
 * What one member, or the "View as" switcher, may do. The gates read this on
 * every request (lib/auth-guard.ts).
 */
export type RoleAccess = {
  role: string;
  /** The role's name as people read it: "Editor", "QA Lead". */
  roleLabel: string;
  permissions: PermissionKey[];
};

/** One role as the Admin screen lists it. */
export type RoleSummary = {
  name: string;
  label: string;
  description: string;
  /** Viewer, Editor and Admin. They cannot be deleted. */
  builtIn: boolean;
  /** How many members of the organization hold this role. A role in use cannot be deleted. */
  userCount: number;
  /** What the role can do. Everything for admin, whatever is stored otherwise. */
  permissions: PermissionKey[];
};

/** One row of the change log, newest first on the Admin screen. */
export type RoleChange = {
  id: number;
  role: string;
  /** The role's name today, or null when it has since been deleted. */
  roleLabel: string | null;
  kind: RoleChangeKind;
  feature: string | null;
  action: string | null;
  /**
   * The person a row is about, by email address: who was given a role
   * (`assign`), who was invited or whose invitation was cancelled (`invite`,
   * `cancel-invite`; null for an invitation link, which names nobody), and who
   * joined (`join`).
   */
  subject: string | null;
  /**
   * The rest of the story, which depends on the kind:
   *   create-role  "Copied from Editor", or null for an empty role
   *   delete-role  the name the role had, so the row still reads after it is gone
   *   assign       the name of the role the person had before
   *   invite       for an invitation link, how many days it was made to last
   *   join         "email" or "link": which kind of invitation they joined with
   */
  detail: string | null;
  actor: string;
  createdAt: string;
};

/** What a log row is written from. */
export type RoleChangeEntry = {
  role: string;
  kind: RoleChangeKind;
  feature?: string | null;
  action?: string | null;
  subject?: string | null;
  detail?: string | null;
  actor: string;
};

/** A write either worked, or says why not in words the person can act on. */
export type RoleResult<T extends object = object> =
  | ({ ok: true } & T)
  | { ok: false; status: number; error: string };

/** Anything that runs one statement: the shared pool, or a transaction's client. */
type Queryable = Pick<MetadataClient, "query">;

function refuse(status: number, error: string): { ok: false; status: number; error: string } {
  return { ok: false, status, error };
}

const ADMIN_IS_FIXED =
  "The admin role can always do everything, so its permissions can't be changed.";

/**
 * One permission row as `feature:action`, the way the catalogue names it.
 * The rows are stored split so the table is readable in psql; every reader
 * here wants them joined.
 */
const PERMISSION_KEYS_SQL = `COALESCE(
  array_agg(p.feature || ':' || p.action) FILTER (WHERE p.feature IS NOT NULL),
  '{}'
)`;

/**
 * A role's label and stored permission rows, or null when the organization
 * has no such role.
 *
 * The join matches on org_id as well as the name: the same name in another
 * organization is another role, and its rows must never be counted in.
 */
async function readRole(
  db: Queryable,
  orgId: number,
  role: string
): Promise<{ label: string; granted: string[] } | null> {
  const result = await db.query<{ label: string; granted: string[] }>(
    `SELECT r.label, ${PERMISSION_KEYS_SQL} AS granted
       FROM roles r
       LEFT JOIN role_permissions p ON p.org_id = r.org_id AND p.role = r.name
      WHERE r.org_id = $1 AND r.name = $2
      GROUP BY r.org_id, r.name`,
    [orgId, role]
  );
  return result.rows[0] ?? null;
}

/**
 * What a role in this organization may do, for the gates and the "View as"
 * switcher. Null when the organization has no such role.
 */
export async function getRoleAccess(orgId: number, role: string): Promise<RoleAccess | null> {
  await syncMetadataTables();
  const found = await readRole(pool, orgId, role);
  if (!found) return null;
  return {
    role,
    roleLabel: found.label,
    permissions: effectivePermissions(role, found.granted),
  };
}

/**
 * Compares role names the way a person reads them: "Équipe QA" goes with the
 * other names starting with E, and a name typed all in small letters sits
 * among the rest rather than after every name with a capital.
 *
 * The roles are put in order here rather than by the database, because how
 * the database orders names depends on the system it runs on. On the Alpine
 * Linux image docker-compose uses, letters are compared by their code, so
 * "Équipe QA" came after "Viewer".
 */
const byName = new Intl.Collator("en", { sensitivity: "base" });

/** Where a role goes in a list: the built-in ones first, in their usual order. */
function builtInRank(role: string): number {
  const rank = (BUILT_IN_ROLES as readonly string[]).indexOf(role);
  return rank === -1 ? BUILT_IN_ROLES.length : rank;
}

/**
 * Every role in the organization, built-in ones first in their usual order,
 * then the rest by name.
 */
export async function listRoles(orgId: number): Promise<RoleSummary[]> {
  await syncMetadataTables();
  const result = await pool.query<{
    name: string;
    label: string;
    description: string;
    built_in: boolean;
    user_count: number;
    granted: string[];
  }>(
    `SELECT r.name, r.label, r.description, r.built_in,
            (SELECT count(*)::int FROM memberships m
              WHERE m.org_id = r.org_id AND m.role = r.name) AS user_count,
            ${PERMISSION_KEYS_SQL} AS granted
       FROM roles r
       LEFT JOIN role_permissions p ON p.org_id = r.org_id AND p.role = r.name
      WHERE r.org_id = $1
      GROUP BY r.org_id, r.name`,
    [orgId]
  );
  const roles = result.rows.map((row) => ({
    name: row.name,
    label: row.label,
    description: row.description,
    builtIn: row.built_in,
    userCount: row.user_count,
    permissions: effectivePermissions(row.name, row.granted),
  }));
  return roles.sort(
    (a, b) =>
      builtInRank(a.name) - builtInRank(b.name) ||
      byName.compare(a.label, b.label) ||
      // Two different names can still read the same, such as "Straße" and
      // "Strasse". Their keys differ, so the key settles it, and the order
      // never depends on which row the database sent first.
      (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
  );
}

/**
 * Write log rows inside the caller's transaction, so a change and its log
 * line commit together or not at all.
 *
 * The rows go in the order given. The Admin screen lists the log newest first,
 * so the last entry of a batch is the one shown on top of it. Every row in a
 * batch belongs to the one organization the change was made in.
 */
export async function logRoleChanges(
  client: Queryable,
  orgId: number,
  entries: readonly RoleChangeEntry[]
): Promise<void> {
  if (entries.length === 0) return;
  await client.query(
    `INSERT INTO role_changes (org_id, role, kind, feature, action, subject, detail, actor)
     SELECT $1::int, * FROM unnest(
       $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[]
     )`,
    [
      orgId,
      entries.map((entry) => entry.role),
      entries.map((entry) => entry.kind),
      entries.map((entry) => entry.feature ?? null),
      entries.map((entry) => entry.action ?? null),
      entries.map((entry) => entry.subject ?? null),
      entries.map((entry) => entry.detail ?? null),
      entries.map((entry) => entry.actor),
    ]
  );
}

/**
 * Make a new role, empty or as a copy of an existing one.
 *
 * The key it is stored under is made from the name (roleKeyFrom), so two names
 * that differ only in case, accents or punctuation ("QA Lead", "qa-lead") are
 * the same role and the second is refused. Only within the organization,
 * though: another organization's "QA Lead" is no reason to refuse this one.
 */
export async function createRole(
  orgId: number,
  input: { label: string; description: string; copyFrom: string | null },
  actor: string
): Promise<RoleResult<{ role: RoleSummary }>> {
  const label = input.label.trim();
  const description = input.description.trim();
  if (label === "") return refuse(400, "Give the role a name.");
  if (label.length > ROLE_LABEL_MAX) {
    return refuse(400, `Keep the name to ${ROLE_LABEL_MAX} characters or fewer.`);
  }
  if (description.length > ROLE_DESCRIPTION_MAX) {
    return refuse(400, `Keep the description to ${ROLE_DESCRIPTION_MAX} characters or fewer.`);
  }
  const name = roleKeyFrom(label);
  if (name === "") {
    return refuse(400, "Give the role a name with at least one letter from A to Z, or a number.");
  }

  await syncMetadataTables();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Checked first so the refusal can name the role that is in the way. The
    // unique indexes still have the last word if two admins race (see catch).
    const taken = await client.query<{ label: string }>(
      `SELECT label FROM roles
        WHERE org_id = $1 AND (name = $2 OR lower(label) = lower($3))
        LIMIT 1`,
      [orgId, name, label]
    );
    if (taken.rows.length > 0) {
      await client.query("ROLLBACK");
      return refuse(
        409,
        `There is already a role called "${taken.rows[0].label}". Pick a different name.`
      );
    }

    let permissions: PermissionKey[] = [];
    let detail: string | null = null;
    if (input.copyFrom !== null) {
      const source = await readRole(client, orgId, input.copyFrom);
      if (!source) {
        await client.query("ROLLBACK");
        return refuse(400, "The role to copy from no longer exists. Refresh the page and try again.");
      }
      // Copying Admin copies everything a role other than admin can hold. The
      // admin-only permissions stay behind, because nothing else may hold them.
      permissions = effectivePermissions(input.copyFrom, source.granted).filter(
        (key) => !isAdminOnly(key)
      );
      detail = `Copied from ${source.label}`;
    }

    await client.query(
      `INSERT INTO roles (org_id, name, label, description) VALUES ($1, $2, $3, $4)`,
      [orgId, name, label, description]
    );
    if (permissions.length > 0) {
      await insertPermissionRows(client, orgId, name, permissions);
    }
    await logRoleChanges(client, orgId, [{ role: name, kind: "create-role", detail, actor }]);
    await client.query("COMMIT");

    return {
      ok: true,
      role: { name, label, description, builtIn: false, userCount: 0, permissions },
    };
  } catch (error) {
    // The ROLLBACK can fail too (the connection may be what broke), and the
    // error worth reporting is the first one.
    await client.query("ROLLBACK").catch(() => {});
    // 23505 unique_violation: another admin made a role with this name between
    // the check above and the insert.
    if ((error as { code?: string })?.code === "23505") {
      return refuse(409, "There is already a role with that name. Pick a different name.");
    }
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Give a role in the organization these permission rows. The caller's
 * transaction decides when they become real.
 *
 * The casts are needed because these values sit in a SELECT list, where
 * Postgres cannot tell from the target column what type a parameter is meant
 * to be, and an untyped one is taken as text.
 */
async function insertPermissionRows(
  client: Queryable,
  orgId: number,
  role: string,
  keys: readonly PermissionKey[]
): Promise<void> {
  await client.query(
    `INSERT INTO role_permissions (org_id, role, feature, action)
     SELECT $1::int, $2::text, feature, action
       FROM unnest($3::text[], $4::text[]) AS p(feature, action)`,
    [
      orgId,
      role,
      keys.map((key) => key.split(":")[0]),
      keys.map((key) => key.split(":")[1]),
    ]
  );
}

/**
 * Store a role's new permissions and log one row per box that changed.
 *
 * Shared by setRolePermissions and resetRolePermissions, which differ only in
 * where the new set comes from and whether a `reset` row heads the log.
 */
async function writeRolePermissions(
  orgId: number,
  role: string,
  target: readonly PermissionKey[],
  actor: string,
  reset: boolean
): Promise<RoleResult<{ permissions: PermissionKey[]; changes: number }>> {
  await syncMetadataTables();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // The lock is what makes two saves of the same role take turns: the second
    // reads what the first one stored, so its log rows describe its own change
    // and not the sum of both.
    const found = await client.query(
      `SELECT name FROM roles WHERE org_id = $1 AND name = $2 FOR UPDATE`,
      [orgId, role]
    );
    if (found.rows.length === 0) {
      await client.query("ROLLBACK");
      return refuse(404, "That role no longer exists. Refresh the page.");
    }

    const stored = (
      await client.query<{ key: string }>(
        `SELECT feature || ':' || action AS key FROM role_permissions
          WHERE org_id = $1 AND role = $2`,
        [orgId, role]
      )
    ).rows.map((row) => row.key);

    const wanted = new Set<string>(target);
    const storedSet = new Set(stored);
    // Rows that go include ones for permissions the catalogue no longer has,
    // so a removed feature does not leave rows behind forever.
    const toDelete = stored.filter((key) => !wanted.has(key));
    const toInsert = target.filter((key) => !storedSet.has(key));

    if (toDelete.length > 0) {
      await client.query(
        `DELETE FROM role_permissions
          WHERE org_id = $1 AND role = $2 AND feature || ':' || action = ANY($3::text[])`,
        [orgId, role, toDelete]
      );
    }
    if (toInsert.length > 0) {
      await insertPermissionRows(client, orgId, role, toInsert);
    }

    // The log compares what the role could DO before and after, not the raw
    // rows, so tidying a stale row or adding a Read the role already had
    // through another box is not reported as a decision nobody made.
    const before = effectivePermissions(role, stored);
    const beforeSet = new Set<string>(before);
    const entries: RoleChangeEntry[] = [
      ...target
        .filter((key) => !beforeSet.has(key))
        .map((key) => grantOrRevoke(role, "grant", key, actor)),
      ...before
        .filter((key) => !wanted.has(key))
        .map((key) => grantOrRevoke(role, "revoke", key, actor)),
    ];
    const changes = entries.length;
    // Last, so it sits on top of its own grants and revokes in the log.
    if (reset) entries.push({ role, kind: "reset", actor });
    await logRoleChanges(client, orgId, entries);

    await client.query("COMMIT");
    return { ok: true, permissions: [...target], changes };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

function grantOrRevoke(
  role: string,
  kind: "grant" | "revoke",
  key: PermissionKey,
  actor: string
): RoleChangeEntry {
  const [feature, action] = key.split(":");
  return { role, kind, feature, action, actor };
}

/**
 * Give a role exactly these permissions.
 *
 * What is stored is the set with every Read it implies added
 * (effectivePermissions), so the table always says what the role can really
 * do. Admin is refused: it can do everything by definition, and letting its
 * boxes be unticked could lock every admin out of this screen.
 */
export async function setRolePermissions(
  orgId: number,
  role: string,
  keys: readonly string[],
  actor: string
): Promise<RoleResult<{ permissions: PermissionKey[]; changes: number }>> {
  if (role === ADMIN_ROLE) return refuse(400, ADMIN_IS_FIXED);
  for (const key of keys) {
    if (!isPermissionKey(key)) {
      return refuse(400, `"${key.slice(0, 60)}" is not a permission this app knows.`);
    }
    if (isAdminOnly(key)) {
      return refuse(400, `"${permissionLabel(key)}" can only belong to the admin role.`);
    }
  }
  return writeRolePermissions(orgId, role, effectivePermissions(role, keys), actor, false);
}

/** Put Viewer or Editor back to what they start with on a new install. */
export async function resetRolePermissions(
  orgId: number,
  role: string,
  actor: string
): Promise<RoleResult<{ permissions: PermissionKey[]; changes: number }>> {
  if (role === ADMIN_ROLE) return refuse(400, ADMIN_IS_FIXED);
  const preset = presetFor(role);
  if (!preset) return refuse(400, "Only Viewer and Editor have a default to go back to.");
  return writeRolePermissions(orgId, role, preset, actor, true);
}

/**
 * Delete a role nobody holds.
 *
 * A role in use is refused rather than its people moved somewhere: where they
 * should go is a decision, and the Users tab is where it is made. The built-in
 * roles cannot be deleted at all, so there is always a role to give someone.
 */
export async function deleteRole(orgId: number, role: string, actor: string): Promise<RoleResult> {
  if (isBuiltInRole(role)) {
    return refuse(400, "Viewer, Editor and Admin are built in and can't be deleted.");
  }

  await syncMetadataTables();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Locked so that nobody can be given this role while it is being deleted:
    // the foreign key from memberships (org_id, role) has to wait for this
    // lock, and then finds the role gone.
    const found = await client.query<{ label: string }>(
      `SELECT label FROM roles WHERE org_id = $1 AND name = $2 FOR UPDATE`,
      [orgId, role]
    );
    if (found.rows.length === 0) {
      await client.query("ROLLBACK");
      return refuse(404, "That role no longer exists. Refresh the page.");
    }

    const inUse = await client.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM memberships WHERE org_id = $1 AND role = $2`,
      [orgId, role]
    );
    const count = inUse.rows[0]?.count ?? 0;
    if (count > 0) {
      await client.query("ROLLBACK");
      return refuse(
        409,
        `${count === 1 ? "1 person has" : `${count} people have`} this role. ` +
          "Give them another role on the Users tab first."
      );
    }

    // Its permission rows go with it (ON DELETE CASCADE on role_permissions).
    await client.query(`DELETE FROM roles WHERE org_id = $1 AND name = $2`, [orgId, role]);
    await logRoleChanges(client, orgId, [
      { role, kind: "delete-role", detail: found.rows[0].label, actor },
    ]);
    await client.query("COMMIT");
    return { ok: true };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    // 23503 foreign_key_violation: a membership still points at the role
    // (memberships_org_id_role_fkey). The count above makes this close to
    // impossible; it is here so that if it ever happens the person gets the
    // same answer rather than a 500.
    if ((error as { code?: string })?.code === "23503") {
      return refuse(409, "Someone still has this role. Give them another role on the Users tab first.");
    }
    throw error;
  } finally {
    client.release();
  }
}

/** The organization's most recent role changes, newest first. */
export async function listRoleChanges(orgId: number, limit = 50): Promise<RoleChange[]> {
  await syncMetadataTables();
  const result = await pool.query<{
    id: number;
    role: string;
    role_label: string | null;
    kind: RoleChangeKind;
    feature: string | null;
    action: string | null;
    subject: string | null;
    detail: string | null;
    actor: string;
    created_at: Date | string;
  }>(
    // By id rather than created_at: every row in one save shares a timestamp
    // (now() is the transaction's start), and id is the primary key's index.
    `SELECT c.id, c.role, r.label AS role_label, c.kind, c.feature, c.action,
            c.subject, c.detail, c.actor, c.created_at
       FROM role_changes c
       LEFT JOIN roles r ON r.org_id = c.org_id AND r.name = c.role
      WHERE c.org_id = $1
      ORDER BY c.id DESC
      LIMIT $2`,
    [orgId, Math.min(Math.max(Math.trunc(limit), 1), 200)]
  );
  return result.rows.map((row) => ({
    id: row.id,
    role: row.role,
    roleLabel: row.role_label,
    kind: row.kind,
    feature: row.feature,
    action: row.action,
    subject: row.subject,
    detail: row.detail,
    actor: row.actor,
    // pg hands timestamptz back as a Date; JSON wants a string either way.
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
  }));
}
