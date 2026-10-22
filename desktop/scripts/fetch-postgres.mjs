/**
 * Puts the PostgreSQL that Schema Studio keeps its own data in into
 * desktop/build/postgres/<platform>-<arch>, ready to be packaged.
 *
 * The desktop app keeps its data (connections, saved scripts, history) in a
 * PostgreSQL 17 of its own, which it starts itself (src/main/postgres.ts), so
 * nobody has to install or set up a database server first. The programs
 * come from the @embedded-postgres packages on npm, which hold PostgreSQL
 * built to run from any folder: on Linux with glibc 2.25 or newer (every
 * Ubuntu from 18.04 on), and on macOS.
 *
 * Each package is pinned to an exact version, size and sha512 checksum, the
 * same check npm itself makes, so a changed or replaced package stops the
 * build instead of ending up in the installer. Nothing in the package is
 * run: the system's tar unpacks it, and only its bin, lib and share folders
 * are copied. npm cannot ship links, so the package lists the library links
 * the system's loader looks for (libpq.so.5 for libpq.so.5.17, and so on),
 * and this makes them.
 *
 * Parts that Schema Studio never uses are left out: the Perl, Python and Tcl
 * languages, which would need those installed, the files for building
 * extensions, and the libraries for C programs that embed SQL.
 *
 *   node scripts/fetch-postgres.mjs [--platform linux|darwin] [--arch x64|arm64]
 *
 * Both default to this computer's. The installer is for Linux only; the Mac
 * package is there to try the app on a Mac while developing it.
 */
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The packages, by platform and processor. The integrity is npm's own sha512 of the file. */
const PACKAGES = {
  "linux-x64": {
    spec: "@embedded-postgres/linux-x64@17.10.0-beta.17",
    integrity: "sha512-hU4Sgna19ixDP/l3P/zkHhQ9B0JDV39qA97RNz55QcngeRjFC5/1G36LZjODVJ84kVJHUTQMmly7nzWO8js8kg==",
    size: 23500205,
  },
  "linux-arm64": {
    spec: "@embedded-postgres/linux-arm64@17.10.0-beta.17",
    integrity: "sha512-mC+bQvaBEf0WDD0nPWW3eGUXDUVzoyCzMtgl+Fw6Jy9DkQFK+jcPtzkzqhhrS/fGzn5telNpKInl8xPqDh71Ig==",
    size: 22767514,
  },
  "darwin-arm64": {
    spec: "@embedded-postgres/darwin-arm64@17.10.0-beta.17",
    integrity: "sha512-E2dxhSllrcyAJBHuvgTrBTx2BaPlX2vvjXClPKHxfwBezk+nTZ01uAEraKiRJMpzHSCyN8J1dTjKh4q/uTsBLQ==",
    size: 51141714,
  },
};

/** In lib: static libraries, the files for building extensions, and the libraries for C programs that embed SQL (ecpg). */
const UNUSED_IN_LIB = /^lib(ecpg|pgtypes)|\.a$|^pkgconfig$/;
/** In lib/postgresql: the Perl, Python and Tcl languages, and the extensions that bridge them to other types. */
const OTHER_LANGUAGE_LIBRARY = /^(plperl|plpython3|pltcl)\.(so|dylib)$|_(plperl|plpython3)\.(so|dylib)$/;
/** In share/postgresql/extension: the same languages' extension files. */
const OTHER_LANGUAGE_EXTENSION = [
  /^(plperl|plperlu|plpython3u|pltcl|pltclu)(--|\.control$)/,
  /_(plperl|plperlu|plpython3u)(--|\.control$)/,
];

class FetchError extends Error {}

function fail(message) {
  throw new FetchError(message);
}

function readOptions() {
  try {
    const { values } = parseArgs({ options: { platform: { type: "string" }, arch: { type: "string" } } });
    return { platform: values.platform ?? process.platform, arch: values.arch ?? process.arch };
  } catch (error) {
    fail(`${error.message}\nUse: node scripts/fetch-postgres.mjs [--platform linux|darwin] [--arch x64|arm64]`);
  }
}

/**
 * This environment without what npm run adds for the desktop project, and
 * without NODE_ENV, so that npm pack behaves the same however it is run.
 * The settings that say where packages come from are kept.
 */
function npmEnv() {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key === "NODE_ENV" || key === "INIT_CWD") continue;
    if (/^npm_/i.test(key) && !/^npm_config_(cache|registry|userconfig|cafile|strict_ssl|(https?_)?proxy|noproxy)$/i.test(key)) {
      continue;
    }
    env[key] = value;
  }
  return env;
}

function run(command, args, options, what) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.error?.code === "ENOENT") fail(`${what} needs ${command}, which is not installed or not on the PATH.`);
  if (result.error) throw result.error;
  if (result.status !== 0) fail(`${what} did not work. The messages above say why.`);
}

function readText(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/** Downloads the package with npm and checks that it is exactly the pinned one. */
function download(pinned, packDir) {
  fs.mkdirSync(packDir);
  // Run from the empty folder, so that npm reads no project's settings and
  // only fetches the file.
  run(
    "npm",
    ["pack", pinned.spec, "--pack-destination", packDir, "--ignore-scripts", "--loglevel=error"],
    { cwd: packDir, env: npmEnv() },
    `Downloading ${pinned.spec}`,
  );
  const tarballs = fs.readdirSync(packDir).filter((name) => name.endsWith(".tgz"));
  if (tarballs.length !== 1) fail(`npm pack should have left one file in ${packDir}, and left ${tarballs.length}.`);
  const tarball = path.join(packDir, tarballs[0]);
  const bytes = fs.readFileSync(tarball);
  if (bytes.length !== pinned.size) {
    fail(`${pinned.spec} is ${bytes.length} bytes instead of ${pinned.size}, so it is not the package this build expects. It was not used.`);
  }
  const integrity = `sha512-${crypto.createHash("sha512").update(bytes).digest("base64")}`;
  if (integrity !== pinned.integrity) {
    fail(`${pinned.spec} does not match its pinned checksum, so it is not the package this build expects. It was not used.`);
  }
  return tarball;
}

/** Unpacks the package and returns its native folder. */
function unpack(tarball, unpackDir) {
  fs.mkdirSync(unpackDir);
  run("tar", ["-xzf", tarball, "-C", unpackDir], {}, "Unpacking PostgreSQL");
  const nativeDir = path.join(unpackDir, "package", "native");
  for (const part of ["bin", "lib", "share"]) {
    if (!fs.existsSync(path.join(nativeDir, part))) {
      fail(`The PostgreSQL package has no native/${part} folder, so it is not laid out the way this build expects.`);
    }
  }
  return nativeDir;
}

function leaveOutUnused(outputDir) {
  const remove = (dir, unused) => {
    for (const name of fs.readdirSync(dir)) {
      if (unused(name)) fs.rmSync(path.join(dir, name), { recursive: true, force: true });
    }
  };
  const libDir = path.join(outputDir, "lib");
  remove(libDir, (name) => UNUSED_IN_LIB.test(name));
  fs.rmSync(path.join(libDir, "postgresql", "pgxs"), { recursive: true, force: true });
  remove(path.join(libDir, "postgresql"), (name) => OTHER_LANGUAGE_LIBRARY.test(name));
  remove(path.join(outputDir, "share", "postgresql", "extension"), (name) =>
    OTHER_LANGUAGE_EXTENSION.some((pattern) => pattern.test(name)),
  );
}

/** A path from pg-symlinks.json, which names paths inside the package's native folder, made into one inside `outputDir`. */
function inside(outputDir, entry) {
  const resolved = path.resolve(outputDir, entry.replace(/^native\//, ""));
  if (!resolved.startsWith(outputDir + path.sep)) {
    fail(`pg-symlinks.json names ${entry}, which is outside the PostgreSQL folder.`);
  }
  return resolved;
}

/** Makes the library links the package lists. */
function linkLibraries(listFile, outputDir) {
  let links;
  try {
    links = JSON.parse(fs.readFileSync(listFile, "utf8"));
  } catch {
    fail("The PostgreSQL package's pg-symlinks.json is missing or is not valid JSON.");
  }
  if (!Array.isArray(links)) fail("The PostgreSQL package's pg-symlinks.json is not a list.");
  for (const link of links) {
    if (typeof link?.source !== "string" || typeof link?.target !== "string") {
      fail("The PostgreSQL package's pg-symlinks.json has an entry without a source and a target.");
    }
    const source = inside(outputDir, link.source);
    const target = inside(outputDir, link.target);
    // The library it points to was left out above.
    if (!fs.existsSync(source)) continue;
    fs.rmSync(target, { force: true });
    // Relative, so that the link still works wherever the folder is installed.
    fs.symlinkSync(path.relative(path.dirname(target), source), target);
  }
}

function install(nativeDir, outputDir) {
  fs.mkdirSync(outputDir, { recursive: true });
  for (const part of ["bin", "lib", "share"]) {
    fs.cpSync(path.join(nativeDir, part), path.join(outputDir, part), { recursive: true });
  }
  // npm does not keep the programs' execute permission reliably.
  const binDir = path.join(outputDir, "bin");
  for (const name of fs.readdirSync(binDir)) fs.chmodSync(path.join(binDir, name), 0o755);
  leaveOutUnused(outputDir);
  linkLibraries(path.join(nativeDir, "pg-symlinks.json"), outputDir);
}

function main() {
  const { platform, arch } = readOptions();
  const target = `${platform}-${arch}`;
  const pinned = PACKAGES[target];
  if (pinned === undefined) {
    fail(`There is no PostgreSQL package for ${target}. Schema Studio has one for ${Object.keys(PACKAGES).join(", ")}.`);
  }
  const outputDir = path.join(desktopDir, "build", "postgres", target);
  const stampFile = path.join(outputDir, ".version");
  const stamp = `${pinned.spec} ${pinned.integrity}\n`;
  if (readText(stampFile) === stamp && fs.existsSync(path.join(outputDir, "bin", "postgres"))) {
    console.log(`PostgreSQL for ${target} is already in build/postgres/${target}.`);
    return;
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "schema-studio-postgres-"));
  try {
    const tarball = download(pinned, path.join(tempDir, "pack"));
    const nativeDir = unpack(tarball, path.join(tempDir, "unpacked"));
    fs.rmSync(outputDir, { recursive: true, force: true });
    try {
      install(nativeDir, outputDir);
      // Written last, so that a fetch that stopped halfway is never taken
      // for a finished one.
      fs.writeFileSync(stampFile, stamp);
    } catch (error) {
      // The app would try to start a PostgreSQL with parts missing.
      fs.rmSync(outputDir, { recursive: true, force: true });
      throw error;
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  console.log(`PostgreSQL for ${target} is ready in build/postgres/${target}.`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof FetchError ? error.message : error);
  process.exitCode = 1;
}
