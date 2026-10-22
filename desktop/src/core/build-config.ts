/**
 * The two Microsoft Entra IDs a build of the app signs in with: which app
 * registration (the client ID) in which organization (the tenant ID).
 *
 * Neither is a secret: both are in the address of every Microsoft sign-in
 * page the app opens. They do belong to one app registration, though, so each
 * person building keeps their own in desktop/.env.desktop, which git ignores,
 * and GitHub Actions passes them in as repository variables.
 *
 * scripts/write-build-config.mjs uses this while building, to write
 * out/build-config.json, and the app reads that file back with
 * parseBuildConfig when it starts. A build without the IDs still installs and
 * runs; its sign-in screen says sign-in is not set up.
 *
 * Pure: reading the files is the callers' job.
 */

export type BuildConfig = {
  clientId: string | null;
  tenantId: string | null;
};

const NOT_SET: BuildConfig = { clientId: null, tenantId: null };

/** Entra shows both IDs as GUIDs, five groups of hexadecimal digits. */
const ENTRA_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isEntraId(value: unknown): value is string {
  return typeof value === "string" && ENTRA_ID.test(value);
}

/**
 * Reads a .env file: KEY=VALUE lines, with # comments, blank lines, an
 * optional "export " in front, and values optionally wrapped in quotes. It
 * only has to read two IDs, so it is not a full shell parser: no variables,
 * no escapes, no values spread over several lines.
 */
export function parseEnvFile(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.length >= 2 && value.endsWith(quote)) {
      value = value.slice(1, -1);
    } else {
      // Without quotes, a value ends where a comment starts.
      value = value.replace(/\s+#.*$/, "");
    }
    values[match[1]] = value;
  }
  return values;
}

/**
 * Works out a build's IDs. A value in the environment (as GitHub Actions sets
 * them) wins over the same one in .env.desktop, and an empty value counts as
 * not set. Anything else must look like an Entra ID: a typo is reported, so
 * it stops the build instead of producing an app whose sign-in can never
 * work. The IDs are kept in lower case, the way Microsoft writes them inside
 * the sign-in tokens the web app compares them with.
 */
export function buildConfigFrom(
  env: Record<string, string | undefined>,
  envFile: Record<string, string>,
): { config: BuildConfig; problems: string[] } {
  const problems: string[] = [];

  const read = (name: string): string | null => {
    const fromEnv = env[name]?.trim() ?? "";
    const value = fromEnv !== "" ? fromEnv : (envFile[name] ?? "").trim();
    if (value === "") return null;
    if (!isEntraId(value)) {
      problems.push(
        `${name} is not an Entra ID. Copy it again from the app registration's Overview page: it looks like 00000000-0000-0000-0000-000000000000.`,
      );
      return null;
    }
    return value.toLowerCase();
  };

  const clientId = read("AZURE_AD_CLIENT_ID");
  const tenantId = read("AZURE_AD_TENANT_ID");
  if (problems.length > 0) return { config: NOT_SET, problems };
  if ((clientId === null) !== (tenantId === null)) {
    return {
      config: NOT_SET,
      problems: ["Set both AZURE_AD_CLIENT_ID and AZURE_AD_TENANT_ID, or neither of them."],
    };
  }
  return { config: { clientId, tenantId }, problems };
}

/**
 * Reads out/build-config.json's contents when the app starts. The build wrote
 * it, but it is still checked: anything other than two Entra IDs together
 * means sign-in is not set up, never a crash or a sign-in that half works.
 */
export function parseBuildConfig(value: unknown): BuildConfig {
  if (typeof value !== "object" || value === null) return NOT_SET;
  const v = value as Record<string, unknown>;
  return isEntraId(v.clientId) && isEntraId(v.tenantId)
    ? { clientId: v.clientId.toLowerCase(), tenantId: v.tenantId.toLowerCase() }
    : NOT_SET;
}
