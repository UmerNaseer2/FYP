/**
 * The server half of an invitation (app/invite/[token]/page.tsx).
 *
 * What an invitation is to whoever opens it is lib/invites-db.ts
 * inspectInvite's to decide, and tests/invites-db.test.ts holds it to that
 * against a real database. Here inspectInvite and the gate are stood in for, so
 * these tests cover only what the page adds on top:
 *
 * - Inside the desktop app, which keeps a single organization of its own, it
 *   forwards to /studio without looking anything up.
 * - A session with no profile in it is shown "signed-out", and the demo (sign-in
 *   switched off) "demo", both without looking anything up.
 * - Otherwise the invitation is looked up for the caller's own profile, and
 *   what came back is handed to the client half as it is.
 * - A lookup that fails is shown "unavailable", with the reason kept to the
 *   log, and the token kept out of it.
 * - Its address does not travel: no referrer, and not indexed.
 *
 * Node, not jsdom, as in tests/page-onboarding-server.test.ts: the page is
 * called as a function and its answer inspected as a React element. What the
 * client half draws is tests/page-invite.test.tsx.
 */
import type { ReactElement } from "react";
import { NextResponse } from "next/server";
import type { SignedInGate } from "@/lib/auth-guard";
import Invite, { dynamic, metadata } from "@/app/invite/[token]/page";
import { InvitePage, type InviteView } from "@/components/invite/InvitePage";

// Relative paths on purpose: next/jest rewrites the @/ alias inside import
// statements only, so jest.mock("@/...") would not resolve.

// redirect() works by throwing, and the stand-in does too, so a case that
// forgot to stop would come back as a page instead of passing by accident.
const mockRedirects: string[] = [];
jest.mock("next/navigation", () => ({
  redirect: (href: string) => {
    mockRedirects.push(href);
    throw new Error("NEXT_REDIRECT");
  },
}));

// next-auth ships as ESM, which Jest cannot load, and signing out is reached
// only through the client half.
jest.mock("../lib/sign-out", () => ({ signOutEverywhere: jest.fn() }));

// A getter, so each case's change is what the page reads.
const mockFlags = { desktopMode: false };
jest.mock("../auth.config", () => ({
  get desktopMode() {
    return mockFlags.desktopMode;
  },
}));

let mockGate: SignedInGate;
let mockGateCalls = 0;
jest.mock("../lib/auth-guard", () => ({
  requireSignedIn: async () => {
    mockGateCalls += 1;
    return mockGate;
  },
}));

const mockInspectInvite = jest.fn();
jest.mock("../lib/invites-db", () => ({
  inspectInvite: (...args: unknown[]) => mockInspectInvite(...args),
}));

/** Ed's profile ID. */
const ED = 31;
const SIGNED_IN: SignedInGate = { ok: true, caller: { profileId: ED, bypass: false } };
const BYPASS: SignedInGate = { ok: true, caller: { profileId: null, bypass: true } };

const TOKEN = "Abc_def-123".padEnd(43, "x");

beforeEach(() => {
  mockRedirects.length = 0;
  mockFlags.desktopMode = false;
  mockGate = SIGNED_IN;
  mockGateCalls = 0;
  mockInspectInvite.mockReset();
});

afterEach(() => {
  jest.restoreAllMocks();
});

type Props = { token: string; view: InviteView };

/** The page for this token, as Next.js calls it. */
async function page(token = TOKEN): Promise<ReactElement<Props>> {
  return (await Invite({ params: Promise.resolve({ token }) })) as ReactElement<Props>;
}

describe("on the desktop", () => {
  test.each([
    ["", () => {}],
    // The desktop wins: it has no invitations whether sign-in is on or not.
    [" even with sign-in switched off", () => (mockGate = BYPASS)],
  ])("forwards to /studio%s, looking nothing up", async (_, setUp) => {
    mockFlags.desktopMode = true;
    setUp();

    await expect(page()).rejects.toThrow("NEXT_REDIRECT");
    expect(mockRedirects).toEqual(["/studio"]);
    expect(mockGateCalls).toBe(0);
    expect(mockInspectInvite).not.toHaveBeenCalled();
  });
});

describe("who is asking", () => {
  test("a session with no profile in it is asked to sign in again, and nothing is looked up", async () => {
    mockGate = {
      ok: false,
      response: NextResponse.json({ error: "Sign in to continue." }, { status: 401 }),
    };

    const element = await page();
    expect(element.type).toBe(InvitePage);
    expect(element.props).toEqual({ token: TOKEN, view: { kind: "signed-out" } });
    expect(mockInspectInvite).not.toHaveBeenCalled();
  });

  test("the demo has nobody to join as, so nothing is looked up", async () => {
    mockGate = BYPASS;

    const element = await page();
    expect(element.type).toBe(InvitePage);
    expect(element.props).toEqual({ token: TOKEN, view: { kind: "demo" } });
    expect(mockInspectInvite).not.toHaveBeenCalled();
  });
});

describe("the lookup", () => {
  test.each<[string, InviteView]>([
    [
      "an invitation that can be taken",
      {
        kind: "ok",
        organization: { slug: "acme", name: "Acme" },
        role: "developer",
        roleLabel: "Developer",
        invite: "email",
      },
    ],
    ["one that cannot", { kind: "expired" }],
  ])("%s is looked up for the caller's own profile and handed over as it came", async (_, found) => {
    mockInspectInvite.mockResolvedValue(found);

    const element = await page();
    expect(mockInspectInvite.mock.calls).toEqual([[TOKEN, ED]]);
    expect(mockRedirects).toEqual([]);
    expect(element.type).toBe(InvitePage);
    expect(element.props).toEqual({ token: TOKEN, view: found });
  });

  test("the token is looked up as it came in the address", async () => {
    // Whatever Next.js decoded the path to. A token that is not exactly right
    // is not one, and inspectInvite is the one to say so.
    mockInspectInvite.mockResolvedValue({ kind: "invalid" });

    const element = await page("not a token");
    expect(mockInspectInvite.mock.calls).toEqual([["not a token", ED]]);
    expect(element.props).toEqual({ token: "not a token", view: { kind: "invalid" } });
  });

  test("a lookup that fails shows the page as unavailable, logging the reason but never the token", async () => {
    const logged = jest.spyOn(console, "error").mockImplementation(() => {});
    const reason = new Error("connect ECONNREFUSED 127.0.0.1:5433");
    mockInspectInvite.mockRejectedValue(reason);

    const element = await page();
    expect(element.type).toBe(InvitePage);
    expect(element.props).toEqual({ token: TOKEN, view: { kind: "unavailable" } });
    expect(logged.mock.calls).toEqual([["Failed to look up an invitation:", reason]]);
    // Whoever reads the log could take the invitation with it.
    expect(logged.mock.calls.flat().map(String).join(" ")).not.toContain(TOKEN);
  });
});

describe("the page itself", () => {
  test("its address is not passed on as a referrer, and it is not indexed", () => {
    expect(metadata).toEqual({
      referrer: "no-referrer",
      robots: { index: false, follow: false },
    });
  });

  test("is drawn on every request, so nobody is shown an answer meant for someone else", () => {
    expect(dynamic).toBe("force-dynamic");
  });
});
