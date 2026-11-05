// ---------------------------------------------------------------------------
// github-settings.ts
// The rules for an organization's GitHub settings: the repository its scripts
// are kept in, and the access token the app uses for that repository.
//
// Pure, so the Admin screen, the new-organization form and the routes check a
// value the same way. The token is only checked for its shape here. Whether
// it works is asked of GitHub itself, by the routes that save it
// (lib/github-check.ts).
// ---------------------------------------------------------------------------

/** A repository on GitHub, as owner and name: "acme" and "schema-scripts". */
export type RepositoryName = { owner: string; repo: string };

// GitHub's own rules: an account name is 1 to 39 letters, digits and hyphens,
// and starts with a letter or digit. A repository name is up to 100 letters,
// digits, dots, hyphens and underscores.
const OWNER = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;

/** The shortest and longest token the app accepts. GitHub's are 40 to 93 characters today. */
export const TOKEN_MIN = 20;
export const TOKEN_MAX = 255;

export const REPOSITORY_PROBLEM =
  "Type the repository as owner/name, for example acme/schema-scripts, or paste its address from GitHub.";

/**
 * The repository as it was typed: "owner/name", or its address copied from
 * GitHub (https://github.com/owner/name, with or without ".git", or the
 * git@github.com:owner/name.git form). Null when it is none of those.
 */
export function parseRepository(input: string): RepositoryName | null {
  let text = input.trim();
  const address =
    /^(?:https?:\/\/)?(?:www\.)?github\.com\/(.+)$/i.exec(text) ?? /^git@github\.com:(.+)$/i.exec(text);
  if (address) text = address[1];
  text = text.replace(/\/+$/, "").replace(/\.git$/i, "");
  const parts = text.split("/");
  if (parts.length !== 2) return null;
  const [owner, repo] = parts;
  if (!OWNER.test(owner) || !REPO.test(repo) || repo === "." || repo === "..") return null;
  return { owner, repo };
}

/** "acme/schema-scripts": how the screens and the change log name a repository. */
export function repositoryLabel({ owner, repo }: RepositoryName): string {
  return `${owner}/${repo}`;
}

/**
 * What is wrong with a pasted token, or null when it looks like one. Pass it
 * already trimmed: a line break copied after the token is not a mistake.
 */
export function tokenProblem(token: string): string | null {
  if (token === "") return "Paste the access token.";
  if (/\s/.test(token)) {
    return "An access token has no spaces or line breaks in it. Copy it from GitHub again.";
  }
  if (token.length < TOKEN_MIN || token.length > TOKEN_MAX) {
    return "That does not look like a GitHub access token. A fine-grained token starts with github_pat_.";
  }
  return null;
}

/** A repository and token typed together, as on the new-organization form. */
export type GitHubPair =
  | { kind: "none" }
  | { kind: "ok"; settings: RepositoryName & { token: string } }
  | { kind: "problem"; field: "repository" | "token"; message: string };

export const TOKEN_WITHOUT_REPOSITORY =
  "Type the repository this token is for, or clear the token to connect GitHub later.";
export const REPOSITORY_WITHOUT_TOKEN =
  "Paste an access token for this repository, or clear the repository to connect GitHub later.";

/**
 * The repository and token from a form where both are optional but go
 * together, as typed: they are trimmed here. Both blank is "none", which
 * makes the organization without GitHub. A problem names the box it is about.
 */
export function readGitHubPair(repositoryTyped: string, tokenTyped: string): GitHubPair {
  const typed = repositoryTyped.trim();
  const token = tokenTyped.trim();
  if (typed === "" && token === "") return { kind: "none" };
  if (typed === "") return { kind: "problem", field: "repository", message: TOKEN_WITHOUT_REPOSITORY };
  if (token === "") return { kind: "problem", field: "token", message: REPOSITORY_WITHOUT_TOKEN };
  const repository = parseRepository(typed);
  if (!repository) return { kind: "problem", field: "repository", message: REPOSITORY_PROBLEM };
  const problem = tokenProblem(token);
  if (problem) return { kind: "problem", field: "token", message: problem };
  return { kind: "ok", settings: { ...repository, token } };
}

/**
 * What the Admin screen's GitHub tab is told (GET /api/admin/github). It
 * never holds the token, only whether one is saved.
 */
export type GitHubSettingsView = {
  /**
   * Where the organization's GitHub settings come from: its own, saved on
   * the Admin screen; the server's (GITHUB_REPO_OWNER, GITHUB_REPO_NAME and
   * GITHUB_PAT), which only the default organization falls back to; or none.
   */
  source: "organization" | "server" | "none";
  /** "owner/name" for the organization's own settings. The server's are not shown. */
  repository: string | null;
  /** The folder in the repository its scripts go in: "" for the top, or "orgs/12". */
  folder: string;
  /** True when the saved token was locked with another key and must be added again. */
  tokenUnreadable: boolean;
  updatedBy: string | null;
  updatedAt: string | null;
  /** True for the organization the server's own settings stand in for. */
  serverFallback: boolean;
  /** Null when the settings can be saved here, or why not. */
  cannotSave: string | null;
  /** Whether this person may change them (github:update). */
  canUpdate: boolean;
};
