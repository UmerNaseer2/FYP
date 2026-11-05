// github-settings: how a repository and an access token are read from what
// someone typed or pasted (lib/github-settings.ts). The Admin screen, the
// new-organization form and the routes all check with these, so a value one
// of them accepts is one the others accept too.
import {
  parseRepository,
  readGitHubPair,
  REPOSITORY_PROBLEM,
  REPOSITORY_WITHOUT_TOKEN,
  repositoryLabel,
  TOKEN_MAX,
  TOKEN_MIN,
  TOKEN_WITHOUT_REPOSITORY,
  tokenProblem,
} from "@/lib/github-settings";

describe("parseRepository", () => {
  test.each([
    ["owner/name", "acme/schema-scripts"],
    ["owner/name with spaces around it", "  acme/schema-scripts \n"],
    ["the address from the browser", "https://github.com/acme/schema-scripts"],
    ["the address with a slash at the end", "https://github.com/acme/schema-scripts/"],
    ["the clone address", "https://github.com/acme/schema-scripts.git"],
    ["the address with www and no https", "www.github.com/acme/schema-scripts"],
    ["the address in capitals", "HTTPS://GitHub.com/acme/schema-scripts"],
    ["the SSH clone address", "git@github.com:acme/schema-scripts.git"],
  ])("reads %s", (_, typed) => {
    expect(parseRepository(typed)).toEqual({ owner: "acme", repo: "schema-scripts" });
  });

  test("keeps the dots, hyphens and underscores GitHub allows", () => {
    expect(parseRepository("Acme-1/v2.schema_scripts")).toEqual({ owner: "Acme-1", repo: "v2.schema_scripts" });
  });

  test.each([
    ["nothing", ""],
    ["a name with no owner", "schema-scripts"],
    ["an owner with no name", "acme/"],
    ["a name with no owner before the slash", "/schema-scripts"],
    ["a folder inside a repository", "https://github.com/acme/schema-scripts/tree/main"],
    ["another site's address", "https://gitlab.com/acme/schema-scripts"],
    ["an owner starting with a hyphen", "-acme/schema-scripts"],
    ["an owner over 39 characters", `${"a".repeat(40)}/schema-scripts`],
    ["a name over 100 characters", `acme/${"r".repeat(101)}`],
    ["a name with a space", "acme/schema scripts"],
    ["a name that is a dot", "acme/."],
    ["a name that is two dots", "acme/.."],
  ])("turns down %s", (_, typed) => {
    expect(parseRepository(typed)).toBeNull();
  });
});

describe("readGitHubPair", () => {
  const TOKEN = "github_pat_not_real_0001_abcdefghij";

  test("reads both, trimmed, with the repository as typed or pasted", () => {
    expect(readGitHubPair(" https://github.com/acme/schema-scripts ", ` ${TOKEN}\n`)).toEqual({
      kind: "ok",
      settings: { owner: "acme", repo: "schema-scripts", token: TOKEN },
    });
  });

  test("both blank is none, so the organization is made without GitHub", () => {
    expect(readGitHubPair("  ", "\n")).toEqual({ kind: "none" });
  });

  test.each([
    ["a repository with no token", "acme/schema-scripts", "", "token", REPOSITORY_WITHOUT_TOKEN],
    ["a token with no repository", "", TOKEN, "repository", TOKEN_WITHOUT_REPOSITORY],
    ["a repository that is not owner/name", "schema-scripts", TOKEN, "repository", REPOSITORY_PROBLEM],
    ["a token that is too short", "acme/schema-scripts", "github_pat_", "token", "That does not look like a GitHub access token. A fine-grained token starts with github_pat_."],
  ])("names the box to fix for %s", (_, repository, token, field, message) => {
    expect(readGitHubPair(repository, token)).toEqual({ kind: "problem", field, message });
  });
});

test("repositoryLabel names a repository as owner/name", () => {
  expect(repositoryLabel({ owner: "acme", repo: "schema-scripts" })).toBe("acme/schema-scripts");
});

describe("tokenProblem", () => {
  test.each([
    ["the shortest the app accepts", "t".repeat(TOKEN_MIN)],
    ["the longest the app accepts", "t".repeat(TOKEN_MAX)],
    ["a fine-grained token's shape", `github_pat_${"A1b2".repeat(20)}`],
    ["a classic token's shape", `ghp_${"A1b2".repeat(9)}`],
  ])("accepts %s", (_, token) => {
    expect(tokenProblem(token)).toBeNull();
  });

  test.each([
    ["nothing", "", /Paste the access token/],
    ["a space inside", "github_pat_abcdef ghijklmnopqrstu", /no spaces or line breaks/],
    ["a line break inside", "github_pat_abcdef\nghijklmnopqrstu", /no spaces or line breaks/],
    ["one character too short", "t".repeat(TOKEN_MIN - 1), /does not look like a GitHub access token/],
    ["one character too long", "t".repeat(TOKEN_MAX + 1), /does not look like a GitHub access token/],
  ])("turns down %s", (_, token, problem) => {
    expect(tokenProblem(token)).toMatch(problem);
  });
});
