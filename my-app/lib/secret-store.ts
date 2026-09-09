import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from "node:crypto";

/**
 * Encryption at rest for saved database credentials.
 *
 * `connections.password` and `connections.connection_string` used to be stored
 * as plain text — twice over, since a URI connection embeds the password in the
 * connection string. Anyone with read access to the metadata database (a backup,
 * a leaked DATABASE_URL_A, a curious teammate) had every target credential.
 *
 * Values are stored as:
 *
 *     enc:v1:<base64 iv>:<base64 auth tag>:<base64 ciphertext>
 *
 * AES-256-GCM, a fresh 12-byte IV per value, and the authentication tag stored
 * alongside — so a tampered value fails to decrypt rather than decrypting to
 * garbage.
 *
 * MIXED CONTENT IS EXPECTED AND SAFE. `decryptSecret` passes through anything
 * that does not carry the `enc:v1:` prefix, which covers two real cases:
 *   1. rows written before this existed, and
 *   2. plaintext the user just typed into the drawer form.
 * Rows are upgraded in place the next time they are written.
 */

const PREFIX = "enc:v1:";
const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const KEY_BYTES = 32;

/** Fixed salt: the derivation must be deterministic, and the input secret is already high-entropy. */
const DERIVATION_SALT = "schema-studio/connection-secrets/v1";

export type KeySource = "app-key" | "derived" | "none";

type ResolvedKey = { key: Buffer; source: Exclude<KeySource, "none"> } | { key: null; source: "none" };

let cached: ResolvedKey | null = null;
let warned = false;

/** Accept a 32-byte key as 64 hex chars or as base64. */
function parseKeyMaterial(raw: string): Buffer | null {
  const value = raw.trim();
  if (!value) return null;

  if (/^[0-9a-fA-F]{64}$/.test(value)) {
    return Buffer.from(value, "hex");
  }

  try {
    const decoded = Buffer.from(value, "base64");
    if (decoded.length === KEY_BYTES) return decoded;
  } catch {
    /* not base64 — fall through */
  }

  return null;
}

function resolveKey(): ResolvedKey {
  if (cached) return cached;

  const explicit = parseKeyMaterial(process.env.APP_ENCRYPTION_KEY ?? "");
  if (explicit) {
    cached = { key: explicit, source: "app-key" };
    return cached;
  }

  // Fall back to deriving from NEXTAUTH_SECRET so a project that has already
  // configured auth gets encryption without a second secret to manage.
  const nextAuthSecret = (process.env.NEXTAUTH_SECRET ?? "").trim();
  if (nextAuthSecret) {
    cached = {
      key: scryptSync(nextAuthSecret, DERIVATION_SALT, KEY_BYTES),
      source: "derived",
    };
    return cached;
  }

  if (!warned) {
    warned = true;
    console.warn(
      "[secret-store] No APP_ENCRYPTION_KEY and no NEXTAUTH_SECRET — saved database " +
        "credentials will be stored in PLAIN TEXT. Set APP_ENCRYPTION_KEY (32 bytes, hex or base64) " +
        "in .env.local to turn encryption on; existing rows upgrade the next time they are saved."
    );
  }
  cached = { key: null, source: "none" };
  return cached;
}

/** True when a stored value is in the encrypted envelope format. */
export function isEncrypted(value: string | null | undefined): boolean {
  return typeof value === "string" && value.startsWith(PREFIX);
}

/**
 * Encrypt a secret for storage. Returns the value unchanged when it is empty
 * (nothing to protect) or when no key is configured (see the warning above).
 * Already-encrypted input is returned as-is so callers can be idempotent.
 */
export function encryptSecret(plain: string | null | undefined): string | null {
  if (plain === null || plain === undefined || plain === "") return plain ?? null;
  if (isEncrypted(plain)) return plain;

  const { key } = resolveKey();
  if (!key) return plain;

  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [
    PREFIX.slice(0, -1), // "enc:v1" — the trailing ":" comes from the join
    iv.toString("base64"),
    tag.toString("base64"),
    ciphertext.toString("base64"),
  ].join(":");
}

/**
 * Decrypt a stored secret. Anything without the envelope prefix is returned
 * unchanged (legacy plaintext rows, or a value the user just typed).
 *
 * Throws when an encrypted value cannot be opened. That is deliberate: silently
 * handing ciphertext to the driver would surface as "password authentication
 * failed", which sends you looking at the wrong problem entirely.
 */
export function decryptSecret(stored: string | null | undefined): string | null {
  if (stored === null || stored === undefined || stored === "") return stored ?? null;
  if (!isEncrypted(stored)) return stored;

  const { key, source } = resolveKey();
  if (!key) {
    throw new Error(
      "This connection's credentials are encrypted but no encryption key is configured. " +
        "Set APP_ENCRYPTION_KEY in .env.local to the key they were saved with."
    );
  }

  const parts = stored.split(":");
  // enc : v1 : iv : tag : ciphertext
  if (parts.length !== 5) {
    throw new Error("Stored credential is malformed (unexpected envelope shape).");
  }

  const iv = Buffer.from(parts[2], "base64");
  const tag = Buffer.from(parts[3], "base64");
  const ciphertext = Buffer.from(parts[4], "base64");

  if (iv.length !== IV_BYTES) {
    throw new Error("Stored credential is malformed (bad IV length).");
  }

  try {
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    throw new Error(
      `Could not decrypt a stored credential with the current key (source: ${source}). ` +
        "The key has probably changed since the connection was saved — re-enter its password."
    );
  }
}
