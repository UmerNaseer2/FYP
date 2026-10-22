/**
 * Writes out/build-config.json: the Microsoft Entra IDs that this build of
 * Schema Studio signs in with (the app registration's client ID and the
 * organization's tenant ID).
 *
 * The IDs come from the environment, which is how CI passes them from the
 * repository's Actions variables, or from desktop/.env.desktop, which is
 * how someone building on their own computer keeps them (git ignores that
 * file). A value in the environment wins. The checks are the app's own, in
 * src/core/build-config.ts, so a typo stops the build here instead of
 * producing an app whose sign-in can never work. A build without the IDs is
 * still a working app, but it says that sign-in is not set up.
 *
 * The IDs are not secrets: Microsoft shows them on every sign-in page. They
 * are still never printed here, because anyone can read the CI logs of a
 * public repository, and nothing needs them there.
 *
 * It runs after npm run build:ts, because it uses the compiled checks in
 * out/, and its result goes into the app's archive with the rest of out/.
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const compiled = path.join(desktopDir, "out", "core", "build-config.js");
const envFile = path.join(desktopDir, ".env.desktop");
const output = path.join(desktopDir, "out", "build-config.json");

if (!fs.existsSync(compiled)) {
  console.error("The app is not compiled yet. Run npm run build:ts first.");
  process.exit(1);
}
const { buildConfigFrom, parseEnvFile } = createRequire(import.meta.url)(compiled);

const fromFile = fs.existsSync(envFile) ? parseEnvFile(fs.readFileSync(envFile, "utf8")) : {};
const { config, problems } = buildConfigFrom(process.env, fromFile);
if (problems.length > 0) {
  for (const problem of problems) console.error(problem);
  process.exit(1);
}

fs.writeFileSync(output, `${JSON.stringify(config, null, 2)}\n`);
if (config.clientId !== null) {
  console.log("Microsoft sign-in is set up in this build.");
} else {
  console.log(
    "Microsoft sign-in is not set up in this build. To set it up, put AZURE_AD_CLIENT_ID and AZURE_AD_TENANT_ID in desktop/.env.desktop (README.md says where to find them) and build again.",
  );
}
