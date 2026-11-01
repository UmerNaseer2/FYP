// me-approver-route: GET /api/me/approver, which tells the desktop app who a
// paired phone's passkey is for (app/api/me/approver/route.ts).
//
// Any member may ask, whatever their role, because someone may set up a passkey
// to deploy without being able to read the approval queue. The answer holds a
// hash of the email and never the email itself.
import type { Gate } from "@/lib/auth-guard";
import { approverKey } from "@/lib/approvals-db";
import { principalFor } from "./helpers/principals";

let mockGate: Gate;

jest.mock("../lib/auth-guard", () => ({
  requireMember: async () => mockGate,
}));

// Relative path on purpose: next/jest rewrites the @/ alias inside import
// statements only, so jest.mock("@/...") would not resolve.
jest.mock("../lib/version-db", () => ({
  __esModule: true,
  default: { query: async () => ({ rows: [] }) },
  syncMetadataTables: async () => undefined,
}));

import { GET } from "../app/api/me/approver/route";

describe("GET /api/me/approver", () => {
  it("answers the gate's refusal for somebody who is not a member", async () => {
    const refusal = Response.json({ error: "no" }, { status: 404 });
    mockGate = { ok: false, response: refusal } as unknown as Gate;
    expect((await GET()).status).toBe(404);
  });

  it("gives the hash of the signed-in email and never the email", async () => {
    const principal = principalFor("editor");
    mockGate = { ok: true, principal };
    const answer = await (await GET()).json();
    expect(answer.approver).toBe(approverKey(principal.email));
    expect(answer.approver).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(answer)).not.toContain(principal.email);
  });

  it("says what a viewer, an editor and an admin may use a passkey for", async () => {
    mockGate = { ok: true, principal: principalFor("viewer") };
    let answer = await (await GET()).json();
    expect(answer).toMatchObject({ canApprove: false, canControl: false });

    mockGate = { ok: true, principal: principalFor("editor") };
    answer = await (await GET()).json();
    expect(answer).toMatchObject({ canApprove: false, canControl: true });

    mockGate = { ok: true, principal: principalFor("admin") };
    answer = await (await GET()).json();
    expect(answer).toMatchObject({ canApprove: true, canControl: true });
  });

  it.each(["deploy:run", "approvals:create", "performance:update"])(
    "counts %s alone as a reason to hold a passkey",
    async (key) => {
      mockGate = { ok: true, principal: { ...principalFor("viewer"), permissions: [key] } } as unknown as Gate;
      expect(await (await GET()).json()).toMatchObject({ canControl: true });
    },
  );
});
