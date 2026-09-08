// Naming rules for the GitHub script registry, kept in one place so the push
// route (which writes the files) and the pull route (which reads them back)
// can never disagree about what a filename means.
//
// A registry folder is <database>/<schema>/<script_name>/ and one version owns
// up to two files inside it:
//
//   v1.2.0.sql        the migration
//   v1.2.0.down.sql   its rollback, optional
//
// Both belong to version "1.2.0". Parsing the down file with the migration's
// rule would read its version as "1.2.0.down" and list it as a release of its
// own, which is the bug this module exists to prevent.

export type RegistryFile = {
  version: string;
  /** True for v<version>.down.sql — the rollback, not a version of its own. */
  isDown: boolean;
};

/** The file name a migration is stored under. */
export function migrationFileName(version: string): string {
  return `v${version}.sql`;
}

/** The file name its rollback is stored under, beside it. */
export function rollbackFileName(version: string): string {
  return `v${version}.down.sql`;
}

/**
 * Read a registry file name. Returns null for anything that is not a .sql file,
 * so unrelated files in the folder (a README, say) are skipped rather than
 * turned into a phantom version.
 */
export function parseRegistryFileName(name: string): RegistryFile | null {
  if (!/\.sql$/i.test(name)) return null;
  const isDown = /\.down\.sql$/i.test(name);
  const version = name
    .replace(/^v/i, "")
    .replace(/\.down\.sql$/i, "")
    .replace(/\.sql$/i, "");
  if (!version) return null;
  return { version, isDown };
}

/**
 * Group one script folder's files by version, pairing each migration with its
 * rollback. A version with no migration file is still returned (as { down }) —
 * the caller decides what an orphan rollback means; the pull route drops it.
 */
export function groupRegistryFiles<T extends { name: string }>(
  files: T[],
): Map<string, { up?: T; down?: T }> {
  const byVersion = new Map<string, { up?: T; down?: T }>();
  for (const file of files) {
    const parsed = parseRegistryFileName(file.name);
    if (!parsed) continue;
    const entry = byVersion.get(parsed.version) ?? {};
    if (parsed.isDown) entry.down = file;
    else entry.up = file;
    byVersion.set(parsed.version, entry);
  }
  return byVersion;
}
