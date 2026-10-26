/** @jest-environment jsdom */
// api-fetch: every call a screen makes to this app's API says which
// organization the page is open in.
//
// The API routes are the same for every organization (/api/...), so the gate
// in lib/auth-guard.ts learns the organization from the ORG_HEADER that
// lib/api-fetch.ts adds. A screen that called fetch() directly would send no
// header; on the web the gate answers that with a 404, so the screen would
// simply stop working, and nothing about it would fail to compile. The first
// tests check the wrapper; the last reads the source and fails on any direct
// fetch() call a screen makes.
import fs from "fs";
import path from "path";
import ts from "typescript";
import { apiFetch } from "@/lib/api-fetch";
import { ORG_HEADER } from "@/lib/org-slug";

const ROOT = path.join(__dirname, "..");

describe("apiFetch", () => {
  const fetchMock = jest.fn<Promise<Response>, unknown[]>(async () => ({}) as Response);

  beforeEach(() => {
    fetchMock.mockClear();
    (globalThis as { fetch?: unknown }).fetch = fetchMock;
  });

  afterEach(() => {
    delete (globalThis as { fetch?: unknown }).fetch;
    window.history.replaceState(null, "", "/");
  });

  function sentHeaders(): Headers {
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    return new Headers(init.headers);
  }

  test("names the organization the page is open in", async () => {
    window.history.replaceState(null, "", "/acme/compare?left=1");
    await apiFetch("/api/connections");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/connections");
    expect(sentHeaders().get(ORG_HEADER)).toBe("acme");
  });

  test("keeps the caller's own options and headers", async () => {
    window.history.replaceState(null, "", "/acme/deploy");
    const body = JSON.stringify({ id: 4 });
    await apiFetch("/api/scripts/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(init.body).toBe(body);
    expect(sentHeaders().get("content-type")).toBe("application/json");
    expect(sentHeaders().get(ORG_HEADER)).toBe("acme");
  });

  test("the page's organization wins over one the caller passed", async () => {
    // The address is what the person is looking at, so a call can never act
    // in an organization other than the one on screen.
    window.history.replaceState(null, "", "/acme/studio");
    await apiFetch("/api/me", { headers: { [ORG_HEADER]: "other-org" } });
    expect(sentHeaders().get(ORG_HEADER)).toBe("acme");
  });

  test("reads the address at the moment of the call", async () => {
    window.history.replaceState(null, "", "/acme/studio");
    await apiFetch("/api/me");
    window.history.replaceState(null, "", "/beta-team/studio");
    await apiFetch("/api/me");
    expect(new Headers((fetchMock.mock.calls[1][1] as RequestInit).headers).get(ORG_HEADER)).toBe(
      "beta-team"
    );
  });

  test("sends no header from an address that names no organization", async () => {
    for (const address of ["/", "/studio", "/login"]) {
      fetchMock.mockClear();
      window.history.replaceState(null, "", address);
      const init = { method: "GET" };
      await apiFetch("/api/me", init);
      // Passed through untouched, so a test at "/" sees exactly what the
      // screen asked for.
      expect(fetchMock).toHaveBeenCalledWith("/api/me", init);
    }
  });
});

// ---------------------------------------------------------------------------
// No screen calls fetch() directly.

/** The folders that hold screens and the code they call. app/api is the server's own. */
const DIRS = ["app", "components", "hooks", "lib"];
const EXTENSIONS = /\.(ts|tsx)$/;

/**
 * The files that may call fetch() directly, and why. Each is a call that does
 * not go to an organization's part of this app's API.
 */
const ALLOWED: Record<string, string> = {
  [path.join("lib", "api-fetch.ts")]: "the wrapper itself",
  [path.join("lib", "github-registry.ts")]: "the server's own calls to GitHub",
  [path.join("app", "login", "page.tsx")]:
    "the sign-in page reads NextAuth's providers, which belong to no organization",
};

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (path.relative(ROOT, full) !== path.join("app", "api")) out.push(...sourceFiles(full));
    } else if (EXTENSIONS.test(entry.name) && !entry.name.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

/** True for fetch(...), window.fetch(...), globalThis.fetch(...) and self.fetch(...). */
function isDirectFetch(call: ts.CallExpression): boolean {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return callee.text === "fetch";
  return (
    ts.isPropertyAccessExpression(callee) &&
    callee.name.text === "fetch" &&
    ts.isIdentifier(callee.expression) &&
    ["window", "globalThis", "self"].includes(callee.expression.text)
  );
}

type Call = { file: string; line: number; direct: boolean };

function callsIn(file: string, text = fs.readFileSync(file, "utf8")): Call[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: Call[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const direct = isDirectFetch(node);
      const wrapped = ts.isIdentifier(node.expression) && node.expression.text === "apiFetch";
      if (direct || wrapped) {
        found.push({
          file: path.relative(ROOT, file),
          line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
          direct,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

const calls = DIRS.flatMap((dir) => sourceFiles(path.join(ROOT, dir))).flatMap((file) =>
  callsIn(file)
);

test("the scan tells a direct fetch from the wrapper", () => {
  // Checked on samples, so a scan that stopped matching cannot pass the real
  // source by finding nothing.
  const sample = [
    'fetch("/api/me");',
    "window.fetch(url);",
    "globalThis.fetch(url, init);",
    'apiFetch("/api/me");',
    "client.fetch(url);",
    "const x = { fetch: 1 };",
  ].join("\n");
  const found = callsIn(path.join(ROOT, "sample.tsx"), sample);
  expect(found.map((call) => [call.line, call.direct])).toEqual([
    [1, true],
    [2, true],
    [3, true],
    [4, false],
  ]);
});

test("the scan finds the screens' API calls", () => {
  // A guard on the guard: the screens make about eighty API calls, and a walk
  // that found few of them would pass the test below for nothing.
  expect(calls.filter((call) => !call.direct).length).toBeGreaterThan(60);
  const files = new Set(calls.map((call) => call.file));
  expect(files).toContain(path.join("hooks", "useUser.ts"));
  expect(files).toContain(path.join("components", "admin", "RolesTab.tsx"));
});

test("no screen calls fetch() directly", () => {
  const direct = calls
    .filter((call) => call.direct && !(call.file in ALLOWED))
    .map((call) => `${call.file}:${call.line}`);
  expect(direct).toEqual([]);
});

test("every file allowed a direct fetch() still makes one", () => {
  // An entry left behind after its call is gone would quietly exempt the next
  // fetch() someone adds to that file.
  const stale = Object.keys(ALLOWED).filter(
    (file) => !calls.some((call) => call.file === file && call.direct)
  );
  expect(stale).toEqual([]);
});
