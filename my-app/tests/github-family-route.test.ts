// GET /api/github/family: the versions one script family already has in the
// GitHub registry. The Workbench bumps the next version from this, so the
// route must fail CLOSED: when GitHub can't be read it answers a readable
// 502, never an empty list that would make the screen offer v1.0.0 again.
//
// Nothing here reaches GitHub. The GitHub settings are replaced with fake
// values, and fetch is replaced with a stub that answers only the addresses
// a test names and records anything else as a failure.
import { NextRequest, NextResponse } from "next/server";
import { principalFor } from "./helpers/principals";

// auth-guard pulls in next-auth, which ships as ESM Jest can't load. The
// route only needs requirePermission's answer, so a stand-in is enough. The
// path is relative on purpose: next/jest rewrites the @/ alias inside import
// statements only, so jest.mock("@/...") would not resolve.
const mockRequirePermission = jest.fn(
  async (): Promise<unknown> => ({ ok: true, principal: principalFor("viewer") }),
);
jest.mock("../lib/auth-guard", () => ({
  requirePermission: () => mockRequirePermission(),
}));

// Each organization's own GitHub settings (lib/org-github-store.ts) are kept
// in the metadata database, which these tests do not have. Organization 12 has
// settings of its own: the server's repository, with a token of its own. No
// other organization has any, so the default one falls back to the server's
// keys and any other has no GitHub at all (lib/github-config.ts).
const ORG_TOKEN = "org-token-not-real";
function savedSettings(orgId: number): unknown {
  return orgId === 12
    ? { owner: "acme-test", repo: "registry-test", token: ORG_TOKEN, updatedBy: "admin@test", updatedAt: new Date(0) }
    : null;
}
const mockReadOrgGitHub = jest.fn();
jest.mock("../lib/org-github-store", () => ({
  readOrgGitHub: (orgId: number) => mockReadOrgGitHub(orgId),
}));

type RouteModule = typeof import("../app/api/github/family/route");
let GET: RouteModule["GET"];

const FAKE_TOKEN = "test-token-not-real";
const REPO = "https://api.github.com/repos/acme-test/registry-test";
const FOLDER = `${REPO}/contents/sales%20db/public/orders_fix`;
const QUERY = "database=sales%20db&schema=public&script=orders_fix";

const ENV_KEYS = ["GITHUB_PAT", "GITHUB_REPO_OWNER", "GITHUB_REPO_NAME"] as const;
let savedEnv: Record<string, string | undefined> = {};
const realFetch = global.fetch;

type Call = { url: string; init?: RequestInit };
let calls: Call[] = [];
let unexpected: string[] = [];
let answers: Record<string, () => Response> = {};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

async function callRoute(query: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await GET(new NextRequest(`http://localhost/api/github/family?${query}`));
  const text = await res.text();
  // Whatever happens, the token never reaches the browser.
  expect(text).not.toContain(FAKE_TOKEN);
  expect(text).not.toContain(ORG_TOKEN);
  return { status: res.status, body: JSON.parse(text) as Record<string, unknown> };
}

beforeAll(async () => {
  // Imported after jest.mock above, so the route sees the stand-in guard.
  ({ GET } = await import("../app/api/github/family/route"));
});

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  process.env.GITHUB_PAT = FAKE_TOKEN;
  process.env.GITHUB_REPO_OWNER = "acme-test";
  process.env.GITHUB_REPO_NAME = "registry-test";

  calls = [];
  unexpected = [];
  answers = {};
  mockRequirePermission.mockClear();
  mockReadOrgGitHub.mockReset().mockImplementation(async (orgId: number) => savedSettings(orgId));
  global.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init });
    const answer = answers[url];
    if (!answer) {
      // Fail closed: an address the test did not name is never fetched.
      unexpected.push(url);
      throw new Error(`Unexpected fetch in test: ${url}`);
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

describe("GET /api/github/family", () => {
  it("lists the published versions, lowest first, with the highest", async () => {
    answers[FOLDER] = () =>
      json(200, [
        { name: "v1.0.0.sql", sha: "a", type: "file" },
        { name: "v1.0.0.down.sql", sha: "b", type: "file" },
        { name: "v1.10.0.sql", sha: "c", type: "file" },
        { name: "v1.9.0.sql", sha: "d", type: "file" },
        { name: "v2.0.0.down.sql", sha: "e", type: "file" },
        { name: "README.md", sha: "f", type: "file" },
        { name: "v9.0.0.sql", sha: "g", type: "dir" },
      ]);
    const { status, body } = await callRoute(QUERY);
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true, versions: ["1.0.0", "1.9.0", "1.10.0"], highest: "1.10.0" });

    // One read, of the encoded folder path, with the token in the header only.
    expect(calls.map((call) => call.url)).toEqual([FOLDER]);
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${FAKE_TOKEN}`);
    expect(headers.Accept).toBe("application/vnd.github+json");
    expect(headers["X-GitHub-Api-Version"]).toBe("2022-11-28");
  });

  it("answers a new family with no versions once the repository is confirmed", async () => {
    answers[FOLDER] = () => json(404, { message: "Not Found" });
    answers[REPO] = () => json(200, { full_name: "acme-test/registry-test" });
    const { status, body } = await callRoute(QUERY);
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true, versions: [], highest: null });
    expect(calls.map((call) => call.url)).toEqual([FOLDER, REPO]);
  });

  it("fails closed when the repository itself can't be seen", async () => {
    answers[FOLDER] = () => json(404, { message: "Not Found" });
    answers[REPO] = () => json(404, { message: "Not Found" });
    const { status, body } = await callRoute(QUERY);
    expect(status).toBe(502);
    expect(body.ok).toBe(false);
    expect(body.code).toBe("repo_not_found");
    expect(body.error).toContain('Could not read the versions of "orders_fix" from GitHub');
    expect(body.error).toContain("GITHUB_REPO_OWNER");
    expect(body).not.toHaveProperty("versions");
  });

  it("explains a rejected token", async () => {
    answers[FOLDER] = () => json(401, { message: "Bad credentials" });
    const { status, body } = await callRoute(QUERY);
    expect(status).toBe(502);
    expect(body.code).toBe("token_rejected");
    expect(body.error).toContain("(status 401)");
    expect(body.error).toContain("GITHUB_PAT");
    // GitHub's own words are not passed through.
    expect(body.error).not.toContain("Bad credentials");
  });

  it("explains GitHub being down", async () => {
    answers[FOLDER] = () => json(503, { message: "Service Unavailable" });
    const { status, body } = await callRoute(QUERY);
    expect(status).toBe(502);
    expect(body.code).toBe("github_down");
  });

  it("explains a path that is a file, not a folder", async () => {
    answers[FOLDER] = () => json(200, { name: "orders_fix", sha: "x", type: "file" });
    const { status, body } = await callRoute(QUERY);
    expect(status).toBe(502);
    expect(body.code).toBe("not_a_folder");
  });

  it("explains GitHub not being reachable", async () => {
    answers[FOLDER] = () => {
      throw new TypeError("fetch failed");
    };
    const { status, body } = await callRoute(QUERY);
    expect(status).toBe(502);
    expect(body.code).toBe("github_unreachable");
    expect(body.error).toContain("could not reach GitHub");
    expect(body.error).not.toContain("(status");
  });

  it("reads another organization's versions from its own folder", async () => {
    // Organization 12 is not the default one, so its scripts sit under
    // orgs/12/. The stub answers only that address: a read of the default
    // organization's folder would fail the test.
    mockRequirePermission.mockImplementationOnce(async () => ({
      ok: true,
      principal: principalFor("viewer", { orgId: 12, orgSlug: "acme", orgName: "Acme", orgIsDefault: false }),
    }));
    const orgFolder = `${REPO}/contents/orgs/12/sales%20db/public/orders_fix`;
    answers[orgFolder] = () =>
      json(200, [
        { name: "v1.0.0.sql", sha: "a", type: "file" },
        { name: "v1.1.0.sql", sha: "b", type: "file" },
      ]);
    const { status, body } = await callRoute(QUERY);
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true, versions: ["1.0.0", "1.1.0"], highest: "1.1.0" });
    expect(calls.map((call) => call.url)).toEqual([orgFolder]);
    // With the organization's own token, never the server's.
    for (const call of calls) {
      expect((call.init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${ORG_TOKEN}`);
    }
  });

  it("names the organization's folder when its path is a file", async () => {
    mockRequirePermission.mockImplementationOnce(async () => ({
      ok: true,
      principal: principalFor("viewer", { orgId: 12, orgSlug: "acme", orgName: "Acme", orgIsDefault: false }),
    }));
    answers[`${REPO}/contents/orgs/12/sales%20db/public/orders_fix`] = () =>
      json(200, { name: "orders_fix", sha: "x", type: "file" });
    const { status, body } = await callRoute(QUERY);
    expect(status).toBe(502);
    expect(body.code).toBe("not_a_folder");
    expect(body.error).toContain("orgs/12/sales db/public/orders_fix");
  });

  it("reads nothing for an organization with no GitHub settings, and never borrows the server's", async () => {
    mockRequirePermission.mockImplementationOnce(async () => ({
      ok: true,
      principal: principalFor("viewer", { orgId: 13, orgSlug: "gamma", orgName: "Gamma", orgIsDefault: false }),
    }));
    const { status, body } = await callRoute(QUERY);
    expect(status).toBe(500);
    expect(body.code).toBe("github_unconfigured");
    expect(body.error).toContain("on the Admin screen, under GitHub");
    expect(calls).toEqual([]);
  });

  it("refuses, for the default organization, the folder of another organization", async () => {
    const { status, body } = await callRoute("database=orgs&schema=12&script=orders_fix");
    expect(status).toBe(400);
    expect(body.ok).toBe(false);
    expect(body.error).toContain("other organizations' scripts");
    expect(calls).toEqual([]);
  });

  it("refuses a missing name without asking GitHub", async () => {
    const { status, body } = await callRoute("database=db&schema=public");
    expect(status).toBe(400);
    expect(body.ok).toBe(false);
    expect(body.error).toContain("Give the script a name");
    expect(calls).toEqual([]);
  });

  it("refuses a folder step as a name without asking GitHub", async () => {
    const { status, body } = await callRoute("database=db&schema=..&script=orders_fix");
    expect(status).toBe(400);
    expect(body.error).toContain("schema");
    expect(calls).toEqual([]);
  });

  it("says which GitHub settings are missing, by name only", async () => {
    process.env.GITHUB_PAT = "";
    const { status, body } = await callRoute(QUERY);
    expect(status).toBe(500);
    expect(body.code).toBe("github_unconfigured");
    expect(body.error).toContain("Missing now: GITHUB_PAT.");
    expect(body.error).not.toContain("acme-test");
    expect(calls).toEqual([]);
  });

  it("returns the guard's answer when nobody is signed in", async () => {
    mockRequirePermission.mockImplementationOnce(async () => ({
      ok: false,
      response: NextResponse.json({ error: "Sign in to continue." }, { status: 401 }),
    }));
    const { status, body } = await callRoute(QUERY);
    expect(status).toBe(401);
    expect(body.error).toBe("Sign in to continue.");
    expect(calls).toEqual([]);
  });
});
