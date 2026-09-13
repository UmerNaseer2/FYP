// GET /api/github/pull: every script in the GitHub registry, for Deploy and
// the Script Editor. One unreadable folder or file must not hide the rest,
// but it must be named in `warnings`; a registry that can't be read at all is
// a readable 502, never an empty list. Each version says how its rollback
// reads, and the rollback text is sent only when Deploy could run it.
//
// Nothing here reaches GitHub. The GitHub settings are replaced with fake
// values, and fetch is replaced with a stub that answers only the addresses a
// test names and records anything else as a failure.
import { NextResponse } from "next/server";

// See tests/github-push.test.ts for why the guard is a relative-path stand-in.
const mockRequireViewer = jest.fn(async (): Promise<unknown> => ({ ok: true, principal: null }));
jest.mock("../lib/auth-guard", () => ({
  requireViewer: () => mockRequireViewer(),
}));

type RouteModule = typeof import("../app/api/github/pull/route");
let GET: RouteModule["GET"];

const FAKE_TOKEN = "test-token-not-real";
const REPO = "https://api.github.com/repos/acme/registry";
const ROOT = `${REPO}/contents`;
const RAW = "https://raw.example.test/acme/registry/main";
const FAMILY = "db/public/orders_fix";

const ENV_KEYS = ["GITHUB_PAT", "GITHUB_REPO_OWNER", "GITHUB_REPO_NAME"] as const;
let savedEnv: Record<string, string | undefined> = {};
const realFetch = global.fetch;
let restoreConsole = () => {};

type Call = { method: string; url: string; init?: RequestInit };
let calls: Call[] = [];
let unexpected: string[] = [];
let answers: Record<string, () => Response> = {};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

type Item = { name: string; path: string; sha: string; type: string; download_url: string | null };
const lastPart = (path: string) => path.split("/").pop() ?? path;
const folder = (path: string): Item => ({ name: lastPart(path), path, sha: `sha-${path}`, type: "dir", download_url: null });
const file = (path: string): Item => ({
  name: lastPart(path),
  path,
  sha: `sha-${path}`,
  type: "file",
  download_url: `${RAW}/${path}`,
});

// Answer a folder listing at its contents address ("" is the repository root).
function listFolder(path: string, items: Item[]): void {
  answers[path === "" ? ROOT : `${ROOT}/${path}`] = () => json(200, items);
}

// Answer a file download at its raw address.
function serve(path: string, text: string): void {
  answers[`${RAW}/${path}`] = () => new Response(text, { status: 200 });
}

// db/public/orders_fix holding `files`, with a README at the root that is not a script.
function registry(files: Item[]): void {
  listFolder("", [folder("db"), file("README.md")]);
  listFolder("db", [folder("db/public")]);
  listFolder("db/public", [folder(FAMILY)]);
  listFolder(FAMILY, files);
}

const UP1 = "-- Change-type: additive\nALTER TABLE orders ADD COLUMN note text;";
const DOWN1 = "ALTER TABLE orders DROP COLUMN note;";
const UP2 = "-- Change-type: patch\nCREATE INDEX orders_note_idx ON orders (note);";

async function pull(): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await GET();
  const text = await res.text();
  // The token never reaches the browser, and neither do raw download
  // addresses (for a private repository they carry their own access).
  expect(text).not.toContain(FAKE_TOKEN);
  expect(text).not.toContain("raw.example.test");
  return { status: res.status, body: JSON.parse(text) as Record<string, unknown> };
}

beforeAll(async () => {
  ({ GET } = await import("../app/api/github/pull/route"));
});

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  process.env.GITHUB_PAT = FAKE_TOKEN;
  process.env.GITHUB_REPO_OWNER = "acme";
  process.env.GITHUB_REPO_NAME = "registry";

  calls = [];
  unexpected = [];
  answers = {};
  mockRequireViewer.mockClear();
  const spy = jest.spyOn(console, "error").mockImplementation(() => {});
  restoreConsole = () => spy.mockRestore();

  global.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ method: (init?.method ?? "GET").toUpperCase(), url, init });
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
  restoreConsole();
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  expect(unexpected).toEqual([]);
  // The pull only ever reads.
  expect(calls.filter((call) => call.method !== "GET")).toEqual([]);
});

describe("GET /api/github/pull", () => {
  it("lists each version with its rollback state, and warns about a leftover rollback", async () => {
    registry([
      file(`${FAMILY}/v1.0.0.sql`),
      file(`${FAMILY}/v1.0.0.down.sql`),
      file(`${FAMILY}/v2.0.0.sql`),
      file(`${FAMILY}/v3.0.0.down.sql`),
      file(`${FAMILY}/notes.txt`),
    ]);
    serve(`${FAMILY}/v1.0.0.sql`, UP1);
    serve(`${FAMILY}/v1.0.0.down.sql`, DOWN1);
    serve(`${FAMILY}/v2.0.0.sql`, UP2);

    const { status, body } = await pull();
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    const where = { database_name: "db", schema_name: "public", script_name: "orders_fix" };
    expect(body.scripts).toEqual([
      { ...where, version: "1.0.0", path: `${FAMILY}/v1.0.0.sql`, sql_content: UP1, down_sql: DOWN1, rollback_state: "usable" },
      { ...where, version: "2.0.0", path: `${FAMILY}/v2.0.0.sql`, sql_content: UP2, rollback_state: "none" },
    ]);
    expect(body.warnings).toEqual([
      `${FAMILY}/v3.0.0.down.sql has no migration beside it (left by an earlier failed save) and is ignored. Saving v3.0.0 again removes it.`,
    ]);

    // GitHub's API gets the token in a header; raw downloads never get it.
    for (const call of calls) {
      expect(call.init?.cache).toBe("no-store");
      const headers = call.init?.headers as Record<string, string> | undefined;
      if (call.url.startsWith(RAW)) expect(headers?.Authorization).toBeUndefined();
      else expect(headers?.Authorization).toBe(`Bearer ${FAKE_TOKEN}`);
    }
  });

  it("labels a rollback that runs nothing and one that ends the transaction, and sends neither", async () => {
    registry([
      file(`${FAMILY}/v1.0.0.sql`),
      file(`${FAMILY}/v1.0.0.down.sql`),
      file(`${FAMILY}/v2.0.0.sql`),
      file(`${FAMILY}/v2.0.0.down.sql`),
    ]);
    serve(`${FAMILY}/v1.0.0.sql`, UP1);
    serve(`${FAMILY}/v1.0.0.down.sql`, "-- write the undo here\n");
    serve(`${FAMILY}/v2.0.0.sql`, UP2);
    serve(`${FAMILY}/v2.0.0.down.sql`, "DROP INDEX orders_note_idx;\nCOMMIT;");

    const { body } = await pull();
    const scripts = body.scripts as Array<Record<string, unknown>>;
    expect(scripts.map((script) => script.rollback_state)).toEqual(["no_statements", "transaction_control"]);
    expect(scripts[0]).not.toHaveProperty("down_sql");
    expect(scripts[1]).not.toHaveProperty("down_sql");
    expect(body.warnings).toEqual([]);
  });

  it("marks a rollback it could not download as unreadable, and leaves out a version it could not download", async () => {
    registry([file(`${FAMILY}/v1.0.0.sql`), file(`${FAMILY}/v1.0.0.down.sql`), file(`${FAMILY}/v2.0.0.sql`)]);
    serve(`${FAMILY}/v1.0.0.sql`, UP1);
    answers[`${RAW}/${FAMILY}/v1.0.0.down.sql`] = () => new Response("oops", { status: 500 });
    answers[`${RAW}/${FAMILY}/v2.0.0.sql`] = () => {
      throw new TypeError("fetch failed");
    };

    const { status, body } = await pull();
    expect(status).toBe(200);
    const scripts = body.scripts as Array<Record<string, unknown>>;
    expect(scripts).toHaveLength(1);
    expect(scripts[0].version).toBe("1.0.0");
    expect(scripts[0].rollback_state).toBe("unreadable");
    expect(scripts[0]).not.toHaveProperty("down_sql");
    const warnings = body.warnings as string[];
    expect(warnings).toHaveLength(2);
    expect(warnings).toContain(`Could not download ${FAMILY}/v2.0.0.sql, so v2.0.0 is left out of this list. Reload to try again.`);
    expect(warnings.some((w) => w.startsWith(`Could not download ${FAMILY}/v1.0.0.down.sql`))).toBe(true);
  });

  it("warns about a folder it could not read and still lists its neighbours", async () => {
    listFolder("", [folder("db")]);
    listFolder("db", [folder("db/public"), folder("db/sales")]);
    answers[`${ROOT}/db/sales`] = () => json(403, { message: "Forbidden by policy" });
    listFolder("db/public", [folder(FAMILY)]);
    listFolder(FAMILY, [file(`${FAMILY}/v1.0.0.sql`)]);
    serve(`${FAMILY}/v1.0.0.sql`, UP1);

    const { status, body } = await pull();
    expect(status).toBe(200);
    expect((body.scripts as unknown[]).length).toBe(1);
    const warnings = body.warnings as string[];
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('Could not read the folder "db/sales" from GitHub');
    expect(warnings[0]).not.toContain("Forbidden by policy");
  });

  it("lists versions in number order, not text order", async () => {
    registry([file(`${FAMILY}/v1.10.0.sql`), file(`${FAMILY}/v1.9.0.sql`)]);
    serve(`${FAMILY}/v1.10.0.sql`, UP1);
    serve(`${FAMILY}/v1.9.0.sql`, UP2);
    const { body } = await pull();
    expect((body.scripts as Array<Record<string, unknown>>).map((script) => script.version)).toEqual(["1.9.0", "1.10.0"]);
  });

  it("answers an empty registry once the repository is confirmed", async () => {
    answers[ROOT] = () => json(404, { message: "This repository is empty." });
    answers[REPO] = () => json(200, { full_name: "acme/registry" });
    const { status, body } = await pull();
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true, scripts: [], warnings: [] });
  });

  it("fails with a readable error when the repository can't be seen", async () => {
    answers[ROOT] = () => json(404, { message: "Not Found" });
    answers[REPO] = () => json(404, { message: "Not Found" });
    const { status, body } = await pull();
    expect(status).toBe(502);
    expect(body.ok).toBe(false);
    expect(body.code).toBe("repo_not_found");
    expect(body.error).toContain("GITHUB_REPO_OWNER");
    expect(body).not.toHaveProperty("scripts");
  });

  it("explains a rejected token without GitHub's words", async () => {
    answers[ROOT] = () => json(401, { message: "Bad credentials" });
    const { status, body } = await pull();
    expect(status).toBe(502);
    expect(body.code).toBe("token_rejected");
    expect(body.error).toContain("GITHUB_PAT");
    expect(body.error).not.toContain("Bad credentials");
  });

  it("explains GitHub not being reachable", async () => {
    answers[ROOT] = () => {
      throw new TypeError("fetch failed");
    };
    const { status, body } = await pull();
    expect(status).toBe(502);
    expect(body.code).toBe("github_unreachable");
  });

  it("says which settings are missing, by name only, and asks GitHub nothing", async () => {
    process.env.GITHUB_PAT = "";
    const { status, body } = await pull();
    expect(status).toBe(500);
    expect(body.code).toBe("github_unconfigured");
    expect(body.error).toContain("Missing now: GITHUB_PAT.");
    expect(calls).toEqual([]);
  });

  it("returns the guard's answer when the viewer may not read", async () => {
    mockRequireViewer.mockImplementationOnce(async () => ({
      ok: false,
      response: NextResponse.json({ ok: false, error: "Sign in to see this." }, { status: 401 }),
    }));
    const { status } = await pull();
    expect(status).toBe(401);
    expect(calls).toEqual([]);
  });
});
