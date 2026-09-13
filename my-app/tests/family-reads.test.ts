/**
 * lib/family-reads.ts: the two reads both push screens take the next version
 * from. fetch is replaced with a stub that answers only the one request each
 * test expects and fails for anything else, so nothing here can reach GitHub
 * or a database.
 */
import { readAppliedVersion, readFamilyVersions } from "../lib/family-reads";

type Answer = { status: number; body: unknown } | "network-error";

const realFetch = global.fetch;
let calls: { url: string; init?: RequestInit }[] = [];

/** Only the fields the helpers read. A string body that is not JSON makes json() throw. */
function fakeResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => (typeof body === "string" ? JSON.parse(body) : body),
  } as unknown as Response;
}

/** Answer exactly one expected URL; any other request throws. */
function stubFetch(expectedUrl: string, answer: Answer) {
  calls = [];
  global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url !== expectedUrl) throw new Error(`Unexpected request in test: ${url}`);
    if (answer === "network-error") throw new TypeError("fetch failed");
    return fakeResponse(answer.status, answer.body);
  }) as unknown as typeof fetch;
}

afterEach(() => {
  global.fetch = realFetch;
});

const FAMILY_URL = "/api/github/family?database=shop&schema=public&script=add_invoices";

describe("readFamilyVersions", () => {
  it("returns the versions GitHub lists, skipping anything that is not text", async () => {
    stubFetch(FAMILY_URL, { status: 200, body: { ok: true, versions: ["1.0.0", "1.1.0", 3], highest: "1.1.0" } });
    await expect(readFamilyVersions("shop", "public", "add_invoices")).resolves.toEqual({
      ok: true,
      versions: ["1.0.0", "1.1.0"],
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].init?.cache).toBe("no-store");
  });

  it("encodes the names in the query string", async () => {
    stubFetch("/api/github/family?database=my+db&schema=s%2F1&script=x", { status: 200, body: { ok: true, versions: [] } });
    await expect(readFamilyVersions("my db", "s/1", "x")).resolves.toEqual({ ok: true, versions: [] });
  });

  it("passes on the route's own message when GitHub could not be read", async () => {
    const error = 'Could not read the versions of "add_invoices" from GitHub (status 502). The next version can\'t be worked out until it can.';
    stubFetch(FAMILY_URL, { status: 502, body: { ok: false, error } });
    await expect(readFamilyVersions("shop", "public", "add_invoices")).resolves.toEqual({ ok: false, error });
  });

  it("names the status when the answer is not JSON", async () => {
    stubFetch(FAMILY_URL, { status: 500, body: "<html>oops</html>" });
    await expect(readFamilyVersions("shop", "public", "add_invoices")).resolves.toEqual({
      ok: false,
      error: 'Could not read the versions of "add_invoices" from GitHub (status 500). The next version can\'t be worked out until it can.',
    });
  });

  it("says the server could not be reached when the request itself fails", async () => {
    stubFetch(FAMILY_URL, "network-error");
    const read = await readFamilyVersions("shop", "public", "add_invoices");
    expect(read.ok).toBe(false);
    expect(read.ok === false && read.error).toBe(
      'Could not reach the server to read the versions of "add_invoices" from GitHub. The next version can\'t be worked out until it can.',
    );
  });
});

describe("readAppliedVersion", () => {
  it("asks the preflight route for the family and returns its version without a leading v", async () => {
    stubFetch("/api/scripts/preflight", { status: 200, body: { currentVersion: " v1.2.0.3 " } });
    await expect(readAppliedVersion(7, "public", "add_invoices")).resolves.toEqual({ ok: true, version: "1.2.0.3" });
    expect(calls[0].init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      connectionId: 7,
      schemaName: "public",
      scriptName: "add_invoices",
    });
  });

  it("counts a value that is not a version, or no value, as nothing applied", async () => {
    stubFetch("/api/scripts/preflight", { status: 200, body: { currentVersion: "init" } });
    await expect(readAppliedVersion(7, "public", "x")).resolves.toEqual({ ok: true, version: null });
    stubFetch("/api/scripts/preflight", { status: 200, body: { currentVersion: null } });
    await expect(readAppliedVersion(7, "public", "x")).resolves.toEqual({ ok: true, version: null });
  });

  it("reports a failed read, never a missing version, when the route or the network fails", async () => {
    stubFetch("/api/scripts/preflight", { status: 500, body: { error: "Could not connect" } });
    await expect(readAppliedVersion(7, "public", "x")).resolves.toEqual({ ok: false });
    stubFetch("/api/scripts/preflight", "network-error");
    await expect(readAppliedVersion(7, "public", "x")).resolves.toEqual({ ok: false });
  });
});
