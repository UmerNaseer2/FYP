import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
  {
    // .cjs helper scripts are CommonJS by definition, so require() is the only
    // way they can import anything. The TypeScript rule does not know that.
    files: ["**/*.cjs"],
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
  {
    // Same rule, different reason. Jest hoists every jest.mock() call above the
    // imports in its file, so a factory that referenced an imported binding
    // would run before that binding existed — require() inside the factory is
    // the documented way to write one, and the page suites all need it to stand
    // in for next/navigation and next-auth/react.
    files: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
]);

export default eslintConfig;
