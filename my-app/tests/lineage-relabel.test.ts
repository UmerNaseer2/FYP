// PATCH /api/lineage: taking the Production label off a tracked schema.
//
// A tracked schema's label counts as much as its connection's: the louder of
// the two decides whether a deploy waits for an approval. So taking the
// Production label off a schema needs the same permission as taking it off a
// connection (lib/environment-guard). Putting it on stays open to editors.
//
// The metadata database and the auth gate are stand-ins. Nothing is dialled.
import { NextRequest } from "next/server";
import { TEST_ORG } from "./helpers/principals";

let mockRole: "editor" | "admin" = "editor";
jest.mock("../lib/auth-guard", () => ({
  requirePermission: async () => ({
    ok: true,
    principal: require("./helpers/principals").principalFor(mockRole),
  }),
}));

const mockPoolQuery = jest.fn<Promise<unknown>, unknown[]>(async () => ({ rows: [] }));
jest.mock("../lib/version-db", () => ({
  __esModule: true,
  default: { query: (...args: unknown[]) => mockPoolQuery(...args) },
  syncMetadataTables: async () => undefined,
}));
jest.mock("../lib/lineage-db", () => ({ listTrackedSchemas: async () => [] }));

import { PATCH } from "@/app/api/lineage/route";

/** The tracked schema 5 is labelled `environment` in the caller's organization. */
function labelled(environment: string) {
  mockPoolQuery.mockReset();
  mockPoolQuery.mockImplementation(async (text: unknown, values: unknown) => {
    if (/^\s*SELECT schema_name, environment FROM tracked_schemas/.test(String(text))) {
      return { rows: [{ schema_name: "sales", environment }] };
    }
    if (/^\s*UPDATE tracked_schemas/.test(String(text))) {
      return { rows: [{ id: 5, environment: (values as unknown[])[0] }] };
    }
    return { rows: [] };
  });
}

async function relabel(environment: string) {
  const response = await PATCH(
    new NextRequest("http://localhost/api/lineage", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: 5, environment }),
    })
  );
  return { status: response.status, body: await response.json() };
}

const updates = () => mockPoolQuery.mock.calls.filter(([text]) => /UPDATE tracked_schemas/.test(String(text)));

afterEach(() => {
  mockRole = "editor";
});

it("refuses an editor who takes the Production label off, and writes nothing", async () => {
  labelled("prod");
  const result = await relabel("dev");
  expect(result.status).toBe(403);
  expect(result.body.error).toMatch(/take the Production label off schema "sales"/);
  expect(updates()).toHaveLength(0);
  const [, values] = mockPoolQuery.mock.calls[0];
  expect(values).toEqual([5, TEST_ORG.id]);
});

it("lets an editor put the label on, or change a label that is not Production", async () => {
  labelled("dev");
  expect((await relabel("prod")).status).toBe(200);
  labelled("unset");
  expect((await relabel("staging")).status).toBe(200);
  expect(updates()).toHaveLength(1);
});

it("lets an admin take the label off, without the extra read", async () => {
  mockRole = "admin";
  labelled("prod");
  const result = await relabel("dev");
  expect(result.status).toBe(200);
  expect(updates()).toHaveLength(1);
  expect(mockPoolQuery.mock.calls.some(([text]) => /SELECT schema_name/.test(String(text)))).toBe(false);
});

it("leaves a schema that is not tracked to the usual not-found answer", async () => {
  mockPoolQuery.mockReset();
  mockPoolQuery.mockResolvedValue({ rows: [] });
  expect((await relabel("dev")).status).toBe(404);
});
