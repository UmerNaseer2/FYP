// SERVER-ONLY: import this file from API routes only.
//
// The Admin screen's AI tab, as one view: the AI switch and features, the
// organization's own AI key (which service, its last four characters, never
// the key), what AI calls use now, and the last 30 days of use. Shared by
// GET and PATCH /api/admin/ai and by /api/admin/ai/key, so every answer
// draws the tab the same way.
import type { Principal } from "../auth-guard";
import { hasPermission } from "../permissions";
import { encryptionKeySource } from "../secret-store";
import { describeAiConfig, readAiLimits, type AiSetup } from "./config";
import { AI_KEY_PROVIDERS } from "./key-providers";
import { readOrgKey, type OrgAiKey } from "./org-key";
import { AI_FEATURES, FEATURE_LABELS } from "./prompts";
import { readOrgAi, type OrgAiSettings } from "./settings";
import { readAiUsage } from "./store";
import type { AiAdminView, AiKeyView } from "./views";

/** The organization's own key as the screen may see it. */
function keyView(key: OrgAiKey): AiKeyView {
  return {
    provider: key.provider,
    service: AI_KEY_PROVIDERS[key.provider].label,
    hint: key.hint,
    models: { ...key.models },
    setBy: key.setBy,
    setAt: key.setAt ? new Date(key.setAt).toISOString() : null,
    readable: key.apiKey !== null,
  };
}

/** What AI calls use now: the same choice as aiDepsFor in run.ts. */
function setupOf(key: OrgAiKey | null, serverSetup: AiSetup): AiSetup {
  if (!key) return serverSetup;
  return {
    configured: key.apiKey !== null,
    service: AI_KEY_PROVIDERS[key.provider].label,
    models: { ...key.models },
    ownKey: true,
  };
}

/**
 * The AI tab for the caller's organization. `settings` saves a read when the
 * caller has just saved them. The use figures are a nice to have: the tab
 * still works without them.
 */
export async function readAiAdminView(principal: Principal, settings?: OrgAiSettings): Promise<AiAdminView> {
  const orgId = principal.orgId;
  const [current, key] = await Promise.all([settings ?? readOrgAi(orgId), readOrgKey(orgId)]);
  const usage = await readAiUsage(orgId).catch((error) => {
    console.error("Failed to read the AI usage:", error);
    return null;
  });
  const serverSetup = describeAiConfig();
  const setup = setupOf(key, serverSetup);
  return {
    setup,
    serverSetup,
    orgKey: key ? keyView(key) : null,
    canStoreKeys: encryptionKeySource() !== "none",
    enabled: current.enabled,
    features: AI_FEATURES.map((feature) => ({ key: feature, label: FEATURE_LABELS[feature], on: current.features[feature] })),
    updatedBy: current.updatedBy,
    updatedAt: current.updatedAt ? new Date(current.updatedAt).toISOString() : null,
    usage,
    dailyLimit: setup.configured ? readAiLimits().dailyLimit : null,
    canUpdate: hasPermission(principal, "organization:update"),
  };
}
