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

  // List the root of the repo
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
    // An empty repository returns 404 here — treat that as "no scripts yet"
    // rather than an error, so the registry just shows up empty.
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
  const rootItems = Array.isArray(rootJson) ? (rootJson as GitHubItem[]) : [];
  const dirs = rootItems.filter((item) => item.type === "dir");

  const scripts: GitHubScript[] = [];

  // New folder structure: <schema>/<script_name>/v<version>.sql
  // Level 1: root dirs  → schema folders
  // Level 2: schema dirs → script-family folders
  // Level 3: script dirs → .sql files
  await Promise.all(
    dirs.map(async (schemaDir) => {
      // Fetch contents of the schema folder. A failed dir read (network or a
      // non-OK status) just skips that folder rather than failing the whole pull.
      let schemaItems: GitHubItem[];
      try {
        const schemaRes = await fetch(
          `https://api.github.com/repos/${OWNER}/${REPO}/contents/${schemaDir.path}`,
          { headers }
        );
        if (!schemaRes.ok) return;
        const schemaJson = (await schemaRes.json()) as GitHubItem[] | unknown;
        schemaItems = Array.isArray(schemaJson) ? (schemaJson as GitHubItem[]) : [];
      } catch {
        return;
      }
      const scriptDirs = schemaItems.filter((item) => item.type === "dir");

      // For each script-family dir inside the schema, collect .sql files
      await Promise.all(
        scriptDirs.map(async (scriptDir) => {
          let files: GitHubItem[];
          try {
            const scriptRes = await fetch(
              `https://api.github.com/repos/${OWNER}/${REPO}/contents/${scriptDir.path}`,
              { headers }
            );
            if (!scriptRes.ok) return;
            const scriptJson = (await scriptRes.json()) as GitHubItem[] | unknown;
            files = Array.isArray(scriptJson) ? (scriptJson as GitHubItem[]) : [];
          } catch {
            return;
          }

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

  return NextResponse.json({ scripts });
}
