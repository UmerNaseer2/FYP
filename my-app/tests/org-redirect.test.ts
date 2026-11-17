// org-redirect: an address that names no organization (/studio?tour=1) goes
// on to the same page in one (/acme/studio?tour=1), and an organization's own
// address (/acme) opens its dashboard.
//
// /studio is the way into the app (sign-in, the landing page and the error
// pages all link there), so it is the one address of this kind left. The last
// tests here fail if it goes, or if another one comes back.
import fs from "fs";
import path from "path";
import { redirectToLastOrg, type OldAddressProps } from "@/lib/orgs/redirect";
import OrganizationHome from "@/app/[org]/page";

let mockBypass = false;
jest.mock("../lib/auth/mode", () => ({
  ...jest.requireActual("../lib/auth/mode"),
  // A getter, so one file can see both sides of the switch. See
  // tests/auth-guard.test.ts.
  get BYPASS_AUTH() {
    return mockBypass;
  },
}));

const mockAuth = jest.fn();
jest.mock("../auth", () => ({ auth: () => mockAuth() }));

const mockFindLast = jest.fn();
const mockFindDefault = jest.fn();
jest.mock("../lib/orgs/orgs-db", () => ({
  findLastOrganization: (...args: unknown[]) => mockFindLast(...args),
  findDefaultOrganization: (...args: unknown[]) => mockFindDefault(...args),
}));

// Next.js stops a page by throwing from redirect() and notFound(), so these
// throw too, and remember where they were asked to go.
const mockRedirect = jest.fn((to: string): never => {
  throw new Error(`redirect to ${to}`);
});
const mockNotFound = jest.fn((): never => {
  throw new Error("not found");
});
jest.mock("next/navigation", () => ({
  redirect: (to: string) => mockRedirect(to),
  notFound: () => mockNotFound(),
}));

const APP = path.join(__dirname, "..", "app");
const STUDIO = path.join(APP, "[org]", "(studio)");
const DEFAULT_ORG = { id: 1, slug: "swinburne-fyp", name: "Swinburne FYP", isDefault: true };

function props(
  rest?: string[],
  query: Record<string, string | string[] | undefined> = {}
): OldAddressProps {
  return {
    params: Promise.resolve(rest === undefined ? {} : { rest }),
    searchParams: Promise.resolve(query),
  };
}

/** Where `call` redirected to. Every call here must redirect, exactly once. */
async function whereTo(call: Promise<unknown>): Promise<string> {
  await call.catch(() => {});
  expect(mockRedirect).toHaveBeenCalledTimes(1);
  return mockRedirect.mock.calls[0][0];
}

beforeEach(() => {
  mockBypass = false;
  // auth.ts puts the profile ID in the session, as a string.
  mockAuth.mockReset().mockResolvedValue({ user: { id: "7", email: "sam@example.com" } });
  mockFindLast.mockReset().mockResolvedValue("acme");
  mockFindDefault.mockReset().mockResolvedValue(DEFAULT_ORG);
  mockRedirect.mockClear();
  mockNotFound.mockClear();
});

describe("redirectToLastOrg", () => {

  test("sends someone signed in to the organization they opened last, with the page and query", async () => {
    const to = await whereTo(redirectToLastOrg("compare", props(undefined, { left: "1", right: "2" })));
    expect(to).toBe("/acme/compare?left=1&right=2");
    // Looked up by the profile ID, never the address.
    expect(mockFindLast).toHaveBeenCalledWith(7);
  });

  test("keeps the rest of the path, each part encoded again", async () => {
    expect(await whereTo(redirectToLastOrg("schemas", props(["12"])))).toBe("/acme/schemas/12");
    mockRedirect.mockClear();
    // Next.js hands the parts over decoded. One that holds a "/" or a "?"
    // must stay one part, not become two or start a query.
    expect(await whereTo(redirectToLastOrg("schemas", props(["a/b?c d"])))).toBe(
      "/acme/schemas/a%2Fb%3Fc%20d"
    );
  });

  test("keeps a query parameter that appears twice, and drops nothing", async () => {
    const to = await whereTo(
      redirectToLastOrg("drift", props(undefined, { tag: ["a", "b"], schema: "4", empty: "" }))
    );
    expect(to).toBe("/acme/drift?tag=a&tag=b&schema=4&empty=");
  });

  test("sends someone in no organization to make one", async () => {
    mockFindLast.mockResolvedValue(null);
    expect(await whereTo(redirectToLastOrg("studio", props()))).toBe("/onboarding");
    expect(mockFindDefault).not.toHaveBeenCalled();
  });

  test("with sign-in switched off, opens the default organization and asks for no session", async () => {
    mockBypass = true;
    const to = await whereTo(redirectToLastOrg("drift", props(undefined, { tab: "detail" })));
    expect(to).toBe("/swinburne-fyp/drift?tab=detail");
    expect(mockAuth).not.toHaveBeenCalled();
    expect(mockFindLast).not.toHaveBeenCalled();
  });

  test("sends a session with no profile ID to sign in, and back to the same old address", async () => {
    const quiet = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      const sessions = [
        () => mockAuth.mockResolvedValue({ user: {} }),
        // Signed before profile IDs went into sessions: an address is not enough.
        () => mockAuth.mockResolvedValue({ user: { email: "sam@example.com" } }),
        () => mockAuth.mockResolvedValue({ user: { id: "not-a-number" } }),
        () => mockAuth.mockResolvedValue(null),
        () => mockAuth.mockRejectedValue(new Error("auth backend down")),
      ];
      for (const session of sessions) {
        session();
        mockRedirect.mockClear();
        const to = await whereTo(redirectToLastOrg("compare", props(undefined, { left: "1" })));
        expect(to).toBe("/login?callbackUrl=%2Fcompare%3Fleft%3D1");
      }
      expect(mockFindLast).not.toHaveBeenCalled();
    } finally {
      quiet.mockRestore();
    }
  });

  test("lets a database that does not answer become an error, never a guess", async () => {
    mockFindLast.mockRejectedValue(new Error("connection refused"));
    await expect(redirectToLastOrg("studio", props())).rejects.toThrow("connection refused");
    expect(mockRedirect).not.toHaveBeenCalled();
  });

  test("with no default organization, fails rather than sending anyone nowhere", async () => {
    mockBypass = true;
    mockFindDefault.mockResolvedValue(null);
    await expect(redirectToLastOrg("studio", props())).rejects.toThrow(/no default organization/);
    expect(mockRedirect).not.toHaveBeenCalled();
  });
});

describe("an organization's own address", () => {
  test("opens its dashboard", async () => {
    const to = await whereTo(OrganizationHome({ params: Promise.resolve({ org: "acme" }) }));
    expect(to).toBe("/acme/studio");
  });

  test("is a 404, never a redirect, when the first part is not a slug", async () => {
    // "//example.com" is what /%2F%2Fexample.com arrives as. Redirected to
    // "//example.com/studio", a browser would open another site.
    for (const org of ["//example.com", "Acme", "studio"]) {
      await expect(OrganizationHome({ params: Promise.resolve({ org }) })).rejects.toThrow(
        "not found"
      );
    }
    expect(mockRedirect).not.toHaveBeenCalled();
  });
});

describe("the /studio door", () => {
  test("is there, and sends people to their organization's dashboard", async () => {
    // A guard on the guard: the studio page it leads to must exist.
    expect(fs.existsSync(path.join(STUDIO, "studio"))).toBe(true);
    const file = path.join(APP, "studio", "[[...rest]]", "page.tsx");
    expect(fs.existsSync(file)).toBe(true);
    const { default: Door } = await import(file);
    mockRedirect.mockClear();
    expect(await whereTo(Door(props()))).toBe("/acme/studio");
  });

  test("is the only address of its kind", () => {
    const doors = fs
      .readdirSync(APP, { withFileTypes: true })
      .filter((entry) => fs.existsSync(path.join(APP, entry.name, "[[...rest]]", "page.tsx")))
      .map((entry) => entry.name);
    expect(doors).toEqual(["studio"]);
  });
});
