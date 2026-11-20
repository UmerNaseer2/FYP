// POST /api/github/retire: set one saved version of a script family aside, so
// Deploy stops offering it and the versions after it can run. The route adds
// one note beside the version (v<version>.retired.md) and nothing else: it
// must never replace or delete a file, never write when it could not first
// read the family, and never write for a version the family does not have.
//
// Nothing here reaches GitHub. The GitHub settings are replaced with fake
// values, and fetch is replaced with a stub that answers only the requests a
// test names (by method and address) and records anything else as a failure.
import { NextRequest, NextResponse } from "next/server";
import { refusalMessage } from "@/lib/roles/permissions";
import { principalFor } from "./helpers/principals";

// lib/auth/guard pulls in next-auth, which ships as ESM Jest can't load. The
// route only needs requirePermission's answer, so a stand-in is enough. The
// stand-in records the permission the route asked for. The path is relative
// on purpose: next/jest rewrites the @/ alias inside import statements only.
const mockRequirePermission = jest.fn<Promise<unknown>, [key?: string]>(
  async () => ({
    ok: true,
    principal: principalFor("admin", { email: "a@x", name: "A" }),
  }),
);
jest.mock("../lib/auth/guard", () => ({
  requirePermission: (key: string) => mockRequirePermission(key),
}));

// Organization 12 has GitHub settings of its own (the server's repository,
// with a token of its own). No other organization has any, so the default one
// falls back to the server's keys and any other has no GitHub at all.
const ORG_TOKEN = "org-token-not-real";
function savedSettings(orgId: number): unknown {
  return orgId === 12
    ? { owner: "acme", repo: "registry", token: ORG_TOKEN, updatedBy: "admin@test", updatedAt: new Date(0) }
    : null;
}
const mockReadOrgGitHub = jest.fn();
jest.mock("../lib/github/org-store", () => ({
  readOrgGitHub: (orgId: number) => mockReadOrgGitHub(orgId),
}));

type RouteModule = typeof import("../app/api/github/retire/route");
let POST: RouteModule["POST"];

const FAKE_TOKEN = "test-token-not-real";
const REPO = "https://api.github.com/repos/acme/registry";
const FOLDER = `${REPO}/contents/db/public/orders_fix`;
const fileUrl = (name: string) => `${FOLDER}/${name}`;
const NOTE = "db/public/orders_fix/v1.2.0.retired.md";

const ENV_KEYS = ["GITHUB_PAT", "GITHUB_REPO_OWNER", "GITHUB_REPO_NAME"] as const;
let savedEnv: Record<string, string | undefined> = {};
const realFetch = global.fetch;
let restoreConsole = () => {};

type Call = { method: string; url: string; body: Record<string, unknown> | null; init?: RequestInit };
let calls: Call[] = [];
let unexpected: string[] = [];
let answers: Record<string, () => Response> = {};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

// A family folder as the contents API lists it.
function listing(...files: Array<[name: string, sha: string]>): () => Response {
  return () => json(200, files.map(([name, sha]) => ({ name, sha, type: "file", path: `db/public/orders_fix/${name}` })));
}

// GitHub's answer to a successful save: the file, with its page on GitHub.
function saved(name: string): () => Response {
  return () =>
    json(201, { content: { name, html_url: `https://github.com/acme/registry/blob/main/db/public/orders_fix/${name}` } });
}

// One file as the contents API sends it: base64 text and its sha.
function contentsFile(text: string, sha: string): () => Response {
  return () => json(200, { type: "file", encoding: "base64", content: Buffer.from(text, "utf8").toString("base64"), sha });
}

// A family with no folder yet, in a repository the token can see.
function newFamily(): void {
  answers[`GET ${FOLDER}`] = () => json(404, { message: "Not Found" });
  answers[`GET ${REPO}`] = () => json(200, { full_name: "acme/registry" });
}

// The family most tests start from: three versions, none retired.
function threeVersions(): void {
  answers[`GET ${FOLDER}`] = listing(
    ["v1.0.0.sql", "a"],
    ["v1.1.0.sql", "b"],
    ["v1.2.0.sql", "c"],
    ["v1.2.0.down.sql", "d"],
  );
}

const writes = () => calls.filter((call) => call.method === "PUT" || call.method === "DELETE");
const decoded = (call: Call) => Buffer.from(String(call.body?.content ?? ""), "base64").toString("utf8");

const BASE = {
  database_name: "db",
  schema_name: "public",
  script_name: "orders_fix",
  version: "1.2.0",
};

async function retire(body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await POST(
    new NextRequest("http://localhost/api/github/retire", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
  const text = await res.text();
  // Whatever happens, the token never reaches the browser.
  expect(text).not.toContain(FAKE_TOKEN);
  expect(text).not.toContain(ORG_TOKEN);
  return { status: res.status, body: JSON.parse(text) as Record<string, unknown> };
}

beforeAll(async () => {
  // Imported after jest.mock above, so the route sees the stand-in guard.
  ({ POST } = await import("../app/api/github/retire/route"));
});

beforeEach(() => {
  // next/jest loads .env.local, so the fake values must overwrite it.
  savedEnv = {};
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  process.env.GITHUB_PAT = FAKE_TOKEN;
  process.env.GITHUB_REPO_OWNER = "acme";
  process.env.GITHUB_REPO_NAME = "registry";

  calls = [];
  unexpected = [];
  answers = {};
  mockRequirePermission.mockClear();
  mockReadOrgGitHub.mockReset().mockImplementation(async (orgId: number) => savedSettings(orgId));
  // The route logs GitHub's raw answers; keep the test output clean.
  const spy = jest.spyOn(console, "error").mockImplementation(() => {});
  restoreConsole = () => spy.mockRestore();

  global.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    const key = `${method} ${url}`;
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    calls.push({ method, url, body, init });
    const answer = answers[key];
    if (!answer) {
      // Fail closed: a request the test did not name is never answered.
      unexpected.push(key);
      throw new Error(`Unexpected fetch in test: ${key}`);
    }
    return answer();
  }) as typeof fetch;
});

afterEach(() => {
  global.fetch = realFetch;
  restoreConsole();
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  expect(unexpected).toEqual([]);
});

describe("POST /api/github/retire, retiring a version", () => {
  it("adds one create-only note beside the version, with the reason, and touches nothing else", async () => {
    threeVersions();
    answers[`PUT ${fileUrl("v1.2.0.retired.md")}`] = saved("v1.2.0.retired.md");
    const { status, body } = await retire({ ...BASE, reason: "Breaks on the reporting replica" });
    expect(status).toBe(200);
    expect(body).toEqual({
      ok: true,
      already: false,
      version: "1.2.0",
      path: NOTE,
      url: "https://github.com/acme/registry/blob/main/db/public/orders_fix/v1.2.0.retired.md",
    });

    // Exactly one write: the note. No sha, so GitHub refuses to replace a file.
    const saves = writes();
    expect(saves.map((call) => `${call.method} ${call.url}`)).toEqual([`PUT ${fileUrl("v1.2.0.retired.md")}`]);
    expect(saves[0].body).not.toHaveProperty("sha");
    expect(saves[0].body?.message).toBe("db/public/orders_fix v1.2.0: retire\n\nBreaks on the reporting replica");

    // The note says what retiring means and how to undo it.
    const note = decoded(saves[0]);
    expect(note).toContain("# v1.2.0 of orders_fix is retired");
    expect(note).toContain("Reason: Breaks on the reporting replica");
    expect(note).toMatch(/Retired on \d{4}-\d{2}-\d{2} \(UTC\)\./);
    expect(note).toContain("To bring it back, delete this file.");

    // Every request skips any fetch cache and carries the token in its header only.
    for (const call of calls) {
      expect(call.init?.cache).toBe("no-store");
      expect((call.init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${FAKE_TOKEN}`);
      expect(call.url).not.toContain(FAKE_TOKEN);
    }
    // Retiring has its own permission, which only Admin has out of the box.
    expect(mockRequirePermission).toHaveBeenCalledWith("scripts:delete");
  });

  it("retires with no reason, and says so in the note", async () => {
    threeVersions();
    answers[`PUT ${fileUrl("v1.1.0.retired.md")}`] = saved("v1.1.0.retired.md");
    const { status, body } = await retire({ ...BASE, version: "1.1.0" });
    expect(status).toBe(200);
    expect(body.path).toBe("db/public/orders_fix/v1.1.0.retired.md");
    const [save] = writes();
    expect(save.body?.message).toBe("db/public/orders_fix v1.1.0: retire");
    expect(decoded(save)).toContain("No reason given.");
    expect(decoded(save)).not.toContain("Reason:");
  });

  it("treats a blank reason as none", async () => {
    threeVersions();
    answers[`PUT ${fileUrl("v1.2.0.retired.md")}`] = saved("v1.2.0.retired.md");
    const { status } = await retire({ ...BASE, reason: "  \n " });
    expect(status).toBe(200);
    expect(writes()[0].body?.message).toBe("db/public/orders_fix v1.2.0: retire");
  });

  it("accepts the version with a leading v", async () => {
    threeVersions();
    answers[`PUT ${fileUrl("v1.2.0.retired.md")}`] = saved("v1.2.0.retired.md");
    const { status, body } = await retire({ ...BASE, version: "v1.2.0" });
    expect(status).toBe(200);
    expect(body.version).toBe("1.2.0");
  });

  it("spells the note like the migration it sits beside", async () => {
    // An old family wrote v1.0.sql. Asked for 1.0.0, the note is v1.0.retired.md.
    answers[`GET ${FOLDER}`] = listing(["v1.0.sql", "a"], ["v1.1.0.sql", "b"]);
    answers[`PUT ${fileUrl("v1.0.retired.md")}`] = saved("v1.0.retired.md");
    const { status, body } = await retire({ ...BASE, version: "1.0.0" });
    expect(status).toBe(200);
    expect(body.version).toBe("1.0");
    expect(body.path).toBe("db/public/orders_fix/v1.0.retired.md");
    expect(writes()[0].body?.message).toBe("db/public/orders_fix v1.0: retire");
    expect(decoded(writes()[0])).toContain("# v1.0 of orders_fix is retired");
  });

  it("keeps the link out when GitHub's answer has none, since the note is saved either way", async () => {
    threeVersions();
    answers[`PUT ${fileUrl("v1.2.0.retired.md")}`] = () => json(201, { content: {} });
    const { status, body } = await retire(BASE);
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true, already: false, version: "1.2.0", path: NOTE, url: null });
  });
});

describe("POST /api/github/retire, a version retired already", () => {
  it("says so and writes nothing", async () => {
    answers[`GET ${FOLDER}`] = listing(["v1.1.0.sql", "b"], ["v1.2.0.sql", "c"], ["v1.2.0.retired.md", "n"]);
    const { status, body } = await retire(BASE);
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true, already: true, version: "1.2.0", path: NOTE });
    expect(writes()).toEqual([]);
  });

  it("finds a note that spells the version differently, and names its real path", async () => {
    answers[`GET ${FOLDER}`] = listing(["v1.0.sql", "a"], ["v1.0.0.retired.md", "n"]);
    const { status, body } = await retire({ ...BASE, version: "1.0" });
    expect(status).toBe(200);
    expect(body).toEqual({
      ok: true,
      already: true,
      version: "1.0",
      path: "db/public/orders_fix/v1.0.0.retired.md",
    });
    expect(writes()).toEqual([]);
  });

  it("reads GitHub's 422 as someone else retiring it a moment ago, once the note is there", async () => {
    threeVersions();
    answers[`PUT ${fileUrl("v1.2.0.retired.md")}`] = () => json(422, { message: "sha wasn't supplied" });
    answers[`GET ${fileUrl("v1.2.0.retired.md")}`] = contentsFile("# v1.2.0 of orders_fix is retired\n", "n");
    const { status, body } = await retire(BASE);
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true, already: true, version: "1.2.0", path: NOTE });
    expect(writes()).toHaveLength(1);
  });

  it("reports a 422 it can't explain, without GitHub's words", async () => {
    threeVersions();
    answers[`PUT ${fileUrl("v1.2.0.retired.md")}`] = () => json(422, { message: `boom ${FAKE_TOKEN}` });
    answers[`GET ${fileUrl("v1.2.0.retired.md")}`] = () => json(404, { message: "Not Found" });
    const { status, body } = await retire(BASE);
    expect(status).toBe(502);
    expect(body.code).toBe("github_error");
    expect(body.error).toContain("status 422");
    expect(body.error).toContain("Nothing was changed in GitHub.");
    expect(body.error).not.toContain("boom");
  });
});

describe("POST /api/github/retire, what it refuses before asking GitHub", () => {
  const long = `1.${"0".repeat(48)}`;
  const cases: Array<[label: string, body: unknown, words: string]> = [
    ["a body that is not JSON", "{", "The request was not valid JSON."],
    ["a JSON list", [], "The request must be a JSON object."],
    ["a missing version", { ...BASE, version: undefined }, "Say which version to retire."],
    ["a blank version", { ...BASE, version: "  " }, "Say which version to retire."],
    ["a version that is not a number", { ...BASE, version: "abc" }, '"abc" is not a version number, such as 1.2.0.'],
    ["a version with a path in it", { ...BASE, version: "1.2.0/../x" }, "is not a version number"],
    ["a very long version, cut short", { ...BASE, version: long }, `"${long.slice(0, 40)}..." is not a version number`],
    ["a reason that is not text", { ...BASE, reason: 5 }, "The reason was sent, but not as text."],
    ["a reason with an invisible character", { ...BASE, reason: "bad\u0007one" }, "invisible character"],
    ["a reason over 500 characters", { ...BASE, reason: "x".repeat(501) }, "The reason is 501 characters long."],
    ["a script name with a slash", { ...BASE, script_name: "orders/fix" }, ""],
    ["a missing database", { ...BASE, database_name: undefined }, ""],
    ["another organization's folder", { ...BASE, database_name: "orgs", schema_name: "12" }, "other organizations' scripts"],
  ];

  it.each(cases)("refuses %s with 400 and asks GitHub nothing", async (_label, request, words) => {
    const { status, body } = await retire(request);
    expect(status).toBe(400);
    expect(body.ok).toBe(false);
    expect(body.code).toBe("invalid_input");
    expect(body.error).toContain(words);
    expect(String(body.error).endsWith(" Nothing was changed in GitHub.")).toBe(true);
    expect(calls).toEqual([]);
  });

  it("allows a reason of exactly 500 characters", async () => {
    threeVersions();
    answers[`PUT ${fileUrl("v1.2.0.retired.md")}`] = saved("v1.2.0.retired.md");
    const { status } = await retire({ ...BASE, reason: "x".repeat(500) });
    expect(status).toBe(200);
  });
});

describe("POST /api/github/retire, a version the family does not have", () => {
  it("refuses a version that is not in the folder", async () => {
    answers[`GET ${FOLDER}`] = listing(["v1.0.0.sql", "a"], ["v1.2.0.down.sql", "d"]);
    const { status, body } = await retire(BASE);
    expect(status).toBe(404);
    expect(body.code).toBe("version_missing");
    expect(body.error).toBe(
      'v1.2.0 of "orders_fix" is not in the registry, so there is nothing to retire. Reload the page and check the version. Nothing was changed in GitHub.',
    );
    expect(writes()).toEqual([]);
  });

  it("refuses a family that has no folder yet, and makes none", async () => {
    newFamily();
    const { status, body } = await retire(BASE);
    expect(status).toBe(404);
    expect(body.code).toBe("version_missing");
    expect(writes()).toEqual([]);
  });

  it("does not count a note on its own as a version", async () => {
    // A note left beside nothing, after the migration was deleted by hand.
    answers[`GET ${FOLDER}`] = listing(["v1.0.0.sql", "a"], ["v1.2.0.retired.md", "n"]);
    const { status, body } = await retire(BASE);
    expect(status).toBe(404);
    expect(body.code).toBe("version_missing");
    expect(writes()).toEqual([]);
  });
});

describe("POST /api/github/retire, when GitHub fails", () => {
  it.each([
    [401, "token_rejected"],
    [403, "github_forbidden"],
    [429, "github_rate_limited"],
    [500, "github_down"],
  ])("stops when the family can't be listed (GitHub answers %i)", async (status, code) => {
    // GitHub's own words (here echoing the token) never reach the browser.
    answers[`GET ${FOLDER}`] = () => json(status, { message: `boom ${FAKE_TOKEN}` });
    const { status: answered, body } = await retire(BASE);
    expect(answered).toBe(502);
    expect(body.code).toBe(code);
    expect(body.error).toContain('Could not read the versions of "orders_fix" in GitHub, so nothing was retired.');
    expect(body.error).not.toContain("boom");
    expect(writes()).toEqual([]);
  });

  it("stops when the repository is missing", async () => {
    answers[`GET ${FOLDER}`] = () => json(404, { message: "Not Found" });
    answers[`GET ${REPO}`] = () => json(404, { message: "Not Found" });
    const { status, body } = await retire(BASE);
    expect(status).toBe(502);
    expect(body.code).toBe("repo_not_found");
    expect(writes()).toEqual([]);
  });

  it("stops when GitHub can't be reached", async () => {
    answers[`GET ${FOLDER}`] = () => {
      throw new TypeError("fetch failed");
    };
    const { status, body } = await retire(BASE);
    expect(status).toBe(502);
    expect(body.code).toBe("github_unreachable");
    expect(writes()).toEqual([]);
  });

  it("stops when the family's name is a file in GitHub", async () => {
    answers[`GET ${FOLDER}`] = () => json(200, { name: "orders_fix", sha: "x", type: "file" });
    const { status, body } = await retire(BASE);
    expect(status).toBe(409);
    expect(body.code).toBe("not_a_folder");
    expect(body.error).toContain("Nothing was changed in GitHub.");
    expect(writes()).toEqual([]);
  });

  it("says the outcome is unknown when the connection drops during the save", async () => {
    threeVersions();
    answers[`PUT ${fileUrl("v1.2.0.retired.md")}`] = () => {
      throw new TypeError("socket hang up");
    };
    const { status, body } = await retire(BASE);
    expect(status).toBe(502);
    expect(body.code).toBe("outcome_unknown");
    expect(body.error).toContain("it is not known whether it was retired");
    expect(body.error).toContain("Try again: if it was, you will be told so.");
  });

  it("passes on a conflict as a 409, so a retry is safe", async () => {
    threeVersions();
    answers[`PUT ${fileUrl("v1.2.0.retired.md")}`] = () => json(409, { message: "is at a different sha" });
    const { status, body } = await retire(BASE);
    expect(status).toBe(409);
    expect(body.code).toBe("github_conflict");
    expect(body.error).toContain("Nothing was changed in GitHub.");
  });

  it("reports a token GitHub refuses at the save", async () => {
    threeVersions();
    answers[`PUT ${fileUrl("v1.2.0.retired.md")}`] = () => json(401, { message: `boom ${FAKE_TOKEN}` });
    const { status, body } = await retire(BASE);
    expect(status).toBe(502);
    expect(body.code).toBe("token_rejected");
    expect(body.error).not.toContain("boom");
  });
});

describe("POST /api/github/retire, organizations", () => {
  // Organization 12 is not the default one, so its scripts live under orgs/12/.
  const ORG_FOLDER = `${REPO}/contents/orgs/12/db/public/orders_fix`;

  it("retires inside that organization's folder, with its own token", async () => {
    mockRequirePermission.mockImplementationOnce(async () => ({
      ok: true,
      principal: principalFor("admin", { orgId: 12, orgSlug: "acme", orgName: "Acme", orgIsDefault: false }),
    }));
    answers[`GET ${ORG_FOLDER}`] = () =>
      json(200, [{ name: "v1.2.0.sql", sha: "c", type: "file", path: "orgs/12/db/public/orders_fix/v1.2.0.sql" }]);
    answers[`PUT ${ORG_FOLDER}/v1.2.0.retired.md`] = saved("v1.2.0.retired.md");
    const { status, body } = await retire(BASE);
    expect(status).toBe(200);
    expect(body.path).toBe("orgs/12/db/public/orders_fix/v1.2.0.retired.md");
    expect(writes().map((call) => call.url)).toEqual([`${ORG_FOLDER}/v1.2.0.retired.md`]);
    for (const call of calls) {
      expect((call.init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${ORG_TOKEN}`);
    }
  });

  it("writes nothing for an organization with no GitHub settings, and never borrows the server's", async () => {
    mockRequirePermission.mockImplementationOnce(async () => ({
      ok: true,
      principal: principalFor("admin", { orgId: 13, orgSlug: "gamma", orgName: "Gamma", orgIsDefault: false }),
    }));
    const { status, body } = await retire(BASE);
    expect(status).toBe(500);
    expect(body.code).toBe("github_unconfigured");
    expect(body.error).toContain("on the Admin screen, under GitHub");
    expect(calls).toEqual([]);
  });
});

describe("POST /api/github/retire, setup and access", () => {
  it("says which settings are missing, by name only, and asks GitHub nothing", async () => {
    process.env.GITHUB_REPO_NAME = "";
    const { status, body } = await retire(BASE);
    expect(status).toBe(500);
    expect(body.code).toBe("github_unconfigured");
    expect(body.error).toContain("Missing now: GITHUB_REPO_NAME.");
    expect(calls).toEqual([]);
  });

  it("returns the guard's answer when the role may not retire versions", async () => {
    const refusal = refusalMessage("Editor", "scripts:delete");
    mockRequirePermission.mockImplementationOnce(async () => ({
      ok: false,
      response: NextResponse.json({ error: refusal }, { status: 403 }),
    }));
    const { status, body } = await retire(BASE);
    expect(status).toBe(403);
    expect(body.error).toBe(refusal);
    expect(mockRequirePermission).toHaveBeenCalledWith("scripts:delete");
    expect(calls).toEqual([]);
  });
});
