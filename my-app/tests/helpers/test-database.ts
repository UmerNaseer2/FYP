// The throwaway Postgres that the real-database suites run against
// (tests/org-migration.test.ts and tests/org-data-db.test.ts).
//
// Those suites skip without TEST_DATABASE_URL, so a laptop with no database to
// spare can still run every other test. CI gives them one, and sets
// REQUIRE_TEST_DATABASE too (.github/workflows/ci.yml). With that set, a
// missing URL fails the suite instead of skipping it: a run that lost its
// database would otherwise skip both suites and still come up green.
//
// This file is not a test itself: Jest only runs tests/**/*.test.ts.

/** TEST_DATABASE_URL, or "" when the suites that need it should skip. */
export function testDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL ?? "";
  if (url === "" && process.env.REQUIRE_TEST_DATABASE === "1") {
    throw new Error(
      "REQUIRE_TEST_DATABASE is set, so these tests may not skip, but TEST_DATABASE_URL is not set."
    );
  }
  return url;
}
