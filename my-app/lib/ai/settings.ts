// SERVER-ONLY: import this file from API routes and other server code only.
//
// Whether an organization lets its people use AI assistance, and which of the
// AI features are on. One row per organization at most (organization_ai). No
// row means AI is off: every organization starts there, and an Admin switches
// it on from the Admin screen's AI tab.
//
// Every change is written to the change log in the same transaction as the
// change, as kind "ai-settings".
import pool, { syncMetadataTables } from "../version-db";
import { logRoleChanges, type RoleChangeEntry } from "../roles-db";
import { AI_FEATURES, FEATURE_LABELS, type AiFeature } from "./prompts";

export type OrgAiSettings = {
  enabled: boolean;
  /** Every feature, on or off. A feature nobody switched is on. */
  features: Record<AiFeature, boolean>;
  updatedBy: string | null;
  updatedAt: Date | null;
};

function allFeatures(saved: Record<string, boolean> | null | undefined): Record<AiFeature, boolean> {
  return Object.fromEntries(AI_FEATURES.map((feature) => [feature, saved?.[feature] !== false])) as Record<
    AiFeature,
    boolean
  >;
}

export const AI_OFF: OrgAiSettings = { enabled: false, features: allFeatures({}), updatedBy: null, updatedAt: null };

type Row = { enabled: boolean; features: Record<string, boolean>; updated_by: string; updated_at: Date };

export async function readOrgAi(orgId: number): Promise<OrgAiSettings> {
  await syncMetadataTables();
  const { rows } = await pool.query<Row>(
    `SELECT enabled, features, updated_by, updated_at FROM organization_ai WHERE org_id = $1`,
    [orgId]
  );
  const row = rows[0];
  if (!row) return AI_OFF;
  return {
    enabled: row.enabled,
    features: allFeatures(row.features),
    updatedBy: row.updated_by,
    updatedAt: row.updated_at,
  };
}

/** Whether one feature can run for an organization's settings. */
export function featureOn(settings: OrgAiSettings, feature: AiFeature): boolean {
  return settings.enabled && settings.features[feature];
}

export type AiSettingsChange = { enabled?: boolean; features?: Partial<Record<AiFeature, boolean>> };
export type AiActor = { email: string; role: string };

/** Save a change and log what really changed. Returns the settings after it. */
export async function saveOrgAi(
  orgId: number,
  change: AiSettingsChange,
  actor: AiActor
): Promise<{ kind: "ok"; settings: OrgAiSettings; changed: boolean } | { kind: "not-found" }> {
  await syncMetadataTables();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const org = await client.query(`SELECT id FROM organizations WHERE id = $1 FOR KEY SHARE`, [orgId]);
    if (org.rows.length === 0) {
      await client.query("ROLLBACK");
      return { kind: "not-found" };
    }
    const found = await client.query<Row>(
      `SELECT enabled, features, updated_by, updated_at FROM organization_ai WHERE org_id = $1 FOR UPDATE`,
      [orgId]
    );
    const before = found.rows[0];
    const beforeEnabled = before?.enabled ?? false;
    const beforeFeatures = allFeatures(before?.features);
    const enabled = change.enabled ?? beforeEnabled;
    const features = { ...beforeFeatures };
    for (const feature of AI_FEATURES) {
      const wanted = change.features?.[feature];
      if (typeof wanted === "boolean") features[feature] = wanted;
    }

    const entries: RoleChangeEntry[] = [];
    if (enabled !== beforeEnabled) {
      entries.push({ role: actor.role, kind: "ai-settings", detail: enabled ? "on" : "off", actor: actor.email });
    }
    for (const feature of AI_FEATURES) {
      if (features[feature] !== beforeFeatures[feature]) {
        entries.push({
          role: actor.role,
          kind: "ai-settings",
          subject: FEATURE_LABELS[feature],
          detail: features[feature] ? "on" : "off",
          actor: actor.email,
        });
      }
    }
    if (entries.length === 0) {
      await client.query("ROLLBACK");
      return { kind: "ok", changed: false, settings: before ? await readOrgAi(orgId) : AI_OFF };
    }

    // Only the switched-off features are stored, so a feature added later
    // starts on wherever AI is on.
    const off = Object.fromEntries(AI_FEATURES.filter((f) => !features[f]).map((f) => [f, false]));
    const saved = await client.query<Row>(
      `INSERT INTO organization_ai (org_id, enabled, features, updated_by, updated_at)
       VALUES ($1, $2, $3::jsonb, $4, now())
       ON CONFLICT (org_id) DO UPDATE
         SET enabled = EXCLUDED.enabled,
             features = EXCLUDED.features,
             updated_by = EXCLUDED.updated_by,
             updated_at = EXCLUDED.updated_at
       RETURNING enabled, features, updated_by, updated_at`,
      [orgId, enabled, JSON.stringify(off), actor.email]
    );
    await logRoleChanges(client, orgId, entries);
    await client.query("COMMIT");
    const row = saved.rows[0];
    return {
      kind: "ok",
      changed: true,
      settings: {
        enabled: row.enabled,
        features: allFeatures(row.features),
        updatedBy: row.updated_by,
        updatedAt: row.updated_at,
      },
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
