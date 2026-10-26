// org-redirect: an address from before organizations (/compare?left=1) goes
// on to the same page in an organization (/acme/compare?left=1), and an
// organization's own address (/acme) opens its dashboard.
//
// The old addresses are in bookmarks, pull requests, the desktop app and the
// sign-in page's way back, so a studio page without one is a link that used
// to work and now says "There is no page here". The last tests here fail when
// a page is added under app/[org]/(studio) without its old address.
import fs from "fs";
import path from "path";
import { redirectToLastOrg, type OldAddressProps } from "@/lib/org-redirect";
import OrganizationHome from "@/app/[org]/page";

let mockBypass = false;
jest.mock("../lib/auth-mode", () => ({
  ...jest.requireActual("../lib/auth-mode"),
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
jest.mock("../lib/orgs-db", () => ({
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
  mockAuth.mockReset().mockResolvedValue({ user: { email: "sam@example.com" } });
  mockFindLast.mockReset().mockResolvedValue("acme");
  mockFindDefault.mockReset().mockResolvedValue(DEFAULT_ORG);
  mockRedirect.mockClear();
  mockNotFound.mockClear();
});

describe("redirectToLastOrg", () => {
  test("sends someone signed in to the organization they opened last, with the page and query", async () => {
    const to = await whereTo(redirectToLastOrg("compare", props(undefined, { left: "1", right: "2" })));
    expect(to).toBe("/acme/compare?left=1&right=2");
    expect(mockFindLast).toHaveBeenCalledWith("sam@example.com");
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

  test("sends someone in no organization to the default one", async () => {
    // Its pages tell them they are not a member and offer to sign out.
    mockFindLast.mockResolvedValue(null);
    expect(await whereTo(redirectToLastOrg("studio", props()))).toBe("/swinburne-fyp/studio");
  });

  test("with sign-in switched off, opens the default organization and asks for no session", async () => {
    mockBypass = true;
    const to = await whereTo(redirectToLastOrg("drift", props(undefined, { tab: "detail" })));
    expect(to).toBe("/swinburne-fyp/drift?tab=detail");
    expect(mockAuth).not.toHaveBeenCalled();
    expect(mockFindLast).not.toHaveBeenCalled();
  });

  test("sends a session with no email to sign in, and back to the same old address", async () => {
    const quiet = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      const sessions = [
        () => mockAuth.mockResolvedValue({ user: {} }),
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

describe("the old addresses", () => {
  const studioPages = fs
    .readdirSync(STUDIO, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

  test("every studio page has one, and it sends people to that page", async () => {
    // A guard on the guard: a walk that found nothing would pass below.
    expect(studioPages).toEqual(expect.arrayContaining(["studio", "compare", "schemas"]));
    for (const name of studioPages) {
      const file = path.join(APP, name, "[[...rest]]", "page.tsx");
      expect({ name, exists: fs.existsSync(file) }).toEqual({ name, exists: true });
      const { default: OldAddress } = await import(file);
      mockRedirect.mockClear();
      expect(await whereTo(OldAddress(props()))).toBe(`/acme/${name}`);
    }
  });

  test("none is left behind for a page that is gone", () => {
    const oldAddresses = fs
      .readdirSync(APP, { withFileTypes: true })
      .filter((entry) => fs.existsSync(path.join(APP, entry.name, "[[...rest]]", "page.tsx")))
      .map((entry) => entry.name);
    expect(oldAddresses.sort()).toEqual([...studioPages].sort());
  });
});
