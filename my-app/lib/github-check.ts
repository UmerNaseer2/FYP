// SERVER-ONLY: import this file from API routes and other server code only.
// It sends an access token to GitHub.
//
// Asks GitHub whether an access token opens a repository, before the app
// saves the pair. A typo in either would otherwise only show up later, as a
// failed push, in front of someone who cannot fix it.
//
// When the repository does not exist yet, the app makes it with the same
// token: a private repository, with a README so it has a first commit and a
// default branch to push to. GitHub answers 404, not 403, both for a
// repository that is missing and for one the token may not see, so the create
// is also how the two are told apart: GitHub refuses to make a repository
// whose name is already taken.
import { GITHUB_API, githubFetch, logGitHubAnswer, repoUrl, type GitHubConfig } from "./github-registry";
import { repositoryLabel } from "./github-settings";

/**
 * What GitHub said. `field` is the form field the problem belongs to, if any.
 * `created` is true when the repository did not exist and the app made it.
 */
export type RepositoryCheck =
  | { ok: true; created: boolean }
  | { ok: false; status: number; field: "repository" | "token" | null; error: string };

/** What the token needs to be allowed to make a repository, for the error messages. */
export const CREATE_PERMISSION_HINT =
  "To let the app make it, use a token with access to all repositories and Administration set to Read and write " +
  "(a fine-grained token), or the repo scope (a classic token). For a repository under an organization, the token " +
  "must belong to that organization, or the organization must allow its members to create repositories.";

/** The description the app gives a repository it makes. */
export const CREATED_REPOSITORY_DESCRIPTION = "Schema Studio script registry";

const UNREACHABLE: RepositoryCheck = {
  ok: false,
  status: 502,
  field: null,
  error: "The server could not reach GitHub to check the repository and token. Nothing was saved. Try again in a moment.",
};

/**
 * Ask GitHub whether `config.token` can open `config.owner/config.repo`, and
 * make the repository when it does not exist. Never throws.
 */
export async function checkRepositoryAccess(config: GitHubConfig): Promise<RepositoryCheck> {
  const res = await githubFetch(config, repoUrl(config));
  if (!res) return UNREACHABLE;
  if (res.ok) return { ok: true, created: false };

  await logGitHubAnswer("check repository", res);
  if (res.status === 404) return createRepository(config);
  return refused(res.status, "the server checked the repository");
}

/**
 * Make `config.owner/config.repo` with the token: under the token's own
 * account when the owner is that account, otherwise under the organization of
 * that name. Never throws. Exported for the push route, which reaches a
 * missing repository when the settings came from the server's environment and
 * were never checked by a save.
 */
export async function createRepository(config: GitHubConfig): Promise<RepositoryCheck> {
  const name = repositoryLabel(config);

  // Whose token is this? The answer decides which address makes the repository.
  const who = await githubFetch(config, `${GITHUB_API}/user`);
  if (!who) return UNREACHABLE;
  if (!who.ok) {
    await logGitHubAnswer("read the token's account", who);
    return refused(who.status, "the server checked the token");
  }
  let login = "";
  try {
    const body = (await who.json()) as { login?: unknown };
    if (typeof body.login === "string") login = body.login;
  } catch {
    login = "";
  }

  const mine = login !== "" && login.toLowerCase() === config.owner.toLowerCase();
  const url = mine ? `${GITHUB_API}/user/repos` : `${GITHUB_API}/orgs/${encodeURIComponent(config.owner)}/repos`;
  const made = await githubFetch(config, url, {
    method: "POST",
    body: { name: config.repo, private: true, auto_init: true, description: CREATED_REPOSITORY_DESCRIPTION },
  });
  if (!made) {
    // The request may have reached GitHub. Saying "nothing was saved" is still
    // true of the app's settings; the next save finds the repository if it was made.
    return {
      ok: false,
      status: 502,
      field: null,
      error:
        `The server lost touch with GitHub while making ${name}. Nothing was saved. Try again: if the ` +
        `repository was made, the next try finds it.`,
    };
  }
  if (made.status === 201) return { ok: true, created: true };

  await logGitHubAnswer("create repository", made);
  if (made.status === 422) {
    // The name is taken (or not a name GitHub allows): the repository exists
    // and this token can't see it, which is what the 404 meant after all.
    return {
      ok: false,
      status: 400,
      field: "repository",
      error:
        `GitHub has a repository ${name} that this token can't open, or does not allow that name. Check the ` +
        `name, and that the token was given access to that repository. Nothing was saved.`,
    };
  }
  if (made.status === 404 && !mine) {
    return {
      ok: false,
      status: 400,
      field: "repository",
      error:
        `GitHub found no repository ${name}, and the app could not make it: ${config.owner} is not this ` +
        `token's own account, nor an organization the token may create repositories in. Check the owner ` +
        `part of the name. Nothing was saved.`,
    };
  }
  if (made.status === 401) return refused(401, "the server tried to make the repository");
  if (made.status === 403 || made.status === 404) {
    return {
      ok: false,
      status: 400,
      field: "token",
      error:
        `GitHub found no repository ${name}, and this token is not allowed to make one. Make the repository ` +
        `on GitHub yourself, or use another token. ${CREATE_PERMISSION_HINT} Nothing was saved.`,
    };
  }
  return refused(made.status, "the server tried to make the repository");
}

/** The answer for a status that means the same thing whichever call got it. */
function refused(status: number, during: string): RepositoryCheck {
  if (status === 401) {
    return {
      ok: false,
      status: 400,
      field: "token",
      error: "GitHub did not accept that access token. It may be mistyped, expired or revoked. Nothing was saved.",
    };
  }
  if (status === 403 || status === 429) {
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
    error: `GitHub answered with an error (${status}) while ${during}. Nothing was saved. Try again in a moment.`,
  };
}
