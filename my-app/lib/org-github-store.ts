// SERVER-ONLY: import this file from API routes and other server code only.
// It reads and writes organizations' GitHub access tokens, and a token in a
// browser bundle is a leaked token.
//
// Each organization's GitHub settings: the repository its scripts are kept
// in, and the access token the app uses for it. One row per organization at
// most (organization_github), saved on the Admin screen's GitHub tab or when
// the organization is made.
//
// The token is stored encrypted with the server's key (lib/secret-store.ts)
// and never leaves the server. Nothing here returns it to a screen or writes
// it to a log: the screens only learn whether one is saved. A server with no
// key at all refuses to save one, because the alternative is a token sitting
// in the database as plain text.
//
// Every change is written to the change log the Admin screen shows, in the
// same transaction as the change, as kind "github-settings".
import pool, { syncMetadataTables } from "./version-db";
import type { MetadataClient } from "./db/sequelize";
import { logRoleChanges, type RoleChangeEntry } from "./roles-db";
import { decryptSecret, encryptSecret, isEncrypted } from "./secret-store";
import { repositoryLabel, type RepositoryName } from "./github-settings";

type Queryable = Pick<MetadataClient, "query">;

/** An organization's saved GitHub settings. */
export type OrgGitHub = RepositoryName & {
  /**
   * The access token, or null when it cannot be read on this server: it was
   * locked with a key the server no longer has (APP_ENCRYPTION_KEY changed,
   * or the database came from another server). An Admin adds it again.
   */
  token: string | null;
  /** The email address of whoever saved the settings last. */
  updatedBy: string;
  updatedAt: Date;
};

/** Who is making a change: the address the log shows, and the role it names. */
export type GitHubActor = { email: string; role: string };

type Row = {
  repo_owner: string;
  repo_name: string;
  token: string;
  updated_by: string;
  updated_at: Date;
};

/** The token in a stored row, or null when this server cannot open it. */
function openToken(stored: string): string | null {
  try {
    return decryptSecret(stored);
  } catch {
    return null;
  }
}

/** The organization's own GitHub settings, or null when it has none saved. */
export async function readOrgGitHub(orgId: number): Promise<OrgGitHub | null> {
  await syncMetadataTables();
  const { rows } = await pool.query<Row>(
    `SELECT repo_owner, repo_name, token, updated_by, updated_at
       FROM organization_github WHERE org_id = $1`,
    [orgId]
  );
  const row = rows[0];
  if (!row) return null;
  return {
    owner: row.repo_owner,
    repo: row.repo_name,
    token: openToken(row.token),
    updatedBy: row.updated_by,
    updatedAt: row.updated_at,
  };
}

/** What a save did. Only "ok" wrote anything. */
export type Saved =
  | { kind: "ok"; changed: boolean }
  /** No token was given, and there is no readable one saved to keep. */
  | { kind: "no-token" }
  /** The server has no encryption key, so the token would be stored as plain text. */
  | { kind: "no-key" }
  /** The organization is gone: someone deleted it a moment ago. */
  | { kind: "not-found" };

/**
 * Save an organization's repository and token inside the caller's
 * transaction, with its change log rows. A token of null keeps the one
 * already saved, so an Admin can point the organization at another
 * repository without pasting the token again.
 *
 * The caller has already checked with GitHub that the token opens the
 * repository (lib/github-check.ts). Nothing here talks to GitHub.
 */
export async function saveOrgGitHubIn(
  client: Queryable,
  orgId: number,
  settings: RepositoryName & { token: string | null },
  actor: GitHubActor
): Promise<Saved> {
  // Encrypted first, so a server without a key refuses before it locks or
  // writes anything.
  let sealed: string | null = null;
  if (settings.token !== null) {
    sealed = encryptSecret(settings.token);
    if (!sealed || !isEncrypted(sealed)) return { kind: "no-key" };
  }

  // A share lock on the organization keeps it from being deleted until this
  // commits, and tells a deleted one apart from a database error.
  const org = await client.query(`SELECT id FROM organizations WHERE id = $1 FOR KEY SHARE`, [orgId]);
  if (org.rows.length === 0) return { kind: "not-found" };

  // Locked, so two Admins saving at once are lined up and each log line says
  // what really changed in that save.
  const found = await client.query<Pick<Row, "repo_owner" | "repo_name" | "token">>(
    `SELECT repo_owner, repo_name, token FROM organization_github WHERE org_id = $1 FOR UPDATE`,
    [orgId]
  );
  const before = found.rows[0];
  if (sealed === null) {
    // Keeping the saved token is only possible when there is one this server
    // can still read. One locked with an old key would look saved and fail
    // on every push.
    if (!before || openToken(before.token) === null) return { kind: "no-token" };
  }

  const repositoryChanged =
    !before || before.repo_owner !== settings.owner || before.repo_name !== settings.repo;
  if (!repositoryChanged && sealed === null) return { kind: "ok", changed: false };

  await client.query(
    `INSERT INTO organization_github (org_id, repo_owner, repo_name, token, updated_by, updated_at)
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (org_id) DO UPDATE
       SET repo_owner = EXCLUDED.repo_owner,
           repo_name = EXCLUDED.repo_name,
           token = EXCLUDED.token,
           updated_by = EXCLUDED.updated_by,
           updated_at = EXCLUDED.updated_at`,
    [orgId, settings.owner, settings.repo, sealed ?? before!.token, actor.email]
  );

  const subject = repositoryLabel(settings);
  const entries: RoleChangeEntry[] = [];
  if (repositoryChanged) {
    entries.push({ role: actor.role, kind: "github-settings", subject, detail: "repository", actor: actor.email });
  }
  if (sealed !== null) {
    entries.push({ role: actor.role, kind: "github-settings", subject, detail: "token", actor: actor.email });
  }
  await logRoleChanges(client, orgId, entries);
  return { kind: "ok", changed: true };
}

/** saveOrgGitHubIn in a transaction of its own, for the Admin screen. */
export async function saveOrgGitHub(
  orgId: number,
  settings: RepositoryName & { token: string | null },
  actor: GitHubActor
): Promise<Saved> {
  await syncMetadataTables();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const saved = await saveOrgGitHubIn(client, orgId, settings, actor);
    await client.query(saved.kind === "ok" ? "COMMIT" : "ROLLBACK");
    return saved;
  } catch (error) {
    // The ROLLBACK can fail too, and the error worth reporting is the first.
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Forget an organization's GitHub settings, token and all, with a log row.
 * Removed is false when there was nothing saved. The scripts already in the
 * repository stay there: this only stops the app from using it.
 */
export async function removeOrgGitHub(orgId: number, actor: GitHubActor): Promise<{ removed: boolean }> {
  await syncMetadataTables();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<Pick<Row, "repo_owner" | "repo_name">>(
      `DELETE FROM organization_github WHERE org_id = $1 RETURNING repo_owner, repo_name`,
      [orgId]
    );
    const removed = rows[0];
    if (removed) {
      await logRoleChanges(client, orgId, [
        {
          role: actor.role,
          kind: "github-settings",
          subject: repositoryLabel({ owner: removed.repo_owner, repo: removed.repo_name }),
          detail: "removed",
          actor: actor.email,
        },
      ]);
    }
    await client.query("COMMIT");
    return { removed: Boolean(removed) };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
