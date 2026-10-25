/**
 * Puts the phone app together in public/, the folder wrangler serves
 * (wrangler.jsonc). `npm run build` runs it, and so do `npm test`,
 * `npm run dev` and `npm run deploy`, so what they serve is never out of
 * date:
 *
 *  1. tsc compiles the app into public/js (tsconfig.phone.json), and the
 *     service worker into public/sw.js (tsconfig.sw.json).
 *  2. jsQR, the QR code reader the Scan screen uses, is copied to
 *     public/js/vendor with its license. It is one built file, which
 *     browsers load as it is.
 *  3. Every file of the app is listed, and a version is made from what is
 *     in them. Both go in front of the service worker, which keeps a copy of
 *     each file so that the app opens without a connection. A new version
 *     gets a new copy, made in full before it is used, so a phone never
 *     mixes the files of two builds. Settings on the phone shows the version.
 *
 * Everything this writes is git-ignored and made again on every run.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const relayDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = path.join(relayDir, "public");
const jsDir = path.join(publicDir, "js");
const workerFile = path.join(publicDir, "sw.js");
const buildInfoPath = "/js/phone/build-info.js";
const jsqrDir = path.join(relayDir, "node_modules", "jsqr");

/**
 * Files in public/ that are not part of the copy: Cloudflare reads _headers
 * and never serves it, and a browser fetches the service worker itself.
 */
const NOT_KEPT = new Set(["/_headers", "/sw.js"]);

function fail(message) {
  console.error(message);
  process.exit(1);
}

function compile(config) {
  try {
    execFileSync(process.execPath, [path.join(relayDir, "node_modules", "typescript", "bin", "tsc"), "-p", path.join(relayDir, config)], {
      stdio: "inherit",
    });
  } catch {
    fail(`The phone app did not compile with ${config}. The errors are above.`);
  }
}

/** Every file under `dir`, as the path a browser asks for it by. Hidden files, such as macOS's .DS_Store, are left out. */
function listFiles(dir, prefix = "") {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const urlPath = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) files.push(...listFiles(path.join(dir, entry.name), urlPath));
    else if (entry.isFile()) files.push(urlPath);
  }
  return files;
}

fs.rmSync(jsDir, { recursive: true, force: true });
fs.rmSync(workerFile, { force: true });
compile("tsconfig.phone.json");
compile("tsconfig.sw.json");

fs.mkdirSync(path.join(jsDir, "vendor"), { recursive: true });
fs.copyFileSync(path.join(jsqrDir, "dist", "jsQR.js"), path.join(jsDir, "vendor", "jsQR.js"));
fs.copyFileSync(path.join(jsqrDir, "LICENSE"), path.join(jsDir, "vendor", "jsQR-LICENSE.txt"));

const files = listFiles(publicDir)
  .filter((file) => !NOT_KEPT.has(file))
  .sort();
// The version comes from every file but the one it is written into.
const hash = createHash("sha256");
for (const file of files) {
  if (file !== buildInfoPath) hash.update(`${file}\0`).update(fs.readFileSync(path.join(publicDir, file))).update("\0");
}
const version = hash.digest("hex").slice(0, 12);
fs.writeFileSync(path.join(publicDir, buildInfoPath), `export const BUILD_VERSION = ${JSON.stringify(version)};\n`);

// The page itself is served at "/", and Cloudflare sends /index.html there.
const urls = files.map((file) => (file === "/index.html" ? "/" : file));
const worker = fs.readFileSync(workerFile, "utf8").replace(/^"use strict";\r?\n/, "");
fs.writeFileSync(
  workerFile,
  `"use strict";\n// Made by scripts/build-phone.mjs from src/phone/sw.ts.\nconst BUILD = ${JSON.stringify({ version, files: urls })};\n${worker}`,
);
console.log(`Built the phone app, version ${version}, with ${urls.length} files.`);
