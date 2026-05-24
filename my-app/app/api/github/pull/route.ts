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
  const rootRes = await fetch(
    `https://api.github.com/repos/${OWNER}/${REPO}/contents`,
    { headers }
  );

  if (!rootRes.ok) {
    const err = await rootRes.text();
    return NextResponse.json(
      { error: `GitHub API error: ${rootRes.status} — ${err}` },
      { status: 502 }
    );
  }

  const rootItems = (await rootRes.json()) as GitHubItem[];
  const dirs = rootItems.filter((item) => item.type === "dir");

  const scripts: GitHubScript[] = [];

  // New folder structure: <schema>/<script_name>/v<version>.sql
  // Level 1: root dirs  → schema folders
  // Level 2: schema dirs → script-family folders
  // Level 3: script dirs → .sql files
  await Promise.all(
    dirs.map(async (schemaDir) => {
      // Fetch contents of the schema folder
      const schemaRes = await fetch(
        `https://api.github.com/repos/${OWNER}/${REPO}/contents/${schemaDir.path}`,
        { headers }
      );
      if (!schemaRes.ok) return;

      const schemaItems = (await schemaRes.json()) as GitHubItem[];
      const scriptDirs = schemaItems.filter((item) => item.type === "dir");

      // For each script-family dir inside the schema, collect .sql files
      await Promise.all(
        scriptDirs.map(async (scriptDir) => {
          const scriptRes = await fetch(
            `https://api.github.com/repos/${OWNER}/${REPO}/contents/${scriptDir.path}`,
            { headers }
          );
          if (!scriptRes.ok) return;

          const files = (await scriptRes.json()) as GitHubItem[];

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
