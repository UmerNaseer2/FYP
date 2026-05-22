import { NextRequest, NextResponse } from "next/server";

const OWNER = process.env.GITHUB_REPO_OWNER;
const REPO = process.env.GITHUB_REPO_NAME;
const PAT = process.env.GITHUB_PAT;

type PushBody = {
  script_name: string;
  version: string;
  sql_content: string;
  description?: string;
};

type GitHubFileResponse = {
  sha: string;
};

export async function POST(req: NextRequest) {
  if (!OWNER || !REPO || !PAT) {
    return NextResponse.json(
      { error: "GitHub env vars not configured (GITHUB_REPO_OWNER, GITHUB_REPO_NAME, GITHUB_PAT)." },
      { status: 500 }
    );
  }

  let body: PushBody;
  try {
    body = (await req.json()) as PushBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const { script_name, version, sql_content, description } = body;

  if (!script_name || !version || !sql_content) {
    return NextResponse.json(
      { error: "script_name, version, and sql_content are required." },
      { status: 400 }
    );
  }

  const filePath = `${script_name}/v${version}.sql`;
  const apiUrl = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${filePath}`;
  const headers = {
    Authorization: `Bearer ${PAT}`,
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  // Check if the file already exists to get its SHA (required for updates)
  let existingSha: string | undefined;
  const checkRes = await fetch(apiUrl, { headers });
  if (checkRes.ok) {
    const existing = (await checkRes.json()) as GitHubFileResponse;
    existingSha = existing.sha;
  }

  const commitMessage = description
    ? `${script_name} v${version}: ${description}`
    : `${script_name} v${version}`;

  const putBody: Record<string, string> = {
    message: commitMessage,
    content: Buffer.from(sql_content).toString("base64"),
  };
  if (existingSha) putBody.sha = existingSha;

  const putRes = await fetch(apiUrl, {
    method: "PUT",
    headers,
    body: JSON.stringify(putBody),
  });

  if (!putRes.ok) {
    const err = await putRes.text();
    return NextResponse.json(
      { error: `GitHub API error: ${putRes.status} — ${err}` },
      { status: 502 }
    );
  }

  const result = (await putRes.json()) as { content: { html_url: string } };
  return NextResponse.json({ url: result.content.html_url });
}
