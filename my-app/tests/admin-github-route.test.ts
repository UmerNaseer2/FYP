/**
 * /api/admin/github (app/api/admin/github/route.ts): the GitHub tab on the
 * Admin screen, where an organization keeps the repository its scripts go in
 * and the access token the app uses for it.
 *
 * What the database does with each change is lib/org-github-store.ts's
 * business. Here the gate, the store and GitHub itself are stood in for, so
 * these cover what the route adds:
 *
 *   - which permission each method asks for, and that a refusal is passed on;
 *   - that no answer ever holds a token, the organization's or the server's,
 *     or names the server's own repository;
 *   - that only the default organization is told the server's settings stand
 *     in for its own;
 *   - what is refused before GitHub or the database is reached: the desktop
 *     app, a server with no encryption key, a body the rules turn down;
 *   - that GitHub is asked about the token that will really be used, the new
 *     one or the saved one, and nothing is saved when it says no;
 *   - how each answer from the store is said.
 */
import { NextRequest } from "next/server";
import type { Gate } from "@/lib/auth-guard";
import { BYPASS_ACTOR } from "@/lib/auth-mode";
import { REPOSITORY_PROBLEM, tokenProblem } from "@/lib/github-settings";
import { bypassAdminPrincipal, principalFor, TEST_ORG } from "./helpers/principals";

let mockGate: Gate;
/** The keys each call to requirePermission asked for, in order. */
let mockAskedFor: string[][] = [];
jest.mock("../lib/auth-guard", () => ({
  requirePermission: async (...keys: string[]) => {
    mockAskedFor.push(keys);
    return mockGate;
  },
}));

const mockStore = { readOrgGitHub: jest.fn(), saveOrgGitHub: jest.fn(), removeOrgGitHub: jest.fn() };
jest.mock("../lib/org-github-store", () => ({
  readOrgGitHub: (...args: unknown[]) => mockStore.readOrgGitHub(...args),
  saveOrgGitHub: (...args: unknown[]) => mockStore.saveOrgGitHub(...args),
  removeOrgGitHub: (...args: unknown[]) => mockStore.removeOrgGitHub(...args),
}));

let mockKeySource: "app-key" | "derived" | "none" = "app-key";
jest.mock("../lib/secret-store", () => ({
  encryptionKeySource: () => mockKeySource,
}));

import { DELETE, GET, PUT } from "@/app/api/admin/github/route";

// Made up for these tests. None of them is a real token.
const ORG_TOKEN = "github_pat_saved_token_not_real_0001";
const NEW_TOKEN = "github_pat_new_token_not_real_0002";
const SERVER = { owner: "server-owner-test", repo: "server-repo-test", token: "server-token-not-real-0003" };

const ADMIN = principalFor("admin");
/** An admin of an organization other than the install's first. */
const ADMIN_ELSEWHERE = principalFor("admin", { orgId: 12, orgIsDefault: false });
const ACTOR = { email: "admin@test", role: "admin" };
const TRY_AGAIN = " The app's database may be unreachable. Try again in a moment.";

const SAVED = {
  owner: "acme",
  repo: "registry",
  token: ORG_TOKEN,
  updatedBy: "someone@test",
  updatedAt: new Date("2026-11-01T02:03:04.000Z"),
};

const ENV_KEYS = ["GITHUB_REPO_OWNER", "GITHUB_REPO_NAME", "GITHUB_PAT", "SCHEMA_STUDIO_DESKTOP"] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

/** What GitHub answers the repository check with, or "unreachable" for no answer at all. */
let github: number | "unreachable" = 200;
/** The account the token belongs to, as GitHub's /user names it. */
let tokenLogin = "someone-else";
/** What GitHub answers a request to make the repository with. 422: the name is taken. */
let createAnswer = 422;
/** Every request sent to GitHub: where to, and with which token. */
let calls: Array<{ url: string; authorization: string | undefined; method?: string; body?: unknown }> = [];
const realFetch = global.fetch;

beforeEach(() => {
  mockGate = { ok: true, principal: ADMIN };
  mockAskedFor = [];
  mockKeySource = "app-key";
  for (const each of Object.values(mockStore)) each.mockReset();
  delete process.env.SCHEMA_STUDIO_DESKTOP;
  process.env.GITHUB_REPO_OWNER = SERVER.owner;
  process.env.GITHUB_REPO_NAME = SERVER.repo;
  process.env.GITHUB_PAT = SERVER.token;

  github = 200;
  tokenLogin = "someone-else";
  createAnswer = 422;
  calls = [];
  global.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const url = String(input);
    const method = init?.method ?? "GET";
    if (method === "GET" && !url.endsWith("/user")) {
      calls.push({ url, authorization: headers.Authorization });
    } else {
      calls.push({
        url,
        authorization: headers.Authorization,
        method,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      });
    }
    if (github === "unreachable") throw new TypeError("fetch failed");
    if (url.endsWith("/user")) return new Response(JSON.stringify({ login: tokenLogin }), { status: 200 });
    if (method === "POST") return new Response("{}", { status: createAnswer });
    return new Response("{}", { status: github });
  }) as typeof fetch;
});

afterEach(() => {
  jest.restoreAllMocks();
  global.fetch = realFetch;
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

function put(body: string): NextRequest {
  return new NextRequest("http://localhost/api/admin/github", {
    method: "PUT",
    body,
    headers: { "content-type": "application/json" },
  });
}

/** The status and the body, once it is clear the body holds no token and nothing of the server's. */
async function answer(response: Response): Promise<[number, unknown]> {
  const text = await response.text();
  for (const secret of [ORG_TOKEN, NEW_TOKEN, SERVER.token, SERVER.owner, SERVER.repo]) {
    expect(text).not.toContain(secret);
  }
  return [response.status, JSON.parse(text)];
}

describe("GET", () => {
  test("asks for GitHub registry: Read and says what is saved and by whom, never the token", async () => {
    mockStore.readOrgGitHub.mockResolvedValue(SAVED);
    expect(await answer(await GET())).toEqual([
      200,
      {
        source: "organization",
        repository: "acme/registry",
        folder: "",
        tokenUnreadable: false,
        updatedBy: "someone@test",
        updatedAt: "2026-11-01T02:03:04.000Z",
        serverFallback: true,
        cannotSave: null,
        canUpdate: true,
      },
    ]);
    expect(mockAskedFor).toEqual([["github:read"]]);
    expect(mockStore.readOrgGitHub.mock.calls).toEqual([[TEST_ORG.id]]);
  });

  test("names another organization's own folder in the repository", async () => {
    mockGate = { ok: true, principal: ADMIN_ELSEWHERE };
    mockStore.readOrgGitHub.mockResolvedValue(SAVED);
    const [, body] = await answer(await GET());
    expect(body).toMatchObject({ source: "organization", folder: "orgs/12", serverFallback: false });
    expect(mockStore.readOrgGitHub.mock.calls).toEqual([[12]]);
  });

  test("tells the default organization the server's settings stand in, without naming them", async () => {
    mockStore.readOrgGitHub.mockResolvedValue(null);
    const [, body] = await answer(await GET());
    expect(body).toMatchObject({ source: "server", repository: null, serverFallback: true, updatedBy: null });
  });

  test("tells another organization with nothing saved it has no GitHub, though the server has settings", async () => {
    mockGate = { ok: true, principal: ADMIN_ELSEWHERE };
    mockStore.readOrgGitHub.mockResolvedValue(null);
    const [, body] = await answer(await GET());
    expect(body).toMatchObject({ source: "none", repository: null, serverFallback: false });
  });

  test("says none for the default organization when the server has no settings either", async () => {
    delete process.env.GITHUB_PAT;
    mockStore.readOrgGitHub.mockResolvedValue(null);
    const [, body] = await answer(await GET());
    expect(body).toMatchObject({ source: "none" });
  });

  test("says when the saved token can't be read on this server", async () => {
    mockStore.readOrgGitHub.mockResolvedValue({ ...SAVED, token: null });
    const [, body] = await answer(await GET());
    expect(body).toMatchObject({ source: "organization", repository: "acme/registry", tokenUnreadable: true });
  });

  test("tells a role with Read alone it may not change them", async () => {
    mockGate = { ok: true, principal: principalFor("editor", { permissions: ["github:read"] }) };
    mockStore.readOrgGitHub.mockResolvedValue(SAVED);
    const [, body] = await answer(await GET());
    expect(body).toMatchObject({ canUpdate: false });
  });

  test("says why nothing can be saved on a server with no encryption key", async () => {
    mockKeySource = "none";
    mockStore.readOrgGitHub.mockResolvedValue(null);
    const [, body] = await answer(await GET());
    expect((body as { cannotSave: string }).cannotSave).toMatch(/no encryption key.*APP_ENCRYPTION_KEY/);
  });

  test("on the desktop, points to its Settings window and reads no database", async () => {
    process.env.SCHEMA_STUDIO_DESKTOP = "1";
    const [status, body] = await answer(await GET());
    expect(status).toBe(200);
    expect(body).toMatchObject({ source: "server", repository: null, canUpdate: false });
    expect((body as { cannotSave: string }).cannotSave).toMatch(/Settings window/);
    expect(mockStore.readOrgGitHub).not.toHaveBeenCalled();
  });

  test("is 503 when the database does not answer, with the reason kept to the log", async () => {
    const logged = jest.spyOn(console, "error").mockImplementation(() => {});
    mockStore.readOrgGitHub.mockRejectedValue(new Error("connection refused"));
    expect(await answer(await GET())).toEqual([503, { error: `Could not read the GitHub settings.${TRY_AGAIN}` }]);
    expect(logged).toHaveBeenCalled();
  });

  test("passes a refusal from the gate on as it is", async () => {
    const refusal = Response.json({ error: "no" }, { status: 403 });
    mockGate = { ok: false, response: refusal as never };
    expect(await GET()).toBe(refusal);
    expect(mockStore.readOrgGitHub).not.toHaveBeenCalled();
  });
});

describe("PUT", () => {
  const CHECKED = "https://api.github.com/repos/acme/registry";

  test("asks for GitHub registry: Update, has GitHub check the new token, then saves it", async () => {
    mockStore.saveOrgGitHub.mockResolvedValue({ kind: "ok", changed: true });
    const sent = put(JSON.stringify({ repository: " https://github.com/acme/registry.git ", token: `  ${NEW_TOKEN}\n` }));

    expect(await answer(await PUT(sent))).toEqual([200, { saved: true, changed: true, created: false, repository: "acme/registry" }]);
    expect(mockAskedFor).toEqual([["github:update"]]);
    expect(calls).toEqual([{ url: CHECKED, authorization: `Bearer ${NEW_TOKEN}` }]);
    expect(mockStore.saveOrgGitHub.mock.calls).toEqual([
      [TEST_ORG.id, { owner: "acme", repo: "registry", token: NEW_TOKEN }, ACTOR],
    ]);
    expect(mockStore.readOrgGitHub).not.toHaveBeenCalled();
  });

  test.each<[string, Record<string, unknown>]>([
    ["left out", {}],
    ["left blank", { token: "   " }],
    ["null", { token: null }],
  ])("keeps the saved token when the token is %s, once GitHub accepts it for the repository", async (_, extra) => {
    mockStore.readOrgGitHub.mockResolvedValue(SAVED);
    mockStore.saveOrgGitHub.mockResolvedValue({ kind: "ok", changed: true });

    const sent = put(JSON.stringify({ repository: "acme/other", ...extra }));
    expect(await answer(await PUT(sent))).toEqual([200, { saved: true, changed: true, created: false, repository: "acme/other" }]);
    expect(calls).toEqual([{ url: "https://api.github.com/repos/acme/other", authorization: `Bearer ${ORG_TOKEN}` }]);
    expect(mockStore.saveOrgGitHub.mock.calls).toEqual([
      [TEST_ORG.id, { owner: "acme", repo: "other", token: null }, ACTOR],
    ]);
  });

  describe("a repository that does not exist yet", () => {
    beforeEach(() => {
      jest.spyOn(console, "error").mockImplementation(() => {});
      github = 404;
      mockStore.saveOrgGitHub.mockResolvedValue({ kind: "ok", changed: false });
    });

    test.each([
      ["an organization", "someone-else", "https://api.github.com/orgs/acme/repos"],
      ["the token's own account", "Acme", "https://api.github.com/user/repos"],
    ])("is made under %s with the same token, private, then saved", async (_, login, address) => {
      tokenLogin = login;
      createAnswer = 201;
      const sent = put(JSON.stringify({ repository: "acme/registry", token: NEW_TOKEN }));
      expect(await answer(await PUT(sent))).toEqual([
        200,
        { saved: true, changed: true, created: true, repository: "acme/registry" },
      ]);
      expect(calls).toEqual([
        { url: CHECKED, authorization: `Bearer ${NEW_TOKEN}` },
        { url: "https://api.github.com/user", authorization: `Bearer ${NEW_TOKEN}`, method: "GET", body: undefined },
        {
          url: address,
          authorization: `Bearer ${NEW_TOKEN}`,
          method: "POST",
          body: { name: "registry", private: true, auto_init: true, description: "Schema Studio script registry" },
        },
      ]);
      expect(mockStore.saveOrgGitHub).toHaveBeenCalled();
    });

    test.each<[string, string, number, "repository" | "token" | null, RegExp]>([
      ["a token not allowed to make repositories", "acme", 403, "token", /not allowed to make one.*Administration/],
      ["an owner that is no organization the token reaches", "someone-else", 404, "repository", /not this token's own account/],
      ["a name that is taken by a repository the token can't see", "someone-else", 422, "repository", /can't open/],
      ["an error on GitHub's side", "someone-else", 500, null, /\(500\)/],
    ])("saves nothing after %s", async (_, login, made, field, message) => {
      tokenLogin = login;
      createAnswer = made;
      const [got, body] = await answer(await PUT(put(JSON.stringify({ repository: "acme/registry", token: NEW_TOKEN }))));
      expect(got).toBe(field === null ? 502 : 400);
      expect(body).toEqual({ error: expect.stringMatching(message), field });
      expect((body as { error: string }).error).toContain("Nothing was saved.");
      expect(mockStore.saveOrgGitHub).not.toHaveBeenCalled();
    });
  });

  test("says when nothing changed", async () => {
    mockStore.readOrgGitHub.mockResolvedValue(SAVED);
    mockStore.saveOrgGitHub.mockResolvedValue({ kind: "ok", changed: false });
    expect(await answer(await PUT(put(JSON.stringify({ repository: "acme/registry" }))))).toEqual([
      200,
      { saved: true, changed: false, created: false, repository: "acme/registry" },
    ]);
  });

  test.each([
    ["a role an Admin let look after GitHub", principalFor("editor", { email: "lead@test", permissions: ["github:update"] }), { email: "lead@test", role: "editor" }],
    ["the demo", bypassAdminPrincipal(), { email: BYPASS_ACTOR, role: "admin" }],
  ])("logs the change for %s under the role that allowed it", async (_, principal, actor) => {
    mockGate = { ok: true, principal };
    mockStore.saveOrgGitHub.mockResolvedValue({ kind: "ok", changed: true });
    await PUT(put(JSON.stringify({ repository: "acme/registry", token: NEW_TOKEN })));
    expect(mockStore.saveOrgGitHub.mock.calls[0][2]).toEqual(actor);
  });

  test.each<[string, string, unknown]>([
    ["a body that is not JSON", "{", { error: "Expected a JSON body." }],
    ["an array", "[]", { error: "Expected a JSON body." }],
    ["no repository", JSON.stringify({ token: NEW_TOKEN }), { error: REPOSITORY_PROBLEM, field: "repository" }],
    ["a repository with no owner", JSON.stringify({ repository: "registry", token: NEW_TOKEN }), { error: REPOSITORY_PROBLEM, field: "repository" }],
    ["a repository that is not text", JSON.stringify({ repository: 5, token: NEW_TOKEN }), { error: REPOSITORY_PROBLEM, field: "repository" }],
    ["a token that is not text", JSON.stringify({ repository: "acme/registry", token: 5 }), { error: "Paste the access token as text.", field: "token" }],
    ["a token with spaces in it", JSON.stringify({ repository: "acme/registry", token: "github_pat_ab cd ef gh ij kl" }), { error: tokenProblem("github_pat_ab cd ef gh ij kl"), field: "token" }],
    ["a token far too short", JSON.stringify({ repository: "acme/registry", token: "short" }), { error: tokenProblem("short"), field: "token" }],
  ])("turns down %s before GitHub or the database is reached", async (_, body, expected) => {
    expect(await answer(await PUT(put(body)))).toEqual([400, expected]);
    expect(calls).toEqual([]);
    expect(mockStore.readOrgGitHub).not.toHaveBeenCalled();
    expect(mockStore.saveOrgGitHub).not.toHaveBeenCalled();
  });

  test.each<[string, unknown, RegExp]>([
    ["nothing is saved yet", null, /None is saved for this organization yet/],
    ["the saved one can't be read here", { ...SAVED, token: null }, /encryption key has changed/],
  ])("asks for a token when none is given and %s", async (_, saved, message) => {
    mockStore.readOrgGitHub.mockResolvedValue(saved);
    const [status, body] = await answer(await PUT(put(JSON.stringify({ repository: "acme/registry" }))));
    expect(status).toBe(400);
    expect(body).toEqual({ error: expect.stringMatching(message), field: "token" });
    expect(calls).toEqual([]);
    expect(mockStore.saveOrgGitHub).not.toHaveBeenCalled();
  });

  test.each<[string, number | "unreachable", number, "repository" | "token" | null]>([
    ["a token GitHub does not accept", 401, 400, "token"],
    ["a repository the token can't open", 404, 400, "repository"],
    ["a refusal from GitHub", 403, 400, "token"],
    ["GitHub out of reach", "unreachable", 502, null],
    ["an error on GitHub's side", 500, 502, null],
  ])("saves nothing after %s", async (_, answered, status, field) => {
    jest.spyOn(console, "error").mockImplementation(() => {});
    github = answered;
    const [got, body] = await answer(await PUT(put(JSON.stringify({ repository: "acme/registry", token: NEW_TOKEN }))));
    expect(got).toBe(status);
    expect(body).toEqual({ error: expect.stringContaining("Nothing was saved."), field });
    expect(mockStore.saveOrgGitHub).not.toHaveBeenCalled();
  });

  test.each<[string, () => void, number, RegExp]>([
    ["the desktop app", () => (process.env.SCHEMA_STUDIO_DESKTOP = "1"), 403, /Settings window/],
    ["a server with no encryption key", () => (mockKeySource = "none"), 503, /no encryption key/],
  ])("refuses on %s before the body is read", async (_, setUp, status, message) => {
    setUp();
    // Not even JSON: a route that read it would answer 400.
    const [got, body] = await answer(await PUT(put("{")));
    expect(got).toBe(status);
    expect((body as { error: string }).error).toMatch(message);
    expect(calls).toEqual([]);
    expect(mockStore.saveOrgGitHub).not.toHaveBeenCalled();
  });

  test.each<[string, unknown, number, unknown]>([
    [
      "the organization deleted a moment ago",
      { kind: "not-found" },
      404,
      { error: "This organization no longer exists. Someone may have just deleted it." },
    ],
    ["no encryption key after all", { kind: "no-key" }, 503, { error: expect.stringMatching(/no encryption key/) }],
    [
      "the saved token gone in the meantime",
      { kind: "no-token" },
      400,
      { error: expect.stringMatching(/Paste an access token/), field: "token" },
    ],
  ])("says so when the store finds %s", async (_, saved, status, expected) => {
    mockStore.saveOrgGitHub.mockResolvedValue(saved);
    const sent = put(JSON.stringify({ repository: "acme/registry", token: NEW_TOKEN }));
    expect(await answer(await PUT(sent))).toEqual([status, expected]);
  });

  test("is 503 when the saved settings can't be read, and asks GitHub nothing", async () => {
    jest.spyOn(console, "error").mockImplementation(() => {});
    mockStore.readOrgGitHub.mockRejectedValue(new Error("connection refused"));
    expect(await answer(await PUT(put(JSON.stringify({ repository: "acme/registry" }))))).toEqual([
      503,
      { error: `Could not read the saved GitHub settings.${TRY_AGAIN}` },
    ]);
    expect(calls).toEqual([]);
  });

  test("is 503 when the database does not answer the save, and the log never holds the token", async () => {
    const logged = jest.spyOn(console, "error").mockImplementation(() => {});
    mockStore.saveOrgGitHub.mockRejectedValue(new Error("connection refused"));
    const sent = put(JSON.stringify({ repository: "acme/registry", token: NEW_TOKEN }));
    expect(await answer(await PUT(sent))).toEqual([503, { error: `Could not save the GitHub settings.${TRY_AGAIN}` }]);
    expect(logged).toHaveBeenCalled();
    expect(logged.mock.calls.flat().map(String).join(" ")).not.toContain(NEW_TOKEN);
  });

  test("passes a refusal from the gate on as it is", async () => {
    const refusal = Response.json({ error: "no" }, { status: 403 });
    mockGate = { ok: false, response: refusal as never };
    expect(await PUT(put(JSON.stringify({ repository: "acme/registry", token: NEW_TOKEN })))).toBe(refusal);
    expect(calls).toEqual([]);
  });
});

describe("DELETE", () => {
  test("asks for GitHub registry: Update and forgets the settings", async () => {
    mockStore.removeOrgGitHub.mockResolvedValue({ removed: true });
    expect(await answer(await DELETE())).toEqual([200, { removed: true }]);
    expect(mockAskedFor).toEqual([["github:update"]]);
    expect(mockStore.removeOrgGitHub.mock.calls).toEqual([[TEST_ORG.id, ACTOR]]);
  });

  test("says when there was nothing to forget", async () => {
    mockStore.removeOrgGitHub.mockResolvedValue({ removed: false });
    expect(await answer(await DELETE())).toEqual([200, { removed: false }]);
  });

  test("refuses on the desktop", async () => {
    process.env.SCHEMA_STUDIO_DESKTOP = "1";
    const [status, body] = await answer(await DELETE());
    expect(status).toBe(403);
    expect((body as { error: string }).error).toMatch(/Settings window/);
    expect(mockStore.removeOrgGitHub).not.toHaveBeenCalled();
  });

  test("is 503 when the database does not answer", async () => {
    jest.spyOn(console, "error").mockImplementation(() => {});
    mockStore.removeOrgGitHub.mockRejectedValue(new Error("connection refused"));
    expect(await answer(await DELETE())).toEqual([503, { error: `Could not remove the GitHub settings.${TRY_AGAIN}` }]);
  });

  test("passes a refusal from the gate on as it is", async () => {
    const refusal = Response.json({ error: "no" }, { status: 403 });
    mockGate = { ok: false, response: refusal as never };
    expect(await DELETE()).toBe(refusal);
    expect(mockStore.removeOrgGitHub).not.toHaveBeenCalled();
  });
});
