import type { Config } from "jest";

const config: Config = {
  // ts-jest handles TypeScript files for us so we don't need to compile first.
  preset: "ts-jest",

  // Tests run in Node, not in a browser.
  testEnvironment: "node",

  // Tell ts-jest to compile TypeScript as CommonJS (Node-style modules),
  // regardless of what the main tsconfig says. This is needed because Jest
  // itself runs in CommonJS mode.
  transform: {
    "^.+\\.tsx?$": [
      "ts-jest",
      {
        tsconfig: {
          module: "commonjs",
        },
      },
    ],
  },

  // Resolve the "@/" path alias the same way Next.js does.
  moduleNameMapper: {
    "^@/(.*)$": "<rootDir>/$1",
  },

  // Only look for test files inside __tests__ folders.
  testMatch: ["**/__tests__/**/*.test.ts"],
};

export default config;
