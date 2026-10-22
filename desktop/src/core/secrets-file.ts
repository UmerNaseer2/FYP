/**
 * The two files that hold the app's secrets: how they are laid out on disk,
 * and checking what comes back when they are read.
 *
 *  - secrets.json (in ~/.local/share/schema-studio) holds the keys this copy
 *    of the app made for itself the first time it ran: one that signs the web
 *    app's sign-in cookie (NEXTAUTH_SECRET), one that locks the database
 *    passwords saved with each connection (APP_ENCRYPTION_KEY), and the
 *    GitHub access token typed into Settings, if there is one. Nothing secret
 *    comes in the installer; every computer makes its own.
 *  - auth.json (in ~/.config/schema-studio) holds the Microsoft sign-in: what
 *    the Microsoft library keeps so it can sign in again without asking, and
 *    when Microsoft last said yes (see src/core/offline.ts).
 *
 * Where the desktop has a keyring (GNOME Keyring, KWallet), each file holds its
 * contents locked with a key from the keyring, so a copy of the file is no use
 * on its own. Without a keyring, the contents are kept as they are, in a file
 * only this person can read, and Settings says so. Locking them with a key
 * written into the app itself, which is what Chromium does in that case, would
 * only look safer.
 *
 * Both files use the same envelope:
 *
 *   { "version": 1, "protection": "keyring", "backend": "gnome_libsecret", "data": "<base64>" }
 *   { "version": 1, "protection": "plain", "values": { ... } }
 *
 * `backend` records which keyring locked the data, so the app can explain
 * itself when a different one (or none) is running later.
 *
 * src/main/secrets.ts reads and writes the files; this one is pure, and tested
 * in src/test/secrets-file.test.ts.
 */
import { isSavedTokenValid } from "./github-settings";

export type ProtectedEnvelope =
  | { version: 1; protection: "keyring"; backend?: string; data: string }
  | { version: 1; protection: "plain"; values: unknown };

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The envelope in a file's text, or null when the file is damaged. */
export function parseEnvelope(text: string): ProtectedEnvelope | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(value) || value.version !== 1) return null;

  if (value.protection === "keyring") {
    const { data, backend } = value;
    if (typeof data !== "string" || data.length % 4 !== 0 || !BASE64.test(data)) return null;
    if (backend === undefined) return { version: 1, protection: "keyring", data };
    if (typeof backend !== "string") return null;
    return { version: 1, protection: "keyring", backend, data };
  }
  if (value.protection === "plain") {
    if (!("values" in value)) return null;
    return { version: 1, protection: "plain", values: value.values };
  }
  return null;
}

export function serializeEnvelope(envelope: ProtectedEnvelope): string {
  return JSON.stringify(envelope, null, 2) + "\n";
}

/** What secrets.json holds. */
export type SecretValues = {
  nextauthSecret: string;
  /** 32 bytes as 64 hex digits, the form the web app reads first. */
  appEncryptionKey: string;
  githubToken: string | null;
};

/** Fresh keys for a new install. `random` is crypto.randomBytes, passed in so tests can fix it. */
export function newSecretValues(random: (size: number) => Buffer): SecretValues {
  return {
    nextauthSecret: random(32).toString("base64url"),
    appEncryptionKey: random(32).toString("hex"),
    githubToken: null,
  };
}

/**
 * The values read back from secrets.json, or null when they are not what the
 * app wrote. The keys are checked exactly: one that is wrong but still used
 * would sign everyone out, or leave every saved password unreadable.
 */
export function parseSecretValues(value: unknown): SecretValues | null {
  if (!isRecord(value)) return null;
  const { nextauthSecret, appEncryptionKey, githubToken } = value;
  if (typeof nextauthSecret !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(nextauthSecret)) return null;
  if (typeof appEncryptionKey !== "string" || !/^[0-9a-f]{64}$/.test(appEncryptionKey)) return null;
  if (githubToken === undefined || githubToken === null) {
    return { nextauthSecret, appEncryptionKey, githubToken: null };
  }
  if (!isSavedTokenValid(githubToken)) return null;
  return { nextauthSecret, appEncryptionKey, githubToken };
}

/** What auth.json holds. */
export type AuthState = {
  /** What the Microsoft library keeps between runs (its "token cache"), exactly as it wrote it. */
  msalCache: string | null;
  /** When Microsoft last said the account may come in, in milliseconds since 1970. */
  lastOnlineCheck: number | null;
};

export function emptyAuthState(): AuthState {
  return { msalCache: null, lastOnlineCheck: null };
}

/** The sign-in read back from auth.json, or null when it is not what the app wrote. */
export function parseAuthState(value: unknown): AuthState | null {
  if (!isRecord(value)) return null;

  let msalCache: string | null = null;
  if (typeof value.msalCache === "string") msalCache = value.msalCache;
  else if (value.msalCache !== undefined && value.msalCache !== null) return null;

  let lastOnlineCheck: number | null = null;
  if (typeof value.lastOnlineCheck === "number" && Number.isFinite(value.lastOnlineCheck)) {
    lastOnlineCheck = value.lastOnlineCheck;
  } else if (value.lastOnlineCheck !== undefined && value.lastOnlineCheck !== null) {
    return null;
  }

  return { msalCache, lastOnlineCheck };
}
