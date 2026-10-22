/**
 * Checks what someone typed into the GitHub part of Settings before any of it
 * is saved: the owner and name of the repository that holds the schema
 * registry, and the access token Schema Studio uses for it.
 *
 * The rules are GitHub's own, kept loose enough that a valid name is never
 * refused: an owner is 1 to 39 letters, digits or hyphens and does not start
 * with a hyphen; a repository name is 1 to 100 letters, digits, dots,
 * hyphens or underscores. Each message says how to fix the problem, because
 * the commonest mistakes (pasting "owner/repo" or a whole URL into one box)
 * are easy to explain.
 *
 * Pure: the Settings window's handler in the main process calls this, and
 * only saves what comes back as ok.
 */
import type { GithubSettingsInput } from "../shared/ipc";

const OWNER = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;
const TOKEN_MAX = 255;

export type GithubSettingsChange = {
  owner: string;
  repo: string;
  /** undefined: keep the saved token; null: remove it; a string: save it. */
  token: string | null | undefined;
};

export type GithubSettingsCheck =
  | { ok: true; change: GithubSettingsChange }
  | { ok: false; field: "owner" | "repo" | "token"; message: string };

function ownerProblem(owner: string): string | null {
  if (owner.includes("/")) {
    return "Enter only the owner here, for example octocat. The repository name goes in the next box.";
  }
  if (!OWNER.test(owner)) {
    return "An owner is the GitHub user or organization name: up to 39 letters, digits or hyphens, not starting with a hyphen.";
  }
  return null;
}

function repoProblem(repo: string): string | null {
  if (repo.includes("/")) {
    return "Enter only the repository name here, for example schema-registry, without the owner or a link.";
  }
  if (repo.toLowerCase().endsWith(".git")) {
    return "Leave out the .git at the end: enter only the repository name, for example schema-registry.";
  }
  if (!REPO.test(repo) || repo === "." || repo === "..") {
    return "A repository name is up to 100 letters, digits, dots, hyphens or underscores.";
  }
  return null;
}

function tokenProblem(token: string): string | null {
  if (token === "") return "Paste the access token, or choose to keep the saved one.";
  if (/\s/.test(token)) return "An access token has no spaces or line breaks in it. Copy it again from GitHub.";
  if (token.length > TOKEN_MAX) return "That is longer than any GitHub access token. Copy it again from GitHub.";
  return null;
}

export function checkGithubSettings(input: GithubSettingsInput): GithubSettingsCheck {
  const owner = input.owner.trim();
  const repo = input.repo.trim();

  // Both boxes empty means "no registry": allowed, and the token can stay.
  if (owner !== "" || repo !== "") {
    if (owner === "") return { ok: false, field: "owner", message: "Enter the owner as well as the repository name." };
    if (repo === "") return { ok: false, field: "repo", message: "Enter the repository name as well as the owner." };
    const ownerMessage = ownerProblem(owner);
    if (ownerMessage) return { ok: false, field: "owner", message: ownerMessage };
    const repoMessage = repoProblem(repo);
    if (repoMessage) return { ok: false, field: "repo", message: repoMessage };
  }

  let token: string | null | undefined;
  switch (input.token.action) {
    case "keep":
      token = undefined;
      break;
    case "remove":
      token = null;
      break;
    case "replace": {
      const value = input.token.value.trim();
      const tokenMessage = tokenProblem(value);
      if (tokenMessage) return { ok: false, field: "token", message: tokenMessage };
      token = value;
      break;
    }
  }

  return { ok: true, change: { owner, repo, token } };
}

/** The same rules, for a value read back from config.json. */
export function isSavedRegistryValid(owner: unknown, repo: unknown): boolean {
  if (owner === "" && repo === "") return true;
  return (
    typeof owner === "string" &&
    typeof repo === "string" &&
    ownerProblem(owner) === null &&
    repoProblem(repo) === null
  );
}

export function isSavedTokenValid(token: unknown): token is string {
  return typeof token === "string" && tokenProblem(token) === null;
}

/**
 * Far longer than any real owner, repository name or token. It only stops a
 * page from handing the main process an absurd amount of text to check.
 */
const MAX_INPUT_LENGTH = 10_000;

function isTextField(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_INPUT_LENGTH;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reads what the Settings window sent with Save. It arrives from a page, so
 * its shape is checked before anything else looks at it: two names as text,
 * and one of the three token choices. Anything else gives null. The answer
 * is a fresh object holding only those fields, so nothing extra the page
 * added travels any further. checkGithubSettings then checks the values.
 */
export function readGithubSettingsInput(value: unknown): GithubSettingsInput | null {
  if (!isRecord(value)) return null;
  const { owner, repo, token } = value;
  if (!isTextField(owner) || !isTextField(repo) || !isRecord(token)) return null;
  switch (token.action) {
    case "keep":
      return { owner, repo, token: { action: "keep" } };
    case "remove":
      return { owner, repo, token: { action: "remove" } };
    case "replace":
      return isTextField(token.value) ? { owner, repo, token: { action: "replace", value: token.value } } : null;
    default:
      return null;
  }
}
