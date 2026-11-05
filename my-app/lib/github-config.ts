// SERVER-ONLY: import this file from API routes and other server code only.
// It hands out GitHub access tokens.
//
// Which repository and token a request uses for the script registry.
//
//   - An organization with its own settings (the Admin screen's GitHub tab,
//     lib/org-github-store.ts) uses those.
//   - The default organization without any falls back to the server's own
//     GITHUB_REPO_OWNER, GITHUB_REPO_NAME and GITHUB_PAT, the way every
//     install worked before organizations had settings of their own.
//   - Any other organization without settings has no GitHub at all. It never
//     borrows the server's token: that would let anyone who makes an
//     organization write into the server owner's repository.
//   - The desktop app keeps a single organization, and its settings window
//     already passes the three keys to its server, so it reads those alone.
//
// Kept apart from lib/github-registry.ts on purpose: that module has no
// database in it, and the tests and tools that load it have none either.
import {
  GITHUB_UNCONFIGURED_CODE,
  githubConfig,
  githubNotConfiguredMessage,
  type GitHubConfig,
} from "./github-registry";
import { readOrgGitHub } from "./org-github-store";
import type { RegistryOwner } from "./registry-paths";

/** The code a screen gets when the settings could not be looked up at all. */
export const GITHUB_SETTINGS_UNAVAILABLE_CODE = "github_settings_unavailable";

/** Where the repository and token came from, or why there are none. */
export type GitHubLookup =
  | ({ ok: true; source: "organization" | "server" } & GitHubConfig)
  | { ok: false; status: number; code: string; message: string };

/** Said when an organization's saved token was locked with another key. */
export const UNREADABLE_TOKEN_MESSAGE =
  "This organization's GitHub access token can't be read on this server: the server's encryption " +
  "key has changed since it was saved. Nothing was read from or written to GitHub. An admin can add " +
  "the token again on the Admin screen, under GitHub.";

/** Said when an organization other than the default one has no settings. */
export const ORG_UNCONFIGURED_MESSAGE =
  "GitHub is not set up for this organization yet. Nothing was read from or written to GitHub. " +
  "An admin can add the repository and an access token on the Admin screen, under GitHub.";

/** The repository and token for this organization. Never throws. */
export async function githubConfigFor(owner: RegistryOwner): Promise<GitHubLookup> {
  if (process.env.SCHEMA_STUDIO_DESKTOP === "1") return fromServer();

  let saved;
  try {
    saved = await readOrgGitHub(owner.orgId);
  } catch (error) {
    console.error("[github] could not read the organization's GitHub settings", error);
    return {
      ok: false,
      status: 503,
      code: GITHUB_SETTINGS_UNAVAILABLE_CODE,
      message:
        "The server could not look up this organization's GitHub settings: its database may be " +
        "unreachable. Nothing was read from or written to GitHub. Try again in a moment.",
    };
  }

  if (saved) {
    if (saved.token === null) {
      return { ok: false, status: 500, code: GITHUB_UNCONFIGURED_CODE, message: UNREADABLE_TOKEN_MESSAGE };
    }
    return { ok: true, source: "organization", owner: saved.owner, repo: saved.repo, token: saved.token };
  }
  if (owner.orgIsDefault) return fromServer();
  return { ok: false, status: 500, code: GITHUB_UNCONFIGURED_CODE, message: ORG_UNCONFIGURED_MESSAGE };
}

/** The server's own three keys, or the message naming the missing ones. */
function fromServer(): GitHubLookup {
  const config = githubConfig();
  if (!config.ok) {
    return {
      ok: false,
      status: 500,
      code: GITHUB_UNCONFIGURED_CODE,
      message: githubNotConfiguredMessage(config.missing),
    };
  }
  return { ok: true, source: "server", owner: config.owner, repo: config.repo, token: config.token };
}
