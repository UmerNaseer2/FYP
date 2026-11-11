// registry-archive, organization folders: after a run commits, the versions it
// applied are recorded in the GitHub registry, and they must land in the
// folder of the organization the run belongs to. The default organization
// keeps the repository root; any other organization writes under orgs/<id>/.
//
// Nothing here reaches GitHub. The GitHub settings are fake, and fetch is a
// stub that answers only the addresses a test names, so a write into the
// wrong organization's folder fails the test.
import { archiveAppliedVersions, type AppliedVersion } from "@/lib/registry-archive";

// Each organization's own GitHub settings (lib/org-github-store.ts) are kept
// in the metadata database, which these tests do not have. Organization 12 has
// the server's repository with a token of its own; no other organization has
// settings, so the default one uses the server's keys.
const ORG_TOKEN = "org-token-not-real";
const mockReadOrgGitHub = jest.fn(
  async (orgId: number): Promise<unknown> =>
    orgId === 12
      ? { owner: "acme", repo: "registry", token: ORG_TOKEN, updatedBy: "admin@test", updatedAt: new Date(0) }
      : null,
);
jest.mock("../lib/org-github-store", () => ({
  readOrgGitHub: (orgId: number) => mockReadOrgGitHub(orgId),
}));

const ORG_12 = { orgId: 12, orgIsDefault: false };
const DEFAULT_ORG = { orgId: 1, orgIsDefault: true };

const REPO = "https://api.github.com/repos/acme/registry";
const ENV_KEYS = ["GITHUB_PAT", "GITHUB_REPO_OWNER", "GITHUB_REPO_NAME"] as const;
let savedEnv: Record<string, string | undefined> = {};
const realFetch = global.fetch;

type Call = { method: string; url: string; token: string | null };
let calls: Call[] = [];
let unexpected: string[] = [];
let answers: Record<string, () => Response> = {};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const APPLIED: AppliedVersion = {
  scriptName: "orders_fix",
  version: "1.0.0",
  sql: "ALTER TABLE orders ADD COLUMN note text;",
  downSql: "ALTER TABLE orders DROP COLUMN note;",
  changeType: "additive",
  description: null,
};

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  process.env.GITHUB_PAT = "test-token-not-real";
  process.env.GITHUB_REPO_OWNER = "acme";
  process.env.GITHUB_REPO_NAME = "registry";

  calls = [];
  unexpected = [];
  answers = {};
  global.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const key = `${(init?.method ?? "GET").toUpperCase()} ${url}`;
    const auth = (init?.headers as Record<string, string> | undefined)?.Authorization ?? null;
    calls.push({ method: (init?.method ?? "GET").toUpperCase(), url, token: auth });
    const answer = answers[key];
    if (!answer) {
      // Fail closed: an address the test did not name is never fetched.
      unexpected.push(key);
      throw new Error(`Unexpected fetch in test: ${key}`);
    }
    return answer();
  }) as typeof fetch;
});

afterEach(() => {
  global.fetch = realFetch;
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  expect(unexpected).toEqual([]);
});

describe("archiveAppliedVersions, organization folders", () => {
  it("records another organization's version, and its rollback, under orgs/<id>", async () => {
    const folder = `${REPO}/contents/orgs/12/db/public/orders_fix`;
    answers[`GET ${folder}`] = () => json(404, { message: "Not Found" });
    answers[`GET ${REPO}`] = () => json(200, { full_name: "acme/registry" });
    answers[`PUT ${folder}/v1.0.0.sql`] = () => json(201, { content: { name: "v1.0.0.sql" } });
    answers[`PUT ${folder}/v1.0.0.down.sql`] = () => json(201, { content: { name: "v1.0.0.down.sql" } });

    const result = await archiveAppliedVersions({
      owner: ORG_12,
      database: "db",
      schema: "public",
      versions: [APPLIED],
    });
    expect(result).toEqual([
      {
        script_name: "orders_fix",
        version: "1.0.0",
        status: "saved",
        path: "orgs/12/db/public/orders_fix/v1.0.0.sql",
        reason: null,
        rollback_saved: true,
      },
    ]);
    expect(calls.filter((call) => call.method === "PUT").map((call) => call.url)).toEqual([
      `${folder}/v1.0.0.sql`,
      `${folder}/v1.0.0.down.sql`,
    ]);
    // With the organization's own token, never the server's.
    expect(calls.map((call) => call.token)).toEqual(calls.map(() => `Bearer ${ORG_TOKEN}`));
  });

  it("names the organization's path for a version its folder already has", async () => {
    answers[`GET ${REPO}/contents/orgs/12/db/public/orders_fix`] = () =>
      json(200, [{ name: "v1.0.0.sql", sha: "a", type: "file" }]);
    const result = await archiveAppliedVersions({
      owner: ORG_12,
      database: "db",
      schema: "public",
      versions: [APPLIED],
    });
    expect(result?.[0]).toMatchObject({
      status: "already-saved",
      path: "orgs/12/db/public/orders_fix/v1.0.0.sql",
      rollback_saved: false,
    });
  });

  it("keeps the default organization's versions at the repository root", async () => {
    answers[`GET ${REPO}/contents/db/public/orders_fix`] = () =>
      json(200, [{ name: "v1.0.0.sql", sha: "a", type: "file" }]);
    const result = await archiveAppliedVersions({ owner: DEFAULT_ORG, database: "db", schema: "public", versions: [APPLIED] });
    expect(result?.[0]).toMatchObject({ status: "already-saved", path: "db/public/orders_fix/v1.0.0.sql" });
  });

  it("records nothing for a default-organization path inside another organization's folder", async () => {
    const result = await archiveAppliedVersions({
      owner: DEFAULT_ORG,
      database: "orgs",
      schema: "12",
      versions: [APPLIED, { ...APPLIED, version: "1.1.0" }],
    });
    expect(result?.map((entry) => [entry.version, entry.status, entry.path])).toEqual([
      ["1.0.0", "not-saved", null],
      ["1.1.0", "not-saved", null],
    ]);
    expect(result?.[0].reason).toContain("another organization's scripts");
    expect(result?.[0].reason).toContain("The migration itself is applied and safe.");
    expect(result?.[0].reason).not.toContain("try again");
    expect(calls).toEqual([]);
  });

  it.each([
    ["a database named ..", { database: "..", schema: "public" }, APPLIED, "database or schema name"],
    ["a schema with a / in it", { database: "db", schema: "a/b" }, APPLIED, "database or schema name"],
    ["a script name that steps up a folder", { database: "db", schema: "public" }, { ...APPLIED, scriptName: "../../13/x" }, "script name"],
    ["a version with a / in it", { database: "db", schema: "public" }, { ...APPLIED, version: "1.0.0/../x" }, "version"],
  ])("records nothing for %s, and asks GitHub nothing", async (_what, place, applied, part) => {
    // Any of these would point the write outside the organization's folder.
    const result = await archiveAppliedVersions({ owner: ORG_12, ...place, versions: [applied] });
    expect(result).toHaveLength(1);
    expect(result?.[0]).toMatchObject({ status: "not-saved", path: null, rollback_saved: false });
    expect(result?.[0].reason).toContain(`its ${part} cannot be used`);
    expect(result?.[0].reason).toContain("The migration itself is applied and safe.");
    expect(calls).toEqual([]);
  });

  it("still records the good versions of a run that holds a bad script name", async () => {
    answers[`GET ${REPO}/contents/orgs/12/db/public/orders_fix`] = () =>
      json(200, [{ name: "v1.0.0.sql", sha: "a", type: "file" }]);
    const result = await archiveAppliedVersions({
      owner: ORG_12,
      database: "db",
      schema: "public",
      versions: [{ ...APPLIED, scriptName: "a/b" }, APPLIED],
    });
    expect(result?.map((entry) => entry.status)).toEqual(["not-saved", "already-saved"]);
  });

  it("records nothing for an organization with no GitHub settings, and never borrows the server's", async () => {
    const result = await archiveAppliedVersions({
      owner: { orgId: 13, orgIsDefault: false },
      database: "db",
      schema: "public",
      versions: [APPLIED],
    });
    expect(result).toBeNull();
    expect(calls).toEqual([]);
  });
});
