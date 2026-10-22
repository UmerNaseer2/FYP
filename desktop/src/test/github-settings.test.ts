/**
 * Checking the GitHub part of Settings before it is saved
 * (src/core/github-settings.ts).
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  checkGithubSettings,
  isSavedRegistryValid,
  isSavedTokenValid,
  readGithubSettingsInput,
} from "../core/github-settings";
import type { GithubSettingsInput } from "../shared/ipc";

const KEEP = { action: "keep" } as const;

function check(owner: string, repo: string, token: GithubSettingsInput["token"] = KEEP) {
  return checkGithubSettings({ owner, repo, token });
}

function replace(value: string): GithubSettingsInput["token"] {
  return { action: "replace", value };
}

function refused(field: "owner" | "repo" | "token", message: string) {
  return { ok: false, field, message };
}

const OWNER_RULES =
  "An owner is the GitHub user or organization name: up to 39 letters, digits or hyphens, not starting with a hyphen.";
const REPO_RULES = "A repository name is up to 100 letters, digits, dots, hyphens or underscores.";

test("trims the names and keeps the saved token", () => {
  assert.deepEqual(check("  octocat ", " schema-registry "), {
    ok: true,
    change: { owner: "octocat", repo: "schema-registry", token: undefined },
  });
});

test("both names empty means no registry, which is allowed", () => {
  assert.deepEqual(check("", "  "), { ok: true, change: { owner: "", repo: "", token: undefined } });
});

test("asks for the other name when only one is filled in", () => {
  assert.deepEqual(check("", "schema-registry"), refused("owner", "Enter the owner as well as the repository name."));
  assert.deepEqual(check("octocat", ""), refused("repo", "Enter the repository name as well as the owner."));
});

test("explains what goes in the owner box when owner/repo or a link is pasted into it", () => {
  const message = "Enter only the owner here, for example octocat. The repository name goes in the next box.";
  assert.deepEqual(check("octocat/schema-registry", "schema-registry"), refused("owner", message));
  assert.deepEqual(check("https://github.com/octocat", "schema-registry"), refused("owner", message));
});

test("checks the owner against GitHub's rules", () => {
  for (const owner of ["-bad", "a".repeat(40), "oct_cat", "octo cat"]) {
    assert.deepEqual(check(owner, "schema-registry"), refused("owner", OWNER_RULES), owner);
  }
  assert.equal(check("a".repeat(39), "schema-registry").ok, true);
  assert.equal(check("my-org-2", "schema-registry").ok, true);
});

test("explains what goes in the repository box when owner/repo is pasted into it", () => {
  assert.deepEqual(
    check("octocat", "octocat/schema-registry"),
    refused("repo", "Enter only the repository name here, for example schema-registry, without the owner or a link."),
  );
});

test("asks for the repository name without .git on the end", () => {
  const message = "Leave out the .git at the end: enter only the repository name, for example schema-registry.";
  assert.deepEqual(check("octocat", "schema-registry.git"), refused("repo", message));
  assert.deepEqual(check("octocat", "schema-registry.GIT"), refused("repo", message));
});

test("checks the repository name against GitHub's rules", () => {
  for (const repo of [".", "..", "a".repeat(101), "my repo"]) {
    assert.deepEqual(check("octocat", repo), refused("repo", REPO_RULES), repo);
  }
  assert.equal(check("octocat", "a".repeat(100)).ok, true);
  assert.equal(check("octocat", "schema_registry.v2").ok, true);
});

test("checks the owner before the repository, and both before the token", () => {
  assert.deepEqual(check("-bad", "x.git", replace(" ")), refused("owner", OWNER_RULES));
  assert.equal(check("octocat", "x.git", replace(" ")).ok, false);
  assert.equal((check("octocat", "x.git", replace(" ")) as { field: string }).field, "repo");
});

test("saves a pasted token without the spaces around it", () => {
  const token = "ghp_" + "A".repeat(36);
  assert.deepEqual(check("octocat", "schema-registry", replace(`  ${token}\n`)), {
    ok: true,
    change: { owner: "octocat", repo: "schema-registry", token },
  });
});

test("explains a pasted token that cannot be right", () => {
  assert.deepEqual(
    check("", "", replace("   ")),
    refused("token", "Paste the access token, or choose to keep the saved one."),
  );
  assert.deepEqual(
    check("", "", replace("ab cd")),
    refused("token", "An access token has no spaces or line breaks in it. Copy it again from GitHub."),
  );
  assert.deepEqual(
    check("", "", replace("a".repeat(256))),
    refused("token", "That is longer than any GitHub access token. Copy it again from GitHub."),
  );
  assert.equal(check("", "", replace("a".repeat(255))).ok, true);
});

test("removing the token gives null, so the saved one is deleted", () => {
  assert.deepEqual(check("octocat", "schema-registry", { action: "remove" }), {
    ok: true,
    change: { owner: "octocat", repo: "schema-registry", token: null },
  });
});

test("a registry read back from config.json follows the same rules, without trimming", () => {
  assert.equal(isSavedRegistryValid("", ""), true);
  assert.equal(isSavedRegistryValid("octocat", "schema-registry"), true);
  assert.equal(isSavedRegistryValid("", "schema-registry"), false);
  assert.equal(isSavedRegistryValid("octocat", ""), false);
  assert.equal(isSavedRegistryValid(" octocat", "schema-registry"), false);
  assert.equal(isSavedRegistryValid(5, "schema-registry"), false);
  assert.equal(isSavedRegistryValid(undefined, undefined), false);
});

test("a token read back from secrets.json follows the same rules", () => {
  assert.equal(isSavedTokenValid("ghp_" + "A".repeat(36)), true);
  assert.equal(isSavedTokenValid(""), false);
  assert.equal(isSavedTokenValid("ab cd"), false);
  assert.equal(isSavedTokenValid("a".repeat(256)), false);
  assert.equal(isSavedTokenValid(5), false);
  assert.equal(isSavedTokenValid(null), false);
});

test("reads what the Settings page sends, and nothing more", () => {
  const token = "ghp_" + "A".repeat(36);
  assert.deepEqual(readGithubSettingsInput({ owner: "octocat", repo: "schema-registry", token: KEEP }), {
    owner: "octocat",
    repo: "schema-registry",
    token: KEEP,
  });
  // The names are passed on as typed: checkGithubSettings does the trimming.
  assert.deepEqual(readGithubSettingsInput({ owner: " octocat ", repo: "", token: { action: "remove" }, extra: 1 }), {
    owner: " octocat ",
    repo: "",
    token: { action: "remove" },
  });
  assert.deepEqual(
    readGithubSettingsInput({ owner: "", repo: "", token: { action: "replace", value: token, extra: true } }),
    { owner: "", repo: "", token: { action: "replace", value: token } },
  );
});

test("refuses anything not shaped like the Settings form", () => {
  const good = { owner: "octocat", repo: "schema-registry", token: KEEP };
  const shapes: unknown[] = [
    null,
    undefined,
    "octocat/schema-registry",
    5,
    [],
    [good],
    { ...good, owner: 5 },
    { ...good, repo: null },
    { owner: "octocat", token: KEEP },
    { ...good, token: "keep" },
    { ...good, token: null },
    { ...good, token: [KEEP] },
    { ...good, token: { action: "delete" } },
    { ...good, token: { action: "replace" } },
    { ...good, token: { action: "replace", value: 5 } },
    { ...good, owner: "a".repeat(10_001) },
    { ...good, token: { action: "replace", value: "a".repeat(10_001) } },
  ];
  shapes.forEach((shape, index) => assert.equal(readGithubSettingsInput(shape), null, `shape ${index}`));
  assert.notEqual(readGithubSettingsInput({ ...good, owner: "a".repeat(10_000) }), null);
});
