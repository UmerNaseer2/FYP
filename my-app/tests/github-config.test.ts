// github-config: which repository and token a request uses for the script
// registry (lib/github-config.ts).
//
// The organization's saved settings are stood in for. What these tests hold
// the lookup to:
//
//   - An organization's own settings come first, the default one's included.
//   - Only the default organization falls back to the server's three keys.
//     Any other one without settings has no GitHub at all: it never borrows
//     the server's token.
//   - A saved token this server can't read, or a database that did not
//     answer, is an error, never a quiet fall back to the server's token.
//   - The desktop app reads the server's keys alone, and no database.
//   - No message holds a token or a value of the server's keys.

const mockReadOrgGitHub = jest.fn();
jest.mock("../lib/org-github-store", () => ({
  readOrgGitHub: (orgId: number) => mockReadOrgGitHub(orgId),
}));

import {
  githubConfigFor,
  GITHUB_SETTINGS_UNAVAILABLE_CODE,
  ORG_UNCONFIGURED_MESSAGE,
  UNREADABLE_TOKEN_MESSAGE,
} from "@/lib/github-config";
import { GITHUB_UNCONFIGURED_CODE } from "@/lib/github-registry";

const DEFAULT_ORG = { orgId: 1, orgIsDefault: true };
const OTHER_ORG = { orgId: 12, orgIsDefault: false };

// Made up for these tests. None of them is a real token.
const SERVER = { owner: "server-owner-test", repo: "server-repo-test", token: "server-token-not-real-0001" };
const SAVED = {
  owner: "acme",
  repo: "registry",
  token: "github_pat_saved_token_not_real_0002",
  updatedBy: "admin@test",
  updatedAt: new Date(0),
};

const ENV_KEYS = ["GITHUB_REPO_OWNER", "GITHUB_REPO_NAME", "GITHUB_PAT", "SCHEMA_STUDIO_DESKTOP"] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

beforeEach(() => {
  mockReadOrgGitHub.mockReset();
  delete process.env.SCHEMA_STUDIO_DESKTOP;
  process.env.GITHUB_REPO_OWNER = SERVER.owner;
  process.env.GITHUB_REPO_NAME = SERVER.repo;
  process.env.GITHUB_PAT = SERVER.token;
});

afterEach(() => {
  jest.restoreAllMocks();
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

/** A failed lookup's message, once it is clear it holds no token or value of the server's. */
function messageOf(lookup: Awaited<ReturnType<typeof githubConfigFor>>): string {
  if (lookup.ok) throw new Error("expected the lookup to fail");
  for (const secret of [SERVER.owner, SERVER.repo, SERVER.token, SAVED.token]) {
    expect(lookup.message).not.toContain(secret);
  }
  return lookup.message;
}

test.each([
  ["the default organization", DEFAULT_ORG],
  ["any other organization", OTHER_ORG],
])("%s uses its own saved settings first", async (_, owner) => {
  mockReadOrgGitHub.mockResolvedValue(SAVED);
  expect(await githubConfigFor(owner)).toEqual({
    ok: true,
    source: "organization",
    owner: "acme",
    repo: "registry",
    token: SAVED.token,
  });
  expect(mockReadOrgGitHub.mock.calls).toEqual([[owner.orgId]]);
});

test("the default organization with nothing saved falls back to the server's keys", async () => {
  mockReadOrgGitHub.mockResolvedValue(null);
  expect(await githubConfigFor(DEFAULT_ORG)).toEqual({ ok: true, source: "server", ...SERVER });
});

test("the default organization with nothing saved and a server key missing is told which key, by name", async () => {
  delete process.env.GITHUB_PAT;
  mockReadOrgGitHub.mockResolvedValue(null);
  const lookup = await githubConfigFor(DEFAULT_ORG);
  expect(lookup).toMatchObject({ ok: false, status: 500, code: GITHUB_UNCONFIGURED_CODE });
  expect(messageOf(lookup)).toMatch(/Admin screen, under GitHub.*Missing now: GITHUB_PAT\./);
});

test("any other organization with nothing saved never borrows the server's token", async () => {
  mockReadOrgGitHub.mockResolvedValue(null);
  const lookup = await githubConfigFor(OTHER_ORG);
  expect(lookup).toEqual({ ok: false, status: 500, code: GITHUB_UNCONFIGURED_CODE, message: ORG_UNCONFIGURED_MESSAGE });
  messageOf(lookup);
});

test.each([
  ["the default organization", DEFAULT_ORG],
  ["any other organization", OTHER_ORG],
])("%s with a saved token this server can't read is told so, and gets no other token", async (_, owner) => {
  mockReadOrgGitHub.mockResolvedValue({ ...SAVED, token: null });
  const lookup = await githubConfigFor(owner);
  expect(lookup).toEqual({ ok: false, status: 500, code: GITHUB_UNCONFIGURED_CODE, message: UNREADABLE_TOKEN_MESSAGE });
  messageOf(lookup);
});

test("a database that did not answer is a 503, never the server's token, with the reason kept to the log", async () => {
  const logged = jest.spyOn(console, "error").mockImplementation(() => {});
  mockReadOrgGitHub.mockRejectedValue(new Error("connection refused"));
  const lookup = await githubConfigFor(DEFAULT_ORG);
  expect(lookup).toMatchObject({ ok: false, status: 503, code: GITHUB_SETTINGS_UNAVAILABLE_CODE });
  expect(messageOf(lookup)).toMatch(/Nothing was read from or written to GitHub/);
  expect(logged).toHaveBeenCalled();
});

test("the desktop app reads the server's keys alone, and no database", async () => {
  process.env.SCHEMA_STUDIO_DESKTOP = "1";
  mockReadOrgGitHub.mockResolvedValue(SAVED);
  expect(await githubConfigFor(DEFAULT_ORG)).toEqual({ ok: true, source: "server", ...SERVER });
  expect(mockReadOrgGitHub).not.toHaveBeenCalled();
});

test("the desktop app without its keys points to its Settings window", async () => {
  process.env.SCHEMA_STUDIO_DESKTOP = "1";
  delete process.env.GITHUB_REPO_NAME;
  const lookup = await githubConfigFor(DEFAULT_ORG);
  expect(lookup).toMatchObject({ ok: false, status: 500, code: GITHUB_UNCONFIGURED_CODE });
  expect(messageOf(lookup)).toMatch(/Missing now: repository name\..*Open Settings from the File menu/);
  expect(mockReadOrgGitHub).not.toHaveBeenCalled();
});
