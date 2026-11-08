// The Compare summary route and the shared limits, after the review fixes.
//
//   - A body of JSON null is refused like any other bad JSON (U34).
//   - Where the query names its targets, only the asked target is compared,
//     and the row compare is left out (U64).
//   - The Script Editor reads the request limit the route enforces (U62).
//
// The panels themselves are in tests/ai-fix-ui.test.tsx.

import { NextRequest } from "next/server";

jest.mock("../lib/version-db", () => ({
  __esModule: true,
  default: {},
  syncMetadataTables: async () => undefined,
}));

jest.mock("../lib/auth-guard", () => ({
  requirePermission: async () => ({ ok: true, principal: require("./helpers/principals").principalFor("admin") }),
}));

// AI is on for this organization: the route asks before it compares.
jest.mock("../lib/ai/respond", () => ({
  ...jest.requireActual("../lib/ai/respond"),
  aiGateRefusal: async () => null,
}));

/** Every query the route ran a comparison with. */
const mockRuns: URLSearchParams[] = [];

// The first target has no report, with a message of its own, so a test can
// tell which outcome the route read without building a real report.
jest.mock("../lib/compare-run", () => ({
  runComparison: async (_orgId: number, params: URLSearchParams) => {
    mockRuns.push(new URLSearchParams(params));
    return { kind: "ready", allowDataLoss: false, outcomes: [{ index: 0, report: null, error: "Outcome 0." }] };
  },
}));

import { POST } from "@/app/api/compare/summary/route";
import { MAX_REQUEST_CHARS as SERVER_MAX } from "@/lib/ai/features/sql-generate";
import { MAX_REQUEST_CHARS as EDITOR_MAX } from "@/lib/ai/features/sql-generate-view";

function send(body: string): NextRequest {
  return new NextRequest("http://localhost/api/compare/summary", {
    method: "POST",
    body,
    headers: { "content-type": "application/json" },
  });
}

async function ask(body: unknown): Promise<[number, { error?: string }]> {
  const response = await POST(send(JSON.stringify(body)));
  return [response.status, await response.json()];
}

beforeEach(() => {
  mockRuns.length = 0;
});

describe("POST /api/compare/summary, the body", () => {
  test.each([["null"], ["3"], ['"text"'], ["[1]"], ["{broken"]])("refuses %s with a 400", async (text) => {
    const response = await POST(send(text));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid JSON in request body." });
    expect(mockRuns).toHaveLength(0);
  });
});

describe("POST /api/compare/summary, what it compares", () => {
  const screenQuery = [
    "source=1",
    "sourceSchema=public",
    "targetConnection=5",
    "targetConnection=7",
    "targetConnection=9",
    "targetSchema=a",
    "targetSchema=b",
    "targetSchema=c",
    "allowDataLoss=1",
    "compareData=1",
    "dataTable=books",
    "run=1",
  ].join("&");

  test("compares only the asked target, without the row compare", async () => {
    const [status, body] = await ask({ query: screenQuery, target: 1 });
    expect(mockRuns).toHaveLength(1);
    const params = mockRuns[0];
    expect(params.getAll("targetConnection")).toEqual(["7"]);
    expect(params.getAll("targetSchema")).toEqual(["b"]);
    expect(params.has("compareData")).toBe(false);
    expect(params.has("dataTable")).toBe(false);
    // The rest of the screen's choices stay.
    expect(params.get("source")).toBe("1");
    expect(params.get("allowDataLoss")).toBe("1");
    expect(params.get("run")).toBe("1");
    // The one target left is the first outcome.
    expect([status, body.error]).toEqual([409, "Outcome 0."]);
  });

  test("reads the right-hand names when the query uses them", async () => {
    await ask({ query: "rightConnection=5&rightConnection=7&rightSchema=a&rightSchema=b", target: 1 });
    expect(mockRuns[0].getAll("targetConnection")).toEqual(["7"]);
    expect(mockRuns[0].getAll("targetSchema")).toEqual(["b"]);
    expect(mockRuns[0].has("rightConnection")).toBe(false);
  });

  test("leaves a saved-set link whole, since only the set knows its targets", async () => {
    await ask({ query: "set=4&compareData=1", target: 2 });
    expect(mockRuns[0].get("set")).toBe("4");
    expect(mockRuns[0].get("compareData")).toBe("1");
    expect(mockRuns[0].has("targetConnection")).toBe(false);
  });

  test("leaves a query that adds or removes a target whole", async () => {
    await ask({ query: `${screenQuery}&removeTarget=0`, target: 1 });
    expect(mockRuns[0].getAll("targetConnection")).toEqual(["5", "7", "9"]);
  });
});

describe("the Script Editor's request limit", () => {
  test("is the route's own", () => {
    expect(EDITOR_MAX).toBe(SERVER_MAX);
    expect(EDITOR_MAX).toBe(2_000);
  });
});
