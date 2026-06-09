import { NextResponse } from "next/server";

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
  download_url: string;
  sql_content: string;
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

              // Fetch each .sql file's content concurrently
              await Promise.all(
                files.map(async (file) => {
                  if (file.type !== "file" || !file.name.endsWith(".sql")) return;
                  if (!file.download_url) return;

                  // Filename is like v1.2.0.sql — strip the leading "v" and ".sql"
                  const version = file.name.replace(/^v/i, "").replace(/\.sql$/i, "");

                  // Fetch raw SQL content via download_url (server-side, uses
                  // GitHub's pre-authenticated CDN URL — no extra PAT needed here)
                  let sql_content = "";
                  try {
                    const contentRes = await fetch(file.download_url);
                    if (contentRes.ok) {
                      sql_content = await contentRes.text();
                    }
                  } catch {
                    // Content fetch failed — include the entry with empty content
                    // rather than dropping it entirely so the list still shows up
                  }

                  scripts.push({
                    database_name: databaseDir.name,
                    schema_name: schemaDir.name,
                    script_name: scriptDir.name,
                    version,
                    path: file.path,
                    download_url: file.download_url,
                    sql_content,
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
