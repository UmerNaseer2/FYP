// Route tests must never reach GitHub, even by accident.
//
// guardGitHub() replaces the three GitHub settings with fake values and
// replaces fetch with a stub that refuses every request and writes it down.
// A test checks `unexpected` is empty at the end, and checks that FAKE_TOKEN
// never appears in a response body. restore() puts everything back.
//
// This file is not a test itself: Jest only runs tests/**/*.test.ts.

export const FAKE_TOKEN = "test-token-not-real";

const ENV_KEYS = ["GITHUB_PAT", "GITHUB_REPO_OWNER", "GITHUB_REPO_NAME"] as const;

export type GitHubGuard = {
  /** Every URL a route tried to fetch. Should stay empty. */
  unexpected: string[];
  restore: () => void;
};

export function guardGitHub(): GitHubGuard {
  const saved: Record<string, string | undefined> = {};
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  process.env.GITHUB_PAT = FAKE_TOKEN;
  process.env.GITHUB_REPO_OWNER = "acme-test";
  process.env.GITHUB_REPO_NAME = "registry-test";

  const realFetch = global.fetch;
  const unexpected: string[] = [];
  // Fails closed: no request is answered, so a route that tried one would
  // fail its test instead of quietly talking to the real API.
  global.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    unexpected.push(url);
    throw new Error(`Tests never reach the network (asked for ${url}).`);
  }) as typeof fetch;

  return {
    unexpected,
    restore() {
      global.fetch = realFetch;
      for (const key of ENV_KEYS) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    },
  };
}
