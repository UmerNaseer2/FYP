// SERVER-ONLY: import this file from API routes and other server code only.
// It sends an access token to GitHub.
//
// Asks GitHub whether an access token opens a repository, before the app
// saves the pair. A typo in either would otherwise only show up later, as a
// failed push, in front of someone who cannot fix it.
//
// GitHub answers 404, not 403, for a repository a token may not see, so a
// missing repository and a token without access to it look the same from
// here. The message says both.
import { githubFetch, logGitHubAnswer, repoUrl, type GitHubConfig } from "./github-registry";
import { repositoryLabel } from "./github-settings";

/** What GitHub said. `field` is the form field the problem belongs to, if any. */
export type RepositoryCheck =
  | { ok: true }
  | { ok: false; status: number; field: "repository" | "token" | null; error: string };

/** Ask GitHub whether `config.token` can open `config.owner/config.repo`. Never throws. */
export async function checkRepositoryAccess(config: GitHubConfig): Promise<RepositoryCheck> {
  const name = repositoryLabel(config);
  const res = await githubFetch(config, repoUrl(config));
  if (!res) {
    return {
      ok: false,
      status: 502,
      field: null,
      error: "The server could not reach GitHub to check the repository and token. Nothing was saved. Try again in a moment.",
    };
  }
  if (res.ok) return { ok: true };

  await logGitHubAnswer("check repository", res);
  if (res.status === 401) {
    return {
      ok: false,
      status: 400,
      field: "token",
      error: "GitHub did not accept that access token. It may be mistyped, expired or revoked. Nothing was saved.",
    };
  }
  if (res.status === 404) {
    return {
      ok: false,
      status: 400,
      field: "repository",
      error:
        `GitHub found no repository ${name} that this token can open. Check the name, and that the ` +
        `token was given access to that repository. Nothing was saved.`,
    };
  }
  if (res.status === 403 || res.status === 429) {
    return {
      ok: false,
      status: 400,
      field: "token",
      error:
        "GitHub refused the request. The token may need approval from the repository's organization, " +
        "or GitHub is limiting requests right now. Nothing was saved. Try again in a few minutes.",
    };
  }
  return {
    ok: false,
    status: 502,
    field: null,
    error: `GitHub answered with an error (${res.status}) while the server checked the repository. Nothing was saved. Try again in a moment.`,
  };
}
