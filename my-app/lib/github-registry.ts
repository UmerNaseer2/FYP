// SERVER-ONLY: import this file from API routes and other server code only.
// It reads GITHUB_PAT, and a token in a browser bundle is a leaked token. (The
// project has no `server-only` package, so this comment is the guard: nothing
// under app/(studio) or components/ may import it. The pure rules the screens
// need are in lib/registry-push.ts.)
//
// The GitHub reads the registry rules need: which files one script family
// already has in the registry repository.
//
// Everything here FAILS CLOSED. When GitHub can't be read, the answer is
// "unknown, and here is why", never "no versions": deciding that a family is
// empty because a request failed is exactly how a version below an existing
// one gets published. (The pull route fails open on purpose, because a page
// that lists scripts is still useful half-filled; a guard is not.)
import {
  describeGitHubFailure,
  familyVersions,
  githubErrorCode,
  type GitHubErrorCode,
  type RegistryEntry,
} from "./registry-push";

// Re-exported so server code can take the listing and its reading from one place.
export { familyVersions };

const GITHUB_API = "https://api.github.com";

// A GitHub call that hangs would leave the screen waiting forever with Push
// disabled; after this long it counts as "could not reach GitHub" instead.
export const GITHUB_TIMEOUT_MS = 15_000;

/** Where the registry lives and the token that reaches it. */
export type GitHubConfig = { owner: string; repo: string; token: string };

/**
 * The registry repository and token from GITHUB_REPO_OWNER, GITHUB_REPO_NAME
 * and GITHUB_PAT, or the NAMES of the keys that are missing.
 *
 * Read at call time, not when the module loads, so a changed setting (or a
 * test's fake value) is picked up. Values are never put in a message.
 */
export function githubConfig(): ({ ok: true } & GitHubConfig) | { ok: false; missing: string[] } {
  const owner = (process.env.GITHUB_REPO_OWNER ?? "").trim();
  const repo = (process.env.GITHUB_REPO_NAME ?? "").trim();
  const token = (process.env.GITHUB_PAT ?? "").trim();
  const missing: string[] = [];
  if (!owner) missing.push("GITHUB_REPO_OWNER");
  if (!repo) missing.push("GITHUB_REPO_NAME");
  if (!token) missing.push("GITHUB_PAT");
  if (missing.length > 0) return { ok: false, missing };
  return { ok: true, owner, repo, token };
}

/** The readable 500 message when the GitHub settings are missing. Names keys, never values. */
export function githubNotConfiguredMessage(missing: ReadonlyArray<string>): string {
  const which = missing.length > 0 ? ` Missing now: ${missing.join(", ")}.` : "";
  return (
    `GitHub is not set up on the server: GITHUB_REPO_OWNER, GITHUB_REPO_NAME and GITHUB_PAT must be set.${which} ` +
    `Nothing was read from or written to GitHub. Ask whoever runs the server to set them and restart it.`
  );
}

/** The headers every GitHub REST call sends. Pass withBody for a PUT or DELETE with a JSON body. */
export function githubHeaders(token: string, withBody = false): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (withBody) headers["Content-Type"] = "application/json";
  return headers;
}

/**
 * The response code every GitHub route answers with when the settings are
 * missing, so a screen can tell "not set up" from "GitHub failed" without
 * matching on the words of the message.
 */
export const GITHUB_UNCONFIGURED_CODE = "github_unconfigured";

/** The REST address of the registry repository itself. */
export function repoUrl(config: GitHubConfig): string {
  return `${GITHUB_API}/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}`;
}

/**
 * The Contents API address of any path in the registry, e.g. "db/public" as
 * GitHub itself lists it. An empty path is the repository root. Each segment
 * is encoded on its own, so the slashes still mean folders.
 */
export function contentsPathUrl(config: GitHubConfig, path: string): string {
  const encoded = path
    .split("/")
    .filter((segment) => segment !== "")
    .map(encodeURIComponent)
    .join("/");
  return encoded ? `${repoUrl(config)}/contents/${encoded}` : `${repoUrl(config)}/contents`;
}

/**
 * One GitHub call with the token, no caching and the timeout. Returns null
 * when GitHub gave no answer at all (a network error or the timeout).
 *
 * Every GitHub call in the registry routes goes through here, so each one
 * sends the same headers and none can be answered from a framework fetch
 * cache: a stale listing is exactly how a version below an existing one gets
 * pushed. For a PUT or DELETE, null means the outcome is UNKNOWN: the request
 * may have reached GitHub and been saved before the connection dropped.
 */
export async function githubFetch(
  config: GitHubConfig,
  url: string,
  request: { method?: "GET" | "PUT" | "DELETE"; body?: unknown } = {},
): Promise<Response | null> {
  const method = request.method ?? "GET";
  const withBody = request.body !== undefined;
  try {
    return await fetch(url, {
      method,
      headers: githubHeaders(config.token, withBody),
      body: withBody ? JSON.stringify(request.body) : undefined,
      cache: "no-store",
      signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
    });
  } catch {
    return null;
  }
}

/**
 * Read a file from a Contents API answer ({ content, encoding: "base64", sha }).
 * Returns null when the answer is not a readable file: GitHub sends files over
 * 1 MB with no content, and a folder answers with a list. Uses Buffer, which
 * is one more reason this module is server-only.
 */
export function decodeContentsFile(body: unknown): { text: string; sha: string } | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const file = body as { content?: unknown; encoding?: unknown; sha?: unknown };
  if (file.encoding !== "base64" || typeof file.content !== "string" || typeof file.sha !== "string") return null;
  // GitHub wraps the base64 at 60 characters; Buffer skips the line breaks.
  return { text: Buffer.from(file.content, "base64").toString("utf8"), sha: file.sha };
}

/**
 * Write a GitHub answer's body to the server log, and ONLY there: GitHub's
 * own words can be long, technical or echo request details, so no response
 * ever carries them. Headers are never logged, because the request's headers
 * hold the token.
 */
export async function logGitHubAnswer(step: string, res: Response): Promise<void> {
  let text = "";
  try {
    text = await res.text();
  } catch {
    text = "(no body)";
  }
  console.error(`[github] ${step}: GitHub answered ${res.status}`, text.slice(0, 500));
}

/**
 * The Contents API address of a family folder, <database>/<schema>/<script>.
 * Every segment is encoded on its own (as the push route always did), so a
 * space becomes %20 and can't change which folder is meant.
 */
export function familyFolderUrl(config: GitHubConfig, database: string, schema: string, scriptName: string): string {
  const path = [database, schema, scriptName].map(encodeURIComponent).join("/");
  return `${repoUrl(config)}/contents/${path}`;
}

/** The Contents API address of one file in a family folder, e.g. v1.2.0.sql. */
export function contentsFileUrl(
  config: GitHubConfig,
  database: string,
  schema: string,
  scriptName: string,
  fileName: string,
): string {
  return `${familyFolderUrl(config, database, schema, scriptName)}/${encodeURIComponent(fileName)}`;
}

/** A family folder's listing, or why it could not be read. `status` 0 means GitHub was not reached. */
export type FamilyListing =
  | { ok: true; files: RegistryEntry[] }
  | { ok: false; status: number; code: GitHubErrorCode | "github_unreachable" | "not_a_folder"; error: string };

function unreachable(action: string): FamilyListing {
  return {
    ok: false,
    status: 0,
    code: "github_unreachable",
    error: `The server could not reach GitHub to ${action}. Check that the server can reach api.github.com, then try again.`,
  };
}

function failed(status: number, action: string): FamilyListing {
  return { ok: false, status, code: githubErrorCode(status), error: describeGitHubFailure(status, action) };
}

function githubGet(config: GitHubConfig, url: string): Promise<Response | null> {
  return githubFetch(config, url);
}

/**
 * List the files in one family folder, <database>/<schema>/<script>/.
 *
 * A 404 on the folder is ambiguous: a new family has no folder yet, but GitHub
 * also answers 404 when the repository name is wrong or the token can't see
 * it. So a 404 is only "no files yet" after a second read confirms the
 * repository itself is visible; otherwise it is an error. Every other failure
 * is an error too, never an empty list.
 */
export async function listFamilyFiles(
  config: GitHubConfig,
  database: string,
  schema: string,
  scriptName: string,
): Promise<FamilyListing> {
  const action = `list the versions of "${scriptName}"`;
  const res = await githubGet(config, familyFolderUrl(config, database, schema, scriptName));
  if (!res) return unreachable(action);

  if (res.status === 404) {
    const repoRes = await githubGet(config, repoUrl(config));
    if (!repoRes) return unreachable(action);
    if (repoRes.ok) return { ok: true, files: [] };
    return failed(repoRes.status, action);
  }
  if (!res.ok) return failed(res.status, action);

  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  // The Contents API answers a FOLDER with an array. An object means the path
  // is a single file, which a family never is.
  if (!Array.isArray(body)) {
    return {
      ok: false,
      status: res.status,
      code: "not_a_folder",
      error: `In GitHub, ${database}/${schema}/${scriptName} is a file, not a folder of versions, so its versions can't be read. Ask whoever looks after the registry repository to move that file out of the way.`,
    };
  }

  const files: RegistryEntry[] = [];
  for (const item of body as Array<{ name?: unknown; sha?: unknown; type?: unknown } | null>) {
    if (!item || typeof item.name !== "string" || typeof item.sha !== "string") continue;
    files.push({ name: item.name, sha: item.sha, type: typeof item.type === "string" ? item.type : undefined });
  }
  return { ok: true, files };
}
