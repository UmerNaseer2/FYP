import { NextResponse } from "next/server";
import { groupRegistryFiles } from "@/lib/registry-paths";

const OWNER = process.env.GITHUB_REPO_OWNER;
const REPO = process.env.GITHUB_REPO_NAME;
const PAT = process.env.GITHUB_PAT;

type GitHubItem = {
  name: string;
  path: string;
  sha: string;
  type: "file" | "dir";
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
   * The rollback saved beside this version as v<version>.down.sql. Absent for a
   * version pushed before rollbacks existed, or pushed without one.
   */
  down_sql?: string;
};

export async function GET() {
  if (!OWNER || !REPO || !PAT) {
    return NextResponse.json(
      { error: "GitHub env vars not configured." },
      { status: 500 }
    );
  }

  const headers = {
    Authorization: `Bearer ${PAT}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  // List one directory's contents via the GitHub contents API. Any failure
  // (network error or non-OK status) yields an empty list so a single bad
  // folder just gets skipped rather than failing the whole pull. The repo
  // root is listed by passing an empty path.
  async function listDir(path: string): Promise<GitHubItem[]> {
    try {
      const res = await fetch(
        `https://api.github.com/repos/${OWNER}/${REPO}/contents/${path}`,
        { headers }
      );
      if (!res.ok) return [];
      const json = (await res.json()) as GitHubItem[] | unknown;
      return Array.isArray(json) ? (json as GitHubItem[]) : [];
    } catch {
      return [];
    }
  }

  const onlyDirs = (items: GitHubItem[]) => items.filter((item) => item.type === "dir");

  // List the root of the repo. An empty repository returns 404 here — the
  // explicit fetch lets us treat that as "no scripts yet" rather than an error,
  // so the registry just shows up empty.
  let rootRes: Response;
  try {
    rootRes = await fetch(
      `https://api.github.com/repos/${OWNER}/${REPO}/contents`,
      { headers }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json(
      { error: `Could not reach GitHub. Check your connection and try again. Details: ${message}` },
      { status: 502 }
    );
  }

  if (!rootRes.ok) {
    if (rootRes.status === 404) {
      return NextResponse.json({ scripts: [] });
    }
    const err = await rootRes.text();
    return NextResponse.json(
      { error: `GitHub API error: ${rootRes.status} — ${err}` },
      { status: 502 }
    );
  }

  const rootJson = (await rootRes.json()) as GitHubItem[] | unknown;
  const databaseDirs = onlyDirs(Array.isArray(rootJson) ? (rootJson as GitHubItem[]) : []);

  const scripts: GitHubScript[] = [];

  // Folder structure: <database_name>/<schema>/<script_name>/v<version>.sql
  // Level 1: root dirs     → database folders
  // Level 2: database dirs → schema folders
  // Level 3: schema dirs   → script-family folders
  // Level 4: script dirs   → .sql files
  await Promise.all(
    databaseDirs.map(async (databaseDir) => {
      const schemaDirs = onlyDirs(await listDir(databaseDir.path));

      await Promise.all(
        schemaDirs.map(async (schemaDir) => {
          const scriptDirs = onlyDirs(await listDir(schemaDir.path));

          await Promise.all(
            scriptDirs.map(async (scriptDir) => {
              const files = await listDir(scriptDir.path);

              // A version owns up to two files: v1.2.0.sql (the migration) and
              // v1.2.0.down.sql (its rollback). Group by version first, so the
              // rollback is attached to its migration instead of being listed as
              // a version called "1.2.0.down".
              const byVersion = groupRegistryFiles(
                files.filter((file) => file.type === "file"),
              );

              // Fetch raw content via download_url (server-side, uses GitHub's
              // pre-authenticated CDN URL — no extra PAT needed here).
              async function fetchText(url: string): Promise<string> {
                try {
                  const res = await fetch(url);
                  return res.ok ? await res.text() : "";
                } catch {
                  return "";
                }
              }

              await Promise.all(
                [...byVersion.entries()].map(async ([version, pair]) => {
                  // A rollback with no migration beside it is the orphan left by
                  // a push that failed after writing the down file. There is no
                  // version to attach it to, so it is not a registry entry.
                  if (!pair.up?.download_url) return;

                  const [sql_content, down_sql] = await Promise.all([
                    fetchText(pair.up.download_url),
                    pair.down?.download_url
                      ? fetchText(pair.down.download_url)
                      : Promise.resolve(""),
                  ]);

                  scripts.push({
                    database_name: databaseDir.name,
                    schema_name: schemaDir.name,
                    script_name: scriptDir.name,
                    version,
                    path: pair.up.path,
                    // NOTE: download_url is deliberately NOT returned. For a private
                    // registry repo, GitHub's download_url is a pre-authenticated
                    // raw URL that would let an (unauthenticated) client read the
                    // private file directly. The client already gets sql_content.
                    sql_content,
                    ...(down_sql ? { down_sql } : {}),
                  });
                })
              );
            })
          );
        })
      );
    })
  );

  return NextResponse.json({ scripts });
}
