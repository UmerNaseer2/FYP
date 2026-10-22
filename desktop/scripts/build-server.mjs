/**
 * Builds the web app (my-app) for the desktop app, into desktop/build/server.
 *
 * The desktop app runs the same Next.js server as the web version, inside
 * Electron and reachable only from the computer itself. Next's "standalone"
 * build is a folder with a server.js and just the packages it needs, and
 * that folder goes into the installer (scripts/after-pack.cjs).
 *
 * The build happens in a fresh copy of my-app in a temporary folder:
 *
 *  - Only files git knows about are copied (committed ones, and new ones
 *    that are not ignored), and never a .env file. The developer's
 *    .env.local holds real passwords, and next build reads .env files, so
 *    building in the folder as it is could put them into the installer.
 *  - npm ci installs exactly the versions in my-app/package-lock.json.
 *  - The developer's own my-app/node_modules and my-app/.next are left
 *    alone, so npm run dev there keeps working.
 *
 * next build sees almost nothing of this computer's environment either. A
 * variable whose name starts with NEXT_PUBLIC_ would be written into the
 * pages, and a developer's or CI's environment can hold tokens.
 *
 * Afterwards every file of the build is checked for the values in the .env
 * files of my-app and of the repository, and for anything that looks like a
 * token or a private key. If one turns up, the build is removed and this
 * stops. The repository is public, and an installer built from it is as
 * good as public, so a secret must never get that far.
 *
 * Last, it writes .schema-studio-build.json with the commit the build came
 * from, which About and the diagnostics show (src/main/build-info.ts).
 *
 * It needs about 3 GB free for the temporary copy, and runs after
 * npm run build:ts, because it reads .env files with the app's own code.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoDir = path.dirname(desktopDir);
const appDir = path.join(repoDir, "my-app");
const outputDir = path.join(desktopDir, "build", "server");
const compiled = path.join(desktopDir, "out", "core", "build-config.js");
/** The name src/main/build-info.ts reads the stamp from. */
const STAMP_FILE = ".schema-studio-build.json";
const GB = 1024 ** 3;

/** .env keys whose values must never reach the build. */
const SECRET_KEY = /SECRET|TOKEN|PASS|CREDENTIAL|DATABASE_URL|CONNECTION|(^|_)(PAT|KEY)(_|$)/i;
/** Shorter values turn up by chance too easily: a password like "postgres" is in every PostgreSQL client. */
const MIN_SECRET_LENGTH = 12;
/** An address with a user and a password in it, such as a database URL. The password is the first group. */
const URL_WITH_PASSWORD = /^[a-z][a-z0-9+.-]*:\/\/[^\s:@\/]*:([^\s@\/]+)@/i;
/**
 * What credentials look like, wherever they came from. These are checked
 * outside node_modules only, because other projects' packages can hold
 * made-up ones for their own tests.
 */
const SECRET_PATTERNS = [
  { name: "a GitHub token", pattern: /gh[pousr]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{20,}/ },
  { name: "a signed token (JWT)", pattern: /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{20,}/ },
  // A key's first line followed by the key itself. Code that reads keys has
  // the first line too, but nothing after it.
  { name: "a private key", pattern: /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----(?:\s|\\[rn])+[A-Za-z0-9+/]{40}/ },
];
/** The npm settings that say where packages come from, which npm ci still needs. */
const NPM_SETTINGS_KEPT = /^npm_config_(cache|registry|userconfig|cafile|strict_ssl|(https?_)?proxy|noproxy)$/i;
/**
 * All that next build sees of this computer's environment: what any program
 * needs to run, and how to reach the internet, because it downloads the
 * web app's fonts.
 */
const BUILD_ENV_KEPT = [
  "PATH",
  "HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "CI",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "NODE_EXTRA_CA_CERTS",
];

class BuildError extends Error {}

function fail(message) {
  throw new BuildError(message);
}

function checkSpace(dir, needed, what) {
  const { bavail, bsize } = fs.statfsSync(dir);
  const free = bavail * bsize;
  if (free < needed) {
    fail(
      `The build needs about ${needed / GB} GB free for ${what} (in ${dir}), and there are ${(free / GB).toFixed(1)} GB. Free some space and try again.`,
    );
  }
}

/** Runs git and returns what it printed, or null if it did not work. */
function git(args, cwd) {
  const result = spawnSync("git", args, { cwd, maxBuffer: 256 * 1024 * 1024 });
  if (result.error?.code === "ENOENT") {
    fail("The build needs git, to know which files belong to the web app. Install git and try again.");
  }
  if (result.error) throw result.error;
  return result.status === 0 ? result.stdout : null;
}

/** Runs a command that prints its own progress, and stops the build if it fails. */
function run(command, args, options, what) {
  // Ctrl+C reaches the command as well as this script. Waiting for the
  // command to stop, rather than stopping first, lets the temporary copy be
  // removed afterwards.
  const wait = () => {};
  process.on("SIGINT", wait);
  let result;
  try {
    result = spawnSync(command, args, { stdio: "inherit", ...options });
  } finally {
    process.off("SIGINT", wait);
  }
  if (result.error?.code === "ENOENT") fail(`${what} needs ${command}, which is not installed or not on the PATH.`);
  if (result.error) throw result.error;
  if (result.signal !== null) fail(`${what} was stopped.`);
  if (result.status !== 0) fail(`${what} did not work. Its own messages above say why.`);
}

/** Copies the web app's files that git knows about, except .env files, and returns how many it copied. */
function copyAppFiles(target) {
  const listed = git(["ls-files", "-z", "--cached", "--others", "--exclude-standard"], appDir);
  if (listed === null) {
    fail("git could not list the web app's files. The build has to run in a git checkout of the repository.");
  }
  let copied = 0;
  for (const relative of listed.toString("utf8").split("\0")) {
    if (relative === "" || path.basename(relative).startsWith(".env")) continue;
    const from = path.join(appDir, relative);
    let stats;
    try {
      stats = fs.lstatSync(from);
    } catch (error) {
      // Deleted, but the deletion is not committed yet.
      if (error.code === "ENOENT") continue;
      throw error;
    }
    // A repository inside the web app's folder, which git lists as a folder.
    if (stats.isDirectory()) continue;
    const to = path.join(target, relative);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    if (stats.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(from), to);
    else fs.copyFileSync(from, to);
    copied += 1;
  }
  if (!fs.existsSync(path.join(target, "package-lock.json"))) {
    fail("The web app has no package-lock.json, which the build installs its packages from.");
  }
  return copied;
}

/**
 * This environment without what npm run adds for the desktop project, which
 * could point npm ci, or a package's install script, at the wrong project,
 * and without NODE_ENV, whose "production" would leave out the packages the
 * build needs.
 */
function npmEnv() {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key === "NODE_ENV" || key === "INIT_CWD") continue;
    if (/^npm_/i.test(key) && !NPM_SETTINGS_KEPT.test(key)) continue;
    env[key] = value;
  }
  return env;
}

function buildEnv() {
  const env = {
    // The desktop app always signs in. The web version's switch for testing
    // without sign-in must never be on in it.
    NEXT_PUBLIC_AUTH_BYPASS: "false",
    NEXT_TELEMETRY_DISABLED: "1",
    NODE_ENV: "production",
    // The web app does not load without a database address. Nothing
    // connects while building, and if anything tried, port 1 refuses at once.
    DATABASE_URL_A: "postgres://build@127.0.0.1:1/build?sslmode=disable",
  };
  for (const key of BUILD_ENV_KEPT) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

/** Takes out of the build what must not, or need not, go into the installer. */
function strip(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.name.startsWith(".env")) {
      // None was copied, but a package could bring one.
      fs.rmSync(full, { recursive: true, force: true });
    } else if (entry.isDirectory() && entry.name === "@img" && path.basename(dir) === "node_modules") {
      // sharp's image libraries, which Next.js uses to resize pictures.
      // Schema Studio has none to resize, and they are native code, which
      // the desktop app cannot load (see below).
      fs.rmSync(full, { recursive: true, force: true });
    } else if (entry.isDirectory()) {
      strip(full);
    }
  }
}

/** Every file under `dir`, as a path relative to it. Links are left out, so that nothing outside is read. */
function listFiles(dir, relative = "", files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = path.join(relative, entry.name);
    if (entry.isDirectory()) listFiles(path.join(dir, entry.name), rel, files);
    else if (entry.isFile()) files.push(rel);
  }
  return files;
}

/** The .env files of my-app and of the repository. The .example ones are placeholders, public on purpose. */
function envFiles() {
  const found = [];
  for (const dir of [appDir, repoDir]) {
    for (const name of fs.readdirSync(dir)) {
      if (!name.startsWith(".env") || name.endsWith(".example")) continue;
      const file = path.join(dir, name);
      if (fs.statSync(file).isFile()) found.push(file);
    }
  }
  return found;
}

/**
 * The password in a value that is an address with one, such as a database
 * URL: as it is written there, and decoded too if it has %-escapes. Empty if
 * the value is not such an address.
 */
function passwordsIn(value) {
  const match = URL_WITH_PASSWORD.exec(value);
  if (match === null) return [];
  const written = match[1];
  try {
    const decoded = decodeURIComponent(written);
    return decoded === written ? [written] : [written, decoded];
  } catch {
    // Not valid %-escapes, so it can only turn up as it is written.
    return [written];
  }
}

/** Where the build holds a value from an .env file, or something that looks like a credential. It names keys and files, never values. */
function findSecrets(files, parseEnvFile) {
  const needles = [];
  const add = (name, value) => {
    if (value.length >= MIN_SECRET_LENGTH) needles.push({ name, bytes: Buffer.from(value) });
  };
  for (const file of envFiles()) {
    const where = path.relative(repoDir, file);
    for (const [key, value] of Object.entries(parseEnvFile(fs.readFileSync(file, "utf8")))) {
      const passwords = passwordsIn(value);
      // An address with a password in it is a secret, whatever its key is called.
      if (SECRET_KEY.test(key) || passwords.length > 0) add(`the value of ${key} in ${where}`, value);
      for (const password of passwords) add(`the password in ${key} in ${where}`, password);
    }
  }

  const found = [];
  for (const file of files) {
    const bytes = fs.readFileSync(path.join(outputDir, file));
    for (const needle of needles) {
      if (bytes.includes(needle.bytes)) found.push(`${file}: ${needle.name}`);
    }
    if (file.split(path.sep).includes("node_modules")) continue;
    // latin1 keeps one character per byte, so the patterns work on any file.
    const text = bytes.toString("latin1");
    for (const { name, pattern } of SECRET_PATTERNS) {
      if (pattern.test(text)) found.push(`${file}: ${name}`);
    }
  }
  return found;
}

function writeStamp() {
  const commit = git(["rev-parse", "--short", "HEAD"], repoDir);
  const changes = git(["status", "--porcelain", "--", "my-app", "desktop"], repoDir);
  const stamp = {
    commit: commit === null ? null : commit.toString("utf8").trim(),
    dirty: changes !== null && changes.length > 0,
    builtAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(outputDir, STAMP_FILE), `${JSON.stringify(stamp, null, 2)}\n`);
  return stamp;
}

if (!fs.existsSync(compiled)) {
  console.error("The app is not compiled yet. Run npm run build:ts first.");
  process.exit(1);
}
const { parseEnvFile } = createRequire(import.meta.url)(compiled);

let tempDir = null;
let replacing = false;
try {
  checkSpace(os.tmpdir(), 3 * GB, "the temporary copy of the web app");
  checkSpace(desktopDir, 1 * GB, "the finished build");
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "schema-studio-server-"));
  const buildDir = path.join(tempDir, "my-app");
  const copied = copyAppFiles(buildDir);
  console.log(`Copied the web app's ${copied} files to ${buildDir}.`);

  run("npm", ["ci", "--no-audit", "--no-fund", "--include=dev"], { cwd: buildDir, env: npmEnv() }, "Installing the web app's packages");
  run(
    process.execPath,
    [path.join(buildDir, "node_modules", "next", "dist", "bin", "next"), "build"],
    { cwd: buildDir, env: buildEnv() },
    "Building the web app",
  );
  const standalone = path.join(buildDir, ".next", "standalone");
  if (!fs.existsSync(path.join(standalone, "server.js"))) {
    fail(
      `next build finished without a .next/standalone/server.js. Check that my-app/next.config.ts still has output: "standalone". If it does, a package-lock.json in a folder above ${tempDir} can make Next take that folder for the project's root and put the server deeper inside .next/standalone.`,
    );
  }

  replacing = true;
  fs.rmSync(outputDir, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(outputDir), { recursive: true });
  fs.cpSync(standalone, outputDir, { recursive: true, verbatimSymlinks: true });
  // The standalone server leaves the pages' scripts and styles, and public/,
  // to be served from elsewhere. The desktop app has nowhere else, so they
  // go with the server.
  fs.cpSync(path.join(buildDir, ".next", "static"), path.join(outputDir, ".next", "static"), {
    recursive: true,
    verbatimSymlinks: true,
  });
  const publicDir = path.join(buildDir, "public");
  if (fs.existsSync(publicDir)) {
    fs.cpSync(publicDir, path.join(outputDir, "public"), { recursive: true, verbatimSymlinks: true });
  }
  strip(outputDir);

  const files = listFiles(outputDir);
  const native = files.filter((file) => file.endsWith(".node"));
  if (native.length > 0) {
    fail(
      `The build has native modules, which cannot load in the desktop app, because it runs the server on Electron's own Node.js:\n${native.map((file) => `  ${file}`).join("\n")}\nFind the package that brings them, and whether the web app needs it.`,
    );
  }
  console.log(`Checking the build's ${files.length} files for passwords, keys and tokens.`);
  const secrets = findSecrets(files, parseEnvFile);
  if (secrets.length > 0) {
    fail(
      `The build was removed, because these files hold what looks like a password, a key or a token:\n${secrets.map((line) => `  ${line}`).join("\n")}\nFind how it got into the web app's code or build before building again.`,
    );
  }

  const stamp = writeStamp();
  const from = stamp.commit === null ? "an unknown commit" : `commit ${stamp.commit}`;
  console.log(`The web app is built in build/server, from ${from}${stamp.dirty ? " with changes not committed yet" : ""}.`);
} catch (error) {
  console.error(error instanceof BuildError ? `\n${error.message}` : error);
  // Half a build, or one with a secret in it, must never be packaged.
  if (replacing) fs.rmSync(outputDir, { recursive: true, force: true });
  process.exitCode = 1;
} finally {
  if (tempDir !== null) fs.rmSync(tempDir, { recursive: true, force: true });
}
