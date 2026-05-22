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
  script_name: string;
  version: string;
  path: string;
  download_url: string;
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

  // Walk each directory (script family) and collect .sql files
  await Promise.all(
    dirs.map(async (dir) => {
      const dirRes = await fetch(
        `https://api.github.com/repos/${OWNER}/${REPO}/contents/${dir.path}`,
        { headers }
      );
      if (!dirRes.ok) return;

      const files = (await dirRes.json()) as GitHubItem[];
      for (const file of files) {
        if (file.type !== "file" || !file.name.endsWith(".sql")) continue;
        // Filename is like v1.2.0.sql
        const version = file.name.replace(/^v/i, "").replace(/\.sql$/i, "");
        if (file.download_url) {
          scripts.push({
            script_name: dir.name,
            version,
            path: file.path,
            download_url: file.download_url,
          });
        }
      }
    })
  );

  return NextResponse.json({ scripts });
}
