/**
 * What the GitHub sign-in reads from GitHub: who signed in, the address they
 * get mail at, and whether GitHub has checked that address.
 *
 * The last part decides whether somebody new can have an account at all
 * (lib/accounts-db.ts makes one only for a checked address), so an address
 * must only ever be marked checked when GitHub says so in so many words.
 *
 * fetch is replaced with a stub that answers the two addresses GitHub's API
 * is asked, and throws for anything else, so nothing leaves the machine.
 * Which providers auth.config.ts offers, and that the GitHub one is wired to
 * readGitHubAccount, is in tests/desktop-sign-in.test.ts.
 */

import { readGitHubAccount } from "../auth.config";

// Auth.js's providers ship as ES modules, which Jest's CommonJS runtime
// cannot load, and auth.config.ts imports both.
jest.mock("next-auth/providers/microsoft-entra-id", () => ({
  __esModule: true,
  default: () => ({ id: "microsoft-entra-id" }),
}));
jest.mock("next-auth/providers/github", () => ({
  __esModule: true,
  default: () => ({ id: "github" }),
}));

const USER_URL = "https://api.github.com/user";
const EMAILS_URL = "https://api.github.com/user/emails";
const TOKEN = "gho_test_token";
const ACCOUNT = { id: 583231, login: "octo", name: "Octo Cat", email: "public@example.com" };

type Answer = { status: number; body: unknown };
let answers: Record<string, Answer>;
let asked: { url: string; headers: Record<string, string> }[];

const realFetch = global.fetch;

beforeEach(() => {
  asked = [];
  answers = {
    [USER_URL]: { status: 200, body: { ...ACCOUNT } },
    [EMAILS_URL]: {
      status: 200,
      body: [
        { email: "old@example.com", primary: false, verified: true },
        { email: "octo@example.com", primary: true, verified: true },
      ],
    },
  };
  global.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    asked.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    const answer = answers[url];
    // Fail closed: an address the test did not name is never fetched.
    if (!answer) throw new Error(`Unexpected fetch in test: ${url}`);
    return new Response(JSON.stringify(answer.body), { status: answer.status });
  }) as typeof fetch;
});

afterEach(() => {
  global.fetch = realFetch;
});

function read() {
  return readGitHubAccount({ tokens: { access_token: TOKEN } });
}

describe("readGitHubAccount", () => {
  test("takes the primary address and GitHub's word that it is checked", async () => {
    const account = await read();
    expect(account).toEqual({ ...ACCOUNT, email: "octo@example.com", email_verified: true });
  });

  test("asks both questions as the person who signed in", async () => {
    await read();
    expect(asked.map((call) => call.url)).toEqual([USER_URL, EMAILS_URL]);
    for (const call of asked) {
      expect(call.headers).toMatchObject({
        Authorization: `Bearer ${TOKEN}`,
        Accept: "application/vnd.github+json",
      });
      // GitHub's API turns away a request without one.
      expect(call.headers["User-Agent"]).toBeTruthy();
    }
  });

  test("marks a primary address GitHub has not checked as unchecked", async () => {
    answers[EMAILS_URL].body = [{ email: "octo@example.com", primary: true, verified: false }];
    expect(await read()).toMatchObject({ email: "octo@example.com", email_verified: false });
  });

  test("believes only a verified flag that is exactly true", async () => {
    for (const verified of ["true", 1, null, undefined]) {
      answers[EMAILS_URL].body = [{ email: "octo@example.com", primary: true, verified }];
      expect(await read()).toMatchObject({ email_verified: false });
    }
  });

  test("keeps the public address, unchecked, when the list cannot be read", async () => {
    // What GitHub answers when the person turned down the user:email scope.
    answers[EMAILS_URL] = { status: 403, body: { message: "Resource not accessible" } };
    expect(await read()).toEqual({ ...ACCOUNT, email_verified: false });
  });

  test("keeps the public address, unchecked, when the list has no primary", async () => {
    for (const body of [
      [],
      [{ email: "octo@example.com", primary: false, verified: true }],
      [{ email: 42, primary: true, verified: true }],
      { email: "octo@example.com", primary: true, verified: true },
    ]) {
      answers[EMAILS_URL].body = body;
      expect(await read()).toEqual({ ...ACCOUNT, email_verified: false });
    }
  });

  test("fails the sign-in when GitHub will not say who it is, and asks nothing more", async () => {
    answers[USER_URL] = { status: 401, body: { message: "Bad credentials" } };
    await expect(read()).rejects.toThrow("GitHub did not say who signed in (HTTP 401).");
    expect(asked.map((call) => call.url)).toEqual([USER_URL]);
  });
});
