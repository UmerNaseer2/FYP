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
//
// WHERE THE FOLDERS SIT. Every organization shares one registry repository,
// and each keeps its scripts under its own root folder:
//
//   the default organization   <database>/<schema>/<script_name>/
//   any other organization     orgs/<id>/<database>/<schema>/<script_name>/
//
// The default organization stays at the top because that is where every
// script pushed before organizations existed already lives; moving them
// would break the history GitHub keeps for each file. The others use their
// numeric id, not their slug, because a slug can be renamed and a folder
// that moved with it would leave every earlier version behind.
//
// One consequence: the default organization must never change. If the flag
// moved to another organization, the new default would read the old one's
// scripts as its own. Nothing in the app moves it.

export type RegistryFile = {
  version: string;
  /** True for v<version>.down.sql — the rollback, not a version of its own. */
  isDown: boolean;
};

/** The folder under the repository root that holds every other organization's scripts. */
export const ORGANIZATIONS_FOLDER = "orgs";

/** Who a registry folder belongs to. A signed-in principal has both fields. */
export type RegistryOwner = { orgId: number; orgIsDefault: boolean };

/**
 * The folder an organization's scripts live under: "" (the repository root)
 * for the default organization, "orgs/<id>" for any other.
 */
export function registryRoot(owner: RegistryOwner): string {
  return owner.orgIsDefault ? "" : `${ORGANIZATIONS_FOLDER}/${owner.orgId}`;
}

/** The path of one family's folder, as GitHub lists it: [root/]database/schema/script. */
export function familyFolderPath(root: string, database: string, schema: string, scriptName: string): string {
  const path = `${database}/${schema}/${scriptName}`;
  return root ? `${root}/${path}` : path;
}

/**
 * True when a <database>/<schema> pair at the repository root is really the
 * start of another organization's folder: database "orgs" and a schema that
 * is all digits, as in orgs/12/.
 */
export function isOrganizationFolder(database: string, schema: string): boolean {
  return database === ORGANIZATIONS_FOLDER && /^[0-9]+$/.test(schema);
}

/**
 * Why a family path can't be used by this organization, or null when it can.
 *
 * Only the default organization can collide with another organization's
 * folder, because only its paths start at the repository root. A database
 * named "orgs" with a schema named "12" would write into organization 12's
 * folder, and its scripts would show up as that organization's. So that one
 * combination is refused. A database called "orgs" with any other schema is
 * fine. The message names only the fixed folder name, never the input.
 */
export function reservedFolderProblem(root: string, database: string, schema: string): string | null {
  if (root !== "" || !isOrganizationFolder(database, schema)) return null;
  return (
    `A database named "${ORGANIZATIONS_FOLDER}" with a schema whose name is only digits can't be ` +
    `kept in the registry: that folder holds other organizations' scripts. Rename the schema, ` +
    `for example by adding a letter, and try again.`
  );
}

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
