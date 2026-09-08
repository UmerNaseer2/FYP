import { NextRequest, NextResponse } from "next/server";
import { requireEditor } from "@/lib/auth-guard";
import { migrationFileName, rollbackFileName } from "@/lib/registry-paths";

const OWNER = process.env.GITHUB_REPO_OWNER;
const REPO = process.env.GITHUB_REPO_NAME;
const PAT = process.env.GITHUB_PAT;

type PushBody = {
  database_name: string;
  schema_name: string;
  script_name: string;
  version: string;
  sql_content: string;
  /**
   * The rollback (down) script for this version, saved beside it as
   * v<version>.down.sql. Optional: a caller that has no rollback just omits it
   * and only the migration file is written.
   */
  down_sql?: string;
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
  const gate = await requireEditor();
  if (!gate.ok) return gate.response;

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

  const { database_name, schema_name, script_name, version, sql_content, down_sql, description, overwrite } = body;

  if (!database_name || !schema_name || !script_name || !version || !sql_content) {
    return NextResponse.json(
      { error: "database_name, schema_name, script_name, version, and sql_content are required." },
      { status: 400 }
    );
  }

  // Path: <database_name>/<schema>/<script_name>/v<version>.sql
  // The rollback, when there is one, sits beside it as v<version>.down.sql.
  // Encode each segment so names with spaces or odd characters stay valid,
  // while keeping the slashes that define the folder structure.
  function contentsUrl(fileName: string): string {
    const filePath = [database_name, schema_name, script_name, fileName]
      .map((segment) => encodeURIComponent(segment))
      .join("/");
    return `https://api.github.com/repos/${OWNER}/${REPO}/contents/${filePath}`;
  }
  const apiUrl = contentsUrl(migrationFileName(version));
  const downUrl = contentsUrl(rollbackFileName(version));
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

  // PUT one file, reusing its SHA when it is already there. Returns the response
  // so the caller decides what a failure means for the push as a whole.
  async function putFile(url: string, content: string, message: string): Promise<Response> {
    let sha: string | undefined;
    try {
      const check = await fetch(url, { headers });
      if (check.ok) sha = ((await check.json()) as GitHubFileResponse).sha;
    } catch {
      // Lookup failed — treat it as a new file.
    }
    const putBody: Record<string, string> = {
      message,
      content: Buffer.from(content).toString("base64"),
    };
    if (sha) putBody.sha = sha;
    return fetch(url, { method: "PUT", headers, body: JSON.stringify(putBody) });
  }

  // The rollback goes first, on purpose. GitHub's contents API has no
  // transaction, so one of the two writes can fail on its own. Writing the
  // rollback first means a failure leaves only an orphan v<ver>.down.sql, which
  // the pull route ignores because no migration sits beside it — nobody sees a
  // half-published version. The reverse order would publish a migration that
  // silently cannot be rolled back.
  if (down_sql) {
    let downRes: Response;
    try {
      downRes = await putFile(downUrl, down_sql, `${commitMessage} (rollback)`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return NextResponse.json(
        { error: `Could not reach GitHub while saving the rollback. Nothing was published. Details: ${message}` },
        { status: 502 }
      );
    }
    if (!downRes.ok) {
      const err = await downRes.text();
      return NextResponse.json(
        { error: `GitHub API error saving the rollback: ${downRes.status} — ${err}. Nothing was published.` },
        { status: 502 }
      );
    }
  }

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
  return NextResponse.json({ url: htmlUrl, rollback_saved: Boolean(down_sql) });
}
