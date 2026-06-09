import { NextRequest, NextResponse } from "next/server";

const OWNER = process.env.GITHUB_REPO_OWNER;
const REPO = process.env.GITHUB_REPO_NAME;
const PAT = process.env.GITHUB_PAT;

type PushBody = {
  database_name: string;
  schema_name: string;
  script_name: string;
  version: string;
  sql_content: string;
  description?: string;
  /**
   * Replace an existing file at this version. Defaults to false: a published
   * version is immutable, so a duplicate is rejected (409) rather than silently
   * overwritten. The version floor is enforced client-side; this is the
   * server-side backstop so a stale floor, a second tab/user, or a replayed
   * request can never clobber a committed migration.
   */
  overwrite?: boolean;
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

  const { database_name, schema_name, script_name, version, sql_content, description, overwrite } = body;

  if (!database_name || !schema_name || !script_name || !version || !sql_content) {
    return NextResponse.json(
      { error: "database_name, schema_name, script_name, version, and sql_content are required." },
      { status: 400 }
    );
  }

  // Path: <database_name>/<schema>/<script_name>/v<version>.sql
  // Encode each segment so names with spaces or odd characters stay valid,
  // while keeping the slashes that define the folder structure.
  const filePath = [database_name, schema_name, script_name, `v${version}.sql`]
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  const apiUrl = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${filePath}`;
  const headers = {
    Authorization: `Bearer ${PAT}`,
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  // Check if the file already exists to get its SHA (required for updates).
  // A missing file or a transient lookup failure both just mean "no SHA" — we
  // then create the file fresh, so neither should abort the push.
  let existingSha: string | undefined;
  try {
    const checkRes = await fetch(apiUrl, { headers });
    if (checkRes.ok) {
      const existing = (await checkRes.json()) as GitHubFileResponse;
      existingSha = existing.sha;
    }
  } catch {
    // Network hiccup during the existence check — proceed as a new file.
  }

  // A file already exists at this version. Versions are immutable, so refuse to
  // overwrite a committed migration unless an explicit overwrite was requested.
  // This is the authoritative guard: the client-side version floor can go stale
  // (a second tab, another user, or a failed registry pull), so the server must
  // be the one that never silently clobbers history.
  if (existingSha && !overwrite) {
    return NextResponse.json(
      {
        error:
          `v${version} already exists for "${script_name}" in ${database_name}/${schema_name}. ` +
          `Versions are immutable — pick a higher version.`,
      },
      { status: 409 }
    );
  }

  const commitMessage = description
    ? `${script_name} v${version}: ${description}`
    : `${script_name} v${version}`;

  const putBody: Record<string, string> = {
    message: commitMessage,
    content: Buffer.from(sql_content).toString("base64"),
  };
  if (existingSha) putBody.sha = existingSha;

  let putRes: Response;
  try {
    putRes = await fetch(apiUrl, {
      method: "PUT",
      headers,
      body: JSON.stringify(putBody),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json(
      { error: `Could not reach GitHub. Check your connection and try again. Details: ${message}` },
      { status: 502 }
    );
  }

  if (!putRes.ok) {
    const err = await putRes.text();
    return NextResponse.json(
      { error: `GitHub API error: ${putRes.status} — ${err}` },
      { status: 502 }
    );
  }

  // The push itself succeeded; only the URL in the response is best-effort.
  let htmlUrl: string | null = null;
  try {
    const result = (await putRes.json()) as { content?: { html_url?: string } };
    htmlUrl = result.content?.html_url ?? null;
  } catch {
    // Body wasn't the JSON we expected — the file is still saved, so report ok.
  }
  return NextResponse.json({ url: htmlUrl });
}
