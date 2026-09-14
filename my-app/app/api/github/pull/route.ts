// GET /api/github/pull: every script in the GitHub script registry, for
// Deploy and the Script Editor.
//
// Layout: <database>/<schema>/<script_name>/v<version>.sql at the repository
// root, each with an optional rollback beside it as v<version>.down.sql (the
// naming rules live in lib/registry-paths.ts).
//
// Unlike the push route, one unreadable folder or file does not stop the
// whole pull: the rest of the registry is still worth showing. But nothing is
// dropped silently any more. Every folder or file that could not be read is
// named in `warnings`, so the screens can say "some of the registry could not
// be read" instead of showing a registry with scripts quietly missing. When
// the registry as a whole can't be read (a bad token, a wrong repository
// name, GitHub down) the answer is a readable 502, never an empty list.
//
// Each version says how its rollback reads (rollback_state), and down_sql is
// sent ONLY when the rollback is usable. A rollback that runs nothing, or one
// that opens or closes its own transaction, is labelled instead of offered,
// so Deploy never offers a rollback it would refuse to run.
//
// Responses:
//   200 { ok: true, scripts: GitHubScript[], warnings: string[] }
//   500 { ok: false, code: "github_unconfigured", error }
//   502 { ok: false, code, error }  code: github_unreachable | token_rejected |
//       github_forbidden | github_rate_limited | repo_not_found | github_down | github_error
import { NextResponse } from "next/server";
import { requireViewer } from "@/lib/auth-guard";
import {
  contentsPathUrl,
  GITHUB_TIMEOUT_MS,
  GITHUB_UNCONFIGURED_CODE,
  githubConfig,
  githubFetch,
  githubNotConfiguredMessage,
  logGitHubAnswer,
  repoUrl,
  type GitHubConfig,
} from "@/lib/github-registry";
import { groupRegistryFiles } from "@/lib/registry-paths";
import {
  describeGitHubFailure,
  githubErrorCode,
  pulledRollbackState,
  type PulledRollbackState,
} from "@/lib/registry-push";
import { compareVersions } from "@/lib/script-status";

// One entry of a contents API folder listing (only the fields used here).
type GitHubItem = {
  name: string;
  path: string;
  type: string; // "dir", "file", "symlink" or "submodule"
  download_url: string | null;
};

export type GitHubScript = {
  database_name: string;
  schema_name: string;
  script_name: string;
  version: string;
  path: string;
  sql_content: string;
  /**
   * The rollback saved beside this version as v<version>.down.sql. Present
   * ONLY when rollback_state is "usable".
   */
  down_sql?: string;
  /**
   * How the rollback reads: "none" (no file), "usable", "no_statements"
   * (blank or comments only), "transaction_control" (it has COMMIT, ROLLBACK
   * or similar, which the revert refuses) or "unreadable" (the file is there
   * but could not be downloaded). Only "usable" can be run from Deploy.
   */
  rollback_state: PulledRollbackState;
};

// Finishes describeGitHubFailure's "while trying to ..." sentence.
const READ_REGISTRY = "read the script registry";

const UNREACHABLE =
  "The server could not reach GitHub, so the script registry could not be read. Check that the server can reach api.github.com, then try again.";

function fail(status: number, code: string, error: string): NextResponse {
  return NextResponse.json({ ok: false, code, error }, { status });
}

// A folder listing is an array of entries. Anything else (one file's JSON,
// an error body) is not a folder.
function asFolder(body: unknown): GitHubItem[] | null {
  if (!Array.isArray(body)) return null;
  return body.filter(
    (item): item is GitHubItem =>
      !!item && typeof item.name === "string" && typeof item.path === "string" && typeof item.type === "string",
  );
}

const onlyFolders = (items: GitHubItem[]) => items.filter((item) => item.type === "dir");

/**
 * One folder's entries, or null when it could not be read. A failure is
 * added to `warnings` and only this folder is skipped, so one unreadable
 * folder never hides the rest of the registry.
 */
async function listFolder(config: GitHubConfig, path: string, warnings: string[]): Promise<GitHubItem[] | null> {
  const res = await githubFetch(config, contentsPathUrl(config, path));
  if (!res) {
    warnings.push(
      `Could not read the folder "${path}" from GitHub, so the scripts inside it are missing from this list. The server could not reach GitHub; reload to try again.`,
    );
    return null;
  }
  if (!res.ok) {
    await logGitHubAnswer(`read folder ${path}`, res);
    warnings.push(
      `Could not read the folder "${path}" from GitHub, so the scripts inside it are missing from this list. ${describeGitHubFailure(res.status, `read the folder "${path}"`)}`,
    );
    return null;
  }
  const items = asFolder(await res.json().catch(() => null));
  if (!items) {
    warnings.push(`"${path}" in the registry could not be read as a folder, so the scripts inside it are missing from this list.`);
    return null;
  }
  return items;
}

/**
 * A file's text, or null when it could not be downloaded. download_url is
 * GitHub's raw file address (for a private repository it carries its own
 * short-lived access), so the server's token is not sent to it, and the
 * address itself is never returned to the browser or logged.
 */
async function download(item: GitHubItem): Promise<string | null> {
  if (!item.download_url) return null;
  try {
    const res = await fetch(item.download_url, { cache: "no-store", signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS) });
    if (!res.ok) {
      await logGitHubAnswer(`download ${item.path}`, res);
      return null;
    }
    return await res.text();
  } catch {
    return null;
  }
}

/**
 * The warning for a rollback file with no migration of its own spelling
 * beside it. The file is ignored either way (files pair by exact name, so
 * v1.0.0.down.sql is never read as the rollback of v1.0.sql), but the advice
 * differs, because the push refuses a version the family already has or is
 * past (checkPushVersion):
 *   - the same version is there under another spelling: saving it again is
 *     refused, so say how that version can get a rollback instead;
 *   - a higher version is published: saving it again is refused as lower than
 *     the newest, so the only way to clear the warning is to delete the file;
 *   - otherwise saving that version removes the file first (push step 2).
 */
function leftoverRollbackWarning(
  path: string,
  version: string,
  byVersion: Map<string, { up?: GitHubItem; down?: GitHubItem }>,
): string {
  const published: { version: string; up: GitHubItem; down?: GitHubItem }[] = [];
  for (const [other, pair] of byVersion) {
    if (pair.up) published.push({ version: other, up: pair.up, down: pair.down });
  }

  const twin = published.find((other) => compareVersions(other.version, version) === 0);
  if (twin) {
    const ignored =
      `${path} is ignored: its name does not match ${twin.up.name}, so it is not read as the rollback of v${twin.version}.`;
    return twin.down
      ? `${ignored} v${twin.version} already has its rollback in ${twin.down.name}, so this extra file can be deleted on GitHub.`
      : `${ignored} v${twin.version} has no rollback yet; add one with "Add a missing rollback" in the Script Editor.`;
  }

  const leftover = `${path} has no migration beside it (left by an earlier failed save) and is ignored.`;
  const newest = published.reduce<string | null>(
    (high, other) => (high === null || compareVersions(other.version, high) > 0 ? other.version : high),
    null,
  );
  if (newest !== null && compareVersions(newest, version) > 0) {
    return `${leftover} v${version} can't be saved again, because v${newest} is already published and a new version must be higher. Delete this file on GitHub to clear this warning.`;
  }
  return `${leftover} Saving v${version} again removes it.`;
}

/** Every version in one family folder, with its rollback classified. */
async function readFamily(
  config: GitHubConfig,
  database: string,
  schema: string,
  family: GitHubItem,
  warnings: string[],
): Promise<GitHubScript[]> {
  const files = await listFolder(config, family.path, warnings);
  if (!files) return [];

  // A version owns up to two files: v1.2.0.sql (the migration) and
  // v1.2.0.down.sql (its rollback). Group by version first, so the rollback
  // is paired with its migration instead of listed as a version of its own.
  const byVersion = groupRegistryFiles(files.filter((file) => file.type === "file"));
  const found: GitHubScript[] = [];

  await Promise.all(
    [...byVersion.entries()].map(async ([version, { up, down }]) => {
      // A rollback with no migration of the same spelling beside it belongs
      // to no version, so it is not listed; the warning says so, and what (if
      // anything) removes it.
      if (!up) {
        if (down) warnings.push(leftoverRollbackWarning(down.path, version, byVersion));
        return;
      }

      const [sql, downText] = await Promise.all([download(up), down ? download(down) : Promise.resolve(null)]);

      // Without its migration text a version can't be run or reviewed, so it
      // is left out rather than listed with an empty script.
      if (sql === null) {
        warnings.push(`Could not download ${up.path}, so v${version} is left out of this list. Reload to try again.`);
        return;
      }

      const downUnreadable = down !== undefined && downText === null;
      if (down && downUnreadable) {
        warnings.push(
          `Could not download ${down.path}, so the rollback of v${version} is marked unreadable and can't be run from Deploy. Reload to try again.`,
        );
      }
      const rollbackState = pulledRollbackState(downText, downUnreadable);

      found.push({
        database_name: database,
        schema_name: schema,
        script_name: family.name,
        version,
        path: up.path,
        // NOTE: download_url is deliberately NOT returned. For a private
        // registry repository it is a pre-authenticated address that would let
        // anyone holding it read the file. The client already gets the text.
        sql_content: sql,
        ...(rollbackState === "usable" && downText !== null ? { down_sql: downText } : {}),
        rollback_state: rollbackState,
      });
    }),
  );
  return found;
}

// Family by family, lowest version first, so the list reads the same on
// every pull even though the folders are read in parallel.
function byFamilyThenVersion(a: GitHubScript, b: GitHubScript): number {
  return (
    a.database_name.localeCompare(b.database_name) ||
    a.schema_name.localeCompare(b.schema_name) ||
    a.script_name.localeCompare(b.script_name) ||
    compareVersions(a.version, b.version)
  );
}

export async function GET() {
  const gate = await requireViewer();
  if (!gate.ok) return gate.response;

  // The GitHub settings, read now rather than when the module loads. The
  // message names missing keys, never values.
  const config = githubConfig();
  if (!config.ok) {
    return fail(500, GITHUB_UNCONFIGURED_CODE, githubNotConfiguredMessage(config.missing));
  }

  // 1. The repository root: one folder per database.
  const rootRes = await githubFetch(config, contentsPathUrl(config, ""));
  if (!rootRes) return fail(502, "github_unreachable", UNREACHABLE);
  if (rootRes.status === 404) {
    // GitHub answers 404 both for an EMPTY repository (nothing saved yet) and
    // for one the token can't see. Asking for the repository itself tells the
    // two apart, so a wrong name or token is reported, not shown as empty.
    const repoRes = await githubFetch(config, repoUrl(config));
    if (!repoRes) return fail(502, "github_unreachable", UNREACHABLE);
    if (repoRes.ok) return NextResponse.json({ ok: true, scripts: [], warnings: [] });
    await logGitHubAnswer("read the registry repository", repoRes);
    return fail(502, githubErrorCode(repoRes.status), describeGitHubFailure(repoRes.status, READ_REGISTRY));
  }
  if (!rootRes.ok) {
    await logGitHubAnswer("read the registry root", rootRes);
    return fail(502, githubErrorCode(rootRes.status), describeGitHubFailure(rootRes.status, READ_REGISTRY));
  }
  const rootItems = asFolder(await rootRes.json().catch(() => null));
  if (!rootItems) {
    return fail(
      502,
      "github_error",
      "GitHub's answer for the top of the registry repository was not a list of folders, so the registry could not be read. Try again; if it keeps happening, ask whoever runs the server to check GITHUB_REPO_OWNER and GITHUB_REPO_NAME.",
    );
  }

  // 2. Walk database -> schema -> family folders. Files at the upper levels
  //    (a README, say) are not scripts and are skipped.
  const warnings: string[] = [];
  const perDatabase = await Promise.all(
    onlyFolders(rootItems).map(async (databaseDir) => {
      const schemaDirs = await listFolder(config, databaseDir.path, warnings);
      if (!schemaDirs) return [];
      const perSchema = await Promise.all(
        onlyFolders(schemaDirs).map(async (schemaDir) => {
          const familyDirs = await listFolder(config, schemaDir.path, warnings);
          if (!familyDirs) return [];
          const perFamily = await Promise.all(
            onlyFolders(familyDirs).map((familyDir) =>
              readFamily(config, databaseDir.name, schemaDir.name, familyDir, warnings),
            ),
          );
          return perFamily.flat();
        }),
      );
      return perSchema.flat();
    }),
  );

  const scripts = perDatabase.flat().sort(byFamilyThenVersion);
  warnings.sort();
  return NextResponse.json({ ok: true, scripts, warnings });
}
