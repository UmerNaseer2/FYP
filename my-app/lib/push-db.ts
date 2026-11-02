/**
 * What the server keeps for phone alerts: the devices that asked for them and
 * the push key they subscribed with.
 *
 * A device belongs to a person. Which organization's alerts reach it is worked
 * out when one is sent (subscriptionsInOrganization), so nothing here has to be
 * cleaned up when someone leaves an organization or changes role.
 *
 * Endpoints and keys are as good as passwords for the device, so nothing here
 * logs them, and no route gives them back.
 */
import { randomBytes } from "node:crypto";
import { decryptSecret, encryptSecret } from "@/lib/secret-store";
import pool, { syncMetadataTables } from "@/lib/version-db";
import {
  newPushKey,
  readPushKey,
  type PushKey,
  type PushSubscriptionFields,
} from "@/lib/web-push";

const KEY_NAME = "site";

/** The most devices one person keeps alerts on. A new one past this drops their oldest. */
export const MOST_DEVICES_PER_PERSON = 10;

export type StoredSubscription = PushSubscriptionFields & { id: number };

export type OrganizationSubscription = StoredSubscription & {
  profileId: number;
  email: string;
  role: string;
};

/** A stored key, or null when this server cannot read it. */
function readStoredKey(stored: string): PushKey | null {
  try {
    return readPushKey(decryptSecret(stored));
  } catch {
    // APP_ENCRYPTION_KEY has changed. pushKeyInUse makes a new one.
    return null;
  }
}

/**
 * The push key, made the first time anyone needs one.
 *
 * Two servers starting together can both get here with no key. Whichever insert
 * lands first wins and both read that one back, so they agree without a lock.
 *
 * A key this server cannot read (APP_ENCRYPTION_KEY has changed) is replaced,
 * and every device goes with it, because their subscriptions are tied to the
 * old key and could never be used again. Each device subscribes again the next
 * time the app opens on it.
 */
async function pushKeyInUse(): Promise<PushKey> {
  await syncMetadataTables();
  await pool.query(
    `INSERT INTO push_keys (name, private_key, created_at) VALUES ($1, $2, now())
     ON CONFLICT (name) DO NOTHING`,
    [KEY_NAME, encryptSecret(newPushKey(randomBytes))]
  );
  const found = await pool.query<{ private_key: string }>(
    "SELECT private_key FROM push_keys WHERE name = $1",
    [KEY_NAME]
  );
  const stored = found.rows[0].private_key;
  const key = readStoredKey(stored);
  if (key) return key;

  // Only the server whose update lands forgets the devices, so that one
  // starting a moment later cannot forget a device that has just subscribed.
  const fresh = newPushKey(randomBytes);
  const replaced = await pool.query(
    "UPDATE push_keys SET private_key = $1 WHERE name = $2 AND private_key = $3",
    [encryptSecret(fresh), KEY_NAME, stored]
  );
  if (replaced.rowCount === 1) {
    await pool.query("DELETE FROM push_subscriptions");
    return readPushKey(fresh)!;
  }
  return pushKeyInUse();
}

/** The public half of the push key, which a browser subscribes with, as base64url. */
export async function pushPublicKey(): Promise<string> {
  const key = await pushKeyInUse();
  return key.publicKey.toString("base64url");
}

/** The push key and the contact address that signs each message. */
export async function pushSender(): Promise<{ key: PushKey; siteOrigin: string | null }> {
  const key = await pushKeyInUse();
  const found = await pool.query<{ site_origin: string | null }>(
    "SELECT site_origin FROM push_keys WHERE name = $1",
    [KEY_NAME]
  );
  return { key, siteOrigin: found.rows[0]?.site_origin ?? null };
}

/** Keeps the site's https address for push services to contact. Anything else is left out. */
export async function rememberSiteOrigin(origin: string | null): Promise<void> {
  if (origin === null || !origin.startsWith("https://")) return;
  await pool.query(
    `UPDATE push_keys SET site_origin = $1
      WHERE name = $2 AND site_origin IS DISTINCT FROM $1`,
    [origin, KEY_NAME]
  );
}

/**
 * Keeps a device for this person.
 *
 * A device already known moves to them, because alerts on a phone belong to
 * whoever turned them on last: a shared phone must not keep showing the last
 * person's alerts to the next.
 */
export async function savePushSubscription(
  profileId: number,
  subscription: PushSubscriptionFields
): Promise<void> {
  await syncMetadataTables();
  await pool.query(
    `INSERT INTO push_subscriptions (profile_id, endpoint, p256dh, auth, hold_until, created_at)
     VALUES ($1, $2, $3, $4, NULL, now())
     ON CONFLICT (endpoint) DO UPDATE
       SET profile_id = EXCLUDED.profile_id,
           p256dh = EXCLUDED.p256dh,
           auth = EXCLUDED.auth,
           hold_until = NULL,
           created_at = now()`,
    [profileId, subscription.endpoint, subscription.p256dh, subscription.auth]
  );
  await pool.query(
    `DELETE FROM push_subscriptions
      WHERE profile_id = $1
        AND id NOT IN (
          SELECT id FROM push_subscriptions
           WHERE profile_id = $1
           ORDER BY created_at DESC, id DESC
           LIMIT $2
        )`,
    [profileId, MOST_DEVICES_PER_PERSON]
  );
}

/** Forgets one of this person's devices. Someone else's stays, whatever address is sent. */
export async function deletePushSubscription(profileId: number, endpoint: string): Promise<void> {
  await syncMetadataTables();
  await pool.query("DELETE FROM push_subscriptions WHERE profile_id = $1 AND endpoint = $2", [
    profileId,
    endpoint,
  ]);
}

const SUBSCRIPTION_COLUMNS = "s.id, s.endpoint, s.p256dh, s.auth";

/** This person's devices that can take a message now. */
export async function listOwnSubscriptions(profileId: number): Promise<StoredSubscription[]> {
  await syncMetadataTables();
  const result = await pool.query<StoredSubscription>(
    `SELECT ${SUBSCRIPTION_COLUMNS}
       FROM push_subscriptions s
      WHERE s.profile_id = $1
        AND (s.hold_until IS NULL OR s.hold_until <= now())`,
    [profileId]
  );
  return result.rows;
}

/** The devices of everyone now in this organization that can take a message now, with who holds them. */
export async function subscriptionsInOrganization(orgId: number): Promise<OrganizationSubscription[]> {
  await syncMetadataTables();
  const result = await pool.query<OrganizationSubscription>(
    `SELECT ${SUBSCRIPTION_COLUMNS}, s.profile_id AS "profileId", p.email, m.role
       FROM push_subscriptions s
       JOIN memberships m ON m.profile_id = s.profile_id AND m.org_id = $1
       JOIN profiles p ON p.id = s.profile_id
      WHERE s.hold_until IS NULL OR s.hold_until <= now()`,
    [orgId]
  );
  return result.rows;
}

/** Forgets a device whose push service says it has gone for good. */
export async function dropPushSubscription(id: number): Promise<void> {
  await pool.query("DELETE FROM push_subscriptions WHERE id = $1", [id]);
}

/** Sends nothing more to a device until `until`, because its push service asked for a wait. */
export async function holdPushSubscription(id: number, until: Date): Promise<void> {
  await pool.query("UPDATE push_subscriptions SET hold_until = $1 WHERE id = $2", [until, id]);
}
