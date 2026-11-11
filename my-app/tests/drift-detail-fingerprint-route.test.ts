// GET /api/lineage/drift: the fingerprint of the differences it sends.
//
// The Drift screen shows these differences and offers "Re-baseline", which
// accepts the live schema as the new baseline. The live schema can change
// between this read and that click, so the answer carries a fingerprint of the
// differences, the screen sends it back with the click, and the re-baseline
// route refuses when what is live no longer gives the same fingerprint
// (tests/rebaseline-stale-read.test.ts). Without the fingerprint here that
// check would be skipped without a word.
//
// Nothing here reaches a database: the drift read is a stand-in.
import { NextRequest } from "next/server";
import { compareSchemas } from "../lib/compare";
import { driftFingerprint } from "../lib/drift-fingerprint";
import { column, schema, table } from "./helpers/snapshots";

// Relative paths on purpose: next/jest rewrites the @/ alias inside import
// statements only, so jest.mock("@/...") would not resolve.
jest.mock("../lib/auth-guard", () => ({
  requirePermission: async () => ({
    ok: true,
    principal: require("./helpers/principals").principalFor("editor"),
  }),
}));

let mockView: Record<string, unknown> | null = null;
jest.mock("../lib/lineage-db", () => ({
  getDriftDetail: async () => mockView,
}));
jest.mock("../lib/drift-runner", () => ({ runDriftCheck: async () => null }));

import { GET } from "../app/api/lineage/drift/route";

const read = () => GET(new NextRequest("http://localhost/api/lineage/drift?trackedSchemaId=1"));

// The baseline has one table; the live schema has gained a column.
const expected = schema([table("invoices", [column("id")])]);
const live = schema([table("invoices", [column("id"), column("notes")])]);

describe("the drift detail's fingerprint", () => {
  it("sends the fingerprint of the differences it sends", async () => {
    const report = compareSchemas(expected, live);
    mockView = { status: "drifted", report };

    const answer = await (await read()).json();

    expect(answer.status).toBe("drifted");
    expect(answer.fingerprint).toBe(driftFingerprint(report));
    expect(answer.fingerprint).not.toBe(driftFingerprint(compareSchemas(expected, expected)));
  });

  it("sends no fingerprint when there are no differences to show", async () => {
    // Never checked, or unreachable: the screen was shown nothing to hold a
    // re-baseline to.
    mockView = { status: "unreachable", report: null };

    const answer = await (await read()).json();

    expect(answer.fingerprint).toBeNull();
  });
});
