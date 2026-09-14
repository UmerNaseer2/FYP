// POST /api/github/push: save one version of a script family to the GitHub
// registry. The route must never overwrite a saved file, never publish a
// version at or below the family's highest, and never write anything when it
// could not first read what the family already holds.
//
// Nothing here reaches GitHub. The GitHub settings are replaced with fake
// values, and fetch is replaced with a stub that answers only the requests a
// test names (by method and address) and records anything else as a failure.
import { NextRequest, NextResponse } from "next/server";
import { stampChangeType } from "@/lib/change-type";
import { CHANGE_LEVEL_REQUIRED, VERSION_FORMAT_HINT, rollbackCommitMessage } from "@/lib/registry-push";

// auth-guard pulls in next-auth, which ships as ESM Jest can't load. The
// route only needs requireEditor's answer, so a stand-in is enough. The path
// is relative on purpose: next/jest rewrites the @/ alias inside import
// statements only, so jest.mock("@/...") would not resolve.
const mockRequireEditor = jest.fn(
  async (): Promise<unknown> => ({
    ok: true,
    principal: { email: "e@x", name: "E", role: "editor", bypass: true },
  }),
);
jest.mock("../lib/auth-guard", () => ({
  requireEditor: () => mockRequireEditor(),
}));

type RouteModule = typeof import("../app/api/github/push/route");
let POST: RouteModule["POST"];

const FAKE_TOKEN = "test-token-not-real";
const REPO = "https://api.github.com/repos/acme/registry";
const FOLDER = `${REPO}/contents/db/public/orders_fix`;
const fileUrl = (name: string) => `${FOLDER}/${name}`;
const IDENTITY = { database: "db", schema: "public", scriptName: "orders_fix", version: "1.2.0" };

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
function saved(name: string, status = 201): () => Response {
  return () =>
    json(status, { content: { name, html_url: `https://github.com/acme/registry/blob/main/db/public/orders_fix/${name}` } });
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

// Answers for a rollback file the route must NOT touch. The old route read
// this address, took the published rollback's sha and overwrote it; the
// router now answers as if that were still possible, and the test checks
// nothing is written.
function trapRollbackFile(version: string, present: boolean): void {
  const url = fileUrl(`v${version}.down.sql`);
  answers[`GET ${url}`] = present
    ? contentsFile("ALTER TABLE orders DROP COLUMN note;", "published-rollback-sha")
    : () => json(404, { message: "Not Found" });
  answers[`PUT ${url}`] = saved(`v${version}.down.sql`, 200);
}

const writes = () => calls.filter((call) => call.method === "PUT" || call.method === "DELETE");
const decoded = (call: Call) => Buffer.from(String(call.body?.content ?? ""), "base64").toString("utf8");

const BASE = {
  database_name: "db",
  schema_name: "public",
  script_name: "orders_fix",
  version: "1.2.0",
  change_level: "additive",
  sql_content: "ALTER TABLE orders ADD COLUMN note text;",
};
const DOWN = "ALTER TABLE orders DROP COLUMN note;";

async function push(body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await POST(
    new NextRequest("http://localhost/api/github/push", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
  const text = await res.text();
  // Whatever happens, the token never reaches the browser.
  expect(text).not.toContain(FAKE_TOKEN);
  return { status: res.status, body: JSON.parse(text) as Record<string, unknown> };
}

beforeAll(async () => {
  // Imported after jest.mock above, so the route sees the stand-in guard.
  ({ POST } = await import("../app/api/github/push/route"));
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
  mockRequireEditor.mockClear();
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

describe("POST /api/github/push, a new version", () => {
  it("saves the migration, then its rollback, both create-only, into a new family", async () => {
    newFamily();
    answers[`PUT ${fileUrl("v1.2.0.sql")}`] = saved("v1.2.0.sql");
    answers[`PUT ${fileUrl("v1.2.0.down.sql")}`] = saved("v1.2.0.down.sql");
    const { status, body } = await push({ ...BASE, down_sql: DOWN });
    expect(status).toBe(200);
    expect(body).toEqual({
      ok: true,
      url: "https://github.com/acme/registry/blob/main/db/public/orders_fix/v1.2.0.sql",
      version: "1.2.0",
      paths: { migration: "db/public/orders_fix/v1.2.0.sql", rollback: "db/public/orders_fix/v1.2.0.down.sql" },
      rollback_saved: true,
    });

    // Migration first, then rollback. Neither sends a sha, so GitHub itself
    // refuses to replace a file that is already there.
    const saves = writes();
    expect(saves.map((call) => `${call.method} ${call.url}`)).toEqual([
      `PUT ${fileUrl("v1.2.0.sql")}`,
      `PUT ${fileUrl("v1.2.0.down.sql")}`,
    ]);
    expect(saves[0].body).not.toHaveProperty("sha");
    expect(saves[1].body).not.toHaveProperty("sha");

    // The migration carries the chosen level in its header; the rollback is saved as sent.
    expect(decoded(saves[0])).toBe(stampChangeType(BASE.sql_content, "additive"));
    expect(decoded(saves[0])).toContain(BASE.sql_content);
    expect(decoded(saves[1])).toBe(DOWN);

    // Every request skips any fetch cache and carries the token in its header only.
    for (const call of calls) {
      expect(call.init?.cache).toBe("no-store");
      expect((call.init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${FAKE_TOKEN}`);
      expect(call.url).not.toContain(FAKE_TOKEN);
    }
  });

  it("replaces a stale change-type line with the level chosen for the push", async () => {
    newFamily();
    answers[`PUT ${fileUrl("v2.0.0.sql")}`] = saved("v2.0.0.sql");
    const sql = "-- Change-type: patch\nALTER TABLE orders DROP COLUMN note;";
    const { status } = await push({ ...BASE, version: "2.0.0", change_level: "breaking", sql_content: sql });
    expect(status).toBe(200);
    const text = decoded(writes()[0]);
    expect(text).toBe(stampChangeType(sql, "breaking"));
    expect(text).not.toContain("Change-type: patch");
  });

  it("saves only the migration when no rollback is sent, and treats a blank rollback as none", async () => {
    newFamily();
    answers[`PUT ${fileUrl("v1.2.0.sql")}`] = saved("v1.2.0.sql");
    const { status, body } = await push({ ...BASE, down_sql: "  \n\t " });
    expect(status).toBe(200);
    expect(body.rollback_saved).toBe(false);
    expect(body.paths).toEqual({ migration: "db/public/orders_fix/v1.2.0.sql", rollback: null });
    expect(body).not.toHaveProperty("rollback_error");
    expect(writes().map((call) => call.url)).toEqual([fileUrl("v1.2.0.sql")]);
  });

  it("stores a two-part version as X.Y.Z", async () => {
    newFamily();
    answers[`PUT ${fileUrl("v1.2.0.sql")}`] = saved("v1.2.0.sql");
    const { status, body } = await push({ ...BASE, version: "1.2" });
    expect(status).toBe(200);
    expect(body.version).toBe("1.2.0");
  });

  it("writes commit messages that name the family, the version and the level", async () => {
    newFamily();
    answers[`PUT ${fileUrl("v1.2.0.sql")}`] = saved("v1.2.0.sql");
    answers[`PUT ${fileUrl("v1.2.0.down.sql")}`] = saved("v1.2.0.down.sql");
    await push({
      ...BASE,
      down_sql: DOWN,
      description: "Add a note column to orders so support can leave remarks on every order they handle",
    });
    const [up, down] = writes();
    const subject = String(up.body?.message).split("\n")[0];
    expect(subject.startsWith("db/public/orders_fix v1.2.0 (additive)")).toBe(true);
    expect(subject.length).toBeLessThanOrEqual(72);
    expect(down.body?.message).toBe(rollbackCommitMessage("rollback", IDENTITY));
    expect(String(down.body?.message).endsWith(": rollback")).toBe(true);
  });
});

describe.each([
  ["present", true],
  ["absent", false],
])("POST /api/github/push, refusals (a rollback file %s at its address)", (_label, rollbackPresent) => {
  it("stops when the repository can't be seen, and writes nothing", async () => {
    trapRollbackFile("1.2.0", rollbackPresent);
    answers[`GET ${FOLDER}`] = () => json(404, { message: "Not Found" });
    answers[`GET ${REPO}`] = () => json(404, { message: "Not Found" });
    const { status, body } = await push({ ...BASE, down_sql: DOWN });
    expect(status).toBe(502);
    expect(body.code).toBe("repo_not_found");
    expect(body.error).toContain('Could not check which versions of "orders_fix"');
    expect(writes()).toEqual([]);
  });

  it("refuses a version that is already saved with its rollback", async () => {
    trapRollbackFile("1.0.0", rollbackPresent);
    answers[`GET ${FOLDER}`] = listing(["v1.0.0.sql", "u1"], ["v1.0.0.down.sql", "d1"]);
    const { status, body } = await push({ ...BASE, version: "1.0.0", down_sql: DOWN });
    expect(status).toBe(409);
    expect(body.code).toBe("version_exists");
    expect(body.highest_version).toBe("1.0.0");
    expect(body.suggested).toBe("1.1.0");
    expect(body.error).toContain("Nothing was saved to GitHub.");
    expect(writes()).toEqual([]);
  });

  it("refuses a version saved without a rollback, and never adds one beside it", async () => {
    // The known bug: this used to create v1.0.0.down.sql next to a published version.
    trapRollbackFile("1.0.0", rollbackPresent);
    answers[`GET ${FOLDER}`] = listing(["v1.0.0.sql", "u1"]);
    const { status, body } = await push({ ...BASE, version: "1.0.0", down_sql: DOWN });
    expect(status).toBe(409);
    expect(body.code).toBe("version_exists");
    expect(writes()).toEqual([]);
  });

  it("refuses the same version spelled differently", async () => {
    trapRollbackFile("1.0.0", rollbackPresent);
    answers[`GET ${FOLDER}`] = listing(["v1.0.sql", "u1"]);
    const { status, body } = await push({ ...BASE, version: "1.0.0" });
    expect(status).toBe(409);
    expect(body.code).toBe("version_exists");
    expect(writes()).toEqual([]);
  });

  it("refuses a version below the family's highest and names the number to use", async () => {
    trapRollbackFile("1.5.0", rollbackPresent);
    answers[`GET ${FOLDER}`] = listing(["v1.0.0.sql", "a"], ["v2.0.0.sql", "b"]);
    const { status, body } = await push({ ...BASE, version: "1.5.0", down_sql: DOWN });
    expect(status).toBe(409);
    expect(body.code).toBe("version_not_newer");
    expect(body.highest_version).toBe("2.0.0");
    expect(body.suggested).toBe("2.1.0");
    expect(body.error).toContain("lower than v2.0.0");
    expect(writes()).toEqual([]);
  });

  it.each([
    [401, "token_rejected"],
    [403, "github_forbidden"],
    [429, "github_rate_limited"],
    [500, "github_down"],
  ])("stops when the family can't be listed (GitHub answers %i)", async (status, code) => {
    trapRollbackFile("1.2.0", rollbackPresent);
    // GitHub's own words (here echoing the token) never reach the browser.
    answers[`GET ${FOLDER}`] = () => json(status, { message: `boom ${FAKE_TOKEN}` });
    const { status: answered, body } = await push({ ...BASE, down_sql: DOWN });
    expect(answered).toBe(502);
    expect(body.code).toBe(code);
    expect(body.error).toContain("nothing was saved");
    expect(body.error).not.toContain("boom");
    expect(writes()).toEqual([]);
  });

  it("stops when GitHub can't be reached", async () => {
    trapRollbackFile("1.2.0", rollbackPresent);
    answers[`GET ${FOLDER}`] = () => {
      throw new TypeError("fetch failed");
    };
    const { status, body } = await push({ ...BASE, down_sql: DOWN });
    expect(status).toBe(502);
    expect(body.code).toBe("github_unreachable");
    expect(writes()).toEqual([]);
  });

  it("stops when the family's name is a file in GitHub", async () => {
    trapRollbackFile("1.2.0", rollbackPresent);
    answers[`GET ${FOLDER}`] = () => json(200, { name: "orders_fix", sha: "x", type: "file" });
    const { status, body } = await push({ ...BASE, down_sql: DOWN });
    expect(status).toBe(409);
    expect(body.code).toBe("not_a_folder");
    expect(body.error).toContain("different name");
    expect(writes()).toEqual([]);
  });
});

describe("POST /api/github/push, a rollback left by an earlier failed save", () => {
  const ORPHAN = fileUrl("v2.0.0.down.sql");
  const V2 = { ...BASE, version: "2.0.0", change_level: "breaking" };

  beforeEach(() => {
    answers[`GET ${FOLDER}`] = listing(["v1.0.0.sql", "a"], ["v2.0.0.down.sql", "orphan-sha"]);
  });

  it("removes it by its listed sha, then saves the migration and the new rollback, in that order", async () => {
    answers[`DELETE ${ORPHAN}`] = () => json(200, { commit: {} });
    answers[`PUT ${fileUrl("v2.0.0.sql")}`] = saved("v2.0.0.sql");
    answers[`PUT ${ORPHAN}`] = saved("v2.0.0.down.sql");
    const { status, body } = await push({ ...V2, down_sql: DOWN });
    expect(status).toBe(200);
    expect(body.rollback_saved).toBe(true);
    expect(writes().map((call) => `${call.method} ${call.url}`)).toEqual([
      `DELETE ${ORPHAN}`,
      `PUT ${fileUrl("v2.0.0.sql")}`,
      `PUT ${ORPHAN}`,
    ]);
    const removal = writes()[0];
    expect(removal.body?.sha).toBe("orphan-sha");
    expect(removal.body?.message).toBe(rollbackCommitMessage("remove_leftover", { ...IDENTITY, version: "2.0.0" }));
    expect(decoded(writes()[2])).toBe(DOWN);
  });

  it("without a new rollback, removes it and saves the migration only", async () => {
    answers[`DELETE ${ORPHAN}`] = () => json(200, { commit: {} });
    answers[`PUT ${fileUrl("v2.0.0.sql")}`] = saved("v2.0.0.sql");
    const { status, body } = await push(V2);
    expect(status).toBe(200);
    expect(body.paths).toEqual({ migration: "db/public/orders_fix/v2.0.0.sql", rollback: null });
    expect(writes().map((call) => `${call.method} ${call.url}`)).toEqual([
      `DELETE ${ORPHAN}`,
      `PUT ${fileUrl("v2.0.0.sql")}`,
    ]);
  });

  it("carries on when someone already removed it", async () => {
    answers[`DELETE ${ORPHAN}`] = () => json(404, { message: "Not Found" });
    answers[`PUT ${fileUrl("v2.0.0.sql")}`] = saved("v2.0.0.sql");
    const { status } = await push(V2);
    expect(status).toBe(200);
  });

  it("stops, saving nothing, when it changed since the listing", async () => {
    answers[`DELETE ${ORPHAN}`] = () => json(409, { message: "sha does not match" });
    const { status, body } = await push({ ...V2, down_sql: DOWN });
    expect(status).toBe(409);
    expect(body.code).toBe("push_in_progress");
    expect(body.error).toContain("Someone else is saving v2.0.0");
    expect(writes().map((call) => call.method)).toEqual(["DELETE"]);
  });

  it("stops when the connection drops while removing it", async () => {
    answers[`DELETE ${ORPHAN}`] = () => {
      throw new TypeError("fetch failed");
    };
    const { status, body } = await push(V2);
    expect(status).toBe(502);
    expect(body.code).toBe("github_unreachable");
    expect(writes().map((call) => call.method)).toEqual(["DELETE"]);
  });
});

describe("POST /api/github/push, when saving the migration fails", () => {
  const UP = fileUrl("v1.2.0.sql");
  beforeEach(() => newFamily());

  it("reports a version someone else saved a moment ago, and saves no rollback", async () => {
    answers[`PUT ${UP}`] = () => json(422, { message: "sha wasn't supplied" });
    answers[`GET ${UP}`] = contentsFile("SELECT 1;", "theirs");
    const { status, body } = await push({ ...BASE, down_sql: DOWN });
    expect(status).toBe(409);
    expect(body.code).toBe("version_exists");
    expect(body.highest_version).toBe("1.2.0");
    expect(body.suggested).toBe("1.3.0");
    expect(body.error).toContain("Someone else published v1.2.0");
    expect(writes().map((call) => call.url)).toEqual([UP]);
  });

  it("reports GitHub's refusal when the file is still not there", async () => {
    answers[`PUT ${UP}`] = () => json(422, { message: "Invalid request" });
    answers[`GET ${UP}`] = () => json(404, { message: "Not Found" });
    const { status, body } = await push({ ...BASE, down_sql: DOWN });
    expect(status).toBe(502);
    expect(body.code).toBe("github_error");
    expect(body.error).toContain("Nothing was saved");
    expect(body.error).not.toContain("Invalid request");
    expect(writes().map((call) => call.url)).toEqual([UP]);
  });

  it("says the outcome is unknown when the connection drops", async () => {
    answers[`PUT ${UP}`] = () => {
      throw new TypeError("socket hang up");
    };
    const { status, body } = await push({ ...BASE, down_sql: DOWN });
    expect(status).toBe(502);
    expect(body.code).toBe("outcome_unknown");
    expect(body.error).toContain("Reload the registry");
    expect(body.error).toContain("without its rollback");
    expect(writes().map((call) => call.url)).toEqual([UP]);
  });

  it("reports a branch that moved under the save as a conflict", async () => {
    answers[`PUT ${UP}`] = () => json(409, { message: "is at abc but expected def" });
    const { status, body } = await push(BASE);
    expect(status).toBe(409);
    expect(body.code).toBe("github_conflict");
    expect(body.error).toContain("Nothing was saved to GitHub.");
  });

  it("explains other GitHub errors in its own words", async () => {
    answers[`PUT ${UP}`] = () => json(500, { message: "internal boom" });
    const { status, body } = await push(BASE);
    expect(status).toBe(502);
    expect(body.code).toBe("github_down");
    expect(body.error).not.toContain("boom");
  });
});

describe("POST /api/github/push, when only the rollback fails", () => {
  const DOWN_URL = fileUrl("v1.2.0.down.sql");
  beforeEach(() => {
    newFamily();
    answers[`PUT ${fileUrl("v1.2.0.sql")}`] = saved("v1.2.0.sql");
  });

  it("keeps the saved version and says its rollback was not saved", async () => {
    answers[`PUT ${DOWN_URL}`] = () => json(500, { message: "boom" });
    const { status, body } = await push({ ...BASE, down_sql: DOWN });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.rollback_saved).toBe(false);
    expect(body.paths).toEqual({ migration: "db/public/orders_fix/v1.2.0.sql", rollback: null });
    expect(body.rollback_error).toContain("v1.2.0 was saved, but its rollback was not");
    // The screens offer "Retry saving the rollback" on this code.
    expect(body.rollback_error_code).toBe("rollback_failed");
  });

  it("names someone else when a rollback appeared meanwhile", async () => {
    answers[`PUT ${DOWN_URL}`] = () => json(422, { message: "sha wasn't supplied" });
    const { status, body } = await push({ ...BASE, down_sql: DOWN });
    expect(status).toBe(200);
    expect(body.rollback_error).toContain("someone else");
    // No retry is offered on this code: a saved rollback never changes.
    expect(body.rollback_error_code).toBe("rollback_exists");
  });

  it("says the rollback's outcome is unknown when the connection drops", async () => {
    answers[`PUT ${DOWN_URL}`] = () => {
      throw new TypeError("socket hang up");
    };
    const { status, body } = await push({ ...BASE, down_sql: DOWN });
    expect(status).toBe(200);
    expect(body.rollback_saved).toBe(false);
    expect(body.rollback_error).toContain("not known");
    expect(body.rollback_error_code).toBe("rollback_outcome_unknown");
  });
});

describe("POST /api/github/push, checks made before GitHub is asked", () => {
  const cases: Array<[string, unknown]> = [
    ["an empty body", {}],
    ["no script name", { ...BASE, script_name: undefined }],
    ["version 'latest'", { ...BASE, version: "latest" }],
    ["version '1.0.0.down'", { ...BASE, version: "1.0.0.down" }],
    ["version '1.2.3.4'", { ...BASE, version: "1.2.3.4" }],
    ["script name 'a/b'", { ...BASE, script_name: "a/b" }],
    ["script name '..'", { ...BASE, script_name: ".." }],
    ["script name ' x'", { ...BASE, script_name: " x" }],
    ["a 151-character script name", { ...BASE, script_name: "x".repeat(151) }],
    ["schema 'a/b'", { ...BASE, schema_name: "a/b" }],
    ["a comment-only migration", { ...BASE, sql_content: "-- nothing yet\n" }],
    ["a migration with COMMIT", { ...BASE, sql_content: "ALTER TABLE orders ADD COLUMN note text;\nCOMMIT;" }],
    ["a numeric migration", { ...BASE, sql_content: 42 }],
    ["no migration", { ...BASE, sql_content: undefined }],
    ["a comment-only rollback", { ...BASE, down_sql: "-- undo later\n" }],
    ["a rollback with ROLLBACK", { ...BASE, down_sql: "ALTER TABLE orders DROP COLUMN note;\nROLLBACK;" }],
    ["a numeric rollback", { ...BASE, down_sql: 7 }],
    ["no change level", { ...BASE, change_level: undefined }],
    ["an unknown change level", { ...BASE, change_level: "major" }],
    ["a description over 1000 characters", { ...BASE, description: "d".repeat(1001) }],
    ["a numeric description", { ...BASE, description: 5 }],
    ["a JSON array", []],
    ["text that is not JSON", "{not json"],
  ];

  it.each(cases)("refuses %s with 400 and asks GitHub nothing", async (_label, body) => {
    const { status, body: answer } = await push(body);
    expect(status).toBe(400);
    expect(answer.ok).toBe(false);
    expect(answer.code).toBe("invalid_input");
    expect(answer.error).toContain("Nothing was saved to GitHub.");
    expect(calls).toEqual([]);
  });

  it("asks for the change level in plain words", async () => {
    const { body } = await push({ ...BASE, change_level: undefined });
    expect(body.error).toContain(CHANGE_LEVEL_REQUIRED);
  });

  it("uses the one wording for a bad version", async () => {
    const { body } = await push({ ...BASE, version: "latest" });
    expect(body.error).toContain(VERSION_FORMAT_HINT);
  });
});

describe("POST /api/github/push, adding a rollback to a saved version", () => {
  const ATTACH = {
    attach_rollback: true,
    database_name: "db",
    schema_name: "public",
    script_name: "orders_fix",
    version: "1.2.0",
    down_sql: DOWN,
  };
  const DOWN_URL = fileUrl("v1.2.0.down.sql");

  it("refuses a version that is not saved", async () => {
    answers[`GET ${FOLDER}`] = listing(["v1.0.0.sql", "a"]);
    const { status, body } = await push(ATTACH);
    expect(status).toBe(404);
    expect(body.code).toBe("version_missing");
    expect(writes()).toEqual([]);
  });

  it("refuses to change a rollback that has statements", async () => {
    answers[`GET ${FOLDER}`] = listing(["v1.2.0.sql", "u"], ["v1.2.0.down.sql", "d1"]);
    answers[`GET ${DOWN_URL}`] = contentsFile("ALTER TABLE orders DROP COLUMN note;", "d1");
    const { status, body } = await push(ATTACH);
    expect(status).toBe(409);
    expect(body.code).toBe("rollback_exists");
    expect(writes()).toEqual([]);
  });

  it("replaces a rollback that runs nothing, by its sha", async () => {
    answers[`GET ${FOLDER}`] = listing(["v1.2.0.sql", "u"], ["v1.2.0.down.sql", "d1"]);
    answers[`GET ${DOWN_URL}`] = contentsFile("-- fill in later\n", "d1");
    answers[`PUT ${DOWN_URL}`] = saved("v1.2.0.down.sql", 200);
    const { status, body } = await push(ATTACH);
    expect(status).toBe(200);
    expect(body).toEqual({
      ok: true,
      url: "https://github.com/acme/registry/blob/main/db/public/orders_fix/v1.2.0.down.sql",
      version: "1.2.0",
      paths: { migration: "db/public/orders_fix/v1.2.0.sql", rollback: "db/public/orders_fix/v1.2.0.down.sql" },
      rollback_saved: true,
    });
    const [put] = writes();
    expect(put.body?.sha).toBe("d1");
    expect(put.body?.message).toBe(rollbackCommitMessage("replace_empty", IDENTITY));
    expect(decoded(put)).toBe(DOWN);
  });

  it("stops when the empty rollback changed since it was read", async () => {
    answers[`GET ${FOLDER}`] = listing(["v1.2.0.sql", "u"], ["v1.2.0.down.sql", "d1"]);
    answers[`GET ${DOWN_URL}`] = contentsFile("", "d1");
    answers[`PUT ${DOWN_URL}`] = () => json(409, { message: "sha does not match" });
    const { status, body } = await push(ATTACH);
    expect(status).toBe(409);
    expect(body.code).toBe("push_in_progress");
  });

  it("adds a missing rollback create-only", async () => {
    answers[`GET ${FOLDER}`] = listing(["v1.2.0.sql", "u"]);
    answers[`PUT ${DOWN_URL}`] = saved("v1.2.0.down.sql");
    const { status, body } = await push(ATTACH);
    expect(status).toBe(200);
    expect(body.rollback_saved).toBe(true);
    const [put] = writes();
    expect(put.body).not.toHaveProperty("sha");
    expect(put.body?.message).toBe(rollbackCommitMessage("add_missing", IDENTITY));
  });

  it("reports a rollback someone else added meanwhile", async () => {
    answers[`GET ${FOLDER}`] = listing(["v1.2.0.sql", "u"]);
    answers[`PUT ${DOWN_URL}`] = () => json(422, { message: "sha wasn't supplied" });
    answers[`GET ${DOWN_URL}`] = contentsFile("ALTER TABLE orders DROP COLUMN note;", "theirs");
    const { status, body } = await push(ATTACH);
    expect(status).toBe(409);
    expect(body.code).toBe("rollback_exists");
    expect(body.error).toContain("someone else");
  });

  it("pairs the rollback with an older two-part version's file name", async () => {
    answers[`GET ${FOLDER}`] = listing(["v1.2.sql", "u"]);
    answers[`PUT ${fileUrl("v1.2.down.sql")}`] = saved("v1.2.down.sql");
    const { status, body } = await push({ ...ATTACH, version: "1.2" });
    expect(status).toBe(200);
    expect(body.paths).toEqual({
      migration: "db/public/orders_fix/v1.2.sql",
      rollback: "db/public/orders_fix/v1.2.down.sql",
    });
  });

  it("adds the rollback under the migration's own spelling when another spelling is in the folder", async () => {
    // Pull never reads v1.2.0.down.sql as the rollback of v1.2.sql, so it is
    // neither read nor replaced: the rollback goes where pull will find it.
    answers[`GET ${FOLDER}`] = listing(["v1.2.sql", "u"], ["v1.2.0.down.sql", "other"]);
    answers[`PUT ${fileUrl("v1.2.down.sql")}`] = saved("v1.2.down.sql");
    const { status, body } = await push(ATTACH);
    expect(status).toBe(200);
    expect(body.rollback_saved).toBe(true);
    expect(body.paths).toEqual({
      migration: "db/public/orders_fix/v1.2.sql",
      rollback: "db/public/orders_fix/v1.2.down.sql",
    });
    const [put] = writes();
    expect(put.body).not.toHaveProperty("sha");
    expect(put.body?.message).toBe(rollbackCommitMessage("add_missing", IDENTITY));
    expect(decoded(put)).toBe(DOWN);
    expect(calls.some((call) => call.url === DOWN_URL)).toBe(false);
  });

  it("says the outcome is unknown when the connection drops", async () => {
    answers[`GET ${FOLDER}`] = listing(["v1.2.0.sql", "u"]);
    answers[`PUT ${DOWN_URL}`] = () => {
      throw new TypeError("socket hang up");
    };
    const { status, body } = await push(ATTACH);
    expect(status).toBe(502);
    expect(body.code).toBe("outcome_unknown");
  });

  it.each([
    ["no rollback", { ...ATTACH, down_sql: undefined }],
    ["a comment-only rollback", { ...ATTACH, down_sql: "-- later\n" }],
    ["a rollback with COMMIT", { ...ATTACH, down_sql: "ALTER TABLE orders DROP COLUMN note;\nCOMMIT;" }],
  ])("refuses %s with 400 and asks GitHub nothing", async (_label, body) => {
    const { status, body: answer } = await push(body);
    expect(status).toBe(400);
    expect(answer.code).toBe("invalid_input");
    expect(calls).toEqual([]);
  });
});

describe("POST /api/github/push, setup and access", () => {
  it("says which settings are missing, by name only, and asks GitHub nothing", async () => {
    process.env.GITHUB_REPO_NAME = "";
    const { status, body } = await push(BASE);
    expect(status).toBe(500);
    expect(body.code).toBe("github_unconfigured");
    expect(body.error).toContain("Missing now: GITHUB_REPO_NAME.");
    expect(body.error).not.toContain("acme");
    expect(calls).toEqual([]);
  });

  it("returns the guard's answer when the user may not edit", async () => {
    mockRequireEditor.mockImplementationOnce(async () => ({
      ok: false,
      response: NextResponse.json({ ok: false, error: "Sign in as an editor to save scripts." }, { status: 403 }),
    }));
    const { status, body } = await push(BASE);
    expect(status).toBe(403);
    expect(body.ok).toBe(false);
    expect(calls).toEqual([]);
  });
});
