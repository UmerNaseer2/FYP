// organizations-route: the caller's organizations, and making a new one
// (app/api/organizations/route.ts).
//
// The gate and the database are stood in for here. The real gate is held to
// its word in tests/auth-guard.test.ts, and createOrganization against a real
// database in tests/org-migration.test.ts. What these tests hold the route to:
//
//   - The gate comes first, and a refusal is passed on as it came.
//   - GET lists the caller's own organizations, by slug and name only. The
//     bypass, which is an Admin everywhere, sees every organization.
//   - canCreate is true exactly where POST would be let through.
//   - POST is refused on the desktop and with the bypass before the body is
//     read, and nothing is written.
//   - A name or address the rules turn down is 400, naming the field, and
//     nothing is written. The name is stored cleaned, the address trimmed.
//   - A taken address is 409 on the address field. A profile deleted since
//     sign-in is 401. A new organization is 201 with its slug and name.
//   - A database that did not answer is 503, with the reason kept to the log.
//   - A GitHub repository and token are optional, but go together. GitHub is
//     asked about them before anything is written, and nothing is written
//     when it says no, or when the server has no key to keep the token safe.
//     Without them the organization is made exactly as before. The token is
//     never in an answer.
import { NextRequest, NextResponse } from "next/server";
import type { SignedInGate } from "@/lib/auth-guard";
import {
  REPOSITORY_PROBLEM,
  REPOSITORY_WITHOUT_TOKEN,
  TOKEN_WITHOUT_REPOSITORY,
} from "@/lib/github-settings";

let mockGate: SignedInGate;
let mockGateCalls = 0;
jest.mock("../lib/auth-guard", () => ({
  requireSignedIn: async () => {
    mockGateCalls += 1;
    return mockGate;
  },
}));

const mockOrgsDb = {
  createOrganization: jest.fn(),
  listMemberships: jest.fn(),
  listOrganizations: jest.fn(),
};
jest.mock("../lib/orgs-db", () => ({
  createOrganization: (...args: unknown[]) => mockOrgsDb.createOrganization(...args),
  listMemberships: (...args: unknown[]) => mockOrgsDb.listMemberships(...args),
  listOrganizations: (...args: unknown[]) => mockOrgsDb.listOrganizations(...args),
}));

const mockCheck = jest.fn();
jest.mock("../lib/github-check", () => ({
  checkRepositoryAccess: (...args: unknown[]) => mockCheck(...args),
}));

let mockKeySource: "app-key" | "derived" | "none" = "app-key";
jest.mock("../lib/secret-store", () => ({
  encryptionKeySource: () => mockKeySource,
}));

import { GET, POST } from "@/app/api/organizations/route";

/** Ed's profile ID. */
const ED = 31;
const SIGNED_IN: SignedInGate = { ok: true, caller: { profileId: ED, bypass: false } };
const BYPASS: SignedInGate = { ok: true, caller: { profileId: null, bypass: true } };

const ACME = { id: 12, slug: "acme", name: "Acme", isDefault: false };
const DEFAULT_ORG = { id: 1, slug: "default", name: "Default organization", isDefault: true };
/** What listMemberships hands back: the organization's fields, and the person's. */
const ACME_MEMBERSHIP = {
  orgId: ACME.id,
  slug: ACME.slug,
  name: ACME.name,
  isDefault: false,
  role: "admin",
  email: "ed@example.com",
  personName: "Ed",
};
const DATABASE_DOWN = new Error("connect ECONNREFUSED 127.0.0.1:5433");
const UNAVAILABLE_TAIL = " The app's database may be unreachable. Try again in a moment.";

const DESKTOP = process.env.SCHEMA_STUDIO_DESKTOP;

/** Made up for these tests. Not a real token. */
const TOKEN = "github_pat_not_real_0001_abcdefghij";

beforeEach(() => {
  mockGate = SIGNED_IN;
  mockGateCalls = 0;
  mockKeySource = "app-key";
  mockCheck.mockReset();
  mockCheck.mockResolvedValue({ ok: true });
  delete process.env.SCHEMA_STUDIO_DESKTOP;
  for (const fake of Object.values(mockOrgsDb)) fake.mockReset();
});

afterEach(() => {
  jest.restoreAllMocks();
  if (DESKTOP === undefined) delete process.env.SCHEMA_STUDIO_DESKTOP;
  else process.env.SCHEMA_STUDIO_DESKTOP = DESKTOP;
});

/** A POST to the route with this body, sent as it is when it is a string. */
function post(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/organizations", {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

/** The status and body, once it is clear the body holds no token. */
async function answer(response: Response): Promise<[number, unknown]> {
  const text = await response.text();
  expect(text).not.toContain(TOKEN);
  return [response.status, JSON.parse(text)];
}

/** Keep the route's own console.error out of the test output, and count it. */
function quietErrors() {
  return jest.spyOn(console, "error").mockImplementation(() => {});
}

function nothingWritten() {
  expect(mockOrgsDb.createOrganization).not.toHaveBeenCalled();
}

describe("a refusal from the gate", () => {
  /** A fresh refusal each time, because a response's body can be read once. */
  function signedOut(): SignedInGate {
    return {
      ok: false,
      response: NextResponse.json({ error: "Sign in to continue." }, { status: 401 }),
    };
  }

  test("is passed on as it came, for both methods, and nothing is read or written", async () => {
    mockGate = signedOut();
    expect(await answer(await GET())).toEqual([401, { error: "Sign in to continue." }]);
    mockGate = signedOut();
    expect(await answer(await POST(post({ name: "Acme", slug: "acme" })))).toEqual([
      401,
      { error: "Sign in to continue." },
    ]);
    expect(mockGateCalls).toBe(2);
    expect(mockOrgsDb.listMemberships).not.toHaveBeenCalled();
    expect(mockOrgsDb.listOrganizations).not.toHaveBeenCalled();
    nothingWritten();
  });
});

describe("GET", () => {
  test("lists the caller's own organizations by slug and name, and nothing about them", async () => {
    mockOrgsDb.listMemberships.mockResolvedValue([ACME_MEMBERSHIP]);
    expect(await answer(await GET())).toEqual([
      200,
      { organizations: [{ slug: "acme", name: "Acme" }], canCreate: true },
    ]);
    expect(mockOrgsDb.listMemberships).toHaveBeenCalledWith(ED);
    expect(mockOrgsDb.listOrganizations).not.toHaveBeenCalled();
  });

  test("answers someone in no organization yet with an empty list", async () => {
    mockOrgsDb.listMemberships.mockResolvedValue([]);
    expect(await answer(await GET())).toEqual([200, { organizations: [], canCreate: true }]);
  });

  test("with the bypass, which is an Admin everywhere, lists every organization and offers no making", async () => {
    mockGate = BYPASS;
    mockOrgsDb.listOrganizations.mockResolvedValue([ACME, DEFAULT_ORG]);
    expect(await answer(await GET())).toEqual([
      200,
      {
        organizations: [
          { slug: "acme", name: "Acme" },
          { slug: "default", name: "Default organization" },
        ],
        canCreate: false,
      },
    ]);
    expect(mockOrgsDb.listMemberships).not.toHaveBeenCalled();
  });

  test("on the desktop offers no making", async () => {
    process.env.SCHEMA_STUDIO_DESKTOP = "1";
    mockOrgsDb.listMemberships.mockResolvedValue([ACME_MEMBERSHIP]);
    expect(await answer(await GET())).toMatchObject([200, { canCreate: false }]);
  });

  test("a database that did not answer is 503, with the reason kept to the log", async () => {
    const errors = quietErrors();
    mockOrgsDb.listMemberships.mockRejectedValue(DATABASE_DOWN);
    expect(await answer(await GET())).toEqual([
      503,
      { error: `Could not read your organizations.${UNAVAILABLE_TAIL}` },
    ]);
    expect(errors).toHaveBeenCalledWith("Failed to list organizations:", DATABASE_DOWN);
  });
});

describe("POST", () => {
  test("makes the organization with the caller as its Admin, and answers 201 with its address", async () => {
    mockOrgsDb.createOrganization.mockResolvedValue({ kind: "ok", organization: ACME });
    expect(await answer(await POST(post({ name: "Acme", slug: "acme" })))).toEqual([
      201,
      { organization: { slug: "acme", name: "Acme" } },
    ]);
    expect(mockOrgsDb.createOrganization.mock.calls).toEqual([[ED, { slug: "acme", name: "Acme" }]]);
  });

  test("stores the name cleaned and the address trimmed", async () => {
    mockOrgsDb.createOrganization.mockResolvedValue({ kind: "ok", organization: ACME });
    await POST(post({ name: "  Acme \t Data  ", slug: " acme-data " }));
    expect(mockOrgsDb.createOrganization).toHaveBeenCalledWith(ED, {
      slug: "acme-data",
      name: "Acme Data",
    });
  });

  test("on the desktop is 403 before the body is read, and nothing is written", async () => {
    process.env.SCHEMA_STUDIO_DESKTOP = "1";
    expect(await answer(await POST(post("not json")))).toEqual([
      403,
      { error: "The desktop app keeps a single organization of its own." },
    ]);
    nothingWritten();
  });

  test("with the bypass is 403 before the body is read, and nothing is written", async () => {
    mockGate = BYPASS;
    expect(await answer(await POST(post("not json")))).toEqual([
      403,
      {
        error:
          "Making an organization needs a real sign-in. The demo has its organizations already.",
      },
    ]);
    nothingWritten();
  });

  test("a body that is not JSON is 400", async () => {
    expect(await answer(await POST(post("{name:")))).toEqual([
      400,
      { error: "Expected a JSON body." },
    ]);
    nothingWritten();
  });

  test.each([
    ["no body fields at all", {}, "name", "Give the organization a name."],
    ["JSON that is not an object", [], "name", "Give the organization a name."],
    ["a name that is only spaces", { name: "   ", slug: "acme" }, "name", "Give the organization a name."],
    ["a name that is not text", { name: 42, slug: "acme" }, "name", "Give the organization a name."],
    [
      "a name past the limit",
      { name: "x".repeat(61), slug: "acme" },
      "name",
      "Keep the name to 60 characters or fewer.",
    ],
    [
      "a name that turns its text around",
      { name: "Acme ‮txt.exe", slug: "acme" },
      "name",
      "The name has a character that cannot be shown. Type it again.",
    ],
    ["no address", { name: "Acme" }, "slug", "Give the organization an address."],
    [
      "an address in capitals",
      { name: "Acme", slug: "Acme" },
      "slug",
      "An address is 3 to 40 lowercase letters, digits and dashes, " +
        "and starts and ends with a letter or digit.",
    ],
    [
      "an address the app uses itself",
      { name: "Acme", slug: "onboarding" },
      "slug",
      "That address is used by the app itself. Pick another.",
    ],
  ])("turns down %s with a 400 naming the field, and nothing is written", async (_, body, field, error) => {
    expect(await answer(await POST(post(body)))).toEqual([400, { error, field }]);
    nothingWritten();
  });

  test("a taken address is 409 on the address field", async () => {
    mockOrgsDb.createOrganization.mockResolvedValue({ kind: "taken" });
    expect(await answer(await POST(post({ name: "Acme", slug: "acme" })))).toEqual([
      409,
      { error: "That address is taken. Pick another.", field: "slug" },
    ]);
  });

  test("a profile deleted since sign-in is 401, asking for a fresh sign-in", async () => {
    mockOrgsDb.createOrganization.mockResolvedValue({ kind: "no-profile" });
    expect(await answer(await POST(post({ name: "Acme", slug: "acme" })))).toEqual([
      401,
      { error: "Sign in again to continue." },
    ]);
  });

  test("a database that did not answer is 503, with the reason kept to the log", async () => {
    const errors = quietErrors();
    mockOrgsDb.createOrganization.mockRejectedValue(DATABASE_DOWN);
    expect(await answer(await POST(post({ name: "Acme", slug: "acme" })))).toEqual([
      503,
      { error: `Could not make the organization.${UNAVAILABLE_TAIL}` },
    ]);
    expect(errors).toHaveBeenCalledWith("Failed to make an organization:", DATABASE_DOWN);
  });
});

describe("POST with a GitHub repository and token", () => {
  const ACME_GITHUB = { name: "Acme", slug: "acme", repository: "acme/schema-scripts", token: TOKEN };
  const SETTINGS = { owner: "acme", repo: "schema-scripts", token: TOKEN };

  test("asks GitHub first, then makes the organization with them, and never answers with the token", async () => {
    mockOrgsDb.createOrganization.mockResolvedValue({ kind: "ok", organization: ACME });
    const response = await POST(
      post({ ...ACME_GITHUB, repository: " https://github.com/acme/schema-scripts.git ", token: ` ${TOKEN}\n` })
    );
    expect(await answer(response)).toEqual([201, { organization: { slug: "acme", name: "Acme" } }]);
    expect(mockCheck.mock.calls).toEqual([[SETTINGS]]);
    expect(mockOrgsDb.createOrganization.mock.calls).toEqual([[ED, { slug: "acme", name: "Acme" }, SETTINGS]]);
  });

  test.each([
    ["left blank", { repository: "  ", token: "" }],
    ["sent as null", { repository: null, token: null }],
  ])("%s, makes the organization without GitHub, as before", async (_, github) => {
    mockOrgsDb.createOrganization.mockResolvedValue({ kind: "ok", organization: ACME });
    expect(await answer(await POST(post({ name: "Acme", slug: "acme", ...github })))).toEqual([
      201,
      { organization: { slug: "acme", name: "Acme" } },
    ]);
    expect(mockOrgsDb.createOrganization.mock.calls).toEqual([[ED, { slug: "acme", name: "Acme" }]]);
    expect(mockCheck).not.toHaveBeenCalled();
  });

  test.each([
    ["a repository with no token", { repository: "acme/schema-scripts" }, "token", REPOSITORY_WITHOUT_TOKEN],
    ["a token with no repository", { token: TOKEN }, "repository", TOKEN_WITHOUT_REPOSITORY],
    ["a repository that is not owner/name", { repository: "schema-scripts", token: TOKEN }, "repository", REPOSITORY_PROBLEM],
    [
      "a token with a space in it",
      { repository: "acme/schema-scripts", token: "github_pat_not real_0001_abcdefghij" },
      "token",
      "An access token has no spaces or line breaks in it. Copy it from GitHub again.",
    ],
    ["a token that is not text", { repository: "acme/schema-scripts", token: 42 }, "token", "Send the repository and token as text."],
    ["a repository that is not text", { repository: ["acme"], token: TOKEN }, "repository", "Send the repository and token as text."],
  ])("turns down %s with a 400 naming the field, before GitHub is asked", async (_, github, field, error) => {
    expect(await answer(await POST(post({ name: "Acme", slug: "acme", ...github })))).toEqual([400, { error, field }]);
    expect(mockCheck).not.toHaveBeenCalled();
    nothingWritten();
  });

  test("on a server with no encryption key is 503 on the token, before GitHub is asked", async () => {
    mockKeySource = "none";
    const [status, body] = await answer(await POST(post(ACME_GITHUB)));
    expect(status).toBe(503);
    expect(body).toMatchObject({ field: "token", error: expect.stringMatching(/without GitHub for now/) });
    expect(mockCheck).not.toHaveBeenCalled();
    nothingWritten();
  });

  test("passes on GitHub's refusal as it came, and nothing is written", async () => {
    const refusal = { ok: false, status: 400, field: "repository", error: "GitHub found no repository. Nothing was saved." };
    mockCheck.mockResolvedValue(refusal);
    expect(await answer(await POST(post(ACME_GITHUB)))).toEqual([
      400,
      { error: refusal.error, field: "repository" },
    ]);
    nothingWritten();
  });

  test("a key gone by the time of the save is 503 on the token", async () => {
    mockOrgsDb.createOrganization.mockResolvedValue({ kind: "no-key" });
    const [status, body] = await answer(await POST(post(ACME_GITHUB)));
    expect(status).toBe(503);
    expect(body).toMatchObject({ field: "token" });
  });

  test("a taken address is still 409 on the address field", async () => {
    mockOrgsDb.createOrganization.mockResolvedValue({ kind: "taken" });
    expect(await answer(await POST(post(ACME_GITHUB)))).toEqual([
      409,
      { error: "That address is taken. Pick another.", field: "slug" },
    ]);
  });
});
