// Where the server's encryption key for saved database passwords comes from,
// as encryptionKeySource() reports it. The landing page asks on every request
// and tells visitors whether their passwords are encrypted, so a wrong answer
// here is a false promise on the front page.
//
// Each case loads a fresh copy of lib/secret-store.ts. The module reads the
// environment on its first call, not at import, and keeps the answer for the
// life of the process, so the settings must stay in place until that call.
//
// The key and the secret below are made up and protect nothing.

import type { KeySource } from "../lib/secret-store";

type Settings = { APP_ENCRYPTION_KEY?: string; NEXTAUTH_SECRET?: string };

/**
 * Loads a fresh copy of the module with only `settings` in the environment
 * and asks it for its key source `asks` times, the way the landing page asks
 * on every request. Returns every answer.
 */
async function askWith(settings: Settings, asks = 1): Promise<KeySource[]> {
  const saved = process.env;
  process.env = { ...saved };
  delete process.env.APP_ENCRYPTION_KEY;
  delete process.env.NEXTAUTH_SECRET;
  Object.assign(process.env, settings);
  try {
    jest.resetModules();
    const { encryptionKeySource } = await import("../lib/secret-store");
    return Array.from({ length: asks }, () => encryptionKeySource());
  } finally {
    process.env = saved;
  }
}

const HEX_KEY = "ab".repeat(32); // 32 bytes, written as 64 hex characters
const BASE64_KEY = Buffer.alloc(32, 7).toString("base64"); // the same length, as base64
const SECRET = ["not", "a", "real", "secret"].join("-");
const PLACEHOLDER = "change-me-before-anyone-else-uses-this";

describe("encryptionKeySource", () => {
  it("answers app-key for a 32-byte APP_ENCRYPTION_KEY in hex or base64", async () => {
    expect(await askWith({ APP_ENCRYPTION_KEY: HEX_KEY })).toEqual(["app-key"]);
    expect(await askWith({ APP_ENCRYPTION_KEY: BASE64_KEY })).toEqual(["app-key"]);
  });

  it("answers derived when there is only NEXTAUTH_SECRET", async () => {
    expect(await askWith({ NEXTAUTH_SECRET: SECRET })).toEqual(["derived"]);
  });

  it("prefers APP_ENCRYPTION_KEY when both are set", async () => {
    expect(await askWith({ APP_ENCRYPTION_KEY: HEX_KEY, NEXTAUTH_SECRET: SECRET })).toEqual(["app-key"]);
  });

  it("falls back to NEXTAUTH_SECRET when APP_ENCRYPTION_KEY is not a usable key", async () => {
    expect(await askWith({ APP_ENCRYPTION_KEY: "too-short", NEXTAUTH_SECRET: SECRET })).toEqual(["derived"]);
  });

  it("answers none when NEXTAUTH_SECRET is only spaces", async () => {
    // A blank secret derives nothing, so claiming encryption from it would be
    // the false promise this file exists to prevent.
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(await askWith({ NEXTAUTH_SECRET: "   " })).toEqual(["none"]);
    } finally {
      warn.mockRestore();
    }
  });

  it("answers none for the placeholder secret docker-compose.yml used to fill in", async () => {
    // The value is in the repository, so a key made from it is a key anyone
    // can make, and the landing page must not call that encrypted.
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(await askWith({ NEXTAUTH_SECRET: PLACEHOLDER })).toEqual(["none"]);
      expect(String(warn.mock.calls[0]?.[0])).toContain("example value from docker-compose.yml");
    } finally {
      warn.mockRestore();
    }
  });

  it("answers none when there is neither, and says so in the log only once", async () => {
    // Asked on every request, so a warning per ask would fill the server log.
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(await askWith({}, 3)).toEqual(["none", "none", "none"]);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("a value saved under the placeholder secret", () => {
  /** Loads a fresh copy of the module with only `settings` in the environment. */
  async function storeWith(settings: Settings) {
    const saved = process.env;
    process.env = { ...saved };
    delete process.env.APP_ENCRYPTION_KEY;
    delete process.env.NEXTAUTH_SECRET;
    Object.assign(process.env, settings);
    jest.resetModules();
    const store = await import("../lib/secret-store");
    return { store, restore: () => (process.env = saved) };
  }

  /** What the old code wrote: a value locked with the key the placeholder derives. */
  function lockedWithPlaceholder(plain: string): string {
    const crypto = require("node:crypto") as typeof import("node:crypto");
    const key = crypto.scryptSync(PLACEHOLDER, "schema-studio/connection-secrets/v1", 32);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    return ["enc", "v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), body.toString("base64")].join(":");
  }

  let warn: jest.SpyInstance;
  beforeEach(() => {
    warn = jest.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => warn.mockRestore());

  it("is still read on a server still running on the placeholder", async () => {
    const { store, restore } = await storeWith({ NEXTAUTH_SECRET: PLACEHOLDER });
    try {
      expect(store.decryptSecret(lockedWithPlaceholder("hunter2"))).toBe("hunter2");
      // A new password is no longer locked with that key: it is kept as typed,
      // which is what the Connections screen and the landing page say.
      expect(store.encryptSecret("new-password")).toBe("new-password");
    } finally {
      restore();
    }
  });

  it("is still read once the server has a key of its own, and new values use that key", async () => {
    const { store, restore } = await storeWith({ APP_ENCRYPTION_KEY: HEX_KEY });
    try {
      expect(store.decryptSecret(lockedWithPlaceholder("hunter2"))).toBe("hunter2");
      const fresh = store.encryptSecret("new-password");
      expect(store.isEncrypted(fresh)).toBe(true);
      expect(store.decryptSecret(fresh)).toBe("new-password");
    } finally {
      restore();
    }
  });

  it("still refuses a value locked with some other key", async () => {
    const other = await storeWith({ APP_ENCRYPTION_KEY: BASE64_KEY });
    const locked = other.store.encryptSecret("hunter2");
    other.restore();

    const { store, restore } = await storeWith({ APP_ENCRYPTION_KEY: HEX_KEY });
    try {
      expect(() => store.decryptSecret(locked)).toThrow(/Could not decrypt/);
    } finally {
      restore();
    }
    const none = await storeWith({});
    try {
      expect(() => none.store.decryptSecret(locked)).toThrow(/no encryption key is configured/);
    } finally {
      none.restore();
    }
  });
});
