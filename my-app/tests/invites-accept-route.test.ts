// invites-accept-route: taking an invitation (app/api/invites/accept/route.ts).
//
// Whether an invitation can be taken, and what taking it writes, is
// lib/invites-db.ts acceptInvite's to decide, and tests/invites-db.test.ts
// holds it to that against a real database. Here acceptInvite and the gate are
// stood in for, so these tests cover only what the route adds on top:
//
//   - The gate comes first, and a refusal is passed on as it came.
//   - Nobody can join on the desktop or with sign-in switched off, and the
//     body is not read there.
//   - The token from the body is passed on as it came, with the caller's own
//     profile. Nothing else in the body counts. A body with no token is passed
//     on as an empty one, which acceptInvite turns down as invalid.
//   - Each answer from acceptInvite has its own status. Joining and being in
//     already both name the organization to open. No refusal names the
//     organization, and each one that the invitation page can redraw from
//     says which view to draw (`state`).
//   - A database that is down reads as "try again", with the reason kept to
//     the log.
import { NextRequest, NextResponse } from "next/server";
import type { SignedInGate } from "@/lib/auth-guard";

let mockGate: SignedInGate;
let mockGateCalls = 0;
jest.mock("../lib/auth-guard", () => ({
  requireSignedIn: async () => {
    mockGateCalls += 1;
    return mockGate;
  },
}));

const mockAcceptInvite = jest.fn();
jest.mock("../lib/invites-db", () => ({
  acceptInvite: (...args: unknown[]) => mockAcceptInvite(...args),
}));

import { POST } from "@/app/api/invites/accept/route";

/** Ed's profile ID. */
const ED = 31;
const SIGNED_IN: SignedInGate = { ok: true, caller: { profileId: ED, bypass: false } };
const BYPASS: SignedInGate = { ok: true, caller: { profileId: null, bypass: true } };

const TOKEN = "Abc_def-123".padEnd(43, "x");
const ACME = { slug: "acme", name: "Acme" };

const DESKTOP = process.env.SCHEMA_STUDIO_DESKTOP;

beforeEach(() => {
  mockGate = SIGNED_IN;
  mockGateCalls = 0;
  delete process.env.SCHEMA_STUDIO_DESKTOP;
  mockAcceptInvite.mockReset();
});

afterEach(() => {
  jest.restoreAllMocks();
  if (DESKTOP === undefined) delete process.env.SCHEMA_STUDIO_DESKTOP;
  else process.env.SCHEMA_STUDIO_DESKTOP = DESKTOP;
});

/** A POST to the route with this body, sent as it is when it is a string. */
function post(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/invites/accept", {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

async function answer(response: Response): Promise<[number, unknown]> {
  return [response.status, await response.json()];
}

describe("before anything is read", () => {
  test("a refusal from the gate is passed on as it came", async () => {
    const refused = NextResponse.json({ error: "Sign in to continue." }, { status: 401 });
    mockGate = { ok: false, response: refused };
    const request = post({ token: TOKEN });

    expect(await POST(request)).toBe(refused);
    expect(mockGateCalls).toBe(1);
    expect(request.bodyUsed).toBe(false);
    expect(mockAcceptInvite).not.toHaveBeenCalled();
  });

  test.each([
    [
      "on the desktop",
      () => (process.env.SCHEMA_STUDIO_DESKTOP = "1"),
      "The desktop app keeps a single organization of its own.",
    ],
    [
      "with sign-in switched off",
      () => (mockGate = BYPASS),
      "Taking an invitation needs a real sign-in. The demo has nobody to join as.",
    ],
    [
      "on the desktop, even with sign-in switched off as well",
      () => {
        process.env.SCHEMA_STUDIO_DESKTOP = "1";
        mockGate = BYPASS;
      },
      "The desktop app keeps a single organization of its own.",
    ],
  ])("nobody can join %s, and the body is not read", async (_, setUp, error) => {
    setUp();
    const request = post({ token: TOKEN });

    expect(await answer(await POST(request))).toEqual([403, { error }]);
    expect(request.bodyUsed).toBe(false);
    expect(mockAcceptInvite).not.toHaveBeenCalled();
  });
});

describe("the body", () => {
  test("text that is not JSON is turned down, and nothing is passed on", async () => {
    expect(await answer(await POST(post(`token=${TOKEN}`)))).toEqual([
      400,
      { error: "Expected a JSON body." },
    ]);
    expect(mockAcceptInvite).not.toHaveBeenCalled();
  });

  test("the token is passed on as it came, with the caller's own profile and nothing else", async () => {
    mockAcceptInvite.mockResolvedValue({ kind: "joined", organization: ACME });

    // Spaces and all: a token that is not exactly right is not one, and
    // acceptInvite is the one to say so.
    await POST(post({ token: ` ${TOKEN}`, profileId: 1, orgId: 99 }));
    expect(mockAcceptInvite.mock.calls).toEqual([[` ${TOKEN}`, ED]]);
  });

  test.each([
    ["no token", {}],
    ["a token that is not a string", { token: 42 }],
    ["null", null],
    ["a list", [TOKEN]],
  ])("%s is passed on as an empty token", async (_, body) => {
    mockAcceptInvite.mockResolvedValue({ kind: "invalid" });

    const [status] = await answer(await POST(post(body)));
    expect(status).toBe(404);
    expect(mockAcceptInvite.mock.calls).toEqual([["", ED]]);
  });
});

describe("the answer", () => {
  test.each([
    ["joined", { kind: "joined", organization: ACME }, 200, { organization: ACME, joined: true }],
    // A second press of Join: still the organization to open.
    ["in already", { kind: "member", organization: ACME }, 200, { organization: ACME, joined: false }],
    [
      "no such invitation",
      { kind: "invalid" },
      404,
      { error: "This invitation link does not work. Check it was copied whole.", state: "invalid" },
    ],
    [
      "cancelled",
      { kind: "revoked" },
      410,
      { error: "This invitation was cancelled. Ask for a new one.", state: "revoked" },
    ],
    [
      "run out",
      { kind: "expired" },
      410,
      { error: "This invitation has run out. Ask for a new one.", state: "expired" },
    ],
    [
      "used",
      { kind: "used" },
      410,
      { error: "This invitation has been used already.", state: "used" },
    ],
    [
      "for another account",
      { kind: "wrong-account", organization: ACME, maskedEmail: "a•••@example.com" },
      403,
      {
        error: "This invitation is for a•••@example.com. Sign in with that address to take it.",
        state: "wrong-account",
      },
    ],
    // The profile was deleted since sign-in. A 401 is what sends the page's
    // Join card to "Sign in again".
    ["a profile that is gone", { kind: "no-profile" }, 401, { error: "Sign in again to continue." }],
  ])("%s", async (_, result, status, body) => {
    mockAcceptInvite.mockResolvedValue(result);

    expect(await answer(await POST(post({ token: TOKEN })))).toEqual([status, body]);
  });

  test("says the database may be down when the invitation cannot be taken", async () => {
    const logged = jest.spyOn(console, "error").mockImplementation(() => {});
    mockAcceptInvite.mockRejectedValue(new Error("connect ECONNREFUSED 127.0.0.1:5433"));

    expect(await answer(await POST(post({ token: TOKEN })))).toEqual([
      503,
      {
        error:
          "Could not take the invitation. The app's database may be unreachable. " +
          "Try again in a moment.",
      },
    ]);
    // The reason goes to the server's log, not to the screen.
    expect(logged).toHaveBeenCalledTimes(1);
  });
});
