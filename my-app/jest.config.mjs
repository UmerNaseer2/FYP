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
  // Node, not jsdom. Everything under test here is plain logic — SQL
  // generation, diffing, guards, parsing. Nothing touches the DOM, so a
  // browser environment would only cost start-up time.
  testEnvironment: "node",
  testMatch: ["<rootDir>/tests/**/*.test.ts"],
  // The app's real database modules are never imported by these tests, so
  // there is no connection to leak — but a stray import would hang the run
  // rather than fail it, and a short timeout turns that into a visible error.
  testTimeout: 10000,
  collectCoverageFrom: [
    "lib/**/*.ts",
    // Excluded on purpose: these modules ARE a database client. Covering them
    // needs a live Postgres, which belongs in the integration harness, not in
    // the unit suite that has to run on a CI box with no server.
    "!lib/postgres.ts",
    "!lib/version-db.ts",
    "!lib/**/*-db.ts",
  ],
};

export default createJestConfig(config);
