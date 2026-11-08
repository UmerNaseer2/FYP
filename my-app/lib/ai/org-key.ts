// SERVER-ONLY: import this file from API routes and other server code only.
// It reads and writes organizations' AI keys, and a key in a browser bundle
// is a leaked key.
//
// An organization's own AI key, saved by an Admin on the Admin screen's AI
// tab. When one is saved, every AI call for that organization uses it, with
// the service it was made for (lib/ai/key-providers.ts), instead of the AI
// service in the server's settings. Removing it puts the organization back
// on the server's settings.
//
// It lives in the organization's organization_ai row, next to the AI switch.
// The key is stored encrypted with the server's key (lib/secret-store.ts) and
// never leaves the server: the screens only learn which service it is for and
// its last four characters. A server with no encryption key refuses to save
// one, because the alternative is a key sitting in the database as plain text.
//
// Every change is written to the change log in the same transaction as the
// change, as kind "ai-settings" with the subject AI_KEY_LOG_SUBJECT. The log
// names the service, never any part of the key.
import pool, { syncMetadataTables } from "../version-db";
import { logRoleChanges } from "../roles-db";
import { decryptSecret, encryptSecret, isEncrypted } from "../secret-store";
import { AI_KEY_LOG_SUBJECT, AI_KEY_PROVIDERS, isAiKeyProvider, type AiKeyProvider } from "./key-providers";
import type { AiActor } from "./settings";

/** What the server knows about an organization's own key. */
export type OrgAiKey = {
  provider: AiKeyProvider;
  /**
   * The key, or null when it cannot be read on this server: it was locked
   * with a key the server no longer has (APP_ENCRYPTION_KEY changed, or the
   * database came from another server). An Admin saves it again.
   */
  apiKey: string | null;
  /** The key's last four characters, the only part a screen shows. */
  hint: string;
  /** The models to use: the Admin's names, or the provider's usual ones. */
  models: { fast: string; smart: string };
  setBy: string | null;
  setAt: Date | null;
};

type Row = {
  key_provider: string | null;
  api_key: string | null;
  key_hint: string | null;
  model_fast: string | null;
  model_smart: string | null;
  key_set_by: string | null;
  key_set_at: Date | null;
};

/** The key in a stored row, or null when this server cannot open it. */
function openKey(stored: string): string | null {
  try {
    return decryptSecret(stored);
  } catch {
    return null;
  }
}

/** The organization's own key, or null when it has none saved. */
export async function readOrgKey(orgId: number): Promise<OrgAiKey | null> {
  await syncMetadataTables();
  const { rows } = await pool.query<Row>(
    `SELECT key_provider, api_key, key_hint, model_fast, model_smart, key_set_by, key_set_at
       FROM organization_ai WHERE org_id = $1`,
    [orgId]
  );
  const row = rows[0];
  // A provider this version does not know (a row from a newer version) is
  // treated as no key, so the organization falls back to the server's settings.
  if (!row || !row.api_key || !isAiKeyProvider(row.key_provider)) return null;
  const usual = AI_KEY_PROVIDERS[row.key_provider].models;
  return {
    provider: row.key_provider,
    apiKey: openKey(row.api_key),
    hint: row.key_hint ?? "",
    models: { fast: row.model_fast || usual.fast, smart: row.model_smart || usual.smart },
    setBy: row.key_set_by,
    setAt: row.key_set_at,
  };
}

/** The last four characters of a key, the only part ever shown. */
export function keyHint(apiKey: string): string {
  return apiKey.slice(-4);
}

export type OrgKeyInput = {
  provider: AiKeyProvider;
  apiKey: string;
  /** Empty or missing keeps the provider's usual model. */
  modelFast?: string;
  modelSmart?: string;
};

/** What a save did. Only "ok" wrote anything. */
export type KeySaved =
  | { kind: "ok" }
  /** The server has no encryption key, so the key would be stored as plain text. */
  | { kind: "no-key" }
  /** The organization is gone: someone deleted it a moment ago. */
  | { kind: "not-found" };

/**
 * Save an organization's own key, replacing any saved before, with a change
 * log row. The caller has checked the input (readAiKeyChange in views.ts).
 */
export async function saveOrgKey(orgId: number, input: OrgKeyInput, actor: AiActor): Promise<KeySaved> {
  // Encrypted first, so a server without a key refuses before it writes anything.
  const sealed = encryptSecret(input.apiKey);
  if (!sealed || !isEncrypted(sealed)) return { kind: "no-key" };

  await syncMetadataTables();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // A share lock on the organization keeps it from being deleted until this
    // commits, and tells a deleted one apart from a database error.
    const org = await client.query(`SELECT id FROM organizations WHERE id = $1 FOR KEY SHARE`, [orgId]);
    if (org.rows.length === 0) {
      await client.query("ROLLBACK");
      return { kind: "not-found" };
    }
    // An organization with no AI row yet gets one with AI still off: saving
    // a key does not switch AI on, an Admin does that with the switch.
    await client.query(
      `INSERT INTO organization_ai
         (org_id, enabled, features, updated_by, updated_at,
          key_provider, api_key, key_hint, model_fast, model_smart, key_set_by, key_set_at)
       VALUES ($1, false, '{}'::jsonb, $2, now(), $3, $4, $5, $6, $7, $2, now())
       ON CONFLICT (org_id) DO UPDATE
         SET key_provider = EXCLUDED.key_provider,
             api_key = EXCLUDED.api_key,
             key_hint = EXCLUDED.key_hint,
             model_fast = EXCLUDED.model_fast,
             model_smart = EXCLUDED.model_smart,
             key_set_by = EXCLUDED.key_set_by,
             key_set_at = EXCLUDED.key_set_at`,
      [
        orgId,
        actor.email,
        input.provider,
        sealed,
        keyHint(input.apiKey),
        input.modelFast || null,
        input.modelSmart || null,
      ]
    );
    await logRoleChanges(client, orgId, [
      {
        role: actor.role,
        kind: "ai-settings",
        subject: AI_KEY_LOG_SUBJECT,
        detail: AI_KEY_PROVIDERS[input.provider].label,
        actor: actor.email,
      },
    ]);
    await client.query("COMMIT");
    return { kind: "ok" };
  } catch (error) {
    // The ROLLBACK can fail too, and the error worth reporting is the first.
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Forget an organization's own key, with a log row, so its AI calls use the
 * server's settings again. Removed is false when there was no key saved.
 */
export async function removeOrgKey(orgId: number, actor: AiActor): Promise<{ removed: boolean }> {
  await syncMetadataTables();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ org_id: number }>(
      `UPDATE organization_ai
          SET key_provider = NULL, api_key = NULL, key_hint = NULL,
              model_fast = NULL, model_smart = NULL, key_set_by = NULL, key_set_at = NULL
        WHERE org_id = $1 AND api_key IS NOT NULL
        RETURNING org_id`,
      [orgId]
    );
    if (rows.length > 0) {
      await logRoleChanges(client, orgId, [
        {
          role: actor.role,
          kind: "ai-settings",
          subject: AI_KEY_LOG_SUBJECT,
          detail: "removed",
          actor: actor.email,
        },
      ]);
    }
    await client.query("COMMIT");
    return { removed: rows.length > 0 };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
