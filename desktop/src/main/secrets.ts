/**
 * Keeps a small JSON file of secrets: secrets.json, which holds the keys this
 * copy of Schema Studio made for itself, and auth.json, which holds the
 * Microsoft sign-in. Both are written so that only the person can read them
 * (mode 0600, in a 0700 folder), and where Ubuntu has a login keyring (GNOME
 * Keyring or KWallet) the contents are locked with it as well, so a copy of
 * the file on its own is no use to anyone.
 *
 * The file records how it was protected (see src/core/secrets-file.ts), so it
 * is always read back the right way. A file saved before a keyring was
 * available is moved into the keyring the next time it is read (upgrade),
 * and a keyring that fails while saving falls back to the plain file rather
 * than losing the secret.
 *
 * Electron's safeStorage does the locking. When no keyring answers it uses a
 * "basic_text" backend whose key is the same on every computer, so that
 * counts as no keyring at all. The self-test passes allowKeyring false, so it
 * never touches the person's keyring or makes it ask to be unlocked.
 */
import path from "node:path";
import { safeStorage } from "electron";

import { readFileIfExists, removeStaleTempFiles, writeFileAtomic } from "../core/atomic-file";
import { parseEnvelope, serializeEnvelope, type ProtectedEnvelope } from "../core/secrets-file";
import { logWarn } from "./log";

export type Protection = "keyring" | "plain";

export type LoadResult<T> =
  | { status: "missing" }
  /** upgrade: the file is plain, but a keyring is now there to lock it with. */
  | { status: "values"; values: T; protection: Protection; upgrade: boolean }
  | { status: "damaged"; message: string }
  | { status: "locked"; message: string };

export type ProtectedStoreOptions<T> = {
  file: string;
  /** What the file holds, for the log: "the app's keys", "the Microsoft sign-in". */
  what: string;
  /** Checks what was read, giving null for anything that is not right. */
  parse: (value: unknown) => T | null;
  allowKeyring: boolean;
};

/** Which keyring safeStorage uses: "gnome_libsecret", "kwallet5", "basic_text" and so on. */
export function keyringBackend(): string {
  try {
    return safeStorage.getSelectedStorageBackend();
  } catch {
    // Not on Linux, or not ready yet.
    return "unknown";
  }
}

export class ProtectedStore<T> {
  private readonly options: ProtectedStoreOptions<T>;

  constructor(options: ProtectedStoreOptions<T>) {
    this.options = options;
    removeStaleTempFiles(path.dirname(options.file));
  }

  keyringAvailable(): boolean {
    if (!this.options.allowKeyring) return false;
    try {
      if (!safeStorage.isEncryptionAvailable()) return false;
    } catch {
      return false;
    }
    const backend = keyringBackend();
    return backend !== "basic_text" && backend !== "unknown";
  }

  load(): LoadResult<T> {
    const { file, what } = this.options;
    let text: string | null;
    try {
      text = readFileIfExists(file);
    } catch (error) {
      logWarn(`Could not read ${file}, which holds ${what}.`, error);
      return { status: "damaged", message: `${file} could not be read.` };
    }
    if (text === null) return { status: "missing" };

    const envelope = parseEnvelope(text);
    if (envelope === null) return { status: "damaged", message: `${file} is not in the form Schema Studio writes.` };

    let raw: unknown;
    if (envelope.protection === "plain") {
      raw = envelope.values;
    } else {
      if (!this.keyringAvailable()) {
        return { status: "locked", message: `${file} is locked with a login keyring that did not open.` };
      }
      let json: string;
      try {
        json = safeStorage.decryptString(Buffer.from(envelope.data, "base64"));
      } catch (error) {
        logWarn(`The login keyring could not unlock ${what}.`, error);
        return { status: "locked", message: `The login keyring could not unlock ${file}.` };
      }
      try {
        raw = JSON.parse(json);
      } catch {
        return { status: "damaged", message: `${file} was unlocked, but what it holds is not readable.` };
      }
    }

    const values = this.options.parse(raw);
    if (values === null) return { status: "damaged", message: `${file} does not hold ${what} in a form Schema Studio can use.` };
    return {
      status: "values",
      values,
      protection: envelope.protection,
      upgrade: envelope.protection === "plain" && this.keyringAvailable(),
    };
  }

  /**
   * Saves the values, locked with the keyring when there is one, and says
   * which protection was used. Throws when the file cannot be written.
   */
  save(values: T): Protection {
    let envelope: ProtectedEnvelope = { version: 1, protection: "plain", values };
    if (this.keyringAvailable()) {
      try {
        const data = safeStorage.encryptString(JSON.stringify(values)).toString("base64");
        envelope = { version: 1, protection: "keyring", backend: keyringBackend(), data };
      } catch (error) {
        logWarn(`The login keyring could not lock ${this.options.what}, so it is kept in a file only you can read.`, error);
      }
    }
    writeFileAtomic(this.options.file, serializeEnvelope(envelope));
    return envelope.protection;
  }
}
