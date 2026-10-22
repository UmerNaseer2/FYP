/**
 * Folders only this person can open (src/core/private-dir.ts), tried on real
 * folders in a fresh temporary folder.
 *
 * A folder that belongs to another user cannot be made without being root, so
 * that refusal is not tried here.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { UnsafeDirError, ensurePrivateDir } from "../core/private-dir";

function tempDir(t: test.TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "schema-studio-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function modeOf(dir: string): number {
  return fs.statSync(dir).mode & 0o777;
}

function refusedBecause(pattern: RegExp) {
  return (error: unknown) =>
    error instanceof UnsafeDirError && error.name === "UnsafeDirError" && pattern.test(error.message);
}

test("makes the folder and any missing folders on the way, each one private", (t) => {
  const root = tempDir(t);
  const deep = path.join(root, "a", "b", "c");
  ensurePrivateDir(deep);
  assert.equal(modeOf(deep), 0o700);
  assert.equal(modeOf(path.join(root, "a")), 0o700);
});

test("tightens a folder that others could look into", (t) => {
  const dir = path.join(tempDir(t), "open");
  fs.mkdirSync(dir);
  fs.chmodSync(dir, 0o755);
  ensurePrivateDir(dir);
  assert.equal(modeOf(dir), 0o700);
});

test("leaves a private folder as it is, contents and all", (t) => {
  const dir = path.join(tempDir(t), "private");
  fs.mkdirSync(dir, { mode: 0o700 });
  fs.writeFileSync(path.join(dir, "keep.txt"), "kept");
  ensurePrivateDir(dir);
  assert.equal(modeOf(dir), 0o700);
  assert.equal(fs.readFileSync(path.join(dir, "keep.txt"), "utf8"), "kept");
});

test("refuses a link to somewhere else, even one to a good folder", (t) => {
  const root = tempDir(t);
  const target = path.join(root, "target");
  fs.mkdirSync(target, { mode: 0o700 });
  const link = path.join(root, "link");
  fs.symlinkSync(target, link);
  assert.throws(() => ensurePrivateDir(link), refusedBecause(/is a link to somewhere else rather than a folder/));
});

test("refuses a file where the folder should be", (t) => {
  const file = path.join(tempDir(t), "file");
  fs.writeFileSync(file, "");
  assert.throws(() => ensurePrivateDir(file), refusedBecause(/is a file rather than a folder/));
});
