import nextJest from "next/jest.js";

/**
 * Jest, wired through next/jest.
 *
 * next/jest is the first-party transformer: it reuses the same SWC pipeline
 * that compiles the app, reads the `@/*` path alias out of tsconfig.json, and
 * loads .env files the way `next dev` does. Configuring ts-jest by hand would
 * mean keeping a second, slightly-different idea of how this project's
 * TypeScript compiles — and the first time the two disagreed, a test would
 * pass against code the app cannot run.
 */
const createJestConfig = nextJest({ dir: "./" });

/** @type {import("jest").Config} */
const config = {
  // Node by DEFAULT, not for everything. Most of what is under test here is
  // plain logic — SQL generation, diffing, guards, parsing — and a browser
  // environment would only cost those suites start-up time.
  //
  // The page suites (tests/page-*.test.tsx) do need a DOM, and each one asks
  // for it in its own first line:
  //
  //     /** @jest-environment jsdom */
  //
  // Per file rather than a second `projects` entry on purpose. next/jest hands
  // back a config function rather than an object, so splitting this into two
  // projects means calling it twice and keeping two copies of everything below
  // in step; the docblock is one line in the files that need it and leaves the
  // rest untouched.
  testEnvironment: "node",
  // Loaded into every suite, node ones included, where it is a no-op — see the
  // file. It covers the browser APIs jsdom leaves out, so a page test fails on
  // what it is testing rather than on scrollIntoView not existing.
  setupFilesAfterEnv: ["<rootDir>/tests/helpers/jsdom-gaps.ts"],
  // .tsx as well as .ts: a test that renders a page is written in JSX, the
  // same as the page.
  testMatch: ["<rootDir>/tests/**/*.test.ts", "<rootDir>/tests/**/*.test.tsx"],
  // `next build` writes a second copy of the app — package.json included —
  // into .next/standalone. Jest crawls the whole project to build its module
  // map, finds two packages both named "my-app", and warns about a naming
  // collision on every run. Nothing under .next is a source file, so keep the
  // crawler out of it.
  modulePathIgnorePatterns: ["<rootDir>/.next/"],
  // Almost no test here imports the app's real database modules, so there is
  // no connection to leak. The two exceptions, tests/org-migration.test.ts and
  // tests/org-data-db.test.ts, import them only when TEST_DATABASE_URL is set
  // (tests/helpers/test-database.ts), and set longer timeouts of their own. A
  // stray import anywhere else would hang the run rather than fail it, and a
  // short timeout turns that into a visible error.
  testTimeout: 10000,
  collectCoverageFrom: [
    "lib/**/*.ts",
    // Excluded on purpose: these modules ARE a database client, and covering
    // them needs a live Postgres. Only two suites use one, and only when
    // TEST_DATABASE_URL is set: tests/org-migration.test.ts boots
    // lib/db/bootstrap.ts and runs the sign-in, membership and role code
    // (lib/version-db.ts, lib/orgs-db.ts, lib/roles-db.ts) on what it made, and
    // tests/org-data-db.test.ts drives the data code of two organizations side
    // by side to check that neither can reach the other's rows. Every other
    // suite runs with no server.
    "!lib/postgres.ts",
    "!lib/version-db.ts",
    "!lib/**/*-db.ts",
  ],
};

export default createJestConfig(config);
