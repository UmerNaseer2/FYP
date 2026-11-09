/**
 * Local connections: databases only one machine can reach.
 *
 * When several copies of Schema Studio share one database (Vercel and the
 * Swinburne server both on Supabase), a connection to `localhost` or a private
 * address still belongs to one machine. Its row lives in the shared database so
 * everyone in the org sees it by name, but its password stays on the machine,
 * in that machine's own PostgreSQL (`LOCAL_DATABASE_URL`, see lib/local-store).
 *
 * The shared row's `password` column holds a marker instead of the secret:
 *
 *     local:v1:<key>:<machine name>
 *
 * The key finds the password in the machine's own store, and the name says
 * where the connection lives, so every copy can show "On Swinburne server"
 * without asking anyone. A marker is not a secret, so encryptSecret leaves it
 * readable and the SQL in lib/connection-writes can read the name out of it.
 *
 * This file holds no database code: lib/connection-config needs to resolve a
 * marker synchronously, so the machine's entries are loaded once into memory
 * (lib/local-store) and read from here.
 */

export const LOCAL_MARKER_PREFIX = "local:v1:";

/** Longest machine name kept, so a typo in the environment cannot fill a page. */
const MACHINE_NAME_MAX = 60;

/** A machine's secrets for one connection, encrypted the same way as the shared database's. */
export type LocalEntry = {
  password: string | null;
  connectionString: string | null;
};

type LocalCache = {
  /** True once the machine's store has been read at least once. */
  loaded: boolean;
  entries: Map<string, LocalEntry>;
};

// Next can load this module more than once (one copy per bundle), and the
// instrumentation hook loads the store before any route does. Keeping the
// cache on globalThis means every copy sees the same entries.
const holder = globalThis as typeof globalThis & { __schemaStudioLocalSecrets?: LocalCache };

function cache(): LocalCache {
  if (!holder.__schemaStudioLocalSecrets) {
    holder.__schemaStudioLocalSecrets = { loaded: false, entries: new Map() };
  }
  return holder.__schemaStudioLocalSecrets;
}

/** True when this copy keeps local passwords, which needs `LOCAL_DATABASE_URL`. */
export function localStoreConfigured(): boolean {
  return Boolean(process.env.LOCAL_DATABASE_URL?.trim());
}

/** Tidy a machine name: one line, no extra spaces, a sensible length. */
export function cleanMachineName(raw: string | null | undefined): string {
  return (raw ?? "").replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, MACHINE_NAME_MAX).trim();
}

/** What this machine is called on screen, from `LOCAL_MACHINE_NAME`. */
export function localMachineName(): string {
  return cleanMachineName(process.env.LOCAL_MACHINE_NAME) || "the server";
}

export function isLocalMarker(value: string | null | undefined): value is string {
  return typeof value === "string" && value.startsWith(LOCAL_MARKER_PREFIX);
}

export function makeLocalMarker(key: string, machine: string): string {
  if (!/^[A-Za-z0-9-]+$/.test(key)) throw new Error("A local connection key must be letters, digits and dashes.");
  return `${LOCAL_MARKER_PREFIX}${key}:${cleanMachineName(machine) || "the server"}`;
}

/** The key and machine name in a marker, or null when the value is not one. */
export function parseLocalMarker(value: string | null | undefined): { key: string; machine: string } | null {
  if (!isLocalMarker(value)) return null;
  const rest = value.slice(LOCAL_MARKER_PREFIX.length);
  const colon = rest.indexOf(":");
  if (colon <= 0) return null;
  return { key: rest.slice(0, colon), machine: rest.slice(colon + 1) || "another machine" };
}

/**
 * True when a value someone typed would read as a marker. Nobody may type one:
 * on the machine that holds the key it would dial another connection's
 * password to whatever host the typist chose.
 */
export function typedLocalMarker(...values: unknown[]): boolean {
  return values.some((value) => typeof value === "string" && value.trimStart().startsWith(LOCAL_MARKER_PREFIX));
}

export const TYPED_MARKER_MESSAGE = `A password or connection string can't start with "${LOCAL_MARKER_PREFIX}".`;

/** Stands in for the key when a marker leaves this database (see markerWithoutKey). */
const HIDDEN_KEY = "elsewhere";

/**
 * A marker as another computer may see it: where the connection lives, without
 * the key that finds its password. The key stays in the shared database.
 */
export function markerWithoutKey(value: string): string {
  const marker = parseLocalMarker(value);
  return `${LOCAL_MARKER_PREFIX}${HIDDEN_KEY}:${marker?.machine ?? "another machine"}`;
}

/** True when this machine holds the secrets for the connection with this key. */
export function holdsLocalSecret(key: string | null | undefined): boolean {
  return typeof key === "string" && cache().entries.has(key);
}

export function localSecretFor(key: string): LocalEntry | null {
  return cache().entries.get(key) ?? null;
}

export function rememberLocalSecret(key: string, entry: LocalEntry): void {
  cache().entries.set(key, { password: entry.password ?? null, connectionString: entry.connectionString ?? null });
}

export function forgetLocalSecret(key: string): void {
  cache().entries.delete(key);
}

/** Replace every entry at once, after reading the machine's store. */
export function replaceLocalSecrets(entries: Map<string, LocalEntry>): void {
  const current = cache();
  current.entries = new Map(entries);
  current.loaded = true;
}

export function localSecretsLoaded(): boolean {
  return cache().loaded;
}

/**
 * Thrown when a connection's password is kept on a machine this copy cannot
 * read from. Its message is written for the person looking at the screen.
 */
export class LivesElsewhereError extends Error {
  readonly machine: string;
  constructor(machine: string, message?: string) {
    super(message ?? `This database lives on ${machine}. Open Schema Studio there to use it.`);
    this.name = "LivesElsewhereError";
    this.machine = machine;
  }
}

/**
 * The secrets behind a stored password value.
 *
 * Returns null when the value is not a marker (an ordinary cloud connection),
 * the machine's entry when this machine holds it, and throws a
 * LivesElsewhereError otherwise.
 */
export function resolveLocalMarker(stored: string | null | undefined): LocalEntry | null {
  const marker = parseLocalMarker(stored);
  if (!marker) return null;
  const entry = localSecretFor(marker.key);
  if (entry) return entry;

  if (localStoreConfigured() && marker.machine === localMachineName()) {
    if (!localSecretsLoaded()) {
      throw new LivesElsewhereError(
        marker.machine,
        `The local password store on ${marker.machine} could not be read yet. Check LOCAL_DATABASE_URL and try again in a moment.`
      );
    }
    throw new LivesElsewhereError(
      marker.machine,
      `This connection's password is missing from ${marker.machine}. Edit the connection here and enter its password again.`
    );
  }
  throw new LivesElsewhereError(marker.machine);
}
